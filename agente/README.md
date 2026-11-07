# HubDri · ADRI, agente de WhatsApp da Adriana

Agente que transforma uma conversa de WhatsApp em uma proposta em PDF pronta para aprovação, mais o backend (API REST) que o hub administrativo consome.

## Como rodar

```bash
npm install
cp .env.example .env        # defina ADMIN_API_TOKEN
npm run seed:demo           # OPCIONAL: preços FICTÍCIOS só para demonstração
npm start                   # http://localhost:3000/simulator
npm run demo                # fluxo completo no terminal
npm test                    # 44 testes
```

Requer Node 22.13+ (usa `node:sqlite`) e Chrome ou Edge instalado (PDF por HTML/CSS; ou `CHROME_PATH`).

## O que é real e o que é simulado

| Peça | Com credenciais | Sem credenciais |
|---|---|---|
| WhatsApp | Cloud API oficial (webhook, assinatura HMAC, envio, PDF, template fora de 24h) | Simulador em `/simulator` e `POST /api/chat/message`, canal `SIMULATOR` |
| Agenda | Google Calendar (OAuth refresh token) | Agenda simulada, sempre identificada (`simulated: true`) |
| Rotas | Google Routes API | Provedor simulado (bairros de SP) rotulado como simulado, confiança baixa |
| Áudio | não há transcrição configurada: ADRI avisa e pede texto | idem |
| Entendimento da mensagem | extração determinística em pt-BR (sem LLM) | idem |

A compreensão do texto é por regras, não por LLM: é previsível e testável, e a injeção de prompt não consegue alterar preços (a mensagem da cliente nunca chega ao PricingEngine). Dá para plugar um LLM no mesmo contrato `extract()` depois.

## Chat no Telegram (simulação do WhatsApp)

1. No Telegram, fale com @BotFather, `/newbot`, e copie o token.
2. No `.env`: `TELEGRAM_BOT_TOKEN=...` (opcional `TELEGRAM_ALLOWED_CHAT_IDS=` para restringir quem fala com o bot).
3. `npm start`: o bot passa a receber mensagens por long polling (sem URL pública, sem ngrok).

É o mesmo agente, a mesma agenda e o mesmo hub. A cliente conversa no Telegram e a Adriana aprova no simulador (`/simulator`) ou pela API; ao enviar, o PDF chega no chat como documento. O canal aparece como `TELEGRAM` e `simulated: true`; não há janela de 24h nem template. Fotos são guardadas como inspiração; áudio recebe aviso de que não é transcrito.

## Regras que o sistema garante

- Preço só sai do `PricingEngine` (centavos inteiros, regras no banco). Regra ausente vira `NEEDS_REVIEW`, nunca valor inventado. Não há preços reais cadastrados: o `seed:demo` é fictício.
- Madrugada: o multiplicador (`pricing.nightMultiplier`: `factor` + `appliesTo` entre `service`, `transport`, `addons`) precisa ser configurado explicitamente. Sem ele, o orçamento vai para revisão.
- Deslocamento entra uma única vez; adicionais duplicados são cobrados uma vez.
- "Pronta às 10h" nunca vira início do atendimento: início = pronta − margem − duração; chegada = início − preparo; saída = chegada − trajeto − folga; retorno calculado à parte.
- Dia ambíguo ("sábado", "dia 25") exige confirmação da cliente. Fuso `America/Sao_Paulo`.
- A cliente não vê valores antes da aprovação. Só orçamento `APPROVED` pode ser enviado.
- Adriana assumindo a conversa (`handoff`) silencia a ADRI até `resume`.
- Proposta enviada não é venda: receita e ticket médio só contam propostas `ACCEPTED` (confirmadas pela Adriana, que cria o agendamento definitivo com recheck de conflito).
- Estimativa de transporte não é cotação da Uber (`isRealtimeUberQuote: false`). Calibra com custos reais via `POST /api/transport/actual` (≥3 corridas semelhantes: confiança média; ≥8: alta).

## Autenticação

Todos os `/api/*` exigem `Authorization: Bearer $ADMIN_API_TOKEN`; sem token configurado respondem 503. Header opcional `X-Actor` registra quem agiu na auditoria. `/webhooks/whatsapp` usa verificação da Meta e assinatura `X-Hub-Signature-256`.

