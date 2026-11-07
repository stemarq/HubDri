// Regras do fluxo: lead → cálculo → aprovações internas → retorno ao WhatsApp → resposta da cliente.
import crypto from "node:crypto";
import * as store from "./store.js";
import { agora, novoId, salvar, notificar } from "./store.js";
import { config, env } from "./config.js";
import { montarCalculo, propostaPorRegras, recalcularTotais } from "./calculo.js";
import { iaDisponivel, iaNome, proporOrcamento } from "./ia.js";
import { enviarParaWhatsapp } from "./whatsapp.js";

export const STATUS = {
  calculando: "Calculando",
  aguardando_aprovacao: "Aguardando aprovação",
  enviando: "Enviando ao WhatsApp",
  enviado: "Enviado à cliente",
  falha_envio: "Falha no envio",
  mudanca_cliente: "Cliente pediu mudanças",
  aceito_cliente: "Aceito pela cliente",
};

// Status em que o hub precisa agir (entram na fila de pendentes).
export const PENDENTES = ["calculando", "aguardando_aprovacao", "falha_envio", "mudanca_cliente"];
// Status em que a conversa do WhatsApp ainda está "aberta" para receber novos dados.
const ABERTOS = ["calculando", "aguardando_aprovacao", "falha_envio", "mudanca_cliente"];

export class ErroFluxo extends Error {
  constructor(msg, status = 400) {
    super(msg);
    this.status = status;
  }
}

// autor: { id, nome } de quem está logada; vazio para ações automáticas (webhook, IA, servidor).
function historico(orc, evento, detalhe = "", autor = null) {
  orc.historico.push({ em: agora(), evento, detalhe, ...(autor && { autorId: autor.id, autorNome: autor.nome }) });
  orc.atualizadoEm = agora();
}

// Aprovação única: a empresária aprova e o PDF segue para o WhatsApp.
function limparAprovacao(orc) {
  orc.aprovadoEm = null;
  orc.aprovadoPor = null;
  orc.aprovadoPorNome = null;
}

// ---------- Entrada (webhook da IA do WhatsApp) ----------

const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

