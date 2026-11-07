import fs from "node:fs";
import path from "node:path";

const arquivo = path.resolve("config", "hub.config.json");

// Relido a cada uso: editar o catálogo não exige reiniciar o servidor.
export function config() {
  return JSON.parse(fs.readFileSync(arquivo, "utf8"));
}

export const env = {
  port: Number(process.env.PORT || 3000),
  publicUrl: (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, ""),
  webhookToken: process.env.HUB_WEBHOOK_TOKEN || "",
  callbackUrl: process.env.WHATSAPP_CALLBACK_URL || "",
  callbackToken: process.env.WHATSAPP_CALLBACK_TOKEN || "",
  hubPassword: process.env.HUB_PASSWORD || "",
  iaDesativada: process.env.IA_DESATIVADA === "1",
  producao: process.env.NODE_ENV === "production",
};
