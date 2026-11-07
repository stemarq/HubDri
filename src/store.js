// Armazenamento do hub.
//
// Com SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY: os dados vivem no Supabase (Postgres + Storage).
// Sem elas: arquivo data/db.json, como no começo do MVP.
//
// Nos dois modos o hub trabalha com os objetos em memória (um processo só) e `salvar()`
// persiste o que mudou. No Supabase a gravação é em segundo plano e em ordem; se falhar,
// é tentada de novo no próximo `salvar()`.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { env } from "./config.js";

export const DATA_DIR = path.resolve("data");
// No modo Supabase vira só um cache local das imagens do Storage.
export const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const DB_FILE = path.join(DATA_DIR, "db.json");
const BUCKET = "imagens-orcamento";

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const supa = env.supabaseUrl && env.supabaseKey
  ? createClient(env.supabaseUrl, env.supabaseKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;
export const modo = supa ? "supabase" : "arquivo";

export const agora = () => new Date().toISOString();
export const novoId = () => crypto.randomUUID();

// Modo Supabase: o que já está no banco. A linha de cada orçamento/notificação (para saber
// se mudou) e os itens das listas que já foram inseridos.
const gravado = { orcamentos: new Map(), notificacoes: new Map(), itens: new WeakSet() };

const vazio = () => ({ seq: 0, orcamentos: [], notificacoes: [], saidaWhatsapp: [] });

export function salvar() {
  if (supa) agendarSincronizacao();
  else gravarArquivoJson();
}

export function proximoCodigo() {
  db.seq += 1;
  return "ORC-" + String(db.seq).padStart(4, "0");
}

export const orcamentos = () => db.orcamentos;
export const notificacoes = () => db.notificacoes;
export const saidaWhatsapp = () => db.saidaWhatsapp;

export function acharOrcamento(id) {
  return db.orcamentos.find((o) => o.id === id || o.codigo === id);
}

export function acharPorToken(token) {
  return db.orcamentos.find((o) => o.tokenPublico === token);
}

export function notificar({ tipo, titulo, texto, orcamentoId }) {
  db.notificacoes.unshift({ id: novoId(), tipo, titulo, texto, orcamentoId, lida: false, em: agora() });
  db.notificacoes = db.notificacoes.slice(0, 300);
  salvar();
}

// ---------- Equipe (perfis do login) ----------

// Nomes da equipe, para mostrar quem aprovou/editou. Preenchido na carga e a cada login.
const nomes = new Map();
export const nomePerfil = (id) => (id ? nomes.get(id) ?? null : null);

export async function buscarPerfil(id) {
  if (!supa) return null;
  const perfil = await consulta(
    supa.from("perfis").select("id, nome, email, papel, ativo").eq("id", id).maybeSingle(),
    "buscar perfil"
  );
  if (perfil) nomes.set(perfil.id, perfil.nome || perfil.email);
  return perfil;
}

// ---------- Arquivos (imagens do chat) ----------

export async function salvarArquivo(caminho, buf, mimeType) {
  const local = path.join(UPLOADS_DIR, caminho);
  if (supa) {
    const { error } = await supa.storage.from(BUCKET).upload(caminho, buf, { contentType: mimeType, upsert: true });
    if (error) throw new Error(`Storage: ${error.message}`);
  }
  fs.mkdirSync(path.dirname(local), { recursive: true });
  fs.writeFileSync(local, buf);
}

// Devolve o caminho local do arquivo, baixando do Storage se ainda não estiver em cache.
export async function garantirArquivo(caminho) {
  const local = path.join(UPLOADS_DIR, caminho);
  if (supa && !fs.existsSync(local)) {
    const { data, error } = await supa.storage.from(BUCKET).download(caminho);
    if (error) throw new Error(`Storage: ${error.message}`);
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, Buffer.from(await data.arrayBuffer()));
  }
  return local;
}

// ---------- Modo arquivo ----------

function lerArquivoJson() {
  try {
    return { ...vazio(), ...JSON.parse(fs.readFileSync(DB_FILE, "utf8")) };
  } catch {
    return vazio();
  }
}

function gravarArquivoJson() {
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

// ---------- Modo Supabase: conversão objeto ↔ linhas ----------

const iso = (v) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);

const linhaOrcamento = (o) => ({
  id: o.id,
  codigo: o.codigo,
  token_publico: o.tokenPublico,
  status: o.status,
  canal: o.origem.canal || "whatsapp",
  conversation_id: o.origem.conversationId,
  cliente: o.cliente || {},
  evento: o.evento || {},
  briefing: o.briefing,
  calculo: o.calculo,
  aprovado_em: iso(o.aprovadoEm),
  aprovado_por: o.aprovadoPor ?? null,
  resposta_decisao: o.respostaCliente?.decisao ?? null,
  resposta_comentario: o.respostaCliente?.comentario ?? null,
  resposta_via: o.respostaCliente?.via ?? null,
  resposta_em: iso(o.respostaCliente?.em),
  criado_em: iso(o.criadoEm),
  atualizado_em: iso(o.atualizadoEm),
});

