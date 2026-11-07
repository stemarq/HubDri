import { join } from 'node:path';
import { z } from 'zod';
import { Ctx } from '../context.js';
import { all, j, one, parse, run, tx, uid, Row } from '../db.js';
import { calculatePrice } from './pricing.js';
import { Plan, planVisit } from './planner.js';
import { QuotePdfData, renderQuoteHtml } from './pdf.js';
import { getSetting } from './settings.js';
import { addDays, epochToLocal, fmtTime, localToEpoch } from '../lib/time.js';
import { CalendarError } from './calendar.js';
import { SendResult } from './outbound.js';
import { ChannelError } from '../channels/types.js';
import { logger } from '../lib/logger.js';

export interface Slots {
  service?: string; role?: string; eventType?: string;
  date?: string; dateConfirmed?: boolean;
  readyMin?: number; eventStartMin?: number; desiredStartMin?: number;
  address?: string; addressFull?: boolean; neighborhood?: string;
  name?: string; inspirations: string[]; weather?: 'rain' | 'clear' | null;
}
export class QuoteError extends Error { constructor(public code: string, public status = 409, msg?: string) { super(msg ?? code); } }

export type Alternative =
  | { kind: 'earlier'; shiftMin: number; startMin: number; label: string }
  | { kind: 'date'; date: string; label: string };

export type BuildResult =
  | { kind: 'created'; quoteId: string; status: string }
  | { kind: 'conflict'; alternatives: Alternative[]; conflicts: { title: string; startEpoch: number; endEpoch: number }[] };

const destinationOf = (s: Slots) => (s.addressFull && s.address ? s.address : s.neighborhood ?? s.address ?? '');
const hm = (ms: number) => fmtTime(epochToLocal(ms).minutes);

async function planFor(ctx: Ctx, s: Slots, extra: { shiftEarlierMin?: number; date?: string } = {}): Promise<Plan> {
  return planVisit(ctx.db, ctx.transport, ctx.baseAddress(), {
    date: extra.date ?? s.date!, readyMin: s.readyMin, desiredStartMin: s.desiredStartMin, serviceCode: s.service!,
    destination: destinationOf(s), weather: s.weather ?? null, shiftEarlierMin: extra.shiftEarlierMin,
  });
}
/** Janela de bloqueio na agenda: saída -> retorno (se rota verificada) ou apenas chegada -> saída do local. */
const blockOf = (p: Plan) => (p.travelVerified ? [p.departureEpoch, p.returnArrivalEpoch] : [p.arrivalEpoch, p.returnDepartureEpoch]) as [number, number];

async function findAlternatives(ctx: Ctx, s: Slots): Promise<Alternative[]> {
  const out: Alternative[] = [];
  for (const shift of [30, 60, 90, 120]) {
    const p = await planFor(ctx, s, { shiftEarlierMin: shift });
    const [a, b] = blockOf(p);
    const av = await ctx.calendar.check(a, b);
    if (av.available) out.push({ kind: 'earlier', shiftMin: shift, startMin: epochToLocal(p.startEpoch).minutes, label: `atendimento começando às ${hm(p.startEpoch)} (você fica pronta às ${hm(p.endEpoch)})` });
    if (out.length >= 2) break;
  }
  for (let d = 1; d <= 7 && out.length < 3; d++) {
    const date = addDays(s.date!, d);
    const p = await planFor(ctx, s, { date });
    const [a, b] = blockOf(p);
    if ((await ctx.calendar.check(a, b)).available) out.push({ kind: 'date', date, label: `no dia ${date.split('-').reverse().slice(0, 2).join('/')} no mesmo horário` });
  }
  return out;
}

