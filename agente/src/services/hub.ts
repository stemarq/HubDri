// Integração com o hub administrativo (src/ na raiz do repositório).
// Fluxo: ADRI -> POST /api/webhooks/whatsapp/lead (hub calcula, gera o PDF e a Adriana aprova no app)
//        hub -> POST /api/hub/callback (orcamento_aprovado | resposta_cliente) -> ADRI entrega o PDF e reserva a agenda.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { Config } from '../config.js';
import { Ctx } from '../context.js';
import { all, one, parse, run } from '../db.js';
import { logger } from '../lib/logger.js';
import { epochToLocal, fmtDateBR, fmtEpochTime } from '../lib/time.js';
import { SERVICE_NAMES } from '../agent/persona.js';
import { acceptQuote, QuoteError } from './quotes.js';
import { handoff } from '../agent/agent.js';

export class HubClient {
  constructor(private cfg: Config, private fetchFn: typeof fetch = fetch) {}
  enabled() { return !!this.cfg.hub.url; }
  private headers() { return { 'content-type': 'application/json', ...(this.cfg.hub.webhookToken ? { 'x-hub-token': this.cfg.hub.webhookToken } : {}) }; }

  async sendLead(payload: unknown): Promise<{ orcamentoId: string; codigo: string; novo: boolean }> {
    const res = await this.fetchFn(`${this.cfg.hub.url}/api/webhooks/whatsapp/lead`, { method: 'POST', headers: this.headers(), body: JSON.stringify(payload), signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Hub respondeu HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as any;
  }
  async sendReply(orcamentoId: string, decisao: 'aprovado' | 'mudanca', comentario?: string) {
    const res = await this.fetchFn(`${this.cfg.hub.url}/api/webhooks/whatsapp/resposta`, { method: 'POST', headers: this.headers(), body: JSON.stringify({ orcamentoId, decisao, comentario }), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Hub respondeu HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  /** Baixa o PDF gerado pelo hub. Só aceita URLs do próprio hub (evita SSRF via callback). */
  async downloadPdf(url: string, dest: string): Promise<void> {
    if (!url.startsWith(this.cfg.hub.url!)) throw new Error('pdfUrl fora do hub configurado');
    const res = await this.fetchFn(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`PDF do hub HTTP ${res.status}`);
    mkdirSync(join(dest, '..'), { recursive: true });
    writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  }
}

const MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

/** Monta o lead do hub a partir do orçamento do agente (dados coletados + agenda + deslocamento). */
export function buildLeadPayload(ctx: Ctx, quoteId: string) {
  const q = one(ctx.db, 'SELECT * FROM quotes WHERE id=?', quoteId)!;
  const cust = one(ctx.db, 'SELECT * FROM customers WHERE id=?', q.customer_id)!;
  const ev = parse<any>(q.event, {});
  const sch = parse<any>(q.schedule, {});
  const av = parse<any>(q.availability, {});
  const reasons = parse<string[]>(q.review_reasons, []);
  const est = all(ctx.db, 'SELECT leg,distance_m,duration_s,predicted_cents,confidence,simulated FROM transportation_estimates WHERE quote_id=?', quoteId);
  const out = est.find((e) => e.leg === 'OUTBOUND');
  const svcName = SERVICE_NAMES[q.service_code] ?? q.service_code;
  const cap = (s?: string) => (s ? s[0].toUpperCase() + s.slice(1) : undefined);
  const ready = ev.readyMin !== undefined ? `${String(Math.floor(ev.readyMin / 60)).padStart(2, '0')}:${String(ev.readyMin % 60).padStart(2, '0')}` : undefined;
  const km = out?.distance_m ? Math.round(out.distance_m / 100) / 10 : undefined;
  const respostas: { pergunta: string; resposta: string }[] = [
    { pergunta: 'Serviços', resposta: svcName },
    ...(ev.role ? [{ pergunta: 'Quem será maquiada', resposta: cap(ev.role)! }] : []),
    { pergunta: 'Data do evento', resposta: fmtDateBR(ev.date) },
    ...(ready ? [{ pergunta: 'Horário em que precisa estar pronta', resposta: ready }] : []),
    { pergunta: 'Início do atendimento', resposta: `às ${fmtEpochTime(sch.startEpoch)} (término ${fmtEpochTime(sch.endEpoch)})` },
    { pergunta: 'Saída da Adriana', resposta: sch.travelVerified ? fmtEpochTime(sch.departureEpoch) : 'não calculada (rota indisponível)' },
    { pergunta: 'Local do atendimento', resposta: ev.address ?? ev.neighborhood ?? '—' },
    ...(km ? [{ pergunta: 'Distância até o local', resposta: `${km} km (estimativa${out?.simulated ? ' por rota simulada' : ''})` }] : []),
    ...(est.length ? [{ pergunta: 'Deslocamento estimado (ida e volta)', resposta: `R$ ${(est.reduce((s, e) => s + (e.predicted_cents ?? 0), 0) / 100).toFixed(2)} (confiança ${out?.confidence ?? 'baixa'}; não é cotação da Uber)` }] : []),
    { pergunta: 'Agenda', resposta: av.verified ? (av.available ? `livre (${av.simulated ? 'agenda simulada' : 'Google Agenda'})` : 'com conflito') : 'não verificada' },
    ...(reasons.length ? [{ pergunta: 'Alertas do agente', resposta: reasons.join('; ') }] : []),
  ];
  const conversa = all(ctx.db, 'SELECT direction,author,body,created_at FROM messages WHERE conversation_id=? AND type IN (?,?) ORDER BY created_at, rowid', q.conversation_id, 'text', 'image')
    .filter((m) => m.body)
    .map((m) => ({ de: m.direction === 'IN' ? 'cliente' : m.author === 'ADRIANA' ? 'adriana' : 'ia', texto: String(m.body), em: new Date(m.created_at).toISOString() }));
  const imagens = ((ev.inspirations ?? []) as string[]).filter((p) => existsSync(p)).slice(0, 6)
    .map((p) => ({ base64: readFileSync(p).toString('base64'), mimeType: MIME[extname(p).toLowerCase()] ?? 'image/jpeg' }));
  const dateBR = fmtDateBR(ev.date);
  return {
    conversationId: q.conversation_id,
    cliente: { nome: ev.customerName ?? cust.name ?? undefined, telefone: String(cust.wa_id).replace(/^tg:/, 'telegram:'), cidade: ev.neighborhood ? `${ev.neighborhood}, São Paulo/SP` : undefined },
    evento: { tipo: cap(ev.eventType) ?? 'Atendimento', data: dateBR, horario: fmtEpochTime(sch.startEpoch), local: ev.address ?? ev.neighborhood },
    briefing: {
      resumo: `${cap(ev.role) ?? 'Cliente'} quer ${svcName}${ev.eventType ? ` para ${ev.eventType}` : ''} em ${dateBR}${ready ? `, pronta às ${ready}` : ''}. Atendimento das ${fmtEpochTime(sch.startEpoch)} às ${fmtEpochTime(sch.endEpoch)}, em ${ev.address ?? ev.neighborhood}${km ? ` (~${km} km)` : ''}.`,
      respostas,
    },
    // Estimativa estruturada (ida e volta, em reais): o hub põe como item do orçamento a domicílio.
    ...(est.length ? { deslocamento: {
      valor: est.reduce((s, e) => s + (e.predicted_cents ?? 0), 0) / 100,
      km: km ?? null,
      minutos: out?.duration_s ? Math.round(out.duration_s / 60) : null,
      confianca: out?.confidence ?? 'baixa',
      simulado: !!out?.simulated,
    } } : {}),
    conversa, imagens,
  };
}

/** Envia o lead e guarda o vínculo. Em falha, o orçamento fica NEEDS_REVIEW com motivo (e pode ser reenviado). */
export async function pushToHub(ctx: Ctx, quoteId: string): Promise<{ ok: boolean; codigo?: string; error?: string }> {
  try {
    const r = await ctx.hub!.sendLead(buildLeadPayload(ctx, quoteId));
    run(ctx.db, "UPDATE quotes SET hub_id=?, hub_code=?, status='IN_HUB', updated_at=? WHERE id=?", r.orcamentoId, r.codigo, ctx.now().getTime(), quoteId);
    const reasons = parse<string[]>(one(ctx.db, 'SELECT review_reasons FROM quotes WHERE id=?', quoteId)?.review_reasons, []).filter((x) => !x.startsWith('HUB_UNAVAILABLE'));
    run(ctx.db, 'UPDATE quotes SET review_reasons=? WHERE id=?', JSON.stringify(reasons), quoteId);
    logger.info('hub.lead.sent', { quoteId, codigo: r.codigo });
    return { ok: true, codigo: r.codigo };
  } catch (e) {
    const msg = (e as Error).message;
    logger.error('hub.lead.failed', { quoteId, err: msg });
    const q = one(ctx.db, 'SELECT review_reasons FROM quotes WHERE id=?', quoteId)!;
    const reasons = [...parse<string[]>(q.review_reasons, []).filter((x) => !x.startsWith('HUB_UNAVAILABLE')), `HUB_UNAVAILABLE:${msg.slice(0, 120)}`];
    run(ctx.db, "UPDATE quotes SET review_reasons=?, status='NEEDS_REVIEW' WHERE id=?", JSON.stringify(reasons), quoteId);
    return { ok: false, error: msg };
  }
}

const findQuote = (ctx: Ctx, b: { orcamentoId?: string; conversationId?: string }) =>
  (b.orcamentoId ? one(ctx.db, 'SELECT * FROM quotes WHERE hub_id=?', b.orcamentoId) : undefined) ??
  (b.conversationId ? one(ctx.db, 'SELECT * FROM quotes WHERE conversation_id=? AND hub_id IS NOT NULL ORDER BY created_at DESC LIMIT 1', b.conversationId) : undefined);

/** Eventos vindos do hub (WHATSAPP_CALLBACK_URL). Lança QuoteError para o hub marcar falha e permitir reenvio. */
export async function handleHubCallback(ctx: Ctx, b: any): Promise<{ ok: true; ignored?: string }> {
  const q = findQuote(ctx, b);
  if (!q) throw new QuoteError('QUOTE_NOT_FOUND', 404, 'Orçamento do hub desconhecido para este agente');
  const now = ctx.now().getTime();

  if (b.evento === 'orcamento_aprovado') {
    if (!['IN_HUB', 'SENT', 'NEEDS_REVIEW'].includes(q.status)) return { ok: true, ignored: `status ${q.status}` };
    const dest = join(ctx.pdfDir, `hub-${b.codigo ?? q.hub_code}-${now}.pdf`);
    try { await ctx.hub!.downloadPdf(b.pdfUrl, dest); } catch (e) { throw new QuoteError('PDF_DOWNLOAD_FAILED', 502, (e as Error).message); }
    run(ctx.db, "UPDATE quotes SET pdf_path=?, total_cents=?, approved_at=COALESCE(approved_at, ?), updated_at=? WHERE id=?", dest, Math.round(Number(b.total ?? 0) * 100), now, now, q.id);
    const caption = String(b.mensagemSugerida ?? 'Aqui está a sua proposta 💗');
    // Só o PDF com a mensagem: nada de link. A cliente confirma ou pede ajustes respondendo na conversa.
    try {
      await ctx.outbound.sendQuoteDocument(q.conversation_id, dest, caption, { idemKey: `hub-send:${b.orcamentoId}:${b.enviadoEm ?? now}`, author: 'ADRIANA' });
    } catch (e) { throw new QuoteError('SEND_FAILED', 502, (e as Error).message); }
    run(ctx.db, "UPDATE quotes SET status='SENT', sent_at=?, hub_status='enviado' WHERE id=?", now, q.id);
    ctx.events.emit('QUOTE_APPROVED', { quoteId: q.id, via: 'hub' });
    ctx.events.emit('QUOTE_SENT', { quoteId: q.id, channel: 'hub' });
    return { ok: true };
  }

  if (b.evento === 'resposta_cliente') {
    if (b.decisao !== 'aprovado') return { ok: true, ignored: 'decisão sem ação' };
    return acceptAndConfirm(ctx, q.id, 'cliente-link');
  }
  return { ok: true, ignored: `evento ${b.evento}` };
}

/** Cliente aprovou: reserva na agenda (Google Calendar se configurado) e confirma no chat. */
export async function acceptAndConfirm(ctx: Ctx, quoteId: string, actor: string): Promise<{ ok: true; ignored?: string }> {
  const q = one(ctx.db, 'SELECT * FROM quotes WHERE id=?', quoteId)!;
  if (q.status === 'ACCEPTED') return { ok: true, ignored: 'já aceito' };
  try {
    const r = await acceptQuote(ctx, quoteId, actor);
    const sch = parse<any>(q.schedule, {});
    await ctx.outbound.sendText(q.conversation_id, `Aprovado! 🎉 Seu horário está reservado: ${fmtDateBR(epochToLocal(sch.startEpoch).date)}, a partir das ${fmtEpochTime(sch.startEpoch)}. A Adriana entra em contato para combinar o sinal.`, { author: 'ADRI', idemKey: `accepted:${quoteId}` }).catch(() => undefined);
    void r;
    return { ok: true };
  } catch (e) {
    if (e instanceof QuoteError) {
      logger.warn('hub.accept.failed', { quoteId, code: e.code });
      await ctx.outbound.sendText(q.conversation_id, 'Recebi a sua aprovação! 💗 Só vou confirmar o horário com a Adriana e já te retorno.', { author: 'ADRI', idemKey: `accept-pending:${quoteId}` }).catch(() => undefined);
      handoff(ctx, q.conversation_id, `ACCEPT_${e.code}`);
      return { ok: true, ignored: e.code };
    }
    throw e;
  }
}
