import { join } from 'node:path';
import { Config, googleCalendarConfigured } from './config.js';
import { DB, openDb } from './db.js';
import { CalendarAdapter, CalendarService, GoogleCalendarAdapter, SimulatedCalendarAdapter } from './services/calendar.js';
import { GoogleRoutesProvider, RouteProvider, SimulatedRouteProvider, TransportationEstimator } from './services/transport.js';
import { ChromePdfRenderer, PdfRenderer } from './services/pdf.js';
import { OutboundService } from './services/outbound.js';
import { ChannelAdapter, ChannelName } from './channels/types.js';
import { SimulatorAdapter } from './channels/simulator.js';
import { TelegramAdapter } from './channels/telegram.js';
import { WhatsAppCloudAdapter } from './channels/whatsappCloud.js';
import { EventBus } from './services/events.js';
import { getSetting } from './services/settings.js';

export interface Ctx {
  db: DB; config: Config; now: () => Date;
  channels: Record<ChannelName, ChannelAdapter>;
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
  const channels: Record<ChannelName, ChannelAdapter> = {
    SIMULATOR: new SimulatorAdapter(), TELEGRAM: new TelegramAdapter(config, overrides.fetchFn), WHATSAPP: new WhatsAppCloudAdapter(db, config, overrides.fetchFn),
  };
  return {
    db, config, now, channels,
    events: new EventBus(db, config, overrides.fetchFn),
    calendar: new CalendarService(db, adapter, () => getSetting(db, 'scheduling').bufferBetweenMinutes),
    transport: new TransportationEstimator(db, provider),
    pdf: overrides.pdf ?? new ChromePdfRenderer(join(config.dataDir, 'tmp'), config.chromePath),
    outbound: new OutboundService(db, channels, now, overrides.sleep),
    baseAddress: () => getSetting(db, 'transport').baseAddress ?? config.baseAddress,
    mediaDir: join(config.dataDir, 'media'), pdfDir: join(config.dataDir, 'pdf'),
  };
}
