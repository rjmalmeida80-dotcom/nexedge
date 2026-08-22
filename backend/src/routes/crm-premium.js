'use strict';
/**
 * NexEdge — CRM Premium
 * Pipeline visual, lead scoring IA, previsão vendas, sequências email
 * Supera: Salesforce, HubSpot, Pipedrive
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const Anthropic = require('@anthropic-ai/sdk');

router.use(autenticar);
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

// ── PIPELINE DE VENDAS ──

router.get('/pipeline', async (req, res) => {
  try {
    const { responsavel_id } = req.query;
    const conds = ['o.empresa_id=$1'], params = [req.empresaId];
    if (responsavel_id) { conds.push(`o.responsavel_id=$2`); params.push(responsavel_id); }

    const r = await query(`
      SELECT o.*,
        c.nome as cliente_nome, c.email as cliente_email, c.telefone as cliente_tel,
        u.nome_completo as responsavel_nome,
        EXTRACT(DAY FROM NOW() - o.criado_em) as dias_no_pipeline,
        CASE WHEN o.data_fecho_prevista < NOW() AND o.estado NOT IN ('ganho','perdido')
          THEN true ELSE false END as atrasada
      FROM oportunidade o
      LEFT JOIN cliente c ON c.id=o.cliente_id
      LEFT JOIN utilizador u ON u.id=o.responsavel_id
      WHERE ${conds.join(' AND ')} AND o.estado NOT IN ('ganho','perdido')
      ORDER BY o.valor DESC
    `, params);

    // Agrupar por etapa
    const etapas = ['lead','qualificado','proposta','negociacao','decisao'];
    const pipeline = {};
    let totalValor = 0, totalPonderado = 0;

    for (const etapa of etapas) {
      const opps = r.rows.filter(o => o.etapa === etapa);
      const probMap = { lead:10, qualificado:25, proposta:50, negociacao:75, decisao:90 };
      pipeline[etapa] = {
        oportunidades: opps,
        total: opps.length,
        valor: opps.reduce((s,o) => s + parseFloat(o.valor||0), 0),
        valor_ponderado: opps.reduce((s,o) => s + parseFloat(o.valor||0) * (o.probabilidade||probMap[etapa]||50) / 100, 0),
      };
      totalValor += pipeline[etapa].valor;
      totalPonderado += pipeline[etapa].valor_ponderado;
    }

    res.json({ pipeline, total_valor: totalValor, total_ponderado: totalPonderado, total_oportunidades: r.rows.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── OPORTUNIDADES ──

router.get('/oportunidades', async (req, res) => {
  try {
    const { estado, etapa, responsavel_id, limite=100 } = req.query;
    const conds = ['o.empresa_id=$1'], params = [req.empresaId];
    let n = 2;
    if (estado) { conds.push(`o.estado=$${n++}`); params.push(estado); }
    if (etapa) { conds.push(`o.etapa=$${n++}`); params.push(etapa); }
    if (responsavel_id) { conds.push(`o.responsavel_id=$${n++}`); params.push(responsavel_id); }
    params.push(parseInt(limite));

    const r = await query(`
      SELECT o.*, c.nome as cliente_nome, u.nome_completo as responsavel_nome,
        (SELECT COUNT(*) FROM crm_actividade WHERE oportunidade_id=o.id) as num_actividades,
        (SELECT MAX(criado_em) FROM crm_actividade WHERE oportunidade_id=o.id) as ultima_actividade
      FROM oportunidade o
      LEFT JOIN cliente c ON c.id=o.cliente_id
      LEFT JOIN utilizador u ON u.id=o.responsavel_id
      WHERE ${conds.join(' AND ')}
      ORDER BY o.criado_em DESC LIMIT $${n}
    `, params);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/oportunidades', async (req, res) => {
  try {
    const d = req.body;
    const r = await query(`
      INSERT INTO oportunidade (
        empresa_id, cliente_id, titulo, descricao, valor, moeda,
        etapa, estado, probabilidade, data_fecho_prevista,
        responsavel_id, origem, tags, campos_extra
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING *
    `, [
      req.empresaId, d.cliente_id||null, d.titulo, d.descricao||'',
      d.valor||0, d.moeda||'EUR', d.etapa||'lead', 'aberta',
      d.probabilidade||10, d.data_fecho_prevista||null,
      d.responsavel_id||req.utilizador.id,
      d.origem||'manual', JSON.stringify(d.tags||[]),
      JSON.stringify(d.campos_extra||{})
    ]);

    // Lead scoring automático
    if (anthropic && d.descricao) {
      scoringIA(r.rows[0].id, d).catch(()=>{});
    }

    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/oportunidades/:id', async (req, res) => {
  try {
    const d = req.body;
    const campos = ['titulo','descricao','valor','etapa','estado','probabilidade','data_fecho_prevista','responsavel_id','motivo_perda'];
    const updates = [], params = [];
    let n = 1;
    for (const c of campos) {
      if (d[c] !== undefined) { updates.push(`${c}=$${n++}`); params.push(d[c]); }
    }

    // Se ganho/perdido, registar data
    if (d.estado === 'ganho') { updates.push(`data_fecho=$${n++}`); params.push(new Date()); updates.push(`etapa='fechado'`); }
    if (d.estado === 'perdido') { updates.push(`data_fecho=$${n++}`); params.push(new Date()); }

    params.push(req.params.id);
    await query(`UPDATE oportunidade SET ${updates.join(',')} WHERE id=$${n} AND empresa_id='${req.empresaId}'`, params);

    // Registar actividade automática se etapa mudou
    if (d.etapa) {
      await query(`INSERT INTO crm_actividade (empresa_id, oportunidade_id, tipo, titulo, criado_por)
        VALUES ($1,$2,'sistema','Etapa alterada para: '+$3,$4)`,
        [req.empresaId, req.params.id, d.etapa, req.utilizador.id]).catch(()=>{});
    }

    const r = await query(`SELECT * FROM oportunidade WHERE id=$1`, [req.params.id]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── LEAD SCORING COM IA ──

async function scoringIA(oportunidadeId, dados) {
  if (!anthropic) return;
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `Analisa esta oportunidade de venda e dá um score de 1-100 e probabilidade de fecho em %.

Título: ${dados.titulo}
Descrição: ${dados.descricao}
Valor: ${dados.valor}€
Origem: ${dados.origem||'manual'}
Etapa: ${dados.etapa||'lead'}

Responde APENAS em JSON:
{"score": 75, "probabilidade": 65, "razoes": ["razão 1", "razão 2"], "proximas_acoes": ["acção 1", "acção 2"], "risco": "baixo|medio|alto"}`
      }]
    });

    const texto = response.content[0]?.text;
    const json = JSON.parse(texto.match(/\{.*\}/s)?.[0] || '{}');
    if (json.score) {
      await query(`UPDATE oportunidade SET score_ia=$1, probabilidade=$2, analise_ia=$3 WHERE id=$4`,
        [json.score, json.probabilidade||null, JSON.stringify(json), oportunidadeId]);
    }
  } catch(e) {}
}

router.post('/oportunidades/:id/scoring', async (req, res) => {
  try {
    const r = await query(`SELECT * FROM oportunidade WHERE id=$1 AND empresa_id=$2`, [req.params.id, req.empresaId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Não encontrado' });
    await scoringIA(req.params.id, r.rows[0]);
    const updated = await query(`SELECT * FROM oportunidade WHERE id=$1`, [req.params.id]);
    res.json(updated.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ACTIVIDADES CRM ──

router.get('/actividades', async (req, res) => {
  try {
    const { oportunidade_id, cliente_id } = req.query;
    const conds = ['a.empresa_id=$1'], params = [req.empresaId];
    let n = 2;
    if (oportunidade_id) { conds.push(`a.oportunidade_id=$${n++}`); params.push(oportunidade_id); }
    if (cliente_id) { conds.push(`a.cliente_id=$${n++}`); params.push(cliente_id); }

    const r = await query(`
      SELECT a.*, u.nome_completo as criado_por_nome,
        o.titulo as oportunidade_titulo, c.nome as cliente_nome
      FROM crm_actividade a
      LEFT JOIN utilizador u ON u.id=a.criado_por
      LEFT JOIN oportunidade o ON o.id=a.oportunidade_id
      LEFT JOIN cliente c ON c.id=a.cliente_id
      WHERE ${conds.join(' AND ')}
      ORDER BY a.criado_em DESC LIMIT 100
    `, params);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/actividades', async (req, res) => {
  try {
    const { tipo, titulo, descricao, oportunidade_id, cliente_id, data_agendada, duracao_min } = req.body;
    const r = await query(`
      INSERT INTO crm_actividade (empresa_id, tipo, titulo, descricao, oportunidade_id, cliente_id, data_agendada, duracao_min, criado_por, estado)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'realizada') RETURNING *
    `, [req.empresaId, tipo||'nota', titulo, descricao||'', oportunidade_id||null, cliente_id||null, data_agendada||null, duracao_min||null, req.utilizador.id]);
    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PREVISÃO DE VENDAS COM IA ──

router.get('/previsao', async (req, res) => {
  try {
    const { meses = 3 } = req.query;

    const [pipeline, historico] = await Promise.all([
      query(`SELECT etapa, SUM(valor) as valor, SUM(valor*probabilidade/100) as ponderado, COUNT(*) as total
        FROM oportunidade WHERE empresa_id=$1 AND estado='aberta'
        GROUP BY etapa`, [req.empresaId]),
      query(`SELECT TO_CHAR(data_fecho,'YYYY-MM') as mes, SUM(valor) as valor, COUNT(*) as total
        FROM oportunidade WHERE empresa_id=$1 AND estado='ganho' AND data_fecho > NOW()-INTERVAL '12 months'
        GROUP BY mes ORDER BY mes`, [req.empresaId]),
    ]);

    const totalPipeline = pipeline.rows.reduce((s,r) => s + parseFloat(r.ponderado||0), 0);
    const mediaHistorica = historico.rows.length ? historico.rows.reduce((s,r)=>s+parseFloat(r.valor),0) / historico.rows.length : 0;

    // Previsão simples: média histórica + tendência do pipeline
    const previsao = [];
    for (let i = 1; i <= parseInt(meses); i++) {
      const data = new Date();
      data.setMonth(data.getMonth() + i);
      previsao.push({
        mes: data.toISOString().slice(0,7),
        previsao_base: Math.round(mediaHistorica),
        previsao_pipeline: Math.round(totalPipeline / parseInt(meses)),
        previsao_total: Math.round(mediaHistorica * 0.6 + totalPipeline / parseInt(meses) * 0.4),
        confianca: Math.max(50, 85 - i * 10),
      });
    }

    // Análise IA se disponível
    let analise_ia = null;
    if (anthropic && historico.rows.length > 2) {
      try {
        const response = await anthropic.messages.create({
          model: 'claude-sonnet-4-6', max_tokens: 600,
          messages: [{ role:'user', content: `Analisa estes dados de vendas e dá insights em PT-PT (máx 150 palavras):
Pipeline total: ${totalPipeline.toFixed(0)}€
Média histórica mensal: ${mediaHistorica.toFixed(0)}€
Histórico: ${JSON.stringify(historico.rows)}
Responde com texto simples, sem markdown.` }]
        });
        analise_ia = response.content[0]?.text;
      } catch(e) {}
    }

    res.json({ previsao, pipeline: pipeline.rows, historico: historico.rows, analise_ia });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── MÉTRICAS CRM ──

router.get('/metricas', async (req, res) => {
  try {
    const [resumo, taxaConversao, cicloVenda, porOrigem] = await Promise.all([
      query(`SELECT
        COUNT(*) FILTER (WHERE estado='aberta') as abertas,
        COUNT(*) FILTER (WHERE estado='ganho') as ganhas,
        COUNT(*) FILTER (WHERE estado='perdido') as perdidas,
        COUNT(*) FILTER (WHERE estado='ganho' AND data_fecho > NOW()-INTERVAL '30 days') as ganhas_30d,
        SUM(valor) FILTER (WHERE estado='ganho' AND data_fecho > NOW()-INTERVAL '30 days') as valor_ganho_30d,
        AVG(valor) FILTER (WHERE estado='ganho') as ticket_medio,
        SUM(valor) FILTER (WHERE estado='aberta') as pipeline_total
        FROM oportunidade WHERE empresa_id=$1`, [req.empresaId]),
      query(`SELECT
        COUNT(*) FILTER (WHERE estado='ganho')::float / NULLIF(COUNT(*),0) * 100 as taxa
        FROM oportunidade WHERE empresa_id=$1 AND criado_em > NOW()-INTERVAL '90 days'`, [req.empresaId]),
      query(`SELECT AVG(EXTRACT(DAY FROM data_fecho - criado_em)) as dias
        FROM oportunidade WHERE empresa_id=$1 AND estado='ganho' AND data_fecho IS NOT NULL`, [req.empresaId]),
      query(`SELECT origem, COUNT(*) as total, SUM(valor) FILTER (WHERE estado='ganho') as valor_ganho
        FROM oportunidade WHERE empresa_id=$1 GROUP BY origem ORDER BY total DESC`, [req.empresaId]),
    ]);

    res.json({
      ...resumo.rows[0],
      taxa_conversao: parseFloat(taxaConversao.rows[0]?.taxa||0).toFixed(1),
      ciclo_venda_dias: Math.round(parseFloat(cicloVenda.rows[0]?.dias||0)),
      por_origem: porOrigem.rows,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
