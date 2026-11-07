import { existsSync } from 'node:fs';
import { loadConfig } from './config.js';
import { buildContext } from './context.js';
import { createApp } from './app.js';
import { TelegramAdapter, TelegramPoller } from './channels/telegram.js';
import { handleEvent } from './agent/agent.js';
import { startBackups } from './services/backup.js';
import { logger } from './lib/logger.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const config = loadConfig();
const ctx = buildContext(config);
const app = createApp(ctx);
const telegram = config.telegram.botToken ? new TelegramPoller(ctx.channels.TELEGRAM as TelegramAdapter, ctx.mediaDir, (e) => handleEvent(ctx, e)) : undefined;
app.listen(config.port, () => {
  telegram?.start();
  startBackups(ctx);
  logger.info('server.started', { port: config.port, adminTokenConfigured: !!config.adminToken, calendar: ctx.calendar.adapter.name,
    routes: ctx.transport.providerName, simulacao: config.simulate });
  if (!config.adminToken) logger.warn('ADMIN_API_TOKEN ausente: endpoints /api responderão 503');
});
