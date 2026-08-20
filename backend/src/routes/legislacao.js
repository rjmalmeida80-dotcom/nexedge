'use strict';
const router = require('express').Router();
const { autenticar, autorizar } = require('../middleware/auth');
const { middlewareAuditoria } = require('../middleware/auditoria');
const { query } = require('../config/database');

const ADMIN = ['admin_empresa','admin_plataforma','rh','diretor'];
router.use(autenticar, middlewareAuditoria);

// Listar regras legais ativas
router.get('/regras', async (req, res) => {
  const { categoria } = req.query;
  const params = [];
  let where = 'WHERE ativa=true';
  if (categoria) { where += ' AND categoria=$1'; params.push(categoria); }
  const { rows } = await query(`SELECT * FROM regra_legal ${where} ORDER BY categoria, codigo`, params);
  res.json(rows);
});

// Listar alertas legais pendentes para esta empresa
router.get('/alertas', async (req, res) => {
  const { rows } = await query(`
    SELECT al.*,
           aal.decisao, aal.justificacao, aal.decidido_em, u.nome_completo AS decidido_por_nome
    FROM alerta_legal al
    LEFT JOIN aprovacao_alerta_legal aal ON aal.alerta_id=al.id AND aal.empresa_id=$1
    LEFT JOIN utilizador u ON u.id=aal.decidido_por
    ORDER BY al.criado_em DESC
  `, [req.empresaId]);
  res.json(rows);
});

// Decidir sobre alerta legal
router.post('/alertas/:id/decidir', autorizar(...ADMIN), async (req, res) => {
  const { decisao, justificacao } = req.body;
  if (!['aplicar','adiar','rejeitar'].includes(decisao)) {
    return res.status(400).json({ error: 'Decisão inválida.' });
  }
  await query(`
    INSERT INTO aprovacao_alerta_legal (alerta_id, empresa_id, decisao, justificacao, decidido_por)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT DO NOTHING
  `, [req.params.id, req.empresaId, decisao, justificacao||null, req.utilizador.id]);

  await req.auditar({ acao: `ALERTA_LEGAL_${decisao.toUpperCase()}`, registoId: req.params.id });
  res.json({ mensagem: 'Decisão registada com sucesso.' });
});

module.exports = router;
