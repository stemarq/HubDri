// Cada falha real vira um caso em nlu-cases.json (e o id vai em regressionRef ao resolver a falha em /api/review/failures).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extract } from '../../src/agent/nlu.js';
import { NOW } from '../helpers.js';

interface Case { id: string; note?: string; text: string; awaiting?: string; asked?: string[]; expect?: Record<string, unknown>; absent?: string[] }
const cases: Case[] = JSON.parse(readFileSync(new URL('./nlu-cases.json', import.meta.url), 'utf-8'));

describe(`interpretação: ${cases.length} casos reais`, () => {
  it('há pelo menos 30 cenários e ids únicos', () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });
  it('inclui os bugs conhecidos', () => {
    expect(cases.map((c) => c.id)).toEqual(expect.arrayContaining(['BUG-3-da-manha', 'BUG-endereco-mmdc']));
  });
  it.each(cases.map((c) => [c.id, c] as const))('%s', (_id, c) => {
    const out = extract(c.text, NOW, c.awaiting, c.asked) as Record<string, unknown>;
    if (c.expect) expect(out).toMatchObject(c.expect);
    for (const k of c.absent ?? []) expect(out[k], `campo "${k}" não deveria existir`).toBeUndefined();
  });
});
