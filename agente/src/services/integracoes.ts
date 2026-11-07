// Painel de integrações: o que está realmente conectado, o que falta e o que (só em modo de teste) é simulado.
import { Ctx } from '../context.js';
import { whatsappConfigured } from '../config.js';
import { lastBackup } from './backup.js';

export interface Integracao { id: string; nome: string; status: 'ok' | 'pendente' | 'erro' | 'simulado'; detalhe: string }
let cache: { at: number; itens: Integracao[] } | undefined;

async function checar<T>(fn: () => Promise<T>): Promise<{ ok: true; v: T } | { ok: false; erro: string }> {
  try { return { ok: true, v: await fn() }; } catch (e) { return { ok: false, erro: (e as Error).message }; }
}

export async function integracoes(ctx: Ctx, force = false): Promise<Integracao[]> {
  if (!force && cache && Date.now() - cache.at < 30_000) return cache.itens;
  const c = ctx.config;
  const itens: Integracao[] = [];

  if (c.telegram.botToken) {
    const r = await checar(async () => {
      const x = await fetch(`https://api.telegram.org/bot${c.telegram.botToken}/getMe`, { signal: AbortSignal.timeout(5000) });
      if (!x.ok) throw new Error(`HTTP ${x.status}`);
      return ((await x.json()) as any).result.username as string;
    });
    itens.push({ id: 'telegram', nome: 'Telegram (chat com clientes)', status: r.ok ? 'ok' : 'erro', detalhe: r.ok ? `bot @${r.v} recebendo mensagens` : `token recusado: ${r.erro}` });
  } else itens.push({ id: 'telegram', nome: 'Telegram (chat com clientes)', status: 'pendente', detalhe: 'defina TELEGRAM_BOT_TOKEN' });

  itens.push({ id: 'whatsapp', nome: 'WhatsApp oficial (Meta)', status: whatsappConfigured(c) ? 'ok' : 'pendente',
    detalhe: whatsappConfigured(c) ? 'webhook e envio configurados' : 'ainda não configurado (veja GUIA_INTEGRACAO_WHATSAPP.md)' });

  const cal = ctx.calendar.adapter;
  if (cal.simulated) itens.push({ id: 'agenda', nome: 'Google Agenda', status: 'simulado', detalhe: 'agenda SIMULADA (SIMULAR=1): só para testes' });
  else if (cal.name.includes('não conectado')) itens.push({ id: 'agenda', nome: 'Google Agenda', status: 'pendente', detalhe: 'não conectado: a ADRI não confirma disponibilidade nem reserva horário (veja GUIA_GOOGLE_AGENDA.md)' });
  else {
    const r = await checar(() => cal.listBusy(Date.now(), Date.now() + 3600_000));
    itens.push({ id: 'agenda', nome: 'Google Agenda', status: r.ok ? 'ok' : 'erro', detalhe: r.ok ? 'lendo e criando eventos' : `falha ao ler a agenda: ${r.erro}` });
  }

  const rota = ctx.transport.providerName;
  itens.push({ id: 'rotas', nome: 'Rotas e deslocamento', status: rota === 'simulated-routes' ? 'simulado' : 'ok',
    detalhe: rota === 'google-routes' ? 'Google Routes (com trânsito)' : rota === 'osm' ? 'OpenStreetMap: distâncias reais, sem trânsito em tempo real (GOOGLE_MAPS_API_KEY adiciona o trânsito)' : 'rotas SIMULADAS (SIMULAR=1): só para testes' });
  itens.push({ id: 'saida', nome: 'Endereço de saída da Adriana', status: ctx.baseAddress() ? 'ok' : 'pendente', detalhe: ctx.baseAddress() ?? 'defina em Configurações: sem ele não há cálculo de rota' });

  itens.push({ id: 'ia', nome: 'IA de interpretação e áudio', status: ctx.llm ? 'ok' : 'pendente',
    detalhe: ctx.llm ? `${ctx.llm.name}${ctx.transcriber ? ' + transcrição de áudio' : ''}` : 'sem GEMINI_API_KEY: só regras; áudios não são transcritos' });

  if (ctx.hub) {
    const r = await checar(async () => {
      const x = await fetch(`${c.hub.url}/api/webhooks/whatsapp/orcamentos/ping`, { headers: c.hub.webhookToken ? { 'x-hub-token': c.hub.webhookToken } : {}, signal: AbortSignal.timeout(5000) });
      if (x.status === 401) throw new Error('token do hub recusado');
      return x.status;
    });
    itens.push({ id: 'hub', nome: 'Hub (orçamentos e aprovação)', status: r.ok ? 'ok' : 'erro', detalhe: r.ok ? `conectado em ${c.hub.url}` : `hub inacessível: ${r.erro}` });
  } else itens.push({ id: 'hub', nome: 'Hub (orçamentos e aprovação)', status: 'pendente', detalhe: 'defina HUB_URL: sem o hub os orçamentos não chegam à Adriana' });

  const b = lastBackup(ctx);
  itens.push({ id: 'backup', nome: 'Backup do histórico', status: b ? 'ok' : 'pendente', detalhe: b ? `último: ${b}` : 'ainda não houve backup' });
  cache = { at: Date.now(), itens };
  return itens;
}
