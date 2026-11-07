// Cálculo do orçamento. A IA (ou as regras) só escolhe itens e quantidades;
// os valores sempre vêm do catálogo e as contas são feitas aqui.
import { agora } from "./store.js";

const arred = (n) => Math.round(n * 100) / 100;

export const LOCAIS = { studio: "No studio", domicilio: "A domicílio" };

// ---------- Deslocamento (atendimento a domicílio) ----------
// O valor vem da ADRI, que calcula a rota da saída da Adriana até o local (ida e volta).
// Não está no catálogo: o hub acrescenta como item próprio, só a domicílio.
export const CODIGO_DESLOCAMENTO = "DESL";
export const PREFIXO_SEM_DESLOCAMENTO = "Deslocamento não calculado";

/** Estimativa de deslocamento do orçamento: o campo enviado pela ADRI ou, em leads antigos, a linha do briefing. */
export function deslocamentoDoOrcamento(orc) {
  const d = orc.evento?.deslocamento;
  if (d && Number(d.valor) > 0) return { valor: arred(Number(d.valor)), km: Number(d.km) || null };
  const r = (orc.briefing?.respostas || []).find((x) => /deslocamento estimado/i.test(x.pergunta));
  const m = r?.resposta?.match(/R\$\s*([\d.]+(?:,\d+)?)/);
  if (!m) return null;
  const valor = Number(m[1].includes(",") ? m[1].replace(/\./g, "").replace(",", ".") : m[1]);
  const km = Number((orc.briefing.respostas.find((x) => /dist[aâ]ncia/i.test(x.pergunta))?.resposta || "").match(/([\d.,]+)\s*km/)?.[1]?.replace(",", ".")) || null;
  return valor > 0 ? { valor: arred(valor), km } : null;
}

export const itemDeslocamento = (d) => ({
  codigo: CODIGO_DESLOCAMENTO,
  descricao: "Deslocamento (ida e volta)",
  unidade: "un",
  quantidade: 1,
  valorUnitario: d.valor,
  total: d.valor,
  observacao: `${d.km ? `~${d.km} km até o local · ` : ""}estimativa de corrida por aplicativo`,
});

/** Põe ou tira o item de deslocamento conforme o local. Sem estimativa a domicílio, deixa um aviso. */
export function aplicarDeslocamento(calc, orc) {
  calc.itens = calc.itens.filter((i) => i.codigo !== CODIGO_DESLOCAMENTO);
  calc.pontosDeAtencao = (calc.pontosDeAtencao || []).filter((p) => !p.startsWith(PREFIXO_SEM_DESLOCAMENTO));
  if (calc.local !== "domicilio") return calc;
  const d = deslocamentoDoOrcamento(orc);
  if (d) calc.itens.push(itemDeslocamento(d));
  else calc.pontosDeAtencao.push(`${PREFIXO_SEM_DESLOCAMENTO}: a ADRI não conseguiu a rota (confira o endereço de saída da Adriana em Configurações). Combine o valor à parte ou edite o orçamento.`);
  return calc;
}

// Tudo o que a cliente contou, num texto só (minúsculo), para as regras.
function textoDoPedido(orc) {
  return [
    orc.briefing?.resumo,
    orc.evento && Object.values(orc.evento).join(" "),
    ...(orc.briefing?.respostas || []).map((r) => `${r.pergunta} ${r.resposta}`),
    ...(orc.conversa || []).filter((m) => m.de === "cliente").map((m) => m.texto),
    ...(orc.revisoes || []).map((r) => r.comentario),
  ].join(" \n ").toLowerCase();
}

/** Onde será o atendimento: no studio da Adriana ou a domicílio (endereço informado pela cliente). */
export function localDoAtendimento(orc) {
  const texto = textoDoPedido(orc);
  if (/\bst[uú]dio\b|\best[uú]dio\b|mois[eé]s de corena|(?:ir|vou) at[eé] (?:voc[eê]|a[ií])/.test(texto))
    return { local: "studio", informado: true };
  if (String(orc.evento?.local || "").trim() || /domic[ií]lio|em casa|minha casa|no hotel|venha at[eé]|vir at[eé]/.test(texto))
    return { local: "domicilio", informado: true };
  return { local: "studio", informado: false };
}

/** Preço do serviço no local. Sem preço a domicílio cadastrado, usa o do studio. */
export const precoNoLocal = (cat, local) => (local === "domicilio" && cat.valorDomicilio != null ? cat.valorDomicilio : cat.valor);

export function montarCalculo(proposta, cfg, geradoPor, { local = "studio", informado = true } = {}) {
  const porCodigo = new Map(cfg.catalogo.map((c) => [c.codigo, c]));
  const itens = [];
  const semPrecoDomicilio = [];
  for (const p of proposta.itens || []) {
    const cat = porCodigo.get(p.codigo);
    const qtd = Number(p.quantidade);
    if (!cat || !(qtd > 0)) continue;
    if (local === "domicilio" && cat.valorDomicilio == null) semPrecoDomicilio.push(cat.descricao);
    const valor = precoNoLocal(cat, local);
    itens.push({
      codigo: cat.codigo,
      descricao: cat.descricao,
      unidade: cat.unidade,
      quantidade: arred(qtd),
      valorUnitario: valor,
      total: arred(valor * qtd),
      observacao: p.observacao || "",
    });
  }
  const pontos = [...(proposta.pontosDeAtencao || [])];
  if (!informado) pontos.push("Local do atendimento não informado: considerado no studio. Troque para domicílio se for o caso.");
  if (semPrecoDomicilio.length) pontos.push(avisoSemDomicilio(semPrecoDomicilio));
  return recalcularTotais(
    {
      local,
      itens,
      descontoPercentual: Math.min(Math.max(Number(proposta.descontoPercentual) || 0, 0), cfg.descontoMaximoPercentual),
      resumo: proposta.resumo || "",
      justificativa: proposta.justificativa || "",
      pontosDeAtencao: pontos,
      validadeDias: cfg.validadeDias,
      geradoPor,
      geradoEm: agora(),
    }
  );
}

