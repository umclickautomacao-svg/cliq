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
    systemPrompt: `Você é o assistente virtual da Um Click Automação.

A Um Click é especializada em automação residencial e corporativa: fechaduras inteligentes, interruptores inteligentes, internet cabeada ou wi-fi, sonorização, câmeras de segurança, controle de acesso e automação completa de ambientes.

Região de atuação: tudo que estiver entre: baixada santista, barueri, campinas, são jose dos campos. toda sao paulo e toda grande sao paulo

REGRAS DE COMPORTAMENTO:

- Nunca use emojis.

- Seja direto, profissional e objetivo.

- Use frases curtas. Máximo de 2-3 linhas por mensagem.

- Sempre que possível, ofereça opções para o cliente selecionar em vez de perguntas abertas.

- Não dê preços exatos. Diga que o orçamento depende do dimensionamento do projeto.

- Não invente informações técnicas que você não tem certeza.

FLUXO DE QUALIFICAÇÃO:

Siga a sequência: saudação → tipo de serviço → tipo de imóvel → estágio da obra → quantidade → localização → encerramento.

Faça uma pergunta por vez. Não pule etapas.

ORIGEM DO LEAD:

Se o campo "origem" indicar "ad", o cliente veio de um anúncio.

Nesse caso, NÃO pergunte como ele chegou até a empresa. Vá direto para a qualificação.

Se o campo "origem" indicar "direto", pergunte como chegou (anúncio, indicação, Instagram, outro).

PERFIS ESPECIAIS:

Se o cliente mencionar que é arquiteto, engenheiro civil, dono de incorporadora ou construtora, trate como lead de parceria. Pergunte sobre o porte dos projetos e ofereça uma reunião com o Alê (proprietário) para discutir parceria.

QUANDO ESCALAR PARA HUMANO:

- Cliente pede para falar com uma pessoa

- Dúvida técnica que foge do escopo do bot

- Reclamação

- Lead de parceria (arquiteto/engenheiro/incorporadora)

- Cliente quer agendar visita técnica`,
    whatsappToken: process.env.WHATSAPP_TOKEN,
  },
};

// ─── State Machine ────────────────────────────────────────────────────────────

const STEP_ORDER = ['servico', 'imovel', 'estagio', 'quantidade', 'localizacao', 'encerramento'];

const SERVICOS_LIST = [
  { id: 'fechadura', title: 'Fechadura inteligente' },
  { id: 'iluminacao', title: 'Iluminação/interruptores' },
  { id: 'sonorizacao', title: 'Sonorização' },
  { id: 'cameras', title: 'Câmeras de segurança' },
  { id: 'acesso', title: 'Controle de acesso' },
  { id: 'internet', title: 'Internet cabeada/Wi-Fi' },
  { id: 'automacao', title: 'Automação completa' },
  { id: 'outro', title: 'Outro' },
];

const QUANTITY_BUTTONS = {
  fechadura:  [{ id: 'q1', title: '1 porta' },       { id: 'q2', title: '2 a 3' },         { id: 'q3', title: '4+' }],
  iluminacao: [{ id: 'q1', title: 'Até 3 ambientes'}, { id: 'q2', title: '4 a 8' },         { id: 'q3', title: 'Mais de 8' }],
  sonorizacao:[{ id: 'q1', title: '1 ambiente' },     { id: 'q2', title: '2 a 4' },         { id: 'q3', title: 'Mais de 4' }],
  cameras:    [{ id: 'q1', title: '1 a 2' },          { id: 'q2', title: '3 a 5' },         { id: 'q3', title: 'Mais de 5' }],
  acesso:     [{ id: 'q1', title: '1 ponto' },        { id: 'q2', title: '2 a 3' },         { id: 'q3', title: '4+' }],
  internet:   [{ id: 'q1', title: 'Até 3 ambientes'}, { id: 'q2', title: '4 a 8' },         { id: 'q3', title: 'Mais de 8' }],
  automacao:  [{ id: 'q1', title: 'Até 5 ambientes'}, { id: 'q2', title: '6 a 10' },        { id: 'q3', title: 'Mais de 10' }],
};

const leadState = {};

function initLead(numero, origem, anuncio) {
  leadState[numero] = {
    step: 'inicio',
    dados: { origem, anuncio, servicos: [], tipoImovel: null, estagioObra: null, quantidades: {}, localizacao: null },
    skipSteps: [],
    quantidadeIndex: 0,
  };
  return leadState[numero];
}

