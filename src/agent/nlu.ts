// Extração estruturada determinística (pt-BR). Mensagens da cliente são DADOS: nada aqui executa ou interpreta
// instruções, e preços nunca passam por este módulo (proteção estrutural contra prompt injection).
import { addDays, todaySP, weekdayOf } from '../lib/time.js';

export type ServiceCode = 'MAKEUP' | 'HAIR' | 'MAKEUP_HAIR' | 'BRIDE_PACKAGE';

export interface DateMention { date: string; needsConfirmation: boolean; source: string }
export interface Extracted {
  service?: ServiceCode;
  wantsMakeup?: boolean; wantsHair?: boolean;
  role?: string; eventType?: string;
  date?: DateMention;
  readyMin?: number; eventStartMin?: number; desiredStartMin?: number;
  address?: { raw: string; full: boolean };
  neighborhood?: string;
  name?: string;
  yes?: boolean; no?: boolean;
  wantsHuman?: boolean;
  injectionSuspected?: boolean;
  choice?: number;
  acceptance?: boolean; decline?: boolean;
}

export const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export const NEIGHBORHOODS = [
  'Vila Mariana', 'Pinheiros', 'Moema', 'Itaim Bibi', 'Vila Madalena', 'Perdizes', 'Tatuape', 'Santana', 'Lapa', 'Mooca',
  'Ipiranga', 'Brooklin', 'Santo Amaro', 'Jabaquara', 'Saude', 'Liberdade', 'Bela Vista', 'Consolacao', 'Higienopolis',
  'Jardins', 'Butanta', 'Morumbi', 'Campo Belo', 'Vila Olimpia', 'Aclimacao', 'Paraiso', 'Centro', 'Penha', 'Vila Prudente',
];

const MONTHS: Record<string, number> = { janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6, julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12 };
const WEEKDAY_WORDS: [string, number][] = [['domingo', 0], ['segunda', 1], ['terca', 2], ['quarta', 3], ['quinta', 4], ['sexta', 5], ['sabado', 6]];
const pad = (n: number) => String(n).padStart(2, '0');
const validYMD = (y: number, m: number, d: number) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCMonth() === m - 1 && t.getUTCDate() === d; };

export function parseDate(text: string, now: Date): DateMention | undefined {
  const t = norm(text);
  const today = todaySP(now);
  const [ty, tm, td] = today.split('-').map(Number);

  let m = t.match(/\b(\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\/\s*(\d{2,4}))?\b/);
  if (m) {
    const d = +m[1], mo = +m[2];
    let y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : ty;
    if (validYMD(y, mo, d)) {
      let date = `${y}-${pad(mo)}-${pad(d)}`;
      if (!m[3] && date < today) date = `${y + 1}-${pad(mo)}-${pad(d)}`;
      return { date, needsConfirmation: false, source: m[0] };
    }
  }
  m = t.match(/\b(\d{1,2})\s*de\s*(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)(?:\s*de\s*(\d{4}))?/);
  if (m) {
    const d = +m[1], mo = MONTHS[m[2]];
    const y = m[3] ? +m[3] : ty;
    if (validYMD(y, mo, d)) {
      let date = `${y}-${pad(mo)}-${pad(d)}`;
      if (!m[3] && date < today) date = `${y + 1}-${pad(mo)}-${pad(d)}`;
      return { date, needsConfirmation: false, source: m[0] };
    }
  }
  if (/\bdepois de amanha\b/.test(t)) return { date: addDays(today, 2), needsConfirmation: false, source: 'depois de amanhã' };
  if (/\bamanha\b/.test(t)) return { date: addDays(today, 1), needsConfirmation: false, source: 'amanhã' };
  if (/\bhoje\b/.test(t)) return { date: today, needsConfirmation: false, source: 'hoje' };

  for (const [w, wd] of WEEKDAY_WORDS) {
    const re = new RegExp(`\\b(proxim[oa]\\s+)?${w}(?:-feira)?(\\s+que vem)?\\b`);
    const mm = t.match(re);
    if (mm) {
      const strictlyAfter = !!(mm[1] || mm[2]);
      let delta = (wd - weekdayOf(today) + 7) % 7;
      if (delta === 0 && strictlyAfter) delta = 7;
      return { date: addDays(today, delta), needsConfirmation: true, source: mm[0] };
    }
  }
  m = t.match(/\bdia\s+(\d{1,2})\b/);
  if (m) {
    const d = +m[1];
    let y = ty, mo = tm;
    if (d < td) { mo += 1; if (mo > 12) { mo = 1; y += 1; } }
    if (validYMD(y, mo, d)) return { date: `${y}-${pad(mo)}-${pad(d)}`, needsConfirmation: true, source: m[0] };
  }
  return undefined;
}

