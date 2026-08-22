'use strict';
/**
 * NexEdge — Notificações WhatsApp Business
 * Usa WhatsApp Business API (Meta) ou Twilio WhatsApp
 * Envia: alertas ITSM, vencimentos faturas, onboarding, lembretes
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { autenticar } = require('../middleware/auth');

// ── CONFIG ──
const WA_CONFIG = {
  provider: process.env.WA_PROVIDER || 'twilio', // 'twilio' ou 'meta'
  // Twilio
  twilio_sid: process.env.TWILIO_ACCOUNT_SID,
  twilio_token: process.env.TWILIO_AUTH_TOKEN,
  twilio_from: process.env.TWILIO_WA_FROM || 'whatsapp:+14155238886',
  // Meta Business API
  meta_token: process.env.META_WA_TOKEN,
  meta_phone_id: process.env.META_WA_PHONE_ID,
};

// ── ENVIAR MENSAGEM ──

async function enviarWhatsApp(telefone, mensagem, template=null) {
  if (!telefone) return false;

  // Normalizar telefone PT
  let tel = telefone.replace(/\s/g,'').replace(/[^+\d]/g,'');
  if (tel.startsWith('9') && tel.length === 9) tel = '+351' + tel;
  if (tel.startsWith('351') && !tel.startsWith('+')) tel = '+' + tel;

  if (WA_CONFIG.provider === 'twilio' && WA_CONFIG.twilio_sid) {
    const auth = Buffer.from(`${WA_CONFIG.twilio_sid}:${WA_CONFIG.twilio_token}`).toString('base64');
    const body = new URLSearchParams({
      From: WA_CONFIG.twilio_from,
      To: `whatsapp:${tel}`,
      Body: mensagem,
    });
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${WA_CONFIG.twilio_sid}/Messages.json`, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    return r.ok;
  }

  if (WA_CONFIG.provider === 'meta' && WA_CONFIG.meta_token) {
    const payload = template ? {
      messaging_product: 'whatsapp',
      to: tel.replace('+',''),
      type: 'template',
      template: { name: template.nome, language: { code: 'pt_PT' }, components: template.params },
    } : {
      messaging_product: 'whatsapp',
      to: tel.replace('+',''),
      type: 'text',
      text: { body: mensagem },
    };

    const r = await fetch(`https://graph.facebook.com/v19.0/${WA_CONFIG.meta_phone_id}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${WA_CONFIG.meta_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return r.ok;
  }

  // Sem provider configurado — log apenas
  console.log(`[WhatsApp] ${tel}: ${mensagem.slice(0,100)}...`);
  return true; // Em dev simular sucesso
}

// ── TEMPLATES DE MENSAGENS ──

const TEMPLATES = {
  ticket_criado: (nome, numero, titulo) =>
    `🎫 *Ticket ${numero} criado*\n\nOlá ${nome}!\n\nO teu pedido de suporte foi recebido:\n*${titulo}*\n\nA equipa irá contactar-te em breve.\n\n_NexEdge Suporte_`,

  ticket_resolvido: (nome, numero, resolucao) =>
    `✅ *Ticket ${numero} resolvido*\n\nOlá ${nome}!\n\nO teu pedido foi marcado como resolvido.\n\n📋 *Resolução:*\n${resolucao||'Ver detalhes no portal'}\n\nComo foi o nosso suporte? Responde com 1-5 ⭐\n\n_NexEdge Suporte_`,

  fatura_vencimento: (nome, numero, valor, dias) =>
    `📄 *Lembrete de Pagamento*\n\nOlá ${nome}!\n\nA fatura *${numero}* de *${valor}€* vence ${dias===0?'HOJE':`em ${dias} dias`}.\n\nPaga online ou contacta-nos para mais informações.\n\n_NexEdge_`,

  onboarding: (nome, empresa) =>
    `👋 *Bem-vindo à ${empresa}!*\n\nOlá ${nome}!\n\nEstamos preparar tudo para a tua chegada. Receberás mais informações em breve.\n\nQualquer questão, responde a esta mensagem.\n\n_Equipa RH_`,

  ferias_aprovadas: (nome, dataInicio, dataFim) =>
    `🏖 *Férias Aprovadas*\n\nOlá ${nome}!\n\nAs tuas férias foram aprovadas:\n📅 ${dataInicio} a ${dataFim}\n\nBoas férias! 🌞\n\n_Equipa RH_`,

  sla_breach: (numero, titulo, agente) =>
    `🚨 *SLA Breach — Acção Imediata*\n\n${agente ? `Olá ${agente}!` : ''}\n\nO ticket *${numero}* ultrapassou o SLA:\n_${titulo}_\n\nActua imediatamente.\n\n_NexEdge ITSM_`,

  alerta_iva: (periodo, valor, prazo) =>
    `🧾 *Alerta IVA — ${periodo}*\n\nDeclaração IVA pendente.\n\n💰 Saldo: *${valor}€*\n📅 Prazo: *${prazo}*\n\nAcede ao portal para submeter.\n\n_NexEdge Contabilidade_`,
};

// ── ROTAS API ──

router.use(autenticar);

// Configurar WhatsApp
router.get('/config', async (req, res) => {
  try {
    const r = await query(`SELECT * FROM whatsapp_config WHERE empresa_id=$1 LIMIT 1`, [req.empresaId]).catch(()=>({rows:[]}));
    res.json(r.rows[0] || { provider: 'nao_configurado', ativo: false });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/config', async (req, res) => {
  try {
    const { provider, twilio_sid, twilio_token, twilio_from, meta_token, meta_phone_id, ativo } = req.body;
    await query(`
      INSERT INTO whatsapp_config (empresa_id, provider, config, ativo)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (empresa_id) DO UPDATE SET provider=$2, config=$3, ativo=$4
    `, [req.empresaId, provider, JSON.stringify({ twilio_sid, twilio_token, twilio_from, meta_token, meta_phone_id }), ativo !== false]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Enviar mensagem manual
router.post('/enviar', async (req, res) => {
  try {
    const { telefone, mensagem, funcionario_id } = req.body;
    let tel = telefone;

    if (funcionario_id) {
      const f = await query(`SELECT telefone, telemovel FROM funcionario WHERE id=$1`, [funcionario_id]);
      tel = f.rows[0]?.telemovel || f.rows[0]?.telefone || telefone;
    }

    if (!tel) return res.status(400).json({ error: 'Telefone não encontrado' });
    const ok = await enviarWhatsApp(tel, mensagem);

    // Registar no log
    await query(`INSERT INTO whatsapp_log (empresa_id, telefone, mensagem, estado) VALUES ($1,$2,$3,$4)`,
      [req.empresaId, tel, mensagem, ok?'enviado':'erro']).catch(()=>{});

    res.json({ ok, telefone: tel });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Histórico de mensagens
router.get('/log', async (req, res) => {
  try {
    const r = await query(`SELECT * FROM whatsapp_log WHERE empresa_id=$1 ORDER BY criado_em DESC LIMIT 100`, [req.empresaId]).catch(()=>({rows:[]}));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Notificar ticket criado
router.post('/notificar/ticket/:id', async (req, res) => {
  try {
    const t = await query(`
      SELECT t.*, u.telemovel, u.nome_completo
      FROM itsm_ticket t
      JOIN utilizador u ON u.id=t.solicitante_id
      WHERE t.id=$1 AND t.empresa_id=$2
    `, [req.params.id, req.empresaId]);

    if (!t.rows.length || !t.rows[0].telemovel) return res.json({ ok: false, motivo: 'Sem telefone' });
    const ticket = t.rows[0];
    const msg = TEMPLATES.ticket_criado(ticket.nome_completo, ticket.numero, ticket.titulo);
    const ok = await enviarWhatsApp(ticket.telemovel, msg);
    res.json({ ok });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Webhook WhatsApp (resposta do utilizador)
router.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    // Meta WhatsApp
    if (body.object === 'whatsapp_business_account') {
      for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
          for (const msg of change.value?.messages || []) {
            const telefone = msg.from;
            const texto = msg.text?.body || '';
            console.log(`[WhatsApp webhook] De ${telefone}: ${texto}`);

            // Se resposta é uma avaliação (1-5)
            const nota = parseInt(texto);
            if (nota >= 1 && nota <= 5) {
              // Tentar associar ao último ticket do número
              const r = await query(`
                SELECT t.id FROM itsm_ticket t
                JOIN utilizador u ON u.id=t.solicitante_id
                WHERE u.telemovel LIKE $1 AND t.estado='resolvido'
                  AND t.satisfacao IS NULL
                ORDER BY t.resolvido_em DESC LIMIT 1
              `, [`%${telefone.slice(-9)}`]).catch(()=>({rows:[]}));

              if (r.rows.length) {
                await query(`UPDATE itsm_ticket SET satisfacao=$1 WHERE id=$2`, [nota, r.rows[0].id]);
                await enviarWhatsApp('+' + telefone, `✅ Obrigado pela tua avaliação de ${nota} ⭐! Fico contente em ajudar.`);
              }
            }
          }
        }
      }
    }

    res.status(200).json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Verificação webhook Meta
router.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === process.env.META_WA_VERIFY_TOKEN) {
    res.send(challenge);
  } else {
    res.status(403).end();
  }
});

// ── AUTOMAÇÕES WHATSAPP (chamadas pelo motor de automações) ──

async function notificarTicketCriado(ticket, telefone, nome) {
  const msg = TEMPLATES.ticket_criado(nome, ticket.numero, ticket.titulo);
  return enviarWhatsApp(telefone, msg);
}

async function notificarTicketResolvido(ticket, telefone, nome) {
  const msg = TEMPLATES.ticket_resolvido(nome, ticket.numero, ticket.resolucao);
  return enviarWhatsApp(telefone, msg);
}

async function notificarVencimentoFatura(fatura, telefone, nome, dias) {
  const valor = parseFloat(fatura.total||0).toFixed(2);
  const msg = TEMPLATES.fatura_vencimento(nome, fatura.numero, valor, dias);
  return enviarWhatsApp(telefone, msg);
}

async function notificarOnboarding(funcionario, telefone, empresaNome) {
  const msg = TEMPLATES.onboarding(funcionario.nome_completo, empresaNome);
  return enviarWhatsApp(telefone, msg);
}

async function notificarFeriasAprovadas(funcionario, ferias) {
  const msg = TEMPLATES.ferias_aprovadas(
    funcionario.nome_completo,
    new Date(ferias.data_inicio).toLocaleDateString('pt-PT'),
    new Date(ferias.data_fim).toLocaleDateString('pt-PT')
  );
  return enviarWhatsApp(funcionario.telemovel || funcionario.telefone, msg);
}

module.exports = {
  router,
  enviarWhatsApp,
  notificarTicketCriado,
  notificarTicketResolvido,
  notificarVencimentoFatura,
  notificarOnboarding,
  notificarFeriasAprovadas,
  TEMPLATES,
};