function getNextStep(state) {
  for (const s of STEP_ORDER) {
    if (!state.skipSteps.includes(s) && state.step !== s) {
      if (STEP_ORDER.indexOf(s) > STEP_ORDER.indexOf(state.step === 'inicio' ? '' : state.step)) {
        return s;
      }
    }
  }
  return 'livre';
}

function nextStepAfter(currentStep, skipSteps) {
  const idx = STEP_ORDER.indexOf(currentStep);
  for (let i = idx + 1; i < STEP_ORDER.length; i++) {
    if (!skipSteps.includes(STEP_ORDER[i])) return STEP_ORDER[i];
  }
  return 'livre';
}

const PRONTO_REGEX = /^(pronto|só isso|so isso|é só|e só|tudo|ok|fim|done|encerrar|terminar|continuar)$/i;

// ─── WhatsApp helpers ─────────────────────────────────────────────────────────

async function sendTextMessage(phoneNumberId, to, token, text) {
  return fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }),
  });
}

async function sendInteractiveButtons(phoneNumberId, to, token, bodyText, buttons) {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: buttons.slice(0, 3).map((b) => ({
          type: 'reply',
          reply: { id: b.id, title: b.title },
        })),
      },
    },
  };
  return fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
}

async function sendInteractiveList(phoneNumberId, to, token, bodyText, buttonText, sections) {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: bodyText },
      action: { button: buttonText, sections },
    },
  };
  return fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
}

// ─── Step sender ──────────────────────────────────────────────────────────────

async function sendStepQuestion(phoneNumberId, numero, token, step, state) {
  if (step === 'servico') {
    await sendInteractiveList(phoneNumberId, numero, token,
      'Qual serviço você precisa?',
      'Ver opções',
      [{ title: 'Serviços', rows: SERVICOS_LIST.map((s) => ({ id: s.id, title: s.title })) }]
    );
    await sendTextMessage(phoneNumberId, numero, token,
      "Selecione um serviço por vez. Quando terminar, digite 'pronto'."
    );
    return;
  }

  if (step === 'imovel') {
    await sendInteractiveButtons(phoneNumberId, numero, token,
      'Qual é o tipo do imóvel?',
      [{ id: 'casa', title: 'Casa' }, { id: 'apartamento', title: 'Apartamento' }, { id: 'comercial', title: 'Comercial' }]
    );
    return;
  }

  if (step === 'estagio') {
    await sendInteractiveButtons(phoneNumberId, numero, token,
      'Em que estágio está o imóvel?',
      [{ id: 'pronto', title: 'Pronto/morando' }, { id: 'reforma', title: 'Em reforma' }, { id: 'construcao', title: 'Em construção' }]
    );
    return;
  }

  if (step === 'quantidade') {
    const servicos = state.dados.servicos.filter((s) => s !== 'outro');
    const idx = state.quantidadeIndex;
    if (idx >= servicos.length) return; // será tratado pela lógica de avanço
    const servico = servicos[idx];
    const buttons = QUANTITY_BUTTONS[servico];
    const label = SERVICOS_LIST.find((s) => s.id === servico)?.title ?? servico;
    await sendInteractiveButtons(phoneNumberId, numero, token,
      `Quantas unidades para ${label}?`,
      buttons
    );
    return;
  }

  if (step === 'localizacao') {
    await sendTextMessage(phoneNumberId, numero, token, 'Em qual cidade ou região você está?');
    return;
  }

  if (step === 'encerramento') {
    await sendInteractiveButtons(phoneNumberId, numero, token,
      'Ótimo! Coletamos tudo que precisamos. Como prefere prosseguir?',
      [
        { id: 'proposta', title: 'Receber proposta aqui' },
        { id: 'visita', title: 'Agendar visita técnica' },
        { id: 'consultor', title: 'Falar com consultor' },
      ]
    );
    return;
  }
}

// ─── First message analysis ───────────────────────────────────────────────────

