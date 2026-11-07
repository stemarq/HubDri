// Gera leads de exemplo (como se viessem da IA do WhatsApp) para testar o fluxo localmente.
import zlib from "node:zlib";
import crypto from "node:crypto";

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (tipo, dados) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(dados.length);
  const td = Buffer.concat([Buffer.from(tipo), dados]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

// PNG simples com faixas diagonais — só para ter "fotos" no teste.
function pngExemplo([r1, g1, b1], [r2, g2, b2], w = 480, h = 360) {
  const linhas = [];
  for (let y = 0; y < h; y++) {
    const l = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) {
      const a = Math.floor((x + y) / 40) % 2 === 0;
      l.set(a ? [r1, g1, b1] : [r2, g2, b2], 1 + x * 3);
    }
    linhas.push(l);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(linhas))),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

const PERFIS = [
  {
    nome: "Mariana Lopes", cidade: "São Paulo/SP",
    evento: { tipo: "Casamento", data: "12/12/2026", horario: "06:00", local: "Espaço Villa Lobos, São Paulo/SP" },
    pedido: "Vou casar em dezembro! Quero make e penteado pra mim e pra 3 madrinhas, começando às 6h.",
    respostas: [["Tipo de evento", "Casamento"], ["Quem será maquiada", "Noiva + 3 madrinhas"], ["Serviços", "Maquiagem e penteado"], ["Início", "6h"]],
  },
  {
    nome: "Juliana Ferreira", cidade: "Campinas/SP",
    evento: { tipo: "Formatura", data: "28/11/2026", horario: "16:00", local: "Campinas/SP" },
    pedido: "Preciso de maquiagem para minha formatura, só eu, com cílios. É em Campinas, uns 95 km daí.",
    respostas: [["Tipo de evento", "Formatura"], ["Quem será maquiada", "Só a cliente"], ["Serviços", "Maquiagem + cílios"], ["Distância", "95 km"]],
  },
  {
    nome: "Beatriz Santos", cidade: "Santo André/SP",
    evento: { tipo: "Aniversário de 15 anos", data: "05/12/2026", horario: "17:00", local: "Santo André/SP" },
    pedido: "Make para a debutante e mais 2 pessoas (mãe e madrinha). Queria 3 horas de permanência para retoques.",
    respostas: [["Tipo de evento", "15 anos"], ["Quem será maquiada", "3 pessoas"], ["Permanência", "3 horas"]],
  },
];

export function leadExemplo() {
  const p = PERFIS[Math.floor(Math.random() * PERFIS.length)];
  const tel = `+55 11 9${crypto.randomInt(1000, 9999)}-${crypto.randomInt(1000, 9999)}`;
  return {
    conversationId: "wa-" + crypto.randomBytes(5).toString("hex"),
    cliente: { nome: p.nome, telefone: tel, cidade: p.cidade, email: "" },
    evento: p.evento,
    briefing: { resumo: "", respostas: p.respostas.map(([pergunta, resposta]) => ({ pergunta, resposta })) },
    conversa: [
      { de: "ia", texto: "Oi! Sou a assistente virtual. Me conta o que você precisa?" },
      { de: "cliente", texto: p.pedido },
      { de: "ia", texto: "Que lindo! Pode me mandar fotos de referência da make que você gosta?" },
      { de: "cliente", texto: "Mandei as fotos 👆" },
      { de: "ia", texto: "Obrigada! Vou preparar seu orçamento e já te retorno por aqui." },
    ],
    imagens: [
      { base64: pngExemplo([238, 214, 205], [226, 190, 178]), mimeType: "image/png", legenda: "Referência de make" },
      { base64: pngExemplo([221, 187, 168], [247, 243, 239]), mimeType: "image/png", legenda: "Referência de penteado" },
      { base64: pngExemplo([196, 140, 122], [170, 112, 96]), mimeType: "image/png", legenda: "Foto da cliente (sem make)" },
    ],
  };
}
