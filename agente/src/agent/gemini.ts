// Gemini (Google AI Studio) para o agente: extração estruturada e transcrição de áudio. Mesmas variáveis do hub:
// GEMINI_API_KEY, GEMINI_MODEL, GEMINI_MODELO_RESERVA. Via REST (sem SDK). Saída sempre validada; nunca decide preço ou agenda.
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { logger } from '../lib/logger.js';
import { LlmContext, LlmExtractor, LlmOutput, SYSTEM, parseLlmJson, userPrompt } from './llm.js';
import { Transcriber } from '../services/transcribe.js';

export interface GeminiConfig { apiKey: string; model: string; reserve?: string }
const TEMPORARIOS = new Set([429, 500, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Part = { text: string } | { inlineData: { mimeType: string; data: string } };

async function callModel(cfg: GeminiConfig, model: string, system: string | undefined, parts: Part[], json: boolean, fetchFn: typeof fetch): Promise<string> {
  const res = await fetchFn(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.apiKey },
    body: JSON.stringify({
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature: 0, ...(json ? { responseMimeType: 'application/json' } : {}) },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) { const e: any = new Error(`Gemini HTTP ${res.status}`); e.status = res.status; throw e; }
  const data: any = await res.json();
  if (data?.promptFeedback?.blockReason) throw new Error(`Gemini bloqueou o pedido (${data.promptFeedback.blockReason})`);
  const text = (data?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('');
  if (!text) throw new Error('Gemini sem conteúdo');
  return text;
}

/** Tenta o modelo principal (2x) e depois o reserva, como o hub faz. */
export async function geminiGenerate(cfg: GeminiConfig, system: string | undefined, parts: Part[], json: boolean, fetchFn: typeof fetch = fetch): Promise<string> {
  let last: any;
  for (const wait of [0, 2500]) {
    await sleep(wait);
    try { return await callModel(cfg, cfg.model, system, parts, json, fetchFn); }
    catch (e: any) { last = e; if (!TEMPORARIOS.has(e?.status)) throw e; }
  }
  if (cfg.reserve && cfg.reserve !== 'nenhum' && cfg.reserve !== cfg.model) {
    logger.warn('gemini.reserva', { modelo: cfg.model, reserva: cfg.reserve });
    return callModel(cfg, cfg.reserve, system, parts, json, fetchFn);
  }
  throw last;
}

export class GeminiExtractor implements LlmExtractor {
  name = 'gemini';
  constructor(private cfg: GeminiConfig, private fetchFn: typeof fetch = fetch) {}
  async extract(text: string, ctx: LlmContext): Promise<LlmOutput | null> {
    try { return parseLlmJson(await geminiGenerate(this.cfg, SYSTEM, [{ text: userPrompt(text, ctx) }], true, this.fetchFn)); }
    catch (e) { logger.warn('gemini.extract.failed', { err: (e as Error).message }); return null; }
  }
}

const AUDIO_MIME: Record<string, string> = { '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.mp3': 'audio/mp3', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.wav': 'audio/wav', '.aac': 'audio/aac', '.flac': 'audio/flac' };

/** Transcrição de áudio de voz (Telegram/WhatsApp) com o próprio Gemini, sem serviço extra. */
export class GeminiTranscriber implements Transcriber {
  name = 'gemini';
  constructor(private cfg: GeminiConfig, private fetchFn: typeof fetch = fetch) {}
  async transcribe(filePath: string): Promise<string | null> {
    try {
      const mimeType = AUDIO_MIME[extname(filePath).toLowerCase()] ?? 'audio/ogg';
      const out = await geminiGenerate(this.cfg, undefined, [
        { inlineData: { mimeType, data: readFileSync(filePath).toString('base64') } },
        { text: 'Transcreva fielmente este áudio em português do Brasil. Responda somente com a transcrição, sem comentários. Se não houver fala, responda exatamente: [sem fala]' },
      ], false, this.fetchFn);
      const t = out.trim();
      return !t || t === '[sem fala]' ? null : t;
    } catch (e) { logger.warn('gemini.transcribe.failed', { err: (e as Error).message }); return null; }
  }
}
