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
  if (!resp.ok) {
    if (resp.status === 404) throw new Error("A ADRI não reconhece este orçamento (HTTP 404). Ele não veio de uma conversa deste agente, por exemplo um lead de teste. Aprove orçamentos que nasceram numa conversa real do Telegram ou WhatsApp.");
    if (resp.status === 401) throw new Error("A ADRI recusou o envio (HTTP 401): WHATSAPP_CALLBACK_TOKEN do hub precisa ser igual ao HUB_CALLBACK_TOKEN do agente.");
    throw new Error("A ADRI respondeu HTTP " + resp.status);
  }
  return { ok: true, simulado: false };
}
