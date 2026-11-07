-- Código do orçamento (ORC-0001) gerado pela sequence do banco.
-- Necessário na Vercel: várias instâncias do hub podem criar orçamentos ao mesmo tempo,
-- e um contador em memória daria o mesmo código para duas delas.

create or replace function public.proximo_codigo_orcamento()
returns text
language sql
security definer
set search_path = public
as $$
  select 'ORC-' || lpad(nextval('public.orcamento_codigo_seq')::text, 4, '0');
$$;

revoke execute on function public.proximo_codigo_orcamento() from public, anon, authenticated;
grant execute on function public.proximo_codigo_orcamento() to service_role;

-- Garante que a sequence está à frente do maior código já gravado.
select setval(
  'public.orcamento_codigo_seq',
  greatest(
    (select coalesce(max(nullif(regexp_replace(codigo, '\D', '', 'g'), '')::bigint), 0) from public.orcamentos),
    (select last_value from public.orcamento_codigo_seq)
  )
);
