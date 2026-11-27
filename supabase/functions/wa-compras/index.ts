// Picking Serena · Pedidos de Compras pelo WhatsApp (Evolution API)
//  Webhook da Evolution (evento MESSAGES_UPSERT, base64 ligado) -> esta função.
//  - Número conectado (conversa consigo mesmo): só processa o que começa com "Serena".
//  - Números em wa_autorizados: processa tudo (ou exige "Serena" se exige_prefixo).
//  - Qualquer outra conversa é descartada na entrada, sem gravar nada.
//  Áudio -> transcrição (OpenAI, chave em app_secrets.openai_api_key) -> Claude (app_secrets.anthropic_api_key)
//  -> rascunho em wa_pedidos -> resumo + "Confirma?" -> confirmado (aparece em Compras).
import { createClient } from "npm:@supabase/supabase-js@2.117.3";
import * as XLSX from "npm:xlsx@0.18.5";

const URL_ = Deno.env.get("SUPABASE_URL")!;
let KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
if (!KEY) { try { KEY = Object.values(JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}"))[0] as string; } catch { /* */ } }
const sb = createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const BOT = "🤖 ";
const JANELA_MIN = 30; // conversa aberta: responde sem precisar de "Serena"
const PREFIXO = /^[\s\W]*(?:(?:ô|ó|oi|ei|olá|ola|e aí|e ai)[\s,!]+)?serena\b[\s,.:;!-]*/i;
const FORNECEDORES = "Torralba, Zen (Zen Design), Italyline (Italy), Jador, Living";

const ok = () => new Response("ok", { status: 200 });
const digits = (s: unknown) => String(s || "").split("@")[0].split(":")[0].replace(/\D/g, "");

let cfgCache: { at: number; v: Record<string, string> } | null = null;
async function cfg() {
  if (cfgCache && Date.now() - cfgCache.at < 60_000) return cfgCache.v;
  const { data } = await sb.from("app_secrets").select("name,value")
    .in("name", ["anthropic_api_key", "lucas_model", "openai_api_key", "evolution_url", "evolution_instance"]);
  const v = Object.fromEntries((data || []).map((r) => [r.name, r.value])) as Record<string, string>;
  cfgCache = { at: Date.now(), v };
  return v;
}

// confere com a própria Evolution que a apikey do webhook é da nossa instância (evita chamadas falsas)
const chavesOk = new Map<string, number>();
async function chaveValida(c: Record<string, string>, apikey: string) {
  if (!apikey) return false;
  const t = chavesOk.get(apikey);
  if (t && Date.now() - t < 3600_000) return true;
  try {
    const r = await fetch(`${c.evolution_url}/instance/connectionState/${encodeURIComponent(c.evolution_instance)}`, { headers: { apikey } });
    if (r.ok) { chavesOk.set(apikey, Date.now()); return true; }
  } catch { /* */ }
  return false;
}

async function enviar(c: Record<string, string>, apikey: string, numero: string, texto: string) {
  const r = await fetch(`${c.evolution_url}/message/sendText/${encodeURIComponent(c.evolution_instance)}`, {
    method: "POST", headers: { apikey, "Content-Type": "application/json" },
    body: JSON.stringify({ number: numero, text: BOT + texto }),
  });
  const j = await r.json().catch(() => ({}));
  const id = j?.key?.id;
  if (id) await sb.from("wa_msgs").upsert({ id, origem: "bot" });
  if (!r.ok) console.log("falha ao enviar", r.status, JSON.stringify(j).slice(0, 300));
}

// Áudio sem base64 no webhook: baixa do WhatsApp e descriptografa com a mediaKey (padrão do WhatsApp)
const toBytes = (v: any): Uint8Array | null => {
  if (!v) return null;
  if (typeof v === "string") return Uint8Array.from(atob(v), (c) => c.charCodeAt(0));
  if (Array.isArray(v?.data)) return new Uint8Array(v.data);
  if (typeof v === "object") return new Uint8Array(Object.keys(v).sort((a, b) => +a - +b).map((k) => +v[k]));
  return null;
};
const toB64 = (u: Uint8Array) => { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
async function baixarAudio(a: any): Promise<string | null> {
  const mk = toBytes(a?.mediaKey);
  const url = a?.url && String(a.url).startsWith("http") ? a.url : a?.directPath ? "https://mmg.whatsapp.net" + a.directPath : null;
  if (!mk || !url) return null;
  const r = await fetch(url);
  if (!r.ok) { console.log("download do áudio falhou", r.status); return null; }
  const enc = new Uint8Array(await r.arrayBuffer());
  const ikm = await crypto.subtle.importKey("raw", mk, "HKDF", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: new TextEncoder().encode("WhatsApp Audio Keys") }, ikm, 112 * 8));
  const key = await crypto.subtle.importKey("raw", bits.slice(16, 48), "AES-CBC", false, ["decrypt"]);
  const dec = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: bits.slice(0, 16) }, key, enc.slice(0, enc.length - 10)));
  return toB64(dec);
}

