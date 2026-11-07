// Cópia diária do banco (histórico de todas as conversas). VACUUM INTO gera um arquivo consistente com o servidor no ar.
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Ctx } from '../context.js';
import { logger } from '../lib/logger.js';

const PADRAO = /^adri-\d{8}\.db$/;

export function backupNow(ctx: Ctx, keep = 14): string | null {
  const dir = join(ctx.config.dataDir, 'backups');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date(ctx.now().getTime() - 3 * 3600_000).toISOString().slice(0, 10).replaceAll('-', '');
  const file = join(dir, `adri-${stamp}.db`);
  if (existsSync(file)) return null; // uma por dia
  try {
    ctx.db.exec(`VACUUM INTO '${file.replaceAll('\\', '/').replaceAll("'", "''")}'`);
    for (const f of readdirSync(dir).filter((x) => PADRAO.test(x)).sort().slice(0, -keep)) rmSync(join(dir, f), { force: true });
    logger.info('backup.ok', { file });
    return file;
  } catch (e) { logger.error('backup.failed', { err: (e as Error).message }); return null; }
}

export function startBackups(ctx: Ctx) {
  backupNow(ctx);
  setInterval(() => backupNow(ctx), 6 * 3600_000).unref();
}

export const lastBackup = (ctx: Ctx): string | undefined => {
  const dir = join(ctx.config.dataDir, 'backups');
  return existsSync(dir) ? readdirSync(dir).filter((f) => PADRAO.test(f)).sort().at(-1) : undefined;
};
