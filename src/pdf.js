// PDF do orçamento enviado à cliente: apresentação da Dri Gianetti + orçamento + condições.
// Sem botão de aprovação: a cliente confirma ou pede ajustes pela conversa do WhatsApp.
import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import { config } from "./config.js";
import { DATA_DIR, UPLOADS_DIR } from "./store.js";

const brl = (n) => Number(n || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const unid = (u, q) => (Number(q) === 1 || ["un", "km", "m²"].includes(u) ? u : u + "s");
const data = (iso) => new Date(iso).toLocaleDateString("pt-BR");

// Cores da marca (logo) dentro da paleta do hub
const CACAU = "#3A2A23";
const AMEIXA = "#7B4B4F";
const ROSE = "#C87D76";
const PRINCIPAL = "#B66A5C";
const AREIA = "#EAD7C6";
const CREME = "#F7F3EF";
const NUDE = "#DDBBA8";

// Logo fica no repositório; fotos de atendimento (com clientes) ficam fora dele, em data/marca/.
const LOGO = path.resolve("config", "marca", "logo.png");
const PASTA_FOTOS = path.join(DATA_DIR, "marca");
const existe = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
const fotosDaMarca = () => {
  try {
    return fs.readdirSync(PASTA_FOTOS).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort().map((f) => path.join(PASTA_FOTOS, f));
  } catch { return []; }
};

// Respostas do briefing por palavra-chave (ex.: "Horário em que precisa estar pronta").
const resposta = (orc, re) => orc.briefing?.respostas?.find((r) => re.test(r.pergunta))?.resposta;

export function gerarPdf(orc, stream) {
  const cfg = config();
  const emp = cfg.empresa;
  const ap = cfg.apresentacao || {};
  const calc = orc.calculo;
  const aprovado = Boolean(orc.aprovadoEm);
  const catalogo = new Map(cfg.catalogo.map((c) => [c.codigo, c]));

  const doc = new PDFDocument({ size: "A4", margin: 48, bufferPages: true, info: { Title: `Orçamento ${orc.codigo}`, Author: emp.nome } });
  doc.pipe(stream);

  const L = doc.page.margins.left;
  const W = doc.page.width - L - doc.page.margins.right;
  const ALT = doc.page.height;
  const LIMITE = ALT - 70; // abaixo disso, nova página (o rodapé ocupa o fim)

  const label = (t, x, y, opts = {}) =>
    doc.font("Helvetica-Bold").fontSize(7.5).fillColor(ROSE).text(t.toUpperCase(), x, y, { characterSpacing: 1.6, ...opts });
  const titulo = (t, x, y, tam = 22, opts = {}) => doc.font("Times-Roman").fontSize(tam).fillColor(CACAU).text(t, x, y, opts);
  const corpo = (t, x, y, opts = {}) => doc.font("Helvetica").fontSize(9.5).fillColor(CACAU).text(t, x, y, { lineGap: 2.5, ...opts });
  const fio = (y, cor = AREIA, x = L, w = W) => doc.moveTo(x, y).lineTo(x + w, y).lineWidth(0.6).strokeColor(cor).stroke();
  const novaPagina = () => { doc.addPage(); return 56; };
  // Quebra no meio do orçamento: a página nova abre com um título, para nada ficar solto.
  const garantir = (y, h) => {
    if (y + h <= LIMITE) return y;
    const yy = novaPagina();
    label(`Orçamento ${orc.codigo} · continuação`, L, yy);
    return yy + 26;
  };
  const foto = (arq, x, y, w, h, r = 14) => {
    doc.save();
    try {
      doc.roundedRect(x, y, w, h, r).clip();
      doc.image(arq, x, y, { cover: [w, h], align: "center", valign: "center" });
    } catch { /* imagem ausente ou formato não suportado */ }
    doc.restore();
  };

  // ---------- Página 1: apresentação ----------
  doc.rect(0, 0, doc.page.width, ALT).fill(CREME);
  let y = 40;
  if (existe(LOGO)) {
    const t = 170;
    doc.image(LOGO, (doc.page.width - t) / 2, y, { width: t });
    y += t + 4;
  } else {
    titulo(emp.nome, L, y + 40, 28, { width: W, align: "center" });
    y = doc.y + 20;
  }
  label(`Orçamento ${orc.codigo} · ${data(calc.geradoEm)}`, L, y, { width: W, align: "center" });
  titulo(`Preparado para ${orc.cliente.nome || "você"}`, L, y + 16, 24, { width: W, align: "center" });
  y = doc.y + 6;
  if (ap.frase) {
    doc.font("Times-Italic").fontSize(13).fillColor(AMEIXA).text(ap.frase, L, y, { width: W, align: "center" });
    y = doc.y + 22;
  }

  // Sobre o atendimento: texto à esquerda, fotos à direita
  const fotos = fotosDaMarca().slice(0, 2);
  const colTexto = fotos.length ? W * 0.56 : W;
  const yBloco = y;
  label("Sobre o atendimento", L, y);
  titulo("Nosso diferencial", L, y + 14, 20);
  y = doc.y + 8;
  if (ap.diferencial) { corpo(ap.diferencial, L, y, { width: colTexto }); y = doc.y + 8; }
  if (ap.experiencia) {
    doc.font("Times-Italic").fontSize(11).fillColor(AMEIXA).text(ap.experiencia, L, y, { width: colTexto, lineGap: 2 });
    y = doc.y + 18;
  }
  if (ap.studio) {
    label("Atendimento no studio", L, y);
    corpo(ap.studio, L, y + 13, { width: colTexto });
    if (ap.horarioStudio) doc.font("Helvetica").fontSize(8.5).fillColor(AMEIXA).text(ap.horarioStudio, L, doc.y + 1, { width: colTexto });
    y = doc.y + 14;
  }
  if (ap.domicilio) {
    label("Atendimento a domicílio", L, y);
    corpo(ap.domicilio, L, y + 13, { width: colTexto });
    y = doc.y + 14;
  }
  if (fotos.length) {
    const fx = L + colTexto + 18, fw = W - colTexto - 18;
    const fh = fotos.length === 2 ? 168 : 300;
    fotos.forEach((f, i) => foto(f, fx, yBloco + i * (fh + 10), fw, fh));
    y = Math.max(y, yBloco + fotos.length * (fh + 10));
  }

  // ---------- Página 2: o orçamento ----------
  y = novaPagina();
  label(`Orçamento ${orc.codigo}`, L, y);
  titulo("Seu investimento", L, y + 14, 26);
  y = doc.y + 14;

  const pronta = resposta(orc, /pronta/i);
  const meta = [
    ["Data", orc.evento?.data || "A combinar"],
    ["Início do atendimento", orc.evento?.horario || "A combinar"],
    ...(pronta ? [["Pronta às", pronta]] : []),
    ["Local", orc.evento?.local || orc.cliente.cidade || "A combinar"],
  ];
  const col = W / meta.length;
  let fimMeta = y;
  meta.forEach(([k, v], i) => {
    label(k, L + i * col, y, { characterSpacing: 1 });
    doc.font("Helvetica").fontSize(10).fillColor(CACAU).text(v, L + i * col, y + 12, { width: col - 10 });
    fimMeta = Math.max(fimMeta, doc.y);
  });
  y = fimMeta + 18;

  if (orc.briefing?.resumo) {
    label("O que você pediu", L, y);
    corpo(orc.briefing.resumo, L, y + 13, { width: W });
    y = doc.y + 18;
  }

  // Itens: nome, conta e o que está incluso (da tabela da Dri)
  fio(y, CACAU);
  y += 12;
  for (const it of calc.itens) {
    const cat = catalogo.get(it.codigo) || {};
    const inclui = cat.inclui || [];
    const alturaPrevista = 40 + (cat.detalhe ? 14 : 0) + inclui.length * 13;
    y = garantir(y, alturaPrevista);
    const wNome = W * 0.68;
    doc.font("Helvetica-Bold").fontSize(10.5).fillColor(CACAU).text(it.descricao, L, y, { width: wNome });
    doc.font("Helvetica-Bold").fontSize(10.5).fillColor(CACAU).text(brl(it.total), L + wNome, y, { width: W - wNome, align: "right" });
    y = doc.y + 2;
    doc.font("Helvetica").fontSize(8.5).fillColor(AMEIXA)
      .text(`${it.quantidade.toLocaleString("pt-BR")} ${unid(it.unidade, it.quantidade)} × ${brl(it.valorUnitario)}`, L, y, { width: wNome });
    y = doc.y + 4;
    if (cat.detalhe) { corpo(cat.detalhe, L, y, { width: wNome }); y = doc.y + 3; }
    for (const linha of inclui) {
      doc.circle(L + 3, y + 4.5, 1.6).fill(ROSE);
      doc.font("Helvetica").fontSize(8.5).fillColor(CACAU).text(linha, L + 11, y, { width: wNome - 11, lineGap: 1.5 });
      y = doc.y + 2;
    }
    y += 8;
    fio(y);
    y += 12;
  }

  // Totais
  y = garantir(y, 90);
  const tx = L + W * 0.5, tw = W * 0.5;
  const linhaTotal = (k, v) => {
    doc.font("Helvetica").fontSize(9.5).fillColor(AMEIXA).text(k, tx, y, { width: tw / 2 });
    doc.font("Helvetica").fontSize(9.5).fillColor(CACAU).text(v, tx + tw / 2, y, { width: tw / 2, align: "right" });
    y += 16;
  };
  if (calc.desconto > 0) {
    linhaTotal("Subtotal", brl(calc.subtotal));
    linhaTotal(`Desconto (${calc.descontoPercentual}%)`, `− ${brl(calc.desconto)}`);
  }
  y += 4;
  doc.roundedRect(tx, y, tw, 40, 12).fill(PRINCIPAL);
  doc.font("Helvetica-Bold").fontSize(7.5).fillColor("#FFFFFF").text("TOTAL", tx + 16, y + 16, { characterSpacing: 1.6 });
  doc.font("Times-Roman").fontSize(20).fillColor("#FFFFFF").text(brl(calc.total), tx, y + 10, { width: tw - 16, align: "right" });
  y += 40 + 8;
  doc.font("Helvetica").fontSize(8).fillColor(AMEIXA).text(`Válido por ${calc.validadeDias} dias a partir de ${data(calc.geradoEm)}.`, tx, y, { width: tw, align: "right" });
  y = doc.y + 22;

  // Referências enviadas pela cliente
  const refs = orc.imagens.filter((i) => ["image/jpeg", "image/png"].includes(i.mimeType)).slice(0, 8);
  if (refs.length) {
    const gap = 8, n = 4, tam = (W - gap * (n - 1)) / n;
    y = garantir(y, 30 + tam);
    label("Referências que você enviou", L, y);
    y += 16;
    refs.forEach((img, i) => {
      if (i && i % n === 0) { y += tam + gap; y = garantir(y, tam); }
      foto(path.join(UPLOADS_DIR, img.arquivo), L + (i % n) * (tam + gap), y, tam, tam, 10);
    });
    y += tam + 22;
  }

  // Condições
  const condicoes = [ap.pagamento, ap.domicilio && `Atendimento a domicílio: ${ap.domicilio}`, emp.rodapePdf].filter(Boolean);
  y = garantir(y, 40 + condicoes.length * 30);
  label("Condições", L, y);
  y += 15;
  for (const c of condicoes) {
    doc.circle(L + 3, y + 4.5, 1.6).fill(ROSE);
    doc.font("Helvetica").fontSize(8.5).fillColor(CACAU).text(c, L + 11, y, { width: W - 11, lineGap: 1.5 });
    y = doc.y + 6;
  }

  // Próximo passo (sem botão: a conversa é no WhatsApp)
  y = garantir(y + 10, 70);
  doc.roundedRect(L, y, W, 58, 14).fill(CREME);
  titulo("Gostou da proposta?", L + 18, y + 12, 15);
  doc.font("Helvetica").fontSize(9.5).fillColor(AMEIXA)
    .text("Para confirmar ou ajustar alguma coisa, é só responder na nossa conversa do WhatsApp.", L + 18, doc.y + 3, { width: W - 36 });

  // ---------- Em todas as páginas: faixa de prévia e rodapé com contato ----------
  const contato = [emp.contato, emp.telefone, emp.instagram].filter(Boolean).join("   ·   ");
  const { start, count } = doc.bufferedPageRange();
  for (let i = start; i < start + count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0; // escrever no rodapé não abre página nova
    if (!aprovado) {
      doc.rect(0, 0, doc.page.width, 16).fill(NUDE);
      doc.font("Helvetica-Bold").fontSize(7).fillColor(CACAU)
        .text("PRÉVIA INTERNA · AINDA NÃO APROVADO · NÃO ENVIAR", 0, 5, { width: doc.page.width, align: "center", characterSpacing: 1, lineBreak: false });
    }
    fio(ALT - 44, AREIA);
    doc.font("Helvetica").fontSize(7.5).fillColor(AMEIXA).text(contato, L, ALT - 34, { width: W * 0.8, lineBreak: false });
    doc.font("Helvetica").fontSize(7.5).fillColor(AMEIXA).text(`${i - start + 1}/${count}`, L, ALT - 34, { width: W, align: "right", lineBreak: false });
  }

  doc.end();
}
