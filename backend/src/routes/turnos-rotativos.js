'use strict';
/**
 * NexEdge — Turnos Rotativos com IA
 * Optimização automática de escalas, gestão de turnos, alertas de conflitos
 * Supera: Deputy, Planday, Shiftboard
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const Anthropic = require('@anthropic-ai/sdk');

router.use(autenticar);
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

// ── TURNOS ──

router.get('/', async (req, res) => {
  try {
    const { data_inicio, data_fim, departamento, funcionario_id } = req.query;
    const conds = ['t.empresa_id=$1'], params = [req.empresaId];
    let n = 2;
    if (data_inicio) { conds.push(`t.data>=$${n++}`); params.push(data_inicio); }
    if (data_fim) { conds.push(`t.data<=$${n++}`); params.push(data_fim); }
    if (departamento) { conds.push(`f.departamento=$${n++}`); params.push(departamento); }
    if (funcionario_id) { conds.push(`t.funcionario_id=$${n++}`); params.push(funcionario_id); }

    const r = await query(`
      SELECT t.*, f.nome_completo, f.departamento, f.cargo,
        EXTRACT(EPOCH FROM (t.hora_fim - t.hora_inicio))/3600 as horas_turno
      FROM turno t
      JOIN funcionario f ON f.id=t.funcionario_id
      WHERE ${conds.join(' AND ')}
      ORDER BY t.data, t.hora_inicio
    `, params).catch(()=>({rows:[]}));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const { funcionario_id, data, hora_inicio, hora_fim, tipo, notas } = req.body;

    // Verificar conflitos
    const conflito = await query(`
      SELECT id FROM turno WHERE funcionario_id=$1 AND data=$2
        AND hora_inicio < $3 AND hora_fim > $4
    `, [funcionario_id, data, hora_fim, hora_inicio]);

    if (conflito.rows.length) return res.status(400).json({ error: 'Conflito de horário — já existe turno neste período' });

    const r = await query(`
      INSERT INTO turno (empresa_id, funcionario_id, data, hora_inicio, hora_fim, tipo, notas, estado)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'publicado') RETURNING *
    `, [req.empresaId, funcionario_id, data, hora_inicio, hora_fim, tipo||'normal', notas||'']);
    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    await query(`DELETE FROM turno WHERE id=$1 AND empresa_id=$2`, [req.params.id, req.empresaId]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PADRÕES DE TURNO ──

router.get('/padroes', async (req, res) => {
  try {
    const r = await query(`SELECT * FROM turno_padrao WHERE empresa_id=$1 ORDER BY nome`, [req.empresaId]).catch(()=>({rows:[]}));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/padroes', async (req, res) => {
  try {
    const { nome, hora_inicio, hora_fim, dias_semana, cor } = req.body;
    const r = await query(`
      INSERT INTO turno_padrao (empresa_id, nome, hora_inicio, hora_fim, dias_semana, cor)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
    `, [req.empresaId, nome, hora_inicio, hora_fim, JSON.stringify(dias_semana||[1,2,3,4,5]), cor||'#4F46E5']);
    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GERAR ESCALA AUTOMÁTICA ──

router.post('/gerar-escala', async (req, res) => {
  try {
    const { data_inicio, data_fim, departamento, padroes_ids } = req.body;

    const [funcionarios, padroes] = await Promise.all([
      query(`SELECT f.id, f.nome_completo, f.departamento, f.horas_semanais,
        COALESCE(f.preferencia_turno,'manha') as preferencia
        FROM funcionario f WHERE f.empresa_id=$1 AND f.estado='ativo'
        ${departamento?`AND f.departamento='${departamento}'`:''}`, [req.empresaId]),
      query(`SELECT * FROM turno_padrao WHERE empresa_id=$1 ${padroes_ids?.length?`AND id=ANY(ARRAY[${padroes_ids.map((_,i)=>`$${i+2}`).join(',')}]::uuid[])`:''} ORDER BY hora_inicio`,
        [req.empresaId, ...(padroes_ids||[])]),
    ]);

    if (!funcionarios.rows.length || !padroes.rows.length) {
      return res.status(400).json({ error: 'Precisas de funcionários e padrões de turno configurados' });
    }

    // Algoritmo de escala rotativa
    const inicio = new Date(data_inicio);
    const fim = new Date(data_fim);
    const turnos = [];
    const horasPorFuncionario = {};

    funcionarios.rows.forEach(f => horasPorFuncionario[f.id] = 0);

    for (let d = new Date(inicio); d <= fim; d.setDate(d.getDate()+1)) {
      const diaSemana = d.getDay(); // 0=domingo, 6=sábado
      if (diaSemana === 0 || diaSemana === 6) continue; // skip weekends by default

      const dataStr = d.toISOString().slice(0,10);
      const padroesHoje = padroes.rows.filter(p => {
        const dias = typeof p.dias_semana === 'string' ? JSON.parse(p.dias_semana) : p.dias_semana;
        return dias.includes(diaSemana);
      });

      for (const padrao of padroesHoje) {
        // Rodar funcionários — escolher o com menos horas desta semana
        const funcOrdenados = funcionarios.rows
          .filter(f => !departamento || f.departamento === departamento)
          .sort((a,b) => (horasPorFuncionario[a.id]||0) - (horasPorFuncionario[b.id]||0));

        const func = funcOrdenados[0];
        if (!func) continue;

        // Verificar se já tem turno hoje
        const jaTemTurno = turnos.find(t => t.funcionario_id === func.id && t.data === dataStr);
        if (jaTemTurno) {
          // Usar segundo funcionário
          const func2 = funcOrdenados[1];
          if (!func2) continue;
          turnos.push({ funcionario_id: func2.id, data: dataStr, hora_inicio: padrao.hora_inicio, hora_fim: padrao.hora_fim, tipo: 'normal' });
          const horas = (parseInt(padrao.hora_fim)-parseInt(padrao.hora_inicio)) || 8;
          horasPorFuncionario[func2.id] = (horasPorFuncionario[func2.id]||0) + horas;
        } else {
          turnos.push({ funcionario_id: func.id, data: dataStr, hora_inicio: padrao.hora_inicio, hora_fim: padrao.hora_fim, tipo: 'normal' });
          const horas = (parseInt(padrao.hora_fim)-parseInt(padrao.hora_inicio)) || 8;
          horasPorFuncionario[func.id] = (horasPorFuncionario[func.id]||0) + horas;
        }
      }
    }

    // Inserir turnos gerados
    let criados = 0;
    for (const t of turnos) {
      await query(`INSERT INTO turno (empresa_id, funcionario_id, data, hora_inicio, hora_fim, tipo, estado)
        VALUES ($1,$2,$3,$4,$5,'normal','rascunho') ON CONFLICT DO NOTHING`,
        [req.empresaId, t.funcionario_id, t.data, t.hora_inicio, t.hora_fim]).catch(()=>{});
      criados++;
    }

    res.json({ criados, periodo: `${data_inicio} a ${data_fim}`, horas_por_funcionario: horasPorFuncionario });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── OPTIMIZAÇÃO COM IA ──

router.post('/optimizar', async (req, res) => {
  try {
    const { data_inicio, data_fim, departamento, restricoes } = req.body;

    const [turnos, funcionarios] = await Promise.all([
      query(`SELECT t.*, f.nome_completo, f.departamento FROM turno t JOIN funcionario f ON f.id=t.funcionario_id
        WHERE t.empresa_id=$1 AND t.data BETWEEN $2 AND $3 AND t.estado='rascunho'
        ${departamento?`AND f.departamento='${departamento}'`:''}`, [req.empresaId, data_inicio, data_fim]),
      query(`SELECT id, nome_completo, horas_semanais, preferencia_turno, departamento
        FROM funcionario WHERE empresa_id=$1 AND estado='ativo'
        ${departamento?`AND departamento='${departamento}'`:''}`, [req.empresaId]),
    ]);

    if (!anthropic) {
      return res.json({ sugestoes: ['Configure a ANTHROPIC_API_KEY para optimização IA'], turnos_actuais: turnos.rows.length });
    }

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 1500,
      messages: [{role:'user', content:`Analisa esta escala de trabalho e sugere optimizações em PT-PT:

Período: ${data_inicio} a ${data_fim}
Funcionários: ${JSON.stringify(funcionarios.rows.map(f=>({nome:f.nome_completo, horas_semana:f.horas_semanais, preferencia:f.preferencia_turno})))}
Turnos actuais: ${turnos.rows.length}
Restrições: ${JSON.stringify(restricoes||{})}

Sugere:
1. Distribuição mais equitativa de horas
2. Respeito por preferências de turno
3. Evitar funcionários com mais de 5 dias consecutivos
4. Garantir descanso mínimo entre turnos (11h)
5. Cobertura adequada em todos os períodos

Responde com lista de sugestões concretas e accionáveis (máx 8 sugestões).`}]
    });

    res.json({ sugestoes: response.content[0]?.text, turnos_actuais: turnos.rows.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── VISÃO SEMANAL ──

router.get('/semana', async (req, res) => {
  try {
    const { data } = req.query;
    const d = new Date(data || new Date());
    const inicio = new Date(d);
    inicio.setDate(d.getDate() - d.getDay() + 1);
    const fim = new Date(inicio);
    fim.setDate(inicio.getDate() + 6);

    const [turnos, funcionarios] = await Promise.all([
      query(`SELECT t.*, f.nome_completo, f.departamento, f.cargo
        FROM turno t JOIN funcionario f ON f.id=t.funcionario_id
        WHERE t.empresa_id=$1 AND t.data BETWEEN $2 AND $3
        ORDER BY f.departamento, f.nome_completo, t.data`, [req.empresaId, inicio.toISOString().slice(0,10), fim.toISOString().slice(0,10)]),
      query(`SELECT id, nome_completo, departamento, cargo FROM funcionario WHERE empresa_id=$1 AND estado='ativo' ORDER BY departamento, nome_completo`, [req.empresaId]),
    ]);

    // Agrupar por funcionário
    const grid = {};
    for (const f of funcionarios.rows) {
      grid[f.id] = { funcionario: f, turnos: {} };
    }
    for (const t of turnos.rows) {
      if (grid[t.funcionario_id]) {
        grid[t.funcionario_id].turnos[t.data] = t;
      }
    }

    const dias = [];
    for (let i = 0; i < 7; i++) {
      const dia = new Date(inicio);
      dia.setDate(inicio.getDate() + i);
      dias.push(dia.toISOString().slice(0,10));
    }

    res.json({ semana_inicio: inicio.toISOString().slice(0,10), dias, funcionarios: Object.values(grid) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
