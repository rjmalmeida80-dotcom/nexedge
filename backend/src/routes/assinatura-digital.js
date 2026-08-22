'use strict';
/**
 * NexEdge — Assinatura Digital de Documentos
 * Suporta: DocuSign, Adobe Sign, ou solução própria com chave criptográfica
 * Fluxo: criar pedido → enviar para assinar → webhook confirma → guardar
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const crypto = require('crypto');

router.use(autenticar);

// ── CRIAR PEDIDO DE ASSINATURA ──
router.post('/pedidos', async (req, res) => {
  try {
    const { titulo, documento_id, signatarios, mensagem, tipo } = req.body;
    if (!titulo || !signatarios?.length) return res.status(400).json({ error: 'Título e signatários obrigatórios' });

    const token = crypto.randomBytes(32).toString('hex');
    const expira = new Date(Date.now() + 30 * 24 * 3600000); // 30 dias

    const r = await query(`
      INSERT INTO assinatura_pedido (
        empresa_id, titulo, documento_id, tipo, mensagem,
        signatarios, estado, token_acesso, expira_em, criado_por
      ) VALUES ($1,$2,$3,$4,$5,$6,'pendente',$7,$8,$9)
      RETURNING *
    `, [
      req.empresaId, titulo, documento_id||null,
      tipo||'contrato', mensagem||'Por favor assine o documento.',
      JSON.stringify(signatarios), token, expira, req.utilizador.id
    ]);

    const pedido = r.rows[0];

    // Enviar emails para signatários
    const { enviarEmail } = require('../services/emailService');
    for (const sig of signatarios) {
      const linkAssinar = `${process.env.FRONTEND_URL}/assinar/${pedido.id}?token=${token}&email=${encodeURIComponent(sig.email)}`;
      await enviarEmail({
        to: sig.email,
        subject: `📝 Pedido de Assinatura — ${titulo}`,
        html: `
          <div style="font-family:Inter,sans-serif;max-width:600px">
            <div style="background:linear-gradient(135deg,#4f46e5,#7c3aed);color:white;padding:20px 24px;border-radius:8px 8px 0 0">
              <h2 style="margin:0">📝 Documento para Assinar</h2>
            </div>
            <div style="background:#fff;border:1px solid #e5e7eb;padding:24px;border-radius:0 0 8px 8px">
              <p>Olá ${sig.nome||sig.email},</p>
              <p>Foi-te enviado um documento para assinar digitalmente:</p>
              <div style="background:#f3f4f6;border-radius:8px;padding:16px;margin:16px 0">
                <div style="font-weight:600;font-size:16px">${titulo}</div>
                ${mensagem?`<div style="color:#6b7280;margin-top:4px;font-size:13px">${mensagem}</div>`:''}
              </div>
              <a href="${linkAssinar}" style="display:inline-block;background:#4f46e5;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin-top:8px">
                ✍️ Assinar Documento
              </a>
              <p style="color:#6b7280;font-size:12px;margin-top:16px">
                Válido até ${expira.toLocaleDateString('pt-PT')}.<br>
                Se não pediste esta assinatura, ignora este email.
              </p>
            </div>
          </div>`
      }).catch(()=>{});
    }

    res.status(201).json(pedido);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── LISTAR PEDIDOS ──
router.get('/pedidos', async (req, res) => {
  try {
    const { estado } = req.query;
    const conds = ['empresa_id=$1'], params = [req.empresaId];
    if (estado) { conds.push(`estado=$2`); params.push(estado); }
    const r = await query(`
      SELECT p.*, u.nome_completo as criado_por_nome
      FROM assinatura_pedido p
      JOIN utilizador u ON u.id=p.criado_por
      WHERE ${conds.join(' AND ')} ORDER BY p.criado_em DESC
    `, params);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── VER PEDIDO (público com token) ──
router.get('/pedidos/:id/ver', async (req, res) => {
  try {
    const { token, email } = req.query;
    const r = await query(`
      SELECT p.*, d.nome as documento_nome, d.url as documento_url
      FROM assinatura_pedido p
      LEFT JOIN documento d ON d.id=p.documento_id
      WHERE p.id=$1 AND p.token_acesso=$2
    `, [req.params.id, token]);
    if (!r.rows.length) return res.status(404).json({ error: 'Pedido não encontrado ou token inválido' });

    const pedido = r.rows[0];
    if (new Date(pedido.expira_em) < new Date()) return res.status(410).json({ error: 'Pedido expirado' });

    // Verificar se o email é um signatário
    const sigs = typeof pedido.signatarios === 'string' ? JSON.parse(pedido.signatarios) : pedido.signatarios;
    const signatario = sigs.find(s => s.email === email);
    if (!signatario) return res.status(403).json({ error: 'Não autorizado' });

    res.json({ ...pedido, signatario_actual: signatario });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ASSINAR ──
router.post('/pedidos/:id/assinar', async (req, res) => {
  try {
    const { token, email, nome_completo, nif, ip, user_agent } = req.body;

    const r = await query(`SELECT * FROM assinatura_pedido WHERE id=$1 AND token_acesso=$2`, [req.params.id, token]);
    if (!r.rows.length) return res.status(404).json({ error: 'Inválido' });

    const pedido = r.rows[0];
    if (new Date(pedido.expira_em) < new Date()) return res.status(410).json({ error: 'Expirado' });
    if (pedido.estado === 'concluido') return res.status(400).json({ error: 'Já assinado' });

    const sigs = typeof pedido.signatarios === 'string' ? JSON.parse(pedido.signatarios) : pedido.signatarios;
    const idx = sigs.findIndex(s => s.email === email);
    if (idx === -1) return res.status(403).json({ error: 'Não autorizado' });

    // Gerar hash da assinatura
    const hashAssinatura = crypto.createHash('sha256')
      .update(`${pedido.id}|${email}|${nome_completo}|${new Date().toISOString()}|${process.env.JWT_SECRET}`)
      .digest('hex');

    // Actualizar signatário
    sigs[idx] = {
      ...sigs[idx],
      assinado: true,
      assinado_em: new Date().toISOString(),
      nome_completo, nif,
      ip: ip || req.ip,
      user_agent: user_agent || req.headers['user-agent'],
      hash: hashAssinatura,
    };

    // Verificar se todos assinaram
    const todosAssinaram = sigs.every(s => s.assinado);

    await query(`
      UPDATE assinatura_pedido SET
        signatarios=$1,
        estado=$2,
        concluido_em=$3
      WHERE id=$4
    `, [
      JSON.stringify(sigs),
      todosAssinaram ? 'concluido' : 'parcial',
      todosAssinaram ? new Date() : null,
      pedido.id
    ]);

    // Notificar criador se concluído
    if (todosAssinaram) {
      const criador = await query(`SELECT email, nome_completo FROM utilizador WHERE id=$1`, [pedido.criado_por]);
      if (criador.rows.length) {
        const { enviarEmail } = require('../services/emailService');
        await enviarEmail({
          to: criador.rows[0].email,
          subject: `✅ Documento assinado — ${pedido.titulo}`,
          html: `<div style="font-family:Inter,sans-serif">
            <h2 style="color:#10b981">✅ Todos os signatários assinaram!</h2>
            <p>O documento <strong>${pedido.titulo}</strong> foi assinado por todos os signatários.</p>
            <p>Acede ao NexEdge para descarregar o documento assinado.</p>
          </div>`
        }).catch(()=>{});
      }
    }

    res.json({ ok: true, todos_assinaram: todosAssinaram, hash: hashAssinatura });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── VERIFICAR AUTENTICIDADE ──
router.get('/verificar/:hash', async (req, res) => {
  try {
    const r = await query(`
      SELECT p.titulo, p.signatarios, p.concluido_em, p.empresa_id
      FROM assinatura_pedido p
      WHERE signatarios::text LIKE $1
    `, [`%${req.params.hash}%`]);

    if (!r.rows.length) return res.json({ valido: false });
    const pedido = r.rows[0];
    const sigs = typeof pedido.signatarios === 'string' ? JSON.parse(pedido.signatarios) : pedido.signatarios;
    const sig = sigs.find(s => s.hash === req.params.hash);

    res.json({
      valido: !!sig,
      documento: pedido.titulo,
      signatario: sig?.email,
      nome: sig?.nome_completo,
      assinado_em: sig?.assinado_em,
      concluido_em: pedido.concluido_em,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CANCELAR ──
router.delete('/pedidos/:id', async (req, res) => {
  try {
    await query(`UPDATE assinatura_pedido SET estado='cancelado' WHERE id=$1 AND empresa_id=$2`, [req.params.id, req.empresaId]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
