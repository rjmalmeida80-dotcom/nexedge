'use strict';
const router = require('express').Router();
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const { autenticar, autorizar } = require('../middleware/auth');
const { query } = require('../config/database');

// ── Gerar QR code para activar 2FA ───────────────────────────────────────────
router.post('/activar', autenticar, async (req, res) => {
  try {
    const { rows:[u] } = await query('SELECT email, twofa_activo FROM utilizador WHERE id=$1', [req.utilizador.id]);
    if (u.twofa_activo) return res.status(400).json({ error: '2FA já está activo' });
    const secret = speakeasy.generateSecret({ name: 'NexEdge (' + u.email + ')', issuer: 'NexEdge', length: 20 });
    await query('UPDATE utilizador SET twofa_secret=$1 WHERE id=$2', [secret.base32, req.utilizador.id]);
    const qr = await QRCode.toDataURL(secret.otpauth_url);
    res.json({ secret: secret.base32, qr_code: qr });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Confirmar código e activar 2FA ────────────────────────────────────────────
router.post('/confirmar', autenticar, async (req, res) => {
  try {
    const { codigo } = req.body;
    const { rows:[u] } = await query('SELECT twofa_secret FROM utilizador WHERE id=$1', [req.utilizador.id]);
    if (!u?.twofa_secret) return res.status(400).json({ error: 'Inicia o processo primeiro' });
    const ok = speakeasy.totp.verify({ secret: u.twofa_secret, encoding: 'base32', token: String(codigo).replace(/\s/g,''), window: 2 });
    if (!ok) return res.status(400).json({ error: 'Código inválido' });
    await query('UPDATE utilizador SET twofa_activo=true WHERE id=$1', [req.utilizador.id]);
    res.json({ message: '2FA activado com sucesso' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Confirmar 2FA durante o login (obrigatório pela empresa) ─────────────────
router.post('/confirmar-login', async (req, res) => {
  try {
    if (!req.body) return res.status(400).json({ error: 'Body vazio' });
    const utilizador_id = req.body.utilizador_id;
    const codigo = req.body.codigo;
    if (!utilizador_id || !codigo) return res.status(400).json({ error: 'Dados obrigatórios' });
    const { rows:[u] } = await query('SELECT twofa_secret FROM utilizador WHERE id=$1', [utilizador_id]);
    if (!u?.twofa_secret) return res.status(400).json({ error: 'Secret não encontrado' });
    const ok = speakeasy.totp.verify({ secret: u.twofa_secret, encoding: 'base32', token: String(codigo).replace(/\s/g,''), window: 2 });
    if (!ok) return res.status(400).json({ error: 'Código inválido' });
    await query('UPDATE utilizador SET twofa_activo=true WHERE id=$1', [utilizador_id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Desactivar 2FA ────────────────────────────────────────────────────────────
router.post('/desactivar', autenticar, async (req, res) => {
  try {
    const { codigo } = req.body;
    const { rows:[u] } = await query('SELECT twofa_secret, twofa_activo FROM utilizador WHERE id=$1', [req.utilizador.id]);
    if (!u?.twofa_activo) return res.status(400).json({ error: '2FA não está activo' });
    const ok = speakeasy.totp.verify({ secret: u.twofa_secret, encoding: 'base32', token: String(codigo).replace(/\s/g,''), window: 2 });
    if (!ok) return res.status(400).json({ error: 'Código inválido' });
    await query('UPDATE utilizador SET twofa_activo=false, twofa_secret=NULL WHERE id=$1', [req.utilizador.id]);
    res.json({ message: '2FA desactivado' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Estado 2FA do utilizador actual ──────────────────────────────────────────
router.get('/estado', autenticar, async (req, res) => {
  try {
    const { rows:[u] } = await query('SELECT twofa_activo FROM utilizador WHERE id=$1', [req.utilizador.id]);
    res.json({ activo: u?.twofa_activo || false });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Estado 2FA da empresa ─────────────────────────────────────────────────────
router.get('/empresa/estado', autenticar, async (req, res) => {
  try {
    let eid = req.empresaId;
    if (!eid) {
      const { rows:[u] } = await query('SELECT empresa_id FROM utilizador WHERE id=$1', [req.utilizador.id]);
      eid = u?.empresa_id;
    }
    if (!eid) return res.json({ obrigatorio: false });
    const { rows:[e] } = await query('SELECT twofa_obrigatorio FROM empresa WHERE id=$1', [eid]);
    res.json({ obrigatorio: e?.twofa_obrigatorio || false });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Activar/desactivar 2FA obrigatório na empresa ────────────────────────────
router.post('/empresa/obrigatorio', autenticar, autorizar('admin_empresa','super_admin','diretor'), async (req, res) => {
  try {
    const { obrigatorio } = req.body;
    let eid = req.empresaId;
    if (!eid) {
      const { rows:[u] } = await query('SELECT empresa_id FROM utilizador WHERE id=$1', [req.utilizador.id]);
      eid = u?.empresa_id;
    }
    if (!eid) return res.status(400).json({ error: 'Empresa não encontrada' });
    await query('UPDATE empresa SET twofa_obrigatorio=$1 WHERE id=$2', [!!obrigatorio, eid]);
    res.json({ message: obrigatorio ? '2FA obrigatório activado' : '2FA obrigatório desactivado' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Listar utilizadores com estado 2FA (para admins) ─────────────────────────
router.get('/utilizadores', autenticar, autorizar('admin_empresa','super_admin','diretor'), async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT id, nome_completo, email, perfil, twofa_activo,
        CASE WHEN twofa_secret IS NOT NULL AND twofa_activo=false THEN 'pendente'
             WHEN twofa_activo=true THEN 'activo'
             ELSE 'inactivo' END AS estado_2fa
      FROM utilizador WHERE empresa_id=$1 ORDER BY nome_completo
    `, [req.empresaId]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Reset 2FA de um utilizador (admin) ───────────────────────────────────────
router.post('/reset-user/:uid', autenticar, autorizar('admin_empresa','super_admin','diretor'), async (req, res) => {
  try {
    const { rows:[u] } = await query('SELECT id, email, empresa_id FROM utilizador WHERE id=$1', [req.params.uid]);
    if (!u) return res.status(404).json({ error: 'Utilizador não encontrado' });
    if (req.utilizador.perfil !== 'super_admin' && u.empresa_id !== req.empresaId) return res.status(403).json({ error: 'Sem permissão' });
    await query('UPDATE utilizador SET twofa_secret=NULL, twofa_activo=false WHERE id=$1', [req.params.uid]);
    res.json({ message: 'Reset 2FA efectuado para ' + u.email });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
