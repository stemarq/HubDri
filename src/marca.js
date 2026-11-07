// Fotos do trabalho da Dri usadas no PDF (portfólio). Têm clientes, então NÃO vão para o repositório público:
// ficam no Storage do Supabase (pasta marca/ do bucket das imagens) e, sem Supabase, em data/marca/.
// Nome do arquivo = grupo + "--" + número. Grupos: geral (apresentação) ou o código do serviço (MAKE-EXPRESS, PENT...).
// Enviar/atualizar: coloque as fotos em data/marca/ e rode `npm run marca:enviar`.
import fs from "node:fs";
import path from "node:path";
import * as store from "./store.js";

const PASTA_LOCAL = path.resolve("data", "marca");
const PREFIXO = "marca";
const VALIDADE_LISTA = 10 * 60 * 1000;
let cache = { em: 0, nomes: [] };

const ehFoto = (n) => /\.(jpe?g|png)$/i.test(n);
const grupoDe = (nome) => nome.split("--")[0];

async function listar() {
  if (store.supabase) {
    if (Date.now() - cache.em < VALIDADE_LISTA) return cache.nomes;
    const { data, error } = await store.supabase.storage.from(store.BUCKET_IMAGENS).list(PREFIXO, { limit: 200, sortBy: { column: "name", order: "asc" } });
    if (error) throw new Error(`Storage (fotos da marca): ${error.message}`);
    cache = { em: Date.now(), nomes: data.map((f) => f.name).filter(ehFoto) };
    return cache.nomes;
  }
  try { return fs.readdirSync(PASTA_LOCAL).filter(ehFoto).sort(); } catch { return []; }
}

// Serviço do orçamento → grupo de fotos (noiva e debutante usam as fotos de make/penteado equivalentes).
export function grupoDoServico(codigo) {
  if (/CACHEADO/.test(codigo)) return "PENT-CACHEADO";
  if (/PENT/.test(codigo)) return "PENT";
  if (/INFANTIL/.test(codigo)) return "MAKE-INFANTIL";
  if (/EXPRESS/.test(codigo)) return "MAKE-EXPRESS";
  if (/MAKE/.test(codigo)) return "MAKE-VISAGISTA";
  return null;
}

/**
 * Escolhe as fotos do PDF e garante que estejam em disco.
 * Devolve { apresentacao: [caminhos], portfolio: [caminhos] }: primeiro as fotos dos serviços do orçamento,
 * completando com as demais até `max`.
 */
export async function fotosParaPdf(orc, { max = 6 } = {}) {
  let nomes;
  try { nomes = await listar(); } catch (e) { console.warn(e.message); return { apresentacao: [], portfolio: [] }; }

  const porGrupo = new Map();
  for (const n of nomes) porGrupo.set(grupoDe(n), [...(porGrupo.get(grupoDe(n)) || []), n]);

  const grupos = [...new Set((orc.calculo?.itens || []).map((i) => grupoDoServico(i.codigo)).filter(Boolean))];
  const escolhidas = [];
  // Alterna entre os serviços do orçamento para todos aparecerem.
  for (let rodada = 0; escolhidas.length < max; rodada++) {
    const daRodada = grupos.map((g) => porGrupo.get(g)?.[rodada]).filter(Boolean);
    if (!daRodada.length) break;
    escolhidas.push(...daRodada.slice(0, max - escolhidas.length));
  }
  for (const n of nomes) {
    if (escolhidas.length >= max) break;
    if (grupoDe(n) !== "geral" && !escolhidas.includes(n)) escolhidas.push(n);
  }
  const apresentacao = (porGrupo.get("geral") || []).slice(0, 2);

  const caminho = async (n) => {
    if (!store.supabase) return path.join(PASTA_LOCAL, n);
    try { return await store.garantirArquivo(`${PREFIXO}/${n}`); } catch (e) { console.warn(e.message); return null; }
  };
  const resolver = async (lista) => (await Promise.all(lista.map(caminho))).filter(Boolean);
  return { apresentacao: await resolver(apresentacao), portfolio: await resolver(escolhidas) };
}
