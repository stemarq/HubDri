// Tela "Conversas": lista, chat completo, assumir/devolver e enviar mensagem como Adriana.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const hora = (iso) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const CANAL = { TELEGRAM: "Telegram", WHATSAPP: "WhatsApp", SIMULATOR: "Simulador" };

async function api(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { "content-type": "application/json" }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (r.status === 401) { location.href = "/login"; return new Promise(() => {}); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.erro || `Erro ${r.status}`);
  return d;
}

let atual = null; // { id, ultimaAssinatura }

export async function telaConversas(id) {
  const app = $("#app");
  atual = null;
  if (id) return telaChat(app, id);
  const { itens, atencao } = await api("/api/conversas");
  app.innerHTML = `
    <div class="titulo">
      <span class="label">${atencao ? `${atencao} esperando a Adriana` : "Todas as conversas da ADRI"}</span>
      <h1>Conversas</h1>
    </div>
    ${itens.length ? `<ol class="fila">${itens.map((c) => `
      <li><a href="#/conversas/${c.id}">
        <span class="thumb"></span>
        <span class="nome">${esc(c.cliente)}</span>
        <span class="valor">${c.orcamento ? esc(c.orcamento.codigo) : ""}</span>
        <span class="meta">
          <span class="chip ${c.modo === "HUMAN" ? "aguardando_aprovacao" : "enviado"}">${c.modo === "HUMAN" ? "Com a Adriana" : "ADRI atendendo"}</span>
          <span class="label">${CANAL[c.canal] || esc(c.canal)}${c.ultima ? ` · ${hora(c.ultima.em)}` : ""}</span>
          ${c.ultima ? `<span class="muted" style="flex-basis:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${c.ultima.de === "cliente" ? "" : "ADRI: "}${esc(c.ultima.texto)}</span>` : ""}
        </span>
      </a></li>`).join("")}</ol>`
      : `<div class="vazio-grande"><span class="label">Sem conversas</span><p>Quando uma cliente falar com a ADRI, a conversa aparece aqui.</p></div>`}`;
}

async function telaChat(app, id) {
  const c = await api(`/api/conversas/${id}`);
  const humano = c.modo === "HUMAN";
  app.innerHTML = `
    <a href="#/conversas" class="voltar">← Conversas</a>
    <div class="titulo">
      <span class="label">${CANAL[c.canal] || esc(c.canal)}${c.orcamento ? ` · <a href="#/orcamento/${c.orcamento.id}">${esc(c.orcamento.codigo)}</a>` : ""}</span>
      <h1>${esc(c.cliente)}</h1>
    </div>
    <div class="card secao pilha">
      <div class="botoes" style="margin:0;align-items:center">
        <span class="chip ${humano ? "aguardando_aprovacao" : "enviado"}" id="modo">${humano ? "Com a Adriana: a ADRI está em silêncio" : "A ADRI está atendendo"}</span>
        <button class="btn pequeno" id="alternar">${humano ? "Devolver à ADRI" : "Assumir conversa"}</button>
      </div>
      <div class="conversa" id="msgs" style="max-height:60vh"></div>
      <form id="enviar" class="pilha">
        <textarea id="texto" rows="2" placeholder="${humano ? "Escreva para a cliente…" : "Escrever assume a conversa e silencia a ADRI"}" style="width:100%;font:inherit;padding:10px 12px;border-radius:12px;border:1px solid var(--border);background:var(--surface)"></textarea>
        <div class="botoes" style="margin:0"><button class="btn" type="submit">Enviar como Adriana</button><span class="erro-txt" id="erro"></span></div>
      </form>
    </div>
    ${c.coletado ? `<details class="card secao"><summary class="label" style="cursor:pointer">O que a ADRI coletou</summary><pre>${esc(JSON.stringify(c.coletado, null, 2))}</pre></details>` : ""}`;

  desenharMensagens(c, true);
  atual = { id, assinatura: assinatura(c) };

  $("#alternar").addEventListener("click", async () => {
    await api(`/api/conversas/${id}/${humano ? "devolver" : "assumir"}`, { method: "POST" });
    telaChat(app, id);
  });
  $("#enviar").addEventListener("submit", async (e) => {
    e.preventDefault();
    const texto = $("#texto").value.trim();
    if (!texto) return;
    $("#erro").textContent = "";
    try {
      await api(`/api/conversas/${id}/mensagem`, { method: "POST", body: { texto } });
      telaChat(app, id);
    } catch (err) { $("#erro").textContent = err.message; }
  });
  $("#texto").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("#enviar").requestSubmit(); });
}

const assinatura = (c) => `${c.modo}|${c.mensagens.length}|${c.mensagens.at(-1)?.id}`;

function desenharMensagens(c, rolar) {
  const box = $("#msgs");
  if (!box) return;
  const noFim = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.innerHTML = c.mensagens.length ? c.mensagens.map((m) => `
    <div class="msg ${m.de === "cliente" ? "cliente" : ""}" ${m.de === "adriana" ? 'style="background:var(--rose)"' : ""}>
      <span class="label">${m.de === "cliente" ? "Cliente" : m.de === "adriana" ? "Adriana" : "ADRI"} · ${hora(m.em)}${m.tipo === "document" ? " · PDF" : ""}${m.status === "FAILED" || m.status === "BLOCKED_WINDOW" ? " · não entregue" : ""}</span>
      ${m.tipo === "document" ? "📎 " : m.tipo === "image" ? "🖼 " : ""}${esc(m.texto)}
    </div>`).join("") : '<p class="muted">Sem mensagens.</p>';
  if (rolar || noFim) box.scrollTop = box.scrollHeight;
}

// Atualização automática a cada 4 s, sem apagar o que a Adriana está digitando.
setInterval(async () => {
  if (!location.hash.startsWith("#/conversas")) return;
  const [, , id] = location.hash.split("/");
  try {
    if (!id) {
      if (document.activeElement?.matches("input, textarea")) return;
      await telaConversas();
    } else if (atual?.id === id) {
      const c = await api(`/api/conversas/${id}`);
      if (assinatura(c) !== atual.assinatura) {
        const mudouModo = !atual.assinatura.startsWith(c.modo);
        atual.assinatura = assinatura(c);
        if (mudouModo) { if (!document.activeElement?.matches("textarea")) telaChat($("#app"), id); } else desenharMensagens(c, false);
      }
    }
  } catch { /* o próximo ciclo tenta de novo */ }
}, 4000);
