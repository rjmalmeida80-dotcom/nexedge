'use strict';
const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { autenticar } = require('../middleware/auth');

router.use(autenticar);

// Análise de equidade salarial
router.get('/analise', async (req, res) => {
  try {
    const { departamento, cargo } = req.query;
    const conds = ['f.empresa_id=$1', 'f.estado=\'ativo\'', 'f.salario_base > 0'];
    const params = [req.empresaId];
    let p = 2;
    if (departamento) { conds.push(`f.departamento=$${p++}`); params.push(departamento); }
    if (cargo) { conds.push(`f.cargo=$${p++}`); params.push(cargo); }

    const [geral, porGenero, porDept, porCargo, outliers] = await Promise.all([
      // Estatísticas gerais
      query(`SELECT
        COUNT(*) as total,
        AVG(salario_base) as media,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY salario_base) as mediana,
        MIN(salario_base) as minimo,
        MAX(salario_base) as maximo,
        STDDEV(salario_base) as desvio_padrao
        FROM funcionario f WHERE ${conds.join(' AND ')}`, params),
      
      // Por género (usando campo genero se existir)
      query(`SELECT
        COALESCE(genero,'Não especificado') as genero,
        COUNT(*) as total,
        AVG(salario_base) as media,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY salario_base) as mediana,
        MIN(salario_base) as minimo,
        MAX(salario_base) as maximo
        FROM funcionario f WHERE ${conds.join(' AND ')}
        GROUP BY genero ORDER BY genero`, params).catch(() => ({ rows: [] })),
      
      // Por departamento
      query(`SELECT
        COALESCE(departamento,'Sem departamento') as departamento,
        COUNT(*) as total,
        AVG(salario_base) as media,
        MIN(salario_base) as minimo,
        MAX(salario_base) as maximo,
        MAX(salario_base)-MIN(salario_base) as amplitude
        FROM funcionario f WHERE ${conds.join(' AND ')}
        GROUP BY departamento ORDER BY media DESC`, params),
      
      // Por cargo
      query(`SELECT
        COALESCE(cargo,'Sem cargo') as cargo,
        COUNT(*) as total,
        AVG(salario_base) as media,
        MIN(salario_base) as minimo,
        MAX(salario_base) as maximo
        FROM funcionario f WHERE ${conds.join(' AND ')}
        GROUP BY cargo ORDER BY media DESC LIMIT 20`, params),
      
      // Outliers (salários muito acima ou abaixo da média)
      query(`WITH stats AS (
        SELECT AVG(salario_base) as media, STDDEV(salario_base) as std
        FROM funcionario f WHERE ${conds.join(' AND ')}
      )
      SELECT f.nome_completo, f.cargo, f.departamento, f.salario_base,
        ROUND(((f.salario_base - s.media) / NULLIF(s.std,0))::numeric, 2) as z_score,
        CASE WHEN f.salario_base > s.media + 2*s.std THEN 'acima'
             WHEN f.salario_base < s.media - 2*s.std THEN 'abaixo'
             ELSE 'normal' END as situacao
      FROM funcionario f, stats s
      WHERE ${conds.join(' AND ')}
        AND ABS((f.salario_base - s.media) / NULLIF(s.std,0)) > 1.5
      ORDER BY z_score DESC LIMIT 20`, params),
    ]);

    // Calcular gap de género
    const gData = porGenero.rows;
    const mediaM = gData.find(g => g.genero==='M')?.media || 0;
    const mediaF = gData.find(g => g.genero==='F')?.media || 0;
    const gapGenero = mediaM && mediaF ? ((mediaM - mediaF) / mediaM * 100).toFixed(1) : null;

    res.json({
      geral: geral.rows[0],
      por_genero: gData,
      gap_genero_pct: gapGenero,
      por_departamento: porDept.rows,
      por_cargo: porCargo.rows,
      outliers: outliers.rows,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Comparação de funcionário vs grupo
router.get('/funcionario/:id', async (req, res) => {
  try {
    const func = await query(`SELECT * FROM funcionario WHERE id=$1 AND empresa_id=$2`, [req.params.id, req.empresaId]);
    if (!func.rows.length) return res.status(404).json({ error: 'Não encontrado' });
    const f = func.rows[0];

    const grupo = await query(`SELECT
      AVG(salario_base) as media, MIN(salario_base) as minimo, MAX(salario_base) as maximo,
      PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY salario_base) as p25,
      PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY salario_base) as p75,
      COUNT(*) as total
      FROM funcionario WHERE empresa_id=$1 AND cargo=$2 AND estado='ativo' AND salario_base > 0`,
      [req.empresaId, f.cargo]);

    const g = grupo.rows[0];
    const posicao = g.media ? ((f.salario_base - g.minimo) / (g.maximo - g.minimo) * 100).toFixed(0) : 50;

    res.json({
      funcionario: f,
      grupo: g,
      posicao_percentil: parseInt(posicao),
      vs_media: g.media ? ((f.salario_base - g.media) / g.media * 100).toFixed(1) : 0,
      recomendacao: f.salario_base < g.p25 ? 'Abaixo do P25 — considerar revisão salarial' :
                    f.salario_base > g.p75 ? 'Acima do P75 — salário competitivo' :
                    'Na banda salarial normal para o cargo',
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Departamentos e cargos disponíveis
router.get('/filtros', async (req, res) => {
  try {
    const [depts, cargos] = await Promise.all([
      query(`SELECT DISTINCT departamento FROM funcionario WHERE empresa_id=$1 AND departamento IS NOT NULL ORDER BY departamento`, [req.empresaId]),
      query(`SELECT DISTINCT cargo FROM funcionario WHERE empresa_id=$1 AND cargo IS NOT NULL ORDER BY cargo`, [req.empresaId]),
    ]);
    res.json({ departamentos: depts.rows.map(r=>r.departamento), cargos: cargos.rows.map(r=>r.cargo) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
