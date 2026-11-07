import express from "express";
import path from "node:path";
import * as store from "./store.js";
import { salvar } from "./store.js";
import { config, env } from "./config.js";
import * as fluxo from "./orcamentos.js";
import { STATUS, PENDENTES, ErroFluxo } from "./orcamentos.js";
import { gerarPdf } from "./pdf.js";
import { iaDisponivel, iaNome, situacaoIa } from "./ia.js";
import { leadExemplo } from "./simulador.js";
import { paginaCliente } from "./pagina-cliente.js";
import { loginAtivo, exigirLogin, rotasDeAcesso } from "./auth.js";
import { rotasConversas } from "./conversas.js";

const app = express();
app.use(express.json({ limit: "40mb" }));
app.use(express.urlencoded({ extended: false }));

const rota = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    if (!(e instanceof ErroFluxo)) console.error(e);
    res.status(e.status || 500).json({ erro: e.message });
  });

// ---------- Webhooks da IA do WhatsApp (token) ----------

function exigirToken(req, res, next) {
  if (env.webhookToken && req.get("x-hub-token") !== env.webhookToken)
    return res.status(401).json({ erro: "token inválido" });
  next();
}

app.post("/api/webhooks/whatsapp/lead", exigirToken, rota(async (req, res) => {
  const { orc, novo, falhas } = await fluxo.receberLead(req.body);
  res.status(novo ? 201 : 200).json({ orcamentoId: orc.id, codigo: orc.codigo, status: orc.status, novo, falhasImagens: falhas });
}));

app.post("/api/webhooks/whatsapp/resposta", exigirToken, rota(async (req, res) => {
  const { orcamentoId, conversationId, decisao, comentario } = req.body;
  const orc = orcamentoId
    ? store.acharOrcamento(orcamentoId)
    : store.orcamentos().findLast((o) => o.origem.conversationId === conversationId);
  await fluxo.registrarRespostaCliente(orc, decisao, comentario, "whatsapp");
  res.json({ ok: true, status: orc.status });
}));

app.get("/api/webhooks/whatsapp/orcamentos/:id", exigirToken, rota((req, res) => {
  const orc = store.acharOrcamento(req.params.id);
  if (!orc) throw new ErroFluxo("Orçamento não encontrado", 404);
  res.json({ orcamentoId: orc.id, codigo: orc.codigo, status: orc.status, pdfUrl: orc.status === "enviado" ? fluxo.linkPdf(orc) : null });
}));

// Receptor de teste: aponte WHATSAPP_CALLBACK_URL para cá para testar o retorno via HTTP.
app.post("/api/mock/whatsapp", (req, res) => {
  store.saidaWhatsapp().unshift({ ...req.body, simulado: true, viaHttp: true });
  salvar();
  res.json({ ok: true });
});

// ---------- Página pública da cliente ----------

app.get(["/tokens.css", "/cliente.css"], (req, res) => res.sendFile(path.resolve("public", req.path.slice(1))));
app.use("/fonts", express.static(path.resolve("public", "fonts")));

app.get("/p/:token", (req, res) => {
  const orc = store.acharPorToken(req.params.token);
  if (!orc) return res.status(404).send("Orçamento não encontrado");
  res.send(paginaCliente(orc));
});

app.get("/p/:token/orcamento.pdf", async (req, res) => {
  const orc = store.acharPorToken(req.params.token);
  if (!orc?.calculo || !orc.aprovadoEm) return res.status(404).send("PDF indisponível");
  await enviarPdf(orc, res);
});

// O PDF usa as imagens do chat: garante que estejam no cache local antes de gerar.
async function enviarPdf(orc, res) {
  await Promise.allSettled(orc.imagens.map((i) => store.garantirArquivo(i.arquivo)));
  res.type("pdf").set("Content-Disposition", `inline; filename="${orc.codigo}.pdf"`);
  gerarPdf(orc, res);
}

app.post("/p/:token/resposta", async (req, res) => {
  const orc = store.acharPorToken(req.params.token);
  try {
    // O link só aprova; pedidos de ajuste são recusados aqui e devem ir pela conversa do WhatsApp.
    await fluxo.registrarRespostaCliente(orc, req.body.decisao || "aprovado", "", "link");
    res.send(paginaCliente(orc));
  } catch (e) {
    if (!orc) return res.status(404).send("Orçamento não encontrado");
    res.status(e.status || 500).send(paginaCliente(orc, { erro: e.message }));
  }
});

// ---------- Hub: login da equipe (Supabase) ou senha opcional (modo arquivo) ----------

if (loginAtivo) rotasDeAcesso(app);

function autenticar(req, res, next) {
  if (!env.hubPassword) return next();
  const [, b64] = (req.get("authorization") || "").split(" ");
  const senha = b64 ? Buffer.from(b64, "base64").toString().split(":").slice(1).join(":") : "";
  if (senha === env.hubPassword) return next();
  res.set("WWW-Authenticate", 'Basic realm="HubDri"').status(401).send("Autenticação necessária");
}
app.use(loginAtivo ? exigirLogin : autenticar);
rotasConversas(app, rota); // conversas da ADRI (agente/) dentro do hub
app.use(express.static(path.resolve("public")));
// Imagens do chat: só serve arquivos que pertencem a algum orçamento (vindas do Storage ou do disco).
app.get("/uploads/:orcamento/:arquivo", rota(async (req, res) => {
  const caminho = `${req.params.orcamento}/${req.params.arquivo}`;
  if (!store.orcamentos().some((o) => o.imagens.some((i) => i.arquivo === caminho)))
    throw new ErroFluxo("Imagem não encontrada", 404);
  res.set("Cache-Control", "private, max-age=86400").sendFile(await store.garantirArquivo(caminho));
}));

