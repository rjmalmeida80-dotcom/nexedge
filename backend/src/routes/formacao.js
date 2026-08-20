'use strict';
const router = require('express').Router();
const { autenticar, autorizar } = require('../middleware/auth');
const { middlewareAuditoria }   = require('../middleware/auditoria');
const { query } = require('../config/database');
const { criarErro } = require('../middleware/errorHandler');

const ADMIN = ['admin_empresa','admin_plataforma','rh','diretor'];
router.use(autenticar, middlewareAuditoria);

// Listar formações
router.get('/', async (req, res) => {
  const { rows } = await query(`
    SELECT f.*, COUNT(fp.funcionario_id) AS total_participantes,
           COUNT(CASE WHEN fp.concluido THEN 1 END) AS total_concluidos
    FROM formacao f
    LEFT JOIN formacao_participante fp ON fp.formacao_id = f.id
    WHERE f.empresa_id=$1
    GROUP BY f.id
    ORDER BY f.data_inicio DESC NULLS LAST, f.criado_em DESC
  `, [req.empresaId]);
  res.json(rows);
});

// Criar formação
router.post('/', autorizar(...ADMIN), async (req, res) => {
  const { nome, entidade, tipo, area, horas, data_inicio, data_fim, local, custo, descricao } = req.body;
  if (!nome || !horas) throw criarErro('Nome e horas são obrigatórios.', 400);
  const { rows } = await query(`
    INSERT INTO formacao (empresa_id, nome, entidade, tipo, area, horas, data_inicio, data_fim, local, custo, descricao)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *
  `, [req.empresaId, nome, entidade||null, tipo||'interna', area||null, horas, data_inicio||null, data_fim||null, local||null, custo||0, descricao||null]);
  res.status(201).json(rows[0]);
});

// Participantes de uma formação
router.get('/:id/participantes', async (req, res) => {
  const { rows } = await query(`
    SELECT fp.*, f.nome_completo, f.cargo, d.nome AS departamento
    FROM formacao_participante fp
    JOIN funcionario f ON f.id = fp.funcionario_id
    LEFT JOIN departamento d ON d.id = f.departamento_id
    WHERE fp.formacao_id=$1
    ORDER BY f.nome_completo
  `, [req.params.id]);
  res.json(rows);
});

// Adicionar participante
router.post('/:id/participantes', autorizar(...ADMIN), async (req, res) => {
  const { funcionario_id } = req.body;
  await query(`
    INSERT INTO formacao_participante (formacao_id, funcionario_id)
    VALUES ($1,$2) ON CONFLICT DO NOTHING
  `, [req.params.id, funcionario_id]);
  res.json({ mensagem: 'Participante adicionado.' });
});

// Marcar como concluído
router.patch('/:id/participantes/:fid/concluir', autorizar(...ADMIN), async (req, res) => {
  const { nota } = req.body;
  await query(`
    UPDATE formacao_participante SET concluido=true, estado='concluido', nota=$1
    WHERE formacao_id=$2 AND funcionario_id=$3
  `, [nota||null, req.params.id, req.params.fid]);
  res.json({ mensagem: 'Marcado como concluído.' });
});

// Horas de formação por funcionário no ano
router.get('/horas-por-funcionario', async (req, res) => {
  const { ano } = req.query;
  const anoNum = parseInt(ano) || new Date().getFullYear();
  const { rows } = await query(`
    SELECT fu.id, fu.nome_completo, fu.cargo, fu.formacao_horas_ano AS horas_obrigatorias,
           COALESCE(SUM(CASE WHEN fp.concluido THEN fo.horas ELSE 0 END), 0) AS horas_feitas,
           fu.formacao_horas_ano - COALESCE(SUM(CASE WHEN fp.concluido THEN fo.horas ELSE 0 END), 0) AS horas_em_falta
    FROM funcionario fu
    LEFT JOIN formacao_participante fp ON fp.funcionario_id = fu.id
    LEFT JOIN formacao fo ON fo.id = fp.formacao_id
      AND (fo.data_fim IS NULL OR EXTRACT(YEAR FROM fo.data_fim)=$1)
    WHERE fu.empresa_id=$2 AND fu.estado='ativo'
    GROUP BY fu.id
    ORDER BY horas_em_falta DESC, fu.nome_completo
  `, [anoNum, req.empresaId]);
  res.json(rows);
});

// PUT /formacao/:id — actualizar
router.put('/:id', autorizar(...ADMIN), async (req, res) => {
  const { nome, entidade, tipo, area, horas, data_inicio, data_fim, local, custo, descricao } = req.body;
  const { rows } = await query(`
    UPDATE formacao SET nome=$1, entidade=$2, tipo=$3, area=$4, horas=$5,
      data_inicio=$6, data_fim=$7, local=$8, custo=$9, descricao=$10
    WHERE id=$11 AND empresa_id=$12 RETURNING *
  `, [nome, entidade||null, tipo||'interna', area||null, horas, data_inicio||null, data_fim||null, local||null, custo||0, descricao||null, req.params.id, req.empresaId]);
  if (!rows.length) throw criarErro('Formação não encontrada.', 404);
  res.json(rows[0]);
});

// DELETE /formacao/:id — apagar
router.delete('/:id', autorizar(...ADMIN), async (req, res) => {
  await query('DELETE FROM formacao WHERE id=$1 AND empresa_id=$2', [req.params.id, req.empresaId]);
  res.json({ mensagem: 'Formação eliminada.' });
});

// DELETE /formacao/:id/participantes/:fid — remover participante
router.delete('/:id/participantes/:fid', autorizar(...ADMIN), async (req, res) => {
  await query('DELETE FROM formacao_participante WHERE formacao_id=$1 AND funcionario_id=$2', [req.params.id, req.params.fid]);
  res.json({ mensagem: 'Participante removido.' });
});

module.exports = router;
