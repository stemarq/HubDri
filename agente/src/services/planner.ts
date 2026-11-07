// Planner: diferencia horário da cliente "pronta" de início do atendimento, saída, chegada, término e retorno.
import { DB, one } from '../db.js';
import { getSetting } from './settings.js';
import { localToEpoch, minutes } from '../lib/time.js';
import { LegEstimate, RouteError, TransportationEstimator } from './transport.js';

export interface Plan {
  date: string;
  readyEpoch: number | null;          // quando a cliente precisa estar pronta (pedido)
  departureEpoch: number;             // saída da Adriana
  arrivalEpoch: number;               // chegada estimada ao local
  startEpoch: number;                 // início do atendimento
  endEpoch: number;                   // término
  returnDepartureEpoch: number;       // saída do local
  returnArrivalEpoch: number;         // retorno estimado
  durationMin: number;
  travelVerified: boolean;            // false => rota indisponível: horários de deslocamento NÃO são confiáveis
  outbound?: LegEstimate; ret?: LegEstimate;
  routeError?: string;
}

export interface PlanRequest {
  date: string; readyMin?: number; desiredStartMin?: number; serviceCode: string;
  destination: string; weather?: 'rain' | 'clear' | null;
  /** Antecipa o atendimento (cliente fica pronta mais cedo, nunca depois do pedido). */
  shiftEarlierMin?: number;
}

/** Cálculo puro dos horários (testável). */
export function computeTimes(p: { date: string; readyMin?: number; desiredStartMin?: number; durationMin: number; finishMargin: number; prep: number; shiftEarlier?: number }) {
  const startMin = p.desiredStartMin ?? (p.readyMin! - p.finishMargin - p.durationMin);
  const start = localToEpoch(p.date, startMin) - minutes(p.shiftEarlier ?? 0);
  const end = start + minutes(p.durationMin);
  return { start, end, arrival: start - minutes(p.prep) };
}

export async function planVisit(db: DB, est: TransportationEstimator, base: string | undefined, req: PlanRequest): Promise<Plan> {
  const sch = getSetting(db, 'scheduling');
  const svc = one(db, 'SELECT duration_min FROM services WHERE code=?', req.serviceCode);
  if (!svc) throw new Error(`SERVICE_NOT_FOUND:${req.serviceCode}`);
  const durationMin: number = svc.duration_min;
  const t = computeTimes({ date: req.date, readyMin: req.readyMin, desiredStartMin: req.desiredStartMin, durationMin, finishMargin: sch.finishMarginMinutes, prep: sch.prepMinutes, shiftEarlier: req.shiftEarlierMin });
  const returnDepartureEpoch = t.end + minutes(sch.cleanupMinutes);
  const readyEpoch = req.readyMin !== undefined ? localToEpoch(req.date, req.readyMin) : null;
  const common = { date: req.date, readyEpoch, arrivalEpoch: t.arrival, startEpoch: t.start, endEpoch: t.end, returnDepartureEpoch, durationMin };

  if (!base) return { ...common, departureEpoch: t.arrival, returnArrivalEpoch: returnDepartureEpoch, travelVerified: false, routeError: 'BASE_ADDRESS_MISSING' };
  try {
    // Ponto fixo: duração depende do horário de saída; duas iterações bastam.
    let departure = t.arrival - minutes(45);
    let out = await est.estimateLeg({ leg: 'OUTBOUND', origin: base, destination: req.destination, departEpoch: departure, weather: req.weather });
    for (let i = 0; i < 2; i++) {
      departure = t.arrival - out.durationS * 1000 - minutes(sch.travelSafetyMinutes);
      out = await est.estimateLeg({ leg: 'OUTBOUND', origin: base, destination: req.destination, departEpoch: departure, weather: req.weather });
    }
    departure = t.arrival - out.durationS * 1000 - minutes(sch.travelSafetyMinutes);
    const back = await est.estimateLeg({ leg: 'RETURN', origin: req.destination, destination: base, departEpoch: returnDepartureEpoch, weather: req.weather });
    return { ...common, departureEpoch: departure, returnArrivalEpoch: returnDepartureEpoch + back.durationS * 1000, travelVerified: true, outbound: out, ret: back };
  } catch (e) {
    if (e instanceof RouteError) return { ...common, departureEpoch: t.arrival, returnArrivalEpoch: returnDepartureEpoch, travelVerified: false, routeError: e.message };
    throw e;
  }
}
