type Level = 'debug' | 'info' | 'warn' | 'error';
let silent = false;
export const setLoggerSilent = (v: boolean) => { silent = v; };
export function log(level: Level, msg: string, fields: Record<string, unknown> = {}) {
  if (silent) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
  (level === 'error' ? console.error : console.log)(line);
}
export const logger = {
  debug: (m: string, f?: Record<string, unknown>) => log('debug', m, f),
  info: (m: string, f?: Record<string, unknown>) => log('info', m, f),
  warn: (m: string, f?: Record<string, unknown>) => log('warn', m, f),
  error: (m: string, f?: Record<string, unknown>) => log('error', m, f),
};
