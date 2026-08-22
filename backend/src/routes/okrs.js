'use strict';
/**
 * NexEdge — OKRs (Objectives & Key Results)
 * Gestão de objectivos empresa/equipa/individual
 * Supera: Lattice, 15Five, Betterworks
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { autenticar } = require('../middleware/auth');

router.use(autenticar);

// ── OBJECTIVOS ──

router.get('/', async (req, res) => {
  try {
    const { ciclo, nivel, responsavel_id } = req.query;
    const conds = ['o.empresa_id=$1'], params = [req.empresaId];
    let n = 2;
    if (ciclo) { conds.push(`o.ciclo=$${n++}`); params.push(ciclo); }
    if (nivel) { conds.push(`o.nivel=$${n++}`); params.push(nivel); }
    if (responsavel_id) { conds.push(`o.responsavel_id=$${n++}`); params.push(responsavel_id); }

    const r = await query(`
      SELECT o.*,
        u.nome_completo as responsavel_nome,
        json_agg(json_build_object(
          'id', kr.id, 'titulo', kr.titulo, 'valor_actual', kr.valor_actual,
          'valor_alvo', kr.valor_alvo, 'unidade', kr.unidade, 'progresso', kr.progresso
        ) ORDER BY kr.ordem) FILTER (WHERE kr.id IS NOT NULL) as key_results
      FROM okr_objectivo o
      LEFT JOIN utilizador u ON u.id=o.responsavel_id
      LEFT JOIN okr_key_result kr ON kr.objectivo_id=o.id
      WHERE ${conds.join(' AND ')}
      GROUP BY o.id, u.nome_completo
      ORDER BY o.nivel, o.criado_em DESC
    `, params);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const { titulo, descricao, nivel, ciclo, data_inicio, data_fim, responsavel_id, objectivo_pai_id, key_results } = req.body;
    if (!titulo) return res.status(400).json({ error: 'Título obrigatório' });

    const r = await query(`
      INSERT INTO okr_objectivo (empresa_id, titulo, descricao, nivel, ciclo, data_inicio, data_fim, responsavel_id, objectivo_pai_id, estado)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'activo') RETURNING *
    `, [req.empresaId, titulo, descricao||'', nivel||'empresa', ciclo||`Q${Math.ceil((new Date().getMonth()+1)/3)} ${new Date().getFullYear()}`,
        data_inicio||null, data_fim||null, responsavel_id||req.utilizador.id, objectivo_pai_id||null]);

    const obj = r.rows[0];

    // Criar Key Results
    if (key_results?.length) {
      for (let i = 0; i < key_results.length; i++) {
        const kr = key_results[i];
        await query(`INSERT INTO okr_key_result (objectivo_id, empresa_id, titulo, valor_inicial, valor_actual, valor_alvo, unidade, ordem)
          VALUES ($1,$2,$3,$4,$4,$5,$6,$7)`,
          [obj.id, req.empresaId, kr.titulo, kr.valor_inicial||0, kr.valor_alvo, kr.unidade||'%', i+1]);
      }
    }

    const objCompleto = await query(`SELECT o.*, json_agg(kr.*) FILTER (WHERE kr.id IS NOT NULL) as key_results
      FROM okr_objectivo o LEFT JOIN okr_key_result kr ON kr.objectivo_id=o.id
      WHERE o.id=$1 GROUP BY o.id`, [obj.id]);
    res.status(201).json(objCompleto.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Actualizar progresso de um Key Result
router.put('/key-results/:id', async (req, res) => {
  try {
    const { valor_actual, nota } = req.body;
    await query(`UPDATE okr_key_result SET valor_actual=$1,
      progresso=ROUND(CASE WHEN valor_alvo>0 THEN (($1-valor_inicial)/(valor_alvo-valor_inicial)*100) ELSE 0 END),
      ultima_actualizacao=NOW(), notas=$2 WHERE id=$3 AND empresa_id=$4`,
      [valor_actual, nota||null, req.params.id, req.empresaId]);

    // Recalcular progresso do objectivo (média dos KRs)
    const kr = await query(`SELECT objectivo_id FROM okr_key_result WHERE id=$1`, [req.params.id]);
    if (kr.rows.length) {
      await query(`UPDATE okr_objectivo SET progresso=(
        SELECT ROUND(AVG(progresso)) FROM okr_key_result WHERE objectivo_id=$1
      ) WHERE id=$1`, [kr.rows[0].objectivo_id]);
    }

    const r = await query(`SELECT * FROM okr_key_result WHERE id=$1`, [req.params.id]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Check-in semanal
router.post('/:id/checkin', async (req, res) => {
  try {
    const { confianca, notas, bloqueios } = req.body; // confianca: 1-5
    await query(`INSERT INTO okr_checkin (objectivo_id, empresa_id, utilizador_id, confianca, notas, bloqueios)
      VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.params.id, req.empresaId, req.utilizador.id, confianca||3, notas||'', bloqueios||'']);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Dashboard OKRs
router.get('/dashboard', async (req, res) => {
  try {
    const { ciclo } = req.query;
    const cicloActual = ciclo || `Q${Math.ceil((new Date().getMonth()+1)/3)} ${new Date().getFullYear()}`;

    const [resumo, porNivel, emRisco] = await Promise.all([
      query(`SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE progresso >= 70) as no_caminho,
        COUNT(*) FILTER (WHERE progresso BETWEEN 40 AND 69) as risco,
        COUNT(*) FILTER (WHERE progresso < 40) as atrasado,
        ROUND(AVG(progresso)) as progresso_medio
        FROM okr_objectivo WHERE empresa_id=$1 AND ciclo=$2 AND estado='activo'`, [req.empresaId, cicloActual]),
      query(`SELECT nivel, COUNT(*) as total, ROUND(AVG(progresso)) as progresso_medio
        FROM okr_objectivo WHERE empresa_id=$1 AND ciclo=$2 AND estado='activo'
        GROUP BY nivel`, [req.empresaId, cicloActual]),
      query(`SELECT o.titulo, o.progresso, u.nome_completo as responsavel_nome,
        o.data_fim FROM okr_objectivo o LEFT JOIN utilizador u ON u.id=o.responsavel_id
        WHERE o.empresa_id=$1 AND o.ciclo=$2 AND o.progresso < 40 AND o.estado='activo'
        ORDER BY o.progresso ASC LIMIT 5`, [req.empresaId, cicloActual]),
    ]);

    res.json({ ciclo: cicloActual, resumo: resumo.rows[0], por_nivel: porNivel.rows, em_risco: emRisco.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
