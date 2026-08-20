'use strict';
const router = require('express').Router();
const { autenticar } = require('../middleware/auth');
const { query } = require('../config/database');
router.use(autenticar);
router.get('/', async (req, res) => {
  const { rows } = await query(`
    SELECT * FROM notificacao WHERE utilizador_id=$1
    ORDER BY criado_em DESC LIMIT 50
  `, [req.utilizador.id]);
  res.json(rows);
});
router.patch('/:id/ler', async (req, res) => {
  await query(`UPDATE notificacao SET lida=true, lida_em=NOW() WHERE id=$1 AND utilizador_id=$2`,
    [req.params.id, req.utilizador.id]);
  res.json({ ok: true });
});
router.patch('/ler-todas', async (req, res) => {
  await query(`UPDATE notificacao SET lida=true, lida_em=NOW() WHERE utilizador_id=$1 AND lida=false`,
    [req.utilizador.id]);
  res.json({ ok: true });
});
router.get('/nao-lidas', autenticar, async (req, res) => {
  try {
    const { rows:[r] } = await query(
      'SELECT COUNT(*) AS total FROM notificacao WHERE utilizador_id=$1 AND lida=false',
      [req.utilizador.id]
    );
    res.json({ total: parseInt(r.total||0) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

