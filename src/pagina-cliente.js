// Página pública aberta pelo botão do PDF: a cliente aprova o orçamento.
// Pedidos de ajuste não são feitos aqui — ficam na conversa do WhatsApp.
import { config } from "./config.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const brl = (n) => Number(n || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

export function paginaCliente(orc, { erro } = {}) {
  const cfg = config();
  const calc = orc.calculo;
  const disponivel = ["enviado", "mudanca_cliente", "aceito_cliente"].includes(orc.status);
  const pdf = `/p/${orc.tokenPublico}/orcamento.pdf`;

  let corpo;
  if (orc.status === "aceito_cliente") {
    corpo = `
      <p class="label">Orçamento aprovado</p>
      <h2>Obrigada! Sua aprovação foi registrada.</h2>
      <p>A conversa continua no WhatsApp — os próximos passos chegam por lá.</p>`;
  } else if (orc.status === "mudanca_cliente") {
    corpo = `
      <p class="label">Em revisão</p>
      <h2>Estamos ajustando seu orçamento.</h2>
      <p>A versão atualizada chega pela conversa do WhatsApp.</p>`;
  } else if (orc.status === "enviado") {
    corpo = `
      ${erro ? `<p class="erro">${esc(erro)}</p>` : ""}
      <p class="label">Próximo passo</p>
      <h2>Está tudo certo com o orçamento?</h2>
      <form method="post" action="/p/${orc.tokenPublico}/resposta" class="acoes">
        <button name="decisao" value="aprovado" class="btn cheio">Aprovar orçamento</button>
      </form>
      <p class="dica">Quer ajustar alguma coisa? É só responder na conversa do WhatsApp.</p>`;
  } else {
    corpo = `<p class="label">Status</p><h2>Este orçamento ainda não está disponível.</h2>`;
  }

  return `<!doctype html>
<html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Orçamento ${esc(orc.codigo)} · ${esc(cfg.empresa.nome)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Inter+Tight:wght@400;500;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/cliente.css">
</head><body>
<main>
  <header><strong>${esc(cfg.empresa.nome)}</strong><span class="label">Orçamento ${esc(orc.codigo)}</span></header>
  <h1>${esc(orc.cliente.nome || "Seu orçamento")}</h1>
  ${calc ? `<div class="total"><span class="label">Total</span><b>${brl(calc.total)}</b></div>
  <dl>
    <div><dt class="label">Evento</dt><dd>${esc([orc.evento?.data, orc.evento?.horario].filter(Boolean).join(" · ") || "A combinar")}</dd></div>
    <div><dt class="label">Validade</dt><dd>${calc.validadeDias} dias</dd></div>
  </dl>` : ""}
  ${disponivel ? `<a class="btn pequeno pdf" href="${pdf}" target="_blank" rel="noopener">Abrir PDF completo ↗</a>` : ""}
  <section>${corpo}</section>
</main>
</body></html>`;
}
