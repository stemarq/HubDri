# Guia: colocar as conversas para funcionar (Telegram agora, WhatsApp depois)

Este guia é para quem recebeu o HubDri com os arquivos `.env` vazios e quer ver conversas na aba **Conversas**. É um passo a passo, sem pular etapa. Faça primeiro a Parte 1 (Telegram, leva uns 15 minutos e é grátis). Quando tudo estiver funcionando, siga para a Parte 2 (WhatsApp oficial).

## Antes de começar: por que a aba Conversas aparece vazia

A aba Conversas não guarda nada por conta própria. Ela pergunta ao agente ADRI (a pasta `agente/`) quais conversas existem. As conversas ficam no banco do agente, que é um arquivo do seu computador. Ele não vai para o GitHub.

Por isso, num computador novo a aba abre com **"Sem conversas"**. Isso é normal. Ela só enche quando alguém escreve para a ADRI por um canal conectado (Telegram ou WhatsApp). Se, em vez de "Sem conversas", aparecer uma mensagem de erro, olhe a seção **Se algo der errado**, no fim.

São dois programas rodando ao mesmo tempo:

| Programa | Pasta | Porta | Arquivo de chaves |
|---|---|---|---|
| Hub (o app que você vê) | raiz do projeto | `PORT` (ex.: 3002) | `.env` |
| Agente ADRI (conversa com as clientes) | `agente/` | `ADRI_PORT` (3001) | `agente/.env` |

Os dois se conversam por duas senhas combinadas. Você mesma inventa essas senhas, e elas precisam ser iguais nos dois arquivos.

## Parte 1: Telegram

### Passo 1. Crie os arquivos de chaves vazios

Na pasta do projeto, rode:

```bash
npm run env:novo
```

Isso cria o `.env` e o `agente/.env` a partir dos modelos. Se eles já existirem, nada é apagado. Abra os dois arquivos no editor para os próximos passos.

### Passo 2. Crie o bot no Telegram

1. Abra o Telegram e procure por **@BotFather** (o que tem o selo azul).
2. Envie `/newbot`.
3. Escolha um nome (aparece para a cliente, ex.: "ADRI Maquiagem") e um usuário que termine em `bot` (ex.: `adri_maquiagem_bot`).
4. O BotFather responde com um texto comprido chamado **token**, parecido com `123456789:ABCdef...`. Copie.

Cuide desse token como uma senha. Quem tiver ele controla o bot.

### Passo 3. Cole o token e invente as duas senhas

No arquivo **`agente/.env`**, preencha:

```
ADMIN_API_TOKEN=invente-uma-senha-longa-1
TELEGRAM_BOT_TOKEN=cole-aqui-o-token-do-botfather
HUB_WEBHOOK_TOKEN=invente-uma-senha-longa-2
HUB_CALLBACK_TOKEN=invente-uma-senha-longa-3
HUB_URL=http://localhost:3002
```

No arquivo **`.env`** da raiz (o do hub), preencha com os mesmos valores:

```
AGENTE_URL=http://localhost:3001
AGENTE_TOKEN=a-mesma-senha-do-ADMIN_API_TOKEN
HUB_WEBHOOK_TOKEN=a-mesma-do-agente
WHATSAPP_CALLBACK_URL=http://localhost:3001/api/hub/callback
WHATSAPP_CALLBACK_TOKEN=a-mesma-do-HUB_CALLBACK_TOKEN
```

Regra para não errar: **a senha 1 vai em dois lugares** (`ADMIN_API_TOKEN` do agente e `AGENTE_TOKEN` do hub). **A senha 2 também** (`HUB_WEBHOOK_TOKEN` nos dois arquivos). **A senha 3** é `HUB_CALLBACK_TOKEN` no agente e `WHATSAPP_CALLBACK_TOKEN` no hub. Use letras e números sem espaço, com 30 caracteres ou mais.

A porta em `HUB_URL` precisa ser a mesma do `PORT` do `.env` do hub.

### Passo 4. Ligue os dois programas

Abra dois terminais.

Terminal 1, na raiz do projeto:

```bash
npm install
npm start
```

Terminal 2, dentro da pasta do agente:

```bash
cd agente
npm install
npm start
```

No terminal do agente deve aparecer algo como `telegram.polling.started`. Isso quer dizer que o bot está escutando.

### Passo 5. Teste

1. No Telegram, procure o seu bot pelo usuário e envie "Oi, quero fazer uma maquiagem".
2. A ADRI responde e começa a perguntar data, endereço e serviço.
3. No hub, abra a aba **Conversas**. A conversa deve aparecer na lista, com o canal **Telegram**.

Ao abrir a conversa, você pode **assumir** (a ADRI fica em silêncio), escrever para a cliente e **devolver** à ADRI.

Para limitar quem pode falar com o bot, descubra o seu `chat id` e coloque em `TELEGRAM_ALLOWED_CHAT_IDS` no `agente/.env` (vários separados por vírgula). Vazio quer dizer que qualquer pessoa que achar o bot consegue conversar.

## Parte 2: WhatsApp oficial (Meta)

