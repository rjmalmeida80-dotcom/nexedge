'use strict';
const router = require('express').Router();
const { autenticar, autorizar } = require('../middleware/auth');
const { query } = require('../config/database');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const email = require('../services/emailService');

const GESTORES = ['admin_empresa','rh','diretor'];

// ═══════════════════════════════════════════════════════════════
// GESTÃO DE FORNECEDORES (lado empresa)
// ═══════════════════════════════════════════════════════════════

// Listar fornecedores do portal
router.get('/fornecedores', autenticar, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT pf.*,
        COUNT(ff.id) AS total_faturas,
        COALESCE(SUM(CASE WHEN ff.estado='submetida' THEN 1 END),0) AS faturas_pendentes,
        COALESCE(SUM(ff.total),0) AS total_faturado
      FROM portal_fornecedor pf
      LEFT JOIN fatura_fornecedor ff ON ff.portal_fornecedor_id = pf.id
      WHERE pf.empresa_id=$1
      GROUP BY pf.id
      ORDER BY pf.nome
    `, [req.empresaId]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Convidar fornecedor
router.post('/fornecedores/convidar', autenticar, autorizar(...GESTORES), async (req, res) => {
  try {
    const { nome, nif, email: emailForn, telefone, morada } = req.body;
    if (!nome || !nif || !emailForn) return res.status(400).json({ error: 'Nome, NIF e email obrigatórios' });

    const token = crypto.randomBytes(32).toString('hex');
    const expiracao = new Date(Date.now() + 7*24*60*60*1000); // 7 dias

    const { rows:[pf] } = await query(`
      INSERT INTO portal_fornecedor (empresa_id, nome, nif, email, telefone, morada, token_convite, token_expiracao, activo)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false)
      ON CONFLICT (email) DO UPDATE SET
        nome=EXCLUDED.nome, token_convite=$7, token_expiracao=$8, empresa_id=$1
      RETURNING *
    `, [req.empresaId, nome, nif, emailForn, telefone||null, morada||null, token, expiracao]);

    // Buscar nome da empresa
    const { rows:[emp] } = await query('SELECT nome FROM empresa WHERE id=$1', [req.empresaId]);

    // Enviar email de convite
    await email.enviar({
      remetente: 'suporte',
      para: emailForn,
      assunto: `🤝 Convite para Portal de Fornecedores — ${emp?.nome}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
          <div style="background:linear-gradient(135deg,#4F46E5,#8B5CF6);padding:32px;text-align:center;border-radius:12px 12px 0 0">
            <h1 style="color:#fff;margin:0">⚡ NexEdge</h1>
            <p style="color:rgba(255,255,255,.7);margin:8px 0 0">Portal de Fornecedores</p>
          </div>
          <div style="background:#fff;padding:32px;border:1px solid #E5E7EB;border-radius:0 0 12px 12px">
            <h2 style="color:#1E1B4B">Olá ${nome},</h2>
            <p><strong>${emp?.nome}</strong> convidou-o a aceder ao Portal de Fornecedores NexEdge.</p>
            <p>Através deste portal poderá submeter faturas directamente, acompanhar o estado dos pagamentos e gerir a sua relação comercial de forma simples e eficiente.</p>
            <div style="text-align:center;margin:32px 0">
              <a href="${process.env.FRONTEND_URL||'https://app.nexedge.pt'}/fornecedor/activar/${token}"
                style="background:linear-gradient(135deg,#4F46E5,#7C3AED);color:#fff;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:700">
                ✅ Activar conta
              </a>
            </div>
            <p style="color:#9CA3AF;font-size:12px">Este convite expira em 7 dias.</p>
          </div>
        </div>
      `,
    }).catch(()=>{});

    res.status(201).json({ ...pf, convite_enviado: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Listar faturas submetidas pelos fornecedores
router.get('/faturas', autenticar, async (req, res) => {
  try {
    const { estado } = req.query;
    let where = 'WHERE ff.empresa_id=$1';
    const params = [req.empresaId];
    if (estado) { params.push(estado); where += ` AND ff.estado=$${params.length}`; }

    const { rows } = await query(`
      SELECT ff.*, pf.nome AS fornecedor_nome, pf.nif AS fornecedor_nif,
        pf.email AS fornecedor_email, u.nome_completo AS aprovado_por_nome
      FROM fatura_fornecedor ff
      JOIN portal_fornecedor pf ON pf.id = ff.portal_fornecedor_id
      LEFT JOIN utilizador u ON u.id = ff.aprovado_por
      ${where}
      ORDER BY ff.criado_em DESC
    `, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Aprovar fatura de fornecedor
router.patch('/faturas/:id/aprovar', autenticar, autorizar(...GESTORES), async (req, res) => {
  try {
    const { rows:[fat] } = await query(`
      UPDATE fatura_fornecedor SET estado='aprovada', aprovado_por=$1, aprovado_em=NOW(), actualizado_em=NOW()
      WHERE id=$2 AND empresa_id=$3 RETURNING *
    `, [req.utilizador.id, req.params.id, req.empresaId]);
    if (!fat) return res.status(404).json({ error: 'Fatura não encontrada' });

    // Notificar fornecedor
    const { rows:[pf] } = await query('SELECT * FROM portal_fornecedor WHERE id=$1', [fat.portal_fornecedor_id]);
    if (pf?.email) {
      await email.enviar({
        remetente: 'pagamentos',
        para: pf.email,
        assunto: `✅ Fatura ${fat.numero} aprovada`,
        html: `<p>Olá <b>${pf.nome}</b>,</p><p>A sua fatura <b>${fat.numero}</b> no valor de <b>${parseFloat(fat.total).toLocaleString('pt-PT',{minimumFractionDigits:2})}€</b> foi aprovada e será processada para pagamento.</p>`,
      }).catch(()=>{});
    }
    res.json(fat);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Rejeitar fatura
router.patch('/faturas/:id/rejeitar', autenticar, autorizar(...GESTORES), async (req, res) => {
  try {
    const { motivo } = req.body;
    const { rows:[fat] } = await query(`
      UPDATE fatura_fornecedor SET estado='rejeitada', notas_internas=$1, actualizado_em=NOW()
      WHERE id=$2 AND empresa_id=$3 RETURNING *
    `, [motivo||null, req.params.id, req.empresaId]);
    res.json(fat);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Marcar como paga
router.patch('/faturas/:id/pagar', autenticar, autorizar(...GESTORES), async (req, res) => {
  try {
    const { data_pagamento } = req.body;
    const { rows:[fat] } = await query(`
      UPDATE fatura_fornecedor SET estado='paga', pago_em=$1, actualizado_em=NOW()
      WHERE id=$2 AND empresa_id=$3 RETURNING *
    `, [data_pagamento||new Date().toISOString().split('T')[0], req.params.id, req.empresaId]);
    res.json(fat);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// PORTAL DO FORNECEDOR (acesso público com token/login)
// ═══════════════════════════════════════════════════════════════

// Activar conta via token de convite
router.post('/activar/:token', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 6) return res.status(400).json({ error: 'Password mínima 6 caracteres' });

    const { rows:[pf] } = await query(
      "SELECT * FROM portal_fornecedor WHERE token_convite=$1 AND token_expiracao > NOW()",
      [req.params.token]
    );
    if (!pf) return res.status(404).json({ error: 'Convite inválido ou expirado' });

    const hash = await bcrypt.hash(password, 12);
    await query(`
      UPDATE portal_fornecedor SET password_hash=$1, activo=true,
        token_convite=NULL, token_expiracao=NULL
      WHERE id=$2
    `, [hash, pf.id]);

    res.json({ message: 'Conta activada com sucesso! Pode fazer login.' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Login do fornecedor
router.post('/login', async (req, res) => {
  try {
    const { email: emailForn, password } = req.body;
    const { rows:[pf] } = await query(
      "SELECT * FROM portal_fornecedor WHERE email=$1 AND activo=true",
      [emailForn]
    );
    if (!pf || !pf.password_hash) return res.status(401).json({ error: 'Credenciais inválidas' });

    const ok = await bcrypt.compare(password, pf.password_hash);
    if (!ok) return res.status(401).json({ error: 'Credenciais inválidas' });

    await query('UPDATE portal_fornecedor SET ultimo_acesso=NOW() WHERE id=$1', [pf.id]);

    const jwt = require('jsonwebtoken');
    const token = jwt.sign(
      { sub: pf.id, tipo: 'fornecedor', empresa_id: pf.empresa_id },
      process.env.JWT_SECRET || 'nexedge_secret_2026',
      { expiresIn: '8h' }
    );

    res.json({ token, fornecedor: { id:pf.id, nome:pf.nome, email:pf.email, nif:pf.nif } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Middleware de autenticação do fornecedor
function autenticarFornecedor(req, res, next) {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Token obrigatório' });
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'nexedge_secret_2026');
    if (decoded.tipo !== 'fornecedor') return res.status(401).json({ error: 'Token inválido' });
    req.fornecedorId = decoded.sub;
    req.empresaId = decoded.empresa_id;
    next();
  } catch { res.status(401).json({ error: 'Token inválido ou expirado' }); }
}

// Ver as minhas faturas (fornecedor)
router.get('/meu/faturas', autenticarFornecedor, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT * FROM fatura_fornecedor
      WHERE portal_fornecedor_id=$1
      ORDER BY criado_em DESC
    `, [req.fornecedorId]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Submeter fatura (fornecedor)
