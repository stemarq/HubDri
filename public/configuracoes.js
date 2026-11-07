// Tela "Configurações": a Adriana edita preços, regras do orçamento, agenda/deslocamento e respostas da ADRI.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

async function api(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { "content-type": "application/json" }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (r.status === 401) { location.href = "/login"; return new Promise(() => {}); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.erro || `Erro ${r.status}`);
  return d;
}

const campo = (rotulo, nome, valor, extra = "") => `<label class="pilha" style="gap:4px"><span class="label">${rotulo}</span><input name="${nome}" value="${esc(valor)}" ${extra} style="font:inherit;padding:10px 12px;border-radius:12px;border:1px solid var(--border);background:var(--surface);width:100%"></label>`;
const area = (rotulo, nome, valor, linhas = 3) => `<label class="pilha" style="gap:4px"><span class="label">${rotulo}</span><textarea name="${nome}" rows="${linhas}" style="font:inherit;padding:10px 12px;border-radius:12px;border:1px solid var(--border);background:var(--surface);width:100%">${esc(valor)}</textarea></label>`;
const entrada = (v, extra = "") => `<input value="${esc(v)}" ${extra} style="font:inherit;padding:8px 10px;border-radius:10px;border:1px solid var(--border);background:var(--surface);width:100%;min-width:0">`;
const num = (n) => (n ?? "") + "";

