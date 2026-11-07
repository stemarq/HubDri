import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildContext, Ctx } from '../src/context.js';
import { openDb } from '../src/db.js';
import { seedDemo } from '../src/scripts/seedDemo.js';
import { PdfRenderer } from '../src/services/pdf.js';
import { SimulatedCalendarAdapter } from '../src/services/calendar.js';
import { RouteProvider, SimulatedRouteProvider } from '../src/services/transport.js';
import { handleInbound } from '../src/agent/agent.js';
import { setLoggerSilent } from '../src/lib/logger.js';
import { localToEpoch } from '../src/lib/time.js';

setLoggerSilent(true);
// Segunda-feira 2026-11-09 10:00 em São Paulo. O sábado seguinte é 2026-11-14.
export const NOW = new Date('2026-11-09T13:00:00Z');
export const SAT = '2026-11-14';

export class FakePdf implements PdfRenderer {
  fail = false; count = 0;
  async render(html: string, out: string) {
    if (this.fail) throw new Error('PDF_RENDERER_UNAVAILABLE');
    mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, `%PDF-fake\n${html.length}`); this.count++;
  }
}

export function makeCtx(opts: { seed?: boolean; env?: Record<string, string>; routeProvider?: RouteProvider; fetchFn?: typeof fetch } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'adri-'));
  const config = loadConfig({ ADMIN_API_TOKEN: 'test-token', SIMULAR: '1', DATA_DIR: dir, DB_PATH: ':memory:', ...(opts.env ?? {}) } as NodeJS.ProcessEnv);
  const db = openDb(':memory:');
  if (opts.seed !== false) seedDemo(db);
  const pdf = new FakePdf();
  const ctx: Ctx = buildContext(config, { db, now: () => NOW, pdf, routeProvider: opts.routeProvider ?? new SimulatedRouteProvider(), calendarAdapter: new SimulatedCalendarAdapter(db), fetchFn: opts.fetchFn, sleep: async () => {} });
  return { ctx, pdf, calendar: ctx.calendar.adapter as SimulatedCalendarAdapter };
}

export const chat = (ctx: Ctx, waId: string) => async (text: string, extra: Partial<Parameters<typeof handleInbound>[1]> = {}) =>
  handleInbound(ctx, { waId, channel: 'SIMULATOR', type: 'text', text, ...extra });

export const busy = (cal: SimulatedCalendarAdapter, title: string, date: string, from: string, to: string) => {
  const m = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  return cal.addBusy(title, localToEpoch(date, m(from)), localToEpoch(date, m(to)));
};
