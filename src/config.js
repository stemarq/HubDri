import fs from "node:fs";
import path from "node:path";

const arquivo = path.resolve("config", "hub.config.json");

// Com Supabase, a tabela de preços e as configurações vêm do banco (carregadas ao iniciar e a cada
// gravação, ver config-banco.js). Sem banco: arquivo base + data/config-editada.json, relidos a cada uso.
let doBanco = null;
export const definirConfigDoBanco = (c) => { doBanco = c; };
export const configDoArquivo = () => JSON.parse(fs.readFileSync(arquivo, "utf8"));

export function config() {
  const base = configDoArquivo();
  if (doBanco) return { ...base, ...doBanco, empresa: { ...base.empresa, ...(doBanco.empresa || {}) }, apresentacao: { ...base.apresentacao, ...(doBanco.apresentacao || {}) } };
  // Edições feitas no app (aba Configurações) ficam em data/config-editada.json, fora do Git, e valem sobre o arquivo base.
  try {
    const editada = JSON.parse(fs.readFileSync(arquivoEditado, "utf8"));
    return { ...base, ...editada, empresa: { ...base.empresa, ...(editada.empresa || {}) } };
  } catch {
    return base;
  }
}
export const arquivoEditado = path.resolve("data", "config-editada.json");

export const env = {
  port: Number(process.env.PORT || 3000),
  publicUrl: (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, ""),
  webhookToken: process.env.HUB_WEBHOOK_TOKEN || "",
  callbackUrl: process.env.WHATSAPP_CALLBACK_URL || "",
  callbackToken: process.env.WHATSAPP_CALLBACK_TOKEN || "",
  hubPassword: process.env.HUB_PASSWORD || "",
  iaDesativada: process.env.IA_DESATIVADA === "1",
  producao: process.env.NODE_ENV === "production",
  demo: process.env.MODO_DEMO === "1", // apresentação: conversa de exemplo e botão de lead de teste, mesmo em produção
  supabaseUrl: process.env.SUPABASE_URL || "",
  supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
};
