// Tela "Preço Uber": simulação de preço de corrida, calibração com cotações reais e ajustes.
// Estimativa heurística (não é o preço oficial da Uber). Dados ficam neste navegador por enquanto.
import "/heuristica-uber.js";

const H = window.HubDriHeuristica;
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const brl = (v) => "R$ " + Number(v).toFixed(2).replace(".", ",");
const brl0 = (v) => "R$ " + (Number.isInteger(v) ? v : Number(v).toFixed(2).replace(".", ","));
const MIN_OBS = 4;

const LS = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sem armazenamento */ } },
};

const NOMES = {
  base: "Valor base (R$)", porKm: "R$ por km", porMin: "R$ por minuto", minima: "Tarifa mínima (R$)",
  arredondarPara: "Arredondar para cima de (R$, 0 = não)", congestionamentoPico: "Trânsito no pico (× tempo)",
  surgePico: "Aumento no pico (×)", surgeChuva: "Aumento com chuva (×)", surgeNoite: "Aumento à noite (×)",
  surgeEvento: "Aumento com evento (×)", surgeMax: "Teto do aumento (×)", extras: "Extras padrão (R$)",
};

let aba = "sim";
let params = Object.assign({}, H.PARAMS_PADRAO, LS.get("hd_params", {}));
let obs = LS.get("hd_obs", []);
const horaAgora = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const form = { km: "10", min: "22", dh: horaAgora(), chuva: 0, evento: 0, ext: "0", manual: "", preco: "" };

const entrada = () => ({ km: +form.km, min: +form.min, dataHora: form.dh, chuva: form.chuva, evento: !!form.evento, extras: +form.ext || 0 });
const campo = (rotulo, id, valor, extra = "") => `<label class="pilha" style="gap:4px"><span class="label">${rotulo}</span><input id="${id}" value="${esc(valor)}" ${extra} style="padding:10px 12px;border-radius:12px;border:1px solid var(--border);background:var(--surface);width:100%;min-width:0"></label>`;
const opcoes = (id, itens, atual) => `<div class="botoes" id="${id}" style="margin:0;flex-wrap:wrap">${itens.map(([v, t]) => `<button type="button" class="btn pequeno ${atual === v ? "cheio" : ""}" data-v="${v}">${t}</button>`).join("")}</div>`;

export function telaPreco() {
  const app = $("#app");
  app.innerHTML = `
    <div class="titulo"><span class="label">Estimativa de corrida · não é o preço oficial da Uber</span><h1>Preço Uber</h1></div>
    <div class="botoes" id="abas" style="margin:0 0 14px;flex-wrap:wrap">
      ${[["sim", "Simular"], ["cal", "Calibrar"], ["aj", "Ajustes"]].map(([v, t]) => `<button class="btn pequeno ${aba === v ? "cheio" : ""}" data-aba="${v}">${t}</button>`).join("")}
    </div>
    <div id="conteudo"></div>`;
  $("#abas").addEventListener("click", (e) => { const b = e.target.closest("[data-aba]"); if (b) { aba = b.dataset.aba; telaPreco(); } });
  if (aba === "sim") telaSimular(); else if (aba === "cal") telaCalibrar(); else telaAjustes();
}

// ---------- Simular ----------
function lerForm() {
  ["km", "min", "dh", "ext", "manual", "preco"].forEach((k) => { const el = $("#f-" + k); if (el) form[k] = el.value; });
}

function telaSimular() {
  $("#conteudo").innerHTML = `
    <div class="card secao pilha">
      <p class="dica" style="margin:0">Preencha o trajeto e o horário. O preço sempre sobe para o próximo múltiplo de ${params.arredondarPara || "—"}.</p>
      <div class="grade" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
        ${campo("Distância (km)", "f-km", form.km, 'inputmode="decimal"')}
        ${campo("Tempo de viagem (min)", "f-min", form.min, 'inputmode="numeric"')}
        ${campo("Dia e hora", "f-dh", form.dh, 'type="datetime-local"')}
        ${campo("Pedágio ou taxa (R$)", "f-ext", form.ext, 'inputmode="decimal"')}
      </div>
      <div class="pilha"><span class="label">Chuva</span>${opcoes("o-chuva", [[0, "Sem chuva"], [0.5, "Pode chover"], [1, "Chovendo"]], form.chuva)}</div>
      <div class="pilha"><span class="label">Movimento na região</span>${opcoes("o-evento", [[0, "Normal"], [1, "Evento / lotado"]], form.evento)}</div>
    </div>
    <div id="resultado" style="margin-top:14px"></div>`;
  const recalc = () => { lerForm(); resultado(); };
  $("#conteudo").addEventListener("input", (e) => { if (e.target.id?.startsWith("f-")) recalc(); });
  [["o-chuva", "chuva"], ["o-evento", "evento"]].forEach(([id, k]) => $("#" + id).addEventListener("click", (e) => {
    const b = e.target.closest("[data-v]"); if (!b) return;
    form[k] = +b.dataset.v;
    $("#" + id).querySelectorAll("button").forEach((x) => x.classList.toggle("cheio", x === b));
    recalc();
  }));
  resultado();
}

