// CalendarService: conflitos, buffers e reserva sem duplicidade. Adaptador Google real ou SIMULADO (identificado).
import { DB, all, one, run, uid, tx } from '../db.js';
import { logger } from '../lib/logger.js';
import { minutes } from '../lib/time.js';

export interface Busy { startEpoch: number; endEpoch: number; title: string; source: string }
export interface CalendarAdapter {
  name: string; simulated: boolean;
  listBusy(fromEpoch: number, toEpoch: number): Promise<Busy[]>;
  createEvent(e: { title: string; startEpoch: number; endEpoch: number; location?: string; description?: string }): Promise<{ id: string }>;
}

export class SimulatedCalendarAdapter implements CalendarAdapter {
  name = 'simulated-calendar'; simulated = true;
  constructor(private db: DB) {}
  async listBusy(from: number, to: number): Promise<Busy[]> {
    return all(this.db, 'SELECT * FROM calendar_events WHERE end_ts > ? AND start_ts < ?', from, to)
      .map((r) => ({ startEpoch: r.start_ts, endEpoch: r.end_ts, title: r.title, source: this.name }));
  }
  async createEvent(e: { title: string; startEpoch: number; endEpoch: number }) {
    const id = uid();
    run(this.db, 'INSERT INTO calendar_events(id,title,start_ts,end_ts,created_at) VALUES(?,?,?,?,?)', id, e.title, e.startEpoch, e.endEpoch, Date.now());
    return { id };
  }
  addBusy(title: string, startEpoch: number, endEpoch: number) { return this.createEvent({ title, startEpoch, endEpoch }); }
}

/** Sem Google Agenda conectado: nunca inventa disponibilidade. A consulta falha (CALENDAR_UNVERIFIED) e a Adriana confirma na mão. */
export class UnconfiguredCalendarAdapter implements CalendarAdapter {
  name = 'google-calendar (não conectado)'; simulated = false;
  async listBusy(): Promise<Busy[]> { throw new Error('Google Agenda não conectado'); }
  async createEvent(): Promise<{ id: string }> { throw new Error('Google Agenda não conectado'); }
}

export class GoogleCalendarAdapter implements CalendarAdapter {
  name = 'google-calendar'; simulated = false;
  private token?: { value: string; exp: number };
  constructor(private cfg: { calendarId: string; clientId: string; clientSecret: string; refreshToken: string }, private fetchFn: typeof fetch = fetch) {}
  private async accessToken(): Promise<string> {
    if (this.token && this.token.exp > Date.now() + 30_000) return this.token.value;
    const res = await this.fetchFn('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, refresh_token: this.cfg.refreshToken, grant_type: 'refresh_token' }),
    });
    if (!res.ok) throw new Error(`Google OAuth falhou (${res.status})`);
    const d: any = await res.json();
    this.token = { value: d.access_token, exp: Date.now() + d.expires_in * 1000 };
    return this.token.value;
  }
  async listBusy(from: number, to: number): Promise<Busy[]> {
    const q = new URLSearchParams({ timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '100' });
    const res = await this.fetchFn(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.cfg.calendarId)}/events?${q}`, { headers: { Authorization: `Bearer ${await this.accessToken()}` } });
    if (!res.ok) throw new Error(`Google Calendar respondeu ${res.status}`);
    const d: any = await res.json();
    return (d.items ?? [])
      .filter((i: any) => i.status !== 'cancelled' && i.transparency !== 'transparent' && i.start?.dateTime)
      .map((i: any) => ({ startEpoch: Date.parse(i.start.dateTime), endEpoch: Date.parse(i.end.dateTime), title: i.summary ?? 'Ocupado', source: this.name }));
  }
  async createEvent(e: { title: string; startEpoch: number; endEpoch: number; location?: string; description?: string }) {
    const res = await this.fetchFn(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.cfg.calendarId)}/events`, {
      method: 'POST', headers: { Authorization: `Bearer ${await this.accessToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: e.title, location: e.location, description: e.description,
        start: { dateTime: new Date(e.startEpoch).toISOString() }, end: { dateTime: new Date(e.endEpoch).toISOString() } }),
    });
    if (!res.ok) throw new Error(`Google Calendar create respondeu ${res.status}`);
    return { id: ((await res.json()) as any).id as string };
  }
}

export interface Conflict { title: string; startEpoch: number; endEpoch: number; source: string }
export interface AvailabilityResult { available: boolean; conflicts: Conflict[]; calendar: string; simulated: boolean; verified: boolean }

export class CalendarService {
  private lock: Promise<unknown> = Promise.resolve();
  constructor(private db: DB, public adapter: CalendarAdapter, private bufferMinutes: () => number) {}

  async check(blockStart: number, blockEnd: number, ignoreQuoteId?: string): Promise<AvailabilityResult> {
    const buf = minutes(this.bufferMinutes());
    const from = blockStart - buf, to = blockEnd + buf;
    let busy: Busy[] = [];
    let verified = true;
    try { busy = await this.adapter.listBusy(from - 86_400_000, to + 86_400_000); }
    catch (e) { logger.error('calendar.list.failed', { err: (e as Error).message }); verified = false; }
    const local = all(this.db, "SELECT * FROM appointments WHERE status='CONFIRMED' AND block_end_ts > ? AND block_start_ts < ? AND (quote_id IS NULL OR quote_id <> ?)", from - 86_400_000, to + 86_400_000, ignoreQuoteId ?? '')
      .map((r) => ({ startEpoch: r.block_start_ts, endEpoch: r.block_end_ts, title: 'Atendimento agendado', source: 'appointments' }));
    const conflicts = [...busy, ...local].filter((b) => blockStart < b.endEpoch + buf && blockEnd > b.startEpoch - buf);
    // Se o calendário real falhou, não afirmamos disponibilidade.
    return { available: verified && conflicts.length === 0, conflicts, calendar: this.adapter.name, simulated: this.adapter.simulated, verified };
  }

  /** Reserva definitiva. Serializada + rechecagem => impede reservas duplicadas. */
  book(p: { quoteId: string; customerId: string; startEpoch: number; endEpoch: number; blockStart: number; blockEnd: number; address: string; title: string }) {
    const job = this.lock.then(async () => {
      if (one(this.db, "SELECT id FROM appointments WHERE quote_id=? AND status='CONFIRMED'", p.quoteId)) throw new CalendarError('ALREADY_BOOKED');
      const av = await this.check(p.blockStart, p.blockEnd, p.quoteId);
      if (!av.verified) throw new CalendarError('CALENDAR_UNVERIFIED');
      if (!av.available) throw new CalendarError('CONFLICT');
      const ev = await this.adapter.createEvent({ title: p.title, startEpoch: p.blockStart, endEpoch: p.blockEnd, location: p.address });
      const id = uid();
      tx(this.db, () => run(this.db, `INSERT INTO appointments(id,quote_id,customer_id,start_ts,end_ts,block_start_ts,block_end_ts,address,status,calendar_event_id,created_at)
        VALUES(?,?,?,?,?,?,?,?,'CONFIRMED',?,?)`, id, p.quoteId, p.customerId, p.startEpoch, p.endEpoch, p.blockStart, p.blockEnd, p.address, ev.id, Date.now()));
      return { id, calendarEventId: ev.id, calendar: this.adapter.name, simulated: this.adapter.simulated };
    });
    this.lock = job.catch(() => undefined);
    return job;
  }
}
export class CalendarError extends Error { constructor(public code: string) { super(code); } }
