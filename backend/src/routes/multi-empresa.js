'use strict';
/**
 * NexEdge — Multi-Empresa Avançado
 * Consolidação de contas, relatórios grupo, transferências inter-empresa
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { autenticar } = require('../middleware/auth');

router.use(autenticar);

// Só admins de plataforma ou admin_empresa com multi-empresa
const verificarMultiEmpresa = (req, res, next) => {
  if (!['superadmin','admin_plataforma','admin_empresa'].includes(req.utilizador?.perfil)) {
    return res.status(403).json({ error: 'Sem permissão' });
  }
  next();
};
router.use(verificarMultiEmpresa);

// ── GRUPO DE EMPRESAS ──

router.get('/grupo', async (req, res) => {
  try {
    // Encontrar empresas do mesmo grupo (empresa_mae_id)
    const r = await query(`
      SELECT e.*,
        (SELECT COUNT(*) FROM utilizador WHERE empresa_id=e.id AND ativo=true) as num_utilizadores,
        (SELECT COUNT(*) FROM funcionario WHERE empresa_id=e.id AND estado='ativo') as num_funcionarios,
        (SELECT COALESCE(SUM(total),0) FROM fatura WHERE empresa_id=e.id AND estado='paga' AND data_emissao > NOW()-INTERVAL '30 days') as receita_30d
      FROM empresa e
      WHERE e.empresa_mae_id=$1 OR e.id=$1
      ORDER BY e.nome
    `, [req.empresaId]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CONSOLIDAÇÃO FINANCEIRA ──

router.get('/consolidado', async (req, res) => {
  try {
    const { ano, mes } = req.query;
    const periodo = mes ? `${ano}-${mes.padStart(2,'0')}` : ano;

    const r = await query(`
      SELECT
        e.nome as empresa,
        e.id as empresa_id,
        COALESCE(SUM(f.total) FILTER (WHERE f.estado IN ('emitida','paga')), 0) as total_faturado,
        COALESCE(SUM(f.total) FILTER (WHERE f.estado='paga'), 0) as total_recebido,
        COALESCE(SUM(d.valor_total) FILTER (WHERE d.estado='aprovada'), 0) as total_despesas,
        COALESCE(SUM(f.total) FILTER (WHERE f.estado IN ('emitida','paga')), 0) -
        COALESCE(SUM(d.valor_total) FILTER (WHERE d.estado='aprovada'), 0) as resultado,
        COUNT(DISTINCT func.id) FILTER (WHERE func.estado='ativo') as funcionarios_ativos
      FROM empresa e
      LEFT JOIN fatura f ON f.empresa_id=e.id
        AND (mes IS NULL OR TO_CHAR(f.data_emissao,'YYYY-MM')=$1)
      LEFT JOIN despesa d ON d.empresa_id=e.id
        AND (mes IS NULL OR TO_CHAR(d.data_despesa,'YYYY-MM')=$1)
      LEFT JOIN funcionario func ON func.empresa_id=e.id
      WHERE e.empresa_mae_id=$2 OR e.id=$2
      GROUP BY e.id, e.nome
      ORDER BY total_faturado DESC
    `, [periodo, req.empresaId]).catch(() => ({ rows: [] }));

    const totais = r.rows.reduce((acc, row) => ({
      total_faturado: acc.total_faturado + parseFloat(row.total_faturado||0),
      total_recebido: acc.total_recebido + parseFloat(row.total_recebido||0),
      total_despesas: acc.total_despesas + parseFloat(row.total_despesas||0),
      resultado: acc.resultado + parseFloat(row.resultado||0),
      funcionarios_ativos: acc.funcionarios_ativos + parseInt(row.funcionarios_ativos||0),
    }), { total_faturado:0, total_recebido:0, total_despesas:0, resultado:0, funcionarios_ativos:0 });

    res.json({ empresas: r.rows, totais, periodo });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── KPIs GRUPO ──

router.get('/kpis', async (req, res) => {
  try {
    const r = await query(`
      SELECT
        COUNT(DISTINCT e.id) as num_empresas,
        COUNT(DISTINCT u.id) FILTER (WHERE u.ativo=true) as total_utilizadores,
        COUNT(DISTINCT f2.id) FILTER (WHERE f2.estado='ativo') as total_funcionarios,
        COALESCE(SUM(fat.total) FILTER (WHERE fat.estado IN ('emitida','paga') AND fat.data_emissao > NOW()-INTERVAL '30 days'), 0) as receita_30d,
        COALESCE(SUM(desp.valor_total) FILTER (WHERE desp.estado='aprovada' AND desp.data_despesa > NOW()-INTERVAL '30 days'), 0) as despesas_30d
      FROM empresa e
      LEFT JOIN utilizador u ON u.empresa_id=e.id
      LEFT JOIN funcionario f2 ON f2.empresa_id=e.id
      LEFT JOIN fatura fat ON fat.empresa_id=e.id
      LEFT JOIN despesa desp ON desp.empresa_id=e.id
      WHERE e.empresa_mae_id=$1 OR e.id=$1
    `, [req.empresaId]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── MUDAR CONTEXTO DE EMPRESA ──

router.post('/mudar-contexto/:empresaId', async (req, res) => {
  try {
    // Verificar que pertence ao grupo
    const r = await query(`
      SELECT id FROM empresa WHERE id=$1 AND (empresa_mae_id=$2 OR id=$2)
    `, [req.params.empresaId, req.empresaId]);
    if (!r.rows.length) return res.status(403).json({ error: 'Empresa não pertence ao grupo' });

    // Emitir token temporário para a empresa
    const jwt = require('jsonwebtoken');
    const tokenTemp = jwt.sign({
      sub: req.utilizador.id,
      perfil: req.utilizador.perfil,
      empresa: req.params.empresaId,
      empresa_original: req.empresaId,
      contexto_mudado: true,
    }, process.env.JWT_SECRET, { expiresIn: '4h' });

    res.json({ token: tokenTemp, empresa_id: req.params.empresaId });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
