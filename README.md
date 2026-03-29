# Cliq

Plataforma de agentes IA para WhatsApp, construída com Node.js, Express e Claude (Anthropic).

## Como rodar

```bash
npm install
cp .env.example .env
# preencha as variáveis no .env
npm start
```

## Variáveis de ambiente

| Variável | Descrição |
|---|---|
| `ANTHROPIC_API_KEY` | Chave da API da Anthropic |
| `WHATSAPP_TOKEN` | Token de acesso da API do WhatsApp (Meta) |
| `WHATSAPP_PHONE_NUMBER_ID` | ID do número de telefone no WhatsApp Business |
| `WEBHOOK_VERIFY_TOKEN` | Token para verificação do webhook do WhatsApp |
| `PORT` | Porta do servidor (padrão: 3000) |

## Rotas

- `GET /health` — status da aplicação
- `POST /webhook/whatsapp` — recebe eventos do WhatsApp
