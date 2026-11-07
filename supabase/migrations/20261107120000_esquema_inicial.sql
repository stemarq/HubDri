-- HubDri · esquema inicial no Supabase (Postgres + Auth + Storage)
--
-- Quem acessa:
--   • O servidor do hub usa a chave service_role (ignora RLS): webhooks do WhatsApp,
--     página pública da cliente e, por enquanto, a própria interface do hub.
--   • Pessoas da equipe entram com login (Supabase Auth). Ter conta não basta: o acesso
--     vem da tabela `perfis` (ativo = true). Toda conta nova nasce inativa.
--   • A chave anon não lê nem escreve nada.
--
-- Primeira dona: depois de criar o usuário (Authentication → Users → Invite/Add user), rode
--   update public.perfis set papel = 'dona', ativo = true where email = 'email@dela.com';

-- ---------- Extensões e utilidades ----------

-- gen_random_bytes (token público). No Supabase a extensão vive no schema "extensions".
create extension if not exists pgcrypto with schema extensions;

create or replace function public.tocar_atualizado_em()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.atualizado_em := now();
  return new;
end;
$$;

-- ---------- Perfis (equipe com login) ----------

create table public.perfis (
  id             uuid primary key references auth.users (id) on delete cascade,
  email          text not null,
  nome           text not null default '',
  papel          text not null default 'equipe' check (papel in ('dona', 'equipe')),
  ativo          boolean not null default false,
  criado_em      timestamptz not null default now(),
  atualizado_em  timestamptz not null default now()
);

comment on table public.perfis is 'Quem pode usar o hub. Conta no Auth sem perfil ativo não acessa nada.';

create trigger perfis_atualizado_em
  before update on public.perfis
  for each row execute function public.tocar_atualizado_em();

-- Cria o perfil (inativo) quando alguém ganha conta no Auth e mantém o e-mail em dia.
create or replace function public.sincronizar_perfil()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.perfis (id, email, nome)
    values (
      new.id,
      coalesce(new.email, ''),
      coalesce(new.raw_user_meta_data ->> 'nome', new.raw_user_meta_data ->> 'full_name', split_part(coalesce(new.email, ''), '@', 1))
    )
    on conflict (id) do nothing;
  else
    update public.perfis set email = coalesce(new.email, '') where id = new.id;
  end if;
  return new;
end;
$$;

create trigger auth_usuario_criado
  after insert on auth.users
  for each row execute function public.sincronizar_perfil();

create trigger auth_email_alterado
  after update of email on auth.users
  for each row execute function public.sincronizar_perfil();

-- Usadas nas políticas. security definer para ler `perfis` sem cair na RLS dela mesma.
create or replace function public.eh_membro()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.perfis where id = (select auth.uid()) and ativo);
$$;

create or replace function public.eh_dona()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.perfis where id = (select auth.uid()) and ativo and papel = 'dona');
$$;

revoke execute on function public.eh_membro(), public.eh_dona() from public, anon;
grant execute on function public.eh_membro(), public.eh_dona() to authenticated;
revoke execute on function public.sincronizar_perfil() from public, anon, authenticated;

-- ---------- Orçamentos ----------

-- Código legível do orçamento: ORC-0001, ORC-0002, ...
create sequence if not exists public.orcamento_codigo_seq;

create table public.orcamentos (
  id               uuid primary key default gen_random_uuid(),
  codigo           text not null unique
                     default 'ORC-' || lpad(nextval('public.orcamento_codigo_seq')::text, 4, '0'),
  token_publico    text not null unique
                     default encode(extensions.gen_random_bytes(16), 'hex'),
  status           text not null default 'calculando'
                     check (status in (
                       'calculando', 'aguardando_aprovacao', 'enviando', 'enviado',
                       'falha_envio', 'mudanca_cliente', 'aceito_cliente'
                     )),

  -- Origem (conversa da IA do WhatsApp)
  canal            text not null default 'whatsapp',
  conversation_id  text not null,

  -- Dados recebidos da IA do WhatsApp (formato livre, mesclados a cada webhook)
  cliente          jsonb not null default '{}'::jsonb,  -- nome, telefone, cidade, ...
  evento           jsonb not null default '{}'::jsonb,  -- tipo, data, horario, local, ...
  briefing         jsonb not null default '{"resumo": "", "respostas": []}'::jsonb,

  -- Cálculo atual (itens, subtotal, desconto, total, geradoPor, ...)
  calculo          jsonb,
  total            numeric(12, 2) generated always as ((calculo ->> 'total')::numeric) stored,

  -- Aprovação única. aprovado_por fica vazio quando a aprovação vem pelo servidor sem login.
  aprovado_em      timestamptz,
  aprovado_por     uuid references public.perfis (id) on delete set null,

  -- Resposta da cliente (link do PDF ou repassada pela IA do WhatsApp)
  resposta_decisao    text check (resposta_decisao in ('aprovado', 'mudanca')),
  resposta_comentario text,
  resposta_via        text check (resposta_via in ('link', 'whatsapp')),
  resposta_em         timestamptz,

  criado_em        timestamptz not null default now(),
  atualizado_em    timestamptz not null default now()
);

