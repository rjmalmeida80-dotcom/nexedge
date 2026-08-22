'use strict';
/**
 * NexEdge — Gestão de Competências & Skills Matrix
 * Mapa de competências da organização, gaps, planos de desenvolvimento
 * Supera: SAP SuccessFactors, Cornerstone
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { autenticar } = require('../middleware/auth');

router.use(autenticar);

// ── COMPETÊNCIAS ──

router.get('/competencias', async (req, res) => {
  try {
    const r = await query(`
      SELECT c.*,
        COUNT(fc.id) as num_funcionarios,
        ROUND(AVG(fc.nivel)) as nivel_medio
      FROM competencia c
      LEFT JOIN funcionario_competencia fc ON fc.competencia_id=c.id AND fc.empresa_id=$1
      WHERE c.empresa_id=$1 OR c.global=true
      GROUP BY c.id ORDER BY c.categoria, c.nome
    `, [req.empresaId]).catch(()=>({rows:[]}));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/competencias', async (req, res) => {
  try {
    const { nome, categoria, descricao, niveis_descricao } = req.body;
    const r = await query(`
      INSERT INTO competencia (empresa_id, nome, categoria, descricao, niveis_descricao)
      VALUES ($1,$2,$3,$4,$5) RETURNING *
    `, [req.empresaId, nome, categoria||'tecnica', descricao||'',
        JSON.stringify(niveis_descricao || {
          1: 'Básico — conhecimento inicial',
          2: 'Elementar — aplica com supervisão',
          3: 'Intermédio — aplica autonomamente',
          4: 'Avançado — referência na equipa',
          5: 'Expert — referência na organização',
        })]);
    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SKILLS MATRIX ──

router.get('/matrix', async (req, res) => {
  try {
    const { departamento } = req.query;
    const conds = ['f.empresa_id=$1', "f.estado='ativo'"], params = [req.empresaId];
    if (departamento) { conds.push('f.departamento=$2'); params.push(departamento); }

    const [funcionarios, competencias, skills] = await Promise.all([
      query(`SELECT id, nome_completo, cargo, departamento FROM funcionario WHERE ${conds.join(' AND ')} ORDER BY departamento, nome_completo LIMIT 50`, params),
      query(`SELECT * FROM competencia WHERE empresa_id=$1 OR global=true ORDER BY categoria, nome`, [req.empresaId]),
      query(`SELECT fc.* FROM funcionario_competencia fc
        JOIN funcionario f ON f.id=fc.funcionario_id
        WHERE f.empresa_id=$1 ${departamento?'AND f.departamento=$2':''}`, params),
    ]);

    // Construir matrix
    const matrix = funcionarios.rows.map(f => ({
      funcionario: f,
      skills: competencias.rows.map(c => {
        const skill = skills.rows.find(s => s.funcionario_id===f.id && s.competencia_id===c.id);
        return { competencia_id: c.id, nivel: skill?.nivel||0, validado: skill?.validado||false };
      }),
    }));

    // Calcular gaps por cargo
    const gapsPorCargo = {};
    for (const f of funcionarios.rows) {
      if (!gapsPorCargo[f.cargo||'Sem cargo']) gapsPorCargo[f.cargo||'Sem cargo'] = {};
      for (const c of competencias.rows) {
        const skill = skills.rows.find(s => s.funcionario_id===f.id && s.competencia_id===c.id);
        if (!gapsPorCargo[f.cargo||'Sem cargo'][c.id]) gapsPorCargo[f.cargo||'Sem cargo'][c.id] = [];
        gapsPorCargo[f.cargo||'Sem cargo'][c.id].push(skill?.nivel||0);
      }
    }

    res.json({ funcionarios: funcionarios.rows, competencias: competencias.rows, matrix, gaps_por_cargo: gapsPorCargo });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Actualizar skill de funcionário
router.put('/funcionario/:funcId/skill/:compId', async (req, res) => {
  try {
    const { nivel, validado, notas } = req.body;
    await query(`
      INSERT INTO funcionario_competencia (empresa_id, funcionario_id, competencia_id, nivel, validado, notas, avaliado_por, avaliado_em)
      VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
      ON CONFLICT (funcionario_id, competencia_id) DO UPDATE SET nivel=$4, validado=$5, notas=$6, avaliado_por=$7, avaliado_em=NOW()
    `, [req.empresaId, req.params.funcId, req.params.compId, nivel||0, validado||false, notas||'', req.utilizador.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Skills de um funcionário
router.get('/funcionario/:id', async (req, res) => {
  try {
    const r = await query(`
      SELECT fc.*, c.nome, c.categoria, c.descricao, c.niveis_descricao,
        u.nome_completo as avaliado_por_nome
      FROM funcionario_competencia fc
      JOIN competencia c ON c.id=fc.competencia_id
      LEFT JOIN utilizador u ON u.id=fc.avaliado_por
      WHERE fc.funcionario_id=$1 AND fc.empresa_id=$2
      ORDER BY c.categoria, c.nome
    `, [req.params.id, req.empresaId]).catch(()=>({rows:[]}));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Requisitos de competência por cargo
router.get('/requisitos-cargo', async (req, res) => {
  try {
    const r = await query(`SELECT * FROM cargo_competencia WHERE empresa_id=$1 ORDER BY cargo, nivel_minimo DESC`, [req.empresaId]).catch(()=>({rows:[]}));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/requisitos-cargo', async (req, res) => {
  try {
    const { cargo, competencia_id, nivel_minimo } = req.body;
    await query(`INSERT INTO cargo_competencia (empresa_id, cargo, competencia_id, nivel_minimo)
      VALUES ($1,$2,$3,$4) ON CONFLICT (empresa_id, cargo, competencia_id) DO UPDATE SET nivel_minimo=$4`,
      [req.empresaId, cargo, competencia_id, nivel_minimo||3]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Análise de gaps da equipa vs requisitos
router.get('/gaps-equipa', async (req, res) => {
  try {
    const r = await query(`
      SELECT f.nome_completo, f.cargo, c.nome as competencia,
        COALESCE(fc.nivel,0) as nivel_actual, cc.nivel_minimo as nivel_exigido,
        cc.nivel_minimo - COALESCE(fc.nivel,0) as gap
      FROM funcionario f
      JOIN cargo_competencia cc ON cc.cargo=f.cargo AND cc.empresa_id=f.empresa_id
      JOIN competencia c ON c.id=cc.competencia_id
      LEFT JOIN funcionario_competencia fc ON fc.funcionario_id=f.id AND fc.competencia_id=cc.competencia_id
      WHERE f.empresa_id=$1 AND f.estado='ativo'
        AND cc.nivel_minimo > COALESCE(fc.nivel,0)
      ORDER BY gap DESC, f.nome_completo
    `, [req.empresaId]).catch(()=>({rows:[]}));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
