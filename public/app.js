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

const lerNome = () => { try { return localStorage.getItem("hub.nome") || ""; } catch { return ""; } };
const gravarNome = (v) => { try { localStorage.setItem("hub.nome", v); } catch {} };

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
              <span class="label">${haQuanto(o.criadoEm)} · ${o.codigo} · ${o.aprovacoes.feitas}/${o.aprovacoes.total} aprov.</span>
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

const PASSOS = ["Recebido", "Calculado", "Aprovações", "Enviado", "Resposta"];
function passoAtual(o) {
  return { calculando: 1, aguardando_aprovacao: 2, enviando: 3, falha_envio: 3, enviado: 4, mudanca_cliente: 4, aceito_cliente: 5 }[o.status];
}

let edicao = null; // cópia dos itens em edição

async function telaOrcamento(id) {
  const o = await api(`/api/orcamentos/${id}`);
  const atual = passoAtual(o);
  const calc = o.calculo;
  const podeAgir = ["aguardando_aprovacao", "mudanca_cliente", "falha_envio"].includes(o.status);
  const todasAprovadas = o.aprovacoes.every((a) => a.status === "aprovado");
  const proxima = o.status === "aguardando_aprovacao" && !edicao ? o.aprovacoes.find((a) => a.status !== "aprovado") : null;
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
        <section class="card secao" id="card-aprov">
          ${calc ? `<div class="resumo-total"><span class="label">Total</span><b>${brl(calc.total)}</b></div>` : ""}
          <h2>Aprovações internas</h2>
          <div class="voce">
            <label class="label" for="nome">Seu nome</label>
            <input id="nome" value="${esc(lerNome())}" placeholder="Quem está aprovando" autocomplete="name">
          </div>
          ${o.aprovacoes.map((a) => `
            <div class="aprov">
              <span><strong>${esc(a.etapa)}</strong><br>
                <span class="label">${a.status === "aprovado" ? `${esc(a.por)} · ${dataHora(a.em)}` : "Pendente"}</span></span>
              ${a.status === "aprovado"
                ? `<span class="ok">✓ Aprovado</span>`
                : `<button class="btn cheio pequeno" data-aprovar="${esc(a.etapa)}" ${o.status !== "aguardando_aprovacao" || edicao ? "disabled" : ""}>Aprovar</button>`}
            </div>`).join("")}
          <p class="dica">Com todas as aprovações, o PDF volta sozinho para a IA do WhatsApp.</p>
        </section>

        ${o.status === "falha_envio" ? `
        <section class="card secao">
          <p class="erro-txt" style="margin:0 0 12px">Falha no envio: ${esc(o.envios.at(-1)?.erro)}</p>
          <button class="btn cheio bloco" data-reenviar>Tentar enviar de novo</button>
        </section>` : ""}

        ${o.respostaCliente ? `
        <section class="card secao">
          <h2>Resposta da cliente <span class="label">via ${o.respostaCliente.via}</span></h2>
          <p style="margin:0"><strong style="font-weight:500">${o.respostaCliente.decisao === "aprovado" ? "Aprovou o orçamento" : "Pediu mudanças"}</strong>
          ${o.respostaCliente.comentario ? `<br><span class="muted">“${esc(o.respostaCliente.comentario)}”</span>` : ""}</p>
        </section>` : ""}

        <section class="card secao">
          <h2>Solicitar mudança</h2>
          <textarea id="mudanca" rows="3" placeholder="Ex.: incluir penteado para as madrinhas" ${podeAgir ? "" : "disabled"}></textarea>
          <button class="btn bloco" id="pedir-mudanca" style="margin-top:10px" ${podeAgir ? "" : "disabled"}>Recalcular com IA</button>
          <p class="dica">Gera um novo cálculo e zera as aprovações.</p>
        </section>

        <section class="card secao pilha">
          ${calc ? `<a class="btn bloco" href="/api/orcamentos/${o.id}/pdf" target="_blank" rel="noopener">Ver PDF${todasAprovadas ? "" : " (prévia)"}</a>` : ""}
          <a class="btn bloco" href="${esc(o.linkPublico)}" target="_blank" rel="noopener">Página da cliente ↗</a>
        </section>
      </aside>

      <div class="coluna">
        <section class="card secao">
          <h2>Orçamento</h2>
          ${calc ? blocoCalculo(o, podeAgir) : `<p class="muted" style="margin:0">Calculando… a página atualiza sozinha.</p>`}
        </section>

        <section class="card secao">
          <h2>Evento e cliente</h2>
          <dl class="kv">
            <div><dt class="label">Data</dt><dd>${esc(ev.data || "—")}</dd></div>
            <div><dt class="label">Horário</dt><dd>${esc(ev.horario || "—")}</dd></div>
            <div><dt class="label">Telefone</dt><dd>${esc(o.cliente.telefone || "—")}</dd></div>
            <div class="largo"><dt class="label">Local</dt><dd>${esc(ev.local || o.cliente.cidade || "—")}</dd></div>
            ${o.cliente.email ? `<div class="largo"><dt class="label">E-mail</dt><dd>${esc(o.cliente.email)}</dd></div>` : ""}
          </dl>
        </section>

        <section class="card secao">
          <h2>Briefing</h2>
          ${o.briefing.resumo ? `<p style="margin:0">${esc(o.briefing.resumo)}</p>` : ""}
          ${o.briefing.respostas.length ? `<dl class="respostas">${o.briefing.respostas.map((r) => `<div><dt class="label">${esc(r.pergunta)}</dt><dd>${esc(r.resposta)}</dd></div>`).join("")}</dl>` : ""}
        </section>

        <section class="card secao">
          <h2>Imagens do chat <span class="label">${o.imagens.length}</span></h2>
          ${o.imagens.length ? `<div class="imagens">${o.imagens.map((img) => `
            <a href="/uploads/${img.arquivo}" target="_blank" rel="noopener">
              <img src="/uploads/${img.arquivo}" alt="${esc(img.legenda)}" loading="lazy">
              <span>${esc(img.legenda || "Sem legenda")}</span>
            </a>`).join("")}</div>` : `<p class="muted" style="margin:0">Nenhuma imagem enviada.</p>`}
        </section>

        <section class="card secao">
          <h2>Conversa no WhatsApp</h2>
          <div class="conversa">${o.conversa.map((m) => `
            <div class="msg ${m.de === "cliente" ? "cliente" : ""}">
              <span class="label">${m.de === "cliente" ? "Cliente" : "IA"} · ${dataHora(m.em)}</span>${esc(m.texto)}
            </div>`).join("") || `<p class="muted">Sem mensagens.</p>`}
          </div>
        </section>

        <section class="card secao">
          <h2>Histórico</h2>
          <ol class="historico">
            ${[...o.historico].reverse().map((h) => `<li><span class="label">${dataHora(h.em)}</span>${esc(h.evento)}${h.detalhe ? ` <span class="muted">— ${esc(h.detalhe)}</span>` : ""}</li>`).join("")}
          </ol>
        </section>
      </div>
    </div>

    <div class="acao-fixa">
      ${calc ? `<a class="btn" href="/api/orcamentos/${o.id}/pdf" target="_blank" rel="noopener">PDF</a>` : ""}
      ${proxima ? `<button class="btn cheio" data-aprovar="${esc(proxima.etapa)}">Aprovar · ${esc(proxima.etapa)}</button>` : ""}
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
    <p class="label" style="margin:-6px 0 14px">${c.geradoPor === "ia" ? "Gerado pela IA" : "Gerado por regras"} · ${dataHora(c.geradoEm)}${c.editadoManualmente ? " · editado" : ""}</p>
    <ul class="itens">${linhas || `<li class="muted">Nenhum item.</li>`}</ul>
    ${editando ? `
      <div class="barra-edicao">
        <label><span class="label">Adicionar item</span>
          <select id="add-item"><option value="">Escolha um serviço…</option>${meta.catalogo.map((x) => `<option value="${x.codigo}">${esc(x.descricao)} — ${brl(x.valor)}/${x.unidade}</option>`).join("")}</select></label>
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
  const nomeEl = $("#nome");
  nomeEl.addEventListener("change", () => gravarNome(nomeEl.value.trim()));
  const por = () => nomeEl.value.trim() || "Equipe";

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
      if (!nomeEl.value.trim()) {
        nomeEl.scrollIntoView({ block: "center" });
        nomeEl.focus();
        return avisar("Informe seu nome para registrar a aprovação.");
      }
      gravarNome(nomeEl.value.trim());
      b.disabled = true;
      executar(() => api(`/api/orcamentos/${o.id}/aprovar`, { method: "POST", body: { etapa: b.dataset.aprovar, por: por() } }),
        `${b.dataset.aprovar} aprovado.`);
    })
  );

  $("#pedir-mudanca").addEventListener("click", () => {
    const comentario = $("#mudanca").value.trim();
    if (!comentario) return $("#mudanca").focus();
    executar(() => api(`/api/orcamentos/${o.id}/mudanca`, { method: "POST", body: { comentario, por: por() } }),
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
    $("#add-item").addEventListener("change", (e) => {
      const cat = meta.catalogo.find((x) => x.codigo === e.target.value);
      if (cat) edicao.itens.push({ codigo: cat.codigo, descricao: cat.descricao, unidade: cat.unidade, quantidade: 1, valorUnitario: cat.valor, observacao: "" });
      render();
    });
    $("#desconto").addEventListener("change", (e) => { edicao.descontoPercentual = Number(e.target.value) || 0; render(); });
    $("#salvar-edicao").addEventListener("click", () => {
      const corpo = { ...edicao, por: por() };
      edicao = null;
      executar(() => api(`/api/orcamentos/${o.id}/calculo`, { method: "PUT", body: corpo }), "Orçamento salvo. Aprovações reiniciadas.");
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
  const digitando = document.activeElement?.matches("input, textarea, select");
  if (digitando || edicao) return;
  if (tela === "fila" || !tela) telaFila().catch(() => {});
  else if (tela === "orcamento" && atualOrc && ["calculando", "enviando"].includes(atualOrc.status)) render();
}

(async function iniciar() {
  meta = await api("/api/meta");
  await render();
  await carregarNotificacoes();
  setInterval(ciclo, 6000);
})();