function detalhamento(e, r) {
  const c = r.detalhe.contexto;
  const l = [["Valor base", brl(params.base)], [`Distância (${e.km} km × ${brl(params.porKm)})`, brl(e.km * params.porKm)], [`Tempo (${r.detalhe.minutosUsados} min × ${brl(params.porMin)})`, brl(r.detalhe.minutosUsados * params.porMin)]];
  if (r.detalhe.usouMinima) l.push(["Tarifa mínima aplicada", brl(params.minima)]);
  if (c.pico) l.push(["Horário de pico", "×" + params.surgePico]);
  if (c.chuva) l.push([c.chuva === 1 ? "Chuva" : "Chance de chuva", "×" + (1 + (params.surgeChuva - 1) * c.chuva).toFixed(2)]);
  if (c.noite) l.push(["Noite", "×" + params.surgeNoite]);
  if (c.evento) l.push(["Evento", "×" + params.surgeEvento]);
  l.push(["Aumento total (com teto)", "×" + r.detalhe.surge], ["Pedágio e taxas", brl(e.extras)], ["Total exato", brl(r.total)], ["Cobrar (arredondado)", brl0(r.cobrar)]);
  return `<table style="width:100%;border-collapse:collapse;font-size:14px">${l.map(([a, b]) => `<tr><td style="padding:6px 0;border-bottom:1px solid var(--border)">${esc(a)}</td><td style="padding:6px 0;border-bottom:1px solid var(--border);text-align:right">${esc(b)}</td></tr>`).join("")}</table>`;
}

function resultado() {
  const box = $("#resultado"); if (!box) return;
  try {
    const e = entrada(), r = H.estimar(e, params), c = r.detalhe.contexto;
    const chips = [c.pico && "Horário de pico", c.chuva === 1 && "Chovendo", c.chuva > 0 && c.chuva < 1 && "Pode chover", c.noite && "Noite", c.evento && "Região movimentada", r.detalhe.usouMinima && "Tarifa mínima"].filter(Boolean);
    const man = parseFloat(String(form.manual).replace(",", "."));
    const dif = man > 0 ? man - r.cobrar : null;
    box.innerHTML = `
      <div class="card secao pilha">
        <span class="label">Cobrar do cliente</span>
        <div style="font-size:48px;font-weight:700;line-height:1.1;color:var(--primary)">${brl0(r.cobrar)}</div>
        <div class="muted" style="font-size:14px">Cálculo exato ${brl(r.total)}, arredondado para cima. A Uber deve mostrar algo entre ${brl(r.faixa[0])} e ${brl(r.faixa[1])}.</div>
        <div class="botoes" style="margin:0;flex-wrap:wrap">${(chips.length ? chips : ["Condições normais"]).map((t) => `<span class="chip">${esc(t)}</span>`).join("")}</div>
      </div>
      <div class="card secao pilha" style="margin-top:12px">
        <span class="label">Prefere definir na mão?</span>
        ${campo("Seu preço (R$)", "f-manual", form.manual, 'inputmode="decimal" placeholder="ex.: 80"')}
        <div class="muted" id="man-dif" style="font-size:14px">${dif === null ? "Digite um valor para comparar com a sugestão." : dif === 0 ? "Igual à sugestão do modelo." : `${dif > 0 ? "Acima" : "Abaixo"} da sugestão em ${brl0(Math.abs(dif))}.`}</div>
      </div>
      <details class="card secao" style="margin-top:12px"><summary class="label" style="cursor:pointer">Análise: como o preço foi calculado</summary><div style="margin-top:10px">${detalhamento(e, r)}</div></details>`;
    $("#f-manual").addEventListener("input", (ev) => { form.manual = ev.target.value; const m = parseFloat(String(form.manual).replace(",", ".")); const d = m > 0 ? m - r.cobrar : null; $("#man-dif").textContent = d === null ? "Digite um valor para comparar com a sugestão." : d === 0 ? "Igual à sugestão do modelo." : `${d > 0 ? "Acima" : "Abaixo"} da sugestão em ${brl0(Math.abs(d))}.`; });
  } catch (err) { box.innerHTML = `<div class="card secao" role="alert" style="color:var(--danger)">${esc(err.message)}</div>`; }
}

