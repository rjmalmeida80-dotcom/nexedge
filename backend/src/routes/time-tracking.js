'use strict';
const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { autenticar } = require('../middleware/auth');

router.use(autenticar);

// ── PROJECTOS ──

router.get('/projectos', async (req, res) => {
  try {
    const r = await query(`
      SELECT p.*,
        u.nome_completo as responsavel_nome,
        COALESCE((SELECT SUM(duracao_min) FROM time_entry WHERE projeto_id=p.id),0) as total_min,
        COALESCE((SELECT SUM(duracao_min) FROM time_entry WHERE projeto_id=p.id AND faturavel=true AND faturado=false),0) as pendente_faturar_min,
        (SELECT COUNT(*) FROM time_entry WHERE projeto_id=p.id) as num_entradas
      FROM projeto p
      LEFT JOIN utilizador u ON u.id=p.responsavel_id
      WHERE p.empresa_id=$1
      ORDER BY p.criado_em DESC
    `, [req.empresaId]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/projectos', async (req, res) => {
  try {
    const d = req.body;
    const r = await query(`
      INSERT INTO projeto (empresa_id,nome,descricao,cliente_id,responsavel_id,estado,data_inicio,data_fim_prevista,orcamento_horas,valor_hora,cor,tags)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *
    `, [req.empresaId,d.nome,d.descricao,d.cliente_id||null,d.responsavel_id||req.utilizador.id,d.estado||'ativo',d.data_inicio||null,d.data_fim_prevista||null,d.orcamento_horas||null,d.valor_hora||0,d.cor||'#4F46E5',JSON.stringify(d.tags||[])]);
    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/projectos/:id', async (req, res) => {
  try {
    const d = req.body;
    const campos = ['nome','descricao','estado','data_inicio','data_fim_prevista','data_fim_real','orcamento_horas','valor_hora','cor'];
    const updates = [], params = [];
    let p = 1;
    for (const c of campos) {
      if (d[c] !== undefined) { updates.push(`${c}=$${p++}`); params.push(d[c]); }
    }
    params.push(req.params.id);
    await query(`UPDATE projeto SET ${updates.join(',')} WHERE id=$${p} AND empresa_id='${req.empresaId}'`, params);
    const r = await query(`SELECT * FROM projeto WHERE id=$1`, [req.params.id]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── TIME ENTRIES ──

router.get('/entradas', async (req, res) => {
  try {
    const { projeto_id, funcionario_id, data_inicio, data_fim, faturavel, faturado } = req.query;
    const conds = ['t.empresa_id=$1'], params = [req.empresaId];
    let p = 2;
    if (projeto_id) { conds.push(`t.projeto_id=$${p++}`); params.push(projeto_id); }
    if (funcionario_id) { conds.push(`t.funcionario_id=$${p++}`); params.push(funcionario_id); }
    if (data_inicio) { conds.push(`t.data>=$${p++}`); params.push(data_inicio); }
    if (data_fim) { conds.push(`t.data<=$${p++}`); params.push(data_fim); }
    if (faturavel !== undefined) { conds.push(`t.faturavel=$${p++}`); params.push(faturavel==='true'); }
    if (faturado !== undefined) { conds.push(`t.faturado=$${p++}`); params.push(faturado==='true'); }

    const r = await query(`
      SELECT t.*, pr.nome as projeto_nome, pr.cor as projeto_cor, pr.valor_hora,
        f.nome_completo as funcionario_nome,
        ROUND(t.duracao_min/60.0,2) as horas,
        ROUND((t.duracao_min/60.0) * COALESCE(pr.valor_hora,0), 2) as valor
      FROM time_entry t
      LEFT JOIN projeto pr ON pr.id=t.projeto_id
      LEFT JOIN funcionario f ON f.id=t.funcionario_id
      WHERE ${conds.join(' AND ')}
      ORDER BY t.data DESC, t.criado_em DESC
      LIMIT 500
    `, params);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/entradas', async (req, res) => {
  try {
    const d = req.body;
    // Calcular duração se hora_inicio e hora_fim fornecidas
    let duracao = d.duracao_min || 0;
    if (d.hora_inicio && d.hora_fim && !duracao) {
      const [hi, mi] = d.hora_inicio.split(':').map(Number);
      const [hf, mf] = d.hora_fim.split(':').map(Number);
      duracao = (hf*60+mf) - (hi*60+mi);
    }
    const r = await query(`
      INSERT INTO time_entry (empresa_id,projeto_id,funcionario_id,utilizador_id,descricao,data,hora_inicio,hora_fim,duracao_min,faturavel,tags)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *
    `, [req.empresaId,d.projeto_id||null,d.funcionario_id||null,req.utilizador.id,d.descricao||'',d.data||new Date().toISOString().slice(0,10),d.hora_inicio||null,d.hora_fim||null,duracao,d.faturavel!==false,JSON.stringify(d.tags||[])]);
    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/entradas/:id', async (req, res) => {
  try {
    await query(`DELETE FROM time_entry WHERE id=$1 AND empresa_id=$2`, [req.params.id, req.empresaId]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── RELATÓRIO / RESUMO ──

router.get('/relatorio', async (req, res) => {
  try {
    const { projeto_id, data_inicio, data_fim } = req.query;
    const conds = ['t.empresa_id=$1'], params = [req.empresaId];
    let p = 2;
    if (projeto_id) { conds.push(`t.projeto_id=$${p++}`); params.push(projeto_id); }
    if (data_inicio) { conds.push(`t.data>=$${p++}`); params.push(data_inicio); }
    if (data_fim) { conds.push(`t.data<=$${p++}`); params.push(data_fim); }
    const where = conds.join(' AND ');

    const [totais, porFuncionario, porProjeto, porDia] = await Promise.all([
      query(`SELECT
        SUM(duracao_min) as total_min,
        SUM(CASE WHEN faturavel=true THEN duracao_min ELSE 0 END) as faturavel_min,
        SUM(CASE WHEN faturado=true THEN duracao_min ELSE 0 END) as faturado_min,
        ROUND(SUM(CASE WHEN faturavel=true AND faturado=false THEN (duracao_min/60.0)*COALESCE(pr.valor_hora,0) ELSE 0 END),2) as valor_pendente
        FROM time_entry t LEFT JOIN projeto pr ON pr.id=t.projeto_id WHERE ${where}`, params),
      query(`SELECT f.nome_completo, SUM(t.duracao_min) as total_min,
        COUNT(*) as num_entradas
        FROM time_entry t JOIN funcionario f ON f.id=t.funcionario_id
        WHERE ${where} GROUP BY f.id,f.nome_completo ORDER BY total_min DESC LIMIT 10`, params),
      query(`SELECT pr.nome, pr.cor, SUM(t.duracao_min) as total_min,
        ROUND(SUM(CASE WHEN t.faturavel THEN (t.duracao_min/60.0)*COALESCE(pr.valor_hora,0) ELSE 0 END),2) as valor
        FROM time_entry t JOIN projeto pr ON pr.id=t.projeto_id
        WHERE ${where} GROUP BY pr.id,pr.nome,pr.cor ORDER BY total_min DESC`, params),
      query(`SELECT data, SUM(duracao_min) as total_min
        FROM time_entry t WHERE ${where}
        GROUP BY data ORDER BY data DESC LIMIT 30`, params),
    ]);

    const t = totais.rows[0];
    res.json({
      totais: {
        total_min: parseInt(t.total_min||0),
        total_h: Math.round(parseInt(t.total_min||0)/60*10)/10,
        faturavel_min: parseInt(t.faturavel_min||0),
        faturado_min: parseInt(t.faturado_min||0),
        valor_pendente: parseFloat(t.valor_pendente||0),
      },
      por_funcionario: porFuncionario.rows,
      por_projeto: porProjeto.rows,
      por_dia: porDia.rows,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── TIMER ACTIVO (start/stop) ──
const timersActivos = new Map();

router.post('/timer/start', async (req, res) => {
  try {
    const key = `${req.empresaId}_${req.utilizador.id}`;
    if (timersActivos.has(key)) return res.status(400).json({ error: 'Já tens um timer activo' });
    timersActivos.set(key, { inicio: new Date(), ...req.body });
    res.json({ ok: true, inicio: timersActivos.get(key).inicio });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/timer/stop', async (req, res) => {
  try {
    const key = `${req.empresaId}_${req.utilizador.id}`;
    const timer = timersActivos.get(key);
    if (!timer) return res.status(400).json({ error: 'Sem timer activo' });
    const duracao = Math.round((Date.now() - new Date(timer.inicio).getTime()) / 60000);
    timersActivos.delete(key);
    const r = await query(`
      INSERT INTO time_entry (empresa_id,projeto_id,funcionario_id,utilizador_id,descricao,data,hora_inicio,hora_fim,duracao_min,faturavel)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
    `, [req.empresaId,timer.projeto_id||null,timer.funcionario_id||null,req.utilizador.id,timer.descricao||'',new Date().toISOString().slice(0,10),timer.inicio.toTimeString().slice(0,5),new Date().toTimeString().slice(0,5),duracao,timer.faturavel!==false]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/timer/activo', (req, res) => {
  const key = `${req.empresaId}_${req.utilizador.id}`;
  const timer = timersActivos.get(key);
  if (!timer) return res.json({ activo: false });
  const duracaoActual = Math.round((Date.now() - new Date(timer.inicio).getTime()) / 60000);
  res.json({ activo: true, inicio: timer.inicio, duracao_min: duracaoActual, ...timer });
});

module.exports = router;