## Ciclo do orçamento

`NEEDS_REVIEW` → (PATCH com `resolveReview`) → `PENDING_APPROVAL` → `APPROVED` → `SENT` → `ACCEPTED` | `LOST`. Também `INFO_REQUESTED` e `REJECTED`.

## Endpoints

| Método e rota | Função |
|---|---|
| `POST /api/chat/message` | `{from, name?, text?, imageBase64?, messageId?}` → `{conversationId, replies[], mode, quoteId?, duplicate}` |
| `GET /api/conversations`, `GET /api/conversations/:id` | lista e detalhe (mensagens, dados coletados) |
| `POST /api/conversations/:id/handoff`, `/resume` | assumir e devolver à ADRI |
| `POST /api/conversations/:id/messages` | Adriana escreve à cliente |
| `POST /api/availability/check` | `{date, readyTime\|startTime, serviceCode, address}` → horários, conflitos |
| `POST /api/transport/estimate` | `{origin?, destination, departAt, leg?, weather?}` |
| `POST /api/transport/actual` | custo real pago `{estimateId, actualCents, discountCents?}` ou viagem completa |
| `POST /api/pricing/calculate` | `{serviceCode, startAt, transportCents?, addons?, discountCode?}` |
| `GET /api/quotes?status=`, `GET /api/quotes/:id` | lista e detalhe (itens, transporte, agenda, histórico, conversa) |
| `PATCH /api/quotes/:id` | `{items?, notes?, validUntil?, resolveReview?}` regenera o PDF e audita |
| `POST /api/quotes/:id/approve`, `/reject`, `/request-info`, `/send`, `/accept`, `/lost` | ações da Adriana |
| `GET /api/quotes/:id/pdf`, `POST /api/quotes/:id/pdf/regenerate` | PDF |
| `GET /api/analytics/overview`, `/conversion`, `/transportation` | métricas reais (`null` quando não há dado) |
| `GET /api/events?since=&type=` | eventos de negócio (também enviados a `HUB_WEBHOOK_URL`, assinado) |
| `GET/PUT /api/settings/pricing` | serviços, durações, preços por tipo de dia, extras, transporte, agendamento |
| `GET/PUT /api/settings/:key` | `branding`, `business`, `whatsapp`, `faq`, `scheduling`, `transport` |
| `POST /api/calendar/events` | só agenda simulada: bloquear horário para testes |

### Exemplo

```http
POST /api/chat/message
{"from":"5511999990000","text":"Oi, quero maquiagem e penteado para um casamento no sábado. Sou noiva, preciso estar pronta às 10h e vou me arrumar em Pinheiros."}
→ {"replies":["Oi! Que bom ter você por aqui! 💗 Sou a Adri, ... Só confirmando: seria sábado, 14/11? Pode me passar o endereço completo ... em Pinheiros?"], "mode":"AI"}
```

```http
GET /api/quotes/:id
→ {"status":"PENDING_APPROVAL","service":{"code":"BRIDE_PACKAGE"},"items":[{"kind":"SERVICE","amountCents":70000},{"kind":"TRANSPORT","amountCents":9800}],
   "totalCents":79800,"reviewReasons":[],"pdfAvailable":true,"transport":[{"leg":"OUTBOUND","confidence":"low","simulated":true}], ...}
```

## WhatsApp oficial

Defina `WHATSAPP_*` no `.env`, aponte o webhook da Meta para `/webhooks/whatsapp` e assine `messages`. Fora da janela de 24h só é possível enviar o template em `whatsapp.quoteTemplateName` (cabeçalho do tipo documento, corpo com 1 variável: nome da cliente); sem ele o envio é bloqueado com erro explícito.

## Limites conhecidos

- Sem transcrição de áudio e sem análise de imagem (as fotos são guardadas como inspiração).
- Provedor de rotas simulado cobre ~30 bairros de SP; fora disso exige Google Routes.
- Durações padrão dos serviços (60/60/120/180 min) são ponto de partida editável.
- Controle de acesso é um token único de administrador; sem perfis. Endereços ficam no SQLite local: proteja o disco e defina retenção antes de produção.
- Modelo de regressão para transporte é só o ponto de extensão (ajuste por mediana do histórico).
