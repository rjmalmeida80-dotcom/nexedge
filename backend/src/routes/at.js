'use strict';
const router = require('express').Router();
const { autenticar, autorizar } = require('../middleware/auth');
const at = require('../services/atService');
const { query } = require('../config/database');

// ── Validar NIF ───────────────────────────────────────────────────────────────
router.get('/validar-nif/:nif', autenticar, async (req, res) => {
  try {
    const resultado = await at.validarNIF(req.params.nif, req.empresaId);
    res.json(resultado);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Comunicar série ───────────────────────────────────────────────────────────
router.post('/comunicar-serie', autenticar, autorizar('admin_empresa','rh'), async (req, res) => {
  try {
    const { tipodoc, serie, iniciador } = req.body;
    const resultado = await at.comunicarSerie(req.empresaId, { tipodoc, serie, iniciador });
    res.json(resultado);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Consultar séries ──────────────────────────────────────────────────────────
router.get('/series/:tipodoc?', autenticar, async (req, res) => {
  try {
    const resultado = await at.consultarSeries(req.empresaId, req.params.tipodoc);
    res.json(resultado);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Submeter SAF-T manualmente ────────────────────────────────────────────────
router.post('/submeter-saft', autenticar, autorizar('admin_empresa'), async (req, res) => {
  try {
    const { tipo, ano, mes } = req.body;
    const resultado = await at.submeterSAFT(req.empresaId, tipo, ano, mes);
    res.json(resultado);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Comunicar fatura manualmente ──────────────────────────────────────────────
router.post('/comunicar-fatura/:id', autenticar, autorizar('admin_empresa','rh'), async (req, res) => {
  try {
    const { rows:[fat] } = await query(
      'SELECT f.*, e.nif AS empresa_nif, e.nome AS empresa_nome FROM fatura f JOIN empresa e ON e.id=f.empresa_id WHERE f.id=$1 AND f.empresa_id=$2',
      [req.params.id, req.empresaId]
    );
    if (!fat) return res.status(404).json({ error: 'Fatura não encontrada' });
    const resultado = await at.comunicarFatura(fat, { nif: fat.empresa_nif, nome: fat.empresa_nome });
    res.json(resultado);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Estado das submissões ─────────────────────────────────────────────────────
router.get('/submissoes', autenticar, async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT * FROM at_submissao WHERE empresa_id=$1 ORDER BY criado_em DESC LIMIT 20',
      [req.empresaId]
    ).catch(() => ({ rows: [] }));
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