// Listas dentro do orçamento → tabela filha. Elas só crescem (push), então basta inserir as novas.
const FILHOS = {
  imagens: {
    tabela: "orcamento_imagens",
    ordem: "recebida_em",
    paraLinha: (x, id) => ({ id: x.id, orcamento_id: id, arquivo: x.arquivo, mime_type: x.mimeType, recebida_em: iso(x.recebidaEm) ?? agora() }),
    deLinha: (r) => ({ id: r.id, arquivo: r.arquivo, mimeType: r.mime_type, recebidaEm: iso(r.recebida_em) }),
  },
  conversa: {
    tabela: "orcamento_mensagens",
    ordem: "id",
    paraLinha: (x, id) => ({ orcamento_id: id, de: x.de ?? "", texto: x.texto ?? "", em: iso(x.em) ?? agora() }),
    deLinha: (r) => ({ de: r.de, texto: r.texto, em: iso(r.em) }),
  },
  historico: {
    tabela: "orcamento_historico",
    ordem: "id",
    paraLinha: (x, id) => ({ orcamento_id: id, evento: x.evento, detalhe: x.detalhe ?? "", autor_id: x.autorId ?? null, em: iso(x.em) ?? agora() }),
    deLinha: (r) => ({ em: iso(r.em), evento: r.evento, detalhe: r.detalhe, autorId: r.autor_id, autorNome: nomePerfil(r.autor_id) }),
  },
  revisoes: {
    tabela: "orcamento_revisoes",
    ordem: "id",
    paraLinha: (x, id) => ({ orcamento_id: id, comentario: x.comentario, origem: x.origem, autor_id: x.autorId ?? null, em: iso(x.em) ?? agora() }),
    deLinha: (r) => ({ comentario: r.comentario, em: iso(r.em), origem: r.origem, autorId: r.autor_id, autorNome: nomePerfil(r.autor_id) }),
  },
  envios: {
    tabela: "orcamento_envios",
    ordem: "id",
    paraLinha: (x, id) => ({ orcamento_id: id, ok: Boolean(x.ok), simulado: Boolean(x.simulado), erro: x.erro ?? null, em: iso(x.em) ?? agora() }),
    deLinha: (r) => ({ em: iso(r.em), ok: r.ok, ...(r.ok ? { simulado: r.simulado } : { erro: r.erro }) }),
  },
};

function deLinhaOrcamento(r) {
  const o = {
    id: r.id,
    codigo: r.codigo,
    tokenPublico: r.token_publico,
    status: r.status,
    criadoEm: iso(r.criado_em),
    atualizadoEm: iso(r.atualizado_em),
    origem: { canal: r.canal, conversationId: r.conversation_id },
    cliente: r.cliente,
    evento: r.evento,
    briefing: r.briefing,
    calculo: r.calculo,
    aprovadoEm: iso(r.aprovado_em),
    aprovadoPor: r.aprovado_por ?? null,
    aprovadoPorNome: nomePerfil(r.aprovado_por),
    respostaCliente: r.resposta_decisao
      ? { decisao: r.resposta_decisao, comentario: r.resposta_comentario ?? "", em: iso(r.resposta_em), via: r.resposta_via }
      : null,
  };
  for (const [campo, f] of Object.entries(FILHOS)) {
    const linhas = [...(r[f.tabela] || [])].sort((a, b) => (a[f.ordem] < b[f.ordem] ? -1 : a[f.ordem] > b[f.ordem] ? 1 : 0));
    o[campo] = linhas.map(f.deLinha);
  }
  return o;
}

const linhaNotificacao = (n) => ({
  id: n.id, tipo: n.tipo, titulo: n.titulo, texto: n.texto ?? "", orcamento_id: n.orcamentoId ?? null, lida: n.lida, em: iso(n.em) ?? agora(),
});

// ---------- Modo Supabase: leitura inicial ----------

async function consulta(promessa, oque) {
  const { data, error } = await promessa;
  if (error) throw new Error(`Supabase (${oque}): ${error.message}`);
  return data;
}

