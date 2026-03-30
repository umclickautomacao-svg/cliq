require('dotenv').config();

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(express.json());

const CLIENTS = {
  '1112302711964826': {
    name: 'Um Click Automação',
    systemPrompt: `Você é o assistente virtual da Um Click Automação, empresa especializada em automação residencial, sonorização, câmeras, fechaduras eletrônicas e controle de acesso em São Paulo, além de instalação de internet cabeada e Wi-Fi para todos os ambientes do imóvel.

Seu objetivo é qualificar o lead e encaminhar para o próximo passo correto.

PASSO 1 - IDENTIFICAR ORIGEM:
Pergunte de forma natural como a pessoa chegou até a Um Click: veio por indicação de alguma loja (EKAZA ou Nova Digital), viu um anúncio, ou encontrou pelo Instagram?

PASSO 2 - ENTENDER O MOMENTO:
Pergunte em que fase está o projeto/obra. Se ainda está no começo ou planejamento, pergunte quando estima que vai estar mais pronto para a automação.

PASSO 3 - QUALIFICAR:
- Se está pronto agora ou em menos de 60 dias → tente agendar visita técnica gratuita. Peça nome completo, endereço do imóvel e melhor horário.
- Se tem projeto → peça para enviar o projeto e agende visita.
- Se está longe (mais de 60 dias) → seja caloroso, diga que vai guardar o contato e pergunte quando seria um bom momento para retomar o contato. Registre isso.
- Se é arquiteto, engenheiro ou incorporadora → trate como parceiro potencial, pergunte sobre os projetos em andamento e diga que a Um Click tem condições especiais para parceiros.

PASSO 4 - COLETAR DADOS PARA ORÇAMENTO (se não puder visita):
Pergunte: quantidade de interruptores e teclas, ares condicionados, televisores, persianas motorizadas e o endereço do imóvel.

REGRAS:
- Seja simpático, direto e profissional. Nunca robótico.
- Nunca invente preços ou prazos.
- Se a pessoa perguntar algo técnico que você não sabe, diga que vai verificar com a equipe.
- Sempre termine coletando nome e contato se ainda não tiver.
- Máximo 2 perguntas por mensagem para não sobrecarregar.`,
    whatsappToken: process.env.WHATSAPP_TOKEN,
  },
};

const MAX_HISTORY = 10;
const CONVERSATION_TTL = 60 * 60 * 1000; // 1 hora em ms

// { numero: { messages: [...], lastActivity: timestamp } }
const conversationHistory = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [numero, data] of conversationHistory) {
    if (now - data.lastActivity > CONVERSATION_TTL) {
      conversationHistory.delete(numero);
    }
  }
}, 5 * 60 * 1000); // verifica a cada 5 minutos

function getHistory(numero) {
  if (!conversationHistory.has(numero)) {
    conversationHistory.set(numero, { messages: [], lastActivity: Date.now() });
  }
  return conversationHistory.get(numero);
}

async function upsertContact(numero, name) {
  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
    const headers = {
      'Content-Type': 'application/json',
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
    };

    // Busca o primeiro organization_id
    const orgRes = await fetch(`${supabaseUrl}/rest/v1/organizations?select=id&limit=1`, { headers });
    const orgs = await orgRes.json();
    const organizationId = orgs?.[0]?.id ?? null;

    // Upsert: cria ou atualiza pelo phone
    await fetch(`${supabaseUrl}/rest/v1/contacts`, {
      method: 'POST',
      headers: {
        ...headers,
        'Prefer': 'resolution=merge-duplicates',
      },
      body: JSON.stringify({
        phone: numero,
        name: name || numero,
        stage: 'lead',
        organization_id: organizationId,
        updated_at: new Date().toISOString(),
      }),
    });
  } catch (err) {
    console.error('Erro ao salvar contato no Supabase:', err.message);
  }
}

function addMessage(numero, role, content) {
  const conv = getHistory(numero);
  conv.messages.push({ role, content });
  conv.lastActivity = Date.now();
  if (conv.messages.length > MAX_HISTORY) {
    conv.messages.shift();
  }
}

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

  const client = CLIENTS[phoneNumberId];

  if (message?.text?.body) {
    const numero = message.from;
    const texto = message.text.body;
    console.log(`Mensagem de ${numero}: ${texto}`);

    try {
      if (!client) {
        console.warn(`Cliente não configurado para phone_number_id: ${phoneNumberId}`);
        await fetch(`https://graph.facebook.com/v19.0/${phoneNumberId}/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: numero,
            text: { body: 'Serviço não configurado para este número.' },
          }),
        });
        return res.sendStatus(200);
      }

      addMessage(numero, 'user', texto);
      const { messages } = getHistory(numero);

      const claudeResponse = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: client.systemPrompt,
        messages,
      });

      const resposta = claudeResponse.content[0].text;
      addMessage(numero, 'assistant', resposta);
      console.log('Resposta Claude:', resposta);

      console.log('Enviando para WhatsApp:', numero, resposta);
      const whatsappRes = await fetch(`https://graph.facebook.com/v19.0/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${client.whatsappToken}`,
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: numero,
          text: { body: resposta },
        }),
      });
      console.log('Resposta WhatsApp API:', await whatsappRes.json());

      const contactName = change?.value?.contacts?.[0]?.profile?.name;
      await upsertContact(numero, contactName);
    } catch (error) {
      console.error('ERRO COMPLETO:', error);
    }
  }

  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`Cliq rodando na porta ${PORT}`);
});
