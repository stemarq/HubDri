import { ChannelAdapter } from './types.js';

/** Canal do simulador web e da API de testes: nada sai para a rede. */
export class SimulatorAdapter implements ChannelAdapter {
  readonly name = 'SIMULATOR' as const;
  readonly simulated = true;
  ready() { return true; }
  async sendText() { /* a resposta volta no corpo de POST /api/chat/message */ }
  async sendDocument() { /* o PDF fica disponível em GET /api/quotes/:id/pdf */ }
}
