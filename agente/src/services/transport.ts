// TransportationEstimator: ESTIMATIVA (não é cotação em tempo real da Uber). Híbrido:
// rota (distância/duração) -> fórmula configurável -> ajuste por histórico real -> margem de segurança.
import { DB, all, one, run, uid, j } from '../db.js';
import { getSetting } from './settings.js';
import { epochToLocal, parseHM } from '../lib/time.js';
import { isHoliday } from '../lib/holidays.js';
import { inWindow } from './pricing.js';
import { NEIGHBORHOODS, norm } from '../agent/nlu.js';
import { logger } from '../lib/logger.js';

export class RouteError extends Error { constructor(msg: string) { super(msg); this.name = 'RouteError'; } }
export interface RouteResult { distanceM: number; durationS: number; source: string; simulated: boolean; /** endereço aproximado (só bairro): revisar */ approximate?: boolean }
export interface RouteProvider { name: string; route(origin: string, destination: string, departEpoch: number): Promise<RouteResult> }

const COORDS: Record<string, [number, number]> = {
  'vila mariana': [-23.5890, -46.6340], pinheiros: [-23.5670, -46.6920], moema: [-23.6010, -46.6670], 'itaim bibi': [-23.5850, -46.6780],
  'vila madalena': [-23.5530, -46.6910], perdizes: [-23.5330, -46.6780], tatuape: [-23.5400, -46.5760], santana: [-23.5030, -46.6250],
  lapa: [-23.5230, -46.7050], mooca: [-23.5600, -46.5990], ipiranga: [-23.5850, -46.6100], brooklin: [-23.6200, -46.6890],
  'santo amaro': [-23.6540, -46.7090], jabaquara: [-23.6460, -46.6420], saude: [-23.6190, -46.6360], liberdade: [-23.5590, -46.6350],
  'bela vista': [-23.5640, -46.6480], consolacao: [-23.5560, -46.6590], higienopolis: [-23.5450, -46.6570], jardins: [-23.5700, -46.6650],
  butanta: [-23.5710, -46.7230], morumbi: [-23.6010, -46.7220], 'campo belo': [-23.6230, -46.6690], 'vila olimpia': [-23.5950, -46.6850],
  aclimacao: [-23.5730, -46.6320], paraiso: [-23.5750, -46.6430], centro: [-23.5500, -46.6340], penha: [-23.5270, -46.5430], 'vila prudente': [-23.5860, -46.5800],
};
export function findNeighborhoodKey(text: string): string | undefined {
  const t = norm(text);
  return NEIGHBORHOODS.map(norm).sort((a, b) => b.length - a.length).find((n) => t.includes(n));
}

/** Provedor SIMULADO: distância em linha reta x fator de circuidade; velocidade média por faixa. Sempre rotulado como simulado. */
export class SimulatedRouteProvider implements RouteProvider {
  name = 'simulated-routes';
  async route(origin: string, destination: string, departEpoch: number): Promise<RouteResult> {
    const o = findNeighborhoodKey(origin), d = findNeighborhoodKey(destination);
    if (!o || !d) throw new RouteError(`Rota simulada indisponível: bairro não reconhecido (${!o ? 'origem' : 'destino'})`);
    const [la1, lo1] = COORDS[o], [la2, lo2] = COORDS[d];
    const R = 6371e3, rad = Math.PI / 180;
    const a = Math.sin(((la2 - la1) * rad) / 2) ** 2 + Math.cos(la1 * rad) * Math.cos(la2 * rad) * Math.sin(((lo2 - lo1) * rad) / 2) ** 2;
    const straight = 2 * R * Math.asin(Math.sqrt(a));
    const distanceM = Math.round(Math.max(straight, 500) * 1.35);
    const h = epochToLocal(departEpoch).minutes / 60;
    const kmh = h >= 7 && h < 10 || h >= 17 && h < 20 ? 18 : h < 6 ? 38 : 28;
    return { distanceM, durationS: Math.round((distanceM / 1000 / kmh) * 3600), source: this.name, simulated: true };
  }
}

