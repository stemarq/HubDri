import express, { NextFunction, Request, Response } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { z, ZodError } from 'zod';
import { Ctx } from './context.js';
import { whatsappConfigured } from './config.js';
import { all, one, parse } from './db.js';
import { handleEvent, handleInbound, handoff, resume, saveInboundMedia } from './agent/agent.js';
import * as Q from './services/quotes.js';
import { calculatePrice } from './services/pricing.js';
import { planVisit } from './services/planner.js';
import { verifySignature, WhatsAppCloudAdapter } from './channels/whatsappCloud.js';
import { WhatsAppError } from './channels/types.js';
import { SimulatedCalendarAdapter } from './services/calendar.js';
import { RouteError } from './services/transport.js';
import * as A from './services/analytics.js';
import { SETTING_SCHEMAS, SettingKey, PricingSettingsInput, getSetting, readPricingSettings, setSetting, writePricingSettings } from './services/settings.js';
import { localToEpoch, parseHM, toIso } from './lib/time.js';
import { logger } from './lib/logger.js';

const wrap = (fn: (req: Request, res: Response) => Promise<unknown> | unknown) => (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res)).catch(next);
const sha = (s: string) => createHash('sha256').update(s).digest();
const actorOf = (req: Request) => String(req.header('x-actor') ?? 'hub').slice(0, 60);
const IsoOrLocal = z.union([z.string().datetime({ offset: true }), z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), time: z.string().regex(/^\d{2}:\d{2}$/) })]);
const toEpoch = (v: z.infer<typeof IsoOrLocal>) => (typeof v === 'string' ? Date.parse(v) : localToEpoch(v.date, parseHM(v.time)));

