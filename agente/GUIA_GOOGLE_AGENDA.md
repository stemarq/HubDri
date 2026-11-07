# Ligar o Google Agenda da Adriana

Com isso a ADRI passa a **ler a agenda real** (para não marcar em cima de outro compromisso e sugerir horários) e **cria o evento** quando a cliente aprova o orçamento. Sem as credenciais, ela usa uma agenda simulada, sempre identificada como tal.

Faça uma vez, logado com a conta Google da Adriana (ou uma conta com acesso à agenda dela).

## 1. Criar as credenciais (Google Cloud)

1. Abra https://console.cloud.google.com e crie um projeto (ex.: "HubDri").
2. Menu **APIs e serviços > Biblioteca**, procure **Google Calendar API** e clique em **Ativar**.
3. **APIs e serviços > Tela de permissão OAuth**: tipo **Externo**, preencha nome do app e e-mail, e em **Usuários de teste** adicione o e-mail da Adriana. (Em modo de teste o token expira em 7 dias; para uso contínuo, clique em **Publicar app**. Para uso interno de uma pessoa, basta publicar sem verificação e aceitar o aviso de app não verificado.)
4. **APIs e serviços > Credenciais > Criar credenciais > ID do cliente OAuth**, tipo **App para computador**. Copie o **ID do cliente** e a **chave secreta**.

## 2. Gerar o token de acesso

No `agente/.env`:

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

No terminal, dentro de `agente/`:

```bash
npm run google-auth
```

O navegador abre, você autoriza o acesso à agenda e o terminal imprime a linha `GOOGLE_REFRESH_TOKEN=...` e a lista de agendas. Cole no `agente/.env`:

```
GOOGLE_REFRESH_TOKEN=...
GOOGLE_CALENDAR_ID=primary      # ou o id da agenda impresso no terminal
```

## 3. Reiniciar o agente

`GET http://localhost:3001/health` passa a mostrar `"calendar":"google-calendar"`.

## Como a ADRI usa a agenda

- **Consulta:** antes de montar o orçamento, vê os eventos do dia (com bloco de saída, trajeto, atendimento e retorno, mais a margem entre compromissos). Eventos de dia inteiro e marcados como "livre" são ignorados.
- **Conflito:** se houver choque, oferece horários e dias alternativos em vez de inventar.
- **Agenda inacessível:** se o Google falhar, ela não afirma que está livre: o orçamento vai para revisão com o motivo `CALENDAR_UNVERIFIED`.
- **Criação do evento:** só quando a cliente aprova a proposta (link de aprovação ou aceite no chat). O evento ocupa do horário de saída ao retorno e leva o endereço no campo local. Uma trava impede duas reservas no mesmo horário.