async function analyzeFirstMessage(texto, contexto) {
  const prompt = `Analise a primeira mensagem deste lead e o contexto de origem. Responda APENAS com um JSON válido sem markdown: { "skipSteps": ["servico", "quantidade", etc], "dados": { "servicos": ["fechadura"] ou [], "quantidades": {} }, "saudacao": "texto da saudação personalizada sem emoji, máximo 2 linhas" }. Skip steps que já podem ser inferidos da mensagem ou do anúncio. Se o anúncio é sobre um serviço específico, inclua esse serviço em dados.servicos e adicione servico em skipSteps.\n\nContexto: ${contexto}\nMensagem: ${texto}`;

  const r = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  });

  try {
    return JSON.parse(r.content[0].text);
  } catch {
    return { skipSteps: [], dados: { servicos: [], quantidades: {} }, saudacao: 'Olá! Bem-vindo à Um Click Automação.' };
  }
}

// ─── Qualification handler ────────────────────────────────────────────────────

async function handleQualification(phoneNumberId, numero, token, texto, state) {
  const { step, dados } = state;

  // ── servico: múltipla seleção ──
  if (step === 'servico') {
    if (PRONTO_REGEX.test(texto.trim())) {
      if (dados.servicos.length === 0) {
        await sendTextMessage(phoneNumberId, numero, token, 'Selecione ao menos um serviço antes de continuar.');
        return;
      }
      // adiciona "quantidade" a skipSteps se todos os serviços são "outro"
      const next = nextStepAfter('servico', state.skipSteps);
      state.step = next;
      await sendStepQuestion(phoneNumberId, numero, token, next, state);
      return;
    }

    // verifica se é seleção de serviço (lista interativa ou texto)
    const servicoSelecionado = SERVICOS_LIST.find(
      (s) => s.id === texto || s.title.toLowerCase() === texto.toLowerCase()
    );
    if (servicoSelecionado) {
      if (!dados.servicos.includes(servicoSelecionado.id)) {
        dados.servicos.push(servicoSelecionado.id);
      }
      const label = servicoSelecionado.title;
      await sendTextMessage(phoneNumberId, numero, token,
        `Anotado: ${label}. Mais algum serviço ou digite 'pronto' para continuar.`
      );
      return;
    }

    // texto livre não reconhecido: reapresenta a lista
    await sendStepQuestion(phoneNumberId, numero, token, 'servico', state);
    return;
  }

  // ── imovel ──
  if (step === 'imovel') {
    dados.tipoImovel = texto;
    const next = nextStepAfter('imovel', state.skipSteps);
    state.step = next;
    await sendStepQuestion(phoneNumberId, numero, token, next, state);
    return;
  }

  // ── estagio ──
  if (step === 'estagio') {
    dados.estagioObra = texto;
    const next = nextStepAfter('estagio', state.skipSteps);
    state.step = next;
    await sendStepQuestion(phoneNumberId, numero, token, next, state);
    return;
  }

  // ── quantidade: loop ──
  if (step === 'quantidade') {
    const servicosComQtd = dados.servicos.filter((s) => s !== 'outro');
    const idx = state.quantidadeIndex;
    if (idx < servicosComQtd.length) {
      dados.quantidades[servicosComQtd[idx]] = texto;
      state.quantidadeIndex++;
    }
    if (state.quantidadeIndex < servicosComQtd.length) {
      // ainda há serviços para perguntar
      await sendStepQuestion(phoneNumberId, numero, token, 'quantidade', state);
      return;
    }
    // todos respondidos
    const next = nextStepAfter('quantidade', state.skipSteps);
    state.step = next;
    await sendStepQuestion(phoneNumberId, numero, token, next, state);
    return;
  }

  // ── localizacao ──
  if (step === 'localizacao') {
    dados.localizacao = texto;
    const next = nextStepAfter('localizacao', state.skipSteps);
    state.step = next;
    await sendStepQuestion(phoneNumberId, numero, token, next, state);
    return;
  }

  // ── encerramento ──
  if (step === 'encerramento') {
    state.step = 'livre';
    // cai no fluxo livre abaixo (retorna false para indicar que deve continuar com Claude)
    return false;
  }

  return true; // mensagem tratada pela state machine
}

// ─── Conversation history ─────────────────────────────────────────────────────

const MAX_HISTORY = 10;
const CONVERSATION_TTL = 60 * 60 * 1000;

const conversationHistory = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [numero, data] of conversationHistory) {
    if (now - data.lastActivity > CONVERSATION_TTL) {
      conversationHistory.delete(numero);
      delete leadState[numero];
    }
  }
}, 5 * 60 * 1000);

function getHistory(numero) {
  if (!conversationHistory.has(numero)) {
    conversationHistory.set(numero, { messages: [], lastActivity: Date.now() });
  }
  return conversationHistory.get(numero);
}

