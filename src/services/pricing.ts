// PricingEngine: 100% determinístico. A IA nunca calcula preço; só consome este serviço.
// Valores em centavos inteiros. Regra ausente => `missing` preenchido e revisão humana (nunca preço inventado).
import { DB, all, one } from '../db.js';
import { getSetting } from './settings.js';
import { epochToLocal, parseHM, weekdayOf } from '../lib/time.js';
import { isHoliday } from '../lib/holidays.js';

export type DayTypeT = 'WEEKDAY' | 'WEEKEND' | 'HOLIDAY';
export interface PriceInput {
  serviceCode: string;
  /** Início do atendimento (instante). Dia/horário de preço são avaliados nele. */
  startEpoch: number;
  /** Total ida+volta já estimado (com margem). null => indisponível. Incluído UMA única vez. */
  transportCents: number | null;
  addons?: string[];
  discountCode?: string;
}
export interface PriceLine { kind: 'SERVICE' | 'NIGHT_SURCHARGE' | 'ADDON' | 'TRANSPORT' | 'DISCOUNT'; label: string; amountCents: number }
export interface PriceResult {
  ok: boolean; lines: PriceLine[]; totalCents: number; missing: string[];
  dayType: DayTypeT; isNight: boolean;
}

export function dayTypeOf(date: string, extraHolidays: string[]): DayTypeT {
  if (isHoliday(date, extraHolidays)) return 'HOLIDAY';
  const wd = weekdayOf(date);
  return wd === 0 || wd === 6 ? 'WEEKEND' : 'WEEKDAY';
}

export function inWindow(min: number, from: string, to: string): boolean {
  const f = parseHM(from), t = parseHM(to);
  return f <= t ? min >= f && min < t : min >= f || min < t;
}

export function calculatePrice(db: DB, input: PriceInput): PriceResult {
  const extras = getSetting(db, 'pricing');
  const local = epochToLocal(input.startEpoch);
  const dayType = dayTypeOf(local.date, extras.holidays);
  const isNight = inWindow(local.minutes, extras.nightWindow.from, extras.nightWindow.to);
  const missing: string[] = [];
  const lines: PriceLine[] = [];

  const svc = one(db, 'SELECT * FROM services WHERE code=?', input.serviceCode);
  if (!svc || !svc.active) return { ok: false, lines, totalCents: 0, missing: [`SERVICE_UNAVAILABLE:${input.serviceCode}`], dayType, isNight };
  const rule = one(db, 'SELECT amount_cents FROM pricing_rules WHERE service_code=? AND day_type=?', input.serviceCode, dayType);
  let serviceCents = 0;
  if (!rule) missing.push(`PRICE_RULE_MISSING:${input.serviceCode}:${dayType}`);
  else serviceCents = rule.amount_cents;

  const addonLines: PriceLine[] = [];
  const seen = new Set<string>();
  for (const code of input.addons ?? []) {
    if (seen.has(code)) continue; // evita cobrança duplicada
    seen.add(code);
    const a = extras.addons.find((x) => x.code === code);
    if (!a) missing.push(`ADDON_UNKNOWN:${code}`);
    else addonLines.push({ kind: 'ADDON', label: a.name, amountCents: a.amountCents });
  }
  const addonsCents = addonLines.reduce((s, l) => s + l.amountCents, 0);

  let transportCents = 0;
  if (input.transportCents === null) missing.push('TRANSPORT_ESTIMATE_UNAVAILABLE');
  else transportCents = input.transportCents;

  let surcharge = 0;
  if (isNight) {
    const nm = extras.nightMultiplier;
    if (!nm) missing.push('NIGHT_MULTIPLIER_NOT_CONFIGURED');
    else {
      const affected =
        (nm.appliesTo.includes('service') ? serviceCents : 0) +
        (nm.appliesTo.includes('transport') ? transportCents : 0) +
        (nm.appliesTo.includes('addons') ? addonsCents : 0);
      surcharge = Math.round(affected * (nm.factor - 1));
    }
  }

  let discount = 0;
  let discountLabel = '';
  if (input.discountCode) {
    const d = extras.discounts.find((x) => x.code === input.discountCode);
    if (!d) missing.push(`DISCOUNT_NOT_AUTHORIZED:${input.discountCode}`);
    else { discount = Math.round(serviceCents * (d.percent / 100)); discountLabel = d.name; } // incide só sobre o preço-base do serviço
  }

  if (rule) lines.push({ kind: 'SERVICE', label: svc.name, amountCents: serviceCents });
  if (surcharge > 0) lines.push({ kind: 'NIGHT_SURCHARGE', label: `Adicional de madrugada (x${extras.nightMultiplier!.factor})`, amountCents: surcharge });
  lines.push(...addonLines);
  if (input.transportCents !== null) lines.push({ kind: 'TRANSPORT', label: 'Deslocamento (ida e volta, estimativa)', amountCents: transportCents });
  if (discount > 0) lines.push({ kind: 'DISCOUNT', label: `Desconto: ${discountLabel}`, amountCents: -discount });

  const totalCents = lines.reduce((s, l) => s + l.amountCents, 0);
  return { ok: missing.length === 0, lines, totalCents, missing, dayType, isNight };
}

export const listPricingRules = (db: DB) => all(db, 'SELECT * FROM pricing_rules');
