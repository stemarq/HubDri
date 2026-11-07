// ADRI: motor conversacional independente de canal. Interpreta (regras + LLM opcional), conversa com empatia e só então
// aciona as ferramentas determinísticas (agenda, transporte, preço). Valores monetários nunca saem da IA nem aparecem
// para a cliente antes da aprovação da Adriana; ações com efeito (criar orçamento, apagar dados) exigem confirmação.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ctx } from '../context.js';
import { all, j, one, parse, run, uid, Row } from '../db.js';
import { Alternative, BuildResult, Slots, buildQuote } from '../services/quotes.js';
import { Extracted, extract, norm, toMinutes } from './nlu.js';
import { LlmContext, reconcile } from './llm.js';
import { getSetting } from '../services/settings.js';
import { eraseCustomerData, getMemory, remember, setAddressConsent } from '../services/memory.js';
import { recordFailure } from '../services/failures.js';
import { APOLOGY, HANDOFF_MSG, MISUNDERSTOOD, OFFER_HUMAN, SERVICE_NAMES, Tone, ask, empathy, firstName, greeting, summary } from './persona.js';
import { epochToLocal, localToEpoch, WEEKDAYS_PT } from '../lib/time.js';
import { logger } from '../lib/logger.js';
import { acceptAndConfirm } from '../services/hub.js';
import type { InboundEvent } from '../channels/types.js';

export interface InboundInput {
  waId: string; name?: string; channel: 'SIMULATOR' | 'WHATSAPP' | 'TELEGRAM'; type: 'text' | 'image' | 'audio' | 'other';
  text?: string; waMessageId?: string; mediaPath?: string; mediaId?: string;
}
export interface InboundResult { conversationId: string; duplicate: boolean; mode: string; replies: string[]; quoteId?: string; sendErrors?: string[] }

interface State {
  slots: Slots; awaiting?: string; askedKeys?: string[]; alternatives?: Alternative[]; greeted?: boolean; quoteId?: string;
  lastAsked?: string; noProgress?: number; finalConfirmed?: boolean; timeConfirmed?: boolean; memoryAsked?: boolean;
  dissatisfied?: number; tone?: Tone; flag?: string;
}
const emptyState = (): State => ({ slots: { inspirations: [] } });

export const handleEvent = (ctx: Ctx, e: InboundEvent) =>
  handleInbound(ctx, { waId: e.userId, name: e.displayName, channel: e.channel, type: e.type, text: e.text, waMessageId: e.messageId, mediaPath: e.mediaPath });

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
  let outcome: { quoteId?: string; erase?: boolean } = {};
  try {
    outcome = await decide(ctx, fresh, st, inp, replies);
  } catch (e) {
    logger.error('agent.failed', { conversationId: conv.id, err: (e as Error).stack });
    recordFailure(ctx, { conversationId: conv.id, category: 'AGENT_ERROR', message: inp.text, detail: { err: (e as Error).message } });
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
  if (outcome.erase) eraseCustomerData(ctx, conv.customer_id); // depois de responder (o envio usa o identificador da cliente)
  const mode = one(ctx.db, 'SELECT mode FROM conversations WHERE id=?', conv.id)!.mode as string;
  return { ...base, duplicate: false, mode, replies, quoteId: outcome.quoteId, sendErrors: sendErrors.length ? sendErrors : undefined };
}

/** Regras + LLM opcional (validado e reconciliado). Divergências viram registro de falha para revisão humana. */
async function interpret(ctx: Ctx, conv: Row, st: State, text: string): Promise<Extracted> {
  const rules = extract(text, ctx.now(), st.awaiting, st.askedKeys);
  if (!ctx.llm || text.trim().length < 4) return rules;
  const today = epochToLocal(ctx.now().getTime());
  const history = all(ctx.db, 'SELECT direction, body FROM messages WHERE conversation_id=? AND type=? ORDER BY created_at DESC, rowid DESC LIMIT 7', conv.id, 'text')
    .reverse().slice(0, -1).map((m) => ({ from: (m.direction === 'IN' ? 'cliente' : 'adri') as 'cliente' | 'adri', text: String(m.body ?? '') }));
  const llmCtx: LlmContext = { today: today.date, weekday: WEEKDAYS_PT[today.weekday], awaiting: st.awaiting, history };
  const out = await ctx.llm.extract(text, llmCtx);
  const { merged, conflicts } = reconcile(rules, out, today.date);
  if (conflicts.length) recordFailure(ctx, { conversationId: conv.id, category: 'LLM_CONFLICT', message: text, detail: { conflicts } });
  return merged;
}

