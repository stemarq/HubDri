// ADRI: orquestra conversa -> extração -> agenda/transporte/preço (serviços determinísticos) -> orçamento PENDING_APPROVAL.
// O texto da cliente é tratado apenas como dado. Valores monetários nunca saem da IA nem aparecem para a cliente antes da aprovação.
import { Ctx } from '../context.js';
import { j, one, parse, run, uid, Row } from '../db.js';
import { Alternative, BuildResult, Slots, buildQuote } from '../services/quotes.js';
import { extract } from './nlu.js';
import { getSetting } from '../services/settings.js';
import { fmtDateLong, fmtTime } from '../lib/time.js';
import { logger } from '../lib/logger.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface InboundInput {
  waId: string; name?: string; channel: 'SIMULATOR' | 'WHATSAPP'; type: 'text' | 'image' | 'audio' | 'other';
  text?: string; waMessageId?: string; mediaPath?: string; mediaId?: string;
}
export interface InboundResult { conversationId: string; duplicate: boolean; mode: string; replies: string[]; quoteId?: string; sendErrors?: string[] }

interface State { slots: Slots; awaiting?: string; alternatives?: Alternative[]; greeted?: boolean; quoteId?: string }
const emptyState = (): State => ({ slots: { inspirations: [] } });

const locks = new Map<string, Promise<unknown>>();
function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next.catch(() => undefined));
  return next;
}

function getOrCreateConversation(ctx: Ctx, inp: InboundInput): { conv: Row; firstContact: boolean } {
  const now = ctx.now().getTime();
  let cust = one(ctx.db, 'SELECT * FROM customers WHERE wa_id=?', inp.waId);
  let first = false;
  if (!cust) {
    const id = uid();
    run(ctx.db, 'INSERT INTO customers(id,wa_id,name,created_at) VALUES(?,?,?,?)', id, inp.waId, inp.name ?? null, now);
    cust = one(ctx.db, 'SELECT * FROM customers WHERE id=?', id)!;
    first = true;
  } else if (!cust.name && inp.name) run(ctx.db, 'UPDATE customers SET name=? WHERE id=?', inp.name, cust.id);
  let conv = one(ctx.db, 'SELECT * FROM conversations WHERE customer_id=?', cust.id);
  if (!conv) {
    const id = uid();
    run(ctx.db, 'INSERT INTO conversations(id,customer_id,channel,mode,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', id, cust.id, inp.channel, 'AI', j(emptyState()), now, now);
    conv = one(ctx.db, 'SELECT * FROM conversations WHERE id=?', id)!;
  }
  return { conv, firstContact: first };
}

const save = (ctx: Ctx, convId: string, st: State) => run(ctx.db, 'UPDATE conversations SET state=?, updated_at=? WHERE id=?', j(st), ctx.now().getTime(), convId);

export function handoff(ctx: Ctx, conversationId: string, reason: string) {
  run(ctx.db, "UPDATE conversations SET mode='HUMAN', updated_at=? WHERE id=?", ctx.now().getTime(), conversationId);
  ctx.events.emit('HANDOFF', { conversationId, reason });
}
export function resume(ctx: Ctx, conversationId: string) {
  run(ctx.db, "UPDATE conversations SET mode='AI', updated_at=? WHERE id=?", ctx.now().getTime(), conversationId);
  ctx.events.emit('RESUME', { conversationId });
}

export function handleInbound(ctx: Ctx, inp: InboundInput): Promise<InboundResult> {
  return serialized(inp.waId, () => process(ctx, inp));
}

