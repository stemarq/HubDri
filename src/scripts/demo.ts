// Demonstração de ponta a ponta no terminal (WhatsApp SIMULADO, agenda SIMULADA, rotas SIMULADAS, preços FICTÍCIOS de demo).
import { loadConfig } from '../config.js';
import { buildContext } from '../context.js';
import { openDb } from '../db.js';
import { handleInbound } from '../agent/agent.js';
import { seedDemo } from './seedDemo.js';
import * as Q from '../services/quotes.js';
import { overview } from '../services/analytics.js';
import { setLoggerSilent } from '../lib/logger.js';
import { brl, fmtEpochTime } from '../lib/time.js';

setLoggerSilent(true);
const ctx = buildContext(loadConfig({ DATA_DIR: 'data/demo', ADMIN_API_TOKEN: 'demo' } as NodeJS.ProcessEnv), { db: openDb(':memory:') });
seedDemo(ctx.db);
const say = async (text: string) => {
  console.log(`\n👤 Cliente: ${text}`);
  const r = await handleInbound(ctx, { waId: '5511999990000', name: 'Marina', channel: 'SIMULATOR', type: 'text', text });
  r.replies.forEach((m) => console.log(`💗 ADRI: ${m}`));
  return r;
};
await say('Oi, quero maquiagem e penteado para um casamento no sábado. Sou noiva, preciso estar pronta às 10h e vou me arrumar em Pinheiros.');
await say('Sim, isso mesmo');
const r = await say('Rua dos Pinheiros, 500, apto 12');
const v: any = Q.quoteView(ctx, r.quoteId!)!;
console.log(`\n📋 Hub: orçamento #${v.number} [${v.status}] total ${brl(v.totalCents)} | atendimento ${fmtEpochTime(v.schedule.startEpoch)}–${fmtEpochTime(v.schedule.endEpoch)}, saída ${fmtEpochTime(v.schedule.departureEpoch)}`);
v.items.forEach((i: any) => console.log(`   - ${i.label}: ${brl(i.amountCents)}`));
console.log(`   PDF: ${v.pdfAvailable ? 'gerado' : 'NÃO gerado'} | motivos de revisão: ${JSON.stringify(v.reviewReasons)}`);
Q.approve(ctx, v.id, 'adriana');
const s = await Q.sendQuote(ctx, v.id, 'adriana');
console.log(`✅ Aprovado e enviado via ${s.delivery.channel} (simulado=${s.delivery.simulated})`);
console.log('📊 Métricas:', JSON.stringify(overview(ctx), null, 1).slice(0, 600));
