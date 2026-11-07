// Página pública aberta pelos botões do PDF: a cliente aprova ou pede mudanças.
import { config } from "./config.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const brl = (n) => Number(n || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

export function paginaCliente(orc, { decisao, enviado, erro } = {}) {
  const cfg = config();
  const calc = orc.calculo;
  const aguardando = orc.status === "enviado" || orc.status === "mudanca_cliente";
  const pdf = `/p/${orc.tokenPublico}/orcamento.pdf`;

  let corpo;
  if (enviado || orc.status === "aceito_cliente") {
    const ok = orc.respostaCliente?.decisao === "aprovado";
    corpo = `
      <p class="label">${ok ? "Orçamento aprovado" : "Pedido recebido"}</p>
      <h2>${ok ? "Obrigada! Já avisamos a equipe." : "Recebemos seu pedido de mudança."}</h2>
      <p>A conversa continua no WhatsApp — em breve você recebe o retorno por lá.</p>`;
  } else if (!aguardando) {
    corpo = `<p class="label">Status</p><h2>Este orçamento ainda não está disponível para resposta.</h2>`;
  } else {
    corpo = `
      ${erro ? `<p class="erro">${esc(erro)}</p>` : ""}
      <p class="label">Próximo passo</p>
      <h2>Está tudo certo com o orçamento?</h2>
      <form method="post" action="/p/${orc.tokenPublico}/resposta" class="acoes">
        <button name="decisao" value="aprovado" class="btn cheio">Aprovar orçamento</button>
      </form>
      <form method="post" action="/p/${orc.tokenPublico}/resposta" class="mudanca">
        <input type="hidden" name="decisao" value="mudanca">
        <label class="label" for="c">O que você gostaria de mudar?</label>
        <textarea id="c" name="comentario" rows="4" ${decisao === "mudanca" ? "autofocus" : ""} required></textarea>
        <button class="btn">Solicitar mudanças</button>
      </form>`;
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
  ${aguardando || orc.status === "aceito_cliente" ? `<a class="btn pequeno pdf" href="${pdf}" target="_blank" rel="noopener">Abrir PDF completo ↗</a>` : ""}
  <section>${corpo}</section>
</main>
</body></html>`;
}
