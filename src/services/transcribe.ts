// Transcrição de áudio (opcional). Sem OPENAI_API_KEY nada é transcrito e a ADRI avisa a cliente.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { logger } from '../lib/logger.js';

export interface Transcriber { name: string; transcribe(filePath: string): Promise<string | null> }

export class WhisperTranscriber implements Transcriber {
  name = 'openai-whisper';
  constructor(private apiKey: string, private model = 'whisper-1', private fetchFn: typeof fetch = fetch) {}
  async transcribe(filePath: string): Promise<string | null> {
    try {
      const form = new FormData();
      form.append('model', this.model); form.append('language', 'pt');
      form.append('file', new Blob([readFileSync(filePath)]), basename(filePath));
      const res = await this.fetchFn('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}` }, body: form, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) { logger.warn('transcribe.http', { status: res.status }); return null; }
      const text = ((await res.json()) as any).text as string | undefined;
      return text?.trim() || null;
    } catch (e) { logger.warn('transcribe.failed', { err: (e as Error).message }); return null; }
  }
}
