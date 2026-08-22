'use strict';
/**
 * NexEdge — Centros de Custo & Análise de Rentabilidade
 * Imputação de custos, P&L por centro, análise de margens
 * Supera: SAP CO, Oracle Financials
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { autenticar } = require('../middleware/auth');

router.use(autenticar);

// ── CENTROS DE CUSTO ──

router.get('/', async (req, res) => {
  try {
    const r = await query(`
      SELECT cc.*,
        COALESCE((SELECT SUM(valor_total) FROM despesa WHERE centro_custo_id=cc.id AND data_despesa > NOW()-INTERVAL '30 days'),0) as custo_30d,
        COALESCE((SELECT SUM(total) FROM fatura WHERE centro_custo_id=cc.id AND data_emissao > NOW()-INTERVAL '30 days'),0) as receita_30d
      FROM centro_custo cc
      WHERE cc.empresa_id=$1 AND cc.ativo=true
      ORDER BY cc.codigo
    `, [req.empresaId]).catch(()=>({rows:[]}));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const { codigo, nome, descricao, responsavel_id, orcamento_anual, cc_pai_id } = req.body;
    const r = await query(`
      INSERT INTO centro_custo (empresa_id, codigo, nome, descricao, responsavel_id, orcamento_anual, cc_pai_id, ativo)
      VALUES ($1,$2,$3,$4,$5,$6,$7,true) RETURNING *
    `, [req.empresaId, codigo, nome, descricao||'', responsavel_id||null, orcamento_anual||0, cc_pai_id||null]);
    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── P&L POR CENTRO DE CUSTO ──

router.get('/:id/pl', async (req, res) => {
  try {
    const { ano, mes } = req.query;
    let whereData = '';
    const params = [req.params.id, req.empresaId];

    if (mes && ano) { whereData = `AND TO_CHAR(data_emissao,'YYYY-MM')='${ano}-${mes.padStart(2,'0')}'`; }
    else if (ano) { whereData = `AND EXTRACT(YEAR FROM data_emissao)=${ano}`; }

    const [receitas, custos, orcamento] = await Promise.all([
      query(`SELECT SUM(total) as total, COUNT(*) as num FROM fatura
        WHERE centro_custo_id=$1 AND empresa_id=$2 ${whereData.replace('data_emissao','data_emissao')} AND estado IN ('emitida','paga')`, params),
      query(`SELECT categoria, SUM(valor_total) as total, COUNT(*) as num FROM despesa
        WHERE centro_custo_id=$1 AND empresa_id=$2 ${whereData.replace('data_emissao','data_despesa')} AND estado='aprovada'
        GROUP BY categoria ORDER BY total DESC`, params),
      query(`SELECT orcamento_anual FROM centro_custo WHERE id=$1 AND empresa_id=$2`, params),
    ]);

    const totalReceitas = parseFloat(receitas.rows[0]?.total||0);
    const totalCustos = custos.rows.reduce((s,r) => s + parseFloat(r.total||0), 0);
    const margem = totalReceitas - totalCustos;
    const orcAnual = parseFloat(orcamento.rows[0]?.orcamento_anual||0);

    res.json({
      centro_custo_id: req.params.id,
      periodo: mes ? `${mes}/${ano}` : ano || 'Total',
      receitas: { total: totalReceitas, num_faturas: parseInt(receitas.rows[0]?.num||0) },
      custos: { total: totalCustos, por_categoria: custos.rows },
      margem,
      margem_pct: totalReceitas ? (margem/totalReceitas*100).toFixed(1) : 0,
      orcamento_anual: orcAnual,
      execucao_orcamental: orcAnual ? (totalCustos/orcAnual*100).toFixed(1) : null,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DASHBOARD CONSOLIDADO ──

router.get('/dashboard', async (req, res) => {
  try {
    const { ano } = req.query;
    const anoActual = ano || new Date().getFullYear();

    const r = await query(`
      SELECT cc.codigo, cc.nome,
        COALESCE((SELECT SUM(total) FROM fatura WHERE centro_custo_id=cc.id AND EXTRACT(YEAR FROM data_emissao)=$2 AND estado IN ('emitida','paga')),0) as receitas,
        COALESCE((SELECT SUM(valor_total) FROM despesa WHERE centro_custo_id=cc.id AND EXTRACT(YEAR FROM data_despesa)=$2 AND estado='aprovada'),0) as custos,
        cc.orcamento_anual
      FROM centro_custo cc
      WHERE cc.empresa_id=$1 AND cc.ativo=true
      ORDER BY cc.codigo
    `, [req.empresaId, anoActual]).catch(()=>({rows:[]}));

    const dados = r.rows.map(cc => ({
      ...cc,
      margem: parseFloat(cc.receitas||0) - parseFloat(cc.custos||0),
      execucao: cc.orcamento_anual ? (parseFloat(cc.custos||0)/cc.orcamento_anual*100).toFixed(1) : null,
    }));

    res.json({
      ano: anoActual,
      centros: dados,
      totais: {
        receitas: dados.reduce((s,c)=>s+parseFloat(c.receitas||0),0),
        custos: dados.reduce((s,c)=>s+parseFloat(c.custos||0),0),
        margem: dados.reduce((s,c)=>s+c.margem,0),
        orcamento: dados.reduce((s,c)=>s+parseFloat(c.orcamento_anual||0),0),
      }
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
