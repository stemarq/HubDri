export interface Config {
  port: number;
  adminToken?: string;
  dbPath: string;
  dataDir: string;
  routeProvider: 'google' | 'simulated';
  baseAddress?: string;
  whatsapp: { phoneNumberId?: string; accessToken?: string; appSecret?: string; verifyToken?: string; apiVersion: string };
  google: { mapsApiKey?: string; calendarId?: string; clientId?: string; clientSecret?: string; refreshToken?: string };
  telegram: { botToken?: string; allowedChatIds: string[] };
  hubWebhookUrl?: string;
  hubWebhookSecret?: string;
  chromePath?: string;
  llm: { anthropicApiKey?: string; model: string };
  openaiApiKey?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mapsApiKey = env.GOOGLE_MAPS_API_KEY || undefined;
  return {
    port: Number(env.PORT ?? 3000),
    adminToken: env.ADMIN_API_TOKEN || undefined,
    dbPath: env.DB_PATH ?? 'data/adri.db',
    dataDir: env.DATA_DIR ?? 'data',
    routeProvider: mapsApiKey && env.ROUTE_PROVIDER !== 'simulated' ? 'google' : 'simulated',
    baseAddress: env.BASE_ADDRESS || undefined,
    whatsapp: {
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || undefined,
      accessToken: env.WHATSAPP_ACCESS_TOKEN || undefined,
      appSecret: env.WHATSAPP_APP_SECRET || undefined,
      verifyToken: env.WHATSAPP_VERIFY_TOKEN || undefined,
      apiVersion: env.WHATSAPP_API_VERSION ?? 'v21.0',
    },
    google: {
      mapsApiKey,
      calendarId: env.GOOGLE_CALENDAR_ID || undefined,
      clientId: env.GOOGLE_CLIENT_ID || undefined,
      clientSecret: env.GOOGLE_CLIENT_SECRET || undefined,
      refreshToken: env.GOOGLE_REFRESH_TOKEN || undefined,
    },
    telegram: { botToken: env.TELEGRAM_BOT_TOKEN || undefined, allowedChatIds: (env.TELEGRAM_ALLOWED_CHAT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean) },
    hubWebhookUrl: env.HUB_WEBHOOK_URL || undefined,
    hubWebhookSecret: env.HUB_WEBHOOK_SECRET || undefined,
    chromePath: env.CHROME_PATH || undefined,
    llm: { anthropicApiKey: env.ANTHROPIC_API_KEY || undefined, model: env.LLM_MODEL || 'claude-haiku-5-5' },
    openaiApiKey: env.OPENAI_API_KEY || undefined,
  };
}

export const whatsappConfigured = (c: Config) =>
  !!(c.whatsapp.phoneNumberId && c.whatsapp.accessToken && c.whatsapp.appSecret && c.whatsapp.verifyToken);
export const googleCalendarConfigured = (c: Config) =>
  !!(c.google.calendarId && c.google.clientId && c.google.clientSecret && c.google.refreshToken);