async function salvarImagem(orc, img) {
  let buf, mimeType = img.mimeType;
  if (img.base64) {
    buf = Buffer.from(img.base64.replace(/^data:[^,]+,/, ""), "base64");
  } else if (img.url) {
    const r = await fetch(img.url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    buf = Buffer.from(await r.arrayBuffer());
    mimeType ||= r.headers.get("content-type")?.split(";")[0];
  } else return null;

  mimeType ||= "image/jpeg";
  const arquivo = `${orc.id}/${crypto.randomBytes(6).toString("hex")}.${EXT[mimeType] || "bin"}`;
  await store.salvarArquivo(arquivo, buf, mimeType);
  return {
    id: novoId(),
    arquivo,
    mimeType,
    recebidaEm: img.recebidaEm || agora(),
  };
}

export async function receberLead(payload) {
  const conversationId = payload.conversationId || payload.conversa_id;
  if (!conversationId) throw new ErroFluxo("conversationId é obrigatório");
  const c = payload.cliente || {};
  if (!c.nome && !c.telefone) throw new ErroFluxo("cliente.nome ou cliente.telefone é obrigatório");

  let orc = store.orcamentos().find((o) => o.origem.conversationId === conversationId && ABERTOS.includes(o.status));
  const novo = !orc;

  if (novo) {
    orc = {
      id: novoId(),
      codigo: store.proximoCodigo(),
      tokenPublico: crypto.randomBytes(16).toString("hex"),
      status: "calculando",
      criadoEm: agora(),
      atualizadoEm: agora(),
      origem: { canal: "whatsapp", conversationId },
      cliente: {},
      evento: {},
      briefing: { resumo: "", respostas: [] },
      conversa: [],
      imagens: [],
      calculo: null,
      aprovadoEm: null,
      revisoes: [],
      historico: [],
      envios: [],
      respostaCliente: null,
    };
    store.orcamentos().push(orc);
  }

  orc.cliente = { ...orc.cliente, ...c };
  orc.evento = { ...(orc.evento || {}), ...(payload.evento || {}) };
  if (payload.briefing?.resumo) orc.briefing.resumo = payload.briefing.resumo;
  orc.briefing.respostas.push(...(payload.briefing?.respostas || []));
  orc.conversa.push(...(payload.conversa || payload.mensagens || []).map((m) => ({ de: m.de, texto: m.texto, em: m.em || agora() })));

  const falhas = [];
  for (const img of payload.imagens || []) {
    try {
      const salva = await salvarImagem(orc, img);
      if (salva) orc.imagens.push(salva);
    } catch (e) {
      falhas.push(`${img.url || "imagem"}: ${e.message}`);
    }
  }

  historico(orc, novo ? "Lead recebido do WhatsApp" : "Novas informações recebidas do WhatsApp",
    `${(payload.imagens || []).length - falhas.length} imagem(ns)` + (falhas.length ? ` · ${falhas.length} falharam` : ""));
  salvar();

  notificar({
    tipo: novo ? "novo" : "atualizacao",
    titulo: novo ? `Novo orçamento ${orc.codigo}` : `${orc.codigo} recebeu novas informações`,
    texto: orc.cliente.nome || orc.cliente.telefone,
    orcamentoId: orc.id,
  });

  // Cálculo em segundo plano: o webhook responde na hora.
  calcularEmSegundoPlano(orc.id, novo ? null : "Novas informações chegaram pelo WhatsApp; atualize o orçamento.");
  return { orc, novo, falhas };
}

// ---------- Cálculo ----------

function calcularEmSegundoPlano(id, pedido) {
  calcular(id, pedido).catch((e) => console.error("Falha no cálculo", id, e));
}

export async function calcular(id, pedidoDeMudanca = null) {
  const orc = store.acharOrcamento(id);
  const cfg = config();
  orc.status = "calculando";
  salvar();

  let proposta, geradoPor = "regras", erroIa = null;
  const nomeIa = iaNome();
  if (iaDisponivel()) {
    try {
      proposta = await proporOrcamento(orc, cfg, pedidoDeMudanca);
      geradoPor = "ia";
    } catch (e) {
      erroIa = e.message;
    }
  }
  proposta ??= propostaPorRegras(orc);
  if (erroIa) proposta.pontosDeAtencao.unshift(`IA falhou (${erroIa}); cálculo feito por regras.`);
  if (geradoPor === "regras" && pedidoDeMudanca)
    proposta.pontosDeAtencao.push(`Mudança pedida: "${pedidoDeMudanca}". O cálculo por regras não interpreta texto livre: ajuste os itens manualmente.`);

  orc.calculo = montarCalculo(proposta, cfg, geradoPor);
  if (geradoPor === "ia") orc.calculo.ia = nomeIa;
  if (!orc.briefing.resumo && proposta.resumo) orc.briefing.resumo = proposta.resumo;
  limparAprovacao(orc);
  orc.status = "aguardando_aprovacao";
  historico(orc, "Orçamento calculado", `${geradoPor === "ia" ? `IA (${nomeIa})` : "Regras"} · total R$ ${orc.calculo.total.toFixed(2)}`);
  salvar();
  return orc;
}

// ---------- Ações do hub ----------

function exigir(orc, ...status) {
  if (!orc) throw new ErroFluxo("Orçamento não encontrado", 404);
  if (!status.includes(orc.status)) throw new ErroFluxo(`Ação indisponível no status "${STATUS[orc.status]}"`, 409);
}

export async function aprovar(id, autor = null) {
  const orc = store.acharOrcamento(id);
  exigir(orc, "aguardando_aprovacao");
  orc.aprovadoEm = agora();
  orc.aprovadoPor = autor?.id ?? null;
  orc.aprovadoPorNome = autor?.nome ?? null;
  historico(orc, "Orçamento aprovado", "", autor);
  salvar();
  return enviar(orc.id);
}

// Calcula de novo com os mesmos dados (ex.: a IA estava fora do ar na primeira vez).
export function recalcular(id, autor = null) {
  const orc = store.acharOrcamento(id);
  exigir(orc, "aguardando_aprovacao", "mudanca_cliente", "falha_envio");
  orc.status = "calculando";
  historico(orc, "Novo cálculo pedido", "", autor);
  salvar();
  calcularEmSegundoPlano(orc.id, null);
  return orc;
}

export function solicitarMudanca(id, comentario, autor = null) {
  const orc = store.acharOrcamento(id);
  exigir(orc, "aguardando_aprovacao", "mudanca_cliente", "falha_envio");
  if (!comentario?.trim()) throw new ErroFluxo("Descreva a mudança desejada");
  orc.revisoes.push({ comentario, em: agora(), origem: "hub", ...(autor && { autorId: autor.id, autorNome: autor.nome }) });
  historico(orc, "Mudança solicitada", comentario, autor);
  salvar();
  calcularEmSegundoPlano(orc.id, comentario);
  return orc;
}

export function editarCalculo(id, { itens, descontoPercentual }, autor = null) {
  const orc = store.acharOrcamento(id);
  exigir(orc, "aguardando_aprovacao", "mudanca_cliente", "falha_envio");
  const cfg = config();
  const porCodigo = new Map(cfg.catalogo.map((c) => [c.codigo, c]));
  const calc = orc.calculo;
  calc.itens = (itens || [])
    .filter((i) => porCodigo.has(i.codigo) && Number(i.quantidade) > 0)
    .map((i) => {
      const cat = porCodigo.get(i.codigo);
      return {
        codigo: cat.codigo,
        descricao: cat.descricao,
        unidade: cat.unidade,
        quantidade: Number(i.quantidade),
        valorUnitario: Number(i.valorUnitario ?? cat.valor),
        observacao: i.observacao || "",
      };
    });
  if (descontoPercentual != null)
    calc.descontoPercentual = Math.min(Math.max(Number(descontoPercentual) || 0, 0), cfg.descontoMaximoPercentual);
  calc.editadoManualmente = true;
  recalcularTotais(calc);
  limparAprovacao(orc);
  orc.status = "aguardando_aprovacao";
  historico(orc, "Orçamento editado manualmente", `total R$ ${calc.total.toFixed(2)}`, autor);
  salvar();
  return orc;
}

export const linkPublico = (orc) => `${env.publicUrl}/p/${orc.tokenPublico}`;
export const linkPdf = (orc) => `${env.publicUrl}/p/${orc.tokenPublico}/orcamento.pdf`;

export async function enviar(id) {
  const orc = store.acharOrcamento(id);
  exigir(orc, "aguardando_aprovacao", "falha_envio");
  if (!orc.aprovadoEm) throw new ErroFluxo("Orçamento ainda não aprovado", 409);
  orc.status = "enviando";
  salvar();

  const primeiroNome = (orc.cliente.nome || "").split(" ")[0];
  try {
    const r = await enviarParaWhatsapp("orcamento_aprovado", {
      orcamentoId: orc.id,
      codigo: orc.codigo,
      conversationId: orc.origem.conversationId,
      telefone: orc.cliente.telefone,
      cliente: orc.cliente.nome,
      total: orc.calculo.total,
      dadosEvento: orc.evento,
      validadeDias: orc.calculo.validadeDias,
      pdfUrl: linkPdf(orc),
      linkAprovacao: linkPublico(orc),
      mensagemSugerida:
        `Oi${primeiroNome ? " " + primeiroNome : ""}! Seu orçamento ${orc.codigo} está pronto. ` +
        `Segue o PDF com todos os detalhes. Se estiver tudo certo, é só aprovar pelo botão do PDF. ` +
        `Se quiser ajustar alguma coisa, me conta por aqui mesmo.`,
    });
    orc.status = "enviado";
    orc.envios.push({ em: agora(), ok: true, simulado: r.simulado });
    historico(orc, "PDF devolvido à IA do WhatsApp", r.simulado ? "modo simulado" : "");
  } catch (e) {
    orc.status = "falha_envio";
    orc.envios.push({ em: agora(), ok: false, erro: e.message });
    historico(orc, "Falha ao devolver para o WhatsApp", e.message);
    notificar({ tipo: "erro", titulo: `Falha no envio de ${orc.codigo}`, texto: e.message, orcamentoId: orc.id });
  }
  salvar();
  return orc;
}

// ---------- Resposta da cliente (link do PDF ou repassada pela IA do WhatsApp) ----------

export async function registrarRespostaCliente(orc, decisao, comentario, via) {
  if (!orc) throw new ErroFluxo("Orçamento não encontrado", 404);
  if (!["enviado", "mudanca_cliente"].includes(orc.status))
    throw new ErroFluxo("Este orçamento não está aguardando resposta", 409);
  if (!["aprovado", "mudanca"].includes(decisao)) throw new ErroFluxo('decisao deve ser "aprovado" ou "mudanca"');
  // Pedidos de mudança só chegam pela conversa do WhatsApp (via webhook), nunca pelo link.
  if (decisao === "mudanca" && via === "link") throw new ErroFluxo("Para pedir ajustes, responda na conversa do WhatsApp");
  // Em revisão, a versão antiga do PDF não pode mais ser aprovada pelo link.
  if (via === "link" && orc.status !== "enviado") throw new ErroFluxo("Este orçamento está em revisão; a nova versão chega pelo WhatsApp", 409);
  if (decisao === "mudanca" && !comentario?.trim()) throw new ErroFluxo("Conte o que você gostaria de mudar");

  orc.respostaCliente = { decisao, comentario: comentario || "", em: agora(), via };
  orc.status = decisao === "aprovado" ? "aceito_cliente" : "mudanca_cliente";
  if (decisao === "mudanca") orc.revisoes.push({ comentario, em: agora(), origem: "cliente" });
  historico(orc, decisao === "aprovado" ? "Cliente aprovou o orçamento" : "Cliente pediu mudanças", comentario || via);
  salvar();

  notificar({
    tipo: decisao === "aprovado" ? "aceito" : "mudanca",
    titulo: decisao === "aprovado" ? `${orc.codigo} aprovado pela cliente` : `${orc.codigo}: cliente pediu mudanças`,
    texto: comentario || orc.cliente.nome,
    orcamentoId: orc.id,
  });

  // Se a resposta veio pelo link do PDF, avisa a IA do WhatsApp para continuar a conversa.
  if (via === "link") {
    try {
      await enviarParaWhatsapp("resposta_cliente", {
        orcamentoId: orc.id,
        codigo: orc.codigo,
        conversationId: orc.origem.conversationId,
        telefone: orc.cliente.telefone,
        decisao,
        comentario: comentario || "",
      });
    } catch (e) {
      historico(orc, "Falha ao avisar o WhatsApp da resposta", e.message);
      salvar();
    }
  }
  return orc;
}
