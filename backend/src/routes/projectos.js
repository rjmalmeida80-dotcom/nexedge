'use strict';
/**
 * NexEdge — Módulo de Projectos
 * Gestão completa: projectos, tarefas, milestones, equipa, orçamento, gantt
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { autenticar } = require('../middleware/auth');

router.use(autenticar);

// ── PROJECTOS ──

router.get('/', async (req, res) => {
  try {
    const { estado, responsavel_id } = req.query;
    const conds = ['p.empresa_id=$1'], params = [req.empresaId];
    let n = 2;
    if (estado) { conds.push(`p.estado=$${n++}`); params.push(estado); }
    if (responsavel_id) { conds.push(`p.responsavel_id=$${n++}`); params.push(responsavel_id); }

    const r = await query(`
      SELECT p.*,
        u.nome_completo as responsavel_nome,
        c.nome as cliente_nome,
        COUNT(DISTINCT t.id) as total_tarefas,
        COUNT(DISTINCT t.id) FILTER (WHERE t.estado='concluida') as tarefas_concluidas,
        COUNT(DISTINCT pm.utilizador_id) as num_membros,
        COALESCE(SUM(te.duracao_min),0) as horas_registadas_min,
        ROUND(
          CASE WHEN COUNT(t.id) > 0
          THEN COUNT(t.id) FILTER (WHERE t.estado='concluida')::numeric / COUNT(t.id) * 100
          ELSE 0 END
        ) as percentagem_conclusao
      FROM projecto p
      LEFT JOIN utilizador u ON u.id=p.responsavel_id
      LEFT JOIN cliente c ON c.id=p.cliente_id
      LEFT JOIN projecto_tarefa t ON t.projecto_id=p.id
      LEFT JOIN projecto_membro pm ON pm.projecto_id=p.id
      LEFT JOIN time_entry te ON te.projeto_id=p.id
      WHERE ${conds.join(' AND ')}
      GROUP BY p.id, u.nome_completo, c.nome
      ORDER BY p.criado_em DESC
    `, params);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const d = req.body;
    const r = await query(`
      INSERT INTO projecto (
        empresa_id, nome, descricao, cliente_id, responsavel_id,
        estado, data_inicio, data_fim_prevista, orcamento, valor_hora,
        cor, prioridade, tags
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING *
    `, [
      req.empresaId, d.nome, d.descricao||'', d.cliente_id||null,
      d.responsavel_id||req.utilizador.id, d.estado||'planeamento',
      d.data_inicio||null, d.data_fim_prevista||null,
      d.orcamento||0, d.valor_hora||0,
      d.cor||'#4F46E5', d.prioridade||'media',
      JSON.stringify(d.tags||[])
    ]);

    // Adicionar criador como membro
    await query(`INSERT INTO projecto_membro (projecto_id, utilizador_id, papel) VALUES ($1,$2,'gestor')`,
      [r.rows[0].id, req.utilizador.id]).catch(()=>{});

    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const [proj, tarefas, membros, milestones, horas] = await Promise.all([
      query(`SELECT p.*, u.nome_completo as responsavel_nome, c.nome as cliente_nome
        FROM projecto p
        LEFT JOIN utilizador u ON u.id=p.responsavel_id
        LEFT JOIN cliente c ON c.id=p.cliente_id
        WHERE p.id=$1 AND p.empresa_id=$2`, [req.params.id, req.empresaId]),
      query(`SELECT t.*, u.nome_completo as responsavel_nome
        FROM projecto_tarefa t LEFT JOIN utilizador u ON u.id=t.responsavel_id
        WHERE t.projecto_id=$1 ORDER BY t.ordem, t.data_inicio_prevista`, [req.params.id]),
      query(`SELECT pm.*, u.nome_completo, u.email
        FROM projecto_membro pm JOIN utilizador u ON u.id=pm.utilizador_id
        WHERE pm.projecto_id=$1`, [req.params.id]),
      query(`SELECT * FROM projecto_milestone WHERE projecto_id=$1 ORDER BY data_prevista`, [req.params.id]),
      query(`SELECT COALESCE(SUM(duracao_min),0) as total_min,
        COUNT(*) as num_entradas FROM time_entry WHERE projeto_id=$1`, [req.params.id]),
    ]);

    if (!proj.rows.length) return res.status(404).json({ error: 'Projecto não encontrado' });
    res.json({
      ...proj.rows[0],
      tarefas: tarefas.rows,
      membros: membros.rows,
      milestones: milestones.rows,
      horas: horas.rows[0],
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', async (req, res) => {
  try {
    const d = req.body;
    const campos = ['nome','descricao','estado','data_inicio','data_fim_prevista','data_fim_real','orcamento','valor_hora','cor','prioridade'];
    const updates = [], params = [];
    let n = 1;
    for (const c of campos) {
      if (d[c] !== undefined) { updates.push(`${c}=$${n++}`); params.push(d[c]); }
    }
    if (!updates.length) return res.status(400).json({ error: 'Sem campos para actualizar' });
    params.push(req.params.id);
    await query(`UPDATE projecto SET ${updates.join(',')} WHERE id=$${n} AND empresa_id='${req.empresaId}'`, params);
    const r = await query(`SELECT * FROM projecto WHERE id=$1`, [req.params.id]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── TAREFAS ──

router.get('/:id/tarefas', async (req, res) => {
  try {
    const r = await query(`
      SELECT t.*, u.nome_completo as responsavel_nome,
        COUNT(st.id) as num_subtarefas,
        COUNT(st.id) FILTER (WHERE st.estado='concluida') as subtarefas_concluidas
      FROM projecto_tarefa t
      LEFT JOIN utilizador u ON u.id=t.responsavel_id
      LEFT JOIN projecto_tarefa st ON st.tarefa_pai_id=t.id
      WHERE t.projecto_id=$1 AND t.tarefa_pai_id IS NULL
      GROUP BY t.id, u.nome_completo
      ORDER BY t.ordem, t.data_inicio_prevista
    `, [req.params.id]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/tarefas', async (req, res) => {
  try {
    const d = req.body;
    const r = await query(`
      INSERT INTO projecto_tarefa (
        projecto_id, titulo, descricao, responsavel_id,
        estado, prioridade, data_inicio_prevista, data_fim_prevista,
        estimativa_horas, tarefa_pai_id, ordem, tags
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
        (SELECT COALESCE(MAX(ordem),0)+1 FROM projecto_tarefa WHERE projecto_id=$1),
        $11)
      RETURNING *
    `, [
      req.params.id, d.titulo, d.descricao||'',
      d.responsavel_id||null, d.estado||'a_fazer',
      d.prioridade||'media', d.data_inicio_prevista||null,
      d.data_fim_prevista||null, d.estimativa_horas||null,
      d.tarefa_pai_id||null, JSON.stringify(d.tags||[])
    ]);
    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/:projecId/tarefas/:id', async (req, res) => {
  try {
    const d = req.body;
    const campos = ['titulo','descricao','estado','prioridade','responsavel_id','data_inicio_prevista','data_fim_prevista','data_conclusao','estimativa_horas','ordem'];
    const updates = [], params = [];
    let n = 1;
    for (const c of campos) {
      if (d[c] !== undefined) { updates.push(`${c}=$${n++}`); params.push(d[c]); }
    }
    // Se estado muda para concluida, registar data
    if (d.estado === 'concluida' && !d.data_conclusao) { updates.push(`data_conclusao=$${n++}`); params.push(new Date()); }
    params.push(req.params.id);
    await query(`UPDATE projecto_tarefa SET ${updates.join(',')} WHERE id=$${n}`, params);
    const r = await query(`SELECT * FROM projecto_tarefa WHERE id=$1`, [req.params.id]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:projecId/tarefas/:id', async (req, res) => {
  try {
    await query(`DELETE FROM projecto_tarefa WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── MILESTONES ──

router.get('/:id/milestones', async (req, res) => {
  try {
    const r = await query(`SELECT * FROM projecto_milestone WHERE projecto_id=$1 ORDER BY data_prevista`, [req.params.id]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/milestones', async (req, res) => {
  try {
    const { titulo, descricao, data_prevista, cor } = req.body;
    const r = await query(`
      INSERT INTO projecto_milestone (projecto_id, titulo, descricao, data_prevista, cor)
      VALUES ($1,$2,$3,$4,$5) RETURNING *
    `, [req.params.id, titulo, descricao||'', data_prevista, cor||'#4F46E5']);
    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/:projecId/milestones/:id', async (req, res) => {
  try {
    const { titulo, data_prevista, data_conclusao, estado } = req.body;
    await query(`UPDATE projecto_milestone SET titulo=$1, data_prevista=$2, data_conclusao=$3, estado=$4 WHERE id=$5`,
      [titulo, data_prevista, data_conclusao||null, estado||'pendente', req.params.id]);
    const r = await query(`SELECT * FROM projecto_milestone WHERE id=$1`, [req.params.id]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── MEMBROS ──

router.post('/:id/membros', async (req, res) => {
  try {
    const { utilizador_id, papel } = req.body;
    await query(`
      INSERT INTO projecto_membro (projecto_id, utilizador_id, papel)
      VALUES ($1,$2,$3) ON CONFLICT (projecto_id, utilizador_id) DO UPDATE SET papel=$3
    `, [req.params.id, utilizador_id, papel||'membro']);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:projecId/membros/:userId', async (req, res) => {
  try {
    await query(`DELETE FROM projecto_membro WHERE projecto_id=$1 AND utilizador_id=$2`, [req.params.projecId, req.params.userId]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DASHBOARD / RELATÓRIO ──

router.get('/:id/relatorio', async (req, res) => {
  try {
    const [proj, stats, horas_por_pessoa, tarefas_atrasadas] = await Promise.all([
      query(`SELECT p.*, u.nome_completo as responsavel_nome FROM projecto p
        LEFT JOIN utilizador u ON u.id=p.responsavel_id WHERE p.id=$1`, [req.params.id]),
      query(`SELECT
        COUNT(*) as total_tarefas,
        COUNT(*) FILTER (WHERE estado='concluida') as concluidas,
        COUNT(*) FILTER (WHERE estado='em_progresso') as em_progresso,
        COUNT(*) FILTER (WHERE estado='a_fazer') as a_fazer,
        COUNT(*) FILTER (WHERE data_fim_prevista < NOW() AND estado != 'concluida') as atrasadas,
        COALESCE(SUM(estimativa_horas),0) as horas_estimadas
        FROM projecto_tarefa WHERE projecto_id=$1`, [req.params.id]),
      query(`SELECT u.nome_completo, SUM(te.duracao_min) as total_min
        FROM time_entry te JOIN utilizador u ON u.id=te.utilizador_id
        WHERE te.projeto_id=$1 GROUP BY u.id, u.nome_completo ORDER BY total_min DESC`, [req.params.id]),
      query(`SELECT titulo, data_fim_prevista, responsavel_id FROM projecto_tarefa
        WHERE projecto_id=$1 AND data_fim_prevista < NOW() AND estado != 'concluida'
        ORDER BY data_fim_prevista`, [req.params.id]),
    ]);

    const p = proj.rows[0];
    const s = stats.rows[0];
    const diasTotal = p.data_inicio && p.data_fim_prevista ?
      Math.ceil((new Date(p.data_fim_prevista) - new Date(p.data_inicio)) / (1000*60*60*24)) : 0;
    const diasDecorridos = p.data_inicio ?
      Math.ceil((new Date() - new Date(p.data_inicio)) / (1000*60*60*24)) : 0;

    res.json({
      projecto: p,
      stats: s,
      progresso_tempo: diasTotal ? Math.min(100, Math.round(diasDecorridos/diasTotal*100)) : 0,
      progresso_tarefas: s.total_tarefas > 0 ? Math.round(s.concluidas/s.total_tarefas*100) : 0,
      horas_por_pessoa: horas_por_pessoa.rows,
      tarefas_atrasadas: tarefas_atrasadas.rows,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GANTT (dados para renderização) ──

router.get('/:id/gantt', async (req, res) => {
  try {
    const [tarefas, milestones] = await Promise.all([
      query(`SELECT t.*, u.nome_completo as responsavel_nome
        FROM projecto_tarefa t LEFT JOIN utilizador u ON u.id=t.responsavel_id
        WHERE t.projecto_id=$1 ORDER BY t.ordem, t.data_inicio_prevista`, [req.params.id]),
      query(`SELECT * FROM projecto_milestone WHERE projecto_id=$1 ORDER BY data_prevista`, [req.params.id]),
    ]);
    res.json({ tarefas: tarefas.rows, milestones: milestones.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
