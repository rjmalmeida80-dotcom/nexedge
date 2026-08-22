'use strict';
/**
 * NexEdge — Orçamentos & Revisões Orçamentais
 * Planeamento financeiro, previsão vs real, alertas de desvio
 * Supera: QuickBooks Budgets, Sage Planning
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { autenticar } = require('../middleware/auth');

router.use(autenticar);

router.get('/', async (req, res) => {
  try {
    const r = await query(`
      SELECT o.*,
        (SELECT SUM(ol.valor) FROM orcamento_linha ol WHERE ol.orcamento_id=o.id AND ol.tipo='receita') as total_receita,
        (SELECT SUM(ol.valor) FROM orcamento_linha ol WHERE ol.orcamento_id=o.id AND ol.tipo='custo') as total_custo
      FROM orcamento o WHERE o.empresa_id=$1 ORDER BY o.ano DESC, o.versao DESC
    `, [req.empresaId]).catch(()=>({rows:[]}));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const { nome, ano, tipo, linhas } = req.body;
    const versao = await query(`SELECT COALESCE(MAX(versao),0)+1 as v FROM orcamento WHERE empresa_id=$1 AND ano=$2`, [req.empresaId, ano]);

    const r = await query(`
      INSERT INTO orcamento (empresa_id, nome, ano, versao, tipo, estado)
      VALUES ($1,$2,$3,$4,$5,'rascunho') RETURNING *
    `, [req.empresaId, nome||`Orçamento ${ano}`, ano, versao.rows[0].v, tipo||'anual']);

    const orc = r.rows[0];

    // Criar linhas orçamentais
    if (linhas?.length) {
      for (const l of linhas) {
        await query(`INSERT INTO orcamento_linha (orcamento_id, empresa_id, categoria, descricao, tipo, centro_custo_id, valor, jan,fev,mar,abr,mai,jun,jul,ago,set,out,nov,dez)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
          [orc.id, req.empresaId, l.categoria, l.descricao, l.tipo||'custo', l.centro_custo_id||null, l.valor||0,
           l.jan||0,l.fev||0,l.mar||0,l.abr||0,l.mai||0,l.jun||0,l.jul||0,l.ago||0,l.set||0,l.out||0,l.nov||0,l.dez||0]);
      }
    }

    res.status(201).json(orc);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Análise previsão vs real
router.get('/:id/analise', async (req, res) => {
  try {
    const [orc, linhas, real] = await Promise.all([
      query(`SELECT * FROM orcamento WHERE id=$1 AND empresa_id=$2`, [req.params.id, req.empresaId]),
      query(`SELECT * FROM orcamento_linha WHERE orcamento_id=$1`, [req.params.id]),
      query(`SELECT
        TO_CHAR(data_emissao,'MM') as mes, SUM(total) as receita
        FROM fatura WHERE empresa_id=$1 AND EXTRACT(YEAR FROM data_emissao)=(SELECT ano FROM orcamento WHERE id=$2)
        AND estado IN ('emitida','paga') GROUP BY mes`, [req.empresaId, req.params.id]),
    ]);

    if (!orc.rows.length) return res.status(404).json({ error: 'Orçamento não encontrado' });

    const meses = ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
    const receitaReal = {};
    real.rows.forEach(r => receitaReal[r.mes] = parseFloat(r.receita||0));

    const analise = meses.map((mes, i) => {
      const receitaOrc = linhas.rows.filter(l=>l.tipo==='receita').reduce((s,l)=>s+parseFloat(l[mes]||0),0);
      const custoOrc = linhas.rows.filter(l=>l.tipo==='custo').reduce((s,l)=>s+parseFloat(l[mes]||0),0);
      const receitaR = receitaReal[(i+1).toString().padStart(2,'0')] || 0;

      return {
        mes: mes.toUpperCase(),
        num: i+1,
        receita_orcada: receitaOrc,
        custo_orcado: custoOrc,
        resultado_orcado: receitaOrc - custoOrc,
        receita_real: receitaR,
        desvio_receita: receitaR - receitaOrc,
        desvio_pct: receitaOrc ? ((receitaR - receitaOrc)/receitaOrc*100).toFixed(1) : 0,
      };
    });

    res.json({ orcamento: orc.rows[0], linhas: linhas.rows, analise,
      totais: {
        receita_orcada: analise.reduce((s,m)=>s+m.receita_orcada,0),
        custo_orcado: analise.reduce((s,m)=>s+m.custo_orcado,0),
        receita_real: analise.reduce((s,m)=>s+m.receita_real,0),
      }
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
