# Guia de integração com a API oficial do WhatsApp (Meta)

O núcleo (agente, preço, agenda, PDF) não muda: o WhatsApp entra como um adaptador de canal, igual ao Telegram.
Código pronto em `src/channels/whatsappCloud.ts` (webhook, assinatura, envio, janela de 24h, template). Falta apenas credenciais e a configuração na Meta.

## Arquitetura

| Camada | Arquivo | Papel |
|---|---|---|
| Adaptadores de canal | `src/channels/{telegram,whatsappCloud,simulator}.ts` | falam com a rede; implementam `ChannelAdapter` (`sendText`, `sendDocument`, `ready`) |
| Motor conversacional | `src/agent/agent.ts`, `nlu.ts`, `llm.ts`, `persona.ts` | entende, conversa, confirma; não conhece canal |
| Memória e dados | `src/db.ts`, `src/services/memory.ts`, `failures.ts` | SQLite, memória por cliente com consentimento |
| Ferramentas operacionais | `calendar.ts`, `transport.ts`, `planner.ts`, `pdf.ts`, `outbound.ts` | agenda, rotas, PDF, envio com retentativa e idempotência |
| Regras comerciais | `src/services/pricing.ts` | preço determinístico; a IA nunca calcula valor |

Para um canal novo: implementar `ChannelAdapter`, registrar em `src/context.ts` e chamar `handleEvent(ctx, evento)` com um `InboundEvent`.

## Pré-requisitos na Meta

1. Conta no Meta Business (business.facebook.com) e, para sair do limite inicial, verificação do negócio (documentos da empresa).
2. App do tipo Business em developers.facebook.com com o produto WhatsApp.
3. WhatsApp Business Account (WABA) e um número de telefone dedicado. O número não pode estar ativo no app WhatsApp comum (ou use o modo de coexistência, se disponível para a sua conta).
4. Nome de exibição aprovado pela Meta.
5. Token permanente: crie um usuário do sistema (Configurações do negócio > Usuários do sistema), atribua o app e a WABA e gere o token com `whatsapp_business_messaging` e `whatsapp_business_management`. O token temporário do painel expira em ~24h.
6. URL pública HTTPS para o webhook (servidor com domínio e TLS; em testes, um túnel como ngrok ou cloudflared).

## Variáveis de ambiente

```
WHATSAPP_PHONE_NUMBER_ID=   # ID do número (painel do app > WhatsApp > Configuração da API)
WHATSAPP_ACCESS_TOKEN=      # token permanente do usuário do sistema
WHATSAPP_APP_SECRET=        # Configurações do app > Básico > Chave secreta (valida a assinatura)
WHATSAPP_VERIFY_TOKEN=      # texto que você inventa; igual ao informado no webhook
WHATSAPP_API_VERSION=v21.0
ADMIN_API_TOKEN=            # protege /api/*
```
Com as quatro primeiras preenchidas, `GET /health` passa a mostrar `official-cloud-api`.

## Webhook

1. Deixe o servidor no ar em `https://SEU-DOMINIO/webhooks/whatsapp`.
2. No painel do app: WhatsApp > Configuração > Webhook > Editar. Callback URL = a URL acima; Verify token = `WHATSAPP_VERIFY_TOKEN`. A Meta chama `GET` com `hub.challenge`; o servidor devolve o desafio.
3. Assine o campo `messages`.
4. Toda chamada `POST` traz `X-Hub-Signature-256` (HMAC-SHA256 do corpo bruto com o App Secret). Sem assinatura válida o servidor responde 401.
5. O servidor responde 200 após gravar a mensagem. A Meta reenvia em caso de falha, e o `wa_message_id` único evita processamento duplicado.

## Regras de mensagem e custos (confirme os valores atuais no painel da Meta)

- Janela de 24h: depois da última mensagem da cliente, só dá para enviar texto livre por 24h. Fora dela, só template aprovado. O adaptador bloqueia texto livre fora da janela (`WINDOW_CLOSED`) e registra a mensagem como `BLOCKED_WINDOW`.
- Template do orçamento: crie em WhatsApp Manager > Modelos de mensagem, categoria Utilidade, idioma `pt_BR`, com cabeçalho do tipo Documento e corpo com 1 variável (nome da cliente). Depois de aprovado, informe o nome em `PUT /api/settings/whatsapp` (`quoteTemplateName`). Aprovação pode levar de minutos a dias.
- Cobrança: a Meta cobra por mensagem de template, por categoria e país (marketing, utilidade, autenticação). Respostas dentro da janela de 24h iniciadas pela cliente (serviço) não são cobradas por mensagem. Consulte a tabela de preços vigente da Meta para o Brasil antes de projetar custo; os valores mudam.
- Limites: contas novas começam com limite baixo de conversas iniciadas pela empresa por 24h, que sobe com qualidade e verificação.
- Telefone: a Meta pode exigir PIN de verificação em duas etapas ao registrar o número.

## Privacidade, consentimento e atendimento humano (LGPD)

- Opt-in: só inicie conversa por template com quem consentiu em receber mensagens. A ADRI só responde a quem escreveu primeiro.
- Transparência: a ADRI se apresenta como assistente automatizada na primeira mensagem e sempre aceita "falar com a Adriana" (`handoff`: a IA silencia até `resume`).
- Minimização: a memória guarda nome e preferências; endereço só com consentimento explícito (“guardar”). “Apagar meus dados” (com `CONFIRMAR`) ou `DELETE /api/customers/:id/data` remove mensagens, memória e dados pessoais dos orçamentos.
- Conversas não são usadas para treinar modelos. Falhas e notas ficam em `/api/review/*` para revisão manual; resolver uma falha exige informar o caso de regressão (`regressionRef`).
- Se `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` estiverem configuradas, trechos da conversa são enviados a esses provedores para interpretar texto/áudio: informe isso na política de privacidade.
- Proteja o disco do SQLite e defina retenção antes de produção; use HTTPS e mantenha o `.env` fora do Git.

## Implantação e testes

1. Servidor com Node 22.13+, Chrome ou Edge (PDF), `npm install`, `.env` preenchido, `npm start` atrás de HTTPS (Nginx/Caddy/Cloud Run).
2. Cadastre preços reais em `PUT /api/settings/pricing` (o `seed:demo` é fictício) e o endereço-base em `transport.baseAddress`.
3. Configure Google Calendar e Google Routes para agenda e rotas reais (`.env.example`).
4. No painel da Meta, use o número de teste para enviar mensagem ao seu telefone cadastrado e confira `GET /api/conversations`.
5. Fluxo de aceite: cliente escreve, ADRI confirma, orçamento fica `PENDING_APPROVAL`, Adriana aprova e envia em `/api/quotes/:id/send`. Dentro de 24h vai o PDF; fora, o template.
6. Antes de ligar para clientes reais, rode `npm test`.
