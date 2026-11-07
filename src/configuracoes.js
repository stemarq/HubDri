// Configurações editáveis no app: regras e catálogo do orçamento (hub) + agenda, deslocamento e respostas da ADRI (agente).
import fs from "node:fs";
import path from "node:path";
import { config, arquivoEditado, env } from "./config.js";
import { iaNome } from "./ia.js";
import * as store from "./store.js";
import { loginAtivo } from "./auth.js";
import { configNoBanco, salvarConfigNoBanco } from "./config-banco.js";

const url = () => (process.env.AGENTE_URL || "http://localhost:3001").replace(/\/$/, "");
const token = () => process.env.AGENTE_TOKEN || "";

class ErroConfig extends Error {
  constructor(msg, status = 400) {
    super(msg);
    this.status = status;
  }
}

async function agente(caminho, { metodo = "GET", corpo } = {}) {
  if (!token()) throw new ErroConfig("AGENTE_TOKEN não configurado no .env do hub", 503);
  let r;
  try {
    r = await fetch(url() + caminho, {
      method: metodo,
      headers: { "content-type": "application/json", authorization: `Bearer ${token()}` },
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new ErroConfig("O agente ADRI está fora do ar", 502);
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new ErroConfig(d.issues ? "Valor inválido: " + d.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ") : d.message || d.error || `Agente HTTP ${r.status}`, 502);
  return d;
}

const texto = (v, nome, { max = 2000, obrigatorio = false } = {}) => {
  const s = String(v ?? "").trim();
  if (obrigatorio && !s) throw new ErroConfig(`${nome} é obrigatório`);
  if (s.length > max) throw new ErroConfig(`${nome} está muito longo`);
  return s;
};
const numero = (v, nome, { min = 0, max = 1e9 } = {}) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new ErroConfig(`${nome} deve estar entre ${min} e ${max}`);
  return n;
};

/** Valida e grava as edições do hub: no Supabase quando há banco; senão em data/config-editada.json. O arquivo base não é alterado. */
async function salvarHub(b, autor) {
  // "Detalhe" e "o que está incluso" (usados no PDF) não aparecem na tela: seguem o item de mesmo código.
  const atuais = new Map(config().catalogo.map((c) => [c.codigo, c]));
  const catalogo = (b.catalogo || []).map((c, i) => {
    const codigo = texto(c.codigo, `Código do item ${i + 1}`, { max: 30, obrigatorio: true }).toUpperCase().replace(/[^A-Z0-9_-]/g, "-");
    const { detalhe, inclui } = atuais.get(codigo) || {};
    return {
      codigo,
      descricao: texto(c.descricao, `Descrição do item ${i + 1}`, { max: 120, obrigatorio: true }),
      unidade: texto(c.unidade, `Unidade do item ${i + 1}`, { max: 20, obrigatorio: true }),
      valor: numero(c.valor, `Valor no studio do item ${i + 1}`, { max: 1e6 }),
      // Vazio = sem preço a domicílio cadastrado (o hub usa o do studio e avisa).
      ...(c.valorDomicilio !== "" && c.valorDomicilio != null && { valorDomicilio: numero(c.valorDomicilio, `Valor a domicílio do item ${i + 1}`, { max: 1e6 }) }),
      ...(detalhe && { detalhe }),
      ...(inclui && { inclui }),
    };
  });
  if (!catalogo.length) throw new ErroConfig("O catálogo precisa ter ao menos um item");
  if (new Set(catalogo.map((c) => c.codigo)).size !== catalogo.length) throw new ErroConfig("Há códigos repetidos no catálogo");
  const novo = {
    empresa: {
      nome: texto(b.empresa?.nome, "Nome da empresa", { max: 80, obrigatorio: true }),
      contato: texto(b.empresa?.contato, "Contato", { max: 120 }),
      telefone: texto(b.empresa?.telefone, "Telefone", { max: 40 }),
      rodapePdf: texto(b.empresa?.rodapePdf, "Rodapé do PDF", { max: 400 }),
    },
    validadeDias: numero(b.validadeDias, "Validade (dias)", { min: 1, max: 365 }),
    descontoMaximoPercentual: numero(b.descontoMaximoPercentual, "Desconto máximo (%)", { max: 100 }),
    atrasoHoras: numero(b.atrasoHoras, "Atraso (horas)", { min: 1, max: 720 }),
    instrucoesCalculo: texto(b.instrucoesCalculo, "Instruções de cálculo", { max: 4000 }),
    catalogo,
  };
  if (configNoBanco()) {
    await salvarConfigNoBanco(novo, autor?.id);
    return novo;
  }
  fs.mkdirSync(path.dirname(arquivoEditado), { recursive: true });
  const tmp = arquivoEditado + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(novo, null, 2));
  fs.renameSync(tmp, arquivoEditado);
  return novo;
}

async function lerAgente() {
  try {
    const [p, faq] = await Promise.all([agente("/api/settings/pricing"), agente("/api/settings/faq")]);
    return { disponivel: true, services: p.services, scheduling: p.scheduling, transport: { baseAddress: p.transport.baseAddress ?? "", safetyMarginPercent: p.transport.safetyMarginPercent }, faq };
  } catch (e) {
    return { disponivel: false, erro: e.message };
  }
}

async function salvarAgente(b) {
  const atual = await agente("/api/settings/pricing");
  const sch = b.scheduling || {};
  const scheduling = { ...atual.scheduling };
  for (const k of ["prepMinutes", "finishMarginMinutes", "cleanupMinutes", "bufferBetweenMinutes", "travelSafetyMinutes"])
    if (sch[k] !== undefined) scheduling[k] = Math.round(numero(sch[k], k, { max: 600 }));
  const transport = { ...atual.transport };
  if (b.transport?.baseAddress !== undefined) transport.baseAddress = texto(b.transport.baseAddress, "Endereço-base", { max: 200 }) || undefined;
  if (b.transport?.safetyMarginPercent !== undefined) transport.safetyMarginPercent = numero(b.transport.safetyMarginPercent, "Margem de deslocamento (%)", { max: 200 });
  const services = (b.services || atual.services).map((s) => ({ code: s.code, name: texto(s.name, "Nome do serviço", { obrigatorio: true, max: 80 }), durationMin: Math.round(numero(s.durationMin, `Duração de ${s.name}`, { min: 15, max: 720 })), active: s.active !== false }));
  await agente("/api/settings/pricing", { metodo: "PUT", corpo: { services, scheduling, transport } });
  if (b.faq) {
    const faq = b.faq
      .map((f) => ({ keywords: String(Array.isArray(f.keywords) ? f.keywords.join(",") : f.keywords || "").split(",").map((k) => k.trim()).filter(Boolean), answer: texto(f.answer, "Resposta", { max: 600 }) }))
      .filter((f) => f.keywords.length && f.answer);
    await agente("/api/settings/faq", { metodo: "PUT", corpo: faq });
  }
  return lerAgente();
}

// Status real de cada integração (nada é dado como conectado sem checar). Itens do agente + itens do próprio hub.
async function integracoes() {
  const hub = [
    { id: "hub-ia", nome: "IA que monta o orçamento", status: iaNome() ? "ok" : "pendente", detalhe: iaNome() ? `${iaNome()}` : "sem GEMINI_API_KEY nem ANTHROPIC_API_KEY: orçamentos calculados só por regras" },
    { id: "hub-banco", nome: "Banco de dados do hub", status: store.modo === "supabase" ? "ok" : "pendente", detalhe: store.modo === "supabase" ? "Supabase" : "arquivo local data/db.json (configure o Supabase para produção)" },
    { id: "hub-login", nome: "Login da equipe", status: loginAtivo ? "ok" : "pendente", detalhe: loginAtivo ? "Supabase Auth" : "sem login (só senha opcional): configure o Supabase" },
    { id: "hub-retorno", nome: "Retorno do orçamento aprovado para a ADRI", status: env.callbackUrl ? "ok" : "simulado", detalhe: env.callbackUrl ? "WHATSAPP_CALLBACK_URL configurada" : "WHATSAPP_CALLBACK_URL vazia: o PDF só fica na aba Saída WhatsApp e NÃO chega à cliente" },
  ];
  try {
    const a = await agente("/api/integrations?force=1");
    return { agente: true, simulacao: a.simulacao, itens: [...a.itens, ...hub] };
  } catch (e) {
    return { agente: false, itens: [{ id: "agente", nome: "Agente ADRI", status: "erro", detalhe: e.message }, ...hub] };
  }
}

export function rotasConfiguracoes(app, rota) {
  app.get("/api/integracoes", rota(async (req, res) => res.json(await integracoes())));
  app.get("/api/configuracoes", rota(async (req, res) => {
    const c = config();
    res.json({
      hub: { empresa: c.empresa, validadeDias: c.validadeDias, descontoMaximoPercentual: c.descontoMaximoPercentual, atrasoHoras: c.atrasoHoras, instrucoesCalculo: c.instrucoesCalculo, catalogo: c.catalogo },
      agente: await lerAgente(),
    });
  }));
  app.put("/api/configuracoes/hub", rota(async (req, res) => res.json(await salvarHub(req.body, req.usuario))));
  app.put("/api/configuracoes/agente", rota(async (req, res) => res.json(await salvarAgente(req.body))));
}
