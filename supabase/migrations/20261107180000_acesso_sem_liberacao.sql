-- Acesso sem liberação: quem tem conta no Supabase Auth já entra no hub.
-- A primeira conta vira dona; as seguintes, equipe. `ativo` continua existindo só para
-- a dona poder bloquear alguém (ativo = false).
--
-- Atenção: com isso, o controle de quem entra é quem tem conta. Deixe desligado o cadastro
-- aberto (Authentication → Sign In / Providers → Allow new users to sign up) e crie as
-- contas pelo painel (Users → Add user / Invite user).

alter table public.perfis alter column ativo set default true;

-- Contas que já existiam e estavam esperando liberação.
update public.perfis set ativo = true where not ativo;

-- Se ainda não há dona, a conta mais antiga assume.
update public.perfis set papel = 'dona'
where id = (select id from public.perfis order by criado_em limit 1)
  and not exists (select 1 from public.perfis where papel = 'dona');

create or replace function public.sincronizar_perfil()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.perfis (id, email, nome, papel, ativo)
    values (
      new.id,
      coalesce(new.email, ''),
      coalesce(new.raw_user_meta_data ->> 'nome', new.raw_user_meta_data ->> 'full_name', split_part(coalesce(new.email, ''), '@', 1)),
      case when exists (select 1 from public.perfis where papel = 'dona') then 'equipe' else 'dona' end,
      true
    )
    on conflict (id) do nothing;
  else
    update public.perfis set email = coalesce(new.email, '') where id = new.id;
  end if;
  return new;
end;
$$;

comment on table public.perfis is 'Equipe do hub. Toda conta do Auth entra; ativo = false bloqueia.';
