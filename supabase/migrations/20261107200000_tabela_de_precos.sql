-- Tabela de preços e configurações do hub no banco (antes ficavam só no arquivo do servidor).
-- Cada serviço tem dois preços: no studio e a domicílio. O hub escolhe pelo local do atendimento.
-- Sem preço a domicílio cadastrado (null), o hub usa o do studio e avisa a Adriana.
-- O servidor do hub preenche a tabela com o catálogo de config/hub.config.json na primeira vez.

create table public.servicos (
  codigo          text primary key check (codigo ~ '^[A-Z0-9_-]{1,30}$'),
  descricao       text not null check (length(descricao) between 1 and 120),
  unidade         text not null default 'pessoa' check (length(unidade) between 1 and 20),
  valor_studio    numeric(10,2) not null check (valor_studio >= 0),
  valor_domicilio numeric(10,2) check (valor_domicilio >= 0),
  detalhe         text,
  inclui          text[] not null default '{}',
  ordem           integer not null default 0,
  ativo           boolean not null default true,
  atualizado_em   timestamptz not null default now(),
  atualizado_por  uuid references public.perfis(id) on delete set null
);

create trigger servicos_tocar_atualizado_em
  before update on public.servicos
  for each row execute function public.tocar_atualizado_em();

-- Demais configurações editáveis na aba Configurações (empresa, validade, desconto, instruções...).
create table public.configuracoes (
  chave          text primary key,
  valor          jsonb not null,
  atualizado_em  timestamptz not null default now(),
  atualizado_por uuid references public.perfis(id) on delete set null
);

create trigger configuracoes_tocar_atualizado_em
  before update on public.configuracoes
  for each row execute function public.tocar_atualizado_em();

alter table public.servicos      enable row level security;
alter table public.configuracoes enable row level security;
revoke all on public.servicos, public.configuracoes from anon;

-- Equipe lê; só a dona altera. (O servidor do hub usa a service role e não passa pelo RLS.)
create policy "servicos: equipe lê" on public.servicos
  for select to authenticated using ((select public.eh_membro()));
create policy "servicos: dona altera" on public.servicos
  for all to authenticated
  using ((select public.eh_dona())) with check ((select public.eh_dona()));

create policy "configuracoes: equipe lê" on public.configuracoes
  for select to authenticated using ((select public.eh_membro()));
create policy "configuracoes: dona altera" on public.configuracoes
  for all to authenticated
  using ((select public.eh_dona())) with check ((select public.eh_dona()));
