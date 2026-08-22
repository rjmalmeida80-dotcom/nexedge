'use strict';
/**
 * NexEdge — Webhooks & API Pública
 * Notificações em tempo real para sistemas externos
 * Supera: Stripe Webhooks em termos de fiabilidade
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const crypto = require('crypto');

router.use(autenticar);

// Eventos disponíveis
const EVENTOS = [
  'fatura.criada','fatura.paga','fatura.vencida',
  'funcionario.admitido','funcionario.saiu',
  'ticket.criado','ticket.resolvido','ticket.escalado',
  'oportunidade.ganha','oportunidade.perdida',
  'ferias.aprovadas','ferias.rejeitadas',
  'despesa.aprovada','despesa.rejeitada',
  'contrato.expira_em_30dias','contrato.renovado',
  'pagamento.recebido','cobranca.enviada',
  'projecto.concluido','tarefa.concluida',
  'okr.actualizado',
];

// ── GERIR WEBHOOKS ──

router.get('/eventos', (req, res) => res.json(EVENTOS));

router.get('/', async (req, res) => {
  try {
    const r = await query(`SELECT id, url, eventos, ativo, criado_em,
      (SELECT COUNT(*) FROM webhook_log WHERE webhook_id=w.id) as total_chamadas,
      (SELECT COUNT(*) FROM webhook_log WHERE webhook_id=w.id AND sucesso=false) as falhas
      FROM webhook w WHERE empresa_id=$1 ORDER BY criado_em DESC`, [req.empresaId]).catch(()=>({rows:[]}));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const { url, eventos, descricao } = req.body;
    if (!url || !eventos?.length) return res.status(400).json({ error: 'URL e eventos obrigatórios' });

    // Validar URL
    try { new URL(url); } catch(e) { return res.status(400).json({ error: 'URL inválido' }); }

    const secret = crypto.randomBytes(24).toString('hex');
    const r = await query(`
      INSERT INTO webhook (empresa_id, url, eventos, descricao, secret, ativo)
      VALUES ($1,$2,$3,$4,$5,true) RETURNING id, url, eventos, descricao, ativo, criado_em
    `, [req.empresaId, url, JSON.stringify(eventos), descricao||'', secret]);

    res.status(201).json({ ...r.rows[0], secret }); // Secret apenas mostrado na criação
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    await query(`DELETE FROM webhook WHERE id=$1 AND empresa_id=$2`, [req.params.id, req.empresaId]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Log de chamadas
router.get('/:id/log', async (req, res) => {
  try {
    const r = await query(`SELECT * FROM webhook_log WHERE webhook_id=$1 ORDER BY criado_em DESC LIMIT 50`, [req.params.id]).catch(()=>({rows:[]}));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DISPARAR WEBHOOK ──

async function dispararWebhook(empresaId, evento, dados) {
  try {
    const webhooks = await query(`
      SELECT * FROM webhook WHERE empresa_id=$1 AND ativo=true AND eventos @> $2
    `, [empresaId, JSON.stringify([evento])]).catch(()=>({rows:[]}));

    for (const wh of webhooks.rows) {
      const payload = {
        evento, timestamp: new Date().toISOString(),
        empresa_id: empresaId, dados,
      };
      const body = JSON.stringify(payload);
      const signature = crypto.createHmac('sha256', wh.secret).update(body).digest('hex');

      const inicio = Date.now();
      let sucesso = false, status = 0, resposta = '';

      try {
        const r = await fetch(wh.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-NexEdge-Signature': `sha256=${signature}`,
            'X-NexEdge-Event': evento,
            'X-NexEdge-Delivery': crypto.randomUUID(),
          },
          body,
          signal: AbortSignal.timeout(10000),
        });
        sucesso = r.ok;
        status = r.status;
        resposta = await r.text().catch(()=>'');
      } catch(e) {
        resposta = e.message;
      }

      await query(`INSERT INTO webhook_log (webhook_id, empresa_id, evento, payload, status_http, resposta, sucesso, duracao_ms)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [wh.id, empresaId, evento, body, status, resposta.slice(0,500), sucesso, Date.now()-inicio]).catch(()=>{});
    }
  } catch(e) {
    console.error('[Webhook] Erro:', e.message);
  }
}

module.exports = { router, dispararWebhook, EVENTOS };
