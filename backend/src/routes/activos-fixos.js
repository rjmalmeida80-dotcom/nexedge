'use strict';
/**
 * NexEdge — Activos Fixos & Depreciações
 * Gestão completa do imobilizado, depreciação automática, mapa de activos
 * Supera: Sage Fixed Assets, PHC CS Imobilizado
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { autenticar } = require('../middleware/auth');

router.use(autenticar);

const METODOS_DEPREC = {
  linear: 'Quotas Constantes (Linear)',
  degressive: 'Quotas Decrescentes',
  sum_of_years: 'Soma dos Dígitos dos Anos',
  units: 'Unidades de Produção',
};

// ── ACTIVOS ──

router.get('/', async (req, res) => {
  try {
    const { categoria, estado } = req.query;
    const conds = ['a.empresa_id=$1'], params = [req.empresaId];
    let n = 2;
    if (categoria) { conds.push(`a.categoria=$${n++}`); params.push(categoria); }
    if (estado) { conds.push(`a.estado=$${n++}`); params.push(estado); }

    const r = await query(`
      SELECT a.*,
        ROUND(a.valor_aquisicao * (1 - COALESCE(a.taxa_depreciacao,0)/100 *
          EXTRACT(YEAR FROM AGE(NOW(), a.data_aquisicao))), 2) as valor_liquido_calculado,
        ROUND(a.valor_aquisicao * COALESCE(a.taxa_depreciacao,0)/100, 2) as depreciacao_anual
      FROM activo_fixo a
      WHERE ${conds.join(' AND ')}
      ORDER BY a.categoria, a.nome
    `, params).catch(()=>({rows:[]}));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const d = req.body;
    if (!d.nome || !d.valor_aquisicao) return res.status(400).json({ error: 'Nome e valor obrigatórios' });

    // Calcular taxa de depreciação por vida útil
    const taxa = d.vida_util_anos ? (100 / d.vida_util_anos) : (d.taxa_depreciacao || 20);
    const valorResidual = d.valor_residual || (d.valor_aquisicao * 0.1);

    const r = await query(`
      INSERT INTO activo_fixo (empresa_id, nome, descricao, categoria, fornecedor_id,
        numero_serie, data_aquisicao, valor_aquisicao, valor_residual, vida_util_anos,
        taxa_depreciacao, metodo_depreciacao, localizacao, responsavel_id, estado, cod_contabilistico)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'activo',$15) RETURNING *
    `, [req.empresaId, d.nome, d.descricao||'', d.categoria||'equipamento',
        d.fornecedor_id||null, d.numero_serie||null,
        d.data_aquisicao||new Date().toISOString().slice(0,10),
        d.valor_aquisicao, valorResidual, d.vida_util_anos||5,
        taxa, d.metodo_depreciacao||'linear',
        d.localizacao||'', d.responsavel_id||null, d.cod_contabilistico||'432']);

    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CÁLCULO DE DEPRECIAÇÃO ──

router.get('/:id/depreciacao', async (req, res) => {
  try {
    const r = await query(`SELECT * FROM activo_fixo WHERE id=$1 AND empresa_id=$2`, [req.params.id, req.empresaId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Activo não encontrado' });
    const a = r.rows[0];

    const dataAquisicao = new Date(a.data_aquisicao);
    const vidaUtil = a.vida_util_anos || 5;
    const valorDepreciavel = parseFloat(a.valor_aquisicao) - parseFloat(a.valor_residual||0);
    const plano = [];

    for (let ano = 1; ano <= vidaUtil; ano++) {
      let depreciacao = 0;
      let valorLiquido = 0;
      const dataAno = new Date(dataAquisicao);
      dataAno.setFullYear(dataAno.getFullYear() + ano);

      if (a.metodo_depreciacao === 'linear') {
        depreciacao = valorDepreciavel / vidaUtil;
        valorLiquido = parseFloat(a.valor_aquisicao) - (depreciacao * ano);
      } else if (a.metodo_depreciacao === 'degressive') {
        const taxa = (2 / vidaUtil);
        const valorAnterior = ano === 1 ? parseFloat(a.valor_aquisicao) : plano[ano-2].valor_liquido;
        depreciacao = valorAnterior * taxa;
        valorLiquido = valorAnterior - depreciacao;
      } else if (a.metodo_depreciacao === 'sum_of_years') {
        const soma = (vidaUtil * (vidaUtil + 1)) / 2;
        depreciacao = valorDepreciavel * (vidaUtil - ano + 1) / soma;
        valorLiquido = parseFloat(a.valor_aquisicao) - plano.reduce((s,p)=>s+p.depreciacao,0) - depreciacao;
      }

      plano.push({
        ano,
        data: dataAno.getFullYear(),
        depreciacao: Math.max(0, Math.round(depreciacao * 100) / 100),
        depreciacao_acumulada: Math.round(Math.min(valorDepreciavel, plano.reduce((s,p)=>s+p.depreciacao,0)+depreciacao) * 100) / 100,
        valor_liquido: Math.max(parseFloat(a.valor_residual||0), Math.round(valorLiquido * 100) / 100),
        lancado: dataAno.getFullYear() < new Date().getFullYear(),
      });
    }

    res.json({
      activo: a,
      plano_depreciacao: plano,
      depreciacao_anual: Math.round(valorDepreciavel / vidaUtil * 100) / 100,
      depreciacao_mensal: Math.round(valorDepreciavel / vidaUtil / 12 * 100) / 100,
      valor_liquido_actual: plano[Math.min(new Date().getFullYear()-dataAquisicao.getFullYear(), vidaUtil)-1]?.valor_liquido || parseFloat(a.valor_aquisicao),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PROCESSAMENTO AUTOMÁTICO MENSAL ──

router.post('/processar-depreciacao', async (req, res) => {
  try {
    const { ano, mes } = req.body;
    const periodo = `${ano}-${mes?.toString().padStart(2,'0')||'01'}`;

    const activos = await query(`
      SELECT * FROM activo_fixo WHERE empresa_id=$1 AND estado='activo' AND taxa_depreciacao > 0
    `, [req.empresaId]);

    let processados = 0;
    for (const a of activos.rows) {
      const depMensal = (parseFloat(a.valor_aquisicao) - parseFloat(a.valor_residual||0)) / (a.vida_util_anos||5) / 12;
      await query(`
        INSERT INTO depreciacao_lancamento (empresa_id, activo_id, periodo, valor, metodo, estado)
        VALUES ($1,$2,$3,$4,$5,'lancado')
        ON CONFLICT (empresa_id, activo_id, periodo) DO NOTHING
      `, [req.empresaId, a.id, periodo, Math.round(depMensal*100)/100, a.metodo_depreciacao||'linear']).catch(()=>{});
      processados++;
    }

    res.json({ processados, periodo });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── MAPA DE ACTIVOS ──

router.get('/mapa', async (req, res) => {
  try {
    const [totais, porCategoria, depreciacaoAnual] = await Promise.all([
      query(`SELECT
        COUNT(*) as total_activos,
        SUM(valor_aquisicao) as valor_bruto_total,
        SUM(valor_aquisicao * (1 - taxa_depreciacao/100 * EXTRACT(YEAR FROM AGE(NOW(),data_aquisicao)))) as valor_liquido_total,
        SUM(valor_aquisicao * taxa_depreciacao/100) as depreciacao_anual_total
        FROM activo_fixo WHERE empresa_id=$1 AND estado='activo'`, [req.empresaId]),
      query(`SELECT categoria, COUNT(*) as total, SUM(valor_aquisicao) as valor_bruto,
        SUM(valor_aquisicao * taxa_depreciacao/100) as depreciacao_anual
        FROM activo_fixo WHERE empresa_id=$1 AND estado='activo'
        GROUP BY categoria ORDER BY valor_bruto DESC`, [req.empresaId]),
      query(`SELECT TO_CHAR(data_aquisicao,'YYYY') as ano, SUM(valor_aquisicao) as investimento
        FROM activo_fixo WHERE empresa_id=$1 GROUP BY ano ORDER BY ano DESC LIMIT 5`, [req.empresaId]),
    ]);

    res.json({
      totais: totais.rows[0],
      por_categoria: porCategoria.rows,
      investimento_por_ano: depreciacaoAnual.rows,
      metodos: METODOS_DEPREC,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', async (req, res) => {
  try {
    const d = req.body;
    const campos = ['nome','descricao','categoria','localizacao','estado','data_abate','motivo_abate'];
    const updates = [], params = [];
    let n = 1;
    for (const c of campos) { if(d[c]!==undefined){updates.push(`${c}=$${n++}`);params.push(d[c]);}}
    params.push(req.params.id);
    await query(`UPDATE activo_fixo SET ${updates.join(',')} WHERE id=$${n} AND empresa_id='${req.empresaId}'`, params);
    const r = await query(`SELECT * FROM activo_fixo WHERE id=$1`, [req.params.id]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
