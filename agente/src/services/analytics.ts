// Métricas agregadas a partir de dados reais. Sem dado => null (nunca número inventado). Proposta enviada NÃO é venda.
import { Ctx } from '../context.js';
import { all, one } from '../db.js';
import { getSetting } from './settings.js';

const avg = (a: number[]) => (a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : null);
const count = (ctx: Ctx, sql: string, ...p: any[]) => (one(ctx.db, sql, ...p)?.n as number) ?? 0;

export function overview(ctx: Ctx) {
  const customers = count(ctx, 'SELECT COUNT(*) n FROM customers');
  const requested = count(ctx, "SELECT COUNT(*) n FROM business_events WHERE type='QUOTE_REQUESTED'");
  const generated = count(ctx, 'SELECT COUNT(*) n FROM quotes');
  const approved = count(ctx, 'SELECT COUNT(*) n FROM quotes WHERE approved_at IS NOT NULL');
  const sent = count(ctx, 'SELECT COUNT(*) n FROM quotes WHERE sent_at IS NOT NULL');
  const accepted = count(ctx, 'SELECT COUNT(*) n FROM quotes WHERE accepted_at IS NOT NULL');
  const revenue = (one(ctx.db, 'SELECT COALESCE(SUM(total_cents),0) s FROM quotes WHERE accepted_at IS NOT NULL')?.s as number) ?? 0;
  const topServices = all(ctx.db, 'SELECT s.name, q.service_code code, COUNT(*) n FROM quotes q LEFT JOIN services s ON s.code=q.service_code GROUP BY q.service_code ORDER BY n DESC')
    .map((r) => ({ code: r.code, name: r.name ?? r.code, requests: r.n }));
  const elab = all(ctx.db, 'SELECT elaboration_ms e FROM quotes WHERE elaboration_ms IS NOT NULL').map((r) => r.e as number);
  const manual = getSetting(ctx.db, 'business').manualQuoteMinutes;
  const t = transportation(ctx);
  const lost = all(ctx.db, "SELECT COALESCE(lost_reason,'não informado') reason, COUNT(*) n FROM quotes WHERE status='LOST' GROUP BY reason ORDER BY n DESC").map((r) => ({ reason: r.reason, count: r.n }));
  const o = {
    customersAttended: customers, quotesRequested: requested, quotesGenerated: generated, quotesApproved: approved, quotesSent: sent, quotesAccepted: accepted,
    conversionRate: sent ? accepted / sent : null,                     // aceitas / enviadas
    topServices, contractedRevenueCents: revenue,                      // só propostas ACEITAS
    averageTicketCents: accepted ? Math.round(revenue / accepted) : null,
    averageQuoteElaborationMs: avg(elab),
    estimatedMinutesSaved: manual === null ? null : Math.round(manual * generated), // depende de businessSettings.manualQuoteMinutes informado pela Adriana
    averageTransportCostCents: t.averageActualCents ?? t.averagePredictedCents,
    transportPredictedVsActualCents: t.averageDifferenceCents,
    lostReasons: lost,
  };
  return { ...o, insights: insights(o, t) };
}

export function conversion(ctx: Ctx) {
  const byStatus = all(ctx.db, 'SELECT status, COUNT(*) n FROM quotes GROUP BY status').map((r) => ({ status: r.status, count: r.n }));
  const sent = count(ctx, 'SELECT COUNT(*) n FROM quotes WHERE sent_at IS NOT NULL');
  const accepted = count(ctx, 'SELECT COUNT(*) n FROM quotes WHERE accepted_at IS NOT NULL');
  const lost = count(ctx, "SELECT COUNT(*) n FROM quotes WHERE status='LOST'");
  const signals = count(ctx, "SELECT COUNT(*) n FROM business_events WHERE type='CLIENT_ACCEPTANCE_SIGNAL'");
  return { funnel: byStatus, sent, accepted, lost, conversionRate: sent ? accepted / sent : null, clientAcceptanceSignalsNotYetConfirmed: signals };
}

export function transportation(ctx: Ctx) {
  const est = all(ctx.db, 'SELECT predicted_cents p, confidence c, simulated s FROM transportation_estimates').filter((r) => r.p != null);
  const hist = all(ctx.db, 'SELECT predicted_cents p, actual_cents a, discount_cents d FROM transportation_history WHERE actual_cents IS NOT NULL');
  const withPred = hist.filter((h) => h.p != null);
  return {
    estimatesCount: est.length, simulatedEstimates: est.filter((r) => r.s).length,
    averagePredictedCents: avg(est.map((r) => r.p)),
    realTripsRecorded: hist.length,
    averageActualCents: avg(hist.map((h) => h.a)),
    averageDifferenceCents: withPred.length ? avg(withPred.map((h) => h.a - h.p)) : null, // real - previsto (positivo = subestimou)
    confidenceBreakdown: ['low', 'medium', 'high'].map((c) => ({ confidence: c, count: est.filter((r) => r.c === c).length })),
  };
}

function insights(o: any, t: ReturnType<typeof transportation>): string[] {
  const out: string[] = [];
  if (o.topServices[0]) out.push(`Serviço mais solicitado: ${o.topServices[0].name} (${o.topServices[0].requests} de ${o.quotesGenerated} orçamentos).`);
  if (o.quotesSent >= 1) out.push(`${o.quotesSent} proposta(s) enviada(s); ${o.quotesAccepted} aceita(s) confirmada(s) pela Adriana.`);
  if (o.quotesSent >= 5 && o.conversionRate !== null) out.push(`Taxa de conversão de ${(o.conversionRate * 100).toFixed(0)}% sobre propostas enviadas.`);
  if (t.realTripsRecorded < 3) out.push(`Só ${t.realTripsRecorded} corrida(s) real(is) registrada(s): as estimativas de deslocamento ainda têm baixa confiabilidade. Registre os custos reais após cada atendimento.`);
  else if (t.averageDifferenceCents !== null) out.push(`Em média o deslocamento real foi ${t.averageDifferenceCents >= 0 ? 'maior' : 'menor'} que o previsto em R$ ${(Math.abs(t.averageDifferenceCents) / 100).toFixed(2)}.`);
  if (o.lostReasons.length && o.lostReasons[0].reason !== 'não informado') out.push(`Principal motivo de perda informado: ${o.lostReasons[0].reason}.`);
  if (!out.length) out.push('Ainda não há dados suficientes para gerar insights.');
  return out;
}
