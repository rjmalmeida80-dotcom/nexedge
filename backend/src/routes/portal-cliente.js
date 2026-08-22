'use strict';
const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// Auth do portal cliente (aceita token portal OU token normal ERP)
async function autenticarPortal(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Não autenticado' });
  try {
    const decoded = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
    if (decoded.tipo === 'portal_cliente') {
      req.clienteId = decoded.cliente_id;
      req.empresaId = decoded.empresa_id;
    } else {
      // Token normal do ERP — admin ou utilizador
      req.clienteId = null;
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
    if (!email || !codigo) return res.status(400).json({ error: 'Email e código obrigatórios' });

    const r = await query(`
      SELECT c.*, e.id as empresa_id, e.nome as empresa_nome
      FROM cliente c
      JOIN empresa e ON e.id=c.empresa_id
      WHERE c.email=$1 AND c.portal_codigo=$2
        AND c.portal_codigo_expira > NOW()
        AND c.ativo=true
    `, [email, codigo]);

    if (!r.rows.length) return res.status(401).json({ error: 'Código inválido ou expirado' });

    const cliente = r.rows[0];
    // Limpar código usado
    await query(`UPDATE cliente SET portal_codigo=NULL, portal_codigo_expira=NULL, portal_ultimo_acesso=NOW() WHERE id=$1`, [cliente.id]);

    const token = jwt.sign(
      { tipo: 'portal_cliente', cliente_id: cliente.id, empresa_id: cliente.empresa_id },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      cliente: { id: cliente.id, nome: cliente.nome, email: cliente.email, empresa: cliente.empresa_nome }
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/pedir-acesso', async (req, res) => {
  try {
    const { email } = req.body;
    const r = await query(`SELECT * FROM cliente WHERE email=$1 AND ativo=true LIMIT 1`, [email]);
    if (!r.rows.length) return res.json({ ok: true }); // Não revelar se existe

    const codigo = Math.random().toString(36).slice(2,8).toUpperCase();
    const expira = new Date(Date.now() + 15*60*1000); // 15 min

    await query(`UPDATE cliente SET portal_codigo=$1, portal_codigo_expira=$2 WHERE id=$3`, [codigo, expira, r.rows[0].id]);

    // Enviar email (se emailService disponível)
    try {
      const { enviarEmail } = require('../services/emailService');
      await enviarEmail({
        to: email,
        subject: 'Código de acesso ao Portal do Cliente NexEdge',
        html: `<div style="font-family:Inter,sans-serif;max-width:500px">
          <h2 style="color:#4f46e5">Código de Acesso</h2>
          <p>O teu código de acesso ao Portal do Cliente é:</p>
          <div style="font-size:32px;font-weight:700;letter-spacing:4px;color:#4f46e5;padding:20px;background:#eef2ff;border-radius:10px;text-align:center;margin:16px 0">${codigo}</div>
          <p style="color:#6b7280;font-size:13px">Válido por 15 minutos. Se não pediste este código, ignora este email.</p>
        </div>`
      });
    } catch(e) {}

    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.use(autenticarPortal);

// ── FATURAS ──
router.get('/faturas', async (req, res) => {
  try {
    const cond = req.clienteId ? 'f.cliente_id=$1' : 'f.empresa_id=$1';
    const param = req.clienteId || req.empresaId;

    const [faturas, resumo] = await Promise.all([
      query(`SELECT f.*, c.nome as cliente_nome FROM fatura f
        LEFT JOIN cliente c ON c.id=f.cliente_id
        WHERE ${cond} ORDER BY f.data_emissao DESC LIMIT 50`, [param]),
      query(`SELECT
        SUM(total) as total_faturado,
        SUM(CASE WHEN estado='paga' THEN total ELSE 0 END) as total_pago,
        SUM(CASE WHEN estado!='paga' THEN total ELSE 0 END) as total_pendente,
        COUNT(CASE WHEN estado='emitida' AND data_vencimento < NOW() THEN 1 END) as num_vencidas
        FROM fatura WHERE ${cond}`, [param]),
    ]);

    res.json({ faturas: faturas.rows, resumo: resumo.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PAGAMENTOS ──
router.get('/pagamentos', async (req, res) => {
  try {
    const r = await query(`
      SELECT p.*, f.numero as fatura_numero
      FROM pagamento p
      LEFT JOIN fatura f ON f.id=p.fatura_id
      WHERE p.${req.clienteId?'cliente_id':'empresa_id'}=$1
      ORDER BY p.data_pagamento DESC LIMIT 50
    `, [req.clienteId||req.empresaId]).catch(() => ({ rows: [] }));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ENCOMENDAS ──
router.get('/encomendas', async (req, res) => {
  try {
    const r = await query(`
      SELECT e.*, COUNT(le.id) as num_itens
      FROM encomenda e
      LEFT JOIN linha_encomenda le ON le.encomenda_id=e.id
      WHERE e.${req.clienteId?'cliente_id':'empresa_id'}=$1
      GROUP BY e.id ORDER BY e.criado_em DESC LIMIT 50
    `, [req.clienteId||req.empresaId]).catch(() => ({ rows: [] }));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── TICKETS ──
router.get('/tickets', async (req, res) => {
  try {
    const r = await query(`
      SELECT t.numero, t.titulo, t.estado, t.prioridade, t.criado_em, t.actualizado_em
      FROM itsm_ticket t
      WHERE t.empresa_id=$1
        AND (t.campos_extra->>'email_contacto'=$2 OR t.campos_extra->>'via'='portal_cliente')
      ORDER BY t.criado_em DESC LIMIT 20
    `, [req.empresaId, req.clienteId ? '' : '']).catch(() => ({ rows: [] }));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/tickets', async (req, res) => {
  try {
    const { titulo, descricao, urgencia, categoria } = req.body;
    const ano = new Date().getFullYear();
    const countR = await query(`SELECT COUNT(*) FROM itsm_ticket WHERE empresa_id=$1 AND EXTRACT(YEAR FROM criado_em)=$2`, [req.empresaId, ano]);
    const seq = (parseInt(countR.rows[0].count)+1).toString().padStart(5,'0');
    const numero = `TK${ano}-${seq}`;

    const r = await query(`
      INSERT INTO itsm_ticket (empresa_id,numero,tipo,titulo,descricao,prioridade,urgencia,estado,tags,campos_extra)
      VALUES ($1,$2,'request',$3,$4,'media',$5,'aberto',$6,$7) RETURNING id,numero
    `, [req.empresaId,numero,titulo,descricao||'',urgencia||'normal',
        JSON.stringify(['portal_cliente',categoria||'outro']),
        JSON.stringify({ via:'portal_cliente', cliente_id:req.clienteId })]);

    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DOCUMENTOS ──
router.get('/documentos', async (req, res) => {
  try {
    const r = await query(`
      SELECT * FROM documento
      WHERE empresa_id=$1 AND partilhado_cliente=true
      ORDER BY criado_em DESC LIMIT 50
    `, [req.empresaId]).catch(() => ({ rows: [] }));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
