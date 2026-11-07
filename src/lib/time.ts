// Fuso America/Sao_Paulo. O Brasil não adota horário de verão desde 2019, logo o offset é fixo (-03:00).
// Instantes são epoch ms; "locais" são (date 'YYYY-MM-DD', minutos desde 00:00).
export const TZ = 'America/Sao_Paulo';
const OFFSET_MIN = -180;
const MIN = 60_000;

export function localToEpoch(date: string, minutes: number): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d, 0, 0) + (minutes - OFFSET_MIN) * MIN;
}
export function epochToLocal(ms: number): { date: string; minutes: number; weekday: number } {
  const d = new Date(ms + OFFSET_MIN * MIN);
  const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  return { date, minutes: d.getUTCHours() * 60 + d.getUTCMinutes(), weekday: d.getUTCDay() };
}
export const todaySP = (now: Date) => epochToLocal(now.getTime()).date;
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
export const WEEKDAYS_PT = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
export function fmtTime(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
export const fmtEpochTime = (ms: number) => fmtTime(epochToLocal(ms).minutes);
export function fmtDateBR(date: string): string {
  const [y, m, d] = date.split('-');
  return `${d}/${m}/${y}`;
}
export function fmtDateLong(date: string): string {
  const [, m, d] = date.split('-');
  return `${WEEKDAYS_PT[weekdayOf(date)]}, ${d}/${m}`;
}
export function parseHM(s: string): number {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + (m || 0);
}
export const toIso = (ms: number) => {
  const l = epochToLocal(ms);
  return `${l.date}T${fmtTime(l.minutes)}:00-03:00`;
};
export const minutes = (n: number) => n * MIN;
export const brl = (cents: number) =>
  (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