type Outcome = { quoteId?: string; erase?: boolean };

async function decide(ctx: Ctx, conv: Row, st: State, inp: InboundInput, replies: string[]): Promise<Outcome> {
  const customer = one(ctx.db, 'SELECT * FROM customers WHERE id=?', conv.customer_id)!;
  const mem = getMemory(ctx, conv.customer_id);
  const returning = mem.visits > 0;
  const tone = (): Tone => st.tone ?? { casual: false, formal: false };
  const greet = () => {
    if (st.greeted) return '';
    st.greeted = true;
    return greeting(st.slots.name ?? mem.firstName ?? customer.name ?? undefined, returning, tone()) + ' ';
  };
  const say = (...parts: string[]) => replies.push(parts.filter(Boolean).join('').trim());

  let text = (inp.text ?? '').slice(0, 1000);
  let transcriptEcho = '';

  if (inp.type === 'audio') {
    if (inp.mediaPath && ctx.transcriber) {
      const tr = await ctx.transcriber.transcribe(inp.mediaPath);
      if (!tr) { recordFailure(ctx, { conversationId: conv.id, category: 'AUDIO_UNTRANSCRIBED', message: '[áudio]', detail: { reason: 'transcription_failed' } }); say(greet(), 'Não consegui ouvir esse áudio direito. Pode escrever pra mim?'); return {}; }
      text = tr.slice(0, 1000);
      transcriptEcho = `Entendi assim: “${text}”. `;
      run(ctx.db, "UPDATE messages SET body=? WHERE id=(SELECT id FROM messages WHERE conversation_id=? AND direction='IN' ORDER BY created_at DESC, rowid DESC LIMIT 1)", text, conv.id);
    } else {
      // Sem serviço de transcrição: dizemos isso claramente em vez de fingir que entendemos.
      recordFailure(ctx, { conversationId: conv.id, category: 'AUDIO_UNTRANSCRIBED', message: '[áudio]', detail: { reason: 'no_transcriber' } });
      say(greet(), 'Ainda não consigo ouvir áudios por aqui. Pode escrever pra mim? 💗');
      return {};
    }
  }
  if (inp.type === 'image') {
    if (inp.mediaPath) st.slots.inspirations.push(inp.mediaPath);
    if (!inp.text) { say(greet(), 'Recebi a sua inspiração, vou mostrar para a Adriana! 💗 Pode me contar mais sobre o que você precisa?'); return {}; }
  }
  if (inp.type === 'other') { say(greet(), 'Por aqui consigo ler mensagens de texto e imagens. Pode me escrever? 💗'); return {}; }

  const ex = await interpret(ctx, conv, st, text);
  if (ex.casual || ex.formal) st.tone = { casual: !!(st.tone?.casual || ex.casual), formal: !!(st.tone?.formal || ex.formal) };
  if (ex.injectionSuspected) { ctx.events.emit('PROMPT_INJECTION_SUSPECTED', { conversationId: conv.id }); recordFailure(ctx, { conversationId: conv.id, category: 'INJECTION', message: text }); }

  // ----- Privacidade (LGPD): apagamento com confirmação; guardar endereço só com consentimento -----
  if (st.awaiting === 'erase_confirm') {
    st.awaiting = undefined;
    if (/\bconfirmar\b/.test(norm(text))) { say('Pronto, vou apagar seus dados e o histórico desta conversa. Se precisar de algo depois, é só chamar de novo.'); return { erase: true }; }
    say('Tudo bem, não apaguei nada. Se mudar de ideia, é só pedir.'); return {};
  }
  if (ex.privacy === 'erase') {
    st.awaiting = 'erase_confirm';
    say('Posso apagar seus dados e o histórico desta conversa. Para confirmar, responda CONFIRMAR. (Orçamentos já feitos guardam só valores e datas, sem identificar você.)'); return {};
  }
  if (st.awaiting === 'memory_consent') {
    st.awaiting = undefined;
    if (ex.privacy === 'keep' || ex.yes) { setAddressConsent(ctx, conv.customer_id, true, st.slots.address); say('Combinado, vou guardar o endereço para facilitar os próximos pedidos. Para apagar, é só dizer “apagar meus dados”.'); return {}; }
    if (ex.privacy === 'dont_keep' || ex.no) { setAddressConsent(ctx, conv.customer_id, false); say('Sem problemas, não vou guardar o endereço.'); return {}; }
  }

  // ----- Atendimento humano e insatisfação -----
  if (ex.wantsHuman) { handoff(ctx, conv.id, 'CUSTOMER_REQUEST'); say(HANDOFF_MSG(tone())); return {}; }
  if (ex.dissatisfied) {
    st.dissatisfied = (st.dissatisfied ?? 0) + 1;
    recordFailure(ctx, { conversationId: conv.id, category: 'DISSATISFIED', message: text, detail: { lastAsked: st.lastAsked, slots: st.slots } });
    if (st.dissatisfied >= 2) { handoff(ctx, conv.id, 'DISSATISFIED'); say('Peço desculpa por não ter acertado. Já chamei a Adriana para continuar com você pessoalmente.'); return {}; }
    say(APOLOGY); return {};
  }

  // ----- Orçamento já em andamento -----
  if (st.quoteId) {
    const status = one(ctx.db, 'SELECT status FROM quotes WHERE id=?', st.quoteId)?.status as string | undefined;
    if (status && ['ACCEPTED', 'LOST', 'REJECTED'].includes(status)) {
      const keep = st.slots.name; const tn = st.tone;
      Object.assign(st, emptyState(), { greeted: true, tone: tn }); st.slots.name = keep;
    } else if (status === 'SENT') {
      const hubQuote = ctx.hub ? one(ctx.db, 'SELECT hub_id FROM quotes WHERE id=?', st.quoteId) : undefined;
      if (ex.acceptance && hubQuote?.hub_id) {
        // Com hub: registra a aprovação lá e reserva a agenda (Google Calendar se configurado).
        try {
          await ctx.hub!.sendReply(hubQuote.hub_id, 'aprovado', text);
          ctx.events.emit('CLIENT_ACCEPTANCE_SIGNAL', { quoteId: st.quoteId });
          await acceptAndConfirm(ctx, st.quoteId, 'cliente-chat');
          return {}; // a confirmação já foi enviada ao chat
        } catch (e) { logger.warn('hub.accept.chat.failed', { err: (e as Error).message }); }
      }
      if (ex.changeRequest && !ex.acceptance && hubQuote?.hub_id) {
        try {
          await ctx.hub!.sendReply(hubQuote.hub_id, 'mudanca', text);
          run(ctx.db, "UPDATE quotes SET status='IN_HUB', sent_at=NULL WHERE id=?", st.quoteId);
          say('Anotei o pedido! 💗 Já passei para a Adriana ajustar e, quando estiver pronto, te mando a nova versão por aqui.');
          return {};
        } catch (e) { logger.warn('hub.change.failed', { err: (e as Error).message }); }
      }
      if (ex.acceptance) { run(ctx.db, 'UPDATE quotes SET client_signal=? WHERE id=?', 'ACCEPT', st.quoteId); ctx.events.emit('CLIENT_ACCEPTANCE_SIGNAL', { quoteId: st.quoteId }); say('Que ótimo! 💗 Já avisei a Adriana para confirmar o seu horário e te retornar.'); }
      else if (ex.decline) { run(ctx.db, 'UPDATE quotes SET client_signal=? WHERE id=?', 'DECLINE', st.quoteId); ctx.events.emit('CLIENT_DECLINE_SIGNAL', { quoteId: st.quoteId }); say('Tudo bem! Se quiser, me conta o que pesou na decisão para eu avisar a Adriana. 💗'); }
      else { handoff(ctx, conv.id, 'QUESTION_AFTER_PROPOSAL'); say('Vou chamar a Adriana para te responder sobre isso, tudo bem? 💗'); }
      return {};
    } else if (status) {
      say(status === 'INFO_REQUESTED' ? 'Anotado! Já passei para a Adriana. 💗' : 'A Adriana está finalizando a revisão da sua proposta. Assim que estiver aprovada, eu te envio por aqui 💗');
      return {};
    }
  }

  // ----- FAQ cadastrada pela Adriana (só responde com o que está cadastrado) -----
  const nothingExtracted = !ex.service && !ex.date && ex.readyMin === undefined && ex.desiredStartMin === undefined && ex.ambiguousHour === undefined && !ex.address && !ex.neighborhood && !ex.role && !ex.eventType && !ex.yes && !ex.no;
  if (nothingExtracted) {
    const tn = norm(text);
    const faq = getSetting(ctx.db, 'faq').find((f) => f.keywords.some((k) => tn.includes(norm(k))));
    if (faq) { say(transcriptEcho, faq.answer); return {}; }
  }

  // ----- Atualiza o que a cliente disse -----
  const before = JSON.stringify(st.slots);
  const changed = applyExtraction(st, ex, ctx.now());
  validate(ctx, st);
  const progressed = JSON.stringify(st.slots) !== before;
  if (progressed) st.finalConfirmed = false;

  const lead = [transcriptEcho, empathy(ex.emotion, tone()), changed.length ? `Anotado, atualizei ${changed.join(' e ')}. ` : ''].join('');
  const questions = nextQuestions(st, mem.savedAddress);
  const key = questions[0]?.key ?? 'final_confirm';
  const stuck = trackProgress(st, key, progressed || changed.length > 0);

  if (stuck >= 3) {
    recordFailure(ctx, { conversationId: conv.id, category: 'STUCK', message: text, detail: { key, slots: st.slots } });
    handoff(ctx, conv.id, 'STUCK');
    say(greet(), 'Acho que não estou conseguindo te entender direitinho, e a última coisa que quero é te fazer repetir. Já chamei a Adriana para continuar com você pessoalmente.');
    return {};
  }
  if (stuck === 2) recordFailure(ctx, { conversationId: conv.id, category: 'NOT_UNDERSTOOD', message: text, detail: { key, slots: st.slots } });
  const misunderstood = !progressed && changed.length === 0 && stuck >= 1 && !ex.yes && !ex.no ? `${MISUNDERSTOOD[Math.min(stuck - 1, MISUNDERSTOOD.length - 1)]} ` : '';
  const human = stuck >= 2 ? ` ${OFFER_HUMAN}` : '';

  if (questions.length) {
    st.awaiting = key;
    st.askedKeys = questions.map((q) => q.key);
    const a = (q: Q) => ask(q.key, { ...q.c, n: stuck });
    say(greet(), lead, misunderstood, questions.map(a).join(' '), human);
    return {};
  }

  // ----- Tudo coletado: confirma antes de executar (registro comercial e aviso à Adriana) -----
  const s = st.slots;
  if (st.awaiting === 'final_confirm' && ex.yes && !progressed) st.finalConfirmed = true;
  else if (st.awaiting === 'final_confirm' && ex.no && !progressed) {
    st.awaiting = 'adjust'; st.askedKeys = [];
    say(lead, 'Claro! O que você quer ajustar? (serviço, data, horário ou endereço)'); return {};
  }
  if (!st.finalConfirmed) {
    st.awaiting = 'final_confirm'; st.askedKeys = [];
    say(greet(), lead, misunderstood, summary({ ...s, service: s.service }, tone()), human);
    return {};
  }

  st.awaiting = undefined; st.askedKeys = [];
  const r: BuildResult = await buildQuote(ctx, conv, s);
  if (r.kind === 'conflict') {
    st.finalConfirmed = false;
    if (!r.alternatives.length) {
      handoff(ctx, conv.id, 'NO_AVAILABILITY');
      say(greet(), 'Nesse horário a agenda da Adriana já está ocupada e não encontrei uma alternativa próxima. Vou chamar a Adriana para encontrar a melhor solução com você 💗');
      return {};
    }
    st.alternatives = r.alternatives; st.awaiting = 'alternative';
    const list = r.alternatives.map((a2, i) => `${i + 1}) ${a2.label}`).join('\n');
    say(greet(), `Nesse horário a agenda da Adriana já está ocupada. 😕 Consigo assim:\n${list}\nQual você prefere? Se preferir, me diga outra data.`);
    return {};
  }
  st.quoteId = r.quoteId;
  run(ctx.db, 'UPDATE conversations SET request_started_at=NULL WHERE id=?', conv.id);
  ctx.events.emit('QUOTE_REQUESTED', { conversationId: conv.id, quoteId: r.quoteId });
  remember(ctx, conv.customer_id, { name: s.name ?? firstName(customer.name), service: s.service, neighborhood: s.neighborhood, address: s.address });
  say(greet(), 'Perfeito, já tenho tudo que preciso! 💗 Enviei os detalhes para a Adriana revisar. Assim que ela aprovar, eu te mando a proposta por aqui. O valor final vem na proposta; o deslocamento entra como estimativa.');
  if (!getMemory(ctx, conv.customer_id).addressConsent && !st.memoryAsked) {
    st.memoryAsked = true; st.awaiting = 'memory_consent';
    say('Quer que eu guarde o seu endereço para facilitar os próximos pedidos? Responda “guardar” se quiser. Se não responder, eu não guardo.');
  }
  return { quoteId: r.quoteId };
}

