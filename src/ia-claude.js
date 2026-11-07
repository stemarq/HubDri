// Provedor Claude (Anthropic), via SDK oficial @anthropic-ai/sdk.
import Anthropic from "@anthropic-ai/sdk";

export const nome = "Claude";
export const TIPOS_IMAGEM = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export const configurado = () => Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
export const modelo = () => "claude-opus-5-5";

let cliente;
function claude() {
  cliente ??= new Anthropic();
  return cliente;
}

// O formato estruturado do Claude não aceita limites numéricos; o servidor já os aplica.
const semLimites = (no) =>
  Array.isArray(no) ? no.map(semLimites)
    : no && typeof no === "object"
      ? Object.fromEntries(Object.entries(no).filter(([k]) => k !== "minimum" && k !== "maximum").map(([k, v]) => [k, semLimites(v)]))
      : no;

// Devolve o texto JSON da resposta (validado depois em ia.js).
export async function gerar({ sistema, texto, imagens, schema }) {
  const resp = await claude().beta.messages.create({
    model: modelo(),
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: { type: "json_schema", schema: semLimites(schema) } },
    system: sistema,
    messages: [{
      role: "user",
      content: [
        ...imagens.map((i) => ({ type: "image", source: { type: "base64", media_type: i.mimeType, data: i.base64 } })),
        { type: "text", text: texto },
      ],
    }],
  });

  if (resp.stop_reason === "refusal") throw new Error("A IA recusou o pedido.");
  if (resp.stop_reason === "max_tokens") throw new Error("Resposta da IA truncada.");
  const bloco = resp.content.find((b) => b.type === "text");
  if (!bloco) throw new Error("Resposta da IA sem conteúdo.");
  return bloco.text;
}
