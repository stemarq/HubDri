// Envia as fotos do trabalho da Dri (data/marca/) para o Storage do Supabase, pasta marca/.
// Nome: <grupo>--<n>.jpg, com grupo = geral (apresentação) ou código do serviço (MAKE-EXPRESS, PENT, PENT-CACHEADO...).
// Uso: npm run marca:enviar            (envia/atualiza)
//      npm run marca:enviar -- --limpar (também apaga do Storage as fotos que não estão mais em data/marca/)
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const BUCKET = "imagens-orcamento";
const PASTA = path.resolve("data", "marca");
const url = process.env.SUPABASE_URL, chave = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !chave) { console.error("Configure SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no .env."); process.exit(1); }

const supa = createClient(url, chave, { auth: { persistSession: false } });
const locais = fs.readdirSync(PASTA).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort();
if (!locais.length) { console.error(`Nenhuma foto em ${PASTA}.`); process.exit(1); }

for (const f of locais) {
  const { error } = await supa.storage.from(BUCKET).upload(`marca/${f}`, fs.readFileSync(path.join(PASTA, f)), {
    contentType: /\.png$/i.test(f) ? "image/png" : "image/jpeg", upsert: true,
  });
  console.log(error ? `✗ ${f}: ${error.message}` : `✓ ${f}`);
}

if (process.argv.includes("--limpar")) {
  const { data } = await supa.storage.from(BUCKET).list("marca", { limit: 500 });
  const sobrando = (data || []).map((d) => d.name).filter((n) => !locais.includes(n));
  if (sobrando.length) await supa.storage.from(BUCKET).remove(sobrando.map((n) => `marca/${n}`));
  console.log(`Removidas do Storage: ${sobrando.length}`);
}
