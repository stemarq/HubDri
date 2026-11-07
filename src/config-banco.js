// Tabela de preços (public.servicos) e configurações (public.configuracoes) no Supabase.
// Carregadas ao iniciar e mantidas em memória; config() as usa no lugar do arquivo.
// Sem Supabase (ou sem a migration aplicada), tudo continua vindo do arquivo.
import { configDoArquivo, definirConfigDoBanco } from "./config.js";
import { supabase as supa } from "./store.js";

const CHAVES_HUB = ["empresa", "validadeDias", "descontoMaximoPercentual", "atrasoHoras", "instrucoesCalculo"];
let ativo = false;
export const configNoBanco = () => ativo;

const num = (v) => (v === null || v === undefined ? null : Number(v));

const deLinha = (r) => ({
  codigo: r.codigo,
  descricao: r.descricao,
  unidade: r.unidade,
  valor: num(r.valor_studio),
  ...(r.valor_domicilio !== null && { valorDomicilio: num(r.valor_domicilio) }),
  ...(r.detalhe && { detalhe: r.detalhe }),
  ...(r.inclui?.length && { inclui: r.inclui }),
});

const paraLinha = (c, ordem, autorId) => ({
  codigo: c.codigo,
  descricao: c.descricao,
  unidade: c.unidade,
  valor_studio: c.valor,
  valor_domicilio: c.valorDomicilio ?? null,
  detalhe: c.detalhe ?? null,
  inclui: c.inclui ?? [],
  ordem,
  ativo: true,
  atualizado_por: autorId ?? null,
});

async function q(promessa, oque) {
  const { data, error } = await promessa;
  if (error) throw Object.assign(new Error(`Supabase (${oque}): ${error.message}`), { code: error.code });
  return data;
}

function aplicar(catalogo, hub) {
  definirConfigDoBanco({ ...hub, catalogo });
}

/** Lê do banco; na primeira vez, preenche a tabela com o catálogo do arquivo. */
export async function carregarConfigDoBanco() {
  if (!supa) return;
  try {
    let linhas = await q(supa.from("servicos").select("*").eq("ativo", true).order("ordem").order("codigo"), "ler tabela de preços");
    if (!linhas.length) {
      const base = configDoArquivo().catalogo;
      await q(supa.from("servicos").upsert(base.map((c, i) => paraLinha(c, i))), "preencher tabela de preços");
      linhas = await q(supa.from("servicos").select("*").eq("ativo", true).order("ordem").order("codigo"), "ler tabela de preços");
      console.log(`Tabela de preços criada no Supabase com ${linhas.length} serviços do arquivo.`);
    }
    const cfg = await q(supa.from("configuracoes").select("valor").eq("chave", "hub").maybeSingle(), "ler configurações");
    aplicar(linhas.map(deLinha), cfg?.valor || {});
    ativo = true;
  } catch (e) {
    // 42P01 = tabela não existe: migration 20261107200000 ainda não aplicada.
    console.warn(e.code === "42P01" || /does not exist|schema cache/i.test(e.message)
      ? "Tabela de preços ainda não existe no Supabase (aplique a migration 20261107200000_tabela_de_precos.sql). Usando o arquivo."
      : `Não deu para ler a tabela de preços do Supabase (${e.message}). Usando o arquivo.`);
  }
}

/** Grava as edições da aba Configurações no banco e atualiza a memória. */
export async function salvarConfigNoBanco(novo, autorId = null) {
  const linhas = novo.catalogo.map((c, i) => paraLinha(c, i, autorId));
  await q(supa.from("servicos").upsert(linhas), "salvar tabela de preços");
  // Itens removidos da tela ficam inativos (não apagados), para não perder o histórico de preços.
  const codigos = novo.catalogo.map((c) => c.codigo);
  await q(supa.from("servicos").update({ ativo: false, atualizado_por: autorId }).not("codigo", "in", `(${codigos.map((c) => `"${c}"`).join(",")})`).eq("ativo", true), "remover serviços");
  const hub = Object.fromEntries(CHAVES_HUB.map((k) => [k, novo[k]]));
  await q(supa.from("configuracoes").upsert({ chave: "hub", valor: hub, atualizado_por: autorId }), "salvar configurações");
  aplicar(novo.catalogo, hub);
}
