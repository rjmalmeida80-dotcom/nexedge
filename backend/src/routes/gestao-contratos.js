'use strict';
/**
 * NexEdge — Gestão de Contratos
 * Ciclo de vida completo: criação, negociação, assinatura, renovação, término
 * Supera: DocuSign CLM, ContractSafe
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { autenticar } = require('../middleware/auth');

router.use(autenticar);

router.get('/', async (req, res) => {
  try {
    const { tipo, estado, expira_em } = req.query;
    const conds = ['c.empresa_id=$1'], params = [req.empresaId];
    let n = 2;
    if (tipo) { conds.push(`c.tipo=$${n++}`); params.push(tipo); }
    if (estado) { conds.push(`c.estado=$${n++}`); params.push(estado); }
    if (expira_em === '30dias') { conds.push(`c.data_fim BETWEEN NOW() AND NOW()+INTERVAL '30 days'`); }
    if (expira_em === '90dias') { conds.push(`c.data_fim BETWEEN NOW() AND NOW()+INTERVAL '90 days'`); }

    const r = await query(`
      SELECT c.*,
        CASE WHEN c.data_fim IS NOT NULL THEN EXTRACT(DAY FROM c.data_fim - NOW()) END as dias_para_expirar,
        cl.nome as cliente_nome, f.nome as fornecedor_nome,
        u.nome_completo as responsavel_nome
      FROM contrato c
      LEFT JOIN cliente cl ON cl.id=c.cliente_id
      LEFT JOIN fornecedor f ON f.id=c.fornecedor_id
      LEFT JOIN utilizador u ON u.id=c.responsavel_id
      WHERE ${conds.join(' AND ')}
      ORDER BY c.data_fim ASC NULLS LAST
    `, params).catch(()=>({rows:[]}));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const d = req.body;
    const r = await query(`
      INSERT INTO contrato (
        empresa_id, titulo, tipo, descricao, cliente_id, fornecedor_id,
        valor, moeda, data_inicio, data_fim, renovacao_automatica,
        aviso_renovacao_dias, responsavel_id, estado, clausulas, tags
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'rascunho',$14,$15)
      RETURNING *
    `, [
      req.empresaId, d.titulo, d.tipo||'servicos', d.descricao||'',
      d.cliente_id||null, d.fornecedor_id||null,
      d.valor||0, d.moeda||'EUR',
      d.data_inicio||null, d.data_fim||null,
      d.renovacao_automatica||false, d.aviso_renovacao_dias||30,
      d.responsavel_id||req.utilizador.id,
      JSON.stringify(d.clausulas||[]), JSON.stringify(d.tags||[])
    ]);
    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', async (req, res) => {
  try {
    const d = req.body;
    const campos = ['titulo','tipo','descricao','valor','estado','data_inicio','data_fim','renovacao_automatica','aviso_renovacao_dias','clausulas'];
    const updates = [], params = [];
    let n = 1;
    for (const c of campos) { if(d[c]!==undefined){updates.push(`${c}=$${n++}`);params.push(d[c]);}}
    params.push(req.params.id);
    await query(`UPDATE contrato SET ${updates.join(',')} WHERE id=$${n} AND empresa_id='${req.empresaId}'`, params);
    const r = await query(`SELECT * FROM contrato WHERE id=$1`, [req.params.id]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Alertas de renovação/expiração
router.get('/alertas', async (req, res) => {
  try {
    const r = await query(`
      SELECT c.titulo, c.tipo, c.data_fim, c.renovacao_automatica,
        c.valor, cl.nome as cliente_nome, f.nome as fornecedor_nome,
        EXTRACT(DAY FROM c.data_fim - NOW()) as dias_para_expirar
      FROM contrato c
      LEFT JOIN cliente cl ON cl.id=c.cliente_id
      LEFT JOIN fornecedor f ON f.id=c.fornecedor_id
      WHERE c.empresa_id=$1 AND c.estado='ativo'
        AND c.data_fim IS NOT NULL
        AND c.data_fim BETWEEN NOW() AND NOW() + INTERVAL '90 days'
      ORDER BY c.data_fim ASC
    `, [req.empresaId]).catch(()=>({rows:[]}));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Renovar contrato
router.post('/:id/renovar', async (req, res) => {
  try {
    const { nova_data_fim, novo_valor } = req.body;
    const old = await query(`SELECT * FROM contrato WHERE id=$1 AND empresa_id=$2`, [req.params.id, req.empresaId]);
    if (!old.rows.length) return res.status(404).json({ error: 'Contrato não encontrado' });
    const c = old.rows[0];

    // Criar nova versão
    const r = await query(`
      INSERT INTO contrato (empresa_id,titulo,tipo,descricao,cliente_id,fornecedor_id,valor,moeda,data_inicio,data_fim,renovacao_automatica,aviso_renovacao_dias,responsavel_id,estado,clausulas,tags,contrato_pai_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'ativo',$14,$15,$16) RETURNING *
    `, [req.empresaId, c.titulo+' (Renovação)', c.tipo, c.descricao, c.cliente_id, c.fornecedor_id,
        novo_valor||c.valor, c.moeda, c.data_fim, nova_data_fim,
        c.renovacao_automatica, c.aviso_renovacao_dias, c.responsavel_id,
        c.clausulas, c.tags, c.id]);

    // Marcar original como renovado
    await query(`UPDATE contrato SET estado='renovado' WHERE id=$1`, [req.params.id]);
    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Dashboard
router.get('/dashboard', async (req, res) => {
  try {
    const r = await query(`SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE estado='ativo') as ativos,
      COUNT(*) FILTER (WHERE estado='rascunho') as rascunhos,
      COUNT(*) FILTER (WHERE data_fim BETWEEN NOW() AND NOW()+INTERVAL '30 days' AND estado='ativo') as a_renovar_30d,
      SUM(valor) FILTER (WHERE estado='ativo') as valor_total,
      COUNT(*) FILTER (WHERE tipo='clientes') as contratos_clientes,
      COUNT(*) FILTER (WHERE tipo='fornecedores') as contratos_fornecedores
      FROM contrato WHERE empresa_id=$1`, [req.empresaId]).catch(()=>({rows:[{}]}));
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
