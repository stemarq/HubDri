// Conversas do WhatsApp/Telegram dentro do hub: ponte para a API do agente ADRI (pasta agente/).
// A Adriana vê o nome da pessoa e TODO o histórico, assume a conversa (a ADRI para de responder), escreve, devolve,
// corrige o nome, anota observações e exporta a conversa.
import * as store from "./store.js";
import { env } from "./config.js";
import { DEMO_ID, ehDemo, demoLista, demoDetalhe } from "./conversas-demo.js";

const url = () => (process.env.AGENTE_URL || "http://localhost:3001").replace(/\/$/, "");
const token = () => process.env.AGENTE_TOKEN || "";

class ErroAgente extends Error {
  constructor(msg, status = 502) {
    super(msg);
    this.status = status;
  }
}

async function chamar(caminho, { metodo = "GET", corpo, autor } = {}) {
  if (!token()) throw new ErroAgente("AGENTE_TOKEN não configurado no .env do hub", 503);
  try {
    return await fetch(url() + caminho, {
      method: metodo,
      headers: { "content-type": "application/json", authorization: `Bearer ${token()}`, ...(autor ? { "x-actor": autor } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new ErroAgente("O agente ADRI está fora do ar (confira AGENTE_URL e se ele está rodando)");
  }
}

async function agente(caminho, opcoes) {
  const r = await chamar(caminho, opcoes);
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) throw new ErroAgente(dados.message || dados.error || `Agente respondeu HTTP ${r.status}`, r.status === 404 ? 404 : 502);
  return dados;
}

const orcamentoDa = (conversationId) => {
  const o = store.orcamentos().findLast((x) => x.origem?.conversationId === conversationId);
  return o ? { id: o.id, codigo: o.codigo, status: o.status } : null;
};
const quem = (m) => (m.direction === "IN" ? "cliente" : m.author === "ADRIANA" ? "adriana" : "ia");
const pessoa = (c) => ({
  id: c.customer.id,
  nome: c.customer.name,
  usuario: c.customer.handle,
  telefone: c.customer.phone,
  identificador: c.customer.waId,
  observacoes: c.customer.notes,
  desde: c.customer.since,
  apagado: c.customer.erased,
});

export function rotasConversas(app, rota) {
  // MODO_DEMO=1: sem agente conectado, mostra uma conversa de exemplo (só leitura) para apresentação.
  if (env.demo) {
    app.use("/api/conversas", (req, res, next) => {
      const id = req.path.split("/")[1];
      if (id && ehDemo(id)) {
        if (req.method === "GET" && req.path === `/${DEMO_ID}`) return res.json(demoDetalhe());
        return res.status(409).json({ erro: "Esta é uma conversa de exemplo, só para ler. As conversas reais aparecem quando o agente ADRI está conectado." });
      }
      if (req.method === "GET" && (req.path === "/" || req.path === "")) {
        return agente("/api/conversations").then(() => next(), () => res.json(demoLista()));
      }
      next();
    });
  }

  app.get("/api/conversas", rota(async (req, res) => {
    const q = req.query.q ? `?q=${encodeURIComponent(String(req.query.q))}` : "";
    const { conversations } = await agente("/api/conversations" + q);
    const itens = conversations.map((c) => ({
      id: c.id,
      pessoa: pessoa(c),
      canal: c.channel,
      modo: c.mode,
      mensagens: c.messageCount,
      ultima: c.lastMessage ? { texto: c.lastMessage.body, de: quem(c.lastMessage), tipo: c.lastMessage.type, em: c.lastMessage.at } : null,
      atualizadoEm: c.updatedAt,
      orcamento: orcamentoDa(c.id),
    }));
    res.json({ itens, atencao: itens.filter((i) => i.modo === "HUMAN").length });
  }));

  app.get("/api/conversas/:id", rota(async (req, res) => {
    const c = await agente(`/api/conversations/${encodeURIComponent(req.params.id)}`);
    res.json({
      id: c.id,
      pessoa: pessoa(c),
      canal: c.channel,
      modo: c.mode,
      mensagens: c.messageCount,
      aguardando: c.awaiting,
      coletado: c.collected,
      orcamento: orcamentoDa(c.id),
      historico: c.messages.map((m) => ({ id: m.id, tipo: m.type, texto: m.body, em: m.at, status: m.status, erro: m.error, de: quem(m) })),
    });
  }));

  // Baixar a conversa inteira (txt ou json).
  app.get("/api/conversas/:id/exportar", rota(async (req, res) => {
    const formato = req.query.formato === "json" ? "json" : "txt";
    const r = await chamar(`/api/conversations/${encodeURIComponent(req.params.id)}/export?format=${formato}`);
    if (!r.ok) throw new ErroAgente("Conversa não encontrada", r.status === 404 ? 404 : 502);
    res.set("Content-Type", r.headers.get("content-type") || "text/plain").set("Content-Disposition", r.headers.get("content-disposition") || "attachment");
    res.send(Buffer.from(await r.arrayBuffer()));
  }));

  // Corrigir o nome e anotar observações sobre a pessoa.
  app.patch("/api/conversas/:id/pessoa", rota(async (req, res) => {
    const c = await agente(`/api/conversations/${encodeURIComponent(req.params.id)}`);
    const corpo = {};
    if (req.body.nome !== undefined) corpo.name = String(req.body.nome).trim().slice(0, 80) || null;
    if (req.body.observacoes !== undefined) corpo.notes = String(req.body.observacoes).trim().slice(0, 2000) || null;
    await agente(`/api/customers/${encodeURIComponent(c.customer.id)}`, { metodo: "PATCH", corpo });
    res.json({ ok: true });
  }));

  const acao = (caminho) => rota(async (req, res) => {
    res.json(await agente(`/api/conversations/${encodeURIComponent(req.params.id)}/${caminho}`, { metodo: "POST", autor: req.usuario?.nome }));
  });
  app.post("/api/conversas/:id/assumir", acao("handoff"));
  app.post("/api/conversas/:id/devolver", acao("resume"));

  // Enviar como Adriana: assume a conversa antes (a ADRI não pode responder junto).
  app.post("/api/conversas/:id/mensagem", rota(async (req, res) => {
    const texto = String(req.body.texto || "").trim();
    if (!texto) throw new ErroAgente("Escreva a mensagem", 400);
    const id = encodeURIComponent(req.params.id);
    const atual = await agente(`/api/conversations/${id}`);
    if (atual.mode !== "HUMAN") await agente(`/api/conversations/${id}/handoff`, { metodo: "POST", autor: req.usuario?.nome });
    res.status(201).json(await agente(`/api/conversations/${id}/messages`, { metodo: "POST", corpo: { text: texto }, autor: req.usuario?.nome }));
  }));
}
