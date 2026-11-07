// Retorno do hub para a IA do WhatsApp.
import { env } from "./config.js";
import { agora, saidaWhatsapp, salvar } from "./store.js";

export async function enviarParaWhatsapp(evento, payload) {
  const corpo = { evento, enviadoEm: agora(), ...payload };

  // Sem URL configurada: grava na caixa de saída simulada (visível no hub).
  if (!env.callbackUrl) {
    saidaWhatsapp().unshift({ ...corpo, simulado: true });
    salvar();
    return { ok: true, simulado: true };
  }

  const resp = await fetch(env.callbackUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(env.callbackToken ? { "x-hub-token": env.callbackToken } : {}),
    },
    body: JSON.stringify(corpo),
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`IA do WhatsApp respondeu HTTP ${resp.status}`);
  return { ok: true, simulado: false };
}
