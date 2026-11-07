// Extração estruturada determinística (pt-BR). Mensagens da cliente são DADOS: nada aqui executa ou interpreta
// instruções, e preços nunca passam por este módulo (proteção estrutural contra prompt injection).
import { addDays, todaySP, weekdayOf } from '../lib/time.js';
import { preprocess } from './text.js';

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
  ambiguousHour?: number;          // "às 7": manhã ou noite? não vira horário até a cliente esclarecer
  periodExplicit?: boolean;        // a cliente disse manhã/tarde/noite/madrugada explicitamente
  period?: 'manha' | 'tarde' | 'noite' | 'madrugada';
  ambiguousDate?: 'weekend' | 'week';
  correction?: boolean; clear?: ('date' | 'address' | 'time')[];
  emotion?: 'nervous' | 'urgent' | 'happy'; dissatisfied?: boolean;
  privacy?: 'erase' | 'keep' | 'dont_keep';
  formal?: boolean; casual?: boolean;
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
  const t = preprocess(norm(text));
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

  // "não é sábado, é domingo": o dia negado não conta
  const tw = t.replace(/nao (?:e|era|eh) (?:para |pra )?(?:o |a )?(?:proxim[oa] )?(?:domingo|segunda|terca|quarta|quinta|sexta|sabado)(?:-feira)?/g, ' ');
  for (const [w, wd] of WEEKDAY_WORDS) {
    const re = new RegExp(`\\b(proxim[oa]\\s+)?${w}(?:-feira)?(\\s+que vem)?\\b`);
    const mm = tw.match(re);
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


export function toMinutes(h: number, mi: number, period?: string): number | undefined {
  if (h > 24 || mi > 59) return undefined;
  if (period === 'tarde' || period === 'noite') { if (h < 12) h += 12; }
  if (h === 24) h = 0;
  return h * 60 + mi;
}

interface TimeMention { min?: number; ambiguousHour?: number; periodExplicit: boolean; ctx: string }

/** Horários em pt-BR: "3h", "15h30", "3 da manhã", "três da tarde", "às 7" (ambíguo), "meio-dia". */
export function parseTimes(text: string): TimeMention[] {
  const t = preprocess(norm(text));
  const out: TimeMention[] = [];
  const re = /(?:\bas?\s+)?\b(\d{1,2})\s*(?:h(?:oras?|rs?)?|:)\s*(\d{2})?\b(?:\s*(?:da|de)\s*(manha|tarde|noite|madrugada))?|\bas\s+(\d{1,2})(?!\d|\s*(?:de\s+\w+|\/))(?:\s*(?:da|de)\s*(manha|tarde|noite|madrugada))?|\b(\d{1,2})\s+(?:da|de)\s+(manha|tarde|noite|madrugada)\b|\bmeio-dia\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const ctx = t.slice(Math.max(0, m.index - 45), m.index + m[0].length);
    if (m[0].includes('meio')) { out.push({ min: 720, periodExplicit: true, ctx }); continue; }
    let h: number, mi = 0, period: string | undefined, hasH = true;
    if (m[1] !== undefined) { h = +m[1]; mi = m[2] ? +m[2] : 0; period = m[3]; }
    else if (m[4] !== undefined) { h = +m[4]; period = m[5]; hasH = false; }
    else { h = +m[6]; period = m[7]; }
    const min = toMinutes(h, mi, period);
    if (min === undefined) continue;
    if (!hasH && !period && h >= 1 && h <= 11) out.push({ ambiguousHour: h, periodExplicit: false, ctx }); // "às 7": manhã ou noite?
    else out.push({ min, periodExplicit: !!period, ctx });
  }
  return out;
}

type TimeFields = Pick<Extracted, 'readyMin' | 'eventStartMin' | 'desiredStartMin' | 'ambiguousHour' | 'periodExplicit'>;