export class GoogleRoutesProvider implements RouteProvider {
  name = 'google-routes';
  constructor(private apiKey: string, private fetchFn: typeof fetch = fetch) {}
  async route(origin: string, destination: string, departEpoch: number): Promise<RouteResult> {
    const body: Record<string, unknown> = {
      origin: { address: origin }, destination: { address: destination }, travelMode: 'DRIVE', routingPreference: 'TRAFFIC_AWARE', languageCode: 'pt-BR',
    };
    if (departEpoch > Date.now() + 60_000) body.departureTime = new Date(departEpoch).toISOString();
    let res: Response;
    try {
      res = await this.fetchFn('https://routes.googleapis.com/directions/v2:computeRoutes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': this.apiKey, 'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
      });
    } catch (e) { throw new RouteError(`Falha de rede na API de rotas: ${(e as Error).message}`); }
    if (!res.ok) throw new RouteError(`API de rotas respondeu ${res.status}`);
    const data: any = await res.json();
    const r = data?.routes?.[0];
    if (!r) throw new RouteError('API de rotas sem resultado');
    return { distanceM: r.distanceMeters, durationS: parseInt(String(r.duration), 10), source: this.name, simulated: false };
  }
}

export type Confidence = 'low' | 'medium' | 'high';
export interface LegEstimate {
  leg: 'OUTBOUND' | 'RETURN'; origin: string; destination: string; departEpoch: number;
  distanceM: number; durationS: number; formulaCents: number; predictedCents: number;
  confidence: Confidence; source: string; simulated: boolean;
  similarTrips: number; breakdown: Record<string, unknown>; isRealtimeUberQuote: false; disclaimer: string;
}
const DISCLAIMER = 'Estimativa calculada por fórmula configurável e histórico de corridas da Adriana. Não é cotação em tempo real da Uber.';

