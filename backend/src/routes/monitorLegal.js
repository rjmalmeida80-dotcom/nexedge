'use strict';
const router = require('express').Router();
const { autenticar, autorizar } = require('../middleware/auth');
const { query } = require('../config/database');
const { correrMonitor, FONTES, VALORES_ACTUAIS } = require('../services/monitorLegal');

const ADMIN = ['admin_empresa', 'admin_plataforma'];

router.use(autenticar);

// GET /api/monitor-legal — lista alertas legais
router.get('/', async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT * FROM alerta_legal WHERE empresa_id=$1 ORDER BY criado_em DESC LIMIT 50',
      [req.empresaId]
    );
    res.json({ alertas: rows, fontes: FONTES.length, valores_actuais: VALORES_ACTUAIS });
  } catch(e) {
    res.json({ alertas: [], fontes: FONTES.length, valores_actuais: VALORES_ACTUAIS });
  }
});

// POST /api/monitor-legal/correr — corre verificação manual
router.post('/correr', autorizar(...ADMIN), async (req, res) => {
  try {
    const resultado = await correrMonitor();
    res.json({ mensagem: 'Verificação concluída.', ...resultado });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/monitor-legal/:id/lido — marcar como lido
router.put('/:id/lido', async (req, res) => {
  await query('UPDATE alerta_legal SET lido=true WHERE id=$1 AND empresa_id=$2', [req.params.id, req.empresaId]);
  res.json({ mensagem: 'Marcado como lido.' });
});

// GET /api/monitor-legal/fontes — lista fontes monitorizadas
router.get('/fontes', async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT DISTINCT ON (fonte_id) * FROM monitor_legal ORDER BY fonte_id, atualizado_em DESC'
    );
    res.json({ fontes: FONTES.map(f => ({
      ...f,
      ultima_verificacao: rows.find(r => r.fonte_id === f.id)?.atualizado_em || null,
      alteracao_detectada: rows.find(r => r.fonte_id === f.id)?.alteracao_detectada || false,
    }))});
  } catch(e) {
    res.json({ fontes: FONTES });
  }
});

module.exports = router;
