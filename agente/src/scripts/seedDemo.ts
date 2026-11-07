// SOMENTE DEMONSTRAÇÃO. Preços e multiplicador abaixo são FICTÍCIOS e existem para exercitar o fluxo.
// Nunca rode em produção: a Adriana deve cadastrar os valores reais em PUT /api/settings/pricing.
import { existsSync } from 'node:fs';
import { loadConfig } from '../config.js';
import { openDb } from '../db.js';
import { writePricingSettings } from '../services/settings.js';
import { PricingExtras, TransportSettings, SchedulingSettings } from '../services/settings.js';

if (existsSync('.env')) process.loadEnvFile('.env');
export function seedDemo(db: ReturnType<typeof openDb>) {
  const day = ['WEEKDAY', 'WEEKEND', 'HOLIDAY'] as const;
  const base: Record<string, number[]> = { MAKEUP: [15000, 18000, 20000], HAIR: [13000, 16000, 18000], MAKEUP_HAIR: [26000, 31000, 34000], BRIDE_PACKAGE: [60000, 70000, 80000] };
  writePricingSettings(db, {
    prices: Object.entries(base).flatMap(([serviceCode, v]) => day.map((dayType, i) => ({ serviceCode, dayType, amountCents: v[i] }))),
    extras: PricingExtras.parse({ nightMultiplier: { factor: 3, appliesTo: ['service'] }, addons: [{ code: 'CILIOS', name: 'Aplicação de cílios', amountCents: 3000 }], discounts: [{ code: 'INDICACAO10', name: 'Indicação', percent: 10 }] }),
    transport: TransportSettings.parse({ baseAddress: 'Vila Mariana, São Paulo' }),
    scheduling: SchedulingSettings.parse({}),
  });
}
if (process.argv[1]?.endsWith('seedDemo.ts')) {
  const db = openDb(loadConfig().dbPath);
  seedDemo(db);
  console.log('Seed DEMO aplicado (valores fictícios).');
}