/** Conta tentativas seguidas na mesma pergunta sem progresso. */
function trackProgress(st: State, key: string, progressed: boolean): number {
  if (!progressed && st.lastAsked === key) st.noProgress = (st.noProgress ?? 0) + 1;
  else st.noProgress = 0;
  st.lastAsked = key;
  return st.noProgress;
}

function applyExtraction(st: State, ex: Extracted, now: Date): string[] {
  const s = st.slots;
  const changed: string[] = [];
  const asked = new Set(st.askedKeys ?? []);

  if (st.awaiting === 'alternative' && st.alternatives && ex.choice && st.alternatives[ex.choice - 1]) {
    const a = st.alternatives[ex.choice - 1];
    if (a.kind === 'earlier') s.desiredStartMin = a.startMin; else { s.date = a.date; s.dateConfirmed = true; }
    st.alternatives = undefined;
  } else if (st.awaiting === 'alternative' && (ex.date || ex.readyMin !== undefined || ex.desiredStartMin !== undefined)) st.alternatives = undefined;

  // Negações / correções sem valor novo
  for (const c of ex.clear ?? []) {
    if (c === 'date') { s.date = undefined; s.dateConfirmed = false; }
    if (c === 'address') { s.address = undefined; s.addressFull = false; }
    if (c === 'time') { s.readyMin = undefined; s.desiredStartMin = undefined; s.ambiguousHour = undefined; st.timeConfirmed = false; }
  }

  if (ex.name) s.name = ex.name;
  if (ex.role) s.role = ex.role;
  if (ex.eventType) s.eventType = ex.eventType;
  if (ex.service) { if (s.service && s.service !== ex.service) changed.push('o serviço'); s.service = ex.service; }
  if (ex.role === 'noiva' && s.service === 'MAKEUP_HAIR') s.service = 'BRIDE_PACKAGE';

  if (ex.date) {
    if (s.date && s.date !== ex.date.date) changed.push('a data');
    if (s.date !== ex.date.date) s.dateConfirmed = false;
    s.date = ex.date.date; s.ambiguousDate = undefined;
    if (!ex.date.needsConfirmation) s.dateConfirmed = true;
  } else if (ex.ambiguousDate && !s.date) s.ambiguousDate = ex.ambiguousDate;

  if (ex.yes) {
    if (asked.has('date_confirm') && s.date) s.dateConfirmed = true;
    if (asked.has('time_confirm')) st.timeConfirmed = true;
  } else if (ex.no && asked.has('date_confirm') && !ex.date) { s.date = undefined; s.dateConfirmed = false; }
  else if (ex.no && asked.has('time_confirm') && ex.readyMin === undefined) { s.readyMin = undefined; st.timeConfirmed = false; }

  if (ex.readyMin !== undefined) {
    if (s.readyMin !== undefined && s.readyMin !== ex.readyMin) { changed.push('o horário'); st.timeConfirmed = false; }
    if (s.readyMin === undefined) st.timeConfirmed = false;
    s.readyMin = ex.readyMin; s.readyExplicit = !!ex.periodExplicit; s.ambiguousHour = undefined; st.flag = undefined;
  } else if (ex.ambiguousHour !== undefined) s.ambiguousHour = ex.ambiguousHour;
  if (ex.period && s.ambiguousHour !== undefined) {
    const v = toMinutes(s.ambiguousHour, 0, ex.period);
    if (v !== undefined) { s.readyMin = v; s.readyExplicit = true; s.ambiguousHour = undefined; st.timeConfirmed = true; }
  }
  if (ex.eventStartMin !== undefined) s.eventStartMin = ex.eventStartMin;
  if (ex.desiredStartMin !== undefined) s.desiredStartMin = ex.desiredStartMin;

  if (ex.address) {
    if (s.addressFull && s.address && s.address !== ex.address.raw) changed.push('o endereço');
    s.address = ex.address.raw; s.addressFull = ex.address.full;
  }
  if (ex.neighborhood) { s.neighborhood = ex.neighborhood; if (!s.addressFull) s.address = ex.neighborhood; }
  void now;
  return changed;
}