comment on table public.orcamentos is 'Um orçamento por conversa aberta do WhatsApp.';

-- Uma conversa só pode ter um orçamento "aberto" por vez (novos dados se juntam a ele).
create unique index orcamentos_conversa_aberta_uk
  on public.orcamentos (conversation_id)
  where status in ('calculando', 'aguardando_aprovacao', 'falha_envio', 'mudanca_cliente');

-- Fila de prioridade: mais antigos primeiro, filtrando por status.
create index orcamentos_fila_idx on public.orcamentos (status, criado_em);
create index orcamentos_conversa_idx on public.orcamentos (conversation_id, criado_em desc);
create index orcamentos_aprovado_por_idx on public.orcamentos (aprovado_por);

create trigger orcamentos_atualizado_em
  before update on public.orcamentos
  for each row execute function public.tocar_atualizado_em();

-- O servidor do hub grava o código já pronto (ORC-0007). Isto empurra a sequence para
-- frente, para que um orçamento criado depois pelo login não repita um código.
create or replace function public.acompanhar_codigo_orcamento()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  n bigint := nullif(regexp_replace(new.codigo, '\D', '', 'g'), '')::bigint;
  ultimo bigint;
begin
  select case when is_called then last_value else last_value - 1 end
    into ultimo from public.orcamento_codigo_seq;
  if n is not null and n > ultimo then
    perform setval('public.orcamento_codigo_seq', n);
  end if;
  return new;
end;
$$;

revoke execute on function public.acompanhar_codigo_orcamento() from public, anon, authenticated;

create trigger orcamentos_codigo
  before insert on public.orcamentos
  for each row execute function public.acompanhar_codigo_orcamento();

-- ---------- Imagens do chat ----------
-- O arquivo fica no Storage (bucket "imagens-orcamento"); aqui só o caminho.

create table public.orcamento_imagens (
  id             uuid primary key default gen_random_uuid(),
  orcamento_id   uuid not null references public.orcamentos (id) on delete cascade,
  arquivo        text not null,  -- caminho no bucket: <orcamento_id>/<nome>.<ext>
  mime_type      text not null default 'image/jpeg',
  recebida_em    timestamptz not null default now()
);

create index orcamento_imagens_orcamento_idx on public.orcamento_imagens (orcamento_id, recebida_em);

-- ---------- Conversa do WhatsApp ----------

create table public.orcamento_mensagens (
  id             bigint generated always as identity primary key,
  orcamento_id   uuid not null references public.orcamentos (id) on delete cascade,
  de             text not null,  -- "cliente" ou "ia"
  texto          text not null default '',
  em             timestamptz not null default now()
);

create index orcamento_mensagens_orcamento_idx on public.orcamento_mensagens (orcamento_id, em);

-- ---------- Histórico (linha do tempo da tela do orçamento) ----------
-- autor_id: quem fez a ação logada; vazio para ações automáticas (webhook, IA, servidor).

create table public.orcamento_historico (
  id             bigint generated always as identity primary key,
  orcamento_id   uuid not null references public.orcamentos (id) on delete cascade,
  evento         text not null,
  detalhe        text not null default '',
  autor_id       uuid default auth.uid() references public.perfis (id) on delete set null,
  em             timestamptz not null default now()
);

create index orcamento_historico_orcamento_idx on public.orcamento_historico (orcamento_id, em);
create index orcamento_historico_autor_idx on public.orcamento_historico (autor_id);

-- ---------- Pedidos de mudança ----------

create table public.orcamento_revisoes (
  id             bigint generated always as identity primary key,
  orcamento_id   uuid not null references public.orcamentos (id) on delete cascade,
  comentario     text not null,
  origem         text not null check (origem in ('hub', 'cliente')),
  autor_id       uuid default auth.uid() references public.perfis (id) on delete set null,
  em             timestamptz not null default now()
);

create index orcamento_revisoes_orcamento_idx on public.orcamento_revisoes (orcamento_id, em);
create index orcamento_revisoes_autor_idx on public.orcamento_revisoes (autor_id);

-- ---------- Envios do PDF para a IA do WhatsApp ----------

create table public.orcamento_envios (
  id             bigint generated always as identity primary key,
  orcamento_id   uuid not null references public.orcamentos (id) on delete cascade,
  ok             boolean not null,
  simulado       boolean not null default false,
  erro           text,
  em             timestamptz not null default now()
);

create index orcamento_envios_orcamento_idx on public.orcamento_envios (orcamento_id, em);

-- ---------- Central de notificações ----------
-- `lida` é compartilhada pela equipe (a central é da empresa, não de cada pessoa).

create table public.notificacoes (
  id             uuid primary key default gen_random_uuid(),
  tipo           text not null check (tipo in ('novo', 'atualizacao', 'erro', 'aceito', 'mudanca')),
  titulo         text not null,
  texto          text not null default '',
  orcamento_id   uuid references public.orcamentos (id) on delete cascade,
  lida           boolean not null default false,
  em             timestamptz not null default now()
);