// ---------- Calibrar ----------
function telaCalibrar() {
  const n = obs.length, m = H.erro(obs, params);
  const viés = n ? obs.reduce((a, o) => a + (H.estimar(o, params).total - o.preco) / o.preco, 0) / n * 100 : 0;
  $("#conteudo").innerHTML = `
    <div class="card secao pilha">
      <p class="dica" style="margin:0">Faça trajetos de teste e registre o preço que o app da Uber mostrou. Quanto mais corridas, melhor o modelo.</p>
      <div><b>1.</b> Preencha o trajeto na aba Simular (km, tempo, hora e chuva).</div>
      <div><b>2.</b> Digite o preço mostrado pela Uber e registre.</div>
      ${campo("Preço da Uber (R$)", "f-preco", form.preco, 'inputmode="decimal"')}
      <div class="botoes" style="margin:0;align-items:center"><button class="btn cheio" id="add">Registrar corrida</button><span id="msg" class="dica"></span></div>
    </div>
    <div class="card secao pilha" style="margin-top:12px">
      <span class="label">Aprendizado</span>
      <div style="height:10px;background:var(--border);border-radius:99px;overflow:hidden"><i style="display:block;height:100%;width:${Math.min(100, n / MIN_OBS * 100)}%;background:var(--primary)"></i></div>
      <div class="muted" style="font-size:14px">${n >= MIN_OBS ? `${n} corridas registradas. Pronto para treinar.` : `${n} de ${MIN_OBS} corridas para o primeiro treino.`}</div>
      ${m === null ? "" : `<div>Erro médio: <b style="color:var(--${m < 15 ? "primary" : "danger"})">${m}%</b> <span class="muted">${m < 10 ? "(muito bom)" : m < 15 ? "(bom)" : "(impreciso, registre mais e treine)"}</span></div>
      <div class="muted" style="font-size:14px">${Math.abs(viés) < 3 ? "O modelo está bem equilibrado." : viés > 0 ? `O modelo costuma cobrar ${viés.toFixed(0)}% a mais que a Uber.` : `O modelo costuma cobrar ${Math.abs(viés).toFixed(0)}% a menos que a Uber.`}</div>`}
      <div class="botoes" style="margin:0"><button class="btn cheio" id="treinar" ${n < MIN_OBS ? "disabled" : ""}>Treinar modelo</button><button class="btn" id="limpar" ${n ? "" : "disabled"}>Apagar corridas</button></div>
    </div>
    ${n ? `<div class="card secao pilha" style="margin-top:12px"><span class="label">Suas corridas: Uber × modelo</span>
      <div class="muted" style="font-size:13px">Mostra quanto o modelo errou em cada corrida. Errar menos de 10% já é um bom resultado.</div>
      ${obs.slice().reverse().map((o) => { const e = H.estimar(o, params).total, d = (e - o.preco) / o.preco * 100, ruim = Math.abs(d) >= 10; return `
      <div style="display:grid;grid-template-columns:1fr auto;gap:2px 12px;padding:10px 0;border-top:1px solid var(--border)">
        <b>${o.km} km · ${o.min} min</b>
        <b style="text-align:right;color:var(${ruim ? "--danger" : "--fg"})">${Math.abs(d) < 0.5 ? "acertou" : `${Math.abs(d).toFixed(0)}% ${d > 0 ? "a mais" : "a menos"}`}</b>
        <span class="muted" style="font-size:14px">Uber ${brl0(o.preco)} · Modelo ${brl0(Math.round(e))}</span><span></span>
      </div>`; }).join("")}</div>` : ""}`;
  const msg = (t) => { $("#msg").textContent = t; };
  $("#add").addEventListener("click", () => {
    form.preco = $("#f-preco").value;
    const p = parseFloat(String(form.preco).replace(",", ".")), e = entrada();
    if (!(e.km > 0 && e.min > 0)) return msg("Preencha km e tempo na aba Simular.");
    if (!(p > 0)) return msg("Digite o preço que a Uber mostrou.");
    const previsto = H.estimar(e, params).total;
    obs.push({ ...e, preco: p }); LS.set("hd_obs", obs); form.preco = "";
    telaCalibrar(); $("#msg").textContent = `Registrada: o modelo previa ${brl(previsto)} e a Uber mostrou ${brl(p)}.`;
  });
  $("#treinar").addEventListener("click", () => {
    try { const antes = H.erro(obs, params); params = H.calibrar(obs, params); LS.set("hd_params", params); const depois = H.erro(obs, params); telaCalibrar(); $("#msg").textContent = `Modelo treinado: erro de ${antes}% para ${depois}%.`; }
    catch (err) { msg(err.message); }
  });
  $("#limpar").addEventListener("click", () => { if (confirm("Apagar todas as corridas registradas?")) { obs = []; LS.set("hd_obs", obs); telaCalibrar(); } });
}

// ---------- Ajustes ----------
function telaAjustes() {
  $("#conteudo").innerHTML = `
    <div class="card secao pilha">
      <p class="dica" style="margin:0">Valores que o modelo usa. Normalmente não precisa mexer: o botão Treinar ajusta base, km e minuto sozinho.</p>
      <div class="grade" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr))">${Object.keys(NOMES).map((k) => campo(NOMES[k], "p-" + k, params[k], 'inputmode="decimal"')).join("")}</div>
      <div class="botoes" style="margin:0"><button class="btn" id="rst">Restaurar padrão</button></div>
    </div>`;
  Object.keys(NOMES).forEach((k) => $("#p-" + k).addEventListener("change", (e) => { const v = parseFloat(String(e.target.value).replace(",", ".")); if (Number.isFinite(v)) { params[k] = v; LS.set("hd_params", params); } }));
  $("#rst").addEventListener("click", () => { params = Object.assign({}, H.PARAMS_PADRAO); LS.set("hd_params", params); telaAjustes(); });
}
