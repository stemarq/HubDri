// Provedor Gemini (Google AI Studio / Gemini API), via SDK oficial @google/genai.
import { GoogleGenAI } from "@google/genai";

export const nome = "Gemini";
// Formatos de imagem aceitos pelo Gemini (GIF não entra).
export const TIPOS_IMAGEM = new Set(["image/jpeg", "image/png", "image/webp"]);
const TEMPO_LIMITE_MS = 90_000;

export const configurado = () => Boolean(process.env.GEMINI_API_KEY);
export const modelo = () => process.env.GEMINI_MODEL || "gemini-3.6-flash";

let cliente;
function gemini() {
  cliente ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return cliente;
}

// Devolve o texto JSON da resposta (validado depois em ia.js).
export async function gerar({ sistema, texto, imagens, schema }) {
  const resp = await gemini().models.generateContent({
    model: modelo(),
    contents: [{
      role: "user",
      parts: [
        ...imagens.map((i) => ({ inlineData: { mimeType: i.mimeType, data: i.base64 } })),
        { text: texto },
      ],
    }],
    config: {
      systemInstruction: sistema,
      responseMimeType: "application/json",
      responseJsonSchema: schema,
      abortSignal: AbortSignal.timeout(TEMPO_LIMITE_MS),
    },
  });

  const bloqueio = resp.promptFeedback?.blockReason;
  if (bloqueio) throw new Error(`O Gemini bloqueou o pedido (${bloqueio}).`);
  const fim = resp.candidates?.[0]?.finishReason;
  if (fim === "MAX_TOKENS") throw new Error("Resposta do Gemini truncada.");
  if (fim && fim !== "STOP") throw new Error(`O Gemini interrompeu a resposta (${fim}).`);
  const json = resp.text;
  if (!json) throw new Error("Resposta do Gemini sem conteúdo.");
  return json;
}
