import { existsSync } from 'node:fs';
import { loadConfig } from './config.js';
import { buildContext } from './context.js';
import { createApp } from './app.js';
import { logger } from './lib/logger.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const config = loadConfig();
const ctx = buildContext(config);
const app = createApp(ctx);
app.listen(config.port, () => {
  logger.info('server.started', { port: config.port, adminTokenConfigured: !!config.adminToken, calendar: ctx.calendar.adapter.name,
    routes: config.routeProvider === 'google' ? 'google-routes' : 'simulated-routes' });
  if (!config.adminToken) logger.warn('ADMIN_API_TOKEN ausente: endpoints /api responderão 503');
});