O WhatsApp usa o mesmo agente e a mesma aba Conversas. A diferença é que o canal passa pela API oficial da Meta, que exige conta de empresa, um número dedicado e um endereço público na internet. Reserve um tempo maior, porque algumas aprovações da Meta levam de minutos a dias.

Detalhes técnicos e regras ficam em [`agente/GUIA_INTEGRACAO_WHATSAPP.md`](agente/GUIA_INTEGRACAO_WHATSAPP.md). Aqui está o caminho em ordem.

### Passo 1. Prepare a conta e o número

1. Crie ou acesse uma conta no **Meta Business** (business.facebook.com).
2. Em **developers.facebook.com**, crie um app do tipo **Business** e adicione o produto **WhatsApp**.
3. Tenha um número de telefone dedicado ao negócio. Ele não pode estar ativo no aplicativo WhatsApp comum, a não ser que a sua conta tenha o modo de coexistência.
4. Para sair do limite inicial de conversas, verifique o negócio na Meta (pede documentos da empresa).

### Passo 2. Pegue as quatro chaves

| Chave no `agente/.env` | Onde encontrar |
|---|---|
| `WHATSAPP_PHONE_NUMBER_ID` | Painel do app, WhatsApp, Configuração da API: aparece como "ID do número de telefone" |
| `WHATSAPP_ACCESS_TOKEN` | Configurações do negócio, Usuários do sistema: crie um usuário, atribua o app e a conta do WhatsApp e gere o token com as permissões `whatsapp_business_messaging` e `whatsapp_business_management`. O token temporário do painel vale só 24 horas |
| `WHATSAPP_APP_SECRET` | Configurações do app, Básico, "Chave secreta do app" |
| `WHATSAPP_VERIFY_TOKEN` | Você inventa um texto qualquer e anota. Ele será colado de novo no passo do webhook |

Cole no `agente/.env`, ao lado de `WHATSAPP_API_VERSION=v21.0`. Reinicie o agente. Quando as quatro estiverem preenchidas, abrir `http://localhost:3001/health` mostra `official-cloud-api`.

### Passo 3. Dê um endereço público ao agente

A Meta precisa conseguir chamar o seu agente pela internet, com HTTPS.

- **Para testar no seu computador:** use um túnel, como ngrok ou cloudflared. Ele cria um endereço do tipo `https://algo.ngrok.app` que aponta para a porta 3001.
- **Para uso de verdade:** hospede o agente num servidor com domínio e HTTPS.

O endereço do webhook será: `https://SEU-ENDERECO/webhooks/whatsapp`.

### Passo 4. Conecte o webhook na Meta

1. No painel do app: WhatsApp, Configuração, Webhook, **Editar**.
2. Em **URL de callback**, cole o endereço do passo anterior.
3. Em **Token de verificação**, cole o mesmo texto do `WHATSAPP_VERIFY_TOKEN`.
4. Clique em verificar. Se a Meta recusar, confira se o agente está rodando e o túnel ligado.
5. Assine o campo **messages**.

### Passo 5. Template para mandar o orçamento

Depois de 24 horas sem mensagem da cliente, o WhatsApp só deixa enviar um modelo aprovado. Em WhatsApp Manager, Modelos de mensagem, crie um modelo de categoria **Utilidade**, idioma `pt_BR`, com cabeçalho do tipo **Documento** e corpo com uma variável (o nome da cliente). Quando a Meta aprovar, informe o nome do modelo em `whatsapp.quoteTemplateName` (veja a seção de configurações no `agente/README.md`).

### Passo 6. Teste

1. Use o número de teste que o painel da Meta oferece e mande uma mensagem do seu celular cadastrado.
2. A conversa aparece na aba Conversas do hub, agora com o canal **WhatsApp**.

Duas coisas para saber: a ADRI só responde a quem escreveu primeiro, e a Meta cobra por mensagens de modelo. Confira a tabela de preços atual dela antes de usar com clientes.

## Se algo der errado

| O que aparece | O que significa | O que fazer |
|---|---|---|
| "Sem conversas" | Tudo conectado, ninguém escreveu ainda | Mande uma mensagem para o bot ou o número |
| "AGENTE_TOKEN não configurado no .env do hub" | Falta a senha 1 no `.env` da raiz | Preencha `AGENTE_TOKEN`, reinicie o hub |
| "O agente ADRI está fora do ar" | O agente não está rodando, ou o `AGENTE_URL` está errado | Rode `npm start` em `agente/` e confira a porta |
| "Agente respondeu HTTP 401" | A senha 1 está diferente nos dois arquivos | Copie exatamente o mesmo valor nos dois |
| O bot do Telegram não responde | Token errado, ou o agente reiniciou sem o token | Confira `TELEGRAM_BOT_TOKEN` no `agente/.env` e olhe o terminal do agente |
| A Meta não verifica o webhook | Endereço fora do ar ou token de verificação diferente | Confira o túnel e se o texto é idêntico nos dois lados |

## Cuidados com as chaves

- Os arquivos `.env` nunca vão para o GitHub. Não os envie por mensagem nem print.
- Se um token vazar, gere outro: no BotFather com `/revoke`, e na Meta criando um novo token do usuário do sistema.
- Trocou uma chave? Reinicie o programa que a usa.
