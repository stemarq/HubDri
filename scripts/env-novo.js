// Cria .env e agente/.env VAZIOS (a partir dos .env.example) quando ainda não existem.
// Entrega para a Adriana: ela roda `npm run env:novo` e preenche as chaves dela. Nunca sobrescreve um .env existente.
import fs from "node:fs";

for (const [modelo, destino] of [[".env.example", ".env"], ["agente/.env.example", "agente/.env"]]) {
  if (fs.existsSync(destino)) {
    console.log(`= ${destino} já existe, mantido.`);
    continue;
  }
  fs.copyFileSync(modelo, destino);
  console.log(`+ ${destino} criado vazio a partir de ${modelo}. Preencha as chaves.`);
}