function bucket(min: number, holiday: boolean, weekday: number, s: ReturnType<typeof getSetting<'transport'>>, night: { from: string; to: string }) {
  const peak = weekday >= 1 && weekday <= 5 && !holiday && s.peakWindows.some((w) => inWindow(min, w.from, w.to));
  const isNight = inWindow(min, night.from, night.to);
  return isNight ? 'night' : peak ? 'peak' : weekday === 0 || weekday === 6 || holiday ? 'offday' : 'offpeak';
}
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export class TransportationEstimator {
  constructor(private db: DB, private provider: RouteProvider) {}
  get providerName() { return this.provider.name; }

  async estimateLeg(p: { leg: 'OUTBOUND' | 'RETURN'; origin: string; destination: string; departEpoch: number; weather?: 'rain' | 'clear' | null }): Promise<LegEstimate> {
    const s = getSetting(this.db, 'transport');
    const night = getSetting(this.db, 'pricing').nightWindow;
    const route = await this.provider.route(p.origin, p.destination, p.departEpoch); // RouteError propaga ao chamador
    const local = epochToLocal(p.departEpoch);
    const holiday = isHoliday(local.date, getSetting(this.db, 'pricing').holidays);

    const b = bucket(local.minutes, holiday, local.weekday, s, night);
    // Provedores sem trânsito (OSM) recebem um fator de pico na duração; o Google já considera o trânsito.
    if (route.source.startsWith('osm') && b === 'peak') route.durationS = Math.round(route.durationS * s.peakDurationFactor);
    const km = route.distanceM / 1000, mins = route.durationS / 60;

    let formula = s.baseFareCents + s.perKmCents * km + s.perMinuteCents * mins;
    const mults: Record<string, number> = {};
    if (b === 'peak') mults.peak = s.peakMultiplier;
    if (b === 'night') mults.night = s.nightMultiplier;
    if (local.weekday === 0 || local.weekday === 6) mults.weekend = s.weekendMultiplier;
    if (holiday) mults.holiday = s.holidayMultiplier;
    if (p.weather === 'rain') mults.rain = s.rainMultiplier;
    for (const m of Object.values(mults)) formula *= m;
    formula = Math.max(formula, s.minFareCents);
    const formulaCents = Math.round(formula);

    // Ajuste por histórico real (viagens semelhantes: mesmo destino ou distância ±25%, mesma faixa de horário).
    const destKey = findNeighborhoodKey(p.destination) ?? null;
    const hist = all(this.db, 'SELECT * FROM transportation_history WHERE actual_cents IS NOT NULL AND formula_cents > 0');
    const similar = hist.filter((h) => {
      const sameDest = destKey && h.dest_key === destKey;
      const nearDist = h.distance_m && Math.abs(h.distance_m - route.distanceM) / route.distanceM <= 0.25;
      const hb = bucket(h.depart_minutes, !!h.holiday, h.weekday ?? 1, s, night);
      return (sameDest || nearDist) && hb === b;
    });
    let ratio = 1;
    let confidence: Confidence = 'low';
    if (similar.length >= 3) {
      ratio = Math.min(2, Math.max(0.5, median(similar.map((h) => (h.actual_cents + (h.discount_cents ?? 0)) / h.formula_cents))));
      confidence = similar.length >= 8 ? 'high' : 'medium';
    }
    if ((route.simulated || route.approximate) && confidence === 'high') confidence = 'medium';
    let adjusted = formulaCents * ratio;
    adjusted *= 1 + s.safetyMarginPercent / 100;
    adjusted *= 1 - s.discountPercent / 100;
    const predictedCents = Math.ceil(adjusted / s.roundToCents) * s.roundToCents;

    return {
      leg: p.leg, origin: p.origin, destination: p.destination, departEpoch: p.departEpoch,
      distanceM: route.distanceM, durationS: route.durationS, formulaCents, predictedCents, confidence,
      source: route.source, simulated: route.simulated, similarTrips: similar.length,
      breakdown: { bucket: b, multipliers: mults, historyRatio: ratio, safetyMarginPercent: s.safetyMarginPercent, discountPercent: s.discountPercent, routeProvider: route.source, approximateAddress: !!route.approximate },
      isRealtimeUberQuote: false, disclaimer: DISCLAIMER,
    };
  }

  saveEstimate(quoteId: string | null, e: LegEstimate): string {
    const id = uid();
    run(this.db, `INSERT INTO transportation_estimates(id,quote_id,leg,origin,destination,depart_ts,distance_m,duration_s,predicted_cents,formula_cents,confidence,source,simulated,breakdown,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, quoteId, e.leg, e.origin, e.destination, e.departEpoch, e.distanceM, e.durationS,
      e.predictedCents, e.formulaCents, e.confidence, e.source, e.simulated ? 1 : 0, j(e.breakdown), Date.now());
    return id;
  }

  /** Registra o custo real pago (calibra estimativas futuras). Aceita estimateId ou dados completos da viagem. */
  recordActual(p: { estimateId?: string; actualCents: number; discountCents?: number; weather?: string | null;
    trip?: { date: string; leg?: string; origin: string; destination: string; distanceM?: number; departMinutes: number; predictedCents?: number; formulaCents?: number } }): string {
    let t = p.trip;
    let estimateId = p.estimateId ?? null;
    let formula: number | undefined, predicted: number | undefined;
    if (p.estimateId) {
      const e = one(this.db, 'SELECT * FROM transportation_estimates WHERE id=?', p.estimateId);
      if (!e) throw new Error('ESTIMATE_NOT_FOUND');
      const l = epochToLocal(e.depart_ts);
      t = { date: l.date, leg: e.leg, origin: e.origin, destination: e.destination, distanceM: e.distance_m, departMinutes: l.minutes };
      formula = e.formula_cents; predicted = e.predicted_cents;
      const existing = one(this.db, 'SELECT id FROM transportation_history WHERE estimate_id=?', p.estimateId);
      if (existing) {
        run(this.db, 'UPDATE transportation_history SET actual_cents=?, discount_cents=?, weather=? WHERE id=?', p.actualCents, p.discountCents ?? 0, p.weather ?? null, existing.id);
        logger.info('transport.actual.updated', { estimateId });
        return existing.id;
      }
    } else if (!t) throw new Error('TRIP_REQUIRED');
    else { formula = t.formulaCents; predicted = t.predictedCents; }
    const id = uid();
    const wd = new Date(`${t!.date}T12:00:00Z`).getUTCDay();
    run(this.db, `INSERT INTO transportation_history(id,estimate_id,trip_date,leg,origin,destination,dest_key,distance_m,depart_minutes,weekday,holiday,weather,formula_cents,predicted_cents,actual_cents,discount_cents,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, estimateId, t!.date, t!.leg ?? null, t!.origin, t!.destination, findNeighborhoodKey(t!.destination) ?? null,
      t!.distanceM ?? null, t!.departMinutes, wd, isHoliday(t!.date) ? 1 : 0, p.weather ?? null, formula ?? null, predicted ?? null, p.actualCents, p.discountCents ?? 0, Date.now());
    return id;
  }
}
export { parseHM };
