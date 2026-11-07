// Tela "Conversas": quem falou com a ADRI, o nome da pessoa e TODO o histórico de mensagens. A Adriana assume/devolve,
// escreve, corrige o nome, anota observações e baixa a conversa.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const dh = (iso) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
const hora = (iso) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const CANAL = { TELEGRAM: "Telegram", WHATSAPP: "WhatsApp", SIMULATOR: "Teste" };
const fone = (t) => (t ? `+${t.slice(0, 2)} ${t.slice(2, 4)} ${t.slice(4, -4)}-${t.slice(-4)}` : "");

async function api(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { "content-type": "application/json" }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (r.status === 401) { location.href = "/login"; return new Promise(() => {}); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.erro || `Erro ${r.status}`);
  return d;
}

const nomeDe = (p) => (p.apagado ? "Dados apagados a pedido" : p.nome || p.usuario || fone(p.telefone) || "Sem nome");
const contato = (p) => [p.usuario, fone(p.telefone)].filter(Boolean).join(" · ");

let atual = null; // chat aberto: { id, assinatura }
let busca = "";

export async function telaConversas(id) {
  const app = $("#app");
  atual = null;
  if (id) return telaChat(app, id);
  app.innerHTML = `
    <div class="titulo"><span class="label" id="resumo-conv">Todas as conversas com a ADRI</span><h1>Conversas</h1></div>
    <input id="busca" type="search" value="${esc(busca)}" placeholder="Buscar por nome, @usuário, telefone ou texto de mensagem" aria-label="Buscar conversas"
      style="width:100%;font:inherit;padding:12px 14px;border-radius:14px;border:1px solid var(--border);background:var(--surface);margin-bottom:14px">
    <div id="lista-conv"></div>`;
  $("#busca").addEventListener("input", (e) => { busca = e.target.value; clearTimeout(telaConversas.t); telaConversas.t = setTimeout(carregarLista, 250); });
  await carregarLista();
}

async function carregarLista() {
  const { itens, atencao } = await api("/api/conversas" + (busca ? `?q=${encodeURIComponent(busca)}` : ""));
  const lista = $("#lista-conv");
  if (!lista) return;
  $("#resumo-conv").textContent = atencao ? `${atencao} esperando a Adriana` : `${itens.length} conversa${itens.length === 1 ? "" : "s"}`;
  lista.innerHTML = itens.length ? `<ol class="fila">${itens.map((c) => `
    <li><a href="#/conversas/${c.id}">
      <span class="thumb" style="display:grid;place-items:center;font-weight:600;color:var(--primary)">${esc((nomeDe(c.pessoa)[0] || "?").toUpperCase())}</span>
      <span class="nome">${esc(nomeDe(c.pessoa))}</span>
      <span class="valor">${c.orcamento ? esc(c.orcamento.codigo) : ""}</span>
      <span class="meta">
        <span class="chip ${c.modo === "HUMAN" ? "aguardando_aprovacao" : "enviado"}">${c.modo === "HUMAN" ? "Com a Adriana" : "ADRI atendendo"}</span>
        <span class="label">${CANAL[c.canal] || esc(c.canal)}${contato(c.pessoa) ? ` · ${esc(contato(c.pessoa))}` : ""} · ${c.mensagens} msg${c.ultima ? ` · ${hora(c.ultima.em)}` : ""}</span>
        ${c.ultima ? `<span class="muted" style="flex-basis:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${c.ultima.de === "cliente" ? "" : (c.ultima.de === "adriana" ? "Adriana: " : "ADRI: ")}${esc(c.ultima.tipo === "document" ? "📎 PDF enviado" : c.ultima.texto)}</span>` : ""}
      </span>
    </a></li>`).join("")}</ol>`
    : `<div class="vazio-grande"><span class="label">${busca ? "Nada encontrado" : "Sem conversas"}</span><p>${busca ? "Tente outro nome ou trecho de mensagem." : "Quando uma cliente falar com a ADRI, a conversa aparece aqui."}</p></div>`;
}

const assinatura = (c) => `${c.modo}|${c.mensagens}|${c.historico.at(-1)?.id}|${c.pessoa.nome}`;

