import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { SettingOf } from './settings.js';
import { brl, epochToLocal, fmtDateLong, fmtEpochTime } from '../lib/time.js';

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export interface QuotePdfData {
  number: number; customerName: string; serviceCode: string; serviceName: string;
  eventType?: string; role?: string; date: string; startEpoch: number; endEpoch: number; address: string;
  items: { kind: string; label: string; amountCents: number }[]; totalCents: number; validUntil: string; notes?: string;
  branding: SettingOf<'branding'>; simulatedTransport?: boolean;
}

const TEMPLATES: Record<string, { title: string; tagline: string; defaultDesc: string }> = {
  MAKEUP: { title: 'Proposta de Maquiagem', tagline: 'Maquiagem pensada para o seu rosto e para o seu momento', defaultDesc: 'Maquiagem personalizada com visagismo, a domicílio.' },
  HAIR: { title: 'Proposta de Penteado', tagline: 'Penteado que valoriza o seu estilo', defaultDesc: 'Penteado personalizado, a domicílio.' },
  MAKEUP_HAIR: { title: 'Proposta de Maquiagem e Penteado', tagline: 'Make e cabelo em harmonia', defaultDesc: 'Maquiagem e penteado personalizados com visagismo, a domicílio.' },
  BRIDE_PACKAGE: { title: 'Proposta para Noivas', tagline: 'O seu grande dia merece um cuidado especial', defaultDesc: 'Pacote de noiva com maquiagem e penteado personalizados com visagismo, a domicílio.' },
};