export async function buildQuote(ctx: Ctx, conv: Row, s: Slots): Promise<BuildResult> {
  const startedAt = ctx.now().getTime();
  const plan = await planFor(ctx, s);
  const [bStart, bEnd] = blockOf(plan);
  const av = await ctx.calendar.check(bStart, bEnd);
  if (av.verified && !av.available) {
    ctx.events.emit('AVAILABILITY_CONFLICT', { conversationId: conv.id, date: s.date, conflicts: av.conflicts.length });
    return { kind: 'conflict', alternatives: await findAlternatives(ctx, s), conflicts: av.conflicts };
  }

  const transportCents = plan.travelVerified && plan.outbound && plan.ret ? plan.outbound.predictedCents + plan.ret.predictedCents : null;
  const price = calculatePrice(ctx.db, { serviceCode: s.service!, startEpoch: plan.startEpoch, transportCents });
  const reasons: string[] = [...price.missing];
  if (!plan.travelVerified) reasons.push(`ROUTE_UNAVAILABLE:${plan.routeError ?? ''}`);
  if (!av.verified) reasons.push('CALENDAR_UNVERIFIED');
  if (!s.addressFull) reasons.push('ADDRESS_PARTIAL');

  const id = uid();
  const number = ((one(ctx.db, 'SELECT MAX(number) n FROM quotes')?.n as number | null) ?? 0) + 1;
  const branding = getSetting(ctx.db, 'branding');
  const validUntil = addDays(epochToLocal(ctx.now().getTime()).date, branding.validityDays);
  const now = ctx.now().getTime();
  const eventJson = { eventType: s.eventType, role: s.role, date: s.date, readyMin: s.readyMin, eventStartMin: s.eventStartMin, desiredStartMin: s.desiredStartMin,
    address: s.address, addressFull: !!s.addressFull, neighborhood: s.neighborhood, inspirations: s.inspirations, customerName: s.name };
  tx(ctx.db, () => {
    run(ctx.db, `INSERT INTO quotes(id,number,conversation_id,customer_id,service_code,status,event,schedule,availability,total_cents,review_reasons,valid_until,created_at,updated_at,elaboration_ms)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, number, conv.id, conv.customer_id, s.service, 'NEEDS_REVIEW', j(eventJson),
      j({ ...plan, outbound: undefined, ret: undefined }), j({ available: av.available, verified: av.verified, calendar: av.calendar, simulated: av.simulated }),
      price.totalCents, j(reasons), validUntil, now, now, now - (conv.request_started_at ?? startedAt));
    price.lines.forEach((l, i) => run(ctx.db, 'INSERT INTO quote_items(id,quote_id,kind,label,amount_cents,position) VALUES(?,?,?,?,?,?)', uid(), id, l.kind, l.label, l.amountCents, i));
    if (plan.outbound) ctx.transport.saveEstimate(id, plan.outbound);
    if (plan.ret) ctx.transport.saveEstimate(id, plan.ret);
  });
  ctx.events.emit('QUOTE_GENERATED', { quoteId: id, service: s.service, totalCents: price.totalCents });

  // PDF sempre que houver preço completo (inclusive como rascunho em revisão); sem preço não há o que mostrar.
  if (price.missing.length === 0) await finalizePdf(ctx, id);
  const q = one(ctx.db, 'SELECT status, review_reasons FROM quotes WHERE id=?', id)!;
  const finalReasons = parse<string[]>(q.review_reasons, []);
  const status = finalReasons.length ? 'NEEDS_REVIEW' : 'PENDING_APPROVAL';
  run(ctx.db, 'UPDATE quotes SET status=? WHERE id=?', status, id);
  if (status === 'NEEDS_REVIEW') ctx.events.emit('QUOTE_NEEDS_REVIEW', { quoteId: id, reasons: finalReasons });
  return { kind: 'created', quoteId: id, status };
}

/** Gera o PDF; falha vira motivo de revisão (nunca silenciosa). */
export async function finalizePdf(ctx: Ctx, quoteId: string): Promise<boolean> {
  const q = one(ctx.db, 'SELECT * FROM quotes WHERE id=?', quoteId)!;
  const sch = parse<Plan>(q.schedule, {} as Plan);
  const ev = parse<any>(q.event, {});
  const svc = one(ctx.db, 'SELECT name FROM services WHERE code=?', q.service_code);
  const cust = one(ctx.db, 'SELECT name FROM customers WHERE id=?', q.customer_id);
  const items = all(ctx.db, 'SELECT kind,label,amount_cents FROM quote_items WHERE quote_id=? ORDER BY position', quoteId).map((r) => ({ kind: r.kind, label: r.label, amountCents: r.amount_cents }));
  const est = one(ctx.db, 'SELECT simulated FROM transportation_estimates WHERE quote_id=? LIMIT 1', quoteId);
  const data: QuotePdfData = {
    number: q.number, customerName: ev.customerName ?? cust?.name ?? 'Cliente', serviceCode: q.service_code, serviceName: svc?.name ?? q.service_code,
    eventType: ev.eventType, role: ev.role, date: sch.date, startEpoch: sch.startEpoch, endEpoch: sch.endEpoch,
    address: ev.address ?? ev.neighborhood ?? '—', items, totalCents: q.total_cents, validUntil: q.valid_until, notes: q.notes ?? getSetting(ctx.db, 'branding').notes,
    branding: getSetting(ctx.db, 'branding'), simulatedTransport: !!est,
  };
  const out = join(ctx.pdfDir, `proposta-${String(q.number).padStart(4, '0')}-${quoteId.slice(0, 8)}.pdf`);
  const reasons = parse<string[]>(q.review_reasons, []).filter((r) => r !== 'PDF_UNAVAILABLE');
  try {
    await ctx.pdf.render(renderQuoteHtml(data), out);
    run(ctx.db, 'UPDATE quotes SET pdf_path=?, review_reasons=?, updated_at=? WHERE id=?', out, j(reasons), ctx.now().getTime(), quoteId);
    return true;
  } catch (e) {
    logger.error('pdf.failed', { quoteId, err: (e as Error).message });
    reasons.push('PDF_UNAVAILABLE');
    run(ctx.db, 'UPDATE quotes SET review_reasons=?, updated_at=? WHERE id=?', j(reasons), ctx.now().getTime(), quoteId);
    return false;
  }
}

// ---------- leitura ----------
export function quoteView(ctx: Ctx, id: string, withConversation = false) {
  const q = one(ctx.db, 'SELECT * FROM quotes WHERE id=?', id);
  if (!q) return undefined;
  const cust = one(ctx.db, 'SELECT id,wa_id,name FROM customers WHERE id=?', q.customer_id);
  const svc = one(ctx.db, 'SELECT name FROM services WHERE code=?', q.service_code);
  const view: Record<string, unknown> = {
    id: q.id, number: q.number, status: q.status, conversationId: q.conversation_id,
    customer: cust ? { id: cust.id, name: cust.name, waId: cust.wa_id } : null,
    service: { code: q.service_code, name: svc?.name }, event: parse(q.event, {}), schedule: parse(q.schedule, {}), availability: parse(q.availability, {}),
    items: all(ctx.db, 'SELECT kind,label,amount_cents FROM quote_items WHERE quote_id=? ORDER BY position', id).map((r) => ({ kind: r.kind, label: r.label, amountCents: r.amount_cents })),
    totalCents: q.total_cents, reviewReasons: parse(q.review_reasons, []), notes: q.notes, validUntil: q.valid_until,
    pdfAvailable: !!q.pdf_path, transport: all(ctx.db, 'SELECT id,leg,origin,destination,distance_m,duration_s,predicted_cents,confidence,source,simulated FROM transportation_estimates WHERE quote_id=?', id)
      .map((r) => ({ id: r.id, leg: r.leg, origin: r.origin, destination: r.destination, distanceM: r.distance_m, durationS: r.duration_s, predictedCents: r.predicted_cents, confidence: r.confidence, source: r.source, simulated: !!r.simulated })),
    createdAt: q.created_at, approvedAt: q.approved_at, sentAt: q.sent_at, acceptedAt: q.accepted_at, lostAt: q.lost_at, lostReason: q.lost_reason,
    clientSignal: q.client_signal, elaborationMs: q.elaboration_ms,
    history: all(ctx.db, 'SELECT action,actor,before,after,created_at FROM approval_history WHERE quote_id=? ORDER BY created_at', id)
      .map((r) => ({ action: r.action, actor: r.actor, before: parse(r.before, null), after: parse(r.after, null), at: r.created_at })),
  };
  if (withConversation) view.messages = all(ctx.db, 'SELECT direction,type,body,author,status,created_at FROM messages WHERE conversation_id=? ORDER BY created_at', q.conversation_id)
    .map((m) => ({ direction: m.direction, type: m.type, body: m.body, author: m.author, status: m.status, at: m.created_at }));
  return view;
}
export const listQuotes = (ctx: Ctx, status?: string) =>
  all(ctx.db, status ? 'SELECT id FROM quotes WHERE status=? ORDER BY created_at DESC' : 'SELECT id FROM quotes ORDER BY created_at DESC', ...(status ? [status] : [])).map((r) => quoteView(ctx, r.id)!);

// ---------- ações do hub ----------
const audit = (ctx: Ctx, quoteId: string, action: string, actor: string, before: unknown, after: unknown) =>
  run(ctx.db, 'INSERT INTO approval_history(id,quote_id,action,actor,before,after,created_at) VALUES(?,?,?,?,?,?,?)', uid(), quoteId, action, actor, j(before), j(after), ctx.now().getTime());
const getQ = (ctx: Ctx, id: string) => { const q = one(ctx.db, 'SELECT * FROM quotes WHERE id=?', id); if (!q) throw new QuoteError('QUOTE_NOT_FOUND', 404); return q; };
const EDITABLE = ['NEEDS_REVIEW', 'PENDING_APPROVAL', 'INFO_REQUESTED'];

export const PatchInput = z.object({
  items: z.array(z.object({ kind: z.enum(['SERVICE', 'NIGHT_SURCHARGE', 'ADDON', 'TRANSPORT', 'DISCOUNT', 'OTHER']), label: z.string().min(1).max(120), amountCents: z.number().int() })).min(1).optional(),
  notes: z.string().max(1000).nullable().optional(),
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  resolveReview: z.boolean().optional(),
});

export async function patchQuote(ctx: Ctx, id: string, input: z.infer<typeof PatchInput>, actor: string) {
  const q = getQ(ctx, id);
  if (!EDITABLE.includes(q.status)) throw new QuoteError('QUOTE_NOT_EDITABLE');
  const before = quoteView(ctx, id)!;
  tx(ctx.db, () => {
    if (input.items) {
      run(ctx.db, 'DELETE FROM quote_items WHERE quote_id=?', id);
      input.items.forEach((l, i) => run(ctx.db, 'INSERT INTO quote_items(id,quote_id,kind,label,amount_cents,position) VALUES(?,?,?,?,?,?)', uid(), id, l.kind, l.label, l.amountCents, i));
      const total = input.items.reduce((s, l) => s + l.amountCents, 0);
      if (total <= 0) throw new QuoteError('INVALID_TOTAL', 422);
      run(ctx.db, 'UPDATE quotes SET total_cents=? WHERE id=?', total, id);
    }
    if (input.notes !== undefined) run(ctx.db, 'UPDATE quotes SET notes=? WHERE id=?', input.notes, id);
    if (input.validUntil) run(ctx.db, 'UPDATE quotes SET valid_until=? WHERE id=?', input.validUntil, id);
    if (input.resolveReview) run(ctx.db, "UPDATE quotes SET review_reasons='[]' WHERE id=?", id);
    run(ctx.db, 'UPDATE quotes SET updated_at=? WHERE id=?', ctx.now().getTime(), id);
  });
  const reasons = parse<string[]>(getQ(ctx, id).review_reasons, []).filter((r) => r !== 'PDF_UNAVAILABLE');
  run(ctx.db, 'UPDATE quotes SET review_reasons=? WHERE id=?', j(reasons), id);
  await finalizePdf(ctx, id);
  const left = parse<string[]>(getQ(ctx, id).review_reasons, []);
  run(ctx.db, 'UPDATE quotes SET status=? WHERE id=?', left.length ? 'NEEDS_REVIEW' : 'PENDING_APPROVAL', id);
  audit(ctx, id, 'EDIT', actor, { items: before.items, totalCents: before.totalCents, notes: before.notes }, { items: input.items, notes: input.notes, resolveReview: input.resolveReview });
  return quoteView(ctx, id)!;
}

export async function regeneratePdf(ctx: Ctx, id: string) {
  const q = getQ(ctx, id);
  if (!q.total_cents) throw new QuoteError('NO_TOTAL', 422);
  const ok = await finalizePdf(ctx, id);
  if (!ok) throw new QuoteError('PDF_UNAVAILABLE', 503);
  return quoteView(ctx, id)!;
}

export function approve(ctx: Ctx, id: string, actor: string) {
  const q = getQ(ctx, id);
  if (!['PENDING_APPROVAL', 'INFO_REQUESTED', 'NEEDS_REVIEW'].includes(q.status)) throw new QuoteError('INVALID_STATE');
  const reasons = parse<string[]>(q.review_reasons, []);
  if (reasons.length) throw new QuoteError('REVIEW_REQUIRED', 409, `Pendências: ${reasons.join(', ')}. Edite o orçamento (PATCH com resolveReview) antes de aprovar.`);
  if (!q.pdf_path || q.total_cents <= 0) throw new QuoteError('PDF_REQUIRED', 409);
  run(ctx.db, "UPDATE quotes SET status='APPROVED', approved_at=?, updated_at=? WHERE id=?", ctx.now().getTime(), ctx.now().getTime(), id);
  audit(ctx, id, 'APPROVE', actor, { status: q.status }, { status: 'APPROVED', totalCents: q.total_cents });
  ctx.events.emit('QUOTE_APPROVED', { quoteId: id, totalCents: q.total_cents });
  return quoteView(ctx, id)!;
}

export function reject(ctx: Ctx, id: string, reason: string, actor: string) {
  const q = getQ(ctx, id);
  if (!EDITABLE.includes(q.status) && q.status !== 'APPROVED') throw new QuoteError('INVALID_STATE');
  run(ctx.db, "UPDATE quotes SET status='REJECTED', updated_at=? WHERE id=?", ctx.now().getTime(), id);
  audit(ctx, id, 'REJECT', actor, { status: q.status }, { reason });
  ctx.events.emit('QUOTE_REJECTED', { quoteId: id, reason });
  return quoteView(ctx, id)!;
}

export async function requestInfo(ctx: Ctx, id: string, question: string, actor: string) {
  const q = getQ(ctx, id);
  if (!EDITABLE.includes(q.status)) throw new QuoteError('INVALID_STATE');
  const r = await ctx.outbound.sendText(q.conversation_id, question, { author: 'ADRIANA' });
  run(ctx.db, "UPDATE quotes SET status='INFO_REQUESTED', updated_at=? WHERE id=?", ctx.now().getTime(), id);
  audit(ctx, id, 'REQUEST_INFO', actor, { status: q.status }, { question });
  ctx.events.emit('QUOTE_INFO_REQUESTED', { quoteId: id });
  return { quote: quoteView(ctx, id)!, delivery: r };
}

/** Só envia orçamento APROVADO. Janela de 24h/template tratados em OutboundService. */
export async function sendQuote(ctx: Ctx, id: string, actor: string): Promise<{ quote: any; delivery: SendResult }> {
  const q = getQ(ctx, id);
  if (q.status !== 'APPROVED') throw new QuoteError('NOT_APPROVED', 409, 'Orçamento precisa estar APPROVED para ser enviado');
  if (!q.pdf_path) throw new QuoteError('PDF_REQUIRED', 409);
  let delivery: SendResult;
  try {
    delivery = await ctx.outbound.sendQuoteDocument(q.conversation_id, q.pdf_path, `Aqui está a sua proposta 💗 Qualquer dúvida é só falar por aqui.`, { idemKey: `quote-send:${id}`, author: 'ADRIANA' });
  } catch (e) {
    if (e instanceof ChannelError) throw new QuoteError(e.code, e.code.endsWith('_NOT_CONFIGURED') ? 503 : 502, e.message);
    throw e;
  }
  run(ctx.db, "UPDATE quotes SET status='SENT', sent_at=?, updated_at=? WHERE id=?", ctx.now().getTime(), ctx.now().getTime(), id);
  audit(ctx, id, 'SEND', actor, { status: 'APPROVED' }, { channel: delivery.channel, simulated: delivery.simulated });
  ctx.events.emit('QUOTE_SENT', { quoteId: id, channel: delivery.channel });
  return { quote: quoteView(ctx, id)!, delivery };
}

/** Aceite confirmado pela Adriana => agendamento definitivo (recheca conflitos). */
export async function acceptQuote(ctx: Ctx, id: string, actor: string) {
  const q = getQ(ctx, id);
  if (q.status !== 'SENT') throw new QuoteError('INVALID_STATE', 409, 'Só propostas SENT podem ser aceitas');
  const sch = parse<Plan>(q.schedule, {} as Plan);
  const ev = parse<any>(q.event, {});
  const block: [number, number] = sch.travelVerified ? [sch.departureEpoch, sch.returnArrivalEpoch] : [sch.arrivalEpoch, sch.returnDepartureEpoch];
  let appt;
  try {
    appt = await ctx.calendar.book({ quoteId: id, customerId: q.customer_id, startEpoch: sch.startEpoch, endEpoch: sch.endEpoch, blockStart: block[0], blockEnd: block[1],
      address: ev.address ?? ev.neighborhood ?? '', title: `Atendimento — ${ev.customerName ?? 'cliente'} (${q.service_code})` });
  } catch (e) {
    if (e instanceof CalendarError) throw new QuoteError(e.code, 409, e.code === 'CONFLICT' ? 'Horário não está mais livre' : e.code);
    throw e;
  }
  run(ctx.db, "UPDATE quotes SET status='ACCEPTED', accepted_at=?, updated_at=? WHERE id=?", ctx.now().getTime(), ctx.now().getTime(), id);
  audit(ctx, id, 'ACCEPT', actor, { status: 'SENT' }, { appointmentId: appt.id, calendar: appt.calendar, simulated: appt.simulated });
  ctx.events.emit('QUOTE_ACCEPTED', { quoteId: id, totalCents: q.total_cents, service: q.service_code });
  return { quote: quoteView(ctx, id)!, appointment: appt };
}

export function markLost(ctx: Ctx, id: string, reason: string | undefined, actor: string) {
  const q = getQ(ctx, id);
  if (!['SENT', 'APPROVED'].includes(q.status)) throw new QuoteError('INVALID_STATE');
  run(ctx.db, "UPDATE quotes SET status='LOST', lost_at=?, lost_reason=?, updated_at=? WHERE id=?", ctx.now().getTime(), reason ?? null, ctx.now().getTime(), id);
  audit(ctx, id, 'LOST', actor, { status: q.status }, { reason });
  ctx.events.emit('QUOTE_LOST', { quoteId: id, reason });
  return quoteView(ctx, id)!;
}
export { localToEpoch };
