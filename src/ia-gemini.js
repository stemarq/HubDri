// Provedor Gemini (Google AI Studio / Gemini API), via SDK oficial @google/genai.
import { GoogleGenAI } from "@google/genai";

export const nome = "Gemini";
// Formatos de imagem aceitos pelo Gemini (GIF não entra).
export const TIPOS_IMAGEM = new Set(["image/jpeg", "image/png", "image/webp"]);
const TEMPO_LIMITE_MS = 60_000;
// Erros passageiros do lado do Google (limite de uso, sobrecarga): vale tentar de novo.
const TEMPORARIOS = new Set([429, 500, 503, 504]);
const ESPERAS_MS = [0, 3_000]; // tentativas no modelo principal
const ESPERA_RESERVA_MS = 2_000;

export const configurado = () => Boolean(process.env.GEMINI_API_KEY);
export const modelo = () => process.env.GEMINI_MODEL || "gemini-3.6-flash";
// Usado quando o principal continua sobrecarregado. "nenhum" desliga.
const modeloReserva = () => process.env.GEMINI_MODELO_RESERVA || "gemini-3.5-flash-lite";

let cliente;
function gemini() {
  cliente ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return cliente;
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function erroLegivel(e) {
  const s = e?.status;
  if (s === 400) return new Error("O Gemini recusou o pedido (HTTP 400). Confira GEMINI_MODEL.");
  if (s === 401 || s === 403) return new Error(`Chave do Gemini inválida ou sem permissão (HTTP ${s}).`);
  if (s === 404) return new Error(`Modelo do Gemini não encontrado (HTTP 404). Confira GEMINI_MODEL.`);
  if (s === 429) return new Error("Limite de uso do Gemini atingido (HTTP 429).");
  if (s >= 500) return new Error(`Gemini indisponível no momento (HTTP ${s}).`);
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return new Error("O Gemini demorou demais para responder.");
  return e;
}

async function chamar(nomeModelo, { sistema, texto, imagens, schema }) {
  const resp = await gemini().models.generateContent({
    model: nomeModelo,
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

// Devolve o texto JSON da resposta (validado depois em ia.js).
export async function gerar(pedido) {
  let ultimo;
  for (const espera of ESPERAS_MS) {
    await esperar(espera);
    try {
      return await chamar(modelo(), pedido);
    } catch (e) {
      ultimo = e;
      if (!TEMPORARIOS.has(e?.status)) throw erroLegivel(e);
    }
  }
  const reserva = modeloReserva();
  if (reserva !== "nenhum" && reserva !== modelo()) {
    console.warn(`Gemini: ${modelo()} indisponível (HTTP ${ultimo?.status}); tentando ${reserva}.`);
    await esperar(ESPERA_RESERVA_MS);
    try {
      return await chamar(reserva, pedido);
    } catch (e) {
      ultimo = e;
    }
  }
  throw erroLegivel(ultimo);
}