function dataUri(path: string): string | null {
  try {
    if (/^https?:\/\//.test(path)) return path;
    const p = resolve(path);
    const ext = extname(p).slice(1).toLowerCase().replace('jpg', 'jpeg');
    return `data:image/${ext === 'svg' ? 'svg+xml' : ext};base64,${readFileSync(p).toString('base64')}`;
  } catch { return null; }
}

export function renderQuoteHtml(d: QuotePdfData): string {
  const t = TEMPLATES[d.serviceCode] ?? TEMPLATES.MAKEUP_HAIR;
  const b = d.branding;
  const logo = b.logoPath ? dataUri(b.logoPath) : null;
  const photos = b.photos.map(dataUri).filter(Boolean) as string[];
  const desc = b.serviceDescriptions[d.serviceCode] ?? t.defaultDesc;
  const rows = d.items.map((i) => `<tr><td>${esc(i.label)}</td><td class="r ${i.amountCents < 0 ? 'neg' : ''}">${esc(brl(i.amountCents))}</td></tr>`).join('');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><style>
@page { size: A4; margin: 0 }
:root { --p: ${b.primaryColor}; --a: ${b.accentColor}; }
* { box-sizing: border-box } body { margin:0; font-family: 'Georgia', serif; color:#3a2f33; }
.top { background: var(--a); padding: 36px 48px; display:flex; align-items:center; gap:24px; border-bottom: 4px solid var(--p) }
.top img { height: 72px } .top h1 { margin:0; font-size: 26px; color: var(--p); font-weight: 600 } .top p { margin:4px 0 0; font-style: italic; font-size: 13px }
.wrap { padding: 28px 48px } .grid { display:grid; grid-template-columns: 1fr 1fr; gap: 10px 32px; margin: 12px 0 22px }
.k { font: 11px/1.2 Arial, sans-serif; text-transform: uppercase; letter-spacing: .08em; color: var(--p) } .v { font-size: 15px; margin-top: 2px }
h2 { font-size: 15px; color: var(--p); border-bottom: 1px solid var(--a); padding-bottom: 4px; margin: 22px 0 8px }
table { width:100%; border-collapse: collapse } td { padding: 9px 4px; border-bottom: 1px solid #eee; font-size: 14px } td.r { text-align:right; white-space:nowrap } .neg { color:#2e7d4f }
.total td { font-weight: 700; font-size: 17px; border-top: 2px solid var(--p); border-bottom: 0; color: var(--p) }
.photos { display:flex; gap:10px; margin-top: 12px } .photos img { height: 110px; border-radius: 8px; object-fit: cover; flex:1; min-width:0 }
.small { font: 12px/1.5 Arial, sans-serif; color:#6b5b61 } .foot { position: fixed; bottom: 0; left:0; right:0; padding: 14px 48px; background: var(--a); font: 11px Arial; color: #6b5b61 }
</style></head><body>
<div class="top">${logo ? `<img src="${esc(logo)}" alt="">` : ''}<div><h1>${esc(t.title)}</h1><p>${esc(t.tagline)}</p></div></div>
<div class="wrap">
  <div class="grid">
    <div><div class="k">Cliente</div><div class="v">${esc(d.customerName)}</div></div>
    <div><div class="k">Proposta nº</div><div class="v">${String(d.number).padStart(4, '0')}</div></div>
    <div><div class="k">Data</div><div class="v">${esc(fmtDateLong(d.date))}</div></div>
    <div><div class="k">Atendimento</div><div class="v">${esc(fmtEpochTime(d.startEpoch))} às ${esc(fmtEpochTime(d.endEpoch))}</div></div>
    <div><div class="k">Ocasião</div><div class="v">${esc([d.eventType, d.role].filter(Boolean).join(' · ') || '—')}</div></div>
    <div><div class="k">Local</div><div class="v">${esc(d.address)}</div></div>
  </div>
  <h2>Serviço</h2><p class="small">${esc(desc)}</p>
  <h2>Investimento</h2>
  <table>${rows}<tr class="total"><td>Total</td><td class="r">${esc(brl(d.totalCents))}</td></tr></table>
  ${d.simulatedTransport ? '<p class="small">O deslocamento é uma estimativa e pode ser ajustado.</p>' : ''}
  ${photos.length ? `<div class="photos">${photos.map((p) => `<img src="${esc(p)}" alt="">`).join('')}</div>` : ''}
  <h2>Condições</h2>
  <p class="small">${esc(b.paymentTerms ?? 'Condições de pagamento a combinar com a Adriana.')}</p>
  <p class="small">Proposta válida até ${esc(d.validUntil.split('-').reverse().join('/'))}. Horários sujeitos à confirmação da agenda.</p>
  ${d.notes ? `<p class="small">${esc(d.notes)}</p>` : ''}
</div><div class="foot">${esc(b.businessName)}</div></body></html>`;
}

export interface PdfRenderer { render(html: string, outPath: string): Promise<void> }

export function detectChrome(explicit?: string): string | undefined {
  const c = [explicit, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  return c.find((p) => p && existsSync(p));
}

export class ChromePdfRenderer implements PdfRenderer {
  constructor(private tmpDir: string, private chromePath?: string) {}
  async render(html: string, outPath: string) {
    const bin = detectChrome(this.chromePath);
    if (!bin) throw new Error('PDF_RENDERER_UNAVAILABLE: instale Chrome/Edge ou defina CHROME_PATH');
    mkdirSync(this.tmpDir, { recursive: true });
    mkdirSync(join(outPath, '..'), { recursive: true });
    const id = randomUUID();
    const htmlPath = resolve(this.tmpDir, `${id}.html`);
    const profile = resolve(this.tmpDir, `profile-${id}`);
    writeFileSync(htmlPath, html);
    try {
      await new Promise<void>((ok, fail) =>
        execFile(bin, ['--headless', '--disable-gpu', '--no-sandbox', '--no-pdf-header-footer', `--user-data-dir=${profile}`, `--print-to-pdf=${resolve(outPath)}`, pathToFileURL(htmlPath).href],
          { timeout: 45_000 }, (err) => (err ? fail(err) : ok())));
      if (!existsSync(outPath)) throw new Error('PDF não gerado');
    } finally {
      rmSync(htmlPath, { force: true }); rmSync(profile, { recursive: true, force: true });
    }
  }
}
export { epochToLocal };
