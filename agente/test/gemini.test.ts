import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GeminiExtractor, GeminiTranscriber } from '../src/agent/gemini.js';
import { reconcile } from '../src/agent/llm.js';
import { extract } from '../src/agent/nlu.js';
import { NOW } from './helpers.js';

const ok = (text: string) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }));
const cfg = { apiKey: 'k', model: 'm', reserve: 'm2' };
const ctx = { today: '2026-11-09', weekday: 'segunda-feira', history: [] };

describe('Gemini no agente', () => {
  it('extrai dados estruturados e o resultado passa pela reconciliação com as regras', async () => {
    const calls: string[] = [];
    const f = (async (url: string, init: any) => { calls.push(String(url)); expect(init.headers['x-goog-api-key']).toBe('k'); return ok('```json\n{"service":"MAKEUP","eventType":"festa"}\n```'); }) as unknown as typeof fetch;
    const out = await new GeminiExtractor(cfg, f).extract('quero ficar linda na festa', ctx);
    expect(out).toMatchObject({ service: 'MAKEUP', eventType: 'festa' });
    expect(calls[0]).toContain('/models/m:generateContent');
    const { merged } = reconcile(extract('quero ficar linda na festa', NOW), out, '2026-11-09');
    expect(merged.service).toBe('MAKEUP');
  });
  it('JSON fora do schema é descartado; erro de rede devolve null', async () => {
    expect(await new GeminiExtractor(cfg, (async () => ok('{"readyTime":"25:99"}')) as unknown as typeof fetch).extract('x', ctx)).toBeNull();
    expect(await new GeminiExtractor(cfg, (async () => { throw new Error('rede'); }) as unknown as typeof fetch).extract('x', ctx)).toBeNull();
  });
  it('usa o modelo reserva quando o principal está sobrecarregado', async () => {
    const urls: string[] = [];
    const f = (async (url: string) => { urls.push(String(url)); return urls.length <= 2 ? new Response('{}', { status: 503 }) : ok('{"service":"HAIR"}'); }) as unknown as typeof fetch;
    const out = await new GeminiExtractor(cfg, f).extract('cabelo', ctx);
    expect(out?.service).toBe('HAIR');
    expect(urls[2]).toContain('/models/m2:generateContent');
  }, 15_000);
  it('transcreve áudio enviando o arquivo como inlineData', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'aud-')), 'voz.oga');
    writeFileSync(file, 'fake-audio');
    let body: any;
    const f = (async (_u: string, init: any) => { body = JSON.parse(init.body); return ok('quero maquiagem amanhã'); }) as unknown as typeof fetch;
    expect(await new GeminiTranscriber(cfg, f).transcribe(file)).toBe('quero maquiagem amanhã');
    expect(body.contents[0].parts[0].inlineData.mimeType).toBe('audio/ogg');
  });
});
