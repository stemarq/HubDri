// IA do hub: lê o briefing + fotos da conversa e propõe itens/quantidades do catálogo.
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { UPLOADS_DIR } from "./store.js";
import { env } from "./config.js";

const MODELO = "claude-opus-5-5";
const MAX_IMAGENS = 6;
const TIPOS_IMAGEM = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

let cliente;
function claude() {
  cliente ??= new Anthropic();
  return cliente;
}

export const iaDisponivel = () =>
  !env.iaDesativada && Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

function schema(codigos) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["itens", "descontoPercentual", "resumo", "justificativa", "pontosDeAtencao"],
    properties: {
      itens: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["codigo", "quantidade", "observacao"],
          properties: {
            codigo: { type: "string", enum: codigos },
            quantidade: { type: "number" },
            observacao: { type: "string" },
          },
        },
      },
      descontoPercentual: { type: "number" },
      resumo: { type: "string", description: "Resumo do pedido da cliente em 2-4 frases, para o PDF." },
      justificativa: { type: "string", description: "Como as quantidades foram estimadas." },
      pontosDeAtencao: { type: "array", items: { type: "string" } },
    },
  };
}

function blocosImagem(orc) {
  const blocos = [];
  for (const img of (orc.imagens || []).slice(0, MAX_IMAGENS)) {
    if (!TIPOS_IMAGEM.has(img.mimeType)) continue;
    try {
      const data = fs.readFileSync(path.join(UPLOADS_DIR, img.arquivo)).toString("base64");
      blocos.push({ type: "image", source: { type: "base64", media_type: img.mimeType, data } });
    } catch {
      /* imagem ausente no disco: ignora */
    }
  }
  return blocos;
}

export async function proporOrcamento(orc, cfg, pedidoDeMudanca) {
  const catalogo = cfg.catalogo
    .map((c) => `- ${c.codigo}: ${c.descricao} (${c.unidade}) R$ ${c.valor}`)
    .join("\n");

  const system = [
    `Você é o orçamentista da empresa ${cfg.empresa.nome}.`,
    "Recebe os dados que uma IA de atendimento coletou no WhatsApp e monta a proposta de orçamento.",
    cfg.instrucoesCalculo,
    `Desconto máximo permitido: ${cfg.descontoMaximoPercentual}%. Use desconto 0 salvo pedido explícito.`,
    "Não faça contas de valores: informe apenas códigos e quantidades; o sistema calcula os totais.",
    "Os serviços são de maquiagem profissional. Escreva em português do Brasil, num tom acolhedor.",
    `Catálogo:\n${catalogo}`,
  ].join("\n\n");

  const dados = {
    cliente: orc.cliente,
    evento: orc.evento,
    briefing: orc.briefing,
    conversa: orc.conversa,
    calculoAnterior: pedidoDeMudanca ? orc.calculo?.itens : undefined,
  };
  let texto = `Dados do atendimento:\n${JSON.stringify(dados, null, 2)}`;
  if (pedidoDeMudanca) texto += `\n\nA equipe pediu as seguintes mudanças no orçamento anterior:\n${pedidoDeMudanca}`;

  const resp = await claude().beta.messages.create({
    model: MODELO,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: { type: "json_schema", schema: schema(cfg.catalogo.map((c) => c.codigo)) } },
    system,
    messages: [{ role: "user", content: [...blocosImagem(orc), { type: "text", text: texto }] }],
  });

  if (resp.stop_reason === "refusal") throw new Error("A IA recusou o pedido.");
  if (resp.stop_reason === "max_tokens") throw new Error("Resposta da IA truncada.");
  const bloco = resp.content.find((b) => b.type === "text");
  if (!bloco) throw new Error("Resposta da IA sem conteúdo.");
  return JSON.parse(bloco.text);
}
