'use strict';
const router = require('express').Router();
const { autenticar, autorizar } = require('../middleware/auth');
const { middlewareAuditoria } = require('../middleware/auditoria');
const { query } = require('../config/database');
const { criarErro } = require('../middleware/errorHandler');
const RH = ['admin_empresa','rh','diretor','supervisor','team_leader'];
router.use(autenticar, middlewareAuditoria);

router.get('/', async (req, res) => {
  const { funcionario_id, mes, ano, tipo } = req.query;
  const params = [req.empresaId]; const conds = ['f.empresa_id=$1']; let p=2;
  if (req.utilizador.perfil === 'funcionario' && req.utilizador.funcionario_id) {
    conds.push(`fa.funcionario_id=$${p}`); params.push(req.utilizador.funcionario_id); p++;
  } else if (funcionario_id) { conds.push(`fa.funcionario_id=$${p}`); params.push(funcionario_id); p++; }
  if (mes) { conds.push(`EXTRACT(MONTH FROM fa.data)=$${p}`); params.push(parseInt(mes)); p++; }
  if (ano) { conds.push(`EXTRACT(YEAR FROM fa.data)=$${p}`); params.push(parseInt(ano)); p++; }
  if (tipo) { conds.push(`fa.tipo=$${p}`); params.push(tipo); p++; }
  const { rows } = await query(`
    SELECT fa.*, f.nome_completo, f.numero_funcionario
    FROM falta fa JOIN funcionario f ON f.id=fa.funcionario_id
    WHERE ${conds.join(' AND ')} ORDER BY fa.data DESC
  `, params);
  res.json(rows);
});

router.post('/', async (req, res) => {
  const { funcionario_id, data, data_inicio, tipo, descricao, motivo } = req.body;
  const funcId = funcionario_id || req.utilizador.funcionario_id;
  const dataFinal = data || data_inicio;
  const tipoFinal = tipo || 'outros';
  if (!funcId || !dataFinal) throw criarErro('Funcionário e data são obrigatórios.', 400);
  const { rows } = await query(`
    INSERT INTO falta (funcionario_id, data, tipo, descricao)
    VALUES ($1,$2,$3,$4) RETURNING *
  `, [funcId, dataFinal, tipoFinal, descricao||motivo||null]);
  await req.auditar({ acao: 'FALTA_REGISTADA', tabela: 'falta', registoId: rows[0].id });
  res.status(201).json(rows[0]);
});

router.patch('/:id/aprovar', autorizar(...RH), async (req, res) => {
  await query(`UPDATE falta SET estado='aprovado', aprovado_por=$1, justificada=true WHERE id=$2`,
    [req.utilizador.id, req.params.id]);
  res.json({ ok: true });
});

router.patch('/:id/justificar', async (req, res) => {
  const { justificacao } = req.body;
  await query('UPDATE falta SET justificada=true, descricao=COALESCE($1, descricao) WHERE id=$2', [justificacao||null, req.params.id]);
  res.json({ mensagem: 'Falta justificada.' });
});

router.patch('/:id/rejeitar', autorizar(...RH), async (req, res) => {
  await query(`UPDATE falta SET estado='rejeitado', aprovado_por=$1 WHERE id=$2`,
    [req.utilizador.id, req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
