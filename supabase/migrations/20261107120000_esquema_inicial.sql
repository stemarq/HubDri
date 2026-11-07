-- HubDri · esquema inicial no Supabase (Postgres)
-- Espelha o que hoje fica em data/db.json: orçamentos, imagens do chat, conversa,
-- histórico, revisões, envios ao WhatsApp, notificações e a saída simulada.
--
-- Acesso: só o servidor do hub fala com o banco, usando a chave service_role
-- (que ignora RLS). O RLS fica ligado sem políticas para bloquear a chave anon.

-- ---------- Utilidades ----------

-- gen_random_bytes (token público). No Supabase a extensão vive no schema "extensions".
create extension if not exists pgcrypto with schema extensions;

create or replace function public.tocar_atualizado_em()
returns trigger
language plpgsql
as $$
begin
  new.atualizado_em := now();
  return new;
end;
$$;

-- Código legível do orçamento: ORC-0001, ORC-0002, ...
create sequence if not exists public.orcamento_codigo_seq;

-- ---------- Orçamentos ----------

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

  -- Aprovação única da empresária
  aprovado_em      timestamptz,

  -- Resposta da cliente (link do PDF ou repassada pela IA do WhatsApp)
  resposta_decisao   text check (resposta_decisao in ('aprovado', 'mudanca')),
  resposta_comentario text,
  resposta_via       text check (resposta_via in ('link', 'whatsapp')),
  resposta_em        timestamptz,

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

create trigger orcamentos_atualizado_em
  before update on public.orcamentos
  for each row execute function public.tocar_atualizado_em();

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

create table public.orcamento_historico (
  id             bigint generated always as identity primary key,
  orcamento_id   uuid not null references public.orcamentos (id) on delete cascade,
  evento         text not null,
  detalhe        text not null default '',
  em             timestamptz not null default now()
);

create index orcamento_historico_orcamento_idx on public.orcamento_historico (orcamento_id, em);

-- ---------- Pedidos de mudança ----------

create table public.orcamento_revisoes (
  id             bigint generated always as identity primary key,
  orcamento_id   uuid not null references public.orcamentos (id) on delete cascade,
  comentario     text not null,
  origem         text not null check (origem in ('hub', 'cliente')),
  em             timestamptz not null default now()
);

create index orcamento_revisoes_orcamento_idx on public.orcamento_revisoes (orcamento_id, em);

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

-- ---------- Saída simulada do WhatsApp (sem WHATSAPP_CALLBACK_URL) ----------

create table public.saida_whatsapp (
  id             bigint generated always as identity primary key,
  tipo           text,           -- "orcamento_aprovado" ou "resposta_cliente"
  corpo          jsonb not null,
  via_http       boolean not null default false,
  em             timestamptz not null default now()
);

create index saida_whatsapp_em_idx on public.saida_whatsapp (em desc);

-- ---------- Segurança ----------
-- Sem políticas: anon/authenticated não leem nem escrevem. O hub usa service_role.

alter table public.orcamentos          enable row level security;
alter table public.orcamento_imagens   enable row level security;
alter table public.orcamento_mensagens enable row level security;
alter table public.orcamento_historico enable row level security;
alter table public.orcamento_revisoes  enable row level security;
alter table public.orcamento_envios    enable row level security;
alter table public.notificacoes        enable row level security;
alter table public.saida_whatsapp      enable row level security;

-- ---------- Storage: imagens recebidas do chat ----------
-- Bucket privado; o hub serve as imagens por URL assinada ou via service_role.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'imagens-orcamento',
  'imagens-orcamento',
  false,
  10485760,  -- 10 MB
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do nothing;
