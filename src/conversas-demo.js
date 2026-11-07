// Conversa de exemplo para apresentações (MODO_DEMO=1) quando o agente ADRI não está conectado.
// Só leitura: nada daqui é gravado e nenhuma ação é enviada a ninguém.
export const DEMO_ID = "demo-conversa";

const em = (min) => Date.now() - min * 60_000;
const msg = (id, de, texto, min, tipo = "text") => ({ id: `demo-${id}`, tipo, texto, em: em(min), status: de === "cliente" ? "RECEIVED" : "DELIVERED", erro: null, de });

const historico = [
  msg(1, "cliente", "Oi, quero maquiagem e penteado para um casamento no sábado, 14/11. Sou noiva, preciso estar pronta às 10h.", 95),
  msg(2, "ia", "Oi, Mariana! Que bom ter você por aqui! 💗 Sou a Adri, assistente virtual da Adriana (uma assistente automatizada): se quiser falar com ela, é só pedir. Onde você vai se arrumar? Pode me passar o endereço completo.", 94),
  msg(3, "cliente", "Rua Augusta, 1000, Consolação, São Paulo", 92),
  msg(4, "ia", "Deixa eu conferir 💗: pacote de noiva (maquiagem e penteado), sábado, 14/11, pronta às 10:00, em Rua Augusta, 1000, Consolação, São Paulo. Posso enviar para a Adriana revisar?", 91),
  msg(5, "cliente", "Pode sim!", 90),
  msg(6, "ia", "Perfeito, já tenho tudo que preciso! 💗 Enviei os detalhes para a Adriana revisar. Assim que ela aprovar, eu te mando a proposta por aqui.", 89),
  msg(7, "adriana", "Oi, Mariana! Aqui é a Adriana. Já revisei, segue a proposta.", 40),
  msg(8, "ia", "Oi Mariana! Seu orçamento está pronto. Segue o PDF com todos os detalhes.", 39, "document"),
];

const pessoa = { id: "demo-pessoa", nome: "Mariana Souza (exemplo)", usuario: null, telefone: "5511900000000", identificador: "demo", observacoes: null, desde: em(95), apagado: false };

export const demoLista = () => ({
  itens: [{
    id: DEMO_ID, pessoa, canal: "SIMULATOR", modo: "AI", mensagens: historico.length,
    ultima: { texto: historico.at(-1).texto, de: "ia", tipo: "document", em: historico.at(-1).em },
    atualizadoEm: historico.at(-1).em, orcamento: null,
  }],
  atencao: 0,
});

export const demoDetalhe = () => ({
  id: DEMO_ID, pessoa, canal: "SIMULATOR", modo: "AI", mensagens: historico.length, aguardando: null,
  coletado: { servico: "Pacote de noiva", data: "sábado, 14/11", pronta: "10:00", endereco: "Rua Augusta, 1000, Consolação, São Paulo" },
  orcamento: null, historico,
});

export const ehDemo = (id) => id === DEMO_ID;