/** Coerência do que foi coletado: nunca seguir com horário no passado ou "pronta" depois do início do evento. */
function validate(ctx: Ctx, st: State) {
  const s = st.slots;
  if (s.date && s.readyMin !== undefined) {
    const nowL = epochToLocal(ctx.now().getTime());
    if (s.date === nowL.date && localToEpoch(s.date, s.readyMin) < ctx.now().getTime()) { s.readyMin = undefined; st.flag = 'time_before_now'; }
  }
  if (s.readyMin !== undefined && s.eventStartMin !== undefined && s.readyMin > s.eventStartMin) { s.readyMin = undefined; st.flag = 'ready_after_event'; }
}

type Q = { key: string; c: Omit<Parameters<typeof ask>[1], 'n'> };
function nextQuestions(st: State, savedAddress?: string): Q[] {
  const s = st.slots;
  const out: Q[] = [];
  if (!s.service) out.push({ key: 'service', c: { needsRole: !s.role && (!s.eventType || s.eventType === 'casamento') } });
  if (!s.date) out.push({ key: 'date', c: { ambiguousDate: s.ambiguousDate } });
  else if (!s.dateConfirmed) out.push({ key: 'date_confirm', c: { date: s.date } });
  if (s.readyMin === undefined && s.desiredStartMin === undefined) {
    if (s.ambiguousHour !== undefined) out.push({ key: 'period', c: { hour: s.ambiguousHour } });
    else if (st.flag === 'time_before_now' || st.flag === 'ready_after_event') out.push({ key: st.flag, c: {} });
    else out.push({ key: 'ready', c: {} });
  } else if (s.readyMin !== undefined && s.readyMin < 360 && !s.readyExplicit && !st.timeConfirmed) out.push({ key: 'time_confirm', c: { readyMin: s.readyMin } });
  if (!s.addressFull) out.push({ key: 'address', c: { neighborhood: s.neighborhood, savedAddress } });
  return out.slice(0, 2);
}

export function saveInboundMedia(ctx: Ctx, base64: string, ext: string): string {
  mkdirSync(ctx.mediaDir, { recursive: true });
  const p = join(ctx.mediaDir, `${uid()}.${ext.replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'bin'}`);
  writeFileSync(p, Buffer.from(base64, 'base64'));
  return p;
}
export { SERVICE_NAMES };
