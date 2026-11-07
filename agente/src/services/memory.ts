// Memória por cliente com minimização de dados (LGPD): nome e preferências de serviço ficam; endereço só com consentimento;
// apagamento a pedido remove PII de mensagens, memória e orçamentos (mantendo apenas totais comerciais anônimos).
import { Ctx } from '../context.js';
import { all, j, one, parse, run, uid } from '../db.js';

export interface CustomerMemory { firstName?: string; services: Record<string, number>; lastNeighborhood?: string; savedAddress?: string; addressConsent: boolean; visits: number }
const empty = (): CustomerMemory => ({ services: {}, addressConsent: false, visits: 0 });

export function getMemory(ctx: Ctx, customerId: string): CustomerMemory {
  const r = one(ctx.db, 'SELECT data FROM customer_memory WHERE customer_id=?', customerId);
  return { ...empty(), ...parse<Partial<CustomerMemory>>(r?.data, {}) };
}
export function saveMemory(ctx: Ctx, customerId: string, m: CustomerMemory) {
  run(ctx.db, 'INSERT INTO customer_memory(customer_id,data,updated_at) VALUES(?,?,?) ON CONFLICT(customer_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at', customerId, j(m), ctx.now().getTime());
}

export function remember(ctx: Ctx, customerId: string, s: { name?: string; service?: string; neighborhood?: string; address?: string }) {
  const m = getMemory(ctx, customerId);
  if (s.name) m.firstName = s.name.split(/\s+/)[0];
  if (s.service) m.services[s.service] = (m.services[s.service] ?? 0) + 1;
  if (s.neighborhood) m.lastNeighborhood = s.neighborhood;
  if (m.addressConsent && s.address) m.savedAddress = s.address;   // só com consentimento explícito
  m.visits += 1;
  saveMemory(ctx, customerId, m);
  return m;
}
export function setAddressConsent(ctx: Ctx, customerId: string, consent: boolean, address?: string) {
  const m = getMemory(ctx, customerId);
  m.addressConsent = consent;
  m.savedAddress = consent ? address ?? m.savedAddress : undefined;
  saveMemory(ctx, customerId, m);
}

/** Direito de apagamento. Mantém só o necessário para contabilidade (valores e datas dos orçamentos), sem identificar a pessoa. */
export function eraseCustomerData(ctx: Ctx, customerId: string) {
  const convs = all(ctx.db, 'SELECT id FROM conversations WHERE customer_id=?', customerId).map((r) => r.id as string);
  for (const id of convs) {
    run(ctx.db, "UPDATE messages SET body='[removido a pedido da titular]', media_path=NULL WHERE conversation_id=?", id);
    run(ctx.db, "UPDATE conversations SET state='{}', mode='AI', updated_at=? WHERE id=?", ctx.now().getTime(), id);
  }
  for (const q of all(ctx.db, 'SELECT id, event FROM quotes WHERE customer_id=?', customerId)) {
    const ev = parse<Record<string, unknown>>(q.event, {});
    run(ctx.db, 'UPDATE quotes SET event=? WHERE id=?', j({ eventType: ev.eventType, date: ev.date, redacted: true }), q.id);
  }
  run(ctx.db, 'DELETE FROM customer_memory WHERE customer_id=?', customerId);
  run(ctx.db, 'UPDATE customers SET name=NULL, wa_id=? WHERE id=?', `erased:${uid()}`, customerId);
  ctx.events.emit('DATA_ERASED', { customerId });
}