interface TimeMention { min: number; ctx: string }

function toMinutes(h: number, mi: number, period?: string): number | undefined {
  if (h > 24 || mi > 59) return undefined;
  if (period === 'tarde' || period === 'noite') { if (h < 12) h += 12; }
  if (h === 24) h = 0;
  return h * 60 + mi;
}

export function parseTimes(text: string): TimeMention[] {
  const t = norm(text);
  const out: TimeMention[] = [];
  const re = /(?:\bas?\s+)?\b(\d{1,2})\s*(?:h(?:oras?)?|:)\s*(\d{2})?\b(?:\s*(?:da|de)\s*(manha|tarde|noite|madrugada))?|\bas\s+(\d{1,2})(?!\d|\s*(?:de\s+\w+|\/))(?:\s*(?:da|de)\s*(manha|tarde|noite|madrugada))?|\b(\d{1,2})\s+(?:da|de)\s+(manha|tarde|noite|madrugada)\b|\bmeio[- ]dia\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    let min: number | undefined;
    if (m[0].includes('meio')) min = 12 * 60;
    else if (m[1] !== undefined) min = toMinutes(+m[1], m[2] ? +m[2] : 0, m[3]);
    else if (m[4] !== undefined) min = toMinutes(+m[4], 0, m[5]);
    else if (m[6] !== undefined) min = toMinutes(+m[6], 0, m[7]);
    if (min === undefined) continue;
    const ctx = t.slice(Math.max(0, m.index - 45), m.index + m[0].length);
    out.push({ min, ctx });
  }
  return out;
}

export function classifyTimes(text: string, awaiting?: string): Pick<Extracted, 'readyMin' | 'eventStartMin' | 'desiredStartMin'> {
  const r: Pick<Extracted, 'readyMin' | 'eventStartMin' | 'desiredStartMin'> = {};
  const times = parseTimes(text);
  for (const { min, ctx } of times) {
    // Só o trecho após o último separador de cláusula conta como contexto.
    const clause = ctx.split(/[,.;!?]| e /).pop() ?? ctx;
    if (/pront[ao]|estar pront/.test(clause)) r.readyMin = min;
    else if (/arrum|maquiar|me produzir|comecar a|iniciar|atendimento|chegar/.test(clause)) r.desiredStartMin = min;
    else if (/evento|cerimonia|festa|casamento|formatura|comeca|inicio|inicia|missa|culto|jantar|almoco/.test(clause)) r.eventStartMin = min;
    else if (awaiting === 'ready' && times.length === 1) r.readyMin = min;
  }
  if (awaiting === 'ready' && times.length === 0) {
    const bare = norm(text).match(/^\s*(?:as\s+)?(\d{1,2})(?::(\d{2}))?\s*$/);
    if (bare) { const v = toMinutes(+bare[1], bare[2] ? +bare[2] : 0); if (v !== undefined) r.readyMin = v; }
  }
  return r;
}

const ROLES: [RegExp, string][] = [
  [/mae d[ao] noiv[ao]/, 'mãe do noivo(a)'], [/noiva/, 'noiva'], [/madrinha/, 'madrinha'], [/convidada/, 'convidada'],
  [/formanda/, 'formanda'], [/debutante/, 'debutante'], [/aniversariante/, 'aniversariante'], [/dama de honra/, 'dama de honra'],
];
const EVENTS: [RegExp, string][] = [
  [/casamento|cerimonia de casamento|wedding/, 'casamento'], [/formatura/, 'formatura'], [/aniversario/, 'aniversário'],
  [/debut|15 anos/, 'debutante'], [/batizado|batismo/, 'batizado'], [/ensaio/, 'ensaio fotográfico'], [/festa/, 'festa'],
  [/corporativ|empresa/, 'evento corporativo'],
];
const INJECTION = /ignore (as|todas|suas)|ignore (previous|all)|desconsidere (as|suas)|esqueca (as|suas)|system prompt|prompt do sistema|voce agora e|aja como|de graca|gratis|desconto de \d+|preco (final )?(e|sera|fica) (r\$)?\s*\d|mude o preco|novo preco/;

