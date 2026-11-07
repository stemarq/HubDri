// Armazenamento em arquivo JSON (suficiente para o MVP, processo único).
// Trocar por um banco (Postgres/SQLite) quando houver mais de uma instância.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const DATA_DIR = path.resolve("data");
export const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const DB_FILE = path.join(DATA_DIR, "db.json");

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const vazio = () => ({ seq: 0, orcamentos: [], notificacoes: [], saidaWhatsapp: [] });

let db = carregar();

function carregar() {
  try {
    return { ...vazio(), ...JSON.parse(fs.readFileSync(DB_FILE, "utf8")) };
  } catch {
    return vazio();
  }
}

export function salvar() {
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

export const agora = () => new Date().toISOString();
export const novoId = () => crypto.randomUUID();

export function proximoCodigo() {
  db.seq += 1;
  return "ORC-" + String(db.seq).padStart(4, "0");
}

export const orcamentos = () => db.orcamentos;
export const notificacoes = () => db.notificacoes;
export const saidaWhatsapp = () => db.saidaWhatsapp;

export function acharOrcamento(id) {
  return db.orcamentos.find((o) => o.id === id || o.codigo === id);
}

export function acharPorToken(token) {
  return db.orcamentos.find((o) => o.tokenPublico === token);
}

export function notificar({ tipo, titulo, texto, orcamentoId }) {
  db.notificacoes.unshift({ id: novoId(), tipo, titulo, texto, orcamentoId, lida: false, em: agora() });
  db.notificacoes = db.notificacoes.slice(0, 300);
  salvar();
}
