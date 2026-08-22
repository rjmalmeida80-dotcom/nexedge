'use strict';
/**
 * NexEdge — 2FA Autenticação de Dois Factores
 * TOTP (Google Authenticator), backup codes, SMS
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const crypto = require('crypto');

router.use(autenticar);

// Gerar segredo TOTP
function gerarSegredo() {
  return crypto.randomBytes(20).toString('base64').replace(/[^A-Z2-7]/gi,'').slice(0,32).toUpperCase();
}

// Verificar código TOTP (algoritmo simplificado)
function verificarTOTP(segredo, codigo) {
  const window = 1; // tolerância de ±30s
  const time = Math.floor(Date.now() / 30000);

  for (let i = -window; i <= window; i++) {
    const timeBytes = Buffer.alloc(8);
    timeBytes.writeBigInt64BE(BigInt(time + i));
    const hmac = crypto.createHmac('sha1', Buffer.from(segredo, 'base64'));
    hmac.update(timeBytes);
    const hash = hmac.digest();
    const offset = hash[hash.length-1] & 0xf;
    const otp = ((hash.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString().padStart(6,'0');
    if (otp === codigo.toString()) return true;
  }
  return false;
}

// Gerar backup codes
function gerarBackupCodes() {
  return Array.from({length:8}, () => crypto.randomBytes(4).toString('hex').toUpperCase());
}

// Activar 2FA — gerar segredo
router.post('/setup', async (req, res) => {
  try {
    const segredo = gerarSegredo();
    const utilizador = await query(`SELECT email, nome_completo FROM utilizador WHERE id=$1`, [req.utilizador.id]);
    const email = encodeURIComponent(utilizador.rows[0]?.email||'');
    const issuer = encodeURIComponent('NexEdge');

    // Guardar segredo temporário (ainda não activado)
    await query(`UPDATE utilizador SET twofa_secret_temp=$1 WHERE id=$2`, [segredo, req.utilizador.id]);

    // URL para QR Code (usar com qrcode.js no frontend)
    const otpAuthUrl = `otpauth://totp/${issuer}:${email}?secret=${segredo}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;

    res.json({
      segredo,
      otp_auth_url: otpAuthUrl,
      instrucoes: 'Scanneia o QR Code com Google Authenticator ou Authy, depois confirma com o código gerado.',
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Confirmar e activar 2FA
router.post('/confirmar', async (req, res) => {
  try {
    const { codigo } = req.body;
    const r = await query(`SELECT twofa_secret_temp FROM utilizador WHERE id=$1`, [req.utilizador.id]);
    const segredo = r.rows[0]?.twofa_secret_temp;

    if (!segredo) return res.status(400).json({ error: 'Sem setup 2FA pendente' });
    if (!verificarTOTP(segredo, codigo)) return res.status(400).json({ error: 'Código inválido' });

    const backupCodes = gerarBackupCodes();
    await query(`UPDATE utilizador SET twofa_secret=$1, twofa_secret_temp=NULL, twofa_ativo=true, twofa_backup_codes=$2 WHERE id=$3`,
      [segredo, JSON.stringify(backupCodes), req.utilizador.id]);

    res.json({ activado: true, backup_codes: backupCodes, aviso: 'Guarda estes códigos de recuperação num local seguro. Cada um só pode ser usado uma vez.' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Verificar 2FA no login
router.post('/verificar', async (req, res) => {
  try {
    const { utilizador_id, codigo } = req.body;
    const r = await query(`SELECT twofa_secret, twofa_backup_codes FROM utilizador WHERE id=$1 AND twofa_ativo=true`, [utilizador_id]);
    if (!r.rows.length) return res.status(400).json({ error: '2FA não activado' });

    const { twofa_secret, twofa_backup_codes } = r.rows[0];

    // Verificar TOTP
    if (verificarTOTP(twofa_secret, codigo)) return res.json({ valido: true });

    // Verificar backup codes
    const backups = typeof twofa_backup_codes === 'string' ? JSON.parse(twofa_backup_codes) : (twofa_backup_codes||[]);
    const idx = backups.indexOf(codigo.toUpperCase());
    if (idx !== -1) {
      backups.splice(idx, 1); // Usar e remover
      await query(`UPDATE utilizador SET twofa_backup_codes=$1 WHERE id=$2`, [JSON.stringify(backups), utilizador_id]);
      return res.json({ valido: true, backup_usado: true, backups_restantes: backups.length });
    }

    res.status(400).json({ valido: false, error: 'Código inválido' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Desactivar 2FA
router.post('/desactivar', async (req, res) => {
  try {
    const { codigo } = req.body;
    const r = await query(`SELECT twofa_secret FROM utilizador WHERE id=$1 AND twofa_ativo=true`, [req.utilizador.id]);
    if (!r.rows.length) return res.status(400).json({ error: '2FA não está activo' });

    if (!verificarTOTP(r.rows[0].twofa_secret, codigo)) return res.status(400).json({ error: 'Código inválido' });

    await query(`UPDATE utilizador SET twofa_secret=NULL, twofa_ativo=false, twofa_backup_codes=NULL WHERE id=$1`, [req.utilizador.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Estado 2FA do utilizador
router.get('/estado', async (req, res) => {
  try {
    const r = await query(`SELECT twofa_ativo, array_length(twofa_backup_codes::jsonb::text[]::text[], 1) as backup_codes_restantes FROM utilizador WHERE id=$1`, [req.utilizador.id]).catch(()=>({rows:[{twofa_ativo:false}]}));
    res.json({ ativo: r.rows[0]?.twofa_ativo||false, backup_codes_restantes: r.rows[0]?.backup_codes_restantes||0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
