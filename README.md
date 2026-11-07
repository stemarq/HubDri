# HubDri

Hub de captação de clientes. A IA do WhatsApp coleta os dados da cliente e envia para o hub; o hub calcula o orçamento (com Gemini ou Claude), gera o PDF e, com um clique de aprovação, devolve o PDF para a IA do WhatsApp continuar a conversa.

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

## Agente ADRI (pasta `agente/`)

O agente de WhatsApp da Adriana é um projeto separado, em TypeScript, com `package.json`, testes e `.env` próprios. Documentação em [`agente/README.md`](agente/README.md) e [`agente/GUIA_INTEGRACAO_WHATSAPP.md`](agente/GUIA_INTEGRACAO_WHATSAPP.md).

```bash
cd agente
npm install
cp .env.example .env   # use PORT=3001 se o hub estiver na 3000
npm start              # simulador em http://localhost:3001/simulator
npm test
```

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
  "dadosEvento": { "tipo": "Casamento", "data": "12/12/2026", "horario": "06:00", "local": "Campinas/SP" },
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

Com `GEMINI_API_KEY` (Gemini, modelo `gemini-3.6-flash`, trocável em `GEMINI_MODEL`) ou `ANTHROPIC_API_KEY` (Claude, `claude-opus-5-5`), a IA lê o briefing, os dados do evento, a conversa e até 6 fotos (referências de make) e escolhe **apenas códigos e quantidades** do catálogo; os valores e totais são sempre calculados pelo hub. Sem chave (ou se a IA falhar), entra o cálculo por regras (noiva, nº de pessoas, penteado, cílios, horário antes das 7h, km) com um aviso para revisar.

### Qual IA

- **Escolha do provedor:** com só uma chave no `.env`, vale aquela. Com as duas, o Gemini tem preferência, a menos que `IA_PROVEDOR=claude` diga o contrário. `IA_DESATIVADA=1` força o cálculo por regras.
- **Onde aparece:** ao iniciar, o hub mostra no terminal qual IA está em uso. No orçamento aparece "Gerado pela IA (Gemini)".
- **Sobrecarga do Gemini:** quando o Google devolve sobrecarga ou limite de uso (HTTP 429/5xx), o hub tenta de novo e depois usa o modelo reserva `gemini-3.5-flash-lite`, trocável em `GEMINI_MODELO_RESERVA` (`nenhum` desliga). Se ainda assim falhar, calcula pelas regras.
- **Mesmo comportamento nos dois:** mesmo formato de resposta, as mesmas travas (só códigos do catálogo, desconto até o máximo configurado) e a mesma volta para as regras se a IA falhar, bloquear ou demorar demais.
- **Privacidade (Gemini):** no plano gratuito do Google AI Studio, o Google pode usar o conteúdo enviado (conversa, fotos, nome e telefone das clientes) para melhorar os produtos dele. Para uso real, ative o faturamento (plano pago).

## Visual

Mobile-first, tema claro, elementos arredondados e sem animações. Paleta nude/rosé (`#EAD7C6` `#DDBBA8` `#F7F3EF` `#A98C7A` `#C87D76` `#B66A5C` `#7B4B4F` `#3A2A23`), definida em `public/tokens.css` e reaproveitada no PDF. Tipografia inspirada em patternbreak.ing: grotesca + IBM Plex Mono nos rótulos. O site usa Neue Montreal (fonte comercial); o hub usa Inter Tight no lugar. Se tiver a licença, coloque `NeueMontreal-Regular/Medium/Bold.woff2` em `public/fonts/` e ela passa a ser usada automaticamente.

## Banco de dados (Supabase)

O esquema fica em `supabase/migrations/`. A primeira migration cria:

- `perfis`: quem pode entrar no hub, ligado ao login do Supabase Auth, com papel `dona` ou `equipe`.
- `orcamentos`: cliente, evento, briefing e cálculo em `jsonb`. Também tem `total`, gerado a partir do cálculo, a aprovação única com `aprovado_por` e a resposta da cliente.
- `orcamento_imagens`, `orcamento_mensagens`, `orcamento_historico`, `orcamento_revisoes` e `orcamento_envios`. O histórico e as revisões guardam o `autor_id`.
- `notificacoes` e `saida_whatsapp`.
- O bucket privado `imagens-orcamento` no Storage, para as fotos do chat.

O código `ORC-0001` vem de uma sequence e o token público é gerado no banco. Um índice único impede dois orçamentos abertos para a mesma conversa.

### Login e permissões

Com o Supabase configurado, o hub exige login. A tela fica em `/login` e tem também "Esqueci minha senha", criação de senha por convite e uma tela para contas bloqueadas.

O login é feito pelo servidor, e a sessão fica em cookies `httpOnly`. O navegador não fala com o Supabase, e imagens e PDF abertos por link continuam protegidos. A sessão é renovada sozinha e dura até a pessoa clicar em **Sair**, no menu com as iniciais no topo.

