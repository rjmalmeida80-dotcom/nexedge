'use strict';
const router = require('express').Router();
const { autenticar } = require('../middleware/auth');
const { query } = require('../config/database');

// ── Listar notificações do utilizador ─────────────────────────────────────────
router.get('/', autenticar, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT * FROM notificacao
      WHERE utilizador_id=$1
      ORDER BY criado_em DESC LIMIT 30
    `, [req.utilizador.id]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Marcar como lida ──────────────────────────────────────────────────────────
router.patch('/:id/ler', autenticar, async (req, res) => {
  try {
    await query('UPDATE notificacao SET lida=true WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Marcar todas como lidas ───────────────────────────────────────────────────
router.patch('/ler-todas', autenticar, async (req, res) => {
  try {
    await query(
      'UPDATE notificacao SET lida=true WHERE utilizador_id=$1 AND lida=false',
      [req.utilizador.id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Registar subscription de push ────────────────────────────────────────────
router.post('/push/subscribe', autenticar, async (req, res) => {
  try {
    const { endpoint, keys } = req.body;
    if (!endpoint || !keys) return res.status(400).json({ error: 'Endpoint e keys obrigatórios' });

    await query(`
      INSERT INTO push_subscription (utilizador_id, empresa_id, endpoint, p256dh, auth)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (utilizador_id, endpoint) DO UPDATE SET
        p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth, actualizado_em=NOW()
    `, [req.utilizador.id, req.empresaId, endpoint, keys.p256dh, keys.auth]);

    res.json({ ok: true, message: 'Push subscription registada' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Remover subscription de push ──────────────────────────────────────────────
router.delete('/push/unsubscribe', autenticar, async (req, res) => {
  try {
    const { endpoint } = req.body;
    await query(
      'DELETE FROM push_subscription WHERE utilizador_id=$1 AND endpoint=$2',
      [req.utilizador.id, endpoint]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Contar não lidas ──────────────────────────────────────────────────────────
router.get('/nao-lidas', autenticar, async (req, res) => {
  try {
    const { rows:[r] } = await query(`
      SELECT COUNT(*) AS total FROM notificacao
      WHERE utilizador_id=$1 AND lida=false
    `, [req.utilizador.id]);
    res.json({ total: parseInt(r.total) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