create index notificacoes_em_idx on public.notificacoes (em desc);
create index notificacoes_nao_lidas_idx on public.notificacoes (em desc) where not lida;
create index notificacoes_orcamento_idx on public.notificacoes (orcamento_id);

-- ---------- Saída simulada do WhatsApp (sem WHATSAPP_CALLBACK_URL) ----------

create table public.saida_whatsapp (
  id             bigint generated always as identity primary key,
  tipo           text,           -- "orcamento_aprovado" ou "resposta_cliente"
  corpo          jsonb not null,
  via_http       boolean not null default false,
  em             timestamptz not null default now()
);

create index saida_whatsapp_em_idx on public.saida_whatsapp (em desc);

-- ---------- Segurança (RLS) ----------
-- anon: nada. authenticated: só com perfil ativo. Listas filhas e histórico são
-- só de inclusão (sem editar/apagar); apagar orçamento é só para a dona.

alter table public.perfis              enable row level security;
alter table public.orcamentos          enable row level security;
alter table public.orcamento_imagens   enable row level security;
alter table public.orcamento_mensagens enable row level security;
alter table public.orcamento_historico enable row level security;
alter table public.orcamento_revisoes  enable row level security;
alter table public.orcamento_envios    enable row level security;
alter table public.notificacoes        enable row level security;
alter table public.saida_whatsapp      enable row level security;

revoke all on
  public.perfis, public.orcamentos, public.orcamento_imagens, public.orcamento_mensagens,
  public.orcamento_historico, public.orcamento_revisoes, public.orcamento_envios,
  public.notificacoes, public.saida_whatsapp
from anon;

-- Perfis: cada um vê o próprio (mesmo inativo, para a tela "aguardando liberação");
-- a equipe vê todos; só a dona libera, muda papel ou remove.
create policy "perfil: ver o próprio ou a equipe" on public.perfis
  for select to authenticated
  using (id = (select auth.uid()) or (select public.eh_membro()));
create policy "perfil: dona gerencia" on public.perfis
  for update to authenticated
  using ((select public.eh_dona())) with check ((select public.eh_dona()));
create policy "perfil: dona remove" on public.perfis
  for delete to authenticated
  using ((select public.eh_dona()));

-- Orçamentos
create policy "orcamento: equipe lê" on public.orcamentos
  for select to authenticated using ((select public.eh_membro()));
create policy "orcamento: equipe cria" on public.orcamentos
  for insert to authenticated with check ((select public.eh_membro()));
create policy "orcamento: equipe altera" on public.orcamentos
  for update to authenticated
  using ((select public.eh_membro())) with check ((select public.eh_membro()));
create policy "orcamento: dona apaga" on public.orcamentos
  for delete to authenticated using ((select public.eh_dona()));

-- Listas do orçamento: ler e incluir.
create policy "imagens: equipe lê" on public.orcamento_imagens
  for select to authenticated using ((select public.eh_membro()));
create policy "imagens: equipe inclui" on public.orcamento_imagens
  for insert to authenticated with check ((select public.eh_membro()));

create policy "mensagens: equipe lê" on public.orcamento_mensagens
  for select to authenticated using ((select public.eh_membro()));
create policy "mensagens: equipe inclui" on public.orcamento_mensagens
  for insert to authenticated with check ((select public.eh_membro()));

create policy "historico: equipe lê" on public.orcamento_historico
  for select to authenticated using ((select public.eh_membro()));
create policy "historico: equipe inclui em seu nome" on public.orcamento_historico
  for insert to authenticated
  with check ((select public.eh_membro()) and autor_id = (select auth.uid()));

create policy "revisoes: equipe lê" on public.orcamento_revisoes
  for select to authenticated using ((select public.eh_membro()));
create policy "revisoes: equipe inclui em seu nome" on public.orcamento_revisoes
  for insert to authenticated
  with check ((select public.eh_membro()) and autor_id = (select auth.uid()));

create policy "envios: equipe lê" on public.orcamento_envios
  for select to authenticated using ((select public.eh_membro()));

-- Notificações: ler e marcar como lida (criadas só pelo servidor).
create policy "notificacoes: equipe lê" on public.notificacoes
  for select to authenticated using ((select public.eh_membro()));
create policy "notificacoes: equipe marca como lida" on public.notificacoes
  for update to authenticated
  using ((select public.eh_membro())) with check ((select public.eh_membro()));
-- ...e só a coluna `lida`.
revoke update on public.notificacoes from authenticated;
grant update (lida) on public.notificacoes to authenticated;

create policy "saida whatsapp: equipe lê" on public.saida_whatsapp
  for select to authenticated using ((select public.eh_membro()));

-- ---------- Storage: imagens recebidas do chat ----------
-- Bucket privado. O servidor grava com service_role; a equipe logada pode ver e enviar.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'imagens-orcamento',
  'imagens-orcamento',
  false,
  10485760,  -- 10 MB
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do nothing;

create policy "imagens-orcamento: equipe lê" on storage.objects
  for select to authenticated
  using (bucket_id = 'imagens-orcamento' and (select public.eh_membro()));
create policy "imagens-orcamento: equipe envia" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'imagens-orcamento' and (select public.eh_membro()));
