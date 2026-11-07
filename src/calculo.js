// Cálculo do orçamento. A IA (ou as regras) só escolhe itens e quantidades;
// os valores sempre vêm do catálogo e as contas são feitas aqui.
import { agora } from "./store.js";

const arred = (n) => Math.round(n * 100) / 100;

export function montarCalculo(proposta, cfg, geradoPor) {
  const porCodigo = new Map(cfg.catalogo.map((c) => [c.codigo, c]));
  const itens = [];
  for (const p of proposta.itens || []) {
    const cat = porCodigo.get(p.codigo);
    const qtd = Number(p.quantidade);
    if (!cat || !(qtd > 0)) continue;
    itens.push({
      codigo: cat.codigo,
      descricao: cat.descricao,
      unidade: cat.unidade,
      quantidade: arred(qtd),
      valorUnitario: cat.valor,
      total: arred(cat.valor * qtd),
      observacao: p.observacao || "",
    });
  }
  return recalcularTotais(
    {
      itens,
      descontoPercentual: Math.min(Math.max(Number(proposta.descontoPercentual) || 0, 0), cfg.descontoMaximoPercentual),
      resumo: proposta.resumo || "",
      justificativa: proposta.justificativa || "",
      pontosDeAtencao: proposta.pontosDeAtencao || [],
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
  const texto = [
    orc.briefing?.resumo,
    orc.evento && Object.values(orc.evento).join(" "),
    ...(orc.briefing?.respostas || []).map((r) => `${r.pergunta} ${r.resposta}`),
    ...(orc.conversa || []).filter((m) => m.de === "cliente").map((m) => m.texto),
    ...(orc.revisoes || []).map((r) => r.comentario),
  ].join(" \n ").toLowerCase();

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
  if (/\bkm\b|desloc|perman[eê]ncia|retoque/.test(texto)) pontos.push("Deslocamento e permanência não estão na tabela de preços: combine à parte, se for o caso.");

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
