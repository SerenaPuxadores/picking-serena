-- Picking Serena · pedidos ao fornecedor pelo WhatsApp (Evolution API -> função wa-compras)
-- Pode rodar de novo sem problema.
create table if not exists public.wa_pedidos (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  status text not null default 'rascunho' check (status in ('rascunho','confirmado','cancelado','convertido')),
  numero text not null,                 -- WhatsApp de quem lançou (só dígitos)
  nome text,
  fornecedor text,
  previsao_entrega date,
  observacao text,
  itens jsonb not null default '[]',    -- [{code, descricao, quantidade}]
  mensagens jsonb not null default '[]',-- conversa: [{at, de, tipo, texto, audio}]
  confirmado_em timestamptz,
  convertido_em timestamptz,
  convertido_por uuid,
  purchase_id text
);
create index if not exists wa_pedidos_status_idx on public.wa_pedidos(status, created_at desc);

-- quem pode lançar pelo WhatsApp (além do número conectado, que precisa começar com "Serena")
create table if not exists public.wa_autorizados (
  numero text primary key,              -- só dígitos, com DDI (ex.: 5547999999999)
  nome text not null,
  ativo boolean not null default true,
  exige_prefixo boolean not null default false,
  created_at timestamptz not null default now()
);
create table if not exists public.wa_conversas (
  numero text primary key,
  pedido_id bigint references public.wa_pedidos(id) on delete set null,
  historico jsonb not null default '[]',
  updated_at timestamptz not null default now()
);
create table if not exists public.wa_msgs (id text primary key, origem text not null, at timestamptz not null default now());

alter table public.wa_pedidos enable row level security;
alter table public.wa_autorizados enable row level security;
alter table public.wa_conversas enable row level security;
alter table public.wa_msgs enable row level security;

create or replace function public.wa_pode_ver() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles p where p.id = auth.uid() and coalesce(p.active,true)
    and (p.role in ('admin','supervisor','compras') or p.roles && array['admin','supervisor','compras']));
$$;
drop policy if exists wa_pedidos_sel on public.wa_pedidos;
create policy wa_pedidos_sel on public.wa_pedidos for select to authenticated using (public.wa_pode_ver());
drop policy if exists wa_pedidos_upd on public.wa_pedidos;
create policy wa_pedidos_upd on public.wa_pedidos for update to authenticated using (public.wa_pode_ver()) with check (public.wa_pode_ver());
drop policy if exists wa_aut_sel on public.wa_autorizados;
create policy wa_aut_sel on public.wa_autorizados for select to authenticated using (public.wa_pode_ver());

insert into storage.buckets (id, name, public) values ('wa-audios','wa-audios', false) on conflict (id) do nothing;
drop policy if exists wa_audios_sel on storage.objects;
create policy wa_audios_sel on storage.objects for select to authenticated using (bucket_id = 'wa-audios' and public.wa_pode_ver());

do $$ begin alter publication supabase_realtime add table public.wa_pedidos; exception when duplicate_object then null; end $$;

-- configuração (não são segredos): endereço da Evolution e nome da instância
insert into app_secrets(name,value) values ('evolution_url','https://SEU-EVOLUTION.up.railway.app'),('evolution_instance','serena') on conflict (name) do nothing;
-- chaves (cadastre pelo painel): anthropic_api_key (Usuários → Assistente Lucas) e openai_api_key (transcrição dos áudios)