export function createApp(ctx: Ctx) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '12mb', verify: (req: any, _res, buf) => { req.rawBody = buf; } }));

  app.get('/health', (_q, res) => res.json({ ok: true, whatsapp: whatsappConfigured(ctx.config) ? 'official-cloud-api' : 'simulator-only',
    calendar: ctx.calendar.adapter.name, routes: ctx.config.routeProvider === 'google' ? 'google-routes' : 'simulated-routes' }));

  // ---------- WhatsApp Cloud API ----------
  app.get('/webhooks/whatsapp', (req, res) => {
    if (!whatsappConfigured(ctx.config)) return res.status(503).json({ error: 'WHATSAPP_NOT_CONFIGURED' });
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === ctx.config.whatsapp.verifyToken) return res.status(200).send(String(req.query['hub.challenge']));
    res.sendStatus(403);
  });
  app.post('/webhooks/whatsapp', wrap(async (req: any, res) => {
    if (!whatsappConfigured(ctx.config)) return res.status(503).json({ error: 'WHATSAPP_NOT_CONFIGURED' });
    if (!verifySignature(req.rawBody ?? '', req.header('x-hub-signature-256'), ctx.config.whatsapp.appSecret)) return res.sendStatus(401);
    const events = await (ctx.channels.WHATSAPP as WhatsAppCloudAdapter).toEvents(req.body, ctx.mediaDir);
    for (const ev of events) {
      try { await handleEvent(ctx, ev); } catch (e) { logger.error('webhook.message.failed', { id: ev.messageId, err: (e as Error).message }); }
    }
    res.sendStatus(200); // 200 sempre após persistir: retentativas da Meta são deduplicadas por wa_message_id
  }));

  // ---------- Simulador (página pública; as chamadas exigem o token) ----------
  app.get('/simulator', (_q, res) => res.sendFile(resolve('public/simulator.html')));

  // ---------- Autenticação admin ----------
  app.use('/api', (req, res, next) => {
    if (!ctx.config.adminToken) return res.status(503).json({ error: 'ADMIN_TOKEN_NOT_CONFIGURED' });
    const m = /^Bearer (.+)$/.exec(req.header('authorization') ?? '');
    if (!m || !timingSafeEqual(sha(m[1]), sha(ctx.config.adminToken))) return res.status(401).json({ error: 'UNAUTHORIZED' });
    next();
  });

  // ---------- Chat (simulador / testes) ----------
  const ChatBody = z.object({ from: z.string().min(3).max(40), name: z.string().max(80).optional(), text: z.string().max(2000).optional(),
    type: z.enum(['text', 'image', 'audio']).default('text'), imageBase64: z.string().optional(), imageExt: z.string().default('jpg'), messageId: z.string().max(100).optional() });
  app.post('/api/chat/message', wrap(async (req, res) => {
    const b = ChatBody.parse(req.body);
    const existing = one(ctx.db, 'SELECT c.channel FROM conversations c JOIN customers u ON u.id=c.customer_id WHERE u.wa_id=?', b.from);
    if (existing && existing.channel !== 'SIMULATOR') return res.status(409).json({ error: 'REAL_WHATSAPP_CUSTOMER', message: 'Este número pertence a uma conversa real do WhatsApp' });
    const mediaPath = b.imageBase64 ? saveInboundMedia(ctx, b.imageBase64, b.imageExt) : undefined;
    const r = await handleInbound(ctx, { waId: b.from, name: b.name, channel: 'SIMULATOR', type: b.imageBase64 ? 'image' : b.type, text: b.text, waMessageId: b.messageId, mediaPath });
    res.json({ ...r, channel: 'SIMULATOR' });
  }));

  // ---------- Conversas ----------
  const convSummary = (c: any) => {
    const last = one(ctx.db, 'SELECT body,direction,created_at FROM messages WHERE conversation_id=? ORDER BY created_at DESC LIMIT 1', c.id);
    const q = one(ctx.db, 'SELECT id,status FROM quotes WHERE conversation_id=? ORDER BY created_at DESC LIMIT 1', c.id);
    return { id: c.id, customer: { id: c.customer_id, name: c.name, waId: c.wa_id }, channel: c.channel, mode: c.mode,
      lastMessage: last ? { body: last.body, direction: last.direction, at: last.created_at } : null, latestQuote: q ? { id: q.id, status: q.status } : null, updatedAt: c.updated_at };
  };
  app.get('/api/conversations', (_q, res) => res.json({ conversations: all(ctx.db, 'SELECT c.*, u.name, u.wa_id FROM conversations c JOIN customers u ON u.id=c.customer_id ORDER BY c.updated_at DESC').map(convSummary) }));
  app.get('/api/conversations/:id', (req, res) => {
    const c = one(ctx.db, 'SELECT c.*, u.name, u.wa_id FROM conversations c JOIN customers u ON u.id=c.customer_id WHERE c.id=?', req.params.id);
    if (!c) return res.status(404).json({ error: 'NOT_FOUND' });
    const st = parse<any>(c.state, {});
    res.json({ ...convSummary(c), collected: st.slots ?? null, awaiting: st.awaiting ?? null,
      messages: all(ctx.db, 'SELECT id,direction,type,body,author,status,error,created_at FROM messages WHERE conversation_id=? ORDER BY created_at', c.id)
        .map((m) => ({ id: m.id, direction: m.direction, type: m.type, body: m.body, author: m.author, status: m.status, error: m.error, at: m.created_at })),
      quotes: all(ctx.db, 'SELECT id FROM quotes WHERE conversation_id=? ORDER BY created_at DESC', c.id).map((r) => r.id) });
  });
  app.post('/api/conversations/:id/handoff', (req, res) => {
    if (!one(ctx.db, 'SELECT id FROM conversations WHERE id=?', req.params.id)) return res.status(404).json({ error: 'NOT_FOUND' });
    handoff(ctx, req.params.id, `HUB:${actorOf(req)}`); res.json({ id: req.params.id, mode: 'HUMAN' });
  });
  app.post('/api/conversations/:id/resume', (req, res) => {
    if (!one(ctx.db, 'SELECT id FROM conversations WHERE id=?', req.params.id)) return res.status(404).json({ error: 'NOT_FOUND' });
    resume(ctx, req.params.id); res.json({ id: req.params.id, mode: 'AI' });
  });
  app.post('/api/conversations/:id/messages', wrap(async (req, res) => {
    const { text } = z.object({ text: z.string().min(1).max(2000) }).parse(req.body);
    if (!one(ctx.db, 'SELECT id FROM conversations WHERE id=?', req.params.id)) return res.status(404).json({ error: 'NOT_FOUND' });
    res.status(201).json(await ctx.outbound.sendText(req.params.id, text, { author: 'ADRIANA' }));
  }));

  // ---------- Disponibilidade / deslocamento / preço ----------
  const AvailBody = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), readyTime: z.string().regex(/^\d{2}:\d{2}$/).optional(), startTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    serviceCode: z.string(), address: z.string().min(2), weather: z.enum(['rain', 'clear']).nullish() }).refine((b) => b.readyTime || b.startTime, 'readyTime ou startTime');
  app.post('/api/availability/check', wrap(async (req, res) => {
    const b = AvailBody.parse(req.body);
    const plan = await planVisit(ctx.db, ctx.transport, ctx.baseAddress(), { date: b.date, readyMin: b.readyTime ? parseHM(b.readyTime) : undefined, desiredStartMin: b.startTime ? parseHM(b.startTime) : undefined, serviceCode: b.serviceCode, destination: b.address, weather: b.weather ?? null });
    const block: [number, number] = plan.travelVerified ? [plan.departureEpoch, plan.returnArrivalEpoch] : [plan.arrivalEpoch, plan.returnDepartureEpoch];
    const av = await ctx.calendar.check(block[0], block[1]);
    res.json({ available: av.available, calendar: av.calendar, calendarSimulated: av.simulated, calendarVerified: av.verified, travelVerified: plan.travelVerified, routeError: plan.routeError ?? null,
      conflicts: av.conflicts.map((c) => ({ title: c.title, start: toIso(c.startEpoch), end: toIso(c.endEpoch) })),
      times: { readyBy: plan.readyEpoch ? toIso(plan.readyEpoch) : null, departure: toIso(plan.departureEpoch), arrival: toIso(plan.arrivalEpoch), serviceStart: toIso(plan.startEpoch), serviceEnd: toIso(plan.endEpoch), returnDeparture: toIso(plan.returnDepartureEpoch), returnArrival: toIso(plan.returnArrivalEpoch) } });
  }));
  app.post('/api/calendar/events', wrap(async (req, res) => {
    if (!(ctx.calendar.adapter instanceof SimulatedCalendarAdapter)) return res.status(409).json({ error: 'REAL_CALENDAR_IN_USE', message: 'Crie eventos no Google Calendar' });
    const b = z.object({ title: z.string().min(1), start: z.string().datetime({ offset: true }), end: z.string().datetime({ offset: true }) }).parse(req.body);
    res.status(201).json(await ctx.calendar.adapter.addBusy(b.title, Date.parse(b.start), Date.parse(b.end)));
  }));

  app.post('/api/transport/estimate', wrap(async (req, res) => {
    const b = z.object({ origin: z.string().optional(), destination: z.string().min(2), departAt: IsoOrLocal, leg: z.enum(['OUTBOUND', 'RETURN']).default('OUTBOUND'), weather: z.enum(['rain', 'clear']).nullish() }).parse(req.body);
    const origin = b.origin ?? ctx.baseAddress();
    if (!origin) return res.status(422).json({ error: 'ORIGIN_REQUIRED', message: 'Informe origin ou configure transport.baseAddress' });
    try { res.json(await ctx.transport.estimateLeg({ leg: b.leg, origin, destination: b.destination, departEpoch: toEpoch(b.departAt), weather: b.weather ?? null })); }
    catch (e) { if (e instanceof RouteError) return res.status(502).json({ error: 'ROUTE_UNAVAILABLE', message: e.message }); throw e; }
  }));
  app.post('/api/transport/actual', wrap(async (req, res) => {
    const b = z.object({ estimateId: z.string().optional(), actualCents: z.number().int().min(0), discountCents: z.number().int().min(0).optional(), weather: z.string().nullish(),
      trip: z.object({ date: z.string(), leg: z.string().optional(), origin: z.string(), destination: z.string(), distanceM: z.number().optional(), departMinutes: z.number(), predictedCents: z.number().optional(), formulaCents: z.number().optional() }).optional() }).parse(req.body);
    try { const id = ctx.transport.recordActual(b); ctx.events.emit('TRANSPORT_ACTUAL_RECORDED', { historyId: id }); res.status(201).json({ id }); }
    catch (e) { const m = (e as Error).message; if (m === 'ESTIMATE_NOT_FOUND') return res.status(404).json({ error: m }); if (m === 'TRIP_REQUIRED') return res.status(422).json({ error: m }); throw e; }
  }));
  app.post('/api/pricing/calculate', wrap(async (req, res) => {
    const b = z.object({ serviceCode: z.string(), startAt: IsoOrLocal, transportCents: z.number().int().min(0).nullable().default(null), addons: z.array(z.string()).optional(), discountCode: z.string().optional() }).parse(req.body);
    res.json(calculatePrice(ctx.db, { serviceCode: b.serviceCode, startEpoch: toEpoch(b.startAt), transportCents: b.transportCents, addons: b.addons, discountCode: b.discountCode }));
  }));

  // ---------- Orçamentos ----------
  app.get('/api/quotes', (req, res) => res.json({ quotes: Q.listQuotes(ctx, req.query.status ? String(req.query.status) : undefined) }));
  app.get('/api/quotes/:id', (req, res) => { const v = Q.quoteView(ctx, req.params.id, true); v ? res.json(v) : res.status(404).json({ error: 'QUOTE_NOT_FOUND' }); });
  app.patch('/api/quotes/:id', wrap(async (req, res) => res.json(await Q.patchQuote(ctx, req.params.id, Q.PatchInput.parse(req.body), actorOf(req)))));
  app.post('/api/quotes/:id/approve', wrap((req, res) => res.json(Q.approve(ctx, req.params.id, actorOf(req)))));
  app.post('/api/quotes/:id/reject', wrap((req, res) => res.json(Q.reject(ctx, req.params.id, z.object({ reason: z.string().max(500).default('') }).parse(req.body ?? {}).reason, actorOf(req)))));
  app.post('/api/quotes/:id/request-info', wrap(async (req, res) => res.json(await Q.requestInfo(ctx, req.params.id, z.object({ question: z.string().min(1).max(1000) }).parse(req.body).question, actorOf(req)))));
  app.post('/api/quotes/:id/send', wrap(async (req, res) => res.json(await Q.sendQuote(ctx, req.params.id, actorOf(req)))));
  app.post('/api/quotes/:id/accept', wrap(async (req, res) => res.json(await Q.acceptQuote(ctx, req.params.id, actorOf(req)))));
  app.post('/api/quotes/:id/lost', wrap((req, res) => res.json(Q.markLost(ctx, req.params.id, z.object({ reason: z.string().max(300).optional() }).parse(req.body ?? {}).reason, actorOf(req)))));
  app.post('/api/quotes/:id/pdf/regenerate', wrap(async (req, res) => res.json(await Q.regeneratePdf(ctx, req.params.id))));
  app.get('/api/quotes/:id/pdf', (req, res) => {
    const q = one(ctx.db, 'SELECT pdf_path FROM quotes WHERE id=?', req.params.id);
    if (!q?.pdf_path) return res.status(404).json({ error: 'PDF_NOT_AVAILABLE' });
    const p = resolve(q.pdf_path);
    if (!p.startsWith(resolve(ctx.pdfDir) + sep) || !existsSync(p)) return res.status(404).json({ error: 'PDF_NOT_AVAILABLE' });
    res.type('application/pdf').sendFile(p);
  });

  // ---------- Analytics / eventos ----------
  app.get('/api/analytics/overview', (_q, res) => res.json(A.overview(ctx)));
  app.get('/api/analytics/conversion', (_q, res) => res.json(A.conversion(ctx)));
  app.get('/api/analytics/transportation', (_q, res) => res.json(A.transportation(ctx)));
  app.get('/api/events', (req, res) => {
    const since = Number(req.query.since ?? 0);
    const rows = req.query.type ? all(ctx.db, 'SELECT * FROM business_events WHERE created_at > ? AND type=? ORDER BY created_at LIMIT 500', since, String(req.query.type))
      : all(ctx.db, 'SELECT * FROM business_events WHERE created_at > ? ORDER BY created_at LIMIT 500', since);
    res.json({ events: rows.map((r) => ({ id: r.id, type: r.type, payload: parse(r.payload, {}), at: r.created_at })) });
  });

  // ---------- Configurações ----------
  app.get('/api/settings/pricing', (_q, res) => res.json(readPricingSettings(ctx.db)));
  app.put('/api/settings/pricing', wrap((req, res) => res.json(writePricingSettings(ctx.db, PricingSettingsInput.parse(req.body)))));
  app.get('/api/settings/:key', (req, res) => {
    const k = req.params.key as SettingKey;
    if (!(k in SETTING_SCHEMAS)) return res.status(404).json({ error: 'UNKNOWN_SETTING' });
    res.json(getSetting(ctx.db, k));
  });
  app.put('/api/settings/:key', (req, res) => {
    const k = req.params.key as SettingKey;
    if (!(k in SETTING_SCHEMAS)) return res.status(404).json({ error: 'UNKNOWN_SETTING' });
    res.json(setSetting(ctx.db, k, req.body));
  });

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) return res.status(400).json({ error: 'VALIDATION_ERROR', issues: err.issues });
    if (err instanceof Q.QuoteError) return res.status(err.status).json({ error: err.code, message: err.message });
    if (err instanceof WhatsAppError) return res.status(502).json({ error: err.code, message: err.message });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'INVALID_JSON' });
    logger.error('request.failed', { err: err?.stack ?? String(err) });
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  });
  return app;
}
void join;