async function transcrever(c: Record<string, string>, b64: string, mime: string) {
  if (!c.openai_api_key) return null;
  const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  for (const model of ["gpt-4o-mini-transcribe", "whisper-1"]) {
    const fd = new FormData();
    fd.append("file", new Blob([bytes], { type: mime || "audio/ogg" }), "audio.ogg");
    fd.append("model", model);
    fd.append("language", "pt");
    fd.append("prompt", `Serena, pedido ao fornecedor, ${FORNECEDORES}, puxador, peças, dourado, cromado, preto fosco.`);
    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${c.openai_api_key}` }, body: fd });
    if (r.ok) { const j = await r.json(); return String(j.text || "").trim(); }
    console.log("transcrição falhou", model, r.status);
  }
  return null;
}

// ---------- ferramentas do assistente ----------
const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
async function buscarProdutos(termo: string) {
  const t = norm(String(termo || "")).replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length >= 2 && !["de", "do", "da", "com", "pux", "puxador", "pecas", "peca"].includes(w)).slice(0, 6);
  if (!t.length) return [];
  if (/^\d{4,6}$/.test(t[0]) && t.length === 1) {
    const { data } = await sb.from("products").select("id,data").eq("id", t[0]).limit(1);
    if (data?.length) return data.map((p) => ({ code: p.id, nome: p.data?.name }));
  }
  let q = sb.from("products").select("id,data");
  for (const w of t) q = q.ilike("data->>name", `%${w}%`);
  const { data } = await q.limit(15);
  if (data && data.length) return data.map((p) => ({ code: p.id, nome: p.data?.name }));
  // sem resultado com todas as palavras: ranqueia por quantas palavras aparecem
  const score = new Map<string, { code: string; nome: string; n: number }>();
  for (const w of t) {
    const { data: d } = await sb.from("products").select("id,data").ilike("data->>name", `%${w}%`).limit(200);
    for (const p of d || []) { const e = score.get(p.id) || { code: p.id, nome: p.data?.name, n: 0 }; e.n++; score.set(p.id, e); }
  }
  return [...score.values()].sort((a, b) => b.n - a.n).slice(0, 12).map(({ code, nome }) => ({ code, nome }));
}

// ---------- planilha das encomendas em aberto (mesma regra da aba Compras do Picking) ----------
const isoOf = (d: unknown) => { const s = String(d || ""); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : /^\d{2}\/\d{2}\/\d{4}$/.test(s) ? s.split("/").reverse().join("-") : ""; };
const hojeISO = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const diasAte = (iso: string) => Math.round((Date.parse(iso + "T12:00:00Z") - Date.parse(hojeISO() + "T12:00:00Z")) / 864e5);
const brData = (iso: string) => iso ? iso.split("-").reverse().join("/") : "";
const SIT: Record<string, string> = { falta: "A encomendar", parcial: "Encomendado em parte", pedido: "Encomendado", fatparc: "Faturado em parte", faturado: "Faturado · a caminho", chegou: "Chegou" };

async function linhasEncomendas() {
  const all: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("orders").select("id,data").not("data->>status", "in", "(enviado,excluido,analise_compras)").order("id").range(from, from + 999);
    if (error) throw new Error(error.message);
    all.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const { data: pur } = await sb.from("purchases").select("id,data");
  const P = Object.fromEntries((pur || []).map((p) => [p.id, p.data || {}]));
  const { data: nfs } = await sb.from("invoices").select("id,data");
  const N = Object.fromEntries((nfs || []).map((n) => [n.id, n.data || {}]));
  const linhas: any[] = [];
  for (const r of all) {
    const o = r.data || {};
    if (o.arrivedAt || (o.mode === "parcial" && o.remessa === 2)) continue;
    (o.items || []).forEach((it: any) => {
      const qtyEnc = (+it.qtyEnc || 0) - (+it.qtyDec || 0);
      if (qtyEnc <= 0) return;
      const links = it.compra?.links || [];
      const nfL = it.compra?.nf || [];
      const qPed = links.reduce((s: number, l: any) => s + (+l.qty || 0), 0);
      const qNf = nfL.reduce((s: number, n: any) => s + (+n.qty || 0), 0);
      const qRec = nfL.reduce((s: number, n: any) => { const R = N[n.id]?.received; if (!R) return s; const v = n.key && R.alloc ? R.alloc[n.key] : undefined; return s + (v != null ? +v : (+n.qty || 0)); }, 0);
      const st = it.compra?.st === "chegou" || qRec >= qtyEnc ? "chegou" : qNf >= qtyEnc ? "faturado" : qNf > 0 ? "fatparc" : qPed >= qtyEnc ? "pedido" : links.length ? "parcial" : "falta";
      if (st === "chegou") return;
      const prev = links.map((l: any) => isoOf(l.prev || l.entrega)).filter(Boolean).sort().pop() || "";
      const d = prev ? diasAte(prev) : null;
      const prazo = d == null ? "" : d < 0 ? `Atrasado ${-d} dia${d === -1 ? "" : "s"}` : d === 0 ? "Chega hoje" : d <= 2 ? `Chega em ${d} dia${d === 1 ? "" : "s"}` : "No prazo";
      const forn = [...new Set(links.map((l: any) => [P[l.pid]?.forn, (l.ped || P[l.pid]?.num) ? "ped. " + (l.ped || P[l.pid]?.num) : ""].filter(Boolean).join(" · ")))].join(" | ");
      const pvIso = isoOf(o.date);
      const idade = pvIso ? -diasAte(pvIso) : null;
      linhas.push({
        "Pré-venda": o.num || r.id, "Data PV": o.date || "", "Dias": idade, "Cliente": o.client || "", "Vendedor": o.seller || "",
        "Código": it.code || "", "Item": it.name || "", "Marca": String(it.name || "").split(" - ")[0], "Qtd encomenda": qtyEnc, "Qtd pedida": qPed,
        "Situação": SIT[st], "Fornecedor · pedido": forn, "Previsão": brData(prev), "Prazo": prazo, "_st": st, "_atr": d != null && d < 0,
      });
    });
  }
  return linhas.sort((a, b) => (b.Dias ?? 0) - (a.Dias ?? 0));
}

async function enviarPlanilha(c: Record<string, string>, apikey: string, numero: string, inp: any) {
  let linhas = await linhasEncomendas();
  const f = norm(String(inp?.fornecedor || "")).trim();
  if (f) linhas = linhas.filter((l) => norm(l.Marca + " " + l["Fornecedor · pedido"] + " " + l.Item).includes(f.split(" ")[0]));
  const s = String(inp?.situacao || "todas");
  if (s === "a_encomendar") linhas = linhas.filter((l) => l._st === "falta" || l._st === "parcial");
  if (s === "encomendadas") linhas = linhas.filter((l) => !["falta"].includes(l._st));
  if (s === "atrasadas") linhas = linhas.filter((l) => l._atr || (l.Dias ?? 0) > 25);
  if (!linhas.length) return "nenhuma encomenda em aberto com esse filtro; planilha não enviada";
  const rows = linhas.map(({ _st, _atr, ...r }) => r);
  const ws = XLSX.utils.json_to_sheet(rows);
  ws["!cols"] = [8, 11, 6, 30, 12, 9, 46, 11, 10, 9, 20, 26, 11, 16].map((w) => ({ wch: w }));
  ws["!autofilter"] = { ref: ws["!ref"] };
  const { data: wa } = await sb.from("wa_pedidos").select("id,confirmado_em,nome,fornecedor,itens,previsao_entrega,status").eq("status", "confirmado").order("id");
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Encomendas em aberto");
  if (wa?.length) {
    const w2 = XLSX.utils.json_to_sheet(wa.flatMap((p) => (p.itens || []).map((i: any) => ({ "Pedido WhatsApp": p.id, "Confirmado em": new Date(p.confirmado_em).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }), "Por": p.nome, "Fornecedor": p.fornecedor, "Código": i.code || "", "Item": i.descricao, "Qtd": i.quantidade, "Previsão": brData(p.previsao_entrega || "") }))));
    w2["!cols"] = [10, 18, 14, 14, 9, 46, 6, 11].map((w) => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, w2, "Pedidos WhatsApp a lançar");
  }
  const b64 = XLSX.write(wb, { type: "base64", bookType: "xlsx" });
  const nome = `encomendas-em-aberto-${hojeISO()}.xlsx`;
  const pecas = linhas.reduce((t, l) => t + (+l["Qtd encomenda"] || 0), 0);
  const pvs = new Set(linhas.map((l) => l["Pré-venda"])).size;
  const r = await fetch(`${c.evolution_url}/message/sendMedia/${encodeURIComponent(c.evolution_instance)}`, {
    method: "POST", headers: { apikey, "Content-Type": "application/json" },
    body: JSON.stringify({ number: numero, mediatype: "document", mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", fileName: nome, media: b64, caption: `${BOT}Encomendas em aberto · ${pvs} pré-venda${pvs === 1 ? "" : "s"} · ${linhas.length} ite${linhas.length === 1 ? "m" : "ns"} · ${pecas} pç` }),
  });
  const j = await r.json().catch(() => ({}));
  if (j?.key?.id) await sb.from("wa_msgs").upsert({ id: j.key.id, origem: "bot" });
  if (!r.ok) { console.log("falha ao enviar planilha", r.status, JSON.stringify(j).slice(0, 300)); return "erro ao enviar o arquivo pelo WhatsApp"; }
  const atr = linhas.filter((l) => l._atr).length, falta = linhas.filter((l) => l._st === "falta").length;
  return `planilha enviada: ${pvs} pré-vendas, ${linhas.length} itens, ${pecas} peças; ${falta} itens ainda a encomendar; ${atr} itens com previsão vencida`;
}

const TOOLS = [
  { name: "enviar_planilha_encomendas", description: "Gera e envia pelo WhatsApp uma planilha Excel com as encomendas em aberto (pré-vendas aguardando encomenda: item, quantidade, situação, fornecedor, previsão e prazo). Use quando pedirem a planilha/lista/relatório das encomendas ou do que está aguardando.",
    input_schema: { type: "object", properties: {
      fornecedor: { type: "string", description: "Filtrar por marca/fornecedor, se a pessoa pediu (ex.: Torralba)" },
      situacao: { type: "string", enum: ["todas", "a_encomendar", "encomendadas", "atrasadas"], description: "todas (padrão); a_encomendar = ainda não pedidas ao fornecedor; encomendadas = já pedidas, aguardando chegada; atrasadas = previsão vencida ou pré-venda com mais de 25 dias" },
    } } },
  { name: "buscar_produtos", description: "Busca produtos no catálogo da Serena pelo nome, modelo, acabamento, marca ou código (SKU). Use para descobrir o código (SKU) de cada item citado.",
    input_schema: { type: "object", properties: { termo: { type: "string", description: "Ex.: 'torralba eira dourado', 'zen beetle rose', '10021'" } }, required: ["termo"] } },
  { name: "salvar_rascunho", description: "Salva (ou atualiza) o rascunho do pedido com o que já se sabe. Chame sempre que entender algo novo. Envie a lista COMPLETA de itens a cada vez.",
    input_schema: { type: "object", properties: {
      fornecedor: { type: "string" },
      previsao_entrega: { type: "string", description: "AAAA-MM-DD, se a pessoa informou" },
      observacao: { type: "string" },
      itens: { type: "array", items: { type: "object", properties: { code: { type: "string", description: "SKU da Serena, se identificado" }, descricao: { type: "string" }, quantidade: { type: "number" } }, required: ["descricao", "quantidade"] } },
    } } },
  { name: "confirmar_pedido", description: "Confirma o pedido e avisa o setor de Compras. Só chame depois de mostrar o resumo e a pessoa responder que confirma (sim/ok/pode lançar).", input_schema: { type: "object", properties: {} } },
  { name: "cancelar_pedido", description: "Cancela o rascunho atual, quando a pessoa desistir.", input_schema: { type: "object", properties: {} } },
];

function sistema(nome: string) {
  const hoje = new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });
  return `Você é o assistente de Compras da Serena Puxadores no WhatsApp. ${nome} usa você para (1) registrar um pedido que JÁ FEZ com um fornecedor, para o setor de Compras saber que ele existe, ou (2) receber a planilha das encomendas em aberto.
Hoje é ${hoje}. Fornecedores: ${FORNECEDORES}.

O que você precisa para lançar: fornecedor, e para cada item o produto (de preferência o SKU da Serena, achado com buscar_produtos) e a quantidade. Previsão de entrega e observação são opcionais (registre se a pessoa disser).
Como agir:
- As mensagens podem vir de áudio transcrito: entenda erros de transcrição pelo contexto (ex.: "eira" pode ser o modelo "Eira").
- Use buscar_produtos para cada item. Se achar um produto claramente certo, use o SKU. Se houver várias opções parecidas (ex.: tamanhos), pergunte mostrando no máximo 4 opções numeradas (código + nome curto). Se não achar, registre só a descrição falada.
- Se faltar o fornecedor ou a quantidade, pergunte de forma curta.
- Chame salvar_rascunho sempre que entender algo novo.
- Quando tiver tudo, salve e mande o resumo assim:
  *Pedido ao fornecedor <fornecedor>*
  • <qtd>x <nome do produto> (<SKU>)
  Previsão: <data ou "não informada">
  Confirma? Responda *sim* para lançar ou diga o que corrigir.
- Só chame confirmar_pedido depois de um "sim" claro a esse resumo. Depois de confirmar, responda curto: "Lançado ✅ Compras já foi avisado." com o número do pedido.
- Se a pessoa desistir, chame cancelar_pedido.
- Se pedirem a planilha/lista/relatório das encomendas em aberto (o que está aguardando encomenda, o que falta encomendar, o que está atrasado), chame enviar_planilha_encomendas (com filtro, se pedirem) e responda com um resumo de 1 a 3 linhas do resultado. A planilha vai como arquivo separado. Isso não cria nem altera pedido.
Estilo: português do Brasil, mensagens curtas de WhatsApp, sem markdown de títulos; negrito com *asteriscos*. Nunca invente produtos ou SKUs.`;
}

type Ator = { numero: string; nome: string; exigePrefixo: boolean; responderPara: string };

async function processar(body: any) {
  const c = await cfg();
  if (!c.evolution_url || !c.evolution_instance) return;
  if (String(body.instance || "") !== c.evolution_instance) return;
  const d = body.data || {};
  const key = d.key || {};
  const jid = String(key.remoteJid || "");
  if (!jid || jid.endsWith("@g.us") || jid.endsWith("@broadcast") || jid.endsWith("@newsletter")) return;
  const msgId = String(key.id || "");
  if (!msgId) return;

  const apikey = String(body.apikey || "");
  if (!(await chaveValida(c, apikey))) { console.log("apikey do webhook não confere; ignorado"); return; }

  const dono = digits(body.sender);
  const chat = digits(jid);
  const alt = digits(key.remoteJidAlt || key.senderPn || d.remoteJidAlt);
  let ator: Ator | null = null;

  if (key.fromMe) {
    const { data: jaBot } = await sb.from("wa_msgs").select("id").eq("id", msgId).maybeSingle();
    if (jaBot) return;
    if (dono && (chat === dono || alt === dono)) ator = { numero: dono, nome: d.pushName || "Eu", exigePrefixo: true, responderPara: dono };
    else { if (jid.endsWith("@lid")) console.log("fromMe @lid sem par", JSON.stringify({ jid, alt: key.remoteJidAlt, sender: body.sender })); return; }
  } else {
    const numero = jid.endsWith("@lid") ? alt : chat;
    if (!numero) return;
    const { data: a } = await sb.from("wa_autorizados").select("nome,ativo,exige_prefixo").eq("numero", numero).maybeSingle();
    if (!a || !a.ativo) return; // conversa de outra pessoa: descarta sem gravar
    ator = { numero, nome: a.nome, exigePrefixo: !!a.exige_prefixo, responderPara: numero };
  }

  // conteúdo
  const m = d.message || {};
  let texto = String(m.conversation || m.extendedTextMessage?.text || "").trim();
  const audio = m.audioMessage || null;
  if (texto.startsWith(BOT.trim())) return;

  // não processa a mesma mensagem duas vezes
  const { error: dup } = await sb.from("wa_msgs").insert({ id: msgId, origem: "in" });
  if (dup) return;

  const { data: conv } = await sb.from("wa_conversas").select("*").eq("numero", ator.numero).maybeSingle();
  const aberta = !!(conv && Array.isArray(conv.historico) && conv.historico.length && Date.now() - new Date(conv.updated_at).getTime() < JANELA_MIN * 60_000);

  let audioPath: string | null = null;
  let b64 = String(m.base64 || d.base64 || "");
  if (audio) {
    if (!b64) { try { b64 = (await baixarAudio(audio)) || ""; } catch (e) { console.log("descriptografar áudio", String((e as Error).message || e)); } }
    if (!b64) { console.log("áudio sem conteúdo", JSON.stringify({ m: Object.keys(m), a: Object.keys(audio) })); return; }
    const tr = await transcrever(c, b64, String(audio.mimetype || "audio/ogg").split(";")[0]);
    if (tr === null) {
      await enviar(c, apikey, ator.responderPara, c.openai_api_key ? "Não consegui transcrever esse áudio. Tenta de novo ou manda em texto." : "Recebi o áudio, mas a transcrição ainda não está ativada (falta a chave da OpenAI no Picking). Por enquanto, manda em texto.");
      return;
    }
    texto = tr;
  }
  if (!texto) return;

  if (ator.exigePrefixo && !aberta) {
    if (!PREFIXO.test(texto)) return; // conversa normal consigo mesmo: ignora
  }
  texto = texto.replace(PREFIXO, "").trim() || texto;

  if (audio && b64) {
    audioPath = `${ator.numero}/${new Date().toISOString().slice(0, 10)}/${msgId}.ogg`;
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const { error } = await sb.storage.from("wa-audios").upload(audioPath, bytes, { contentType: "audio/ogg", upsert: true });
    if (error) { console.log("falha ao guardar áudio", error.message); audioPath = null; }
  }

  if (!c.anthropic_api_key) { await enviar(c, apikey, ator.responderPara, "O assistente ainda não está configurado (falta a chave da IA no Picking)."); return; }

  // estado da conversa
  let pedidoId: number | null = aberta ? (conv!.pedido_id ?? null) : null;
  let hist: any[] = aberta && Array.isArray(conv!.historico) ? conv!.historico : [];
  const entrada = audio ? `[áudio transcrito] ${texto}` : texto;
  hist.push({ role: "user", content: entrada });

  let encerrou = false;
  const exec = async (nome: string, inp: any): Promise<string> => {
    if (nome === "buscar_produtos") return JSON.stringify(await buscarProdutos(inp?.termo));
    if (nome === "enviar_planilha_encomendas") { try { return await enviarPlanilha(c, apikey, ator!.responderPara, inp); } catch (e) { console.log("planilha", String((e as Error).message || e)); return "erro ao gerar a planilha"; } }
    if (nome === "salvar_rascunho") {
      const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (typeof inp?.fornecedor === "string") row.fornecedor = inp.fornecedor.slice(0, 80);
      if (typeof inp?.observacao === "string") row.observacao = inp.observacao.slice(0, 500);
      if (typeof inp?.previsao_entrega === "string" && /^\d{4}-\d{2}-\d{2}$/.test(inp.previsao_entrega)) row.previsao_entrega = inp.previsao_entrega;
      if (Array.isArray(inp?.itens)) row.itens = inp.itens.slice(0, 50).map((i: any) => ({ code: i.code ? String(i.code) : null, descricao: String(i.descricao || "").slice(0, 160), quantidade: Number(i.quantidade) || 0 }));
      if (!pedidoId) {
        const { data, error } = await sb.from("wa_pedidos").insert({ ...row, numero: ator!.numero, nome: ator!.nome, status: "rascunho" }).select("id").single();
        if (error) return "erro: " + error.message;
        pedidoId = data.id;
      } else {
        const { error } = await sb.from("wa_pedidos").update(row).eq("id", pedidoId);
        if (error) return "erro: " + error.message;
      }
      return `rascunho salvo (pedido #${pedidoId})`;
    }
    if (nome === "confirmar_pedido") {
      if (!pedidoId) return "não há rascunho para confirmar";
      const { data: p } = await sb.from("wa_pedidos").select("fornecedor,itens").eq("id", pedidoId).single();
      if (!p?.fornecedor || !Array.isArray(p.itens) || !p.itens.length) return "faltam dados: fornecedor e ao menos um item";
      await sb.from("wa_pedidos").update({ status: "confirmado", confirmado_em: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", pedidoId);
      encerrou = true;
      // avisa o setor de Compras no celular (mesmo push das encomendas)
      try {
        const { data: s } = await sb.from("app_secrets").select("value").eq("name", "push_webhook").maybeSingle();
        if (s?.value) await fetch(`${URL_}/functions/v1/push`, { method: "POST", headers: { "Content-Type": "application/json", "x-push-secret": s.value },
          body: JSON.stringify({ wa: { id: pedidoId, nome: ator!.nome, fornecedor: p.fornecedor, pecas: p.itens.reduce((t: number, i: any) => t + (+i.quantidade || 0), 0) } }) });
      } catch (e) { console.log("push", String(e)); }
      return `pedido #${pedidoId} confirmado`;
    }
    if (nome === "cancelar_pedido") {
      if (pedidoId) await sb.from("wa_pedidos").update({ status: "cancelado", updated_at: new Date().toISOString() }).eq("id", pedidoId);
      encerrou = true;
      return "cancelado";
    }
    return "ferramenta desconhecida";
  };

  // mantém o histórico curto, cortando sempre numa mensagem de texto do usuário
  if (hist.length > 40) { const i = hist.findIndex((h, k) => k >= hist.length - 40 && h.role === "user" && typeof h.content === "string"); if (i > 0) hist = hist.slice(i); }

  const model = c.lucas_model || "claude-sonnet-5-5";
  let resposta = "";
  for (let volta = 0; volta < 8; volta++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": c.anthropic_api_key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 1000, system: sistema(ator.nome), tools: TOOLS, messages: hist }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { console.log("claude erro", r.status, JSON.stringify(j).slice(0, 300)); resposta = "Não consegui processar agora. Tenta de novo em instantes."; break; }
    hist.push({ role: "assistant", content: j.content });
    const usos = (j.content || []).filter((b: any) => b.type === "tool_use");
    if (j.stop_reason === "tool_use" && usos.length) {
      const res = [];
      for (const u of usos) res.push({ type: "tool_result", tool_use_id: u.id, content: await exec(u.name, u.input) });
      hist.push({ role: "user", content: res });
      continue;
    }
    resposta = (j.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
    break;
  }

  // registra a mensagem recebida no pedido (prova para Compras)
  if (pedidoId) {
    const { data: p } = await sb.from("wa_pedidos").select("mensagens").eq("id", pedidoId).single();
    const msgs = Array.isArray(p?.mensagens) ? p!.mensagens : [];
    msgs.push({ at: new Date().toISOString(), de: ator.nome, tipo: audio ? "audio" : "texto", texto: texto.slice(0, 2000), audio: audioPath });
    if (resposta) msgs.push({ at: new Date().toISOString(), de: "assistente", tipo: "texto", texto: resposta.slice(0, 2000) });
    await sb.from("wa_pedidos").update({ mensagens: msgs.slice(-60) }).eq("id", pedidoId);
  }

  if (encerrou || !pedidoId) {
    // pedido fechado (ou nada aberto): próxima mensagem começa do zero
    if (encerrou) await sb.from("wa_conversas").delete().eq("numero", ator.numero);
    else await sb.from("wa_conversas").upsert({ numero: ator.numero, pedido_id: null, historico: hist, updated_at: new Date().toISOString() });
  } else {
    await sb.from("wa_conversas").upsert({ numero: ator.numero, pedido_id: pedidoId, historico: hist, updated_at: new Date().toISOString() });
  }

  if (resposta) await enviar(c, apikey, ator.responderPara, resposta);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return ok();
  const body = await req.json().catch(() => null);
  if (!body) return ok();
  const ev = String(body.event || "").toLowerCase().replace(/_/g, ".");
  if (ev !== "messages.upsert") return ok();
  // responde já para a Evolution e processa em segundo plano
  // @ts-ignore EdgeRuntime existe no Supabase
  EdgeRuntime.waitUntil(processar(body).catch((e) => console.log("erro", String(e?.message || e))));
  return ok();
});
