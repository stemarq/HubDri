// Interface do hub: fila de prioridade, detalhe do orçamento, notificações.
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

async function api(url, opts = {}) {
  const r = await fetch(url, {
    ...opts,
    headers: { "content-type": "application/json", ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  // Sessão expirada ou encerrada: volta para a tela de login.
  if (r.status === 401 && (!meta || meta.usuario)) {
    location.href = "/login";
    return new Promise(() => {});
  }
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(dados.erro || `Erro ${r.status}`);
  return dados;
}

function avisar(msg) {
  const el = $("#aviso");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(avisar.t);
  avisar.t = setTimeout(() => (el.hidden = true), 4000);
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
  await api("/api/notificacoes/lidas", { method: "POST", body: { ids: [a.dataset.notif] } });
  carregarNotificacoes();
});
$("#ler-todas").addEventListener("click", async () => {
  await api("/api/notificacoes/lidas", { method: "POST", body: {} });
  carregarNotificacoes();
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

async function simularLead() {
  const r = await api("/api/dev/simular", { method: "POST" });
  avisar(`Lead simulado recebido: ${r.codigo}`);
  carregarNotificacoes();
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
      <span class="label">${o.codigo} · recebido ${dataHora(o.criadoEm)} · ${haQuanto(o.criadoEm)}</span>
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
          <textarea id="mudanca" rows="3" placeholder="Ex.: incluir penteado para as madrinhas" ${podeAgir ? "" : "disabled"}></textarea>
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
          ${calc ? blocoCalculo(o, podeAgir) : `<p class="muted" style="margin:0">Calculando… a página atualiza sozinha.</p>`}
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

  return `
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
    ${c.pontosDeAtencao?.length ? `<div class="atencao"><span class="label">Pontos de atenção</span><ul>${c.pontosDeAtencao.map((p) => `<li>${esc(p)}</li>`).join("")}</ul></div>` : ""}`;
}

function ligarAcoesDetalhe(o) {
  const executar = async (fn, msg) => {
    try {
      await fn();
      if (msg) avisar(msg);
    } catch (e) {
      avisar(e.message);
    }
    render();
  };

  app.querySelectorAll("[data-aprovar]").forEach((b) =>
    b.addEventListener("click", () => {
      b.disabled = true;
      executar(() => api(`/api/orcamentos/${o.id}/aprovar`, { method: "POST" }), "Aprovado! PDF enviado para o WhatsApp.");
    })
  );

  $("#pedir-mudanca").addEventListener("click", () => {
    const comentario = $("#mudanca").value.trim();
    if (!comentario) return $("#mudanca").focus();
    executar(() => api(`/api/orcamentos/${o.id}/mudanca`, { method: "POST", body: { comentario } }),
      "Mudança registrada. Recalculando…");
  });

  app.querySelectorAll("[data-reenviar]").forEach((b) =>
    b.addEventListener("click", () => executar(() => api(`/api/orcamentos/${o.id}/reenviar`, { method: "POST" })))
  );

  $("#editar")?.addEventListener("click", () => {
    edicao = { itens: structuredClone(o.calculo.itens), descontoPercentual: o.calculo.descontoPercentual };
    render();
  });
  $("#cancelar-edicao")?.addEventListener("click", () => { edicao = null; render(); });

  if (edicao) {
    app.querySelectorAll("[data-campo]").forEach((inp) =>
      inp.addEventListener("change", () => {
        edicao.itens[inp.dataset.i][inp.dataset.campo] = Number(inp.value) || 0;
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
    $("#desconto").addEventListener("change", (e) => { edicao.descontoPercentual = Number(e.target.value) || 0; render(); });
    $("#salvar-edicao").addEventListener("click", () => {
      const corpo = { ...edicao };
      edicao = null;
      executar(() => api(`/api/orcamentos/${o.id}/calculo`, { method: "PUT", body: corpo }), "Orçamento salvo. Revise e aprove para enviar.");
    });
  }
}

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
async function render() {
  const [, tela, param] = (location.hash || "#/fila").split("/");
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("ativo", a.dataset.nav === (tela === "orcamento" ? "fila" : tela || "fila")));
  try {
    if (tela === "orcamento") atualOrc = await telaOrcamento(param);
    else if (tela === "saida") { atualOrc = null; await telaSaida(); }
    else {
      atualOrc = null;
      if (param) filtroAtual = param;
      await telaFila();
    }
  } catch (e) {
    app.innerHTML = `<div class="vazio-grande"><span class="label">Erro</span><p>${esc(e.message)}</p><a class="btn" href="#/fila">Voltar à fila</a></div>`;
  }
}

window.addEventListener("hashchange", () => { edicao = null; render(); window.scrollTo(0, 0); });

async function ciclo() {
  await carregarNotificacoes().catch(() => {});
  const [, tela] = (location.hash || "#/fila").split("/");
  const digitando = document.activeElement?.matches("input, textarea, select, .dropdown *");
  if (digitando || edicao) return;
  if (tela === "fila" || !tela) telaFila().catch(() => {});
  else if (tela === "orcamento" && atualOrc && ["calculando", "enviando"].includes(atualOrc.status)) render();
}

(async function iniciar() {
  meta = await api("/api/meta");
  mostrarConta(meta.usuario);
  try { sessionStorage.removeItem("hub_link"); } catch {} // token do link de senha já foi usado
  await render();
  await carregarNotificacoes();
  setInterval(ciclo, 6000);
})();
