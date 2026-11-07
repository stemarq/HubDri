// WhatsApp Business Platform (Cloud API oficial). Sem credenciais, o canal da conversa é SIMULATOR e nada é enviado à Meta.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DB, one, run, uid } from '../db.js';
import { Config, whatsappConfigured } from '../config.js';
import { getSetting } from './settings.js';
import { logger } from '../lib/logger.js';

export function verifySignature(rawBody: Buffer | string, header: string | undefined, appSecret: string | undefined): boolean {
  if (!appSecret || !header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  let got: Buffer;
  try { got = Buffer.from(header.slice(7), 'hex'); } catch { return false; }
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export interface InboundMessage { waMessageId: string; from: string; name?: string; type: 'text' | 'image' | 'audio' | 'other'; text?: string; mediaId?: string; timestamp?: number }

export function parseWebhook(payload: any): InboundMessage[] {
  const out: InboundMessage[] = [];
  for (const entry of payload?.entry ?? []) for (const ch of entry?.changes ?? []) {
    const v = ch?.value;
    const names: Record<string, string> = {};
    for (const c of v?.contacts ?? []) names[c.wa_id] = c.profile?.name;
    for (const m of v?.messages ?? []) {
      const base = { waMessageId: m.id as string, from: m.from as string, name: names[m.from], timestamp: m.timestamp ? Number(m.timestamp) * 1000 : undefined };
      if (m.type === 'text') out.push({ ...base, type: 'text', text: m.text?.body });
      else if (m.type === 'image') out.push({ ...base, type: 'image', text: m.image?.caption, mediaId: m.image?.id });
      else if (m.type === 'audio') out.push({ ...base, type: 'audio', mediaId: m.audio?.id });
      else out.push({ ...base, type: 'other' });
    }
  }
  return out;
}

export interface SendResult { messageId: string; status: string; channel: 'SIMULATOR' | 'WHATSAPP' | 'TELEGRAM'; simulated: boolean; error?: string }
export class WhatsAppError extends Error { constructor(public code: string, msg?: string) { super(msg ?? code); } }

export const tgChat = (waId: string) => waId.replace(/^tg:/, '');
const WINDOW_MS = 24 * 3600 * 1000;

export class OutboundService {
  constructor(private db: DB, private cfg: Config, private fetchFn: typeof fetch = fetch,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)), private now: () => Date = () => new Date()) {}

  private conv(conversationId: string) {
    const r = one(this.db, 'SELECT c.*, cu.wa_id, cu.name FROM conversations c JOIN customers cu ON cu.id=c.customer_id WHERE c.id=?', conversationId);
    if (!r) throw new WhatsAppError('CONVERSATION_NOT_FOUND');
    return r;
  }
  private record(conversationId: string, type: string, body: string, status: string, author: string, idem?: string, mediaPath?: string) {
    const id = uid();
    run(this.db, 'INSERT INTO messages(id,conversation_id,direction,idem_key,type,body,media_path,status,author,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      id, conversationId, 'OUT', idem ?? null, type, body, mediaPath ?? null, status, author, this.now().getTime());
    return id;
  }
  private finish(id: string, status: string, attempts: number, error?: string) {
    run(this.db, 'UPDATE messages SET status=?, attempts=?, error=? WHERE id=?', status, attempts, error ?? null, id);
  }
  private duplicate(idem?: string): SendResult | undefined {
    if (!idem) return;
    const m = one(this.db, 'SELECT id,status FROM messages WHERE idem_key=?', idem);
    if (m) return { messageId: m.id, status: m.status, channel: 'WHATSAPP', simulated: false };
  }

  async sendText(conversationId: string, text: string, opts: { idemKey?: string; author?: string } = {}): Promise<SendResult> {
    const dup = this.duplicate(opts.idemKey); if (dup) return dup;
    const c = this.conv(conversationId);
    const id = this.record(conversationId, 'text', text, 'PENDING', opts.author ?? 'ADRI', opts.idemKey);
    if (c.channel === 'SIMULATOR') { this.finish(id, 'SIMULATED_DELIVERED', 0); return { messageId: id, status: 'SIMULATED_DELIVERED', channel: 'SIMULATOR', simulated: true }; }
    if (c.channel === 'TELEGRAM') return this.telegram(id, () => this.tg('sendMessage', { chat_id: tgChat(c.wa_id), text }));
    if (!whatsappConfigured(this.cfg)) { this.finish(id, 'FAILED', 0, 'WHATSAPP_NOT_CONFIGURED'); throw new WhatsAppError('WHATSAPP_NOT_CONFIGURED'); }
    if (this.now().getTime() - (c.last_inbound_at ?? 0) > WINDOW_MS) {
      this.finish(id, 'BLOCKED_WINDOW', 0, 'Fora da janela de 24h: só template aprovado pode ser enviado');
      throw new WhatsAppError('WINDOW_CLOSED', 'Fora da janela de 24h; texto livre bloqueado');
    }
    return this.deliver(id, () => this.post({ messaging_product: 'whatsapp', to: c.wa_id, type: 'text', text: { body: text, preview_url: false } }));
  }

  async sendQuoteDocument(conversationId: string, pdfPath: string, caption: string, opts: { idemKey?: string; author?: string } = {}): Promise<SendResult> {
    const dup = this.duplicate(opts.idemKey); if (dup) return dup;
    const c = this.conv(conversationId);
    const filename = `Proposta-${basename(pdfPath)}`;
    const id = this.record(conversationId, 'document', caption, 'PENDING', opts.author ?? 'ADRIANA', opts.idemKey, pdfPath);
    if (c.channel === 'SIMULATOR') { this.finish(id, 'SIMULATED_DELIVERED', 0); return { messageId: id, status: 'SIMULATED_DELIVERED', channel: 'SIMULATOR', simulated: true }; }
    if (c.channel === 'TELEGRAM') {
      return this.telegram(id, () => {
        const form = new FormData();
        form.append('chat_id', tgChat(c.wa_id));
        form.append('caption', caption);
        form.append('document', new Blob([readFileSync(pdfPath)], { type: 'application/pdf' }), filename);
        return this.tg('sendDocument', form);
      });
    }
    if (!whatsappConfigured(this.cfg)) { this.finish(id, 'FAILED', 0, 'WHATSAPP_NOT_CONFIGURED'); throw new WhatsAppError('WHATSAPP_NOT_CONFIGURED'); }
    const inWindow = this.now().getTime() - (c.last_inbound_at ?? 0) <= WINDOW_MS;
    const tpl = getSetting(this.db, 'whatsapp');
    if (!inWindow && !tpl.quoteTemplateName) {
      this.finish(id, 'BLOCKED_WINDOW', 0, 'Fora da janela de 24h e sem template configurado (whatsapp.quoteTemplateName)');
      throw new WhatsAppError('WINDOW_CLOSED_NO_TEMPLATE');
    }
    return this.deliver(id, async () => {
      const mediaId = await this.uploadMedia(pdfPath);
      if (inWindow) return this.post({ messaging_product: 'whatsapp', to: c.wa_id, type: 'document', document: { id: mediaId, filename, caption } });
      return this.post({ messaging_product: 'whatsapp', to: c.wa_id, type: 'template', template: { name: tpl.quoteTemplateName, language: { code: tpl.quoteTemplateLang },
        components: [{ type: 'header', parameters: [{ type: 'document', document: { id: mediaId, filename } }] }, { type: 'body', parameters: [{ type: 'text', text: c.name ?? 'cliente' }] }] } });
    });
  }

  /** Canal Telegram = simulação do chat (sem janela de 24h nem templates). */
  private async telegram(id: string, fn: () => Promise<unknown>): Promise<SendResult> {
    if (!this.cfg.telegram.botToken) { this.finish(id, 'FAILED', 0, 'TELEGRAM_NOT_CONFIGURED'); throw new WhatsAppError('TELEGRAM_NOT_CONFIGURED'); }
    const r = await this.deliver(id, fn);
    return { ...r, channel: 'TELEGRAM', simulated: true };
  }
  private async tg(method: string, payload: Record<string, unknown> | FormData) {
    const isForm = payload instanceof FormData;
    const res = await this.fetchFn(`https://api.telegram.org/bot${this.cfg.telegram.botToken}/${method}`, {
      method: 'POST', headers: isForm ? undefined : { 'Content-Type': 'application/json' }, body: isForm ? payload : JSON.stringify(payload), signal: AbortSignal.timeout(20_000) });
    if (!res.ok) { const e: any = new Error(`Telegram API ${res.status}`); e.permanent = res.status < 500 && res.status !== 429; throw e; }
    return res.json();
  }

  private async deliver(id: string, fn: () => Promise<any>): Promise<SendResult> {
    let attempts = 0, lastErr = '';
    for (; attempts < 3;) {
      attempts++;
      try {
        await fn();
        this.finish(id, 'SENT', attempts);
        return { messageId: id, status: 'SENT', channel: 'WHATSAPP', simulated: false };
      } catch (e: any) {
        lastErr = e.message;
        logger.warn('whatsapp.send.retry', { attempt: attempts, err: lastErr });
        if (e.permanent) break;
        await this.sleep(500 * 2 ** (attempts - 1));
      }
    }
    this.finish(id, 'FAILED', attempts, lastErr);
    throw new WhatsAppError('SEND_FAILED', lastErr);
  }

  private base() { return `https://graph.facebook.com/${this.cfg.whatsapp.apiVersion}/${this.cfg.whatsapp.phoneNumberId}`; }
  private async post(body: unknown) {
    const res = await this.fetchFn(`${this.base()}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${this.cfg.whatsapp.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) { const e: any = new Error(`WhatsApp API ${res.status}`); e.permanent = res.status < 500 && res.status !== 429; throw e; }
    return res.json();
  }
  private async uploadMedia(path: string): Promise<string> {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp'); form.append('type', 'application/pdf');
    form.append('file', new Blob([readFileSync(path)], { type: 'application/pdf' }), basename(path));
    const res = await this.fetchFn(`${this.base()}/media`, { method: 'POST', headers: { Authorization: `Bearer ${this.cfg.whatsapp.accessToken}` }, body: form, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) { const e: any = new Error(`WhatsApp media ${res.status}`); e.permanent = res.status < 500 && res.status !== 429; throw e; }
    return ((await res.json()) as any).id;
  }

  /** Baixa mídia recebida (imagem/áudio) para armazenamento local. */
  async downloadMedia(mediaId: string, dir: string, ext: string): Promise<string | undefined> {
    if (!whatsappConfigured(this.cfg)) return;
    try {
      const meta: any = await (await this.fetchFn(`https://graph.facebook.com/${this.cfg.whatsapp.apiVersion}/${mediaId}`, { headers: { Authorization: `Bearer ${this.cfg.whatsapp.accessToken}` } })).json();
      const bin = await this.fetchFn(meta.url, { headers: { Authorization: `Bearer ${this.cfg.whatsapp.accessToken}` } });
      mkdirSync(dir, { recursive: true });
      const p = join(dir, `${uid()}.${ext}`);
      writeFileSync(p, Buffer.from(await bin.arrayBuffer()));
      return p;
    } catch (e) { logger.warn('whatsapp.media.failed', { err: (e as Error).message }); }
  }
}