const resumo = (o) => ({
  id: o.id,
  codigo: o.codigo,
  cliente: o.cliente.nome || o.cliente.telefone,
  telefone: o.cliente.telefone,
  cidade: o.cliente.cidade,
  status: o.status,
  criadoEm: o.criadoEm,
  atualizadoEm: o.atualizadoEm,
  total: o.calculo?.total ?? null,
  imagens: o.imagens.length,
  aprovado: Boolean(o.aprovadoEm),
  primeiraImagem: o.imagens[0]?.arquivo || null,
});

app.get("/api/meta", (req, res) => {
  const cfg = config();
  res.json({
    status: STATUS,
    pendentes: PENDENTES,
    catalogo: cfg.catalogo,
    empresa: cfg.empresa.nome,
    descontoMaximo: cfg.descontoMaximoPercentual,
    atrasoHoras: cfg.atrasoHoras,
    iaDisponivel: iaDisponivel(),
    ia: iaNome(),
    whatsappSimulado: !env.callbackUrl,
    simuladorAtivo: !env.producao,
    usuario: req.usuario ?? null,
  });
});

// Fila de prioridade: mais antigos primeiro.
app.get("/api/orcamentos", (req, res) => {
  const filtro = req.query.filtro || "pendentes";
  const lista = store.orcamentos().filter((o) =>
    filtro === "todos" ? true : filtro === "concluidos" ? !PENDENTES.includes(o.status) : PENDENTES.includes(o.status)
  );
  lista.sort((a, b) => a.criadoEm.localeCompare(b.criadoEm));
  res.json({
    itens: lista.map(resumo),
    contagem: {
      pendentes: store.orcamentos().filter((o) => PENDENTES.includes(o.status)).length,
      todos: store.orcamentos().length,
    },
  });
});

app.get("/api/orcamentos/:id", rota((req, res) => {
  const orc = store.acharOrcamento(req.params.id);
  if (!orc) throw new ErroFluxo("Orçamento não encontrado", 404);
  res.json({ ...orc, linkPublico: fluxo.linkPublico(orc) });
}));

app.get("/api/orcamentos/:id/pdf", rota(async (req, res) => {
  const orc = store.acharOrcamento(req.params.id);
  if (!orc?.calculo) throw new ErroFluxo("Orçamento ainda sem cálculo", 404);
  await enviarPdf(orc, res);
}));

app.post("/api/orcamentos/:id/aprovar", rota(async (req, res) => {
  res.json(await fluxo.aprovar(req.params.id, req.usuario));
}));
app.post("/api/orcamentos/:id/mudanca", rota((req, res) => {
  res.json(fluxo.solicitarMudanca(req.params.id, req.body.comentario, req.usuario));
}));
app.put("/api/orcamentos/:id/calculo", rota((req, res) => {
  res.json(fluxo.editarCalculo(req.params.id, req.body, req.usuario));
}));
app.post("/api/orcamentos/:id/reenviar", rota(async (req, res) => {
  res.json(await fluxo.enviar(req.params.id));
}));

app.get("/api/notificacoes", (req, res) => {
  const n = store.notificacoes();
  res.json({ itens: n.slice(0, 50), naoLidas: n.filter((x) => !x.lida).length });
});
app.post("/api/notificacoes/lidas", (req, res) => {
  const ids = req.body.ids;
  for (const n of store.notificacoes()) if (!ids || ids.includes(n.id)) n.lida = true;
  salvar();
  res.json({ ok: true });
});

app.get("/api/saida-whatsapp", (req, res) => res.json(store.saidaWhatsapp().slice(0, 50)));

if (!env.producao) {
  app.post("/api/dev/simular", rota(async (req, res) => {
    const { orc } = await fluxo.receberLead(leadExemplo());
    res.status(201).json({ orcamentoId: orc.id, codigo: orc.codigo });
  }));
}

const servidor = app.listen(env.port, () => {
  console.log(`HubDri rodando em ${env.publicUrl} · dados: ${store.modo === "supabase" ? "Supabase" : "data/db.json"}`);
  if (!env.webhookToken) console.warn("! HUB_WEBHOOK_TOKEN vazio: webhooks aceitam qualquer chamada.");
  if (!env.callbackUrl) console.warn("! WHATSAPP_CALLBACK_URL vazio: retorno ao WhatsApp em modo simulado.");
  (iaDisponivel() ? console.log : console.warn)((iaDisponivel() ? "" : "! ") + situacaoIa());
});

// Ao desligar, termina as gravações pendentes no Supabase antes de sair.
for (const sinal of ["SIGINT", "SIGTERM"]) {
  process.once(sinal, async () => {
    servidor.close();
    await store.aguardarGravacoes();
    process.exit(0);
  });
}
