# HubDri

Hub de captação de clientes. A IA do WhatsApp coleta os dados da cliente e envia para o hub; o hub calcula o orçamento (com Claude), gera o PDF e, com um clique de aprovação, devolve o PDF para a IA do WhatsApp continuar a conversa.

```
WhatsApp (IA) ──lead──▶ Hub ──▶ cálculo (IA/regras) ──▶ aprovação (botão único)
      ▲                                                          │
      └────────── PDF + mensagem sugerida ◀──────────────────────┘
cliente aprova (botão do PDF ou no chat) ou pede ajustes (só no chat) ──▶ Hub notifica
```

## Rodando

```bash
npm install
cp .env.example .env   # ajuste as variáveis
npm run dev            # http://localhost:3000
```

Sem configurar nada, o hub funciona em modo local: cálculo por regras, retorno ao WhatsApp simulado (aba **Saída WhatsApp**) e botão **+ Simular lead** para testar o fluxo.

## Telas

- **Fila** — orçamentos que precisam de ação, **mais antigos primeiro**. Passou de `atrasoHoras` (config) aparece marcado como atrasado. Abas: Pendentes / Concluídos / Todos.
- **Orçamento** — dados da cliente, cálculo (editável), briefing, imagens do chat, conversa, botão **Aprovar e enviar**, pedido de mudança, PDF e histórico.
- **Notificações** — novo lead, novas informações no chat, resposta da cliente, falha de envio. O hub atualiza a cada 6 s.
- **Página da cliente** (`/p/:token`) — aberta pelo botão *Aprovar orçamento* do PDF. Não há link para pedir alterações: ajustes são combinados na conversa do WhatsApp.

## Status do orçamento

| Status | Significa |
|---|---|
| `calculando` | IA/regras montando o orçamento |
| `aguardando_aprovacao` | Esperando a aprovação (botão único) |
| `enviado` | Aprovado; PDF devolvido à IA do WhatsApp |
| `falha_envio` | O endpoint do WhatsApp falhou (botão de reenvio) |
| `mudanca_cliente` | A cliente pediu ajustes na conversa (a IA do WhatsApp repassa) → recalcular/editar e aprovar de novo |
| `aceito_cliente` | A cliente aprovou |

Pedir mudança ou editar itens **desfaz a aprovação** — é preciso aprovar de novo para enviar.

## Integração com a IA do WhatsApp

Todas as chamadas levam o header `x-hub-token: $HUB_WEBHOOK_TOKEN`.

### 1. Enviar lead — `POST /api/webhooks/whatsapp/lead`

Veja `exemplos/lead.json`. Imagens podem vir como `url` (o hub baixa e guarda, já que links de mídia do WhatsApp expiram) ou `base64` + `mimeType` (sem legenda: as fotos ficam todas juntas no orçamento). Chamar de novo com o mesmo `conversationId` enquanto o orçamento estiver aberto **acrescenta** mensagens e imagens e recalcula.

Resposta: `{ "orcamentoId", "codigo", "status", "novo", "falhasImagens" }`

### 2. Receber o orçamento aprovado — `WHATSAPP_CALLBACK_URL`

O hub faz `POST` (header `x-hub-token: $WHATSAPP_CALLBACK_TOKEN`) com:

```json
{
  "evento": "orcamento_aprovado",
  "orcamentoId": "…", "codigo": "ORC-0001",
  "conversationId": "wa-123", "telefone": "+55…", "cliente": "Mariana Lopes",
  "total": 1890, "validadeDias": 7,
  "evento": { "tipo": "Casamento", "data": "12/12/2026", "horario": "06:00", "local": "Campinas/SP" },
  "pdfUrl": "https://hub/p/<token>/orcamento.pdf",
  "linkAprovacao": "https://hub/p/<token>",
  "mensagemSugerida": "Oi Mariana! Seu orçamento ORC-0001 está pronto…"
}
```

O retorno **não** traz link para a cliente pedir alterações — só `linkAprovacao`. Quando ela aprova pelo botão do PDF, o hub envia `{"evento": "resposta_cliente", "decisao": "aprovado", …}` para a mesma URL.

### 3. Repassar a resposta dada no chat — `POST /api/webhooks/whatsapp/resposta`

É o único caminho para pedidos de ajuste.

```json
{ "orcamentoId": "…", "decisao": "mudanca", "comentario": "Queria material padrão" }
```
(`conversationId` também serve no lugar de `orcamentoId`.)

### 4. Consultar status — `GET /api/webhooks/whatsapp/orcamentos/:id`

## Cálculo

`config/hub.config.json` define o catálogo de preços, validade, desconto máximo e as instruções para a IA. **Os preços do catálogo são de exemplo — troque pelos valores reais.**

Com `ANTHROPIC_API_KEY`, o Claude (`claude-opus-5-5`) lê o briefing, os dados do evento, a conversa e até 6 fotos (referências de make) e escolhe **apenas códigos e quantidades** do catálogo; os valores e totais são sempre calculados pelo hub. Sem chave (ou se a IA falhar), entra o cálculo por regras (noiva, nº de pessoas, penteado, cílios, horário antes das 7h, km) com um aviso para revisar.

## Visual

Mobile-first, tema claro, elementos arredondados e sem animações. Paleta nude/rosé (`#EAD7C6` `#DDBBA8` `#F7F3EF` `#A98C7A` `#C87D76` `#B66A5C` `#7B4B4F` `#3A2A23`), definida em `public/tokens.css` e reaproveitada no PDF. Tipografia inspirada em patternbreak.ing: grotesca + IBM Plex Mono nos rótulos. O site usa Neue Montreal (fonte comercial); o hub usa Inter Tight no lugar. Se tiver a licença, coloque `NeueMontreal-Regular/Medium/Bold.woff2` em `public/fonts/` e ela passa a ser usada automaticamente.

## Limitações do MVP

- Armazenamento em `data/db.json` (um processo só). Para produção, trocar por Postgres/SQLite.
- Login do hub é só uma senha opcional (`HUB_PASSWORD`, HTTP Basic). Feito para uma usuária só: não há perfis nem registro de quem aprovou.
- Notificações por polling (6 s), sem push/e-mail.
