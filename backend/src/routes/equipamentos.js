'use strict';
const router = require('express').Router();
const { autenticar, autorizar } = require('../middleware/auth');
const { query } = require('../config/database');
const { criarErro } = require('../middleware/errorHandler');

const ADMIN = ['admin_empresa', 'admin_plataforma', 'rh', 'diretor'];
router.use(autenticar);

// GET /equipamentos
router.get('/', async (req, res) => {
  const { estado, tipo, funcionario_id } = req.query;
  let where = 'e.empresa_id=$1';
  const params = [req.empresaId];
  let p = 2;
  if (estado) { where += ` AND e.estado=$${p++}`; params.push(estado); }
  if (tipo) { where += ` AND e.tipo=$${p++}`; params.push(tipo); }
  if (funcionario_id) { where += ` AND e.funcionario_id=$${p++}`; params.push(funcionario_id); }

  const { rows } = await query(`
    SELECT e.*, f.nome_completo AS funcionario_nome, f.cargo AS funcionario_cargo
    FROM equipamento e
    LEFT JOIN funcionario f ON f.id = e.funcionario_id
    WHERE ${where}
    ORDER BY e.tipo, e.nome
  `, params);
  res.json(rows);
});

// POST /equipamentos
router.post('/', autorizar(...ADMIN), async (req, res) => {
  const { tipo, nome, marca, modelo, numero_serie, numero_inventario, estado, data_aquisicao, valor_aquisicao, notas } = req.body;
  if (!tipo || !nome) throw criarErro('Tipo e nome são obrigatórios.', 400);
  const { rows } = await query(`
    INSERT INTO equipamento (empresa_id, tipo, nome, marca, modelo, numero_serie, numero_inventario, estado, data_aquisicao, valor_aquisicao, notas)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *
  `, [req.empresaId, tipo, nome, marca||null, modelo||null, numero_serie||null, numero_inventario||null, estado||'disponivel', data_aquisicao||null, valor_aquisicao||null, notas||null]);
  res.status(201).json(rows[0]);
});

// PUT /equipamentos/:id
router.put('/:id', autorizar(...ADMIN), async (req, res) => {
  const { tipo, nome, marca, modelo, numero_serie, numero_inventario, estado, data_aquisicao, valor_aquisicao, notas } = req.body;
  const { rows } = await query(`
    UPDATE equipamento SET tipo=$1, nome=$2, marca=$3, modelo=$4, numero_serie=$5,
      numero_inventario=$6, estado=$7, data_aquisicao=$8, valor_aquisicao=$9, notas=$10, atualizado_em=NOW()
    WHERE id=$11 AND empresa_id=$12 RETURNING *
  `, [tipo, nome, marca||null, modelo||null, numero_serie||null, numero_inventario||null, estado||'disponivel', data_aquisicao||null, valor_aquisicao||null, notas||null, req.params.id, req.empresaId]);
  if (!rows.length) throw criarErro('Equipamento não encontrado.', 404);
  res.json(rows[0]);
});

// PUT /equipamentos/:id/atribuir
router.put('/:id/atribuir', autorizar(...ADMIN), async (req, res) => {
  const { funcionario_id } = req.body;
  const { rows } = await query(`
    UPDATE equipamento SET funcionario_id=$1, estado='atribuido', data_atribuicao=NOW(), atualizado_em=NOW()
    WHERE id=$2 AND empresa_id=$3 RETURNING *
  `, [funcionario_id || null, req.params.id, req.empresaId]);
  if (!rows.length) throw criarErro('Equipamento não encontrado.', 404);
  res.json(rows[0]);
});

// PUT /equipamentos/:id/devolver
router.put('/:id/devolver', autorizar(...ADMIN), async (req, res) => {
  const { rows } = await query(`
    UPDATE equipamento SET funcionario_id=NULL, estado='disponivel', data_atribuicao=NULL, atualizado_em=NOW()
    WHERE id=$1 AND empresa_id=$2 RETURNING *
  `, [req.params.id, req.empresaId]);
  if (!rows.length) throw criarErro('Equipamento não encontrado.', 404);
  res.json(rows[0]);
});

// DELETE /equipamentos/:id
router.delete('/:id', autorizar(...ADMIN), async (req, res) => {
  await query('DELETE FROM equipamento WHERE id=$1 AND empresa_id=$2', [req.params.id, req.empresaId]);
  res.json({ mensagem: 'Equipamento eliminado.' });
});

// GET /equipamentos/funcionario/:id — equipamentos de um funcionário
router.get('/funcionario/:id', async (req, res) => {
  const { rows } = await query(`
    SELECT * FROM equipamento WHERE funcionario_id=$1 AND empresa_id=$2 ORDER BY tipo, nome
  `, [req.params.id, req.empresaId]);
  res.json(rows);
});

module.exports = router;
