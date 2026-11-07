import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export type DB = DatabaseSync;
export const uid = () => randomUUID();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS customers (id TEXT PRIMARY KEY, wa_id TEXT UNIQUE NOT NULL, name TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id), channel TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'AI', state TEXT NOT NULL DEFAULT '{}', last_inbound_at INTEGER,
  request_started_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), direction TEXT NOT NULL,
  wa_message_id TEXT UNIQUE, idem_key TEXT UNIQUE, type TEXT NOT NULL, body TEXT, media_path TEXT,
  status TEXT NOT NULL, error TEXT, attempts INTEGER NOT NULL DEFAULT 0, author TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, created_at);
CREATE TABLE IF NOT EXISTS services (code TEXT PRIMARY KEY, name TEXT NOT NULL, duration_min INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS pricing_rules (service_code TEXT NOT NULL, day_type TEXT NOT NULL, amount_cents INTEGER NOT NULL, PRIMARY KEY(service_code, day_type));
CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY, number INTEGER NOT NULL, conversation_id TEXT NOT NULL, customer_id TEXT NOT NULL,
  service_code TEXT, status TEXT NOT NULL, event TEXT NOT NULL, schedule TEXT NOT NULL, availability TEXT NOT NULL,
  total_cents INTEGER NOT NULL DEFAULT 0, review_reasons TEXT NOT NULL DEFAULT '[]', pdf_path TEXT, notes TEXT,
  valid_until TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, approved_at INTEGER, sent_at INTEGER,
  accepted_at INTEGER, lost_at INTEGER, lost_reason TEXT, elaboration_ms INTEGER, client_signal TEXT);
CREATE TABLE IF NOT EXISTS quote_items (id TEXT PRIMARY KEY, quote_id TEXT NOT NULL REFERENCES quotes(id), kind TEXT NOT NULL, label TEXT NOT NULL, amount_cents INTEGER NOT NULL, position INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY, quote_id TEXT, customer_id TEXT, start_ts INTEGER NOT NULL, end_ts INTEGER NOT NULL,
  block_start_ts INTEGER NOT NULL, block_end_ts INTEGER NOT NULL, address TEXT, status TEXT NOT NULL,
  calendar_event_id TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS transportation_estimates (
  id TEXT PRIMARY KEY, quote_id TEXT, leg TEXT NOT NULL, origin TEXT NOT NULL, destination TEXT NOT NULL, depart_ts INTEGER NOT NULL,
  distance_m INTEGER, duration_s INTEGER, predicted_cents INTEGER, formula_cents INTEGER, confidence TEXT, source TEXT,
  simulated INTEGER NOT NULL DEFAULT 0, breakdown TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS transportation_history (
  id TEXT PRIMARY KEY, estimate_id TEXT, trip_date TEXT NOT NULL, leg TEXT, origin TEXT NOT NULL, destination TEXT NOT NULL,
  dest_key TEXT, distance_m INTEGER, depart_minutes INTEGER NOT NULL, weekday INTEGER, holiday INTEGER NOT NULL DEFAULT 0, weather TEXT,
  formula_cents INTEGER, predicted_cents INTEGER, actual_cents INTEGER, discount_cents INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS approval_history (id TEXT PRIMARY KEY, quote_id TEXT NOT NULL, action TEXT NOT NULL, actor TEXT, before TEXT, after TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS business_events (id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_events_type ON business_events(type, created_at);
CREATE TABLE IF NOT EXISTS business_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS customer_memory (customer_id TEXT PRIMARY KEY REFERENCES customers(id), data TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS agent_failures (id TEXT PRIMARY KEY, conversation_id TEXT, category TEXT NOT NULL, message TEXT, detail TEXT, status TEXT NOT NULL, regression_ref TEXT, note TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS message_ratings (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, score INTEGER NOT NULL, comment TEXT, actor TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS calendar_events (id TEXT PRIMARY KEY, title TEXT NOT NULL, start_ts INTEGER NOT NULL, end_ts INTEGER NOT NULL, created_at INTEGER NOT NULL);
`;

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  for (const col of ['hub_id TEXT', 'hub_code TEXT', 'hub_status TEXT']) { try { db.exec(`ALTER TABLE quotes ADD COLUMN ${col}`); } catch { /* já existe */ } }
  seedServices(db);
  return db;
}

/** Serviços e durações padrão (editáveis em PUT /api/settings/pricing). NÃO inclui preços. */
function seedServices(db: DB) {
  const rows: [string, string, number][] = [
    ['MAKEUP', 'Maquiagem', 60], ['HAIR', 'Penteado', 60],
    ['MAKEUP_HAIR', 'Maquiagem e penteado', 120], ['BRIDE_PACKAGE', 'Pacote de noiva', 180],
  ];
  const st = db.prepare('INSERT OR IGNORE INTO services (code,name,duration_min,active) VALUES (?,?,?,1)');
  rows.forEach((r) => st.run(...r));
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
export const j = (v: unknown) => JSON.stringify(v);
export const parse = <T>(s: string | null | undefined, d: T): T => { try { return s ? (JSON.parse(s) as T) : d; } catch { return d; } };
export type Row = Record<string, any>;
export const one = (db: DB, sql: string, ...p: any[]) => db.prepare(sql).get(...p) as Row | undefined;
export const all = (db: DB, sql: string, ...p: any[]) => db.prepare(sql).all(...p) as Row[];
export const run = (db: DB, sql: string, ...p: any[]) => db.prepare(sql).run(...p);
