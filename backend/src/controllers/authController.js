'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { query, transaction } = require('../config/database');
const { registarAuditoria } = require('../middleware/auditoria');
const { criarErro } = require('../middleware/errorHandler');

function gerarTokens(utilizadorId, perfil, empresaId) {
  const access = jwt.sign(
    { sub: utilizadorId, perfil, empresa: empresaId },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '15m' }
  );
  const refresh = jwt.sign(
    { sub: utilizadorId, tipo: 'refresh' },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d' }
  );
  return { access, refresh };
}

// POST /api/auth/login
async function login(req, res) {
  const { email, password } = req.body;
  if (!email || !password) throw criarErro('Email e password são obrigatórios.', 400);

  const { rows } = await query(`
    SELECT u.*, e.nome AS empresa_nome, e.logo_url AS empresa_logo,
           e.modulos_ativos
    FROM utilizador u
    LEFT JOIN empresa e ON e.id = u.empresa_id
    WHERE u.email = $1
  `, [email.toLowerCase().trim()]);

  if (!rows.length) throw criarErro('Credenciais inválidas.', 401);

  const utilizador = rows[0];
  if (!utilizador.ativo) throw criarErro('Conta inativa. Contacte o administrador.', 403);

  const passwordCorreta = await bcrypt.compare(password, utilizador.password_hash);
  if (!passwordCorreta) {
    await registarAuditoria({
      empresaId: utilizador.empresa_id,
      utilizadorId: utilizador.id,
      acao: 'LOGIN_FALHOU',
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    throw criarErro('Credenciais inválidas.', 401);
  }

  // ── Verificar 2FA ─────────────────────────────────────────────────────────────
  const speakeasy = require('speakeasy');
  const QRCode = require('qrcode');

  // Verificar se empresa tem 2FA obrigatório
  let empresaTwofa = false;
  if (utilizador.empresa_id) {
    const { rows:[emp] } = await query('SELECT twofa_obrigatorio FROM empresa WHERE id=$1', [utilizador.empresa_id]);
    empresaTwofa = emp?.twofa_obrigatorio || false;
  }

  // Se empresa obriga 2FA e utilizador não tem configurado → gerar QR code
  if (empresaTwofa && !utilizador.twofa_activo) {
    let secretBase32 = utilizador.twofa_secret;
    if (!secretBase32) {
      const secret = speakeasy.generateSecret({ name: 'NexEdge:' + utilizador.email, issuer: 'NexEdge', length: 20 });
      secretBase32 = secret.base32;
      await query('UPDATE utilizador SET twofa_secret=$1 WHERE id=$2', [secretBase32, utilizador.id]);
    }
    const otpauth = speakeasy.otpauthURL({ secret: secretBase32, label: 'NexEdge:' + utilizador.email, issuer: 'NexEdge', encoding: 'base32' });
    const qrCode = await QRCode.toDataURL(otpauth);
    return res.json({ requer_configurar_2fa: true, utilizador_id: utilizador.id, qr_code: qrCode, mensagem: 'Configura o 2FA para continuar.' });
  }

  // Se utilizador tem 2FA activo → verificar código
  if (utilizador.twofa_activo) {
    const { codigo_2fa } = req.body;
    if (!codigo_2fa) {
      return res.json({ requer_2fa: true, utilizador_id: utilizador.id });
    }
    const ok = speakeasy.totp.verify({ secret: utilizador.twofa_secret, encoding: 'base32', token: String(codigo_2fa).replace(/\s/g,''), window: 2 });
    if (!ok) throw criarErro('Código 2FA inválido.', 401);
  }

    const { access, refresh } = gerarTokens(utilizador.id, utilizador.perfil, utilizador.empresa_id);

  // Guardar refresh token (hash)
  const refreshHash = await bcrypt.hash(refresh, 8);
  await query('UPDATE utilizador SET refresh_token=$1, ultimo_login=NOW() WHERE id=$2',
    [refreshHash, utilizador.id]);

  await registarAuditoria({
    empresaId: utilizador.empresa_id,
    utilizadorId: utilizador.id,
    acao: 'LOGIN_SUCESSO',
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });

  res.json({
    access_token:  access,
    refresh_token: refresh,
    token_type:    'Bearer',
    expires_in:    900,
    utilizador: {
      id:             utilizador.id,
      nome:           utilizador.nome_completo,
      email:          utilizador.email,
      perfil:         utilizador.perfil,
      empresa_id:     utilizador.empresa_id,
      empresa_nome:   utilizador.empresa_nome,
      empresa_logo:   utilizador.empresa_logo,
      modulos: utilizador.perfil === 'admin_empresa' || utilizador.perfil === 'super_admin'
        ? ['funcionarios','ferias','horarios','faturacao','crm','contabilidade','frota','despesas','relatorios','salarios','documentos','chat','formacao','medicina','avaliacoes','contratos','ativos','compras','fornecedores','tickets']
        : utilizador.modulos_ativos,
      avatar:         utilizador.avatar_url,
      mudar_password: utilizador.mudar_password || false,
    }
  });
}

// POST /api/auth/refresh
async function refresh(req, res) {
  const { refresh_token } = req.body;
  if (!refresh_token) throw criarErro('Refresh token em falta.', 400);

  let payload;
  try {
    payload = jwt.verify(refresh_token, process.env.JWT_REFRESH_SECRET);
  } catch {
    throw criarErro('Refresh token inválido ou expirado.', 401);
  }

  const { rows } = await query(
    'SELECT id, empresa_id, perfil, ativo, refresh_token AS hash FROM utilizador WHERE id=$1',
    [payload.sub]
  );

  if (!rows.length || !rows[0].ativo) throw criarErro('Utilizador inativo.', 401);

  const tokenValido = await bcrypt.compare(refresh_token, rows[0].hash || '');
  if (!tokenValido) throw criarErro('Refresh token inválido.', 401);

  const { access, refresh: newRefresh } = gerarTokens(rows[0].id, rows[0].perfil, rows[0].empresa_id);
  const newHash = await bcrypt.hash(newRefresh, 8);
  await query('UPDATE utilizador SET refresh_token=$1 WHERE id=$2', [newHash, rows[0].id]);

  res.json({ access_token: access, refresh_token: newRefresh, token_type: 'Bearer', expires_in: 900 });
}

// POST /api/auth/logout
async function logout(req, res) {
  await query('UPDATE utilizador SET refresh_token=NULL WHERE id=$1', [req.utilizador.id]);
  await registarAuditoria({
    empresaId: req.empresaId,
    utilizadorId: req.utilizador.id,
    acao: 'LOGOUT',
    ip: req.ip,
  });
  res.json({ mensagem: 'Sessão terminada com sucesso.' });
}

// GET /api/auth/me
async function me(req, res) {
  const { rows } = await query(`
    SELECT u.id, u.email, u.perfil, u.nome_completo, u.avatar_url, u.ultimo_login,
           u.empresa_id, e.nome AS empresa_nome, e.logo_url, e.modulos_ativos,
           f.id AS funcionario_id, f.cargo, f.departamento_id
    FROM utilizador u
    LEFT JOIN empresa e ON e.id = u.empresa_id
    LEFT JOIN funcionario f ON f.utilizador_id = u.id
    WHERE u.id = $1
  `, [req.utilizador.id]);

  if (!rows.length) throw criarErro('Utilizador não encontrado.', 404);

  const user = rows[0];

  // Se é sessão de impersonation, usar o contexto do token
  if (req.utilizador.impersonated_by) {
    // Buscar dados da empresa alvo
    const { rows:[empAlvo] } = await query(
      'SELECT nome, logo_url, modulos_ativos FROM empresa WHERE id=$1',
      [req.utilizador.empresa_id]
    );
    res.json({
      ...user,
      empresa_id:   req.utilizador.empresa_id,
      empresa_nome: empAlvo?.nome || user.empresa_nome,
      empresa_logo: empAlvo?.logo_url || user.logo_url,
      modulos_ativos: empAlvo?.modulos_ativos || user.modulos_ativos,
      perfil:       'admin_empresa',
      nome_completo: user.nome_completo,
      _impersonated: true,
      _impersonated_by: req.utilizador.impersonated_by,
    });
  } else {
    res.json(user);
  }
}

// POST /api/auth/alterar-password
async function alterarPassword(req, res) {
  const { password_atual, password_nova } = req.body;
  if (!password_nova) throw criarErro('Nova password em falta.', 400);
  if (password_nova.length < 8) throw criarErro('A nova password deve ter pelo menos 8 caracteres.', 400);

  const { rows } = await query('SELECT password_hash, mudar_password FROM utilizador WHERE id=$1', [req.utilizador.id]);

  // Se não é reset obrigatório, verificar password actual
  if (!rows[0].mudar_password) {
    if (!password_atual) throw criarErro('Password atual em falta.', 400);
    const ok = await bcrypt.compare(password_atual, rows[0].password_hash);
    if (!ok) throw criarErro('Password atual incorreta.', 401);
  }

  const hash = await bcrypt.hash(password_nova, 12);
  await query('UPDATE utilizador SET password_hash=$1, mudar_password=false, atualizado_em=NOW() WHERE id=$2', [hash, req.utilizador.id]);

  await req.auditar({ acao: 'PASSWORD_ALTERADA', tabela: 'utilizador', registoId: req.utilizador.id });
  res.json({ mensagem: 'Password alterada com sucesso.' });
}


// ── Pedir reset de password ────────────────────────────────────────────────
async function pedirResetPassword(req, res) {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email obrigatório' });

    const { rows:[util] } = await query(
      'SELECT * FROM utilizador WHERE email=$1 AND ativo=true', [email]
    );

    // Sempre retorna sucesso (segurança — não revelar se email existe)
    if (!util) return res.json({ message: 'Se o email existir, receberá instruções.' });

    const crypto = require('crypto');
    const token = crypto.randomBytes(32).toString('hex');
    const expiracao = new Date(Date.now() + 2*60*60*1000); // 2 horas

    await query(
      'UPDATE utilizador SET token_reset_password=$1, token_reset_expiracao=$2 WHERE id=$3',
      [token, expiracao, util.id]
    );

    const { enviar } = require('../services/emailService');
    const frontendUrl = process.env.FRONTEND_URL || 'https://app.nexedge.pt';
    await enviar({
      remetente: 'suporte',
      para: email,
      assunto: '🔑 Recuperar password — NexEdge',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
          <div style="background:linear-gradient(135deg,#4F46E5,#8B5CF6);padding:32px;text-align:center;border-radius:12px 12px 0 0">
            <h1 style="color:#fff;margin:0">NexEdge</h1>
          </div>
          <div style="background:#fff;padding:32px;border:1px solid #E5E7EB;border-radius:0 0 12px 12px">
            <h2>Recuperação de password</h2>
            <p>Recebemos um pedido para recuperar a password da conta associada a este email.</p>
            <p>Clica no botão abaixo para definir uma nova password:</p>
            <div style="text-align:center;margin:32px 0">
              <a href="${frontendUrl}/reset-password/${token}"
                style="background:linear-gradient(135deg,#4F46E5,#7C3AED);color:#fff;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:700">
                Definir nova password
              </a>
            </div>
            <p style="color:#9CA3AF;font-size:12px">Este link expira em 2 horas. Se não pediste esta recuperação, ignora este email.</p>
          </div>
        </div>
      `,
    }).catch(()=>{});

    res.json({ message: 'Se o email existir, receberá instruções.' });
  } catch(e) { res.status(500).json({ error: e.message }); }
}

// ── Confirmar reset de password ────────────────────────────────────────────
async function confirmarResetPassword(req, res) {
  try {
    const { token, nova_password } = req.body;
    if (!token || !nova_password) return res.status(400).json({ error: 'Token e nova password obrigatórios' });
    if (nova_password.length < 8) return res.status(400).json({ error: 'Password mínima 8 caracteres' });

    const { rows:[util] } = await query(
      'SELECT * FROM utilizador WHERE token_reset_password=$1 AND token_reset_expiracao > NOW()',
      [token]
    );
    if (!util) return res.status(400).json({ error: 'Link inválido ou expirado' });

    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash(nova_password, 12);
    await query(
      'UPDATE utilizador SET password_hash=$1, token_reset_password=NULL, token_reset_expiracao=NULL WHERE id=$2',
      [hash, util.id]
    );

    res.json({ message: 'Password alterada com sucesso! Já podes fazer login.' });
  } catch(e) { res.status(500).json({ error: e.message }); }
}

module.exports = { login, refresh, logout, me, alterarPassword, pedirResetPassword, confirmarResetPassword };