export function extract(text: string, now: Date, awaiting?: string): Extracted {
  const t = norm(text);
  const e: Extracted = {};

  if (INJECTION.test(t)) e.injectionSuspected = true;

  const both = awaiting === 'service' && /\b(os dois|ambos|as duas|os 2|tudo|completo)\b/.test(t);
  const wantsMakeup = both || /maquiagem|maquiar|make\b|makeup/.test(t);
  const wantsHair = both || /penteado|cabelo|hair|babyliss|escova/.test(t);
  for (const [re, r] of ROLES) if (re.test(t)) { e.role = r; break; }
  for (const [re, r] of EVENTS) if (re.test(t)) { e.eventType = r; break; }
  if (wantsMakeup) e.wantsMakeup = true;
  if (wantsHair) e.wantsHair = true;
  if (e.role === 'noiva' && (wantsMakeup || wantsHair || /pacote/.test(t))) e.service = 'BRIDE_PACKAGE';
  else if (wantsMakeup && wantsHair) e.service = 'MAKEUP_HAIR';
  else if (wantsMakeup) e.service = 'MAKEUP';
  else if (wantsHair) e.service = 'HAIR';

  const d = parseDate(text, now);
  if (d) e.date = d;
  Object.assign(e, classifyTimes(text, awaiting));

  // Endereço
  const street = text.match(/\b(rua|r\.|avenida|av\.?|alameda|al\.|travessa|estrada|rodovia|pra[cç]a)\s+[^,;\n]+/i);
  const cep = /\b\d{5}-?\d{3}\b/.test(text);
  const streetTail = street ? text.slice(street.index ?? 0, (street.index ?? 0) + 200) : '';
  if (street && (/\d{1,5}/.test(streetTail) || cep)) e.address = { raw: streetTail.trim(), full: true };
  else if (awaiting === 'address' && /\d/.test(text) && text.trim().length > 8) e.address = { raw: text.trim().slice(0, 200), full: true };
  for (const n of NEIGHBORHOODS) if (t.includes(norm(n))) { e.neighborhood = n; break; }
  if (!e.neighborhood && !e.address) {
    const loc = text.match(/\b(?:em|na|no|pra|para|moro em)\s+((?:\p{Lu}[\p{L}'-]+)(?:\s+(?:d[aeo]s?\s+)?\p{Lu}[\p{L}'-]+){0,3})/u);
    if (loc) e.neighborhood = loc[1];
  }

  const nm = text.match(/(?:[Mm]eu nome [ée]|[Mm]e chamo|[Ss]ou [ao]|[Aa]qui [ée] [ao])\s+(\p{Lu}\p{L}+(?:\s\p{Lu}\p{L}+)?)/u);
  if (nm && !ROLES.some(([re]) => re.test(norm(nm[1])))) e.name = nm[1];

  if (/^\s*(sim|isso|isso mesmo|confirmo|pode ser|certo|exato|ok|combinado|perfeito|esse mesmo)\b/.test(t) || /\b(confirmo|isso mesmo)\b/.test(t)) e.yes = true;
  if (/^\s*(nao|não)\b/.test(t) || /\b(nao e isso|errado)\b/.test(t)) e.no = true;
  if (/(falar|conversar|chamar|passa(r)?|quero) (com )?(a )?(adriana|atendente|humano|pessoa|alguem|dona)|atendimento humano|atendente humano/.test(t)) e.wantsHuman = true;

  const ch = t.match(/^\s*(?:opcao\s*)?([1-3])\b\s*$/);
  if (ch) e.choice = +ch[1];
  else if (/\b(primeira|a primeira)\b/.test(t)) e.choice = 1;
  else if (/\bsegunda opcao\b/.test(t)) e.choice = 2;

  if (/\b(aceito|fechado|fechou|pode confirmar|quero fechar|vamos fechar|fechamos|aprovado)\b/.test(t)) e.acceptance = true;
  if (/\b(desisti|nao vou fechar|nao quero mais|muito caro|achei caro|vou pensar|cancelar)\b/.test(t)) e.decline = true;
  return e;
}
