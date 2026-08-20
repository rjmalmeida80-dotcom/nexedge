'use strict';
const router = require('express').Router();
const { autenticar, autorizar } = require('../middleware/auth');
const { middlewareAuditoria }   = require('../middleware/auditoria');
const { query } = require('../config/database');
const { criarErro } = require('../middleware/errorHandler');

const ADMIN = ['admin_empresa','admin_plataforma','rh'];
router.use(autenticar, middlewareAuditoria);

// ── MEDICINA DO TRABALHO ──────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const { funcionario_id } = req.query;
  let sql = `
    SELECT m.*, f.nome_completo, f.cargo
    FROM medicina_trabalho m
    JOIN funcionario f ON f.id = m.funcionario_id
    WHERE m.empresa_id=$1
  `;
  const params = [req.empresaId];
  if (funcionario_id) { sql += ' AND m.funcionario_id=$2'; params.push(funcionario_id); }
  sql += ' ORDER BY m.data_exame DESC';
  const { rows } = await query(sql, params);
  res.json(rows);
});

router.post('/', autorizar(...ADMIN), async (req, res) => {
  const { funcionario_id, tipo, data_exame, data_validade, resultado, medico, clinica, restricoes, notas } = req.body;
  if (!funcionario_id || !tipo || !data_exame) throw criarErro('Funcionário, tipo e data são obrigatórios.', 400);
  const { rows } = await query(`
    INSERT INTO medicina_trabalho (empresa_id, funcionario_id, tipo, data_exame, data_validade, resultado, medico, clinica, restricoes, notas)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
  `, [req.empresaId, funcionario_id, tipo, data_exame, data_validade||null, resultado||'apto', medico||null, clinica||null, restricoes||null, notas||null]);
  await req.auditar({ acao: 'MEDICINA_REGISTADA', tabela: 'medicina_trabalho', registoId: rows[0].id });
  res.status(201).json(rows[0]);
});

// Exames a expirar (próximos 60 dias)
router.get('/a-expirar', async (req, res) => {
  const { rows } = await query(`
    SELECT m.*, f.nome_completo, f.cargo, f.email_empresa
    FROM medicina_trabalho m
    JOIN funcionario f ON f.id = m.funcionario_id
    WHERE m.empresa_id=$1 AND m.data_validade IS NOT NULL
      AND m.data_validade BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '60 days'
    ORDER BY m.data_validade ASC
  `, [req.empresaId]);
  res.json(rows);
});

// ── ACIDENTES DE TRABALHO ─────────────────────────────────────────────────
router.get('/acidentes', async (req, res) => {
  const { rows } = await query(`
    SELECT a.*, f.nome_completo, f.cargo
    FROM acidente_trabalho a
    JOIN funcionario f ON f.id = a.funcionario_id
    WHERE a.empresa_id=$1
    ORDER BY a.data_acidente DESC
  `, [req.empresaId]);
  res.json(rows);
});

router.post('/acidentes', autorizar(...ADMIN), async (req, res) => {
  const { funcionario_id, data_acidente, local, descricao, gravidade, dias_baixa, participado_act, data_participacao, num_participacao, notas } = req.body;
  if (!funcionario_id || !data_acidente || !descricao) throw criarErro('Funcionário, data e descrição são obrigatórios.', 400);
  const { rows } = await query(`
    INSERT INTO acidente_trabalho (empresa_id, funcionario_id, data_acidente, local, descricao, gravidade, dias_baixa, participado_act, data_participacao, num_participacao, notas)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *
  `, [req.empresaId, funcionario_id, data_acidente, local||null, descricao, gravidade||'ligeiro', dias_baixa||0, participado_act||false, data_participacao||null, num_participacao||null, notas||null]);
  await req.auditar({ acao: 'ACIDENTE_REGISTADO', tabela: 'acidente_trabalho', registoId: rows[0].id });
  res.status(201).json(rows[0]);
});

// ── LICENÇAS ESPECIAIS ────────────────────────────────────────────────────
router.get('/licencas', async (req, res) => {
  const { rows } = await query(`
    SELECT l.*, f.nome_completo, f.cargo
    FROM licenca_especial l
    JOIN funcionario f ON f.id = l.funcionario_id
    WHERE l.empresa_id=$1
    ORDER BY l.data_inicio DESC
  `, [req.empresaId]);
  res.json(rows);
});

