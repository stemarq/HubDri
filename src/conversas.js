// Conversas do WhatsApp/Telegram dentro do hub: ponte para a API do agente ADRI (pasta agente/).
// A Adriana vê o chat inteiro, assume a conversa (a ADRI para de responder), escreve para a cliente e devolve à ADRI.
import * as store from "./store.js";

const url = () => (process.env.AGENTE_URL || "http://localhost:3001").replace(/\/$/, "");
const token = () => process.env.AGENTE_TOKEN || "";

class ErroAgente extends Error {
  constructor(msg, status = 502) {
    super(msg);
    this.status = status;
  }
}

async function agente(caminho, { metodo = "GET", corpo, autor } = {}) {
  if (!token()) throw new ErroAgente("AGENTE_TOKEN não configurado no .env do hub", 503);
  let r;
  try {
    r = await fetch(url() + caminho, {
      method: metodo,
      headers: { "content-type": "application/json", authorization: `Bearer ${token()}`, ...(autor ? { "x-actor": autor } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new ErroAgente("O agente ADRI está fora do ar (confira AGENTE_URL e se ele está rodando)");
  }
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) throw new ErroAgente(dados.message || dados.error || `Agente respondeu HTTP ${r.status}`, r.status === 404 ? 404 : 502);
  return dados;
}

const orcamentoDa = (conversationId) => {
  const o = store.orcamentos().findLast((x) => x.origem?.conversationId === conversationId);
  return o ? { id: o.id, codigo: o.codigo, status: o.status } : null;
};
const quem = (de) => (de === "IN" ? "cliente" : "ia");

export function rotasConversas(app, rota) {
  app.get("/api/conversas", rota(async (req, res) => {
    const { conversations } = await agente("/api/conversations");
    const itens = conversations.map((c) => ({
      id: c.id,
      cliente: c.customer.name || c.customer.waId,
      canal: c.channel,
      modo: c.mode,
      ultima: c.lastMessage ? { texto: c.lastMessage.body, de: quem(c.lastMessage.direction), em: c.lastMessage.at } : null,
      atualizadoEm: c.updatedAt,
      orcamento: orcamentoDa(c.id),
    }));
    res.json({ itens, atencao: itens.filter((i) => i.modo === "HUMAN").length });
  }));

  app.get("/api/conversas/:id", rota(async (req, res) => {
    const c = await agente(`/api/conversations/${encodeURIComponent(req.params.id)}`);
    res.json({
      id: c.id,
      cliente: c.customer.name || c.customer.waId,
      canal: c.channel,
      modo: c.mode,
      aguardando: c.awaiting,
      coletado: c.collected,
      orcamento: orcamentoDa(c.id),
      mensagens: c.messages.map((m) => ({
        id: m.id, tipo: m.type, texto: m.body, em: m.at, status: m.status, erro: m.error,
        de: m.direction === "IN" ? "cliente" : m.author === "ADRIANA" ? "adriana" : "ia",
      })),
    });
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
