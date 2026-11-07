// Voz da ADRI. Texto 100% determinístico: variações dependem do contexto (quantas vezes a pergunta já foi feita, tom da cliente,
// emoção detectada), nunca de sorteio, para que o comportamento seja testável. Veja docs/PERSONA.md.
import { fmtDateLong, fmtTime } from '../lib/time.js';

export interface Tone { casual: boolean; formal: boolean }
export const SERVICE_NAMES: Record<string, string> = { MAKEUP: 'maquiagem', HAIR: 'penteado', MAKEUP_HAIR: 'maquiagem e penteado', BRIDE_PACKAGE: 'pacote de noiva (maquiagem e penteado)' };

export const heart = (t: Tone) => (t.formal ? '' : ' 💗');
export const firstName = (n?: string | null) => (n ? n.trim().split(/\s+/)[0] : undefined);

export function greeting(name: string | undefined, returning: boolean, t: Tone): string {
  const n = firstName(name);
  if (returning) return `${t.formal ? 'Olá' : 'Oi'}${n ? `, ${n}` : ''}! Que bom ter você de volta${heart(t)}.`;
  return `${t.formal ? 'Olá' : 'Oi'}${n ? `, ${n}` : ''}! Que bom ter você por aqui!${heart(t)} Sou a Adri, assistente virtual da Adriana (uma assistente automatizada): se quiser falar com ela, é só pedir.`;
}

export function empathy(emotion: 'nervous' | 'urgent' | 'happy' | undefined, t: Tone): string {
  if (emotion === 'nervous') return `Fica tranquila, vou te ajudar com tudo${heart(t)}. `;
  if (emotion === 'urgent') return 'Entendi que é para logo, vou agilizar. ';
  if (emotion === 'happy') return `Que alegria${heart(t)}! `;
  return '';
}

export const OFFER_HUMAN = 'Se preferir, posso chamar a Adriana para te atender pessoalmente.';

export interface AskCtx { n: number; hour?: number; neighborhood?: string; date?: string; readyMin?: number; savedAddress?: string; needsRole?: boolean; ambiguousDate?: 'weekend' | 'week' }

/** Texto da pergunta por chave; `n` = quantas vezes já foi perguntada sem progresso (0 = primeira vez). */
export function ask(key: string, c: AskCtx): string {
  const r = c.n;
  switch (key) {
    case 'service':
      return (r === 0 ? 'Você quer maquiagem, penteado ou os dois?' : 'Para eu te ajudar direitinho: é maquiagem, penteado ou os dois? Pode escrever do seu jeito.') +
        (c.needsRole ? ' E você vai como noiva, madrinha ou convidada?' : '');
    case 'date':
      if (c.ambiguousDate === 'weekend') return 'Fim de semana: seria sábado ou domingo? E qual dia do mês?';
      if (c.ambiguousDate === 'week') return 'Qual dia da semana você precisa? Pode me dizer o dia do mês também.';
      return r === 0 ? 'Para qual data é o atendimento?' : 'Qual é o dia? Pode ser “sábado”, “dia 21” ou “21/11”.';
    case 'date_confirm': return `Só confirmando: seria ${fmtDateLong(c.date!)}?`;
    case 'ready':
      return r === 0 ? 'Que horas você precisa estar pronta?' : 'Que horas você precisa estar pronta? Por exemplo: “10h” ou “3 da manhã”.';
    case 'period': return `Seria ${c.hour} da manhã, da tarde ou da noite?`;
    case 'time_confirm': return `Só confirmando: você precisa estar pronta às ${fmtTime(c.readyMin!)}, de madrugada? Isso exige que a Adriana saia bem cedo, então confirmo antes de seguir.`;
    case 'time_before_now': return 'Esse horário já passou hoje. Qual horário (ou outro dia) funciona para você?';
    case 'ready_after_event': return 'Você disse que o evento começa antes desse horário. Que horas você precisa estar pronta mesmo?';
    case 'address':
      if (c.savedAddress) return `Quer usar o mesmo endereço do outro atendimento (${c.savedAddress})? Se for outro, me passe rua, número e complemento.`;
      if (r >= 1) return 'Me passa assim: rua, número e complemento. Por exemplo: “Rua das Flores, 123, apto 45”.';
      return c.neighborhood ? `Pode me passar o endereço completo (rua, número e complemento) de onde você vai se arrumar em ${c.neighborhood}?` : 'Onde você vai se arrumar? Pode me passar o endereço completo (rua, número e complemento).';
    default: return '';
  }
}

export const MISUNDERSTOOD = [
  'Não entendi bem essa parte. Pode me explicar de outro jeito?',
  'Desculpa, ainda não peguei. Você pode me contar com outras palavras?',
];
export const APOLOGY = `Desculpa a confusão, vou tentar de novo com mais atenção. ${OFFER_HUMAN}`;

export function summary(s: { service?: string; eventType?: string; role?: string; date?: string; readyMin?: number; desiredStartMin?: number; address?: string }, t: Tone): string {
  const ev = [s.eventType, s.role ? `como ${s.role}` : ''].filter(Boolean).join(' ');
  const when = s.desiredStartMin !== undefined ? `começando às ${fmtTime(s.desiredStartMin)}` : `pronta às ${fmtTime(s.readyMin!)}`;
  return `Deixa eu conferir${heart(t)}: ${SERVICE_NAMES[s.service!] ?? s.service}${ev ? ` para ${ev}` : ''}, ${fmtDateLong(s.date!)}, ${when}, em ${s.address}. Posso enviar para a Adriana revisar?`;
}

export const HANDOFF_MSG = (t: Tone) => `Claro! Vou avisar a Adriana para continuar a conversa com você por aqui${heart(t)}`;
