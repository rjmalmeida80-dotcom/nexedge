'use strict';
const router = require('express').Router();
const email = require('../services/emailService');
const push = require('../services/pushService');
const ctrl   = require('../controllers/feriasController');
const { autenticar, autorizar } = require('../middleware/auth');
const { middlewareAuditoria }   = require('../middleware/auditoria');

const APROVADORES = ['admin_empresa','rh','diretor','supervisor','team_leader'];

router.use(autenticar, middlewareAuditoria);
router.get('/',                      ctrl.listar);
router.post('/',                     ctrl.criar);
// Email automático na aprovação/rejeição
router.patch('/:id/aprovar',         autorizar(...APROVADORES), ctrl.aprovar);
router.patch('/:id/rejeitar',        autorizar(...APROVADORES), ctrl.rejeitar);

// GET /ferias/mapa?ano=2025 — mapa anual de ferias por funcionario
router.get('/mapa', autenticar, async (req, res) => {
  const ano = parseInt(req.query.ano) || new Date().getFullYear();
  const { rows } = await query(`
    SELECT
      f.id AS funcionario_id,
      f.nome_completo,
      d.nome AS departamento,
      COALESCE(SUM(pf.num_dias), 0) AS total_dias,
      json_agg(json_build_object(
        'data_inicio', pf.data_inicio,
        'data_fim', pf.data_fim,
        'num_dias', pf.num_dias
      ) ORDER BY pf.data_inicio) FILTER (WHERE pf.id IS NOT NULL) AS periodos
    FROM funcionario f
    LEFT JOIN departamento d ON d.id = f.departamento_id
    LEFT JOIN pedido_ferias pf ON pf.funcionario_id = f.id
      AND pf.estado = 'aprovado'
      AND EXTRACT(YEAR FROM pf.data_inicio) = $2
    WHERE f.empresa_id = $1 AND f.estado = 'ativo'
    GROUP BY f.id, f.nome_completo, d.nome
    ORDER BY d.nome NULLS LAST, f.nome_completo
  `, [req.empresaId, ano]);
  res.json(rows);
});

module.exports = router;
