'use strict';
const router = require('express').Router();
const { autenticar, autorizar } = require('../middleware/auth');
const { query } = require('../config/database');

router.get('/', autenticar, autorizar('admin_empresa','diretor'), async (req, res) => {
  try {
    const { tabela, utilizador_id, data_inicio, data_fim, pagina=1 } = req.query;
    const params = [req.empresaId];
    const condicoes = [
      '(al.empresa_id=$1 OR (al.empresa_id IS NULL AND al.utilizador_id IN (SELECT id FROM utilizador WHERE empresa_id=$1)))'
    ];

    if (tabela)        { params.push(tabela);              condicoes.push(`al.tabela=$${params.length}`); }
    if (utilizador_id) { params.push(utilizador_id);        condicoes.push(`al.utilizador_id=$${params.length}`); }
    if (data_inicio)   { params.push(data_inicio);          condicoes.push(`al.criado_em>=$${params.length}`); }
    if (data_fim)      { params.push(data_fim+' 23:59:59'); condicoes.push(`al.criado_em<=$${params.length}`); }

    const where = 'WHERE ' + condicoes.join(' AND ');
    const offset = (parseInt(pagina)-1) * 50;

    const { rows } = await query(`
      SELECT al.id, al.acao, al.tabela, al.registo_id, al.ip, al.criado_em,
        u.nome_completo AS utilizador_nome, u.email AS utilizador_email
      FROM log_auditoria al
      LEFT JOIN utilizador u ON u.id = al.utilizador_id
      ${where}
      ORDER BY al.criado_em DESC
      LIMIT 50 OFFSET ${offset}
    `, params);

    // COUNT usa mesma tabela sem alias
    const { rows:[tot] } = await query(
      `SELECT COUNT(*) FROM log_auditoria al ${where}`, params
    );

    res.json({ logs: rows, total: parseInt(tot.count), pagina: parseInt(pagina) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/stats', autenticar, autorizar('admin_empresa','diretor'), async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT acao, COUNT(*) AS total
      FROM log_auditoria
      WHERE (empresa_id=$1 OR (empresa_id IS NULL AND utilizador_id IN (SELECT id FROM utilizador WHERE empresa_id=$1)))
        AND criado_em >= NOW() - INTERVAL '30 days'
      GROUP BY acao ORDER BY total DESC LIMIT 10
    `, [req.empresaId]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