router.post('/meu/faturas', autenticarFornecedor, async (req, res) => {
  try {
    const { numero, data_emissao, data_vencimento, descricao, subtotal, iva_total, total, notas_fornecedor } = req.body;
    if (!numero || !data_emissao || !total) return res.status(400).json({ error: 'Número, data e total obrigatórios' });

    const { rows:[fat] } = await query(`
      INSERT INTO fatura_fornecedor (empresa_id, portal_fornecedor_id, numero, data_emissao,
        data_vencimento, descricao, subtotal, iva_total, total, notas_fornecedor, estado)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'submetida') RETURNING *
    `, [req.empresaId, req.fornecedorId, numero, data_emissao, data_vencimento||null,
        descricao||null, subtotal||0, iva_total||0, total, notas_fornecedor||null]);

    // Notificar a empresa
    const { rows:[pf] } = await query('SELECT nome FROM portal_fornecedor WHERE id=$1', [req.fornecedorId]);
    const { rows:[emp] } = await query('SELECT email FROM empresa WHERE id=$1', [req.empresaId]);
    if (emp?.email) {
      await email.enviar({
        remetente: 'contabilidade',
        para: emp.email,
        assunto: `📄 Nova fatura de fornecedor — ${pf?.nome} — ${numero}`,
        html: `<p>O fornecedor <b>${pf?.nome}</b> submeteu a fatura <b>${numero}</b> no valor de <b>${parseFloat(total).toLocaleString('pt-PT',{minimumFractionDigits:2})}€</b>.</p><p><a href="${process.env.FRONTEND_URL||'https://app.nexedge.pt'}/portal-fornecedor">Ver fatura</a></p>`,
      }).catch(()=>{});
    }

    res.status(201).json(fat);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Ver o meu perfil (fornecedor)
router.get('/meu/perfil', autenticarFornecedor, async (req, res) => {
  try {
    const { rows:[pf] } = await query(
      'SELECT id,nome,nif,email,telefone,morada,iban,bic,ultimo_acesso FROM portal_fornecedor WHERE id=$1',
      [req.fornecedorId]
    );
    res.json(pf);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Actualizar perfil (fornecedor)
router.patch('/meu/perfil', autenticarFornecedor, async (req, res) => {
  try {
    const { telefone, morada, iban, bic } = req.body;
    const { rows:[pf] } = await query(`
      UPDATE portal_fornecedor SET
        telefone=COALESCE($1,telefone), morada=COALESCE($2,morada),
        iban=COALESCE($3,iban), bic=COALESCE($4,bic)
      WHERE id=$5 RETURNING id,nome,nif,email,telefone,morada,iban,bic
    `, [telefone, morada, iban, bic, req.fornecedorId]);
    res.json(pf);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