async function telaChat(app, id) {
  const c = await api(`/api/conversas/${id}`);
  const p = c.pessoa, humano = c.modo === "HUMAN";
  app.innerHTML = `
    <a href="#/conversas" class="voltar">← Conversas</a>
    <div class="titulo">
      <span class="label">${CANAL[c.canal] || esc(c.canal)}${contato(p) ? ` · ${esc(contato(p))}` : ""}${c.orcamento ? ` · <a href="#/orcamento/${c.orcamento.id}">${esc(c.orcamento.codigo)}</a>` : ""}</span>
      <h1 id="nome-pessoa">${esc(nomeDe(p))}</h1>
      <span class="muted">Primeiro contato em ${dh(p.desde)} · ${c.mensagens} mensagens</span>
    </div>
    <div class="card secao pilha">
      <div class="botoes" style="margin:0;align-items:center">
        <span class="chip ${humano ? "aguardando_aprovacao" : "enviado"}">${humano ? "Com a Adriana: a ADRI está em silêncio" : "A ADRI está atendendo"}</span>
        <button class="btn pequeno" id="alternar">${humano ? "Devolver à ADRI" : "Assumir conversa"}</button>
        <a class="btn pequeno" href="/api/conversas/${id}/exportar?formato=txt">Baixar conversa</a>
      </div>
      <div class="conversa" id="msgs" style="max-height:60vh"></div>
      <form id="enviar" class="pilha">
        <textarea id="texto" rows="2" placeholder="${humano ? "Escreva para a cliente…" : "Escrever assume a conversa e silencia a ADRI"}" style="width:100%;font:inherit;padding:10px 12px;border-radius:12px;border:1px solid var(--border);background:var(--surface)"></textarea>
        <div class="botoes" style="margin:0"><button class="btn" type="submit">Enviar como Adriana</button><span class="erro-txt" id="erro"></span></div>
      </form>
    </div>
    ${p.apagado ? "" : `
    <form class="card secao pilha" id="f-pessoa">
      <span class="label">Sobre a pessoa</span>
      <label class="pilha" style="gap:4px"><span class="label">Nome</span><input name="nome" value="${esc(p.nome)}" placeholder="Como a cliente se chama" style="font:inherit;padding:10px 12px;border-radius:12px;border:1px solid var(--border);background:var(--surface);width:100%"></label>
      <label class="pilha" style="gap:4px"><span class="label">Observações da Adriana</span><textarea name="observacoes" rows="3" placeholder="Preferências, alergias, combinados…" style="font:inherit;padding:10px 12px;border-radius:12px;border:1px solid var(--border);background:var(--surface);width:100%">${esc(p.observacoes)}</textarea></label>
      <div class="botoes" style="margin:0;align-items:center"><button class="btn pequeno" type="submit">Salvar</button><span class="dica" id="m-pessoa"></span></div>
    </form>`}
    ${c.coletado ? `<details class="card secao"><summary class="label" style="cursor:pointer">O que a ADRI coletou neste pedido</summary><pre>${esc(JSON.stringify(c.coletado, null, 2))}</pre></details>` : ""}`;

  desenhar(c, true);
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
    try { await api(`/api/conversas/${id}/mensagem`, { method: "POST", body: { texto } }); telaChat(app, id); }
    catch (err) { $("#erro").textContent = err.message; }
  });
  $("#texto").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("#enviar").requestSubmit(); });
  $("#f-pessoa")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const m = $("#m-pessoa");
    try {
      await api(`/api/conversas/${id}/pessoa`, { method: "PATCH", body: { nome: e.target.elements.nome.value, observacoes: e.target.elements.observacoes.value } });
      m.textContent = "Salvo ✓"; m.className = "dica";
      $("#nome-pessoa").textContent = e.target.elements.nome.value.trim() || nomeDe({ ...p, nome: null });
    } catch (err) { m.textContent = err.message; m.className = "erro-txt"; }
  });
}

function desenhar(c, rolar) {
  const box = $("#msgs");
  if (!box) return;
  const noFim = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  let dia = "";
  box.innerHTML = c.historico.length ? c.historico.map((m) => {
    const d = new Date(m.em).toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long" });
    const sep = d !== dia ? `<div class="label" style="text-align:center;margin:10px 0 2px">${esc((dia = d))}</div>` : "";
    const quemE = m.de === "cliente" ? esc(c.pessoa.nome || c.pessoa.usuario || "Cliente") : m.de === "adriana" ? "Adriana" : "ADRI";
    return `${sep}<div class="msg ${m.de === "cliente" ? "cliente" : ""}" ${m.de === "adriana" ? 'style="background:var(--rose)"' : ""}>
      <span class="label">${quemE} · ${hora(m.em)}${m.tipo === "document" ? " · PDF" : m.tipo === "audio" ? " · áudio" : m.tipo === "image" ? " · imagem" : ""}${m.status === "FAILED" || m.status === "BLOCKED_WINDOW" ? ` · NÃO ENTREGUE${m.erro ? ` (${esc(m.erro)})` : ""}` : ""}</span>
      ${m.tipo === "document" ? "📎 " : m.tipo === "image" ? "🖼 " : m.tipo === "audio" ? "🎤 " : ""}${esc(m.texto)}
    </div>`;
  }).join("") : '<p class="muted">Sem mensagens.</p>';
  if (rolar || noFim) box.scrollTop = box.scrollHeight;
}

// Atualização automática a cada 4 s, sem apagar o que a Adriana está digitando.
setInterval(async () => {
  if (!location.hash.startsWith("#/conversas")) return;
  const [, , id] = location.hash.split("/");
  try {
    if (!id) {
      if (document.activeElement?.matches("input, textarea")) return;
      await carregarLista();
    } else if (atual?.id === id) {
      const c = await api(`/api/conversas/${id}`);
      if (assinatura(c) !== atual.assinatura) {
        const mudouModo = !atual.assinatura.startsWith(c.modo);
        atual.assinatura = assinatura(c);
        if (mudouModo) { if (!document.activeElement?.matches("textarea, input")) telaChat($("#app"), id); } else desenhar(c, false);
      }
    }
  } catch { /* o próximo ciclo tenta de novo */ }
}, 4000);
