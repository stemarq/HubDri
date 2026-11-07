// Avaliação e revisão humana: falhas e notas viram registros revisáveis. Resolver exige apontar o teste de regressão.
// Nada daqui é usado para treinar modelos; o export é manual e gera apenas esqueletos de teste.
import { Ctx } from '../context.js';
import { all, j, one, parse, run, uid } from '../db.js';

export type FailureCategory = 'STUCK' | 'NOT_UNDERSTOOD' | 'LLM_CONFLICT' | 'AGENT_ERROR' | 'DISSATISFIED' | 'LOW_RATING' | 'AUDIO_UNTRANSCRIBED' | 'INJECTION';

export function recordFailure(ctx: Ctx, f: { conversationId?: string; category: FailureCategory; message?: string; detail?: Record<string, unknown> }): string {
  const id = uid();
  run(ctx.db, "INSERT INTO agent_failures(id,conversation_id,category,message,detail,status,created_at) VALUES(?,?,?,?,?,'OPEN',?)",
    id, f.conversationId ?? null, f.category, (f.message ?? '').slice(0, 300), j(f.detail ?? {}), ctx.now().getTime());
  return id;
}

export const listFailures = (ctx: Ctx, status?: string) =>
  all(ctx.db, status ? 'SELECT * FROM agent_failures WHERE status=? ORDER BY created_at DESC' : 'SELECT * FROM agent_failures ORDER BY created_at DESC', ...(status ? [status] : []))
    .map((r) => ({ id: r.id, conversationId: r.conversation_id, category: r.category, message: r.message, detail: parse(r.detail, {}), status: r.status, regressionRef: r.regression_ref, note: r.note, createdAt: r.created_at }));

export class FailureError extends Error { constructor(public code: string, public status = 400) { super(code); } }
export function resolveFailure(ctx: Ctx, id: string, p: { regressionRef: string; note?: string }) {
  if (!one(ctx.db, 'SELECT id FROM agent_failures WHERE id=?', id)) throw new FailureError('FAILURE_NOT_FOUND', 404);
  run(ctx.db, "UPDATE agent_failures SET status='RESOLVED', regression_ref=?, note=? WHERE id=?", p.regressionRef, p.note ?? null, id);
  return listFailures(ctx).find((f) => f.id === id)!;
}

export function rateMessage(ctx: Ctx, messageId: string, score: number, comment: string | undefined, actor: string) {
  const m = one(ctx.db, 'SELECT id, conversation_id, body FROM messages WHERE id=?', messageId);
  if (!m) throw new FailureError('MESSAGE_NOT_FOUND', 404);
  run(ctx.db, 'INSERT INTO message_ratings(id,message_id,score,comment,actor,created_at) VALUES(?,?,?,?,?,?)', uid(), messageId, score, comment ?? null, actor, ctx.now().getTime());
  if (score <= 2) recordFailure(ctx, { conversationId: m.conversation_id, category: 'LOW_RATING', message: m.body, detail: { score, comment } });
}

export const ratingsSummary = (ctx: Ctx) => {
  const r = one(ctx.db, 'SELECT COUNT(*) n, AVG(score) a FROM message_ratings');
  return { count: (r?.n as number) ?? 0, average: r?.a == null ? null : Math.round((r.a as number) * 100) / 100 };
};
