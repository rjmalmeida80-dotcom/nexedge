'use strict';
const router = require('express').Router();
const { autenticar, autorizar } = require('../middleware/auth');
const { middlewareAuditoria }   = require('../middleware/auditoria');
const { query } = require('../config/database');
const { criarErro } = require('../middleware/errorHandler');

const ADMIN = ['admin_empresa','admin_plataforma','rh','diretor'];
router.use(autenticar, middlewareAuditoria);

// ── FERIADOS ──────────────────────────────────────────────────────────────
router.get('/feriados', async (req, res) => {
  const { ano } = req.query;
  const { rows } = await query(`
    SELECT * FROM feriado
    WHERE (empresa_id=$1 OR empresa_id IS NULL) AND ativo=true
    ${ano ? `AND EXTRACT(YEAR FROM data)=${parseInt(ano)}` : ''}
    ORDER BY data ASC
  `, [req.empresaId]);
  res.json(rows);
});

router.post('/feriados', autorizar(...ADMIN), async (req, res) => {
  const { nome, data, tipo, recorrente } = req.body;
  if (!nome || !data) throw criarErro('Nome e data são obrigatórios.', 400);
  const { rows } = await query(`
    INSERT INTO feriado (empresa_id, nome, data, tipo, recorrente)
    VALUES ($1,$2,$3,$4,$5) RETURNING *
  `, [req.empresaId, nome, data, tipo||'empresa', recorrente!==false]);
  res.status(201).json(rows[0]);
});

router.delete('/feriados/:id', autorizar(...ADMIN), async (req, res) => {
  await query('UPDATE feriado SET ativo=false WHERE id=$1 AND empresa_id=$2', [req.params.id, req.empresaId]);
  res.json({ mensagem: 'Feriado removido.' });
});

// ── POLÍTICA DA EMPRESA ───────────────────────────────────────────────────
router.get('/politica', async (req, res) => {
  const { rows: [emp] } = await query(`
    SELECT dia_aniversario, aniversario_transfere_fds, tolerancia_ponto_aniversario,
           dias_natal, dias_pascoa, dias_carnaval, email_aniversario
    FROM empresa WHERE id=$1
  `, [req.empresaId]);
  res.json(emp || {});
});

router.put('/politica', autorizar(...ADMIN), async (req, res) => {
  const { dia_aniversario, aniversario_transfere_fds, tolerancia_ponto_aniversario,
          dias_natal, dias_pascoa, dias_carnaval, email_aniversario } = req.body;
  await query(`
    UPDATE empresa SET
      dia_aniversario=$1, aniversario_transfere_fds=$2, tolerancia_ponto_aniversario=$3,
      dias_natal=$4, dias_pascoa=$5, dias_carnaval=$6, email_aniversario=$7
    WHERE id=$8
  `, [dia_aniversario||false, aniversario_transfere_fds!==false, tolerancia_ponto_aniversario||0,
      dias_natal||0, dias_pascoa||0, dias_carnaval||0, email_aniversario!==false, req.empresaId]);
  res.json({ mensagem: 'Política actualizada.' });
});

// ── ANIVERSÁRIOS DO MÊS ────────────────────────────────────────────────────
router.get('/aniversarios', async (req, res) => {
  const { mes } = req.query;
  const mesNum = parseInt(mes) || new Date().getMonth() + 1;
  const { rows } = await query(`
    SELECT f.id, f.nome_completo, f.cargo, f.data_nascimento, f.email_empresa,
           d.nome AS departamento,
           EXTRACT(DAY FROM f.data_nascimento) AS dia,
           DATE_PART('year', AGE(f.data_nascimento)) AS idade
    FROM funcionario f
    LEFT JOIN departamento d ON d.id = f.departamento_id
    WHERE f.empresa_id=$1 AND f.estado='ativo'
      AND f.data_nascimento IS NOT NULL
      AND EXTRACT(MONTH FROM f.data_nascimento)=$2
    ORDER BY EXTRACT(DAY FROM f.data_nascimento)
  `, [req.empresaId, mesNum]);
  res.json(rows);
});

// ── MAPA DE FÉRIAS (calendário visual) ────────────────────────────────────
router.get('/mapa-ferias', async (req, res) => {
  const { ano } = req.query;
  const anoNum = parseInt(ano) || new Date().getFullYear();
  const { rows } = await query(`
    SELECT pf.id AS ferias_id, pf.data_inicio, pf.data_fim, pf.estado, pf.num_dias,
           fu.nome_completo, fu.cargo,
           d.nome AS departamento
    FROM pedido_ferias pf
    JOIN funcionario fu ON fu.id = pf.funcionario_id
    LEFT JOIN departamento d ON d.id = fu.departamento_id
    WHERE fu.empresa_id=$1
      AND (EXTRACT(YEAR FROM pf.data_inicio)=$2 OR EXTRACT(YEAR FROM pf.data_fim)=$2)
      AND pf.estado IN ('aprovado','pendente')
    ORDER BY pf.data_inicio
  `, [req.empresaId, anoNum]);
  res.json(rows);
});

module.exports = router;
