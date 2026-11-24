-- Prazo de despacho dos pedidos do Mercado Livre
-- A importação da Magazord (functions/magazord) consulta o prazo no ML e grava o.mlPrazo no pedido ao importar.
-- Esta função grava só o campo mlPrazo (nova tentativa para pedidos que entraram sem prazo), sem mexer no resto do documento.
create or replace function public.ml_prazo_set(p_id text, p_prazo jsonb)
returns void language sql security definer set search_path = public as $$
  update public.orders set data = data || jsonb_build_object('mlPrazo', p_prazo), updated_at = now() where id = p_id;
$$;
revoke execute on function public.ml_prazo_set(text, jsonb) from public, anon, authenticated;
grant execute on function public.ml_prazo_set(text, jsonb) to service_role;
