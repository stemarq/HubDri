// Contrato de canal. O motor conversacional só conhece estes tipos: Telegram, WhatsApp Cloud API e simulador são plugáveis.
export type ChannelName = 'SIMULATOR' | 'WHATSAPP' | 'TELEGRAM';

/** Evento de entrada já normalizado pelo adaptador. */
export interface InboundEvent {
  channel: ChannelName;
  userId: string;               // identificador estável da cliente no canal (wa_id, tg:<chat_id>)
  displayName?: string;
  handle?: string;              // @usuário, quando o canal tem
  messageId?: string;           // id externo (idempotência)
  type: 'text' | 'image' | 'audio' | 'other';
  text?: string;
  mediaPath?: string;           // mídia já baixada para armazenamento local
}

export interface ChannelRecipient { userId: string; name?: string | null; lastInboundAt?: number | null; now: Date }

export interface ChannelAdapter {
  readonly name: ChannelName;
  /** Canal de teste: entregas são marcadas simulated=true e não valem como WhatsApp oficial. */
  readonly simulated: boolean;
  /** Credenciais presentes? */
  ready(): boolean;
  sendText(to: ChannelRecipient, text: string): Promise<void>;
  sendDocument(to: ChannelRecipient, file: { path: string; filename: string; caption: string }): Promise<void>;
}

/** Erro de canal. `permanent` => não adianta retentar. */
export class ChannelError extends Error {
  constructor(public code: string, msg?: string, public permanent = true) { super(msg ?? code); this.name = 'ChannelError'; }
}
export const WhatsAppError = ChannelError;
export type WhatsAppError = ChannelError;

export const httpError = (what: string, status: number) =>
  new ChannelError('SEND_FAILED', `${what} ${status}`, status < 500 && status !== 429);