export function classifyTimes(text: string, awaiting?: string): TimeFields {
  const r: TimeFields = {};
  const times = parseTimes(text);
  const assign = (field: 'readyMin' | 'eventStartMin' | 'desiredStartMin', tm: TimeMention) => {
    if (tm.min !== undefined) { r[field] = tm.min; if (field === 'readyMin') r.periodExplicit = tm.periodExplicit; }
    else if (field === 'readyMin') r.ambiguousHour = tm.ambiguousHour;
  };
  for (const tm of times) {
    // Só o trecho após o último separador de cláusula conta como contexto.
    const clause = tm.ctx.split(/[,.;!?]| e /).pop() ?? tm.ctx;
    if (/pront[ao]|estar pront/.test(clause)) assign('readyMin', tm);
    else if (/arrum|maquiar|me produzir|comecar a|iniciar|atendimento|chegar/.test(clause)) assign('desiredStartMin', tm);
    else if (/evento|cerimonia|festa|casamento|formatura|comeca|inicio|inicia|missa|culto|jantar|almoco/.test(clause)) assign('eventStartMin', tm);
    else if (awaiting === 'ready' && times.length === 1) assign('readyMin', tm);
  }
  if (awaiting === 'ready' && times.length === 0) {
    const bare = norm(text).match(/^\s*(?:as\s+)?(\d{1,2})(?::(\d{2}))?\s*$/);
    if (bare) {
      const h = +bare[1];
      if (!bare[2] && h >= 1 && h <= 11) r.ambiguousHour = h;
      else { const v = toMinutes(h, bare[2] ? +bare[2] : 0); if (v !== undefined) { r.readyMin = v; r.periodExplicit = false; } }
    }
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
const WEEKDAY_RE = /domingo|segunda|terca|quarta|quinta|sexta|sabado/;

export function extract(text: string, now: Date, awaiting?: string): Extracted {
  const raw = norm(text);          // para sinais de intenção (sim/não/humano/aceite)
  const t = preprocess(raw);       // gírias, números por extenso e erros de digitação corrigidos
  const e: Extracted = {};

  if (INJECTION.test(raw)) e.injectionSuspected = true;

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
  else if (!WEEKDAY_RE.test(t)) {
    if (/fim de semana|final de semana|\bfds\b/.test(t)) e.ambiguousDate = 'weekend';
    else if (/semana que vem|proxima semana|mes que vem|proximo mes/.test(t)) e.ambiguousDate = 'week';
  }
  const tf = classifyTimes(text, awaiting);
  Object.assign(e, tf);
  if (/\b(na verdade|errei|corrigindo|quer dizer|ops|mudei|mudou|trocar|trocando|melhor)\b/.test(raw) && tf.readyMin === undefined && tf.eventStartMin === undefined && tf.desiredStartMin === undefined) {
    // correção com um único horário e sem rótulo: assume o horário principal (pronta)
    const only = parseTimes(text);
    if (only.length === 1) { if (only[0].min !== undefined) { e.readyMin = only[0].min; e.periodExplicit = only[0].periodExplicit; } else e.ambiguousHour = only[0].ambiguousHour; }
  }
  if (awaiting === 'period' && tf.readyMin === undefined) {
    const p = t.match(/\b(manha|tarde|noite|madrugada)\b/);
    if (p) e.period = p[1] as Extracted['period'];
  }

  // Endereço (pontos e abreviações como "m.m.d.c." não cortam o texto)
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

  if (/^\s*(sim|s|isso|isso mesmo|confirmo|pode ser|pode|certo|exato|ok|blz|beleza|combinado|perfeito|esse mesmo|show|claro|com certeza|aham|uhum|fechado|fechou)\b/.test(raw) || /\b(confirmo|isso mesmo)\b/.test(raw)) e.yes = true;
  if (/^\s*(nao|n|negativo)\b/.test(raw) || /\b(nao e isso|errado|errada)\b/.test(raw)) e.no = true;
  if (/(falar|conversar|chama(r)?|passa(r)?|quero) (com )?(a )?(adriana|atendente|humano|pessoa|alguem|dona)|atendimento humano|atendente humano|pessoa de verdade/.test(raw)) e.wantsHuman = true;

  const ch = raw.match(/^\s*(?:opcao\s*)?([1-3])\b\s*$/);
  if (ch) e.choice = +ch[1];
  else if (/\b(primeira|a primeira)\b/.test(raw)) e.choice = 1;
  else if (/\bsegunda opcao\b/.test(raw)) e.choice = 2;

  if (/\b(aceito|fechado|fechou|pode confirmar|quero fechar|vamos fechar|fechamos|aprovado)\b/.test(raw)) e.acceptance = true;
  if (/\b(desisti|nao vou fechar|nao quero mais|muito caro|achei caro|vou pensar|cancelar)\b/.test(raw)) e.decline = true;

  // Correções, negações e sinais de contexto
  if (/\b(na verdade|errei|corrigindo|quer dizer|ops|mudei|mudou|trocar|trocando|melhor)\b/.test(raw)) e.correction = true;
  const clear: NonNullable<Extracted['clear']> = [];
  if (/nao e (sabado|domingo|segunda|terca|quarta|quinta|sexta|amanha|hoje)|data errada|outra data/.test(raw)) clear.push('date');
  if (/endereco (esta |ta )?(errado|e outro|mudou)|outro endereco|mudei de endereco/.test(raw)) clear.push('address');
  if (/horario (esta |ta )?errado|outro horario/.test(raw)) clear.push('time');
  if (clear.length) e.clear = clear;
  if (/nervos|ansios|apavorad|desesper|com medo|insegur/.test(raw)) e.emotion = 'nervous';
  else if (/urgente|urgencia|em cima da hora|correndo/.test(raw)) e.emotion = 'urgent';
  else if (/empolgad|feliz|sonho|maravilh|amando/.test(raw)) e.emotion = 'happy';
  if (/nao (e|era) isso|nao entendeu|nao entende|voce nao|burro|inutil|ja falei|ja disse|que saco/.test(raw)) e.dissatisfied = true;
  if (/(apagar|excluir|esquecer|remover|deletar) (todos )?(os )?(meus )?dados|\blgpd\b/.test(raw)) e.privacy = 'erase';
  else if (/nao (precisa )?guard/.test(raw)) e.privacy = 'dont_keep';
  else if (/(pode )?guard(ar|e) (o )?(meu )?(endereco|dados)|pode guardar/.test(raw)) e.privacy = 'keep';
  if (/(^|\s)(bom dia|boa tarde|boa noite|prezada|senhora)\b/.test(raw)) e.formal = true;
  if (/\b(kk+|rs+|haha+|mds|miga|amiga|linda)\b|[\u{1F300}-\u{1FAFF}]/u.test(text)) e.casual = true;
  return e;
}
