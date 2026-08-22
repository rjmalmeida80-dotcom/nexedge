'use strict';
/**
 * NexEdge — Portal do Fornecedor
 * Acesso seguro para fornecedores: enviar facturas, ver encomendas, pagamentos
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// Auth portal fornecedor
async function autenticarFornecedor(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Não autenticado' });
  try {
    const decoded = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
    if (decoded.tipo === 'portal_fornecedor') {
      req.fornecedorId = decoded.fornecedor_id;
      req.empresaId = decoded.empresa_id;
    } else {
      // Token normal ERP
      req.fornecedorId = null;
      req.empresaId = decoded.empresa;
      req.isAdmin = true;
    }
    next();
  } catch(e) { res.status(401).json({ error: 'Token inválido' }); }
}

// ── AUTH ──
router.post('/auth', async (req, res) => {
  try {
    const { email, codigo } = req.body;
    const r = await query(`
      SELECT f.*, e.id as empresa_id, e.nome as empresa_nome
      FROM fornecedor f JOIN empresa e ON e.id=f.empresa_id
      WHERE f.email=$1 AND f.portal_codigo=$2
        AND f.portal_codigo_expira > NOW() AND f.ativo=true
    `, [email, codigo]);
    if (!r.rows.length) return res.status(401).json({ error: 'Código inválido ou expirado' });

    const forn = r.rows[0];
    await query(`UPDATE fornecedor SET portal_codigo=NULL, portal_codigo_expira=NULL, portal_ultimo_acesso=NOW() WHERE id=$1`, [forn.id]);

    const token = jwt.sign({ tipo:'portal_fornecedor', fornecedor_id:forn.id, empresa_id:forn.empresa_id },
      process.env.JWT_SECRET, { expiresIn:'7d' });

    res.json({ token, fornecedor: { id:forn.id, nome:forn.nome, email:forn.email, empresa:forn.empresa_nome } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/pedir-acesso', async (req, res) => {
  try {
    const { email } = req.body;
    const r = await query(`SELECT * FROM fornecedor WHERE email=$1 AND ativo=true LIMIT 1`, [email]);
    if (!r.rows.length) return res.json({ ok: true });

    const codigo = Math.random().toString(36).slice(2,8).toUpperCase();
    await query(`UPDATE fornecedor SET portal_codigo=$1, portal_codigo_expira=$2 WHERE id=$3`,
      [codigo, new Date(Date.now()+15*60000), r.rows[0].id]);

    try {
      const { enviarEmail } = require('../services/emailService');
      await enviarEmail({ to: email, subject: 'Código de acesso — Portal Fornecedor NexEdge',
        html: `<div style="font-family:Inter,sans-serif;max-width:500px">
          <h2 style="color:#4f46e5">Portal do Fornecedor</h2>
          <p>O teu código de acesso é:</p>
          <div style="font-size:32px;font-weight:700;letter-spacing:4px;color:#4f46e5;padding:20px;background:#eef2ff;border-radius:10px;text-align:center">${codigo}</div>
          <p style="color:#6b7280;font-size:13px">Válido por 15 minutos.</p>
        </div>` });
    } catch(e) {}
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.use(autenticarFornecedor);

// ── ENCOMENDAS ──
router.get('/encomendas', async (req, res) => {
  try {
    const cond = req.fornecedorId ? 'pc.fornecedor_id=$1' : 'pc.empresa_id=$1';
    const param = req.fornecedorId || req.empresaId;
    const r = await query(`
      SELECT pc.*, f.nome as fornecedor_nome
      FROM pedido_compra pc
      JOIN fornecedor f ON f.id=pc.fornecedor_id
      WHERE ${cond} ORDER BY pc.criado_em DESC LIMIT 50
    `, [param]).catch(() => ({ rows: [] }));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── FACTURAS ENVIADAS ──
router.get('/facturas', async (req, res) => {
  try {
    const cond = req.fornecedorId ? 'fornecedor_id=$1' : 'empresa_id=$1';
    const r = await query(`
      SELECT * FROM despesa WHERE ${cond} AND tipo='fatura_fornecedor'
      ORDER BY data_despesa DESC LIMIT 50
    `, [req.fornecedorId||req.empresaId]).catch(() => ({ rows: [] }));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Submeter factura
router.post('/facturas', async (req, res) => {
  try {
    const { numero_fatura, valor_total, data_emissao, data_vencimento, descricao, pedido_compra_id } = req.body;
    if (!valor_total || !data_emissao) return res.status(400).json({ error: 'Valor e data obrigatórios' });

    const r = await query(`
      INSERT INTO despesa (empresa_id, fornecedor_id, tipo, descricao, valor_total,
        data_despesa, data_vencimento, estado, referencia, pedido_compra_id)
      VALUES ($1,$2,'fatura_fornecedor',$3,$4,$5,$6,'pendente',$7,$8) RETURNING *
    `, [
      req.empresaId, req.fornecedorId||null,
      descricao||'Factura fornecedor', parseFloat(valor_total),
      data_emissao, data_vencimento||null,
      numero_fatura||null, pedido_compra_id||null
    ]);
    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PAGAMENTOS ──
router.get('/pagamentos', async (req, res) => {
  try {
    const r = await query(`
      SELECT p.*, d.referencia as fatura_numero
      FROM pagamento p LEFT JOIN despesa d ON d.id=p.despesa_id
      WHERE p.${req.fornecedorId?'fornecedor_id':'empresa_id'}=$1
      ORDER BY p.data_pagamento DESC LIMIT 50
    `, [req.fornecedorId||req.empresaId]).catch(() => ({ rows: [] }));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CATÁLOGO DE PRODUTOS ──
router.get('/catalogo', async (req, res) => {
  try {
    const r = await query(`
      SELECT fp.*, p.nome as produto_nome
      FROM fornecedor_produto fp
      JOIN produto p ON p.id=fp.produto_id
      WHERE fp.fornecedor_id=$1
      ORDER BY p.nome
    `, [req.fornecedorId||'00000000-0000-0000-0000-000000000000']).catch(() => ({ rows: [] }));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Actualizar preço do produto
router.put('/catalogo/:produtoId', async (req, res) => {
  try {
    const { preco, disponivel, prazo_entrega } = req.body;
    await query(`
      INSERT INTO fornecedor_produto (fornecedor_id, produto_id, preco, disponivel, prazo_entrega)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (fornecedor_id, produto_id) DO UPDATE SET preco=$3, disponivel=$4, prazo_entrega=$5
    `, [req.fornecedorId, req.params.produtoId, preco, disponivel!==false, prazo_entrega||0]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DOCUMENTOS ──
router.get('/documentos', async (req, res) => {
  try {
    const r = await query(`
      SELECT * FROM documento WHERE empresa_id=$1 AND partilhado_fornecedor=true
      ORDER BY criado_em DESC LIMIT 50
    `, [req.empresaId]).catch(() => ({ rows: [] }));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