async function carregarSupabase() {
  for (const p of await consulta(supa.from("perfis").select("id, nome, email"), "carregar equipe")) nomes.set(p.id, p.nome || p.email);
  const filhos = Object.values(FILHOS).map((f) => `${f.tabela}(*)`).join(", ");
  const linhas = [];
  for (let de = 0; ; de += 500) {
    const pagina = await consulta(
      supa.from("orcamentos").select(`*, ${filhos}`).order("criado_em").order("id").range(de, de + 499),
      "carregar orçamentos"
    );
    linhas.push(...pagina);
    if (pagina.length < 500) break;
  }
  const notifs = await consulta(supa.from("notificacoes").select("*").order("em", { ascending: false }).limit(300), "carregar notificações");
  const saida = await consulta(supa.from("saida_whatsapp").select("corpo").order("em", { ascending: false }).limit(100), "carregar saída do WhatsApp");

  const dados = {
    orcamentos: linhas.map(deLinhaOrcamento),
    notificacoes: notifs.map((n) => ({
      id: n.id, tipo: n.tipo, titulo: n.titulo, texto: n.texto, orcamentoId: n.orcamento_id, lida: n.lida, em: iso(n.em),
    })),
    saidaWhatsapp: saida.map((s) => s.corpo),
  };
  dados.seq = Math.max(0, ...dados.orcamentos.map((o) => Number(o.codigo.replace(/\D/g, "")) || 0));

  // O que veio do banco já está gravado.
  for (const o of dados.orcamentos) {
    gravado.orcamentos.set(o.id, JSON.stringify(linhaOrcamento(o)));
    for (const campo of Object.keys(FILHOS)) for (const x of o[campo]) gravado.itens.add(x);
  }
  for (const n of dados.notificacoes) gravado.notificacoes.set(n.id, JSON.stringify(linhaNotificacao(n)));
  for (const s of dados.saidaWhatsapp) gravado.itens.add(s);

  console.log(`Supabase: ${dados.orcamentos.length} orçamento(s) carregado(s).`);
  return dados;
}

// ---------- Modo Supabase: gravação em segundo plano ----------

let fila = Promise.resolve();
let agendado = false;

function agendarSincronizacao() {
  if (agendado) return;
  agendado = true;
  fila = fila.then(() => {
    agendado = false;
    return sincronizar().catch((e) => console.error("Falha ao gravar no Supabase", e));
  });
}

let novaTentativa = null;

async function sincronizar() {
  let falhou = false;
  // Tudo é lido de uma vez aqui, antes de qualquer await: o que mudar durante a gravação
  // fica para a próxima rodada (que o próprio salvar() já agendou).
  const trabalhos = [];
  for (const o of db.orcamentos) {
    const linha = linhaOrcamento(o);
    const json = JSON.stringify(linha);
    const novos = [];
    for (const [campo, f] of Object.entries(FILHOS))
      for (const x of o[campo] || []) if (!gravado.itens.has(x)) novos.push({ x, tabela: f.tabela, linha: f.paraLinha(x, o.id) });
    if (json !== gravado.orcamentos.get(o.id) || novos.length) trabalhos.push({ o, linha, json, novos });
  }
  const notifs = db.notificacoes
    .map((n) => ({ n, linha: linhaNotificacao(n) }))
    .map((t) => ({ ...t, json: JSON.stringify(t.linha) }))
    .filter((t) => t.json !== gravado.notificacoes.get(t.n.id));
  const saida = db.saidaWhatsapp.filter((s) => !gravado.itens.has(s));

  for (const t of trabalhos) {
    try {
      if (t.json !== gravado.orcamentos.get(t.o.id)) {
        await consulta(supa.from("orcamentos").upsert(t.linha, { onConflict: "id" }), `gravar ${t.o.codigo}`);
        gravado.orcamentos.set(t.o.id, t.json);
      }
      const porTabela = Map.groupBy(t.novos, (n) => n.tabela);
      for (const [tabela, itens] of porTabela) {
        await consulta(supa.from(tabela).insert(itens.map((i) => i.linha)), `gravar ${tabela} de ${t.o.codigo}`);
        for (const i of itens) gravado.itens.add(i.x);
      }
    } catch (e) {
      falhou = true;
      console.error(e.message);
    }
  }

  // Notificações só depois que o orçamento delas existe no banco (chave estrangeira).
  const prontas = notifs.filter((t) => !t.n.orcamentoId || gravado.orcamentos.has(t.n.orcamentoId));
  if (prontas.length) {
    try {
      await consulta(supa.from("notificacoes").upsert(prontas.map((t) => t.linha), { onConflict: "id" }), "gravar notificações");
      for (const t of prontas) gravado.notificacoes.set(t.n.id, t.json);
    } catch (e) {
      falhou = true;
      console.error(e.message);
    }
  }

  if (saida.length) {
    try {
      await consulta(
        supa.from("saida_whatsapp").insert(saida.map((s) => ({
          tipo: typeof s.evento === "string" ? s.evento : null, corpo: s, via_http: Boolean(s.viaHttp), em: iso(s.enviadoEm) ?? agora(),
        }))),
        "gravar saída do WhatsApp"
      );
      for (const s of saida) gravado.itens.add(s);
    } catch (e) {
      falhou = true;
      console.error(e.message);
    }
  }

  // Se algo falhou (rede, Supabase fora do ar), tenta de novo em 30 s mesmo sem novas mudanças.
  if (falhou && !novaTentativa)
    novaTentativa = setTimeout(() => { novaTentativa = null; agendarSincronizacao(); }, 30_000).unref();
}

// Espera as gravações pendentes (usado ao desligar o servidor).
export async function aguardarGravacoes() {
  if (supa) await fila;
}

// ---------- Carga inicial (no fim: usa as funções e constantes acima) ----------

let db = supa ? await carregarSupabase() : lerArquivoJson();
