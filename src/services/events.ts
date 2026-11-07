import { createHmac } from 'node:crypto';
import { DB, run, uid, j } from '../db.js';
import { Config } from '../config.js';
import { logger } from '../lib/logger.js';

export type EventType =
  | 'CUSTOMER_FIRST_CONTACT' | 'QUOTE_REQUESTED' | 'QUOTE_GENERATED' | 'QUOTE_NEEDS_REVIEW' | 'QUOTE_APPROVED' | 'QUOTE_REJECTED'
  | 'QUOTE_INFO_REQUESTED' | 'QUOTE_SENT' | 'QUOTE_ACCEPTED' | 'QUOTE_LOST' | 'CLIENT_ACCEPTANCE_SIGNAL' | 'CLIENT_DECLINE_SIGNAL'
  | 'HANDOFF' | 'RESUME' | 'TRANSPORT_ACTUAL_RECORDED' | 'PROMPT_INJECTION_SUSPECTED' | 'AVAILABILITY_CONFLICT';

export class EventBus {
  constructor(private db: DB, private cfg: Config, private fetchFn: typeof fetch = fetch) {}
  emit(type: EventType, payload: Record<string, unknown> = {}) {
    const id = uid(), createdAt = Date.now();
    run(this.db, 'INSERT INTO business_events(id,type,payload,created_at) VALUES(?,?,?,?)', id, type, j(payload), createdAt);
    logger.info('event', { type, ...payload });
    if (this.cfg.hubWebhookUrl) void this.push({ id, type, payload, createdAt });
  }
  private async push(ev: unknown) {
    const body = JSON.stringify(ev);
    const sig = this.cfg.hubWebhookSecret ? createHmac('sha256', this.cfg.hubWebhookSecret).update(body).digest('hex') : '';
    for (let a = 0; a < 3; a++) {
      try {
        const r = await this.fetchFn(this.cfg.hubWebhookUrl!, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Adri-Signature': sig }, body, signal: AbortSignal.timeout(5000) });
        if (r.ok) return;
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 300 * 2 ** a));
    }
    logger.warn('hub.webhook.failed');
  }
}