Aprovações, edições e pedidos de mudança registram quem fez. O nome aparece no card de aprovação e no histórico.

Sem Supabase, não há login. Vale só a senha opcional `HUB_PASSWORD`.

- **Quem tem conta entra:** não há etapa de liberação. A primeira conta criada vira **dona**; as seguintes entram como **equipe**.
- **Equipe:** lê os orçamentos, cria e edita orçamentos, marca notificações como lidas e grava histórico só em seu próprio nome.
- **Dona:** além disso, muda papéis, bloqueia pessoas (`ativo = false`) e apaga orçamentos.
- **Chave `anon`:** não acessa nada.
- **Servidor do hub:** usa a `service_role`. Ele confere o login e se a conta não está bloqueada antes de cada ação; as regras acima protegem o acesso direto ao banco.

Para começar, crie a conta da dona em **Authentication → Users → Add user → Create new user**, com **Auto Confirm User** marcado. Ela já pode entrar em `/login`.

Configure também, no painel do Supabase:
- **Authentication → URL Configuration:**
  - **Site URL:** o endereço do hub (o mesmo `PUBLIC_URL`).
  - **Redirect URLs:** `<PUBLIC_URL>/definir-senha`.

  Assim os links de convite e de recuperação de senha abrem a tela de criar senha.
- **Authentication → Sign In / Providers:** desligue **Allow new users to sign up**. Como não há liberação, qualquer pessoa que conseguir criar conta entra no hub. Crie as contas só pelo painel (**Users → Add user** ou **Invite user**).

Para aplicar:

```bash
npx supabase login
npx supabase init            # só na primeira vez (cria supabase/config.toml)
npx supabase link --project-ref <id-do-projeto>
npx supabase db push
```

Outra opção é colar o conteúdo do arquivo no SQL Editor do painel.

Depois, preencha no `.env` os valores que ficam no painel do Supabase, em **Project Settings → API**:

```bash
SUPABASE_URL=https://<id-do-projeto>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<chave service_role>
```

Ao subir, o hub mostra `dados: Supabase`. Sem essas variáveis, ele continua gravando em `data/db.json`.

**Como funciona:**
- O hub carrega os orçamentos ao iniciar e trabalha com eles em memória, num processo só.
- Cada mudança é gravada no banco em segundo plano. Se o Supabase falhar, o hub tenta de novo em 30 s.
- As imagens do chat vão para o bucket `imagens-orcamento`. A pasta `data/uploads` passa a ser só um cache local, que pode ser apagado.

## Limitações do MVP

- Um processo só: mesmo com o Supabase, os dados ficam em memória. Rodar duas instâncias do hub ao mesmo tempo causaria conflito.
- Sem Supabase, o acesso é só uma senha opcional (`HUB_PASSWORD`, HTTP Basic), sem perfis nem registro de quem aprovou.
- Uma pessoa desativada pela dona pode levar até 30 s para perder o acesso.
- Notificações por polling (6 s), sem push/e-mail.

---

## Integração hub + agente ADRI

O agente (pasta `agente/`) é a "IA do WhatsApp" deste hub. Fluxo:

1. A cliente conversa com a ADRI (Telegram hoje, WhatsApp oficial depois). Quando todos os dados estão confirmados, o agente envia o lead para `POST /api/webhooks/whatsapp/lead` (agenda, horários, deslocamento estimado e conversa vão no briefing).
2. O hub calcula, gera o PDF e a Adriana aprova no app (**Fila**).
3. O hub chama `WHATSAPP_CALLBACK_URL` (`http://localhost:3001/api/hub/callback`): o agente baixa o PDF do hub e entrega para a cliente no chat, com o link de aprovação.
4. A cliente aprova pelo botão do PDF (ou escrevendo "aceito"): o agente **reserva o horário no Google Agenda** e confirma no chat. Pedidos de mudança escritos no chat voltam ao hub como `mudanca`.
5. A aba **Conversas** mostra todos os chats, com o histórico completo. A Adriana pode **assumir** a conversa (a ADRI fica em silêncio), escrever para a cliente e **devolver** à ADRI. Escrever já assume a conversa.

Variáveis: `AGENTE_URL`/`AGENTE_TOKEN` no `.env` do hub; `HUB_URL`/`HUB_WEBHOOK_TOKEN`/`HUB_CALLBACK_TOKEN` no `agente/.env` (modelos nos `.env.example`). Google Agenda: `agente/GUIA_GOOGLE_AGENDA.md`.

Para rodar tudo local: `npm start` na raiz (hub, `PORT`) e `npm start` dentro de `agente/` (porta `ADRI_PORT`, padrão 3001). Se o seu ambiente já tiver `SUPABASE_URL` definida (outro projeto), limpe-a ao subir o hub, ou ele tentará usar aquele banco.
