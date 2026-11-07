// Adaptador WhatsApp Business Platform (Cloud API oficial): webhook, assinatura, envio, janela de 24h e templates.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Config, whatsappConfigured } from '../config.js';
import { DB, uid } from '../db.js';
import { getSetting } from '../services/settings.js';
import { logger } from '../lib/logger.js';
import { ChannelAdapter, ChannelError, ChannelRecipient, InboundEvent, httpError } from './types.js';

const WINDOW_MS = 24 * 3600 * 1000;

export function verifySignature(rawBody: Buffer | string, header: string | undefined, appSecret: string | undefined): boolean {
  if (!appSecret || !header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  let got: Buffer;
  try { got = Buffer.from(header.slice(7), 'hex'); } catch { return false; }
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export interface RawWhatsAppMessage { id: string; from: string; name?: string; type: 'text' | 'image' | 'audio' | 'other'; text?: string; mediaId?: string }
export function parseWebhook(payload: any): RawWhatsAppMessage[] {
  const out: RawWhatsAppMessage[] = [];
  for (const entry of payload?.entry ?? []) for (const ch of entry?.changes ?? []) {
    const v = ch?.value;
    const names: Record<string, string> = {};
    for (const c of v?.contacts ?? []) names[c.wa_id] = c.profile?.name;
    for (const m of v?.messages ?? []) {
      const base = { id: m.id as string, from: m.from as string, name: names[m.from] };
      if (m.type === 'text') out.push({ ...base, type: 'text', text: m.text?.body });
      else if (m.type === 'image') out.push({ ...base, type: 'image', text: m.image?.caption, mediaId: m.image?.id });
      else if (m.type === 'audio') out.push({ ...base, type: 'audio', mediaId: m.audio?.id });
      else out.push({ ...base, type: 'other' });
    }
  }
  return out;
}

export class WhatsAppCloudAdapter implements ChannelAdapter {
  readonly name = 'WHATSAPP' as const;
  readonly simulated = false;
  constructor(private db: DB, private cfg: Config, private fetchFn: typeof fetch = fetch) {}
  ready() { return whatsappConfigured(this.cfg); }

  private base() { return `https://graph.facebook.com/${this.cfg.whatsapp.apiVersion}/${this.cfg.whatsapp.phoneNumberId}`; }
  private auth() { return { Authorization: `Bearer ${this.cfg.whatsapp.accessToken}` }; }
  private async post(body: unknown) {
    const res = await this.fetchFn(`${this.base()}/messages`, { method: 'POST', headers: { ...this.auth(), 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw httpError('WhatsApp API', res.status);
  }
  private async uploadMedia(path: string): Promise<string> {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp'); form.append('type', 'application/pdf');
    form.append('file', new Blob([readFileSync(path)], { type: 'application/pdf' }), basename(path));
    const res = await this.fetchFn(`${this.base()}/media`, { method: 'POST', headers: this.auth(), body: form, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw httpError('WhatsApp media', res.status);
    return ((await res.json()) as any).id;
  }
  private inWindow(to: ChannelRecipient) { return to.now.getTime() - (to.lastInboundAt ?? 0) <= WINDOW_MS; }

  async sendText(to: ChannelRecipient, text: string) {
    if (!this.inWindow(to)) throw new ChannelError('WINDOW_CLOSED', 'Fora da janela de 24h: texto livre bloqueado; só template aprovado');
    await this.post({ messaging_product: 'whatsapp', to: to.userId, type: 'text', text: { body: text, preview_url: false } });
  }

  async sendDocument(to: ChannelRecipient, f: { path: string; filename: string; caption: string }) {
    const tpl = getSetting(this.db, 'whatsapp');
    const open = this.inWindow(to);
    if (!open && !tpl.quoteTemplateName) throw new ChannelError('WINDOW_CLOSED_NO_TEMPLATE', 'Fora da janela de 24h e sem template (whatsapp.quoteTemplateName)');
    const mediaId = await this.uploadMedia(f.path);
    if (open) return this.post({ messaging_product: 'whatsapp', to: to.userId, type: 'document', document: { id: mediaId, filename: f.filename, caption: f.caption } });
    return this.post({ messaging_product: 'whatsapp', to: to.userId, type: 'template', template: { name: tpl.quoteTemplateName, language: { code: tpl.quoteTemplateLang },
      components: [{ type: 'header', parameters: [{ type: 'document', document: { id: mediaId, filename: f.filename } }] }, { type: 'body', parameters: [{ type: 'text', text: to.name ?? 'cliente' }] }] } });
  }

  /** Webhook -> eventos normalizados (baixa a mídia quando houver). */
  async toEvents(payload: unknown, mediaDir: string): Promise<InboundEvent[]> {
    const out: InboundEvent[] = [];
    for (const m of parseWebhook(payload)) {
      out.push({ channel: 'WHATSAPP', userId: m.from, displayName: m.name, messageId: m.id, type: m.type, text: m.text,
        mediaPath: m.mediaId ? await this.downloadMedia(m.mediaId, mediaDir, m.type === 'image' ? 'jpg' : 'ogg') : undefined });
    }
    return out;
  }

  async downloadMedia(mediaId: string, dir: string, ext: string): Promise<string | undefined> {
    if (!this.ready()) return;
    try {
      const meta: any = await (await this.fetchFn(`https://graph.facebook.com/${this.cfg.whatsapp.apiVersion}/${mediaId}`, { headers: this.auth() })).json();
      const bin = await this.fetchFn(meta.url, { headers: this.auth() });
      mkdirSync(dir, { recursive: true });
      const p = join(dir, `${uid()}.${ext}`);
      writeFileSync(p, Buffer.from(await bin.arrayBuffer()));
      return p;
    } catch (e) { logger.warn('whatsapp.media.failed', { err: (e as Error).message }); }
  }
}
