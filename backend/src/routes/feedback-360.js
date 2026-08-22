'use strict';
/**
 * NexEdge — 360° Feedback & Avaliações de Desempenho
 * Feedback anónimo multi-fonte, PDI, calibração
 * Supera: Lattice, Culture Amp, 15Five
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const Anthropic = require('@anthropic-ai/sdk');

router.use(autenticar);
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

// ── CICLOS DE AVALIAÇÃO ──

router.get('/ciclos', async (req, res) => {
  try {
    const r = await query(`SELECT c.*,
      (SELECT COUNT(*) FROM avaliacao_360 WHERE ciclo_id=c.id) as num_avaliacoes,
      (SELECT COUNT(DISTINCT avaliado_id) FROM avaliacao_360 WHERE ciclo_id=c.id) as num_avaliados
      FROM avaliacao_ciclo c WHERE c.empresa_id=$1 ORDER BY c.criado_em DESC`, [req.empresaId]).catch(()=>({rows:[]}));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/ciclos', async (req, res) => {
  try {
    const { nome, tipo, data_inicio, data_fim, competencias, anonimo, auto_avaliacao } = req.body;
    const r = await query(`
      INSERT INTO avaliacao_ciclo (empresa_id, nome, tipo, data_inicio, data_fim, competencias, anonimo, auto_avaliacao, estado)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'planeamento') RETURNING *
    `, [req.empresaId, nome, tipo||'360', data_inicio, data_fim,
        JSON.stringify(competencias||defaultCompetencias()), anonimo!==false, auto_avaliacao!==false]);
    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

function defaultCompetencias() {
  return [
    { id:'comunicacao', titulo:'Comunicação', descricao:'Clareza e eficácia na comunicação', peso:20 },
    { id:'trabalho_equipa', titulo:'Trabalho em Equipa', descricao:'Colaboração e suporte aos colegas', peso:20 },
    { id:'iniciativa', titulo:'Iniciativa & Autonomia', descricao:'Proactividade e resolução de problemas', peso:20 },
    { id:'qualidade', titulo:'Qualidade do Trabalho', descricao:'Rigor e excelência nos resultados', peso:20 },
    { id:'lideranca', titulo:'Liderança', descricao:'Influência positiva e desenvolvimento da equipa', peso:20 },
  ];
}

// ── AVALIAÇÕES ──

router.post('/avaliacoes', async (req, res) => {
  try {
    const { ciclo_id, avaliado_id, tipo_relacao, respostas, comentario_geral } = req.body;
    // tipo_relacao: 'supervisor','par','subordinado','auto'

    const r = await query(`
      INSERT INTO avaliacao_360 (ciclo_id, empresa_id, avaliador_id, avaliado_id, tipo_relacao, respostas, comentario_geral, estado)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'submetida') RETURNING *
    `, [ciclo_id, req.empresaId, req.utilizador.id, avaliado_id, tipo_relacao||'par',
        JSON.stringify(respostas||{}), comentario_geral||'']);
    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Resultado consolidado de um avaliado
router.get('/resultados/:funcionarioId', async (req, res) => {
  try {
    const { ciclo_id } = req.query;
    const conds = ['a.avaliado_id=$1','a.empresa_id=$2'], params = [req.params.funcionarioId, req.empresaId];
    if (ciclo_id) { conds.push('a.ciclo_id=$3'); params.push(ciclo_id); }

    const avaliacoes = await query(`
      SELECT a.*, c.competencias, c.anonimo,
        CASE WHEN c.anonimo THEN NULL ELSE u.nome_completo END as avaliador_nome
      FROM avaliacao_360 a
      JOIN avaliacao_ciclo c ON c.id=a.ciclo_id
      LEFT JOIN utilizador u ON u.id=a.avaliador_id
      WHERE ${conds.join(' AND ')} AND a.estado='submetida'
    `, params);

    if (!avaliacoes.rows.length) return res.json({ avaliacoes: [], media_geral: null });

    // Calcular médias por competência e por tipo de relação
    const competencias = typeof avaliacoes.rows[0].competencias === 'string'
      ? JSON.parse(avaliacoes.rows[0].competencias) : avaliacoes.rows[0].competencias || [];

    const mediasPorComp = {};
    const mediasPorRelacao = { supervisor:[], par:[], subordinado:[], auto:[] };

    for (const av of avaliacoes.rows) {
      const respostas = typeof av.respostas === 'string' ? JSON.parse(av.respostas) : (av.respostas||{});
      mediasPorRelacao[av.tipo_relacao]?.push(respostas);
      for (const [comp, nota] of Object.entries(respostas)) {
        if (!mediasPorComp[comp]) mediasPorComp[comp] = [];
        mediasPorComp[comp].push(parseFloat(nota));
      }
    }

    const resultadoCompetencias = competencias.map(c => ({
      ...c,
      media: mediasPorComp[c.id]?.length ? (mediasPorComp[c.id].reduce((a,b)=>a+b,0)/mediasPorComp[c.id].length).toFixed(1) : null,
      num_respostas: mediasPorComp[c.id]?.length || 0,
    }));

    const mediaGeral = resultadoCompetencias.filter(c=>c.media).length
      ? (resultadoCompetencias.filter(c=>c.media).reduce((s,c)=>s+parseFloat(c.media)*c.peso/100,0)).toFixed(1)
      : null;

    // Análise IA dos comentários
    let analise_ia = null;
    const comentarios = avaliacoes.rows.map(a=>a.comentario_geral).filter(Boolean);
    if (anthropic && comentarios.length > 1) {
      try {
        const response = await anthropic.messages.create({
          model:'claude-sonnet-4-6', max_tokens:800,
          messages:[{role:'user', content:`Analisa estes comentários de avaliação 360° e gera um sumário executivo em PT-PT (máx 200 palavras):
- Pontos fortes identificados
- Áreas de melhoria
- Padrões nos comentários
- Recomendação de desenvolvimento

Comentários: ${comentarios.join('\n---\n')}`}]
        });
        analise_ia = response.content[0]?.text;
      } catch(e) {}
    }

    res.json({
      total_avaliacoes: avaliacoes.rows.length,
      media_geral: mediaGeral,
      competencias: resultadoCompetencias,
      por_relacao: {
        supervisor: mediasPorRelacao.supervisor.length,
        par: mediasPorRelacao.par.length,
        subordinado: mediasPorRelacao.subordinado.length,
        auto: mediasPorRelacao.auto.length,
      },
      comentarios: avaliacoes.rows[0]?.anonimo ? null : avaliacoes.rows.map(a=>({tipo:a.tipo_relacao, comentario:a.comentario_geral})).filter(a=>a.comentario),
      analise_ia,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PDI — Plano de Desenvolvimento Individual
router.get('/pdi/:funcionarioId', async (req, res) => {
  try {
    const r = await query(`SELECT * FROM pdi WHERE funcionario_id=$1 AND empresa_id=$2 ORDER BY criado_em DESC LIMIT 1`, [req.params.funcionarioId, req.empresaId]).catch(()=>({rows:[]}));
    res.json(r.rows[0] || null);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/pdi/:funcionarioId', async (req, res) => {
  try {
    const { objetivos_desenvolvimento, acoes, recursos, prazo, avaliacao_id } = req.body;
    const r = await query(`
      INSERT INTO pdi (empresa_id, funcionario_id, avaliacao_id, objetivos_desenvolvimento, acoes, recursos, prazo, estado)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'activo')
      ON CONFLICT (empresa_id, funcionario_id) DO UPDATE SET objetivos_desenvolvimento=$4, acoes=$5, recursos=$6, prazo=$7, estado='activo'
      RETURNING *
    `, [req.empresaId, req.params.funcionarioId, avaliacao_id||null,
        objetivos_desenvolvimento||'', JSON.stringify(acoes||[]), recursos||'', prazo||null]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