router.post('/licencas', autorizar(...ADMIN), async (req, res) => {
  const { funcionario_id, tipo, data_inicio, data_fim, dias_uteis, motivo } = req.body;
  if (!funcionario_id || !tipo || !data_inicio || !data_fim) throw criarErro('Campos obrigatórios em falta.', 400);
  const { rows } = await query(`
    INSERT INTO licenca_especial (empresa_id, funcionario_id, tipo, data_inicio, data_fim, dias_uteis, motivo, criado_por)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
  `, [req.empresaId, funcionario_id, tipo, data_inicio, data_fim, dias_uteis||1, motivo||null, req.utilizador.id]);
  res.status(201).json(rows[0]);
});

// ── BANCO DE HORAS ────────────────────────────────────────────────────────
router.get('/banco-horas', async (req, res) => {
  const { funcionario_id } = req.query;
  let sql = `
    SELECT b.*, f.nome_completo, f.cargo
    FROM banco_horas b
    JOIN funcionario f ON f.id = b.funcionario_id
    WHERE b.empresa_id=$1
  `;
  const params = [req.empresaId];
  if (funcionario_id) { sql += ' AND b.funcionario_id=$2'; params.push(funcionario_id); }
  sql += ' ORDER BY b.data DESC';
  const { rows } = await query(sql, params);
  res.json(rows);
});

router.get('/banco-horas/saldo', async (req, res) => {
  const { rows } = await query(`
    SELECT f.id, f.nome_completo, f.cargo,
           COALESCE(SUM(CASE WHEN b.tipo='credito' AND b.aprovado THEN b.horas ELSE 0 END), 0) AS horas_credito,
           COALESCE(SUM(CASE WHEN b.tipo='debito' AND b.aprovado THEN b.horas ELSE 0 END), 0) AS horas_debito,
           COALESCE(SUM(CASE WHEN b.tipo='credito' AND b.aprovado THEN b.horas ELSE 0 END), 0) -
           COALESCE(SUM(CASE WHEN b.tipo='debito' AND b.aprovado THEN b.horas ELSE 0 END), 0) AS saldo
    FROM funcionario f
    LEFT JOIN banco_horas b ON b.funcionario_id = f.id AND b.empresa_id = f.empresa_id
    WHERE f.empresa_id=$1 AND f.estado='ativo'
    GROUP BY f.id
    ORDER BY saldo DESC, f.nome_completo
  `, [req.empresaId]);
  res.json(rows);
});

router.post('/banco-horas', autorizar(...ADMIN), async (req, res) => {
  const { funcionario_id, data, horas, tipo, descricao } = req.body;
  if (!funcionario_id || !horas || !tipo) throw criarErro('Campos obrigatórios em falta.', 400);
  const { rows } = await query(`
    INSERT INTO banco_horas (empresa_id, funcionario_id, data, horas, tipo, descricao, aprovado, aprovado_por)
    VALUES ($1,$2,$3,$4,$5,$6,true,$7) RETURNING *
  `, [req.empresaId, funcionario_id, data||new Date(), horas, tipo, descricao||null, req.utilizador.id]);
  res.status(201).json(rows[0]);
});

// DELETE medicina/:id
router.delete('/:id', autorizar(...ADMIN), async (req, res) => {
  await query('DELETE FROM medicina_trabalho WHERE id=$1 AND empresa_id=$2', [req.params.id, req.empresaId]);
  res.json({ mensagem: 'Exame eliminado.' });
});

// DELETE acidentes/:id
router.delete('/acidentes/:id', autorizar(...ADMIN), async (req, res) => {
  await query('DELETE FROM acidente_trabalho WHERE id=$1 AND empresa_id=$2', [req.params.id, req.empresaId]);
  res.json({ mensagem: 'Registo eliminado.' });
});

// DELETE licencas/:id
router.delete('/licencas/:id', autorizar(...ADMIN), async (req, res) => {
  await query('DELETE FROM licenca_especial WHERE id=$1 AND empresa_id=$2', [req.params.id, req.empresaId]);
  res.json({ mensagem: 'Licença eliminada.' });
});

// DELETE banco-horas/:id
router.delete('/banco-horas/:id', autorizar(...ADMIN), async (req, res) => {
  await query('DELETE FROM banco_horas WHERE id=$1 AND empresa_id=$2', [req.params.id, req.empresaId]);
  res.json({ mensagem: 'Registo eliminado.' });
});

module.exports = router;
