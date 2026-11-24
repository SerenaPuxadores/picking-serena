-- Prazo de despacho dos pedidos do Mercado Livre (função ml-prazos)
-- grava o.mlPrazo no pedido sem mexer no resto do documento
create or replace function public.ml_prazo_set(p_id text, p_prazo jsonb)
returns void language sql security definer set search_path = public as $$
  update public.orders set data = data || jsonb_build_object('mlPrazo', p_prazo), updated_at = now() where id = p_id;
$$;
revoke execute on function public.ml_prazo_set(text, jsonb) from public, anon, authenticated;
grant execute on function public.ml_prazo_set(text, jsonb) to service_role;

-- atualiza os prazos a cada 3 minutos (minutos 1, 4, 7… para não coincidir com a importação da Magazord)
select cron.schedule('ml-prazos', '1-59/3 * * * *', $$
  select net.http_post(
    url := 'https://dtrfujxhfcyefbipkcwz.supabase.co/functions/v1/ml-prazos',
    headers := jsonb_build_object('Content-Type','application/json',
                 'x-push-secret', (select value from public.app_secrets where name = 'push_webhook')),
    body := '{"action":"sync"}'::jsonb,
    timeout_milliseconds := 120000);
$$);
