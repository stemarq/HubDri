// Histórico de conversas por pessoa: nome, @usuário/telefone, canal, primeiro contato, todas as mensagens, exportação e edição pela Adriana.
import { Ctx } from '../context.js';
import { all, one, parse, run } from '../db.js';
import { saveMemory, getMemory } from './memory.js';

const SELECT = 'SELECT c.*, u.name, u.wa_id, u.handle, u.notes, u.created_at AS customer_since FROM conversations c JOIN customers u ON u.id=c.customer_id';

export const phoneOf = (waId: string): string | null => (/^\d{10,15}$/.test(waId) ? waId : null);

function summary(ctx: Ctx, c: any) {
  const last = one(ctx.db, 'SELECT body,direction,type,author,created_at FROM messages WHERE conversation_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1', c.id);
  const q = one(ctx.db, 'SELECT id,status,hub_id,hub_code FROM quotes WHERE conversation_id=? ORDER BY created_at DESC LIMIT 1', c.id);
  const count = one(ctx.db, 'SELECT COUNT(*) n FROM messages WHERE conversation_id=?', c.id)?.n ?? 0;
  const erased = String(c.wa_id).startsWith('erased:');
  return {
    id: c.id, channel: c.channel, mode: c.mode, updatedAt: c.updated_at,
    customer: { id: c.customer_id, name: erased ? null : c.name, waId: c.wa_id, handle: c.handle ?? null, phone: phoneOf(c.wa_id), notes: c.notes ?? null, since: c.customer_since, erased },
    messageCount: count,
    lastMessage: last ? { body: last.body, direction: last.direction, type: last.type, author: last.author, at: last.created_at } : null,
    latestQuote: q ? { id: q.id, status: q.status, hubId: q.hub_id ?? null, hubCode: q.hub_code ?? null } : null,
  };
}

/** Lista conversas; `q` filtra por nome, @usuário, telefone ou texto de qualquer mensagem. */
export function listConversations(ctx: Ctx, q?: string) {
  const term = q?.trim();
  const rows = term
    ? all(ctx.db, `${SELECT} WHERE u.name LIKE ? OR u.handle LIKE ? OR u.wa_id LIKE ? OR c.id IN (SELECT conversation_id FROM messages WHERE body LIKE ?) ORDER BY c.updated_at DESC`, `%${term}%`, `%${term}%`, `%${term}%`, `%${term}%`)
    : all(ctx.db, `${SELECT} ORDER BY c.updated_at DESC`);
  return rows.map((c) => summary(ctx, c));
}

export function conversationDetail(ctx: Ctx, id: string) {
  const c = one(ctx.db, `${SELECT} WHERE c.id=?`, id);
  if (!c) return undefined;
  const st = parse<any>(c.state, {});
  return {
    ...summary(ctx, c), collected: st.slots ?? null, awaiting: st.awaiting ?? null,
    messages: all(ctx.db, 'SELECT id,direction,type,body,author,status,error,created_at FROM messages WHERE conversation_id=? ORDER BY created_at, rowid', id)
      .map((m) => ({ id: m.id, direction: m.direction, type: m.type, body: m.body, author: m.author, status: m.status, error: m.error, at: m.created_at })),
    quotes: all(ctx.db, 'SELECT id FROM quotes WHERE conversation_id=? ORDER BY created_at DESC', id).map((r) => r.id),
  };
}

const AUTOR: Record<string, string> = { CUSTOMER: 'Cliente', ADRI: 'ADRI', ADRIANA: 'Adriana' };

/** Transcrição completa (texto ou JSON) para guardar ou enviar. */
export function exportTranscript(ctx: Ctx, id: string, format: 'txt' | 'json') {
  const d = conversationDetail(ctx, id);
  if (!d) return undefined;
  if (format === 'json') return { type: 'application/json', body: JSON.stringify(d, null, 2), filename: `conversa-${id.slice(0, 8)}.json` };
  const fmt = (ms: number) => new Date(ms).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const head = [`Conversa com ${d.customer.name ?? d.customer.handle ?? d.customer.waId}`, `Canal: ${d.channel}${d.customer.handle ? ` · ${d.customer.handle}` : ''}${d.customer.phone ? ` · +${d.customer.phone}` : ''}`,
    `Primeiro contato: ${fmt(d.customer.since)} · ${d.messageCount} mensagens`, ''];
  const lines = d.messages.map((m) => `[${fmt(m.at)}] ${m.direction === 'IN' ? 'Cliente' : AUTOR[m.author ?? 'ADRI'] ?? m.author}${m.type !== 'text' ? ` (${m.type})` : ''}: ${m.body ?? ''}${m.status === 'FAILED' || m.status === 'BLOCKED_WINDOW' ? '  [NÃO ENTREGUE]' : ''}`);
  return { type: 'text/plain; charset=utf-8', body: [...head, ...lines].join('\n') + '\n', filename: `conversa-${id.slice(0, 8)}.txt` };
}

/** A Adriana pode corrigir o nome e anotar observações sobre a pessoa. */
export function updateCustomer(ctx: Ctx, customerId: string, p: { name?: string | null; notes?: string | null }) {
  if (!one(ctx.db, 'SELECT id FROM customers WHERE id=?', customerId)) return false;
  if (p.name !== undefined) {
    run(ctx.db, 'UPDATE customers SET name=? WHERE id=?', p.name?.trim() || null, customerId);
    const m = getMemory(ctx, customerId);
    m.firstName = p.name?.trim().split(/\s+/)[0] || undefined;
    saveMemory(ctx, customerId, m);
  }
  if (p.notes !== undefined) run(ctx.db, 'UPDATE customers SET notes=? WHERE id=?', p.notes?.trim() || null, customerId);
  return true;
}