function addMessage(numero, role, content) {
  const conv = getHistory(numero);
  conv.messages.push({ role, content });
  conv.lastActivity = Date.now();
  if (conv.messages.length > MAX_HISTORY) {
    conv.messages.shift();
  }
}

// ─── Supabase ─────────────────────────────────────────────────────────────────

async function upsertContact(numero, name) {
  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
    const headers = {
      'Content-Type': 'application/json',
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
    };

    const orgRes = await fetch(`${supabaseUrl}/rest/v1/organizations?select=id&limit=1`, { headers });
    const orgs = await orgRes.json();
    const organizationId = orgs?.[0]?.id ?? null;

    await fetch(`${supabaseUrl}/rest/v1/contacts`, {
      method: 'POST',
      headers: { ...headers, 'Prefer': 'resolution=merge-duplicates' },
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

// ─── Routes ───────────────────────────────────────────────────────────────────

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

  if (!message) return res.sendStatus(200);

  // Extrai texto de mensagem de texto ou resposta interativa
  let texto = null;
  if (message.type === 'text') {
    texto = message.text?.body;
  } else if (message.type === 'interactive') {
    texto = message.interactive?.button_reply?.title
      ?? message.interactive?.list_reply?.title
      ?? null;
  }

  if (!texto) return res.sendStatus(200);

  const numero = message.from;
  const referral = message.referral;
  const origem = referral ? referral.source_type : 'direto';
  const anuncioInfo = referral?.headline ?? null;
  console.log(`Mensagem de ${numero} [origem: ${origem}]: ${texto}`);

  try {
    if (!client) {
      console.warn(`Cliente não configurado para phone_number_id: ${phoneNumberId}`);
      await sendTextMessage(phoneNumberId, numero, process.env.WHATSAPP_TOKEN, 'Serviço não configurado para este número.');
      return res.sendStatus(200);
    }

    const { whatsappToken } = client;
    const contactName = change?.value?.contacts?.[0]?.profile?.name;

    // ── PRIMEIRA MENSAGEM: analisa e inicializa state machine ──
    if (!leadState[numero]) {
      const contexto = origem === 'ad'
        ? `Origem: ad. Anúncio: ${anuncioInfo}`
        : 'Origem: direto';

      const analysis = await analyzeFirstMessage(texto, contexto);
      const state = initLead(numero, origem, anuncioInfo);
      state.skipSteps = analysis.skipSteps ?? [];
      if (analysis.dados?.servicos?.length) state.dados.servicos = analysis.dados.servicos;
      if (analysis.dados?.quantidades) state.dados.quantidades = analysis.dados.quantidades;

      // Envia saudação
      await sendTextMessage(phoneNumberId, numero, whatsappToken, analysis.saudacao);

      // Avança para o primeiro step não-pulado
      const firstStep = nextStepAfter('', state.skipSteps.includes('servico') ? 'servico' : '');
      // Encontra o primeiro step da ordem que não está em skipSteps
      const first = STEP_ORDER.find((s) => !state.skipSteps.includes(s)) ?? 'livre';
      state.step = first;
      await sendStepQuestion(phoneNumberId, numero, whatsappToken, first, state);

      await upsertContact(numero, contactName);
      return res.sendStatus(200);
    }

    const state = leadState[numero];

    // ── QUALIFICAÇÃO em andamento ──
    if (state.step !== 'livre') {
      const handled = await handleQualification(phoneNumberId, numero, whatsappToken, texto, state);
      // handleQualification retorna false apenas no encerramento (para cair no Claude livre)
      if (handled !== false) {
        await upsertContact(numero, contactName);
        return res.sendStatus(200);
      }
      // se retornou false, continua para o Claude abaixo
    }

    // ── MODO LIVRE: Claude normal ──
    const contexto = origem === 'ad'
      ? `[CONTEXTO: cliente veio do anúncio ${anuncioInfo}. Origem: ad]`
      : '[CONTEXTO: cliente chegou por contato direto]';
    const textoComContexto = `${contexto}\n${texto}`;

    addMessage(numero, 'user', textoComContexto);
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

    const whatsappRes = await sendTextMessage(phoneNumberId, numero, whatsappToken, resposta);
    console.log('Resposta WhatsApp API:', await whatsappRes.json());

    await upsertContact(numero, contactName);
  } catch (error) {
    console.error('ERRO COMPLETO:', error);
  }

  res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`Cliq rodando na porta ${PORT}`);
});