async function process(ctx: Ctx, inp: InboundInput): Promise<InboundResult> {
  const now = ctx.now().getTime();
  const { conv, firstContact } = getOrCreateConversation(ctx, inp);
  const base = { conversationId: conv.id as string };

  // Idempotência: wa_message_id é UNIQUE.
  try {
    run(ctx.db, 'INSERT INTO messages(id,conversation_id,direction,wa_message_id,type,body,media_path,status,author,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      uid(), conv.id, 'IN', inp.waMessageId ?? null, inp.type, inp.text ?? (inp.type === 'text' ? '' : `[${inp.type}]`), inp.mediaPath ?? null, 'RECEIVED', 'CUSTOMER', now);
  } catch (e) {
    if (/UNIQUE/i.test((e as Error).message)) { logger.info('message.duplicate', { waMessageId: inp.waMessageId }); return { ...base, duplicate: true, mode: conv.mode, replies: [] }; }
    throw e;
  }
  run(ctx.db, 'UPDATE conversations SET last_inbound_at=?, request_started_at=COALESCE(request_started_at, ?) WHERE id=?', now, now, conv.id);
  if (firstContact) ctx.events.emit('CUSTOMER_FIRST_CONTACT', { customerId: conv.customer_id });

  const fresh = one(ctx.db, 'SELECT * FROM conversations WHERE id=?', conv.id)!;
  if (fresh.mode === 'HUMAN') return { ...base, duplicate: false, mode: 'HUMAN', replies: [] }; // IA calada até ser reativada

  const st = parse<State>(fresh.state, emptyState());
  if (!st.slots) Object.assign(st, emptyState());
  const replies: string[] = [];
  let quoteId: string | undefined;
  try {
    quoteId = await decide(ctx, fresh, st, inp, replies);
  } catch (e) {
    logger.error('agent.failed', { conversationId: conv.id, err: (e as Error).stack });
    replies.length = 0;
    handoff(ctx, conv.id, 'AGENT_ERROR');
    replies.push('Tive um probleminha para finalizar aqui, mas já avisei a Adriana para te ajudar pessoalmente 💗');
  }
  save(ctx, conv.id, st);
  const sendErrors: string[] = [];
  for (const [i, text] of replies.entries()) {
    try { await ctx.outbound.sendText(conv.id, text, { author: 'ADRI', idemKey: inp.waMessageId ? `reply:${inp.waMessageId}:${i}` : undefined }); }
    catch (e) { sendErrors.push((e as Error).message); logger.warn('reply.send.failed', { err: (e as Error).message }); }
  }
  const mode = one(ctx.db, 'SELECT mode FROM conversations WHERE id=?', conv.id)!.mode as string;
  return { ...base, duplicate: false, mode, replies, quoteId, sendErrors: sendErrors.length ? sendErrors : undefined };
}

const GREETING = 'Oi! Que bom ter você por aqui! 💗 Sou a Adri, assistente virtual da Adriana.';

async function decide(ctx: Ctx, conv: Row, st: State, inp: InboundInput, replies: string[]): Promise<string | undefined> {
  const greet = () => { if (!st.greeted) { st.greeted = true; return GREETING + ' '; } return ''; };

  if (inp.type === 'audio') {
    // Sem serviço de transcrição configurado: dizemos isso claramente em vez de fingir que entendemos.
    replies.push(`${greet()}Ainda não consigo ouvir áudios por aqui. Pode escrever pra mim? 💗`.trim());
    return;
  }
  if (inp.type === 'image') {
    if (inp.mediaPath) st.slots.inspirations.push(inp.mediaPath);
    if (!inp.text) { replies.push(`${greet()}Recebi a sua inspiração, vou mostrar para a Adriana! 💗 Pode me contar mais sobre o que você precisa?`.trim()); return; }
  }
  if (inp.type === 'other') { replies.push(`${greet()}Por aqui consigo ler mensagens de texto e imagens. Pode me escrever? 💗`.trim()); return; }

  const text = (inp.text ?? '').slice(0, 1000);
  const nowD = ctx.now();
  const ex = extract(text, nowD, st.awaiting);
  if (ex.injectionSuspected) ctx.events.emit('PROMPT_INJECTION_SUSPECTED', { conversationId: conv.id });

  if (ex.wantsHuman) {
    handoff(ctx, conv.id, 'CUSTOMER_REQUEST');
    replies.push('Claro! Vou avisar a Adriana para continuar a conversa com você por aqui 💗');
    return;
  }

  // Já existe orçamento em andamento?
  if (st.quoteId) {
    const q = one(ctx.db, 'SELECT status FROM quotes WHERE id=?', st.quoteId);
    const status = q?.status as string | undefined;
    if (status && ['ACCEPTED', 'LOST', 'REJECTED'].includes(status)) { const keep = { name: st.slots.name }; Object.assign(st, emptyState(), { greeted: true }); st.slots.name = keep.name; }
    else if (status === 'SENT') {
      if (ex.acceptance) { run(ctx.db, 'UPDATE quotes SET client_signal=? WHERE id=?', 'ACCEPT', st.quoteId); ctx.events.emit('CLIENT_ACCEPTANCE_SIGNAL', { quoteId: st.quoteId }); replies.push('Que ótimo! 💗 Já avisei a Adriana para confirmar o seu horário e te retornar.'); }
      else if (ex.decline) { run(ctx.db, 'UPDATE quotes SET client_signal=? WHERE id=?', 'DECLINE', st.quoteId); ctx.events.emit('CLIENT_DECLINE_SIGNAL', { quoteId: st.quoteId }); replies.push('Tudo bem! Se quiser, me conta o que pesou na decisão para eu avisar a Adriana. 💗'); }
      else { handoff(ctx, conv.id, 'QUESTION_AFTER_PROPOSAL'); replies.push('Vou chamar a Adriana para te responder sobre isso, tudo bem? 💗'); }
      return;
    } else if (status) {
      replies.push(status === 'INFO_REQUESTED' ? 'Anotado! Já passei para a Adriana. 💗' : 'A Adriana está finalizando a revisão da sua proposta. Assim que estiver aprovada, eu te envio por aqui 💗');
      return;
    }
  }

  // FAQ configurada pela Adriana (só responde com o que está cadastrado).
  const nothingExtracted = !ex.service && !ex.date && ex.readyMin === undefined && ex.desiredStartMin === undefined && !ex.address && !ex.neighborhood && !ex.role && !ex.eventType;
  if (nothingExtracted) {
    const tn = text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const faq = getSetting(ctx.db, 'faq').find((f) => f.keywords.some((k) => tn.includes(k.toLowerCase())));
    if (faq) { replies.push(faq.answer); return; }
  }

  applyExtraction(st, ex, nowD);

  const q = nextQuestions(st);
  if (q.length) {
    st.awaiting = q[0].key;
    replies.push((greet() + q.map((x) => x.text).join(' ')).trim());
    return;
  }

  // Dados completos => pipeline determinístico.
  st.awaiting = undefined;
  let r: BuildResult;
  r = await buildQuote(ctx, conv, st.slots);
  if (r.kind === 'conflict') {
    if (!r.alternatives.length) {
      handoff(ctx, conv.id, 'NO_AVAILABILITY');
      replies.push(`${greet()}Nesse horário a agenda da Adriana já está ocupada e não encontrei uma alternativa próxima. Vou chamar a Adriana para encontrar a melhor solução com você 💗`.trim());
      return;
    }
    st.alternatives = r.alternatives; st.awaiting = 'alternative';
    const list = r.alternatives.map((a, i) => `${i + 1}) ${a.label}`).join('\n');
    replies.push(`${greet()}Nesse horário a agenda da Adriana já está ocupada. 😕 Consigo assim:\n${list}\nQual você prefere? Se preferir, me diga outra data.`.trim());
    return;
  }
  st.quoteId = r.quoteId;
  run(ctx.db, 'UPDATE conversations SET request_started_at=NULL WHERE id=?', conv.id);
  ctx.events.emit('QUOTE_REQUESTED', { conversationId: conv.id, quoteId: r.quoteId });
  replies.push(`${greet()}Perfeito, já tenho tudo que preciso! 💗 Enviei os detalhes para a Adriana revisar. Assim que ela aprovar, eu te mando a proposta por aqui.`.trim());
  return r.quoteId;
}

function applyExtraction(st: State, ex: ReturnType<typeof extract>, now: Date) {
  const s = st.slots;
  if (st.awaiting === 'alternative' && st.alternatives && ex.choice && st.alternatives[ex.choice - 1]) {
    const a = st.alternatives[ex.choice - 1];
    if (a.kind === 'earlier') { s.desiredStartMin = a.startMin; } else { s.date = a.date; s.dateConfirmed = true; }
    st.alternatives = undefined;
  } else if (st.awaiting === 'alternative' && (ex.date || ex.readyMin !== undefined || ex.desiredStartMin !== undefined)) st.alternatives = undefined;

  if (ex.name) { s.name = ex.name; }
  if (ex.role) s.role = ex.role;
  if (ex.eventType) s.eventType = ex.eventType;
  if (ex.service) s.service = ex.service;
  if (ex.role === 'noiva' && s.service === 'MAKEUP_HAIR') s.service = 'BRIDE_PACKAGE';

  if (ex.date) { if (s.date !== ex.date.date) s.dateConfirmed = false; s.date = ex.date.date; if (!ex.date.needsConfirmation) s.dateConfirmed = true; }
  else if (st.awaiting === 'date_confirm') { if (ex.yes) s.dateConfirmed = true; else if (ex.no) { s.date = undefined; s.dateConfirmed = false; } }

  if (ex.readyMin !== undefined) s.readyMin = ex.readyMin;
  if (ex.eventStartMin !== undefined) s.eventStartMin = ex.eventStartMin;
  if (ex.desiredStartMin !== undefined) { s.desiredStartMin = ex.desiredStartMin; }

  if (ex.address) { s.address = ex.address.raw; s.addressFull = ex.address.full; }
  if (ex.neighborhood) { s.neighborhood = ex.neighborhood; if (!s.addressFull) s.address = ex.neighborhood; }
  void now;
}

function nextQuestions(st: State): { key: string; text: string }[] {
  const s = st.slots;
  const out: { key: string; text: string }[] = [];
  if (!s.service) {
    const role = !s.role && (!s.eventType || s.eventType === 'casamento') ? ' E você vai como noiva, madrinha ou convidada?' : '';
    out.push({ key: 'service', text: `Você quer maquiagem, penteado ou os dois?${role}` });
  }
  if (!s.date) out.push({ key: 'date', text: 'Para qual data é o atendimento?' });
  else if (!s.dateConfirmed) out.push({ key: 'date_confirm', text: `Só confirmando: seria ${fmtDateLong(s.date)}?` });
  if (s.readyMin === undefined && s.desiredStartMin === undefined) {
    const ev = s.eventStartMin !== undefined ? ` Vi que o evento começa às ${fmtTime(s.eventStartMin)}, mas` : '';
    out.push({ key: 'ready', text: ev ? `${ev.trim()} que horas você precisa estar pronta?` : 'Que horas você precisa estar pronta?' });
  }
  if (!s.addressFull) {
    out.push({ key: 'address', text: s.neighborhood ? `Pode me passar o endereço completo (rua, número e complemento) de onde você vai se arrumar em ${s.neighborhood}?` : 'Onde você vai se arrumar? Pode me passar o endereço completo (rua, número e complemento).' });
  }
  return out.slice(0, 2);
}

export function saveInboundMedia(ctx: Ctx, base64: string, ext: string): string {
  mkdirSync(ctx.mediaDir, { recursive: true });
  const p = join(ctx.mediaDir, `${uid()}.${ext.replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'bin'}`);
  writeFileSync(p, Buffer.from(base64, 'base64'));
  return p;
}
