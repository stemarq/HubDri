// Interface do hub: fila de prioridade, detalhe do orçamento, notificações.
import { telaConversas } from "/conversas.js";
import { telaConfiguracoes } from "/configuracoes.js";
const $ = (s, el = document) => el.querySelector(s);
const app = $("#app");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const brl = (n) => (n == null ? "—" : Number(n).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }));
const dataHora = (iso) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const pad = (n) => String(n).padStart(2, "0");
const unid = (u, q) => (Number(q) === 1 || ["un", "km", "m²"].includes(u) ? u : u + "s");

function haQuanto(iso) {
  const min = Math.floor((Date.now() - new Date(iso)) / 60000);
  if (min < 1) return "agora";
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h} h`;
  return `há ${Math.floor(h / 24)} d ${h % 24} h`;
}

class ErroConexao extends Error {}

async function api(url, opts = {}) {
  let r;
  try {
    r = await fetch(url, {
      ...opts,
      headers: { "content-type": "application/json", ...(opts.headers || {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ErroConexao("Sem conexão com o servidor. Confira a internet e tente de novo.");
  }
  // Sessão expirada ou encerrada: volta para a tela de login.
  if (r.status === 401 && (!meta || meta.usuario)) {
    location.href = "/login";
    return new Promise(() => {});
  }
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(dados.erro || (r.status >= 500 ? "O servidor teve um problema. Tente de novo em instantes." : `Erro ${r.status}`));
  return dados;
}

// ---------- Avisos (toasts) ----------
// tipo: "sucesso" | "erro" | "info". Erros ficam mais tempo e são anunciados na hora (role=alert).

const ICONE_AVISO = { sucesso: "✓", erro: "!", info: "i" };

function avisar(msg, tipo = "sucesso", titulo = "") {
  const pilha = $("#avisos");
  const el = document.createElement("div");
  el.className = `toast ${tipo}`;
  el.setAttribute("role", tipo === "erro" ? "alert" : "status");
  el.innerHTML = `
    <span class="toast-icone" aria-hidden="true">${ICONE_AVISO[tipo]}</span>
    <span>${titulo ? `<span class="toast-titulo">${esc(titulo)}</span>` : ""}${esc(msg)}</span>
    <button class="toast-fechar" aria-label="Fechar aviso">×</button>`;
  el.querySelector(".toast-fechar").addEventListener("click", () => el.remove());
  pilha.prepend(el);
  while (pilha.children.length > 3) pilha.lastElementChild.remove();
  setTimeout(() => el.remove(), tipo === "erro" ? 9000 : 4500);
}
const avisarErro = (e, titulo = "Não deu certo") => avisar(e.message || String(e), "erro", titulo);

// ---------- Popup de confirmação ----------
// confirmar({ titulo, texto (HTML já escapado), ok, cancelar }) → Promise<boolean>

function confirmar({ titulo, texto, ok = "Confirmar", cancelar = "Cancelar" }) {
  const d = $("#dialogo");
  d.innerHTML = `
    <form method="dialog" class="dialogo-corpo">
      <h2 id="dialogo-titulo">${esc(titulo)}</h2>
      <div class="dialogo-texto">${texto}</div>
      <div class="dialogo-botoes">
        <button class="btn" value="nao">${esc(cancelar)}</button>
        <button class="btn cheio" value="sim">${esc(ok)}</button>
      </div>
    </form>`;
  d.returnValue = "";
  return new Promise((resolve) => {
    d.addEventListener("close", () => resolve(d.returnValue === "sim"), { once: true });
    d.showModal();
    d.querySelector('[value="sim"]').focus();
  });
}
// Clique fora do cartão fecha (= cancelar).
$("#dialogo").addEventListener("click", (e) => { if (e.target.id === "dialogo") e.target.close("nao"); });

// ---------- Botão ocupado ----------
// Desativa as ações da tela e mostra o progresso no botão clicado. A tela é redesenhada depois.

function ocupar(botao, texto) {
  document.querySelectorAll("#app button, .acao-fixa button").forEach((b) => (b.disabled = true));
  botao.setAttribute("aria-busy", "true");
  botao.innerHTML = `<span class="spinner" aria-hidden="true"></span>${esc(texto)}`;
}

// ---------- Esqueletos (enquanto a tela carrega) ----------

function esqueleto(tela) {
  const sr = `<span class="sr">Carregando…</span>`;
  if (tela === "orcamento") return `
    <div class="esqueleto" aria-busy="true">${sr}
      <span class="esq linha" style="width:64px"></span>
      <span class="esq linha" style="width:46%"></span>
      <span class="esq titulo"></span>
      <span class="esq card" style="height:70px"></span>
      <span class="esq bloco"></span>
      <span class="esq bloco" style="height:140px"></span>
    </div>`;
  return `
    <div class="esqueleto" aria-busy="true">${sr}
      <span class="esq linha" style="width:40%"></span>
      <span class="esq titulo" style="width:45%"></span>
      <span class="esq linha" style="width:260px;height:40px;border-radius:999px;margin-bottom:6px"></span>
      <span class="esq card"></span><span class="esq card"></span><span class="esq card"></span>
    </div>`;
}

// ---------- Conexão ----------

function conexao(ok) {
  $("#conexao").hidden = ok;
}

// ---------- Dropdown personalizado ----------
// Botão + lista (role="listbox"), navegável por teclado. Substitui o <select> nativo.

const CHEVRON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;

function dropdown({ id, rotulo, placeholder, opcoes }) {
  return `
    <div class="dropdown" id="${id}">
      <span class="label" id="${id}-rotulo">${esc(rotulo)}</span>
      <button type="button" class="dropdown-botao" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="${id}-rotulo ${id}-valor">
        <span id="${id}-valor">${esc(placeholder)}</span>${CHEVRON}
      </button>
      <ul class="dropdown-lista" role="listbox" aria-labelledby="${id}-rotulo" tabindex="-1" hidden>
        ${opcoes.map((op) => `
          <li role="option" data-valor="${esc(op.valor)}" aria-selected="false">
            <span>${esc(op.titulo)}</span>${op.detalhe ? `<span class="dropdown-detalhe">${esc(op.detalhe)}</span>` : ""}
          </li>`).join("")}
      </ul>
    </div>`;
}

function ligarDropdown(el, aoEscolher) {
  const botao = $(".dropdown-botao", el), lista = $(".dropdown-lista", el);
  const itens = [...lista.querySelectorAll("[role=option]")];
  let ativo = -1;

  const marcar = (i) => {
    ativo = (i + itens.length) % itens.length;
    itens.forEach((li, j) => li.classList.toggle("ativo", j === ativo));
    itens[ativo].scrollIntoView({ block: "nearest" });
  };
  const abrir = () => { lista.hidden = false; botao.setAttribute("aria-expanded", "true"); lista.focus(); marcar(0); };
  const fechar = (focar = true) => { lista.hidden = true; botao.setAttribute("aria-expanded", "false"); if (focar) botao.focus(); };
  const escolher = (i) => { fechar(); aoEscolher(itens[i].dataset.valor); };

  botao.addEventListener("click", () => (lista.hidden ? abrir() : fechar()));
  botao.addEventListener("keydown", (e) => { if (e.key === "ArrowDown") { e.preventDefault(); abrir(); } });
  lista.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); marcar(ativo + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); marcar(ativo - 1); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); escolher(ativo); }
    else if (e.key === "Escape" || e.key === "Tab") fechar(e.key === "Escape");
  });
  itens.forEach((li, i) => {
    li.addEventListener("click", () => escolher(i));
    li.addEventListener("mousemove", () => ativo !== i && marcar(i));
  });
  document.addEventListener("click", (e) => { if (!el.contains(e.target) && !lista.hidden) fechar(false); });
}

let meta;
let filtroAtual = "pendentes";

// ---------- Notificações ----------

const sino = $("#sino"), painel = $("#painel-notif");

async function carregarNotificacoes() {
  const { itens, naoLidas } = await api("/api/notificacoes");
  const badge = $("#badge");
  badge.hidden = naoLidas === 0;
  badge.textContent = naoLidas;
  document.title = naoLidas ? `(${naoLidas}) HubDri` : "HubDri";
  $("#lista-notif").innerHTML = itens.length
    ? itens.map((n) => `
      <li class="${n.lida ? "lida" : ""}">
        <a href="#/orcamento/${n.orcamentoId}" data-notif="${n.id}">
          <span class="ponto"></span>
          <span><strong>${esc(n.titulo)}</strong>${esc(n.texto)}<span class="label" style="display:block;margin-top:2px">${haQuanto(n.em)}</span></span>
        </a>
      </li>`).join("")
    : `<li class="vazio">Nenhuma notificação ainda.</li>`;
}

sino.addEventListener("click", () => {
  const abrir = painel.hidden;
  painel.hidden = !abrir;
  sino.setAttribute("aria-expanded", String(abrir));
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".notif")) { painel.hidden = true; sino.setAttribute("aria-expanded", "false"); }
});
$("#lista-notif").addEventListener("click", async (e) => {
  const a = e.target.closest("[data-notif]");
  if (!a) return;
  painel.hidden = true;
  try {
    await api("/api/notificacoes/lidas", { method: "POST", body: { ids: [a.dataset.notif] } });
    await carregarNotificacoes();
  } catch { /* marcar como lida é secundário: a navegação segue */ }
});
$("#ler-todas").addEventListener("click", async (e) => {
  const b = e.currentTarget;
  b.disabled = true;
  try {
    await api("/api/notificacoes/lidas", { method: "POST", body: {} });
    await carregarNotificacoes();
    avisar("Todas as notificações foram marcadas como lidas.", "info");
  } catch (err) {
    avisarErro(err, "Não foi possível marcar as notificações");
  } finally {
    b.disabled = false;
  }
});

// ---------- Conta (login) ----------

const PAPEIS = { dona: "Dona", equipe: "Equipe" };

function mostrarConta(u) {
  if (!u) return;
  const iniciais = u.nome.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join("").toUpperCase() || "?";
  $("#avatar").textContent = iniciais;
  $("#conta-nome").textContent = u.nome;
  $("#conta-email").textContent = u.email;
  $("#conta-papel").textContent = PAPEIS[u.papel] || u.papel;
  $("#conta").hidden = false;
}

$("#avatar").addEventListener("click", () => {
  const p = $("#painel-conta"), abrir = p.hidden;
  p.hidden = !abrir;
  $("#avatar").setAttribute("aria-expanded", String(abrir));
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".conta")) { $("#painel-conta").hidden = true; $("#avatar").setAttribute("aria-expanded", "false"); }
});

async function simularLead(e) {
  ocupar(e.currentTarget, "Simulando…");
  try {
    const r = await api("/api/dev/simular", { method: "POST" });
    avisar(`${r.codigo} entrou na fila. O cálculo começa agora.`, "sucesso", "Lead simulado recebido");
    carregarNotificacoes().catch(() => {});
  } catch (err) {
    avisarErro(err, "Não foi possível simular o lead");
  }
  render();
}

// ---------- Fila ----------

async function telaFila() {
  const { itens, contagem } = await api(`/api/orcamentos?filtro=${filtroAtual}`);
  const aba = (f, t, n) => `<a href="#/fila/${f}" class="${filtroAtual === f ? "ativo" : ""}">${t}${n != null ? `<span class="n">${n}</span>` : ""}</a>`;
  const atrasoMs = meta.atrasoHoras * 3600000;

  app.innerHTML = `
    <div class="titulo">
      <span class="label">Fila de prioridade · mais antigos primeiro</span>
      <h1>Orçamentos</h1>
    </div>
    <div class="barra-fila">
      <nav class="abas" aria-label="Filtro">${aba("pendentes", "Pendentes", contagem.pendentes)}${aba("concluidos", "Concluídos")}${aba("todos", "Todos", contagem.todos)}</nav>
      ${meta.simuladorAtivo ? `<button class="btn pequeno" data-simular>+ Simular lead</button>` : ""}
    </div>
    ${itens.length ? `
      <ol class="fila">
        ${itens.map((o, i) => {
          const pendente = meta.pendentes.includes(o.status);
          const atrasado = pendente && Date.now() - new Date(o.criadoEm) > atrasoMs;
          return `<li><a href="#/orcamento/${o.id}">
            <span class="pos">${pad(i + 1)}</span>
            ${o.primeiraImagem ? `<img class="thumb" src="/uploads/${o.primeiraImagem}" alt="">` : `<span class="thumb"></span>`}
            <span class="nome">${esc(o.cliente)}</span>
            <span class="valor">${brl(o.total)}</span>
            <span class="meta">
              <span class="chip ${o.status}">${meta.status[o.status]}</span>
              ${atrasado ? `<span class="chip atraso">Atrasado</span>` : ""}
              <span class="label">${haQuanto(o.criadoEm)} · ${o.codigo}</span>
            </span>
          </a></li>`;
        }).join("")}
      </ol>` : `
      <div class="vazio-grande">
        <span class="label">Fila vazia</span>
        <p>${filtroAtual === "pendentes" ? "Nenhum orçamento esperando ação." : "Nada por aqui ainda."}</p>
        ${meta.simuladorAtivo ? `<button class="btn" data-simular>+ Simular lead do WhatsApp</button>` : ""}
      </div>`}`;

  app.querySelectorAll("[data-simular]").forEach((b) => b.addEventListener("click", simularLead));
}

// ---------- Detalhe ----------

const PASSOS = ["Recebido", "Calculado", "Aprovação", "Enviado", "Resposta"];
function passoAtual(o) {
  return { calculando: 1, aguardando_aprovacao: 2, enviando: 3, falha_envio: 3, enviado: 4, mudanca_cliente: 4, aceito_cliente: 5 }[o.status];
}

let edicao = null; // cópia dos itens em edição

async function telaOrcamento(id) {
  const o = await api(`/api/orcamentos/${id}`);
  const atual = passoAtual(o);
  const calc = o.calculo;
  const podeAgir = ["aguardando_aprovacao", "mudanca_cliente", "falha_envio"].includes(o.status);
  const aprovado = Boolean(o.aprovadoEm);
  const podeAprovar = o.status === "aguardando_aprovacao" && !edicao;
  const ev = o.evento || {};
  const cls = (i) => (i < atual ? "feito" : i === atual ? "atual" : "");

  app.innerHTML = `
    <a href="#/fila" class="voltar">← Fila</a>
    <div class="cab-orc">
      <span class="label">${o.codigo} · recebido ${dataHora(o.criadoEm)} · ${haQuanto(o.criadoEm)}${o.origem?.conversationId ? ` · <a href="#/conversas/${esc(o.origem.conversationId)}">ver conversa completa</a>` : ""}</span>
      <h1>${esc(o.cliente.nome || o.cliente.telefone)}</h1>
      <div class="linha"><span class="chip ${o.status}">${meta.status[o.status]}</span>${ev.tipo ? `<span class="chip">${esc(ev.tipo)}</span>` : ""}</div>
    </div>

    <div class="progresso card secao">
      <span class="label">Etapa ${Math.min(atual + 1, 5)} de 5 · ${PASSOS[Math.min(atual, 4)]}</span>
      <div class="barras">${PASSOS.map((_, i) => `<span class="${cls(i)}"></span>`).join("")}</div>
      <div class="nomes">${PASSOS.map((p, i) => `<span class="${cls(i)}">${p}</span>`).join("")}</div>
    </div>

    <div class="grade">
      <aside class="coluna lateral">
        <section class="card secao" id="card-aprov" style="order:2">
          ${calc ? `<div class="resumo-total"><span class="label">Total</span><b>${brl(calc.total)}</b></div>` : ""}
          ${aprovado
            ? `<span class="ok">✓ Aprovado em ${dataHora(o.aprovadoEm)}${o.aprovadoPorNome ? ` por ${esc(o.aprovadoPorNome)}` : ""}</span>`
            : `<button class="btn cheio bloco" data-aprovar ${podeAprovar ? "" : "disabled"}>Aprovar e enviar</button>
               <p class="dica">${edicao ? "Salve a edição antes de aprovar." : o.status === "calculando" ? "Aguardando o cálculo terminar." : "Ao aprovar, o PDF vai direto para a IA do WhatsApp."}</p>`}
        </section>

        ${o.status === "falha_envio" ? `
        <section class="card secao" style="order:3">
          <p class="erro-txt" style="margin:0 0 12px">Falha no envio: ${esc(o.envios.at(-1)?.erro)}</p>
          <button class="btn cheio bloco" data-reenviar>Tentar enviar de novo</button>
        </section>` : ""}

        ${o.respostaCliente ? `
        <section class="card secao" style="order:4">
          <h2>Resposta da cliente <span class="label">via ${o.respostaCliente.via}</span></h2>
          <p style="margin:0"><strong style="font-weight:500">${o.respostaCliente.decisao === "aprovado" ? "Aprovou o orçamento" : "Pediu mudanças"}</strong>
          ${o.respostaCliente.comentario ? `<br><span class="muted">“${esc(o.respostaCliente.comentario)}”</span>` : ""}</p>
        </section>` : ""}

        <section class="card secao" style="order:9">
          <h2>Solicitar mudança</h2>
          <label class="label" for="mudanca" style="display:block;margin-bottom:6px">O que precisa mudar?</label>
          <textarea id="mudanca" rows="3" placeholder="Ex.: incluir penteado para as madrinhas" aria-describedby="mudanca-erro" ${podeAgir ? "" : "disabled"}></textarea>
          <p class="erro-campo" id="mudanca-erro" hidden>Escreva o que deve mudar antes de recalcular.</p>
          <button class="btn bloco" id="pedir-mudanca" style="margin-top:10px" ${podeAgir ? "" : "disabled"}>Recalcular com IA</button>
          <p class="dica">Gera um novo cálculo; depois é só aprovar de novo.</p>
        </section>

        <section class="card secao pilha" style="order:10">
          ${calc ? `<a class="btn bloco" href="/api/orcamentos/${o.id}/pdf" target="_blank" rel="noopener">Ver PDF${aprovado ? "" : " (prévia)"}</a>` : ""}
          <a class="btn bloco" href="${esc(o.linkPublico)}" target="_blank" rel="noopener">Página da cliente ↗</a>
        </section>
      </aside>

      <div class="coluna">
        <section class="card secao" style="order:1">
          <h2>Orçamento</h2>
          ${o.status === "calculando" ? cartaoCalculando(Boolean(calc)) : ""}
          ${calc ? blocoCalculo(o, podeAgir) : ""}
        </section>

        <section class="card secao" style="order:5">
          <h2>Evento e cliente</h2>
          <dl class="kv">
            <div><dt class="label">Data</dt><dd>${esc(ev.data || "—")}</dd></div>
            <div><dt class="label">Horário</dt><dd>${esc(ev.horario || "—")}</dd></div>
            <div><dt class="label">Telefone</dt><dd>${esc(o.cliente.telefone || "—")}</dd></div>
            <div class="largo"><dt class="label">Local</dt><dd>${esc(ev.local || o.cliente.cidade || "—")}</dd></div>
            ${o.cliente.email ? `<div class="largo"><dt class="label">E-mail</dt><dd>${esc(o.cliente.email)}</dd></div>` : ""}
          </dl>
        </section>

        <section class="card secao" style="order:6">
          <h2>Briefing</h2>
          ${o.briefing.resumo ? `<p style="margin:0">${esc(o.briefing.resumo)}</p>` : ""}
          ${o.briefing.respostas.length ? `<dl class="respostas">${o.briefing.respostas.map((r) => `<div><dt class="label">${esc(r.pergunta)}</dt><dd>${esc(r.resposta)}</dd></div>`).join("")}</dl>` : ""}
        </section>

        <section class="card secao" style="order:7">
          <h2>Imagens do chat <span class="label">${o.imagens.length}</span></h2>
          ${o.imagens.length ? `<div class="imagens">${o.imagens.map((img) => `
            <a href="/uploads/${img.arquivo}" target="_blank" rel="noopener">
              <img src="/uploads/${img.arquivo}" alt="Imagem enviada pela cliente" loading="lazy">
            </a>`).join("")}</div>` : `<p class="muted" style="margin:0">Nenhuma imagem enviada.</p>`}
        </section>

        <section class="card secao" style="order:8">
          <h2>Conversa no WhatsApp</h2>
          <div class="conversa">${o.conversa.map((m) => `
            <div class="msg ${m.de === "cliente" ? "cliente" : ""}">
              <span class="label">${m.de === "cliente" ? "Cliente" : "IA"} · ${dataHora(m.em)}</span>${esc(m.texto)}
            </div>`).join("") || `<p class="muted">Sem mensagens.</p>`}
          </div>
        </section>

        <section class="card secao" style="order:11">
          <h2>Histórico</h2>
          <ol class="historico">
            ${[...o.historico].reverse().map((h) => `<li><span class="label">${dataHora(h.em)}</span>${esc(h.evento)}${h.detalhe ? ` <span class="muted">— ${esc(h.detalhe)}</span>` : ""}${h.autorNome ? ` <span class="muted">· ${esc(h.autorNome)}</span>` : ""}</li>`).join("")}
          </ol>
        </section>
      </div>
    </div>

    <div class="acao-fixa">
      ${calc ? `<a class="btn" href="/api/orcamentos/${o.id}/pdf" target="_blank" rel="noopener">PDF</a>` : ""}
      ${podeAprovar ? `<button class="btn cheio" data-aprovar>Aprovar e enviar</button>` : ""}
      ${o.status === "falha_envio" ? `<button class="btn cheio" data-reenviar>Reenviar</button>` : ""}
    </div>`;

  ligarAcoesDetalhe(o);
  return o;
}

function blocoCalculo(o, podeAgir) {
  const c = o.calculo;
  const editando = Boolean(edicao);
  const itens = editando ? edicao.itens : c.itens;
  const fmtQtd = (q) => Number(q).toLocaleString("pt-BR");

  const linhas = itens.map((it, i) => `
    <li>
      <span class="desc">${esc(it.descricao)}</span>
      <span class="tot">${brl(it.quantidade * it.valorUnitario)}</span>
      <span class="conta">${fmtQtd(it.quantidade)} ${esc(unid(it.unidade, it.quantidade))} × ${brl(it.valorUnitario)}</span>
      ${!editando && it.observacao ? `<span class="obs">${esc(it.observacao)}</span>` : ""}
      ${editando ? `
        <div class="editar">
          <label><span class="label">Qtd</span><input type="number" inputmode="decimal" step="0.5" min="0" data-campo="quantidade" data-i="${i}" value="${it.quantidade}"></label>
          <label><span class="label">Unitário</span><input type="number" inputmode="decimal" step="0.01" min="0" data-campo="valorUnitario" data-i="${i}" value="${it.valorUnitario}"></label>
          <button class="btn pequeno" data-remover="${i}" aria-label="Remover ${esc(it.descricao)}">Remover</button>
        </div>` : ""}
    </li>`).join("");

  const subtotal = itens.reduce((s, i) => s + i.quantidade * i.valorUnitario, 0);
  const desc = editando ? edicao.descontoPercentual : c.descontoPercentual;
  const total = subtotal - subtotal * (desc || 0) / 100;

  const falhaIa = c.pontosDeAtencao?.find((p) => p.startsWith("IA falhou"));
  // O alerta já explica a falha; o aviso genérico das regras sairia repetido.
  const pontos = (c.pontosDeAtencao || []).filter((p) => !falhaIa || (p !== falhaIa && !p.startsWith("Calculado por regras automáticas")));
  const motivoIa = falhaIa?.match(/^IA falhou \((.*)\); cálculo feito por regras\.$/)?.[1];
  return `
    ${falhaIa && !editando && podeAgir ? `
      <div class="alerta" role="note">
        <span class="alerta-icone" aria-hidden="true">!</span>
        <div>
          <strong>A IA não conseguiu calcular este orçamento</strong>
          <span>${esc(motivoIa || falhaIa)} Os itens abaixo vieram das regras automáticas: revise antes de aprovar.</span>
          ${meta.iaDisponivel ? `<br><button class="btn pequeno" data-recalcular>Tentar com a IA de novo</button>` : ""}
        </div>
      </div>` : ""}
    <p class="label" style="margin:-6px 0 14px">${c.geradoPor === "ia" ? `Gerado pela IA${c.ia ? ` (${esc(c.ia)})` : ""}` : "Gerado por regras"} · ${dataHora(c.geradoEm)}${c.editadoManualmente ? " · editado" : ""}</p>
    <ul class="itens">${linhas || `<li class="muted">Nenhum item.</li>`}</ul>
    ${editando ? `
      <div class="barra-edicao">
        ${dropdown({
          id: "add-item",
          rotulo: "Adicionar serviço",
          placeholder: "Escolha um serviço…",
          opcoes: meta.catalogo.map((x) => ({ valor: x.codigo, titulo: x.descricao, detalhe: `${brl(x.valor)} / ${x.unidade}` })),
        })}
        <label><span class="label">Desconto % (máx. ${meta.descontoMaximo})</span><input type="number" inputmode="decimal" id="desconto" min="0" max="${meta.descontoMaximo}" value="${desc || 0}"></label>
      </div>` : ""}
    <div class="totais">
      <div><span class="muted">Subtotal</span><span>${brl(subtotal)}</span></div>
      ${desc ? `<div><span class="muted">Desconto (${desc}%)</span><span>− ${brl(subtotal * desc / 100)}</span></div>` : ""}
      <div class="final"><span class="label">Total</span><span>${brl(total)}</span></div>
    </div>
    <div class="botoes">
      ${editando
        ? `<button class="btn cheio" id="salvar-edicao">Salvar alterações</button><button class="btn" id="cancelar-edicao">Cancelar</button>`
        : podeAgir ? `<button class="btn" id="editar">Editar itens</button>` : ""}
    </div>
    ${c.justificativa ? `<p class="como"><span class="label">Como foi calculado</span><br>${esc(c.justificativa)}</p>` : ""}
    ${pontos.length ? `<div class="atencao"><span class="label">Pontos de atenção</span><ul>${pontos.map((p) => `<li>${esc(p)}</li>`).join("")}</ul></div>` : ""}`;
}

function cartaoCalculando(recalculo) {
  const quem = meta.ia ? `A IA (${esc(meta.ia)}) está lendo a conversa e as fotos.` : "O cálculo pelas regras automáticas está em andamento.";
  return `
    <div class="calculando" role="status">
      <span class="spinner grande" aria-hidden="true"></span>
      <div>
        <strong>${recalculo ? "Recalculando o orçamento…" : "Calculando o orçamento…"}</strong>
        <span class="muted">${quem} Costuma levar de 10 a 30 segundos; a tela atualiza sozinha.</span>
      </div>
    </div>`;
}

function ligarAcoesDetalhe(o) {
  const cliente = esc(o.cliente.nome || o.cliente.telefone);

  // Roda a ação com o botão ocupado; erros viram aviso e a tela é redesenhada no fim.
  // Sem conexão, a tela fica como está (nada se perde) e só os botões voltam.
  const executar = async (botao, texto, fn, titulo) => {
    const antes = [...document.querySelectorAll("#app button")].map((b) => [b, b.disabled]);
    const rotulo = botao.innerHTML;
    ocupar(botao, texto);
    try {
      const r = await fn();
      await render();
      return r;
    } catch (e) {
      avisarErro(e, titulo);
      if (e instanceof ErroConexao) {
        conexao(false);
        antes.forEach(([b, d]) => (b.disabled = d));
        botao.removeAttribute("aria-busy");
        botao.innerHTML = rotulo;
      } else await render();
    }
  };

  // O envio pode falhar mesmo com a aprovação feita: o servidor responde com status falha_envio.
  const falhaEnvio = (r) => r?.envios?.at(-1)?.erro || "Erro desconhecido.";

  app.querySelectorAll("[data-aprovar]").forEach((b) =>
    b.addEventListener("click", async () => {
      const ok = await confirmar({
        titulo: "Aprovar e enviar?",
        texto: `<p><strong>${esc(o.codigo)} · ${cliente}</strong><br>Total de <strong>${brl(o.calculo.total)}</strong></p>
                <p class="muted">O PDF vai para a IA do WhatsApp enviar à cliente. Depois disso o envio não pode ser desfeito.</p>`,
        ok: "Aprovar e enviar",
      });
      if (!ok) return;
      const r = await executar(b, "Aprovando…", () => api(`/api/orcamentos/${o.id}/aprovar`, { method: "POST" }), "Não foi possível aprovar");
      if (r?.status === "falha_envio") avisar(falhaEnvio(r), "erro", "Aprovado, mas o envio ao WhatsApp falhou");
      else if (r) avisar("O PDF foi para a IA do WhatsApp enviar à cliente.", "sucesso", `${o.codigo} aprovado`);
    })
  );

  app.querySelectorAll("[data-reenviar]").forEach((b) =>
    b.addEventListener("click", async () => {
      const r = await executar(b, "Enviando…", () => api(`/api/orcamentos/${o.id}/reenviar`, { method: "POST" }), "Não foi possível reenviar");
      if (r?.status === "falha_envio") avisar(falhaEnvio(r), "erro", "O envio falhou de novo");
      else if (r) avisar("O PDF foi para a IA do WhatsApp.", "sucesso", "Reenviado");
    })
  );

  const campo = $("#mudanca");
  const erroCampo = $("#mudanca-erro");
  const marcarErro = (sim) => {
    erroCampo.hidden = !sim;
    if (sim) campo.setAttribute("aria-invalid", "true");
    else campo.removeAttribute("aria-invalid");
  };
  campo.addEventListener("input", () => { if (campo.value.trim()) marcarErro(false); });
  $("#pedir-mudanca").addEventListener("click", async (e) => {
    const b = e.currentTarget;
    const comentario = campo.value.trim();
    if (!comentario) { marcarErro(true); campo.focus(); return; }
    const ok = await confirmar({
      titulo: "Recalcular o orçamento?",
      texto: `<p>A IA vai refazer o cálculo de <strong>${cliente}</strong> com este pedido:</p>
              <blockquote>${esc(comentario)}</blockquote>
              <p class="muted">Depois é só revisar e aprovar de novo.</p>`,
      ok: "Recalcular",
    });
    if (!ok) return;
    const r = await executar(b, "Recalculando…", () => api(`/api/orcamentos/${o.id}/mudanca`, { method: "POST", body: { comentario } }), "Não foi possível pedir a mudança");
    if (r) avisar("O novo cálculo aparece aqui em alguns segundos.", "info", "Mudança registrada");
  });

  app.querySelectorAll("[data-recalcular]").forEach((b) =>
    b.addEventListener("click", async () => {
      const ok = await confirmar({
        titulo: "Tentar com a IA de novo?",
        texto: `<p>O cálculo atual, feito pelas regras, será substituído pelo da IA${meta.ia ? ` (${esc(meta.ia)})` : ""}.</p>`,
        ok: "Tentar de novo",
      });
      if (!ok) return;
      const r = await executar(b, "Pedindo…", () => api(`/api/orcamentos/${o.id}/recalcular`, { method: "POST" }), "Não foi possível recalcular");
      if (r) avisar("O novo cálculo aparece aqui em alguns segundos.", "info", "Cálculo pedido");
    })
  );

  $("#editar")?.addEventListener("click", () => {
    edicao = {
      itens: structuredClone(o.calculo.itens),
      descontoPercentual: o.calculo.descontoPercentual,
      original: JSON.stringify([o.calculo.itens, o.calculo.descontoPercentual]),
    };
    render();
  });
  $("#cancelar-edicao")?.addEventListener("click", async () => {
    if (edicaoAlterada() && !(await confirmar({
      titulo: "Descartar as alterações?",
      texto: "<p>As mudanças nos itens ainda não foram salvas.</p>",
      ok: "Descartar",
      cancelar: "Continuar editando",
    }))) return;
    edicao = null;
    render();
  });

  if (edicao) {
    app.querySelectorAll("[data-campo]").forEach((inp) =>
      inp.addEventListener("change", () => {
        let v = Number(inp.value) || 0;
        if (v < 0) { v = 0; avisar("Valores negativos viram zero.", "info"); }
        edicao.itens[inp.dataset.i][inp.dataset.campo] = v;
        render();
      })
    );
    app.querySelectorAll("[data-remover]").forEach((b) =>
      b.addEventListener("click", () => { edicao.itens.splice(Number(b.dataset.remover), 1); render(); })
    );
    ligarDropdown($("#add-item"), async (codigo) => {
      const cat = meta.catalogo.find((x) => x.codigo === codigo);
      if (cat) edicao.itens.push({ codigo: cat.codigo, descricao: cat.descricao, unidade: cat.unidade, quantidade: 1, valorUnitario: cat.valor, observacao: "" });
      await render();
      $("#add-item .dropdown-botao")?.focus({ preventScroll: true }); // mantém o foco após redesenhar
    });
    $("#desconto").addEventListener("change", (e) => {
      const v = Number(e.target.value) || 0;
      const ajustado = Math.min(Math.max(v, 0), meta.descontoMaximo);
      if (ajustado !== v) avisar(`O desconto fica entre 0 e ${meta.descontoMaximo}%.`, "info", "Desconto ajustado");
      edicao.descontoPercentual = ajustado;
      render();
    });
    $("#salvar-edicao").addEventListener("click", async (e) => {
      if (!edicao.itens.some((i) => i.quantidade > 0)) {
        avisar("Deixe pelo menos um serviço com quantidade maior que zero.", "erro", "Orçamento vazio");
        return;
      }
      const { itens, descontoPercentual } = edicao;
      const r = await executar(e.currentTarget, "Salvando…", async () => {
        const res = await api(`/api/orcamentos/${o.id}/calculo`, { method: "PUT", body: { itens, descontoPercentual } });
        edicao = null; // só sai da edição se salvou
        return res;
      }, "Não foi possível salvar");
      if (r) avisar("Revise e aprove para enviar.", "sucesso", "Orçamento salvo");
    });
  }
}

const edicaoAlterada = () => Boolean(edicao) && JSON.stringify([edicao.itens, edicao.descontoPercentual]) !== edicao.original;

// Sair da tela com edição pendente pede confirmação (links internos e fechar a aba).
document.addEventListener("click", async (e) => {
  const a = e.target.closest('a[href^="#/"]');
  if (!a || !edicaoAlterada()) return;
  e.preventDefault();
  const ok = await confirmar({
    titulo: "Sair sem salvar?",
    texto: "<p>As alterações nos itens deste orçamento serão perdidas.</p>",
    ok: "Sair sem salvar",
    cancelar: "Continuar editando",
  });
  if (ok) { edicao = null; location.hash = a.getAttribute("href"); }
});
window.addEventListener("beforeunload", (e) => { if (edicaoAlterada()) e.preventDefault(); });

// ---------- Saída WhatsApp ----------

async function telaSaida() {
  const itens = await api("/api/saida-whatsapp");
  app.innerHTML = `
    <div class="titulo">
      <span class="label">${meta.whatsappSimulado ? "Modo simulado · configure WHATSAPP_CALLBACK_URL" : "Retornos simulados"}</span>
      <h1>Saída WhatsApp</h1>
    </div>
    <div class="saida">
      ${itens.length ? itens.map((s) => `
        <article class="card">
          <span class="label">${dataHora(s.enviadoEm)} · ${esc(s.evento)} · ${esc(s.codigo)}</span>
          ${s.mensagemSugerida ? `<p style="margin:8px 0 0">${esc(s.mensagemSugerida)}</p>` : ""}
          ${s.pdfUrl ? `<p style="margin:12px 0 0"><a class="btn pequeno" href="${esc(s.pdfUrl)}" target="_blank" rel="noopener">Abrir PDF enviado</a></p>` : ""}
          <details><summary class="label" style="margin-top:12px;cursor:pointer">Ver dados enviados</summary><pre>${esc(JSON.stringify(s, null, 2))}</pre></details>
        </article>`).join("") : `<div class="vazio-grande"><span class="label">Vazio</span><p>Nada foi devolvido ao WhatsApp ainda.</p></div>`}
    </div>`;
}

// ---------- Roteamento e atualização ----------

let atualOrc = null;
async function render({ carregando = false } = {}) {
  const [, tela, param] = (location.hash || "#/fila").split("/");
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("ativo", a.dataset.nav === (tela === "orcamento" ? "fila" : tela || "fila")));
  if (carregando) app.innerHTML = esqueleto(tela);
  try {
    if (tela === "orcamento") atualOrc = await telaOrcamento(param);
    else if (tela === "saida") { atualOrc = null; await telaSaida(); }
    else if (tela === "conversas") { atualOrc = null; await telaConversas(param); }
    else if (tela === "configuracoes") { atualOrc = null; await telaConfiguracoes(); }
    else {
      atualOrc = null;
      if (param) filtroAtual = param;
      await telaFila();
    }
    conexao(true);
  } catch (e) {
    const semRede = e instanceof ErroConexao;
    if (semRede) conexao(false);
    app.innerHTML = `
      <div class="vazio-grande" role="alert">
        <span class="label">${semRede ? "Sem conexão" : "Erro"}</span>
        <p>${esc(e.message)}</p>
        <div class="acoes-erro">
          <button class="btn cheio" data-tentar ${semRede ? "data-sem-rede" : ""}>Tentar de novo</button>
          ${tela === "orcamento" ? `<a class="btn" href="#/fila">Voltar à fila</a>` : ""}
        </div>
      </div>`;
    $("[data-tentar]").addEventListener("click", () => render({ carregando: true }));
  }
}

window.addEventListener("hashchange", () => { edicao = null; render({ carregando: true }); window.scrollTo(0, 0); });

async function ciclo() {
  try {
    await carregarNotificacoes();
    conexao(true);
  } catch (e) {
    if (e instanceof ErroConexao) conexao(false);
    return;
  }
  // A conexão voltou e a tela ficou no erro: tenta de novo sozinha.
  if (app.querySelector("[data-tentar][data-sem-rede]")) return render();
  const [, tela] = (location.hash || "#/fila").split("/");
  const digitando = document.activeElement?.matches("input, textarea, select, .dropdown *");
  const ocupado = $("#dialogo").open || app.querySelector("button[aria-busy]");
  if (digitando || edicao || ocupado) return;
  if (tela === "fila" || !tela) telaFila().catch(() => {});
  else if (tela === "orcamento" && atualOrc && ["calculando", "enviando"].includes(atualOrc.status)) {
    const antes = atualOrc;
    await render();
    avisarFimDoCalculo(antes, atualOrc);
  }
}

// Avisa quando o cálculo em segundo plano termina com a tela aberta.
function avisarFimDoCalculo(antes, depois) {
  if (antes.status !== "calculando" || !depois || depois.id !== antes.id || depois.status === "calculando" || !depois.calculo) return;
  const c = depois.calculo;
  if (c.pontosDeAtencao?.some((p) => p.startsWith("IA falhou"))) avisar("Usamos as regras automáticas. Revise os itens antes de aprovar.", "erro", "A IA não conseguiu calcular");
  else if (c.geradoPor === "ia") avisar("Revise e aprove para enviar.", "sucesso", `Calculado pela IA${c.ia ? ` (${c.ia})` : ""}`);
  else avisar("Revise e aprove para enviar.", "info", "Calculado pelas regras");
}

(async function iniciar() {
  try {
    meta = await api("/api/meta");
  } catch (e) {
    if (e instanceof ErroConexao) conexao(false);
    app.innerHTML = `
      <div class="vazio-grande" role="alert">
        <span class="label">Não foi possível abrir o hub</span>
        <p>${esc(e.message)}</p>
        <button class="btn cheio" id="recarregar">Tentar de novo</button>
      </div>`;
    $("#recarregar").addEventListener("click", () => location.reload());
    return;
  }
  mostrarConta(meta.usuario);
  try { sessionStorage.removeItem("hub_link"); } catch {} // token do link de senha já foi usado
  await render({ carregando: true });
  carregarNotificacoes().catch(() => {});
  setInterval(ciclo, 6000);
})();
