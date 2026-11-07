import { addDays } from './time.js';

function easter(year: number): string {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const FIXED = ['01-01', '01-25', '04-21', '05-01', '07-09', '09-07', '10-12', '11-02', '11-15', '11-20', '12-25'];

/** Feriados nacionais + São Paulo (estado/capital) + móveis. `extra` vem das configurações. */
export function holidaysOf(year: number, extra: string[] = []): Set<string> {
  const e = easter(year);
  const set = new Set<string>(FIXED.map((f) => `${year}-${f}`));
  [-48, -47, -2, 60].forEach((n) => set.add(addDays(e, n)));
  extra.forEach((x) => set.add(x));
  return set;
}
export const isHoliday = (date: string, extra: string[] = []) => holidaysOf(Number(date.slice(0, 4)), extra).has(date);
