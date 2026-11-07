import { join } from 'node:path';
import { Config, googleCalendarConfigured } from './config.js';
import { DB, openDb } from './db.js';
import { CalendarAdapter, CalendarService, GoogleCalendarAdapter, SimulatedCalendarAdapter } from './services/calendar.js';
import { GoogleRoutesProvider, RouteProvider, SimulatedRouteProvider, TransportationEstimator } from './services/transport.js';
import { ChromePdfRenderer, PdfRenderer } from './services/pdf.js';
import { OutboundService } from './services/whatsapp.js';
import { EventBus } from './services/events.js';
import { getSetting } from './services/settings.js';

export interface Ctx {
  db: DB; config: Config; now: () => Date;
  events: EventBus; calendar: CalendarService; transport: TransportationEstimator; pdf: PdfRenderer; outbound: OutboundService;
  baseAddress: () => string | undefined;
  mediaDir: string; pdfDir: string;
}

export function buildContext(config: Config, overrides: Partial<{ db: DB; now: () => Date; calendarAdapter: CalendarAdapter; routeProvider: RouteProvider; pdf: PdfRenderer; fetchFn: typeof fetch; sleep: (ms: number) => Promise<void> }> = {}): Ctx {
  const db = overrides.db ?? openDb(config.dbPath);
  const now = overrides.now ?? (() => new Date());
  const adapter = overrides.calendarAdapter ?? (googleCalendarConfigured(config)
    ? new GoogleCalendarAdapter({ calendarId: config.google.calendarId!, clientId: config.google.clientId!, clientSecret: config.google.clientSecret!, refreshToken: config.google.refreshToken! })
    : new SimulatedCalendarAdapter(db));
  const provider = overrides.routeProvider ?? (config.routeProvider === 'google' ? new GoogleRoutesProvider(config.google.mapsApiKey!) : new SimulatedRouteProvider());
  return {
    db, config, now,
    events: new EventBus(db, config, overrides.fetchFn),
    calendar: new CalendarService(db, adapter, () => getSetting(db, 'scheduling').bufferBetweenMinutes),
    transport: new TransportationEstimator(db, provider),
    pdf: overrides.pdf ?? new ChromePdfRenderer(join(config.dataDir, 'tmp'), config.chromePath),
    outbound: new OutboundService(db, config, overrides.fetchFn, overrides.sleep, now),
    baseAddress: () => getSetting(db, 'transport').baseAddress ?? config.baseAddress,
    mediaDir: join(config.dataDir, 'media'), pdfDir: join(config.dataDir, 'pdf'),
  };
}
