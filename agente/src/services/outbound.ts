// Envio independente de canal: persistência, idempotência, retentativas e status. Quem fala com a rede é o adaptador.
import { basename } from 'node:path';
import { DB, one, run, uid } from '../db.js';
import { ChannelAdapter, ChannelError, ChannelName, ChannelRecipient, WhatsAppError } from '../channels/types.js';
import { logger } from '../lib/logger.js';

export interface SendResult { messageId: string; status: string; channel: ChannelName; simulated: boolean; error?: string }
export { WhatsAppError };

export class OutboundService {
  constructor(private db: DB, private adapters: Record<ChannelName, ChannelAdapter>, private now: () => Date = () => new Date(),
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))) {}

  private conv(id: string) {
    const r = one(this.db, 'SELECT c.*, cu.wa_id, cu.name FROM conversations c JOIN customers cu ON cu.id=c.customer_id WHERE c.id=?', id);
    if (!r) throw new ChannelError('CONVERSATION_NOT_FOUND');
    return r;
  }
  private record(conversationId: string, type: string, body: string, author: string, idem?: string, mediaPath?: string) {
    const id = uid();
    run(this.db, 'INSERT INTO messages(id,conversation_id,direction,idem_key,type,body,media_path,status,author,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      id, conversationId, 'OUT', idem ?? null, type, body, mediaPath ?? null, 'PENDING', author, this.now().getTime());
    return id;
  }
  private finish(id: string, status: string, attempts: number, error?: string) {
    run(this.db, 'UPDATE messages SET status=?, attempts=?, error=? WHERE id=?', status, attempts, error ?? null, id);
  }

  private async dispatch(conversationId: string, type: 'text' | 'document', body: string, author: string, idem: string | undefined, mediaPath: string | undefined,
    act: (a: ChannelAdapter, to: ChannelRecipient) => Promise<void>): Promise<SendResult> {
    const c = this.conv(conversationId);
    const adapter = this.adapters[c.channel as ChannelName];
    if (idem) {
      const dup = one(this.db, 'SELECT id,status FROM messages WHERE idem_key=?', idem);
      if (dup) return { messageId: dup.id, status: dup.status, channel: adapter.name, simulated: adapter.simulated };
    }
    const id = this.record(conversationId, type, body, author, idem, mediaPath);
    if (adapter.name === 'SIMULATOR') { this.finish(id, 'SIMULATED_DELIVERED', 0); return { messageId: id, status: 'SIMULATED_DELIVERED', channel: 'SIMULATOR', simulated: true }; }
    if (!adapter.ready()) { this.finish(id, 'FAILED', 0, `${adapter.name}_NOT_CONFIGURED`); throw new ChannelError(`${adapter.name}_NOT_CONFIGURED`); }
    const to: ChannelRecipient = { userId: c.wa_id, name: c.name, lastInboundAt: c.last_inbound_at, now: this.now() };
    let attempts = 0, last = '';
    while (attempts < 3) {
      attempts++;
      try {
        await act(adapter, to);
        this.finish(id, 'SENT', attempts);
        return { messageId: id, status: 'SENT', channel: adapter.name, simulated: adapter.simulated };
      } catch (e) {
        const err = e as ChannelError;
        last = err.message;
        if (err.code === 'WINDOW_CLOSED' || err.code === 'WINDOW_CLOSED_NO_TEMPLATE') { this.finish(id, 'BLOCKED_WINDOW', attempts, last); throw err; }
        logger.warn('channel.send.retry', { channel: adapter.name, attempt: attempts, err: last });
        if (err.permanent) break;
        await this.sleep(500 * 2 ** (attempts - 1));
      }
    }
    this.finish(id, 'FAILED', attempts, last);
    throw new ChannelError('SEND_FAILED', last);
  }

  sendText(conversationId: string, text: string, opts: { idemKey?: string; author?: string } = {}) {
    return this.dispatch(conversationId, 'text', text, opts.author ?? 'ADRI', opts.idemKey, undefined, (a, to) => a.sendText(to, text));
  }
  sendQuoteDocument(conversationId: string, pdfPath: string, caption: string, opts: { idemKey?: string; author?: string } = {}) {
    const filename = `Proposta-${basename(pdfPath)}`;
    return this.dispatch(conversationId, 'document', caption, opts.author ?? 'ADRIANA', opts.idemKey, pdfPath, (a, to) => a.sendDocument(to, { path: pdfPath, filename, caption }));
  }
}
