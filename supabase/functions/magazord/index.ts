// Picking Serena · integração Magazord (e-commerce)
//  Administrador (JWT):  {action:"config", url, token, senha}  -> guarda as credenciais no servidor
//                        {action:"status"}                      -> mostra se está configurado (sem revelar a senha)
//                        {action:"test"}                        -> testa a conexão e resume os pedidos recentes
//                        {action:"sync"}                        -> importa agora
//  Interno (x-push-secret): {action:"sync"}                     -> importação automática (agendada a cada 2 min)
//                           {action:"probe"|"meta"}             -> estrutura dos campos (sem dados pessoais) para o mapeamento
import { createClient } from "npm:@supabase/supabase-js@2.117.3";

const URL_ = Deno.env.get("SUPABASE_URL")!;
let KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
if (!KEY) { try { KEY = Object.values(JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}"))[0] as string; } catch { /* */ } }
const sb = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

async function getSecret(name: string) { const { data } = await sb.from("app_secrets").select("value").eq("name", name).maybeSingle(); return data?.value as string | undefined; }
async function setSecret(name: string, value: string) { const { error } = await sb.from("app_secrets").upsert({ name, value }, { onConflict: "name" }); if (error) throw error; }

function baseUrl(u: string) {
  let s = String(u || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  s = s.replace(/\/api(\/.*)?$/i, "");
  return s;
}
async function creds() {
  const url = await getSecret("magazord_url"), token = await getSecret("magazord_token"), senha = await getSecret("magazord_senha");
  if (!url || !token || !senha) throw new Error("Integração Magazord não configurada.");
  return { url: baseUrl(url), auth: "Basic " + btoa(`${token}:${senha}`) };
}
async function mz(path: string) {
  const c = await creds();
  const r = await fetch(c.url + "/api" + path, { headers: { Authorization: c.auth, Accept: "application/json" } });
  const text = await r.text(); let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* texto */ }
  return { status: r.status, body };
}

// Estrutura sem dados pessoais: mostra só nomes de campos e tipos; valores apenas de campos "de classificação"
const SHOW = /situac|status|transport|frete|entrega|servico|loja|origem|marketplace|canal|plataforma|tipo|forma|codigo$|^id$|sku|ean|gtin|quantidade|qtd|^data|deposito|nome$/i;
const PII = /pessoa|cliente|cpf|cnpj|email|telefone|fone|celular|endereco|logradouro|cep|bairro|numero|complemento|documento|rg|nascimento|ip/i;
function shape(v: unknown, key = "", depth = 0, path = ""): unknown {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.length ? [shape(v[0], key, depth + 1, path + "[]"), `(${v.length} itens)`] : [];
  if (typeof v === "object") {
    if (depth > 5) return "{…}";
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = PII.test(path + "." + k) && typeof x !== "object" ? `<${typeof x}>` : shape(x, k, depth + 1, path + "." + k);
    return o;
  }
  if (typeof v === "string") return SHOW.test(key) && !PII.test(path) && v.length <= 80 ? v : `<string>`;
  return SHOW.test(key) && !PII.test(path) ? v : `<${typeof v}>`;
}
function listOf(body: any): any[] {
  const d = body?.data ?? body;
  if (Array.isArray(d)) return d;
  for (const k of ["items", "itens", "pedidos", "data", "results", "registros"]) if (Array.isArray(d?.[k])) return d[k];
  return [];
}
// valores distintos de campos de classificação nos pedidos recentes (para o administrador ver situações, transportadoras e lojas)
function distinct(list: any[]) {
  const out: Record<string, Record<string, number>> = {};
  const walk = (v: any, path: string, depth: number) => {
    if (v == null || depth > 3) return;
    if (Array.isArray(v)) return;
    if (typeof v === "object") { for (const [k, x] of Object.entries(v)) walk(x, path ? path + "." + k : k, depth + 1); return; }
    const leaf = path.split(".").pop() || "";
    if (/situac|status|transport|loja|origem|marketplace|canal|plataforma|servico|formaEntrega|frete/i.test(path) && !PII.test(path) && String(v).length <= 80 && !/^(id|codigo)$/i.test(leaf) || /(situacao|loja|transportadora|marketplace|origem).*(nome|descricao|id|codigo)$/i.test(path)) {
      (out[path] ||= {})[String(v)] = ((out[path] ||= {})[String(v)] || 0) + 1;
    }
  };
  list.forEach((o) => walk(o, "", 0));
  return out;
}

/* ================== Prazo de despacho do Mercado Livre ==================
   Na importação, todo pedido do ML consulta o envio e o SLA no Mercado Livre (mesma conexão do app Envio Full,
   tabela full_ml_auth) e entra no Picking já com mlPrazo = { limite, sla, tipo, envio, st, sub, at }.
   O dia é definido na venda, mas o ML pode acertar a hora de corte depois (reconsulta a cada 30 min, só prazos de hoje/amanhã). Se o ML não responder, o pedido entra sem prazo
   e a próxima importação (2 min) tenta de novo só os que ficaram sem prazo (até 5 tentativas).
   codigoMarketplace "2000…" = pedido ou carrinho (pack); "S-4860…" = já é o número do envio. */
const ML = "https://api.mercadolibre.com";
const ML_ID = Deno.env.get("ML_CLIENT_ID") || "770978757588091";
const espera = (ms: number) => new Promise((z) => setTimeout(z, ms));
const isML = (o: any) => /mercado\s*livre/i.test(String(o?.origem || ""));
async function mlAuth() { const { data, error } = await sb.from("full_ml_auth").select("access_token,refresh_token,expira").eq("id", 1).maybeSingle(); if (error) throw error; return data; }
// o refresh_token do ML só vale uma vez: renova com folga e só grava se o Envio Full não renovou no meio do caminho
async function mlToken(): Promise<string> {
  const a = await mlAuth();
  if (!a || (!a.refresh_token && !a.access_token)) throw new Error("Mercado Livre não conectado (conecte pelo app Envio Full).");
  if (a.access_token && new Date(a.expira).getTime() > Date.now() + 600000) return a.access_token;
  if (!a.refresh_token) throw new Error("Conexão com o Mercado Livre expirada (conecte de novo pelo app Envio Full).");
  const sec = Deno.env.get("ML_CLIENT_SECRET"); if (!sec) throw new Error("Falta a ML_CLIENT_SECRET nos secrets das Edge Functions.");
  const r = await fetch(`${ML}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: ML_ID, client_secret: sec, refresh_token: a.refresh_token }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    await espera(1500); const b = await mlAuth();
    if (b?.access_token && b.access_token !== a.access_token && new Date(b.expira).getTime() > Date.now() + 60000) return b.access_token;
    if (a.access_token && new Date(a.expira).getTime() > Date.now() + 30000) return a.access_token;
    throw new Error(`Mercado Livre recusou a renovação do token: ${j.message || j.error || r.status}`);
  }
  await sb.from("full_ml_auth").update({ access_token: j.access_token, refresh_token: j.refresh_token || a.refresh_token,
    expira: new Date(Date.now() + (j.expires_in || 21600) * 1000).toISOString(), msg: null, updated_at: new Date().toISOString() }).eq("id", 1).eq("refresh_token", a.refresh_token);
  return j.access_token;
}
async function mlGet(tk: string, path: string): Promise<{ status: number; body: any }> {
  for (let t = 0; t < 3; t++) {
    const r = await fetch(ML + path, { headers: { authorization: `Bearer ${tk}`, accept: "application/json" } });
    if (r.status === 429 || r.status >= 500) { await espera(1000 * 2 ** t); continue; }
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }
  return { status: 429, body: {} };
}
async function mlPrazo(tk: string, cod: string, envioAnt?: string) {
  const c = String(cod || "").trim();
  let envio = envioAnt || (c.match(/^S-?(\d{6,})$/i) || [])[1] || "";
  if (!envio && /^\d{10,}$/.test(c)) {
    const o = await mlGet(tk, `/orders/${c}`);
    if (o.status === 200 && o.body?.shipping?.id) envio = String(o.body.shipping.id);
    else { const p = await mlGet(tk, `/packs/${c}`); if (p.status === 200 && p.body?.shipment?.id) envio = String(p.body.shipment.id); }
  }
  if (!envio) throw new Error("envio não encontrado no Mercado Livre");
  const [sh, sla] = await Promise.all([mlGet(tk, `/shipments/${envio}`), mlGet(tk, `/shipments/${envio}/sla`)]);
  const S = sh.status === 200 ? sh.body : {}, L = sla.status === 200 ? sla.body : {};
  const limite = L?.expected_date || S?.shipping_option?.estimated_handling_limit?.date || S?.lead_time?.estimated_handling_limit?.date || null;
  if (!limite) throw new Error(`prazo indisponível (envio ${envio}, ${sh.status}/${sla.status})`);
  return { envio, limite, sla: L?.status || null, tipo: S?.logistic_type || null, st: S?.status || null, sub: S?.substatus || null, at: Date.now() };
}

/* ================== Importação dos pedidos ================== */
const SITUACAO_IMPORTAR = 5;             // Crédito e Cadastro Aprovados
const IGNORAR_CANAL = /full/i;           // Mercado Livre Full: sai do armazém do Mercado Livre
const JANELA_HORAS = 72;                 // só entram pedidos feitos nas últimas 72 h (pendências antigas da loja ficam de fora)
const eanNorm = (e: unknown) => { let s = String(e ?? "").replace(/\D/g, ""); while (s.length > 13 && s.startsWith("0")) s = s.slice(1); return s; };
const toMs = (d: unknown) => { const t = Date.parse(String(d || "").replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00")); return isNaN(t) ? Date.now() : t; };

async function productIndex() {
  const all: any[] = []; let from = 0;
  for (;;) { const { data, error } = await sb.from("products").select("id,data").range(from, from + 999); if (error) throw error; all.push(...data); if (data.length < 1000) break; from += 1000; }
  const byEan = new Map<string, any>(), byId = new Map<string, any>();
  for (const p of all) { byId.set(p.id, p); const e = eanNorm(p.data?.ean); if (e) byEan.set(e, p); }
  return { byEan, byId };
}
function mapOrder(d: any, idx: { byEan: Map<string, any>; byId: Map<string, any> }) {
  const rastreios = (d.arrayPedidoRastreio || []).filter((r: any) => r && typeof r === "object");
  const r0 = rastreios[0] || {};
  const items = new Map<string, any>();
  for (const r of rastreios) for (const it of (r.pedidoItem || [])) {
    if (!it || typeof it !== "object") continue;
    const sku = String(it.produtoDerivacaoCodigo || ""), ean = eanNorm(it.ean);
    // produto do Picking Serena: primeiro pelo código do SKU vendido (13088-001-U -> 13088); o EAN do site só entra quando o código
    // não existe no Picking. O cadastro do site às vezes repete o EAN de outra variação (ex.: 10863 escovado com o EAN do 10248 gold).
    const pSku = idx.byId.get(sku) || idx.byId.get(sku.split("-")[0]), pEan = ean ? idx.byEan.get(ean) : undefined;
    const p = pSku || pEan;
    const eanOutro = pSku && pEan && pEan.id !== pSku.id ? pEan.id : "";
    const code = p ? p.id : (sku || ean || String(it.id));
    const q = Number(it.quantidade) || 0;
    const cur = items.get(code);
    if (cur) { cur.qty += q; continue; }
    items.set(code, { code, name: p?.data?.name || [it.produtoNome, it.produtoDerivacaoNome].filter(Boolean).join(" · "), ean: p?.data?.ean || (eanOutro ? "" : ean), // EAN do site que é de outro produto não vale para bipar
      un: "UN", qty: q, price: Number(it.valorUnitario) || 0, loc: p?.data?.loc || "", qtyEnc: 0, eta: "", sku, ...(p ? {} : { semCadastro: true }), ...(eanOutro ? { eanSiteDe: eanOutro } : {}) });
  }
  return {
    id: "MZ-" + d.id, num: String(d.codigo || d.id), mzId: d.id, codigoMarketplace: d.codigoMarketplace || "",
    client: d.pessoaNome || d.nomeDestinatario || "", city: d.cidadeNome || "", obs: "",
    canal: "ecommerce", origem: d.lojaDoMarketplaceNome || d.marketplaceNome || "Site",
    transportadora: r0.transportadoraNome || "", servico: r0.transportadoraServicoDescricao || "",
    mode: "total", v2: true, remessa: 1, status: "aguardando", items: [...items.values()],
    createdAt: toMs(d.dataHora), importedAt: Date.now(), mzSituacao: d.pedidoSituacao, createdBy: "",
    mzOrigem: d.origem ?? null, mzTipoCad: d.tipoCadastroPM ?? null, // como o pedido foi criado na Magazord (site, manual, marketplace)
  };
}
async function patchOrder(id: string, data: any, patch: Record<string, unknown>) {
  await sb.from("orders").update({ data: { ...data, ...patch }, updated_at: new Date().toISOString() }).eq("id", id);
}
async function sync(horas = JANELA_HORAS) {
  const t0 = Date.now(), idx = await productIndex();
  const fetched: any[] = [];
  for (let page = 1; page <= 5; page++) {
    const r = await mz(`/v2/site/pedido?limit=100&page=${page}&orderDirection=desc&situacao=${SITUACAO_IMPORTAR}`);
    if (r.status >= 400) throw new Error(`A Magazord respondeu erro ${r.status}`);
    fetched.push(...listOf(r.body));
    if (!(r.body as any)?.data?.has_more) break;
  }
  const inicio = Number(await getSecret("magazord_inicio")) || 0; // ponto de partida da integração
  const corte = Math.max(Date.now() - horas * 36e5, inicio);
  const eligible = fetched.filter((o) => !IGNORAR_CANAL.test(String(o.lojaDoMarketplaceNome || "")) && toMs(o.dataHora) >= corte);
  const ids = eligible.map((o) => "MZ-" + o.id);
  const have = new Map<string, any>();
  for (let i = 0; i < ids.length; i += 200) { const { data } = await sb.from("orders").select("id,data").in("id", ids.slice(i, i + 200)); (data || []).forEach((x) => have.set(x.id, x.data)); }
  let imported = 0, cancelled = 0, changed = 0, restored = 0; const errors: string[] = [];
  let tkML: string | null = null, tkErr = "";
  const tkGet = async () => { if (tkML) return tkML; if (tkErr) throw new Error(tkErr); try { return tkML = await mlToken(); } catch (e) { tkErr = (e as Error).message; throw e; } };
  let prazos = 0;
  for (const o of eligible) {
    const cur = have.get("MZ-" + o.id);
    if (cur) {
      // saiu da fila sozinho porque a situação mudou e agora voltou para a 5: volta para a fila
      if (cur.status === "excluido" && cur.mzAuto) { await patchOrder("MZ-" + o.id, cur, { status: "aguardando", mzAuto: false, deletedAt: null, deleteReason: "", mzSituacao: SITUACAO_IMPORTAR, mzSituacaoDesc: "" }); restored++; }
      else if (!("mzOrigem" in cur) && ["aguardando", "separando"].includes(cur.status)) { // pedidos importados antes de guardar a origem
        try { const d = await mz(`/v2/site/pedido/${encodeURIComponent(String(o.codigo))}`); const det = (d.body as any)?.data; if (det) await patchOrder("MZ-" + o.id, cur, { mzOrigem: det.origem ?? null, mzTipoCad: det.tipoCadastroPM ?? null }); } catch { /* tenta na próxima */ }
      }
      continue;
    }
    try {
      const d = await mz(`/v2/site/pedido/${encodeURIComponent(String(o.codigo))}`);
      const det = (d.body as any)?.data ?? d.body;
      if (d.status >= 400 || !det || typeof det !== "object") throw new Error("detalhe " + d.status);
      const ord = mapOrder(det, idx);
      if (!ord.items.length) continue;
      if (isML(ord) && ord.codigoMarketplace) { // prazo de despacho do ML: se falhar, entra sem prazo e tenta na próxima
        try { (ord as any).mlPrazo = await mlPrazo(await tkGet(), ord.codigoMarketplace); prazos++; }
        catch (e) { (ord as any).mlPrazo = { erro: (e as Error).message.slice(0, 120), tent: 1, at: Date.now() }; errors.push(`${o.codigo} (prazo ML): ${(e as Error).message}`); }
      }
      const { error } = await sb.from("orders").insert({ id: ord.id, data: ord });
      if (error) { if (!/duplicate|unique/i.test(error.message)) throw error; } else imported++;
    } catch (e) { errors.push(`${o.codigo}: ${(e as Error).message}`); }
  }
  // pedidos do ML na fila que ficaram sem prazo (ML fora do ar, token): tenta de novo, até 5 vezes
  { const { data: sem } = await sb.from("orders").select("id,data").like("id", "MZ-%").filter("data->>origem", "ilike", "%mercado%livre%")
      .filter("data->>status", "in", "(aguardando,separando)").is("data->mlPrazo->>limite", null).limit(20);
    for (const row of (sem || [])) {
      const ant = row.data?.mlPrazo || {}; if (!row.data?.codigoMarketplace || (ant.tent || 0) >= 5) continue;
      let p: Record<string, unknown>;
      try { p = await mlPrazo(await tkGet(), row.data.codigoMarketplace, ant.envio); prazos++; }
      catch (e) { p = { ...ant, erro: (e as Error).message.slice(0, 120), tent: (ant.tent || 0) + 1, at: Date.now() }; }
      await sb.rpc("ml_prazo_set", { p_id: row.id, p_prazo: p }); // só o campo mlPrazo (não sobrescreve o que a expedição mudou)
    } }
  // o ML acerta a HORA de corte depois da venda (ex.: 16:00 virou 13:30 na impressão da etiqueta; o dia não muda).
  // Pedidos do ML ainda não enviados, com prazo para hoje ou amanhã: confere de novo a cada 30 min e regrava.
  { const dia = (t: number) => new Date(t - 3 * 36e5).toISOString().slice(0, 10); // dia em Brasília
    const amanha = dia(Date.now() + 864e5);
    const { data: rec } = await sb.from("orders").select("id,data").like("id", "MZ-%").filter("data->>origem", "ilike", "%mercado%livre%")
      .filter("data->>status", "in", "(aguardando,separando,na_mesa,na_colmeia,pronto_envio)").gt("data->>createdAt", String(Date.now() - 6 * 864e5));
    const alvo = (rec || []).filter((r: any) => { const p = r.data?.mlPrazo; if (!p?.limite || !p.envio) return false;
      const d = String(p.limite).slice(0, 10); return (d <= amanha) && d >= dia(Date.now() - 864e5) && Date.now() - (p.at || 0) > 30 * 60e3; }).slice(0, 25);
    for (const r of alvo) {
      try { const ant = r.data.mlPrazo, p = await mlPrazo(await tkGet(), r.data.codigoMarketplace, ant.envio);
        if (p.limite !== ant.limite) prazos++;
        await sb.rpc("ml_prazo_set", { p_id: r.id, p_prazo: p });
      } catch (e) { errors.push(`${r.data.num} (reconsulta ML): ${(e as Error).message}`); }
    } }
  // pedidos do e-commerce ainda na fila cuja situação mudou na Magazord (qualquer situação diferente da 5): saem da fila
  const elig = new Set(fetched.map((o) => "MZ-" + o.id)); // ainda na situação 5 (mesmo fora da janela de dias)
  const { data: active } = await sb.from("orders").select("id,data").like("id", "MZ-%").filter("data->>status", "in", "(aguardando,separando)");
  for (const row of (active || [])) {
    if (elig.has(row.id)) continue;
    try {
      const d = await mz(`/v2/site/pedido/${encodeURIComponent(String(row.data.num))}`);
      const det = (d.body as any)?.data; if (!det) continue;
      const sit = Number(det.pedidoSituacao), desc = det.pedidoSituacaoDescricao || "";
      if (sit === SITUACAO_IMPORTAR) continue;
      if (sit === 2) cancelled++; else changed++;
      const motivo = sit === 2 ? "Cancelado na Magazord" : `Situação mudou na Magazord: ${desc || sit}`;
      if (row.data.status === "aguardando") // ainda não foi separado: sai da fila
        await patchOrder(row.id, row.data, { status: "excluido", deletedAt: Date.now(), deletedBy: "", deleteReason: motivo, mzAuto: true, mzSituacao: sit, mzSituacaoDesc: desc });
      else // já em separação: avisa o separador na tela
        await patchOrder(row.id, row.data, { mzCancelado: sit === 2, mzMudou: true, mzSituacao: sit, mzSituacaoDesc: desc });
    } catch (e) { errors.push(`${row.data.num}: ${(e as Error).message}`); }
  }
  const full = fetched.filter((o) => IGNORAR_CANAL.test(String(o.lojaDoMarketplaceNome || ""))).length;
  const info = { lastRun: Date.now(), ms: Date.now() - t0, horas, found: eligible.length, full, old: fetched.length - eligible.length - full, imported, prazos, cancelled, changed, restored, errors: errors.slice(0, 5) };
  await sb.from("config").upsert({ id: "magazord_sync", data: info, updated_at: new Date().toISOString() }, { onConflict: "id" });
  return info;
}

async function isAdmin(req: Request) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: u } = await sb.auth.getUser(token);
  if (!u?.user) return false;
  const { data: me } = await sb.from("profiles").select("role,active").eq("id", u.user.id).maybeSingle();
  return me?.role === "admin" && me?.active !== false;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const b = await req.json().catch(() => ({}));
    const internal = req.headers.get("x-push-secret") && req.headers.get("x-push-secret") === await getSecret("push_webhook");
    if (!internal && !(await isAdmin(req))) return json({ error: "Só o Administrador pode acessar a integração." }, 403);

    if (b.action === "config") {
      if (!b.url) return json({ error: "Informe o endereço do painel Magazord." }, 400);
      await setSecret("magazord_url", baseUrl(b.url));
      if (b.token) await setSecret("magazord_token", String(b.token).trim());
      if (b.senha) await setSecret("magazord_senha", String(b.senha).trim());
      return json({ ok: true });
    }
    if (b.action === "status") {
      const url = await getSecret("magazord_url"), token = await getSecret("magazord_token"), senha = await getSecret("magazord_senha");
      return json({ configured: !!(url && token && senha), url: url || "", token: token ? token.slice(0, 4) + "…" : "", senha: !!senha });
    }
    if (b.action === "reset") { // só Administrador (pela tela): apaga os pedidos importados e importa de novo
      if (internal) return json({ error: "Ação só pela tela do Administrador." }, 403);
      const { error, count } = await sb.from("orders").delete({ count: "exact" }).like("id", "MZ-%");
      if (error) throw error;
      const h = Math.min(Math.max(Number(b.horas) || 24, 1), 24 * 30);
      await setSecret("magazord_inicio", String(Date.now() - h * 36e5)); // daqui pra frente nada antes disso entra
      const info = await sync(h);
      return json({ ok: true, removed: count || 0, ...info });
    }
    if (b.action === "sync") return json({ ok: true, ...(await sync(Math.min(Math.max(Number(b.horas) || JANELA_HORAS, 1), 24 * 30))) });
    if (b.action === "meta" && internal) { // diagnóstico: paginação e filtros, sem dados pessoais
      const out: Record<string, unknown> = {};
      for (const q of (b.queries || ["?limit=5&page=1"])) {
        const r = await mz("/v2/site/pedido" + q); const body: any = r.body; const d = body?.data;
        const meta = d && typeof d === "object" && !Array.isArray(d) ? Object.fromEntries(Object.entries(d).filter(([, v]) => !Array.isArray(v))) : null;
        out[q] = { status: r.status, meta, rows: listOf(body).map((o: any) => [o.id, o.dataHora, o.pedidoSituacao, o.pedidoSituacaoDescricao, o.lojaDoMarketplaceNome]), err: r.status >= 400 ? (typeof body === "string" ? body.slice(0, 200) : body?.message || body?.error) : undefined };
      }
      return json(out);
    }
    if (b.action === "origens" && internal) { // diagnóstico: como a Magazord marca a origem (site, manual, marketplace)
      const r = await mz("/v2/site/pedido?limit=" + Math.min(Number(b.n) || 40, 100) + "&page=1&orderDirection=desc");
      const out: Record<string, Record<string, number>> = {};
      for (const o of listOf(r.body)) {
        const d = await mz(`/v2/site/pedido/${encodeURIComponent(String(o.codigo))}`); const det = (d.body as any)?.data; if (!det) continue;
        const key = `origem=${JSON.stringify(det.origem)} tipoCadastroPM=${JSON.stringify(det.tipoCadastroPM)} mkt=${det.lojaDoMarketplaceNome || det.marketplaceNome || "-"} vend=${det.codigoVendedor ? "sim" : "não"} src=${String(det.pedidoTrackingSource ?? "-").slice(0, 30)}`;
        (out[key] ||= {})[String(det.pedidoSituacaoDescricao || "")] = ((out[key] ||= {})[String(det.pedidoSituacaoDescricao || "")] || 0) + 1;
      }
      return json({ ok: true, out });
    }
    if (b.action === "test" || b.action === "probe") {
      const q = b.query || "?limit=50&page=1";
      const r = await mz("/v2/site/pedido" + q);
      if (r.status === 401 || r.status === 403) return json({ ok: false, error: "A Magazord recusou o token/senha (erro " + r.status + "). Confira as credenciais e as permissões do token para /api/v2/site/pedido." });
      if (r.status >= 400) return json({ ok: false, error: `A Magazord respondeu erro ${r.status}.`, body: typeof r.body === "string" ? r.body.slice(0, 300) : shape(r.body) });
      const list = listOf(r.body);
      const res: Record<string, unknown> = { ok: true, count: list.length, distinct: distinct(list) };
      if (b.action === "probe") {
        res.top = shape(typeof r.body === "object" && r.body ? { ...(r.body as Record<string, unknown>), data: undefined } : r.body);
        res.list0 = shape(list[0]);
        const id = list[0]?.codigo ?? list[0]?.id;
        if (id != null) { const d = await mz(`/v2/site/pedido/${encodeURIComponent(String(id))}`); res.detailStatus = d.status; res.detail = shape((d.body as any)?.data ?? d.body); }
      }
      return json(res);
    }
    return json({ error: "Ação inválida." }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
