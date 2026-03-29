require('dotenv').config();

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', name: 'Cliq', version: '0.1.0' });
});

app.post('/chat', async (req, res) => {
  const { message } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'Campo "message" é obrigatório.' });
  }

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: 'Você é o assistente virtual do Cliq. Responda de forma curta e útil em português.',
      messages: [{ role: 'user', content: message }],
    });

    res.json({ reply: response.content[0].text });
  } catch (err) {
    console.error('Erro na API do Claude:', err.message);
    res.status(500).json({ error: 'Falha ao processar a mensagem.' });
  }
});

app.get('/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.post('/webhook/whatsapp', async (req, res) => {
  console.log('Webhook body:', JSON.stringify(req.body, null, 2));

  const entry = req.body?.entry?.[0];
  const change = entry?.changes?.[0];
  const message = change?.value?.messages?.[0];
  const phoneNumberId = change?.value?.metadata?.phone_number_id;

  if (message?.text?.body) {
    const numero = message.from;
    const texto = message.text.body;
    console.log(`Mensagem de ${numero}: ${texto}`);

    try {
      const claudeResponse = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: 'Você é o Cliq, um assistente de atendimento via WhatsApp. Seja direto e útil.',
        messages: [{ role: 'user', content: texto }],
      });

      const resposta = claudeResponse.content[0].text;
      console.log('Resposta Claude:', resposta);

      console.log('Enviando para WhatsApp:', numero, resposta);
      const whatsappRes = await fetch(`https://graph.facebook.com/v19.0/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: numero,
          text: { body: resposta },
        }),
      });
      console.log('Resposta WhatsApp API:', await whatsappRes.json());
    } catch (error) {
      console.error('ERRO COMPLETO:', error);
    }
  }

  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`Cliq rodando na porta ${PORT}`);
});
