// Picking Serena · prazo de despacho dos pedidos do Mercado Livre
// O pedido chega pela Magazord com o identificador do marketplace (codigoMarketplace):
//   "2000…"  -> pedido (ou carrinho/pack) do Mercado Livre
//   "S-4860…" -> já é o número do envio (shipment)
// Para cada pedido do ML ainda na operação, consulta o envio e o SLA no Mercado Livre (mesma conexão do app Envio Full,
// tabela full_ml_auth) e grava no pedido o campo mlPrazo: { limite, sla, tipo, envio, st, sub, at }.
//  Interno (x-push-secret): {action:"sync"}           -> agendado a cada 3 min
//  Administrador (JWT):     {action:"sync"} | {action:"one", id:"MZ-…"}
import { createClient } from "npm:@supabase/supabase-js@2.117.3";

const URL_ = Deno.env.get("SUPABASE_URL")!;
let KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
if (!KEY) { try { KEY = Object.values(JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}"))[0] as string; } catch { /* */ } }
const sb = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-push-secret", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const ML = "https://api.mercadolibre.com";
const ML_ID = Deno.env.get("ML_CLIENT_ID") || "770978757588091";
const ATIVOS = ["aguardando", "separando", "na_mesa", "analise_compras", "desmembrar", "encomenda", "enc_pendente", "na_colmeia"];
const espera = (ms: number) => new Promise((z) => setTimeout(z, ms));

/* ---------- token (compartilhado com o Envio Full) ----------
   O refresh_token do ML só vale uma vez. Renovamos com folga (10 min antes) e gravamos só se ninguém
   renovou no meio do caminho; se o outro app renovou primeiro, usamos o token novo dele. */
async function auth() { const { data, error } = await sb.from("full_ml_auth").select("access_token,refresh_token,expira,user_id").eq("id", 1).maybeSingle(); if (error) throw error; return data; }
async function token(): Promise<string> {
  const a = await auth();
  if (!a || (!a.refresh_token && !a.access_token)) throw new Error("Mercado Livre não conectado (conecte pelo app Envio Full).");
  if (a.access_token && new Date(a.expira).getTime() > Date.now() + 600000) return a.access_token;
  if (!a.refresh_token) throw new Error("Conexão com o Mercado Livre expirada (conecte de novo pelo app Envio Full).");
  const sec = Deno.env.get("ML_CLIENT_SECRET"); if (!sec) throw new Error("Falta a ML_CLIENT_SECRET nos secrets das Edge Functions.");
  const r = await fetch(`${ML}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: ML_ID, client_secret: sec, refresh_token: a.refresh_token }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { // provavelmente o Envio Full renovou ao mesmo tempo: relê
    await espera(1500); const b = await auth();
    if (b?.access_token && b.access_token !== a.access_token && new Date(b.expira).getTime() > Date.now() + 60000) return b.access_token;
    if (a.access_token && new Date(a.expira).getTime() > Date.now() + 30000) return a.access_token;
    throw new Error(`Mercado Livre recusou a renovação do token: ${j.message || j.error || r.status}`);
  }
  const n = { access_token: j.access_token, refresh_token: j.refresh_token || a.refresh_token, expira: new Date(Date.now() + (j.expires_in || 21600) * 1000).toISOString(), msg: null, updated_at: new Date().toISOString() };
  await sb.from("full_ml_auth").update(n).eq("id", 1).eq("refresh_token", a.refresh_token);
  return j.access_token;
}
async function mlGet(tk: string, path: string): Promise<{ status: number; body: any }> {
  for (let t = 0; t < 3; t++) {
    const r = await fetch(ML + path, { headers: { authorization: `Bearer ${tk}`, accept: "application/json" } });
    if (r.status === 429 || r.status >= 500) { await espera(1500 * 2 ** t); continue; }
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }
  return { status: 429, body: {} };
}

/* ---------- envio de um pedido ---------- */
async function envioDe(tk: string, cod: string): Promise<string | null> {
  const c = String(cod || "").trim();
  const s = c.match(/^S-?(\d{6,})$/i); if (s) return s[1];
  if (!/^\d{10,}$/.test(c)) return null;
  const o = await mlGet(tk, `/orders/${c}`);
  if (o.status === 200 && o.body?.shipping?.id) return String(o.body.shipping.id);
  const p = await mlGet(tk, `/packs/${c}`); // carrinho: o identificador pode ser do pack
  if (p.status === 200 && p.body?.shipment?.id) return String(p.body.shipment.id);
  if (o.status === 401 || o.status === 403) throw new Error(`Sem permissão para ler pedidos no Mercado Livre (${o.status}).`);
  return null;
}
async function prazoDo(tk: string, envio: string) {
  const [sh, sla] = await Promise.all([mlGet(tk, `/shipments/${envio}`), mlGet(tk, `/shipments/${envio}/sla`)]);
  if (sh.status === 401 || sh.status === 403) throw new Error(`Sem permissão para ler envios no Mercado Livre (${sh.status}).`);
  const S = sh.status === 200 ? sh.body : {}, L = sla.status === 200 ? sla.body : {};
  const hl = S?.shipping_option?.estimated_handling_limit?.date || S?.lead_time?.estimated_handling_limit?.date || null;
  return {
    envio, limite: L?.expected_date || hl || null, // data/hora limite para despachar
    sla: L?.status || null,                        // on_time | delayed | …
    tipo: S?.logistic_type || null,                // cross_docking (coleta), drop_off, xd_drop_off (places), self_service (flex), fulfillment
    st: S?.status || null, sub: S?.substatus || null,
  };
}

const igual = (a: any, b: any) => a && b && ["envio", "limite", "sla", "tipo", "st", "sub"].every((k) => (a[k] ?? null) === (b[k] ?? null));
async function grava(id: string, p: Record<string, unknown>) {
  const { error } = await sb.rpc("ml_prazo_set", { p_id: id, p_prazo: p }); if (error) throw error;
}

async function sync(only?: string) {
  const t0 = Date.now();
  let sel = sb.from("orders").select("id,data").like("id", "MZ-%").filter("data->>origem", "eq", "Mercado Livre");
  sel = only ? sel.eq("id", only) : sel.filter("data->>status", "in", `(${ATIVOS.join(",")})`);
  const { data: rows, error } = await sel; if (error) throw error;
  if (!rows?.length) return { lidos: 0, gravados: 0, ms: Date.now() - t0 };
  const tk = await token();
  let gravados = 0, semEnvio = 0; const erros: string[] = [];
  for (let i = 0; i < rows.length; i += 5) {
    await Promise.all(rows.slice(i, i + 5).map(async (r: any) => {
      const d = r.data || {}, ant = d.mlPrazo || null;
      try {
        const envio = ant?.envio || await envioDe(tk, d.codigoMarketplace);
        if (!envio) { semEnvio++; if (!ant?.erro) await grava(r.id, { erro: "envio não encontrado", cod: d.codigoMarketplace || "", at: Date.now() }); return; }
        const p = await prazoDo(tk, envio);
        if (igual(ant, p)) return;
        await grava(r.id, { ...p, at: Date.now() }); gravados++;
      } catch (e) { erros.push(`${d.num || r.id}: ${(e as Error).message}`); }
    }));
    if (Date.now() - t0 > 110000) break;
  }
  const info = { lastRun: Date.now(), ms: Date.now() - t0, lidos: rows.length, gravados, semEnvio, erros: erros.slice(0, 5) };
  if (!only) await sb.from("config").upsert({ id: "ml_prazos", data: info, updated_at: new Date().toISOString() }, { onConflict: "id" });
  return info;
}

async function isAdmin(req: Request) {
  const t = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: u } = await sb.auth.getUser(t); if (!u?.user) return false;
  const { data: me } = await sb.from("profiles").select("role,active").eq("id", u.user.id).maybeSingle();
  return me?.role === "admin" && me?.active !== false;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const b = await req.json().catch(() => ({}));
    const { data: s } = await sb.from("app_secrets").select("value").eq("name", "push_webhook").maybeSingle();
    const internal = !!req.headers.get("x-push-secret") && req.headers.get("x-push-secret") === s?.value;
    if (!internal && !(await isAdmin(req))) return json({ error: "Acesso negado." }, 403);
    if (b.action === "sync") return json({ ok: true, ...(await sync()) });
    if (b.action === "one" && b.id) return json({ ok: true, ...(await sync(String(b.id))) });
    return json({ error: "Ação inválida." }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
