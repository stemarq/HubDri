// Adaptador Telegram (simulação do WhatsApp): envio + recepção por long polling. Não contém regra de negócio.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Config } from '../config.js';
import { uid } from '../db.js';
import { logger } from '../lib/logger.js';
import { ChannelAdapter, ChannelError, ChannelRecipient, InboundEvent, httpError } from './types.js';

export const tgChat = (userId: string) => userId.replace(/^tg:/, '');

export class TelegramAdapter implements ChannelAdapter {
  readonly name = 'TELEGRAM' as const;
  readonly simulated = false; // entrega real pelo Telegram (não é o WhatsApp oficial)
  constructor(private cfg: Config, private fetchFn: typeof fetch = fetch) {}
  ready() { return !!this.cfg.telegram.botToken; }
  private api(m: string) { return `https://api.telegram.org/bot${this.cfg.telegram.botToken}/${m}`; }

  private async call(method: string, payload: Record<string, unknown> | FormData) {
    const form = payload instanceof FormData;
    let res: Response;
    try {
      res = await this.fetchFn(this.api(method), { method: 'POST', headers: form ? undefined : { 'Content-Type': 'application/json' },
        body: form ? payload : JSON.stringify(payload), signal: AbortSignal.timeout(20_000) });
    } catch (e) { throw new ChannelError('SEND_FAILED', (e as Error).message, false); }
    if (!res.ok) throw httpError('Telegram API', res.status);
  }
  async sendText(to: ChannelRecipient, text: string) { await this.call('sendMessage', { chat_id: tgChat(to.userId), text }); }
  async sendDocument(to: ChannelRecipient, f: { path: string; filename: string; caption: string }) {
    const form = new FormData();
    form.append('chat_id', tgChat(to.userId)); form.append('caption', f.caption);
    form.append('document', new Blob([readFileSync(f.path)], { type: 'application/pdf' }), f.filename);
    await this.call('sendDocument', form);
  }

  /** Converte um update do Telegram em InboundEvent (sem baixar mídia). */
  parseUpdate(u: any): (InboundEvent & { fileId?: string; chatId: string }) | undefined {
    const m = u?.message;
    if (!m?.chat?.id) return;
    const displayName = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' ') || undefined;
    const base = { channel: 'TELEGRAM' as const, userId: `tg:${m.chat.id}`, chatId: String(m.chat.id), displayName, handle: m.from?.username ? `@${m.from.username}` : undefined, messageId: `tg:${u.update_id}` };
    if (typeof m.text === 'string') return { ...base, type: 'text', text: m.text };
    if (m.photo?.length) return { ...base, type: 'image', text: m.caption, fileId: m.photo[m.photo.length - 1].file_id };
    if (m.voice || m.audio) return { ...base, type: 'audio', fileId: (m.voice ?? m.audio).file_id };
    return { ...base, type: 'other' };
  }

  async download(fileId: string, dir: string): Promise<string | undefined> {
    try {
      const meta: any = await (await this.fetchFn(`${this.api('getFile')}?file_id=${encodeURIComponent(fileId)}`)).json();
      const path: string = meta.result.file_path;
      const bin = await this.fetchFn(`https://api.telegram.org/file/bot${this.cfg.telegram.botToken}/${path}`);
      mkdirSync(dir, { recursive: true });
      const p = join(dir, `${uid()}.${path.split('.').pop() ?? 'bin'}`);
      writeFileSync(p, Buffer.from(await bin.arrayBuffer()));
      return p;
    } catch (e) { logger.warn('telegram.media.failed', { err: (e as Error).message }); }
  }

  /** Busca updates (long polling). Devolve eventos prontos e o próximo offset. */
  async fetchUpdates(offset: number, timeoutSec: number, mediaDir: string): Promise<{ events: InboundEvent[]; nextOffset: number }> {
    const res = await this.fetchFn(`${this.api('getUpdates')}?timeout=${timeoutSec}&offset=${offset}`, { signal: AbortSignal.timeout((timeoutSec + 10) * 1000) });
    if (!res.ok) throw new Error(`Telegram getUpdates ${res.status}`);
    const data: any = await res.json();
    const allowed = this.cfg.telegram.allowedChatIds;
    const events: InboundEvent[] = [];
    let next = offset;
    for (const u of data.result ?? []) {
      next = Math.max(next, u.update_id + 1);
      const ev = this.parseUpdate(u);
      if (!ev) continue;
      if (allowed.length && !allowed.includes(ev.chatId)) { logger.warn('telegram.chat.blocked', { chatId: ev.chatId }); continue; }
      const { fileId, chatId: _c, ...event } = ev;
      void _c;
      events.push({ ...event, mediaPath: fileId ? await this.download(fileId, mediaDir) : undefined });
    }
    return { events, nextOffset: next };
  }
}

/** Laço de polling: entrega cada evento ao motor conversacional via `onEvent`. */
export class TelegramPoller {
  private offset = 0;
  private running = false;
  constructor(private adapter: TelegramAdapter, private mediaDir: string, private onEvent: (e: InboundEvent) => Promise<unknown>, private pollSeconds = 25) {}

  async pollOnce(): Promise<number> {
    const { events, nextOffset } = await this.adapter.fetchUpdates(this.offset, this.pollSeconds, this.mediaDir);
    this.offset = nextOffset;
    let n = 0;
    for (const e of events) {
      try { await this.onEvent(e); n++; } catch (err) { logger.error('telegram.update.failed', { id: e.messageId, err: (err as Error).message }); }
    }
    return n;
  }
  start() {
    if (this.running) return;
    this.running = true;
    logger.info('telegram.polling.started');
    void (async () => {
      let backoff = 1000;
      while (this.running) {
        try { await this.pollOnce(); backoff = 1000; }
        catch (e) { logger.warn('telegram.poll.error', { err: (e as Error).message }); await new Promise((r) => setTimeout(r, backoff)); backoff = Math.min(backoff * 2, 30_000); }
      }
    })();
  }
  stop() { this.running = false; }
}