export function recalcularTotais(calc) {
  calc.itens = calc.itens.map((i) => ({ ...i, total: arred(i.valorUnitario * i.quantidade) }));
  calc.subtotal = arred(calc.itens.reduce((s, i) => s + i.total, 0));
  calc.desconto = arred(calc.subtotal * (calc.descontoPercentual || 0) / 100);
  calc.total = arred(calc.subtotal - calc.desconto);
  return calc;
}

// Fallback sem IA: extrai do texto quem será maquiada, serviços extras, horário e distância.
export function propostaPorRegras(orc) {
  const texto = textoDoPedido(orc);

  const num = (re) => {
    const m = texto.match(re);
    return m ? Number(m[1].replace(",", ".")) : null;
  };
  const noiva = /noiva|casamento|casar|casando/.test(texto);
  const debutante = !noiva && /debutante|15 anos|quinze anos/.test(texto);
  const principal = noiva ? "NOIVA" : debutante ? "DEB" : null; // a protagonista tem itens próprios
  // "3 madrinhas" = além da protagonista; "3 pessoas"/"3 maquiagens" = total, contando ela.
  const acompanhantes = num(/(\d+)\s*(?:madrinhas|convidadas|amigas|mulheres|damas)/);
  const total = num(/(\d+)\s*(?:pessoas|maquiagens)/);
  const extras = acompanhantes != null ? acompanhantes + (principal ? 1 : 0) : total;
  const teste = /\bteste\b|\bprova\b/.test(texto);
  const penteado = /penteado|cabelo/.test(texto);
  const russo = /russo/.test(texto);
  const cacheado = /cachead|cachos/.test(texto);
  const cilios = /c[ií]lios/.test(texto);

  // "pra mim e mais 2" = a própria cliente + 2 (se ela for a noiva/debutante, já entra como tal)
  const maisN = num(/(?:mim|eu)\s+e\s+(?:mais\s+)?(?:pra\s+|para\s+)?(\d+)/);
  const outras = maisN != null ? maisN + (principal ? 0 : 1) : extras != null ? Math.max(extras - (principal ? 1 : 0), 0) : principal ? 0 : 1;

  const itens = [];
  const pontos = ["Calculado por regras automáticas (IA indisponível). Revise antes de aprovar."];
  if (principal) {
    itens.push({ codigo: `${principal}-MAKE${teste ? "-TESTE" : ""}`, quantidade: 1 });
    if (penteado) {
      // Só usa combinações que existem na tabela.
      const opcoes = noiva
        ? [russo && teste && "NOIVA-PENT-RUSSO-TESTE", teste && "NOIVA-PENT-TESTE", "NOIVA-PENT"]
        : [russo && teste && "DEB-PENT-RUSSO-TESTE", russo && "DEB-PENT-RUSSO", teste && "DEB-PENT-TESTE", cacheado && "DEB-PENT-CACHEADO", "DEB-PENT"];
      itens.push({ codigo: opcoes.find(Boolean), quantidade: 1 });
      if (noiva && russo && !teste) pontos.push("Penteado russo para noiva só existe com teste na tabela: foi considerado o penteado de noiva simples.");
    }
  }
  if (outras > 0) itens.push({ codigo: "MAKE-VISAGISTA", quantidade: outras });
  if (cilios) itens.push({ codigo: "CILIOS", quantidade: 1 });

  if (extras == null && maisN == null && !principal) pontos.push("Número de pessoas não informado: considerada 1 pessoa.");
  if (penteado && outras > 0) pontos.push("Penteado incluído só para a protagonista: confirme se as outras pessoas também querem.");
  if (cilios) pontos.push("Cílios considerados para 1 pessoa: confirme quantas querem.");
  if (/perman[eê]ncia|retoque/.test(texto)) pontos.push("Permanência e retoques no evento não estão na tabela de preços: combine à parte, se for o caso.");

  return {
    itens,
    descontoPercentual: 0,
    resumo:
      orc.briefing?.resumo ||
      (orc.briefing?.respostas || []).map((r) => `${r.pergunta}: ${r.resposta}`).join(" · "),
    justificativa: `${noiva ? "Noiva + " : debutante ? "Debutante + " : ""}${outras} maquiagem(ns) visagista(s)${penteado ? ", com penteado" : ""}${cilios ? ", com cílios" : ""}.`,
    pontosDeAtencao: pontos,
  };
}

export const PREFIXO_SEM_DOMICILIO = "Sem preço a domicílio cadastrado";
export const avisoSemDomicilio = (descricoes) =>
  `${PREFIXO_SEM_DOMICILIO} (usado o do studio): ${descricoes.join(", ")}. Cadastre em Configurações ou ajuste o valor.`;
