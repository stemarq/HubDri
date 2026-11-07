// Canal Telegram para SIMULAR o chat de WhatsApp (mesmo agente, mesmos endpoints). Long polling: não precisa de URL pública.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ctx } from '../context.js';
import { uid } from '../db.js';
import { handleInbound, InboundInput } from '../agent/agent.js';
import { logger } from '../lib/logger.js';

export function parseUpdate(u: any): (InboundInput & { fileId?: string; chatId: string }) | undefined {
  const m = u?.message;
  if (!m?.chat?.id) return;
  const name = [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' ') || undefined;
  const base = { waId: `tg:${m.chat.id}`, chatId: String(m.chat.id), name, channel: 'TELEGRAM' as const, waMessageId: `tg:${u.update_id}` };
  if (typeof m.text === 'string') return { ...base, type: 'text', text: m.text };
  if (m.photo?.length) return { ...base, type: 'image', text: m.caption, fileId: m.photo[m.photo.length - 1].file_id };
  if (m.voice || m.audio) return { ...base, type: 'audio' };
  return { ...base, type: 'other' };
}

export class TelegramPoller {
  private offset = 0;
  private running = false;
  constructor(private ctx: Ctx, private fetchFn: typeof fetch = fetch, private pollSeconds = 25) {}
  private url(m: string) { return `https://api.telegram.org/bot${this.ctx.config.telegram.botToken}/${m}`; }

  private async download(fileId: string): Promise<string | undefined> {
    try {
      const meta: any = await (await this.fetchFn(`${this.url('getFile')}?file_id=${encodeURIComponent(fileId)}`)).json();
      const path: string = meta.result.file_path;
      const bin = await this.fetchFn(`https://api.telegram.org/file/bot${this.ctx.config.telegram.botToken}/${path}`);
      mkdirSync(this.ctx.mediaDir, { recursive: true });
      const p = join(this.ctx.mediaDir, `${uid()}.${path.split('.').pop() ?? 'jpg'}`);
      writeFileSync(p, Buffer.from(await bin.arrayBuffer()));
      return p;
    } catch (e) { logger.warn('telegram.media.failed', { err: (e as Error).message }); }
  }

  /** Processa um lote de updates; retorna quantos foram entregues ao agente. */
  async pollOnce(): Promise<number> {
    const res = await this.fetchFn(`${this.url('getUpdates')}?timeout=${this.pollSeconds}&offset=${this.offset}`, { signal: AbortSignal.timeout((this.pollSeconds + 10) * 1000) });
    if (!res.ok) throw new Error(`Telegram getUpdates ${res.status}`);
    const data: any = await res.json();
    const allowed = this.ctx.config.telegram.allowedChatIds;
    let n = 0;
    for (const u of data.result ?? []) {
      this.offset = Math.max(this.offset, u.update_id + 1);
      const inp = parseUpdate(u);
      if (!inp) continue;
      if (allowed.length && !allowed.includes(inp.chatId)) { logger.warn('telegram.chat.blocked', { chatId: inp.chatId }); continue; }
      try {
        const mediaPath = inp.fileId ? await this.download(inp.fileId) : undefined;
        await handleInbound(this.ctx, { ...inp, mediaPath });
        n++;
      } catch (e) { logger.error('telegram.update.failed', { id: u.update_id, err: (e as Error).message }); }
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
