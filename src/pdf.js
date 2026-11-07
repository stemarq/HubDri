// PDF do orçamento enviado à cliente, com botões de aprovação / pedido de mudança.
import path from "node:path";
import PDFDocument from "pdfkit";
import { config } from "./config.js";
import { UPLOADS_DIR } from "./store.js";
import { linkPublico } from "./orcamentos.js";

const brl = (n) => Number(n || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const unid = (u, q) => (Number(q) === 1 || ["un", "km", "m²"].includes(u) ? u : u + "s");
const data = (iso) => new Date(iso).toLocaleDateString("pt-BR");

// Paleta do hub (ver public/tokens.css)
const PRETO = "#3A2A23"; // cacau
const CINZA = "#7B4B4F"; // ameixa
const LINHA = "#EAD7C6"; // areia
const PRINCIPAL = "#B66A5C"; // burnt rose — cor principal
const DESTAQUE = "#DDBBA8"; // nude — faixa de prévia

export function gerarPdf(orc, stream) {
  const cfg = config();
  const calc = orc.calculo;
  const aprovado = Boolean(orc.aprovadoEm);
  const doc = new PDFDocument({ size: "A4", margin: 48, info: { Title: `Orçamento ${orc.codigo}`, Author: cfg.empresa.nome } });
  doc.pipe(stream);

  const L = doc.page.margins.left;
  const W = doc.page.width - L - doc.page.margins.right;
  const label = (t, x, y, opts = {}) =>
    doc.font("Courier-Bold").fontSize(7.5).fillColor(CINZA).text(t.toUpperCase(), x, y, { characterSpacing: 0.8, ...opts });
  const regua = (y) => doc.moveTo(L, y).lineTo(L + W, y).lineWidth(0.6).strokeColor(PRETO).stroke();

  // Faixa de prévia
  if (!aprovado) {
    doc.rect(0, 0, doc.page.width, 18).fill(DESTAQUE);
    doc.font("Courier-Bold").fontSize(7.5).fillColor(PRETO)
      .text("PRÉVIA INTERNA — AINDA NÃO APROVADO — NÃO ENVIAR", 0, 6, { width: doc.page.width, align: "center", characterSpacing: 0.8 });
  }

  // Cabeçalho
  doc.font("Helvetica-Bold").fontSize(11).fillColor(PRINCIPAL).text(cfg.empresa.nome, L, 48);
  doc.font("Courier").fontSize(8).fillColor(CINZA).text(`${cfg.empresa.contato}  ·  ${cfg.empresa.telefone}`, L, 63);
  label(`Orçamento ${orc.codigo}`, L, 48, { width: W, align: "right" });
  doc.font("Courier").fontSize(8).fillColor(CINZA).text(data(calc.geradoEm), L, 63, { width: W, align: "right" });
  regua(84);

  // Título
  doc.font("Helvetica-Bold").fontSize(30).fillColor(PRETO).text(orc.cliente.nome || "Cliente", L, 104, { width: W, lineGap: -4 });
  let y = doc.y + 14;

  // Metadados
  const meta = [
    ["Telefone", orc.cliente.telefone || "—"],
    ["Data do evento", [orc.evento?.data, orc.evento?.horario].filter(Boolean).join(" · ") || "A combinar"],
    ["Local", orc.evento?.local || orc.cliente.cidade || "—"],
    ["Validade", `${calc.validadeDias} dias`],
  ];
  const col = W / meta.length;
  let fimMeta = y;
  meta.forEach(([k, v], i) => {
    label(k, L + i * col, y);
    doc.font("Helvetica").fontSize(10).fillColor(PRETO).text(v, L + i * col, y + 12, { width: col - 8 });
    fimMeta = Math.max(fimMeta, doc.y);
  });
  y = fimMeta + 20;

  // Resumo
  if (orc.briefing.resumo) {
    label("01 — O que você pediu", L, y);
    doc.font("Helvetica").fontSize(10.5).fillColor(PRETO).text(orc.briefing.resumo, L, y + 14, { width: W, lineGap: 2 });
    y = doc.y + 22;
  }

  // Itens
  label("02 — Itens do orçamento", L, y);
  y += 16;
  const cols = [
    { t: "Item", w: W * 0.46, a: "left" },
    { t: "Qtd", w: W * 0.14, a: "right" },
    { t: "Unitário", w: W * 0.18, a: "right" },
    { t: "Total", w: W * 0.22, a: "right" },
  ];
  const linhaTabela = (vals, fonte, cor, yy) => {
    let x = L;
    vals.forEach((v, i) => {
      doc.font(fonte).fontSize(9.5).fillColor(cor).text(v, x + (i ? 0 : 0), yy, { width: cols[i].w - 6, align: cols[i].a });
      x += cols[i].w;
    });
  };
  regua(y);
  let x = L;
  cols.forEach((c) => { label(c.t, x, y + 6, { width: c.w - 6, align: c.a }); x += c.w; });
  y += 22;
  for (const it of calc.itens) {
    if (y > doc.page.height - 160) { doc.addPage(); y = 56; }
    linhaTabela(
      [it.descricao, `${it.quantidade.toLocaleString("pt-BR")} ${unid(it.unidade, it.quantidade)}`, brl(it.valorUnitario), brl(it.total)],
      "Helvetica", PRETO, y
    );
    const h = doc.heightOfString(it.descricao, { width: cols[0].w - 6 });
    y += Math.max(h, 12) + 4;
    if (it.observacao) {
      doc.font("Helvetica").fontSize(8).fillColor(CINZA).text(it.observacao, L, y - 2, { width: cols[0].w - 6 });
      y = doc.y + 2;
    }
    doc.moveTo(L, y + 2).lineTo(L + W, y + 2).lineWidth(0.4).strokeColor(LINHA).stroke();
    y += 8;
  }

  // Totais
  const tx = L + W * 0.55, tw = W * 0.45;
  const linhaTotal = (k, v, yy) => {
    doc.font("Helvetica").fontSize(9.5).fillColor(CINZA).text(k, tx, yy, { width: tw / 2 });
    doc.font("Helvetica").fontSize(9.5).fillColor(PRETO).text(v, tx + tw / 2, yy, { width: tw / 2, align: "right" });
  };
  y += 4;
  linhaTotal("Subtotal", brl(calc.subtotal), y);
  if (calc.desconto > 0) { y += 16; linhaTotal(`Desconto (${calc.descontoPercentual}%)`, `− ${brl(calc.desconto)}`, y); }
  y += 22;
  doc.roundedRect(tx, y - 6, tw, 32, 10).fill(PRINCIPAL);
  doc.font("Courier-Bold").fontSize(7.5).fillColor("#FFFFFF").text("TOTAL", tx + 12, y + 5, { characterSpacing: 0.8 });
  doc.font("Helvetica-Bold").fontSize(16).fillColor("#FFFFFF").text(brl(calc.total), tx, y + 1, { width: tw - 10, align: "right" });
  y += 44;

  // Imagens de referência
  const imgs = orc.imagens.filter((i) => ["image/jpeg", "image/png"].includes(i.mimeType)).slice(0, 8);
  if (imgs.length) {
    if (y > doc.page.height - 220) { doc.addPage(); y = 56; }
    label("03 — Referências que você enviou", L, y);
    y += 16;
    const gap = 8, n = 4, tam = (W - gap * (n - 1)) / n;
    imgs.forEach((img, i) => {
      const cx = L + (i % n) * (tam + gap);
      const cy = y + Math.floor(i / n) * (tam + gap);
      doc.save();
      try {
        doc.roundedRect(cx, cy, tam, tam, 10).clip();
        doc.image(path.join(UPLOADS_DIR, img.arquivo), cx, cy, { cover: [tam, tam], align: "center", valign: "center" });
      } catch { /* imagem ausente ou formato não suportado */ }
      doc.restore();
    });
    y += Math.ceil(imgs.length / n) * (tam + gap) + 12;
  }

  // Próximo passo
  if (y > doc.page.height - 170) { doc.addPage(); y = 56; }
  regua(y);
  y += 14;
  label("Próximo passo", L, y);
  doc.font("Helvetica-Bold").fontSize(15).fillColor(PRETO).text("Está tudo certo com o orçamento?", L, y + 14);
  y = doc.y + 12;

  const link = linkPublico(orc);
  const bw = Math.min(W, 260), bh = 38;
  const botao = (txt, bx, url, cheio) => {
    if (cheio) doc.roundedRect(bx, y, bw, bh, bh / 2).fill(PRINCIPAL);
    else doc.roundedRect(bx, y, bw, bh, bh / 2).lineWidth(1).strokeColor(PRETO).stroke();
    doc.font("Courier-Bold").fontSize(10).fillColor(cheio ? "#FFFFFF" : PRETO)
      .text(txt, bx, y + 14, { width: bw, align: "center", characterSpacing: 1 });
    doc.link(bx, y, bw, bh, url);
  };
  botao("APROVAR ORÇAMENTO", L, link, true);
  y += bh + 12;
  // Ajustes não têm link: são combinados na conversa do WhatsApp.
  doc.font("Helvetica").fontSize(9).fillColor(CINZA)
    .text("Quer ajustar alguma coisa? É só responder na conversa do WhatsApp.", L, y, { width: W });
  doc.font("Courier").fontSize(7.5).fillColor(CINZA).text(link, L, doc.y + 4, { width: W, link });

  // Rodapé (zera a margem inferior para o texto não abrir página nova)
  doc.page.margins.bottom = 0;
  doc.font("Helvetica").fontSize(7.5).fillColor(CINZA)
    .text(cfg.empresa.rodapePdf, L, doc.page.height - 40, { width: W, align: "center", lineBreak: false });

  doc.end();
}
