// Pré-processamento do texto da cliente: gírias, números por extenso, erros de digitação (fuzzy). Entrada/saída já sem acento e minúsculas.

const NUM_WORDS: [string, number][] = ([
  ['vinte e quatro', 24], ['vinte e tres', 23], ['vinte e duas', 22], ['vinte e dois', 22], ['vinte e uma', 21], ['vinte e um', 21], ['vinte', 20],
  ['dezenove', 19], ['dezessete', 17], ['dezesseis', 16], ['dezoito', 18], ['quinze', 15], ['quatorze', 14], ['catorze', 14], ['treze', 13],
  ['doze', 12], ['onze', 11], ['dez', 10], ['nove', 9], ['oito', 8], ['sete', 7], ['seis', 6], ['cinco', 5], ['quatro', 4], ['tres', 3],
  ['duas', 2], ['dois', 2], ['uma', 1], ['um', 1],
] as [string, number][]).sort((a, b) => b[0].length - a[0].length);

const SLANG: [RegExp, string][] = [
  [/\bvc\b|\bvce\b|\bvoces\b/g, 'voce'], [/\btb\b|\btbm\b/g, 'tambem'], [/\bhj\b/g, 'hoje'], [/\bamh\b|\bamnha\b|\bamanhaa+\b/g, 'amanha'],
  [/\bpq\b/g, 'porque'], [/\bq\b/g, 'que'], [/\bn\b/g, 'nao'], [/\bblz\b|\bbeleza\b|\bfechou\b|\bfechado\b/g, 'ok'],
  [/\bmadruga\b|\bmadrugadinha\b/g, 'madrugada'], [/\bmanhazinha\b|\bmanhazona\b/g, 'manha'],
  [/\b(?:de|pela|na) (manha|tarde|noite|madrugada)\b/g, 'da $1'], [/\bmeia[- ]noite\b/g, '0h da madrugada'], [/\bmeio[- ]dia\b/g, 'meio-dia'],
  [/\bpra\b/g, 'para'], [/\bta\b/g, 'esta'], [/\bto\b/g, 'estou'], [/\bpreciso de estar\b/g, 'preciso estar'], [/\bprontinha\b/g, 'pronta'],
];

const MINUTES: [RegExp, string][] = [
  [/\be meia\b/g, ':30'], [/\be quarenta e cinco\b/g, ':45'], [/\be quinze\b/g, ':15'], [/\be trinta\b/g, ':30'], [/\be vinte\b/g, ':20'],
];

/** "três da tarde" -> "3 da tarde"; só converte quando o contexto é horário (evita "um casamento" -> "1 casamento"). */
export function numberWordsToDigits(t: string): string {
  const alt = NUM_WORDS.map(([w]) => w).join('|');
  const re = new RegExp(`\\b(${alt})\\b(?=\\s*(?:h\\b|horas?\\b|da (?:manha|tarde|noite|madrugada)|e (?:meia|quinze|trinta|vinte|quarenta e cinco)\\b))`, 'g');
  let out = t.replace(re, (_m, w: string) => String(NUM_WORDS.find(([k]) => k === w)![1]));
  for (const [r, v] of MINUTES) out = out.replace(new RegExp(`(\\d{1,2})\\s*${r.source}`, 'g'), `$1${v}`);
  return out;
}

export function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

// Só vocabulário longo e distintivo: palavras curtas/comuns (minha, tarde, sexta...) geram falsos positivos.
const VOCAB = ['maquiagem', 'penteado', 'sabado', 'domingo', 'amanha', 'noiva', 'madrinha', 'convidada', 'pronta', 'casamento', 'formatura',
  'aniversario', 'madrugada', 'cabelo', 'maquiar', 'proxima'];
const KEEP = new Set(['manha', 'minha', 'tarde', 'noite', 'madrinhas', 'convidadas', 'noivo', 'noivas', 'pronto', 'cabelos', 'sabados', 'proximo', 'ponta', 'prontas']);

export function fuzzyCorrect(t: string): string {
  return t.replace(/[a-z]{5,}/g, (w) => {
    if (VOCAB.includes(w) || KEEP.has(w)) return w;
    let best: string | undefined, bd = 99;
    for (const v of VOCAB) {
      if (Math.abs(v.length - w.length) > 2) continue;
      const d = levenshtein(w, v);
      const max = v.length >= 8 ? 2 : 1;
      if (d <= max && d < bd) { best = v; bd = d; }
    }
    return best ?? w;
  });
}

export function preprocess(normalized: string): string {
  let t = normalized;
  for (const [r, v] of SLANG) t = t.replace(r, v);
  t = fuzzyCorrect(t);
  return numberWordsToDigits(t);
}
