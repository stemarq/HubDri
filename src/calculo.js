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
  const extras = num(/(\d+)\s*(?:pessoas|madrinhas|convidadas|maquiagens|amigas|mulheres)/);
  const km = num(/(\d+(?:[.,]\d+)?)\s*km/);
  const hora = num(/\b(?:às|as|a partir das)?\s*([0-6])\s*(?:h|horas?)\b(?!\s*de perman)/);
  const permanencia = num(/(\d+)\s*h(?:oras?)?\s*de perman/);
  const penteado = /penteado|cabelo/.test(texto);
  const cilios = /c[ií]lios/.test(texto);

  // "pra mim e mais 2" = a própria cliente + 2 (se ela for a noiva, já entra como noiva)
  const maisN = num(/(?:mim|eu)\s+e\s+(?:mais\s+)?(?:pra\s+|para\s+)?(\d+)/);
  const pessoasSociais = maisN != null ? maisN + (noiva ? 0 : 1) : extras ?? (noiva ? 0 : 1);
  const totalPessoas = pessoasSociais + (noiva ? 1 : 0);
  const itens = [];
  if (noiva) {
    itens.push({ codigo: "MAKE-NOIVA", quantidade: 1 });
    itens.push({ codigo: "TESTE-NOIVA", quantidade: 1 });
  }
  if (pessoasSociais > 0) itens.push({ codigo: "MAKE-SOCIAL", quantidade: pessoasSociais });
  if (penteado) itens.push({ codigo: "PENTEADO", quantidade: totalPessoas });
  if (cilios) itens.push({ codigo: "CILIOS", quantidade: totalPessoas });
  if (hora != null && hora < 7) itens.push({ codigo: "MADRUGADA", quantidade: 1, observacao: `início às ${hora}h` });
  if (permanencia) itens.push({ codigo: "PERMANENCIA", quantidade: permanencia });
  if (km && km > 15) itens.push({ codigo: "DESL", quantidade: km * 2, observacao: `${km} km, ida e volta` });

  const pontos = ["Calculado por regras automáticas (IA indisponível). Revise antes de aprovar."];
  if (extras == null && !noiva) pontos.push("Número de pessoas não informado: considerada 1 pessoa.");
  if (penteado || cilios) pontos.push("Penteado/cílios aplicados a todas as pessoas — confirme quem quer.");

  return {
    itens,
    descontoPercentual: 0,
    resumo:
      orc.briefing?.resumo ||
      (orc.briefing?.respostas || []).map((r) => `${r.pergunta}: ${r.resposta}`).join(" · "),
    justificativa: `${noiva ? "Noiva + " : ""}${pessoasSociais} maquiagem(ns) social(is)${penteado ? ", com penteado" : ""}${cilios ? ", com cílios" : ""}.`,
    pontosDeAtencao: pontos,
  };
}
