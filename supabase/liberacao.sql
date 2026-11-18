-- Senha de liberação do gestor (já aplicada no projeto como migração "liberacao_gestor").
-- Produto bipado que não pertence ao pedido só é aceito com esta senha. Guardada com hash (bcrypt) em app_secrets.
create or replace function public.liberacao_set(p_senha text)
returns boolean language plpgsql security definer set search_path to 'public' as $$
begin
  if not is_ps_admin() then raise exception 'Só o administrador define a senha de liberação.'; end if;
  if p_senha is null or length(p_senha) < 4 then raise exception 'A senha precisa ter pelo menos 4 caracteres.'; end if;
  insert into app_secrets(name, value) values ('liberacao_senha', extensions.crypt(p_senha, extensions.gen_salt('bf')))
    on conflict (name) do update set value = excluded.value;
  return true;
end $$;

create or replace function public.liberacao_status()
returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists(select 1 from app_secrets where name='liberacao_senha');
$$;

create or replace function public.liberacao_check(p_senha text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare h text;
begin
  if coalesce(array_length(app_roles(),1),0) = 0 then return jsonb_build_object('ok',false,'error','Sem acesso.'); end if;
  select value into h from app_secrets where name='liberacao_senha';
  if h is null then return jsonb_build_object('ok',false,'error','O administrador ainda não definiu a senha de liberação (Usuários → Configuração).'); end if;
  if p_senha is not null and extensions.crypt(p_senha, h) = h then return jsonb_build_object('ok',true); end if;
  perform pg_sleep(0.8);
  return jsonb_build_object('ok',false,'error','Senha incorreta.');
end $$;

revoke all on function public.liberacao_set(text), public.liberacao_status(), public.liberacao_check(text) from public, anon;
grant execute on function public.liberacao_set(text), public.liberacao_status(), public.liberacao_check(text) to authenticated;