export async function telaConfiguracoes() {
  const app = $("#app");
  const [c, integ] = await Promise.all([api("/api/configuracoes"), api("/api/integracoes").catch((e) => ({ itens: [{ nome: "Integrações", status: "erro", detalhe: e.message }] }))]);
  const h = c.hub, a = c.agente;
  const COR = { ok: "#2e7d4f", pendente: "#b3261e", erro: "#b3261e", simulado: "#9a6b00" };
  const ROT = { ok: "Conectado", pendente: "Falta configurar", erro: "Com erro", simulado: "SIMULADO" };

  app.innerHTML = `
    <div class="titulo"><span class="label">Tudo que a Adriana pode mudar quando quiser</span><h1>Configurações</h1></div>

    <section class="card secao pilha" id="integracoes">
      <h2 style="margin:0;font-size:18px">Integrações</h2>
      <p class="dica">O que está realmente conectado agora. Nada aqui é simulado em produção: o que falta aparece em vermelho.</p>
      <ul style="list-style:none;margin:0;padding:0;display:grid;gap:10px">${integ.itens.map((i) => `<li style="display:grid;grid-template-columns:auto 1fr;gap:4px 10px;align-items:baseline"><span class="chip" style="color:${COR[i.status]};border-color:${COR[i.status]}">${ROT[i.status]}</span><span><strong>${esc(i.nome)}</strong><br><span class="muted">${esc(i.detalhe)}</span></span></li>`).join("")}</ul>
    </section>

    <form class="card secao pilha" id="f-hub">
      <h2 style="margin:0;font-size:18px">Orçamento e preços</h2>
      <p class="dica">Valem para os próximos orçamentos. Orçamentos já criados não mudam sozinhos (use “Editar” dentro do orçamento).</p>
      ${campo("Nome da empresa (aparece no PDF)", "nome", h.empresa.nome)}
      ${campo("E-mail de contato", "contato", h.empresa.contato)}
      ${campo("Telefone", "telefone", h.empresa.telefone)}
      ${area("Rodapé do PDF", "rodapePdf", h.empresa.rodapePdf, 2)}
      ${campo("Validade do orçamento (dias)", "validadeDias", num(h.validadeDias), 'inputmode="numeric"')}
      ${campo("Desconto máximo permitido (%)", "descontoMaximoPercentual", num(h.descontoMaximoPercentual), 'inputmode="decimal"')}
      ${campo("Marcar como atrasado depois de (horas)", "atrasoHoras", num(h.atrasoHoras), 'inputmode="numeric"')}
      ${area("Instruções para a IA que monta o orçamento", "instrucoesCalculo", h.instrucoesCalculo, 5)}
      <div class="pilha"><span class="label">Catálogo de preços</span>
        <div id="catalogo" class="pilha"></div>
        <div class="botoes" style="margin:0"><button type="button" class="btn pequeno" id="novo-item">+ Adicionar item</button></div>
      </div>
      <div class="botoes" style="margin:0;align-items:center"><button class="btn" type="submit">Salvar orçamento e preços</button><span id="m-hub" class="dica"></span></div>
    </form>

    ${a.disponivel ? `
    <form class="card secao pilha" id="f-agente">
      <h2 style="margin:0;font-size:18px">Agenda e deslocamento (ADRI)</h2>
      <p class="dica">A ADRI usa isso para calcular saída, chegada, término e retorno, e para conferir a agenda.</p>
      ${campo("Endereço de saída da Adriana", "baseAddress", a.transport.baseAddress)}
      ${campo("Tempo de preparo ao chegar (min)", "prepMinutes", num(a.scheduling.prepMinutes), 'inputmode="numeric"')}
      ${campo("Folga entre terminar e a cliente precisar estar pronta (min)", "finishMarginMinutes", num(a.scheduling.finishMarginMinutes), 'inputmode="numeric"')}
      ${campo("Tempo para organizar antes de ir embora (min)", "cleanupMinutes", num(a.scheduling.cleanupMinutes), 'inputmode="numeric"')}
      ${campo("Intervalo mínimo entre compromissos (min)", "bufferBetweenMinutes", num(a.scheduling.bufferBetweenMinutes), 'inputmode="numeric"')}
      ${campo("Folga extra no trajeto (min)", "travelSafetyMinutes", num(a.scheduling.travelSafetyMinutes), 'inputmode="numeric"')}
      ${campo("Margem de segurança no custo do deslocamento (%)", "safetyMarginPercent", num(a.transport.safetyMarginPercent), 'inputmode="decimal"')}
      <div class="pilha"><span class="label">Duração dos serviços</span><div id="servicos" class="pilha"></div></div>

      <h2 style="margin:12px 0 0;font-size:18px">Respostas automáticas da ADRI</h2>
      <p class="dica">Perguntas frequentes. Se a mensagem da cliente tiver uma das palavras, a ADRI responde com o texto. Palavras separadas por vírgula.</p>
      <div id="faq" class="pilha"></div>
      <div class="botoes" style="margin:0"><button type="button" class="btn pequeno" id="novo-faq">+ Adicionar resposta</button></div>
      <div class="botoes" style="margin:0;align-items:center"><button class="btn" type="submit">Salvar agenda e respostas</button><span id="m-agente" class="dica"></span></div>
    </form>` : `
    <div class="card secao"><span class="label">ADRI indisponível</span><p>${esc(a.erro)}. As configurações da ADRI aparecem aqui quando ela estiver no ar.</p></div>`}`;

  // ----- catálogo -----
  const linhaItem = (it = { codigo: "", descricao: "", unidade: "un", valor: "" }) => {
    const d = document.createElement("div");
    d.className = "item-cat";
    d.style.cssText = "display:grid;grid-template-columns:minmax(70px,1fr) minmax(120px,3fr) 70px 90px auto;gap:6px;align-items:center";
    d.innerHTML = `${entrada(it.codigo, 'data-k="codigo" placeholder="CÓDIGO"')}${entrada(it.descricao, 'data-k="descricao" placeholder="Descrição"')}${entrada(it.unidade, 'data-k="unidade" placeholder="un"')}${entrada(it.valor, 'data-k="valor" inputmode="decimal" placeholder="R$"')}<button type="button" class="link" aria-label="Remover item">Remover</button>`;
    d.querySelector("button").addEventListener("click", () => d.remove());
    return d;
  };
  h.catalogo.forEach((it) => $("#catalogo").append(linhaItem(it)));
  $("#novo-item").addEventListener("click", () => $("#catalogo").append(linhaItem()));

  $("#f-hub").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target, v = (n) => f.elements[n].value;
    const catalogo = [...f.querySelectorAll(".item-cat")].map((r) => {
      const g = (k) => r.querySelector(`[data-k=${k}]`).value;
      return { codigo: g("codigo"), descricao: g("descricao"), unidade: g("unidade"), valor: g("valor").replace(",", ".") };
    });
    const m = $("#m-hub");
    try {
      await api("/api/configuracoes/hub", { method: "PUT", body: {
        empresa: { nome: v("nome"), contato: v("contato"), telefone: v("telefone"), rodapePdf: v("rodapePdf") },
        validadeDias: v("validadeDias"), descontoMaximoPercentual: v("descontoMaximoPercentual").replace(",", "."), atrasoHoras: v("atrasoHoras"),
        instrucoesCalculo: v("instrucoesCalculo"), catalogo } });
      m.textContent = "Salvo ✓"; m.className = "dica";
    } catch (err) { m.textContent = err.message; m.className = "erro-txt"; }
  });

  if (!a.disponivel) return;

  // ----- agente: serviços e FAQ -----
  a.services.forEach((s) => {
    const d = document.createElement("div");
    d.className = "item-srv"; d.dataset.code = s.code; d.dataset.name = s.name;
    d.style.cssText = "display:grid;grid-template-columns:1fr 110px auto;gap:8px;align-items:center";
    d.innerHTML = `<span>${esc(s.name)}</span>${entrada(s.durationMin, 'data-k="durationMin" inputmode="numeric" aria-label="Duração em minutos"')}<label class="muted" style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-k="active" ${s.active ? "checked" : ""}> ativo</label>`;
    $("#servicos").append(d);
  });
  const linhaFaq = (f = { keywords: [], answer: "" }) => {
    const d = document.createElement("div");
    d.className = "item-faq"; d.style.cssText = "display:grid;gap:6px;border:1px solid var(--border);border-radius:12px;padding:10px";
    d.innerHTML = `${entrada((f.keywords || []).join(", "), 'data-k="keywords" placeholder="Palavras: endereço, onde fica, atende em"')}<textarea data-k="answer" rows="2" placeholder="Resposta da ADRI" style="font:inherit;padding:8px 10px;border-radius:10px;border:1px solid var(--border);background:var(--surface);width:100%">${esc(f.answer)}</textarea><button type="button" class="link" style="justify-self:start">Remover</button>`;
    d.querySelector("button").addEventListener("click", () => d.remove());
    return d;
  };
  a.faq.forEach((f) => $("#faq").append(linhaFaq(f)));
  $("#novo-faq").addEventListener("click", () => $("#faq").append(linhaFaq()));

  $("#f-agente").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target, v = (n) => f.elements[n].value.replace(",", ".");
    const m = $("#m-agente");
    try {
      await api("/api/configuracoes/agente", { method: "PUT", body: {
        transport: { baseAddress: v("baseAddress"), safetyMarginPercent: v("safetyMarginPercent") },
        scheduling: { prepMinutes: v("prepMinutes"), finishMarginMinutes: v("finishMarginMinutes"), cleanupMinutes: v("cleanupMinutes"), bufferBetweenMinutes: v("bufferBetweenMinutes"), travelSafetyMinutes: v("travelSafetyMinutes") },
        services: [...f.querySelectorAll(".item-srv")].map((r) => ({ code: r.dataset.code, name: r.dataset.name, durationMin: r.querySelector("[data-k=durationMin]").value, active: r.querySelector("[data-k=active]").checked })),
        faq: [...f.querySelectorAll(".item-faq")].map((r) => ({ keywords: r.querySelector("[data-k=keywords]").value, answer: r.querySelector("[data-k=answer]").value })),
      } });
      m.textContent = "Salvo ✓"; m.className = "dica";
    } catch (err) { m.textContent = err.message; m.className = "erro-txt"; }
  });
}
