// Gera o GOOGLE_REFRESH_TOKEN para o Google Agenda da Adriana (fluxo "app de computador", sem servidor público).
// Uso: preencha GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET no agente/.env e rode `npm run google-auth` dentro de agente/.
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { exec } from 'node:child_process';

if (existsSync('.env')) process.loadEnvFile('.env');
const id = process.env.GOOGLE_CLIENT_ID, secret = process.env.GOOGLE_CLIENT_SECRET;
if (!id || !secret) { console.error('Defina GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET no agente/.env (veja agente/GUIA_GOOGLE_AGENDA.md).'); process.exit(1); }

const PORT = 53682, redirect = `http://localhost:${PORT}`;
const scope = 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly';
const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({ client_id: id, redirect_uri: redirect, response_type: 'code', scope, access_type: 'offline', prompt: 'consent' });

const server = createServer(async (req, res) => {
  const code = new URL(req.url ?? '/', redirect).searchParams.get('code');
  if (!code) { res.end('Aguardando autorização…'); return; }
  try {
    const tr = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: id, client_secret: secret, redirect_uri: redirect, grant_type: 'authorization_code' }) });
    const t: any = await tr.json();
    if (!t.refresh_token) throw new Error(t.error_description ?? 'Google não devolveu refresh_token (revogue o acesso do app em myaccount.google.com/permissions e tente de novo)');
    const cal: any = await (await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', { headers: { authorization: `Bearer ${t.access_token}` } })).json();
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<h2>Pronto! Pode voltar ao terminal.</h2>');
    console.log('\nAutorizado. Cole no agente/.env:\n');
    console.log(`GOOGLE_REFRESH_TOKEN=${t.refresh_token}`);
    console.log('\nAgendas disponíveis (use o id em GOOGLE_CALENDAR_ID; "primary" é a principal):');
    for (const c of cal.items ?? []) console.log(`  ${c.primary ? 'primary' : c.id}  —  ${c.summary}`);
  } catch (e) { res.end('Erro: ' + (e as Error).message); console.error('Erro:', (e as Error).message); }
  server.close();
});
server.listen(PORT, () => {
  console.log('Abra este endereço e autorize (se o navegador não abrir sozinho):\n\n' + url + '\n');
  exec(process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`);
});
