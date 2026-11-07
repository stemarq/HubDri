import { z } from 'zod';
import { DB, one, run, j, parse, all, tx } from '../db.js';

export const DayType = z.enum(['WEEKDAY', 'WEEKEND', 'HOLIDAY']);
const hhmm = z.string().regex(/^\d{2}:\d{2}$/);

export const SchedulingSettings = z.object({
  prepMinutes: z.number().int().min(0).default(20),          // montagem do kit ao chegar
  finishMarginMinutes: z.number().int().min(0).default(30),  // folga de segurança entre terminar e a cliente precisar estar pronta
  cleanupMinutes: z.number().int().min(0).default(15),       // organização antes de sair
  bufferBetweenMinutes: z.number().int().min(0).default(30), // margem entre compromissos
  travelSafetyMinutes: z.number().int().min(0).default(10),  // folga somada ao tempo de trajeto
});

export const TransportSettings = z.object({
  baseAddress: z.string().optional(),
  baseFareCents: z.number().int().min(0).default(600),
  perKmCents: z.number().int().min(0).default(220),
  perMinuteCents: z.number().int().min(0).default(45),
  minFareCents: z.number().int().min(0).default(1000),
  peakMultiplier: z.number().min(1).default(1.3),
  weekendMultiplier: z.number().min(1).default(1.1),
  holidayMultiplier: z.number().min(1).default(1.15),
  nightMultiplier: z.number().min(1).default(1.5),
  rainMultiplier: z.number().min(1).default(1.25),
  safetyMarginPercent: z.number().min(0).default(10),
  peakDurationFactor: z.number().min(1).default(1.35),   // trânsito de pico quando o provedor de rotas não o considera (OSM)
  discountPercent: z.number().min(0).max(100).default(0),    // desconto autorizado (cupom/assinatura)
  peakWindows: z.array(z.object({ from: hhmm, to: hhmm })).default([{ from: '07:00', to: '09:30' }, { from: '17:00', to: '20:00' }]),
  roundToCents: z.number().int().min(1).default(100),
});

export const PricingExtras = z.object({
  nightWindow: z.object({ from: hhmm, to: hhmm }).default({ from: '00:00', to: '06:00' }),
  /** Sem valor => atendimento na madrugada vai para revisão humana. appliesTo define explicitamente onde incide. */
  nightMultiplier: z.object({
    factor: z.number().min(1),
    appliesTo: z.array(z.enum(['service', 'transport', 'addons'])).min(1),
  }).nullable().default(null),
  addons: z.array(z.object({ code: z.string().min(1), name: z.string().min(1), amountCents: z.number().int().min(0) })).default([]),
  discounts: z.array(z.object({ code: z.string().min(1), name: z.string(), percent: z.number().min(0).max(100) })).default([]),
  holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).default([]),
});

export const Branding = z.object({
  businessName: z.string().default('Adriana · Maquiagem e Visagismo'),
  logoPath: z.string().optional(),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{3,8}$/).default('#b5527a'),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{3,8}$/).default('#f6e3ea'),
  photos: z.array(z.string()).max(6).default([]),
  serviceDescriptions: z.record(z.string(), z.string()).default({}),
  paymentTerms: z.string().optional(),
  validityDays: z.number().int().min(1).default(7),
  notes: z.string().optional(),
});

export const BusinessSettings = z.object({
  manualQuoteMinutes: z.number().min(0).nullable().default(null), // para "tempo economizado"; sem valor => métrica indisponível
});
export const WhatsAppSettings = z.object({
  quoteTemplateName: z.string().optional(),
  quoteTemplateLang: z.string().default('pt_BR'),
});
export const FaqSettings = z.array(z.object({ keywords: z.array(z.string()).min(1), answer: z.string() })).default([]);

export const SETTING_SCHEMAS = {
  scheduling: SchedulingSettings, transport: TransportSettings, pricing: PricingExtras,
  branding: Branding, business: BusinessSettings, whatsapp: WhatsAppSettings, faq: FaqSettings,
} as const;
export type SettingKey = keyof typeof SETTING_SCHEMAS;
export type SettingOf<K extends SettingKey> = z.infer<(typeof SETTING_SCHEMAS)[K]>;

export function getSetting<K extends SettingKey>(db: DB, key: K): SettingOf<K> {
  const row = one(db, 'SELECT value FROM business_settings WHERE key=?', key);
  return SETTING_SCHEMAS[key].parse(parse<unknown>(row?.value, key === 'faq' ? [] : {})) as SettingOf<K>;
}
export function setSetting<K extends SettingKey>(db: DB, key: K, value: unknown): SettingOf<K> {
  const v = SETTING_SCHEMAS[key].parse(value);
  run(db, 'INSERT INTO business_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, j(v));
  return v as SettingOf<K>;
}

export interface PricingSettingsDoc {
  services: { code: string; name: string; durationMin: number; active: boolean }[];
  prices: { serviceCode: string; dayType: z.infer<typeof DayType>; amountCents: number }[];
  extras: SettingOf<'pricing'>;
  transport: SettingOf<'transport'>;
  scheduling: SettingOf<'scheduling'>;
}

export const PricingSettingsInput = z.object({
  services: z.array(z.object({ code: z.string().min(1), name: z.string().min(1), durationMin: z.number().int().min(15).max(720), active: z.boolean().default(true) })).optional(),
  prices: z.array(z.object({ serviceCode: z.string(), dayType: DayType, amountCents: z.number().int().min(0) })).optional(),
  extras: PricingExtras.optional(),
  transport: TransportSettings.optional(),
  scheduling: SchedulingSettings.optional(),
});

export function readPricingSettings(db: DB): PricingSettingsDoc {
  return {
    services: all(db, 'SELECT * FROM services ORDER BY code').map((r) => ({ code: r.code, name: r.name, durationMin: r.duration_min, active: !!r.active })),
    prices: all(db, 'SELECT * FROM pricing_rules ORDER BY service_code, day_type').map((r) => ({ serviceCode: r.service_code, dayType: r.day_type, amountCents: r.amount_cents })),
    extras: getSetting(db, 'pricing'), transport: getSetting(db, 'transport'), scheduling: getSetting(db, 'scheduling'),
  };
}

export function writePricingSettings(db: DB, input: z.infer<typeof PricingSettingsInput>): PricingSettingsDoc {
  tx(db, () => {
    if (input.services) {
      const st = db.prepare('INSERT INTO services(code,name,duration_min,active) VALUES(?,?,?,?) ON CONFLICT(code) DO UPDATE SET name=excluded.name,duration_min=excluded.duration_min,active=excluded.active');
      input.services.forEach((s) => st.run(s.code, s.name, s.durationMin, s.active ? 1 : 0));
    }
    if (input.prices) {
      const known = new Set(all(db, 'SELECT code FROM services').map((r) => r.code));
      db.exec('DELETE FROM pricing_rules');
      const st = db.prepare('INSERT INTO pricing_rules(service_code,day_type,amount_cents) VALUES(?,?,?)');
      input.prices.forEach((p) => {
        if (!known.has(p.serviceCode)) throw new Error(`Serviço desconhecido: ${p.serviceCode}`);
        st.run(p.serviceCode, p.dayType, p.amountCents);
      });
    }
    if (input.extras) setSetting(db, 'pricing', input.extras);
    if (input.transport) setSetting(db, 'transport', input.transport);
    if (input.scheduling) setSetting(db, 'scheduling', input.scheduling);
  });
  return readPricingSettings(db);
}
