'use strict';
const router = require('express').Router();
const email = require('../services/emailService');
const { autenticar, autorizar } = require('../middleware/auth');
const { query } = require('../config/database');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// ── PÚBLICO — Registo de nova empresa ────────────────────────────────────────
router.post('/registar', async (req, res) => {
  try {
    const { nome_empresa, nif, nome_responsavel, email, telefone, plano_slug, metodo_pagamento } = req.body;
    if (!nome_empresa || !email || !nome_responsavel) {
      return res.status(400).json({ error: 'Nome da empresa, responsável e email são obrigatórios' });
    }

    // Verificar se email já existe
    const { rows: existe } = await query(
      'SELECT id FROM registo_empresa WHERE email=$1', [email]
    );
    if (existe.length) return res.status(409).json({ error: 'Este email já tem um registo pendente ou activo.' });

    const token = crypto.randomBytes(32).toString('hex');
    const { rows:[reg] } = await query(`
      INSERT INTO registo_empresa (nome_empresa, nif, nome_responsavel, email, telefone, plano_slug, metodo_pagamento, token_confirmacao, estado)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pendente') RETURNING *
    `, [nome_empresa, nif||null, nome_responsavel, email, telefone||null, plano_slug||'growth', metodo_pagamento||'transferencia', token]);

    // Email de confirmação (simulado — em produção usar nodemailer)
    console.log(`📧 Email para ${email}: Confirmar registo em /api/saas/confirmar/${token}`);

    res.status(201).json({
      message: 'Registo recebido! Vai receber um email de confirmação em breve.',
      id: reg.id,
      // Em produção NÃO enviar o token na resposta
      ...(process.env.NODE_ENV !== 'production' && { token })
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ── PÚBLICO — Auto-registo trial (sem aprovação manual) ──────────────────────
router.post('/trial', async (req, res) => {
  try {
    const { nome_empresa, nome_responsavel, email, telefone, password, plano_slug } = req.body;
    if (!nome_empresa || !email || !nome_responsavel || !password) {
      return res.status(400).json({ error: 'Nome da empresa, responsável, email e password são obrigatórios' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password deve ter pelo menos 8 caracteres' });
    }

    // Verificar se email já existe
    const { rows: existe } = await query('SELECT id FROM utilizador WHERE email=$1', [email]);
    if (existe.length) return res.status(409).json({ error: 'Este email já está registado. Faça login em app.nexedge.pt' });

    // Gerar token de activação (válido 24h)
    const tokenActivacao = crypto.randomBytes(32).toString('hex');
    const tokenExpira = new Date(Date.now() + 24*60*60*1000);

    // Criar empresa INACTIVA (aguarda confirmação de email)
    const { rows:[emp] } = await query(`
      INSERT INTO empresa (nome, email, telefone, nif, ativo, pais, criado_em)
      VALUES ($1,$2,$3,$4,false,'PT',NOW()) RETURNING *
    `, [nome_empresa, email, telefone||null, String(Date.now()).slice(-9)]);

    // Criar utilizador admin INACTIVO (aguarda confirmação)
    const hash = await bcrypt.hash(password, 12);
    await query(`
      INSERT INTO utilizador (empresa_id, nome_completo, email, password_hash, perfil, ativo, email_verificado, token_activacao, token_activacao_expira)
      VALUES ($1,$2,$3,$4,'admin_empresa',false,false,$5,$6)
    `, [emp.id, nome_responsavel, email, hash, tokenActivacao, tokenExpira]).catch(async () => {
      // Se colunas token não existem, criar sem token (fallback)
      await query(`
        INSERT INTO utilizador (empresa_id, nome_completo, email, password_hash, perfil, ativo, email_verificado)
        VALUES ($1,$2,$3,$4,'admin_empresa',false,false)
      `, [emp.id, nome_responsavel, email, hash]);
    });

    // Guardar interesse (mensagem actualizada após saber se SMTP funcionou)
    await query(`
      INSERT INTO interesse_contacto (nome, email, empresa, telefone, plano, mensagem)
      VALUES ($1,$2,$3,$4,$5,'Registo trial — a processar...')
      ON CONFLICT DO NOTHING
    `, [nome_responsavel, email, nome_empresa, telefone||null, plano_slug||'growth']).catch(()=>{});

    // Trial de 14 dias
    const trialFim = new Date(Date.now() + 14*86400000).toISOString().split('T')[0];
    const trialFimFormatado = new Date(Date.now() + 14*86400000).toLocaleDateString('pt-PT');

    // Tentar enviar email de confirmação
    const frontendUrl = process.env.FRONTEND_URL || 'https://app.nexedge.pt';
    const linkActivacao = `${frontendUrl}/activar?token=${tokenActivacao}`;
    let emailEnviado = false;

    try {
      const { enviarEmailGenerico } = require('../services/emailService');
      await enviarEmailGenerico({
        para: email,
        assunto: `✅ Confirme o seu email — NexEdge`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
            <h1 style="color:#4F46E5">Bem-vindo ao NexEdge! 🚀</h1>
            <p>Olá <strong>${nome_responsavel}</strong>,</p>
            <p>A sua conta para a empresa <strong>${nome_empresa}</strong> foi criada com sucesso.</p>
            <p>Para activar a sua conta e começar a usar o NexEdge, clique no botão abaixo:</p>
            <div style="text-align:center;margin:32px 0">
              <a href="${linkActivacao}" style="background:#4F46E5;color:white;padding:16px 32px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:16px">
                Activar a minha conta →
              </a>
            </div>
            <p style="color:#666;font-size:14px">Este link é válido durante 24 horas.</p>
            <p style="color:#666;font-size:14px">Se não criou esta conta, ignore este email.</p>
            <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
            <p style="color:#999;font-size:12px">NexEdge · nexedge.pt · suporte@nexedge.pt</p>
          </div>
        `
      });
      emailEnviado = true;
    } catch(_) {
      // SMTP não configurado — activar automaticamente
      await query(`UPDATE empresa SET ativo=true WHERE id=$1`, [emp.id]).catch(()=>{});
      await query(`UPDATE utilizador SET ativo=true, email_verificado=true WHERE empresa_id=$1`, [emp.id]).catch(()=>{});
      emailEnviado = false;
    }

    // Notificar super admins
    try {
      const { enviarEmailGenerico } = require('../services/emailService');
      const { rows: admins } = await query(`SELECT email FROM utilizador WHERE perfil='super_admin' AND ativo=true`).catch(()=>({rows:[]}));
      for (const admin of admins) {
        await enviarEmailGenerico({
          para: admin.email,
          assunto: `🎉 Novo registo NexEdge — ${nome_empresa}`,
          html: `<h2>Novo cliente registado!</h2>
            <p><strong>Empresa:</strong> ${nome_empresa}</p>
            <p><strong>Responsável:</strong> ${nome_responsavel}</p>
            <p><strong>Email:</strong> ${email}</p>
            <p><strong>Plano:</strong> ${plano_slug||'growth'}</p>
            <p><strong>Estado:</strong> ${emailEnviado ? '⏳ A aguardar confirmação de email' : '✅ Activado automaticamente (sem SMTP)'}</p>
            <p><a href="https://app.nexedge.pt/login">Ver no Super Admin</a></p>`
        }).catch(()=>{});
      }
    } catch(_) {}

    // Actualizar mensagem do interesse com estado real
    const msgInteresse = emailEnviado
      ? 'Registo trial — aguarda activação por email'
      : 'Registo trial — conta activa (sem SMTP)';
    await query(`UPDATE interesse_contacto SET mensagem=$1 WHERE email=$2`, [msgInteresse, email]).catch(()=>{});

    res.status(201).json({
      ok: true,
      mensagem: emailEnviado
        ? 'Conta criada! Enviámos um email de confirmação para ' + email + '. Clique no link para activar a sua conta.'
        : 'Conta criada com sucesso! Já pode fazer login.',
      email,
      requer_confirmacao: emailEnviado,
      trial_fim: trialFim,
      redirect: 'https://app.nexedge.pt/login'
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ── PÚBLICO — Activar conta por token de email ───────────────────────────────
router.get('/activar/:token', async (req, res) => {
  try {
    const { token } = req.params;
    if (!token) return res.status(400).json({ error: 'Token inválido' });

    // Procurar utilizador com este token
    const { rows: [util] } = await query(`
      SELECT u.*, e.nome as empresa_nome, e.id as empresa_id_real
      FROM utilizador u
      JOIN empresa e ON e.id = u.empresa_id
      WHERE u.token_activacao = $1
    `, [token]).catch(() => ({ rows: [] }));

    if (!util) {
      return res.status(400).json({ 
        error: 'Link de activação inválido ou já utilizado.',
        redirect: '/login'
      });
    }

    // Verificar se o token expirou
    if (util.token_activacao_expira && new Date(util.token_activacao_expira) < new Date()) {
      // Apagar empresa e utilizador criados
      await query(`DELETE FROM utilizador WHERE empresa_id=$1`, [util.empresa_id]).catch(()=>{});
      await query(`DELETE FROM empresa WHERE id=$1`, [util.empresa_id]).catch(()=>{});
      return res.status(400).json({ 
        error: 'O link de activação expirou (válido 24h). Por favor registe-se novamente.',
        redirect: '/#registar'
      });
    }

    // Activar empresa e utilizador
    await query(`UPDATE empresa SET ativo=true WHERE id=$1`, [util.empresa_id]);
    await query(`
      UPDATE utilizador 
      SET ativo=true, email_verificado=true, token_activacao=NULL, token_activacao_expira=NULL
      WHERE id=$1
    `, [util.id]);

    // Trial de 14 dias
    const trialFim = new Date(Date.now() + 14*86400000).toISOString().split('T')[0];
    const { rows:[plano] } = await query(`SELECT * FROM plano_saas WHERE slug='growth' LIMIT 1`).catch(()=>({rows:[null]}));
    if (plano) {
      await query(`
        INSERT INTO subscricao (empresa_id, plano_id, estado, trial_fim, metodo_pagamento)
        VALUES ($1,$2,'trial',$3,'trial') ON CONFLICT DO NOTHING
      `, [util.empresa_id, plano.id, trialFim]).catch(()=>{});
    }

    // Notificar super admins
    try {
      const { enviarEmailGenerico } = require('../services/emailService');
      const { rows: admins } = await query(`SELECT email FROM utilizador WHERE perfil='super_admin' AND ativo=true`).catch(()=>({rows:[]}));
      for (const admin of admins) {
        await enviarEmailGenerico({
          para: admin.email,
          assunto: `✅ Conta activada — ${util.empresa_nome}`,
          html: `<h2>Cliente activou a conta!</h2>
            <p><strong>Empresa:</strong> ${util.empresa_nome}</p>
            <p><strong>Email:</strong> ${util.email}</p>
            <p><strong>Trial até:</strong> ${trialFimFormatado}</p>
            <p><a href="https://app.nexedge.pt/login">Ver no Super Admin</a></p>`
        }).catch(()=>{});
      }
    } catch(_) {}

    res.json({
      ok: true,
      mensagem: 'Conta activada com sucesso! Já pode fazer login.',
      email: util.email,
      empresa: util.empresa_nome,
      redirect: '/login?email=' + encodeURIComponent(util.email)
    });

  } catch(e) {
    console.error('Erro activar conta:', e.message);
    res.status(500).json({ error: 'Erro ao activar conta. Contacte suporte@nexedge.pt' });
  }
});

// ── PÚBLICO — Reenviar email de activação ────────────────────────────────────
router.post('/reenviar-activacao', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email obrigatório' });

    const { rows: [util] } = await query(`
      SELECT u.*, e.nome as empresa_nome
      FROM utilizador u JOIN empresa e ON e.id=u.empresa_id
      WHERE u.email=$1 AND u.email_verificado=false AND u.ativo=false
    `, [email]).catch(()=>({rows:[]}));

    if (!util) {
      return res.status(404).json({ error: 'Conta não encontrada ou já activada' });
    }

    // Gerar novo token
    const novoToken = require('crypto').randomBytes(32).toString('hex');
    const expira = new Date(Date.now() + 24*60*60*1000);
    await query(`UPDATE utilizador SET token_activacao=$1, token_activacao_expira=$2 WHERE id=$3`,
      [novoToken, expira, util.id]);

    const frontendUrl = process.env.FRONTEND_URL || 'https://app.nexedge.pt';
    const link = `${frontendUrl}/activar?token=${novoToken}`;

    try {
      const { enviarEmailGenerico } = require('../services/emailService');
      await enviarEmailGenerico({
        para: email,
        assunto: '✅ Novo link de activação — NexEdge',
        html: `<p>Olá ${util.nome_completo},</p>
          <p>Aqui está o seu novo link de activação (válido 24h):</p>
          <p><a href="${link}" style="background:#4F46E5;color:white;padding:12px 24px;border-radius:8px;text-decoration:none">Activar conta →</a></p>`
      });
      res.json({ ok: true, mensagem: 'Email de activação reenviado!' });
    } catch(_) {
      res.status(503).json({ error: 'Email não configurado. Contacte suporte@nexedge.pt' });
    }
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PÚBLICO — Confirmar email ─────────────────────────────────────────────────
router.get('/confirmar/:token', async (req, res) => {
  try {
    const { rows:[reg] } = await query(
      "SELECT * FROM registo_empresa WHERE token_confirmacao=$1 AND estado='pendente'",
      [req.params.token]
    );
    if (!reg) return res.status(404).json({ error: 'Link inválido ou já utilizado.' });

    await query(
      "UPDATE registo_empresa SET estado='confirmado' WHERE id=$1",
      [reg.id]
    );

    res.json({ message: 'Email confirmado! A tua conta será activada em breve.', empresa: reg.nome_empresa });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PÚBLICO — Planos disponíveis ──────────────────────────────────────────────
router.get('/planos', async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM plano_saas WHERE ativo=true ORDER BY ordem',
  );
  res.json(rows);
});

// ── ADMIN NEXEDGE — Ver todos os registos ─────────────────────────────────────
router.get('/admin/registos', autenticar, autorizar('super_admin'), async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM registo_empresa ORDER BY criado_em DESC'
  );
  res.json(rows);
});

// ── ADMIN NEXEDGE — Aprovar registo e criar empresa ───────────────────────────
router.post('/admin/aprovar/:id', autenticar, autorizar('super_admin'), async (req, res) => {
  try {
    const { rows:[reg] } = await query(
      "SELECT * FROM registo_empresa WHERE id=$1 AND estado IN ('pendente','confirmado')",
      [req.params.id]
    );
    if (!reg) return res.status(404).json({ error: 'Registo não encontrado ou já processado' });

    // Criar empresa
    const { rows:[emp] } = await query(`
      INSERT INTO empresa (nome, email, nif, plano, ativa, criado_em)
      VALUES ($1,$2,$3,$4,true,NOW()) RETURNING *
    `, [reg.nome_empresa, reg.email, reg.nif||'999999990', reg.plano_slug]);

    // Criar utilizador admin da empresa
    const senha = crypto.randomBytes(8).toString('base64').replace(/[^a-zA-Z0-9]/g,'').substring(0,10);
    const hash = await bcrypt.hash(senha, 12);
    await query(`
      INSERT INTO utilizador (empresa_id, nome_completo, email, password_hash, perfil, ativo)
      VALUES ($1,$2,$3,$4,'admin_empresa',true)
    `, [emp.id, reg.nome_responsavel, reg.email, hash]);

    // Criar subscrição em trial
    const { rows:[plano] } = await query('SELECT * FROM plano_saas WHERE slug=$1', [reg.plano_slug]);
    const trialFim = new Date(Date.now() + 14*86400000).toISOString().split('T')[0];
    await query(`
      INSERT INTO subscricao (empresa_id, plano_id, estado, trial_fim, metodo_pagamento)
      VALUES ($1,$2,'trial',$3,$4)
    `, [emp.id, plano.id, trialFim, reg.metodo_pagamento]);

    // Marcar registo como activo
    await query(
      "UPDATE registo_empresa SET estado='activo', empresa_id=$1, aprovado_por=$2, aprovado_em=NOW() WHERE id=$3",
      [emp.id, req.utilizador.id, reg.id]
    );

    // Em produção enviar email com credenciais
    // Enviar email de boas-vindas
    try {
      await email.enviarBoasVindas({
        email: reg.email, nome: reg.nome_responsavel,
        empresa: reg.nome_empresa, password: senha,
        trialFim: new Date(Date.now() + 14*86400000).toLocaleDateString('pt-PT'),
      });
    } catch(_) { console.log('Email boas-vindas falhou (sem SMTP configurado)'); }

    res.json({
      message: 'Empresa criada e activada com trial de 14 dias',
      empresa: emp,
      credenciais: { email: reg.email, password: senha },
      trial_fim: trialFim,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN NEXEDGE — Dashboard SaaS ───────────────────────────────────────────
router.get('/admin/dashboard', autenticar, autorizar('super_admin'), async (req, res) => {
  try {
    const { rows:[stats] } = await query(`
      SELECT
        COUNT(DISTINCT e.id) AS total_empresas,
        COUNT(DISTINCT CASE WHEN s.estado='trial' THEN e.id END) AS em_trial,
        COUNT(DISTINCT CASE WHEN s.estado='activa' THEN e.id END) AS activas,
        COUNT(DISTINCT CASE WHEN s.estado='suspensa' THEN e.id END) AS suspensas,
        COALESCE(SUM(CASE WHEN s.estado='activa' THEN p.preco_mensal END), 0) AS mrr
      FROM empresa e
      LEFT JOIN subscricao s ON s.empresa_id = e.id
      LEFT JOIN plano_saas p ON p.id = s.plano_id
      WHERE e.ativa = true
    `);

    const { rows: porPlano } = await query(`
      SELECT p.nome, p.preco_mensal, COUNT(s.id) AS total,
             p.preco_mensal * COUNT(s.id) AS receita
      FROM subscricao s
      JOIN plano_saas p ON p.id = s.plano_id
      WHERE s.estado IN ('activa','trial')
      GROUP BY p.id, p.nome, p.preco_mensal
      ORDER BY p.ordem
    `);

    const { rows: trialsAExpirar } = await query(`
      SELECT e.nome, e.email, s.trial_fim,
             s.trial_fim - CURRENT_DATE AS dias_restantes
      FROM subscricao s
      JOIN empresa e ON e.id = s.empresa_id
      WHERE s.estado = 'trial'
        AND s.trial_fim <= CURRENT_DATE + INTERVAL '3 days'
      ORDER BY s.trial_fim
    `);

    const { rows: registosPendentes } = await query(
      "SELECT * FROM registo_empresa WHERE estado IN ('pendente','confirmado') ORDER BY criado_em DESC LIMIT 10"
    );

    res.json({ stats, porPlano, trialsAExpirar, registosPendentes });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN NEXEDGE — Suspender/Activar empresa ────────────────────────────────
router.patch('/admin/empresa/:id/estado', autenticar, autorizar('super_admin'), async (req, res) => {
  const { estado, motivo } = req.body;
  await query(
    "UPDATE subscricao SET estado=$1 WHERE empresa_id=$2 RETURNING *",
    [estado, req.params.id]
  );
  await query("UPDATE empresa SET ativa=$1 WHERE id=$2", [estado !== 'suspensa', req.params.id]);
  res.json({ message: `Empresa ${estado === 'suspensa' ? 'suspensa' : 'reactivada'}` });
});

// ── CLIENTE — Ver a minha subscrição ─────────────────────────────────────────
router.get('/subscricao', autenticar, async (req, res) => {
  try {
    const { rows:[sub] } = await query(`
      SELECT s.*, p.nome AS plano_nome, p.preco_mensal, p.features, p.max_colaboradores,
             p.slug AS plano_slug
      FROM subscricao s
      JOIN plano_saas p ON p.id = s.plano_id
      WHERE s.empresa_id = $1
    `, [req.empresaId]);

    if (!sub) return res.json({ estado: 'sem_subscricao' });

    const diasRestantes = sub.trial_fim
      ? Math.max(0, Math.ceil((new Date(sub.trial_fim) - new Date()) / 86400000))
      : null;

    res.json({ ...sub, dias_restantes: diasRestantes });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CLIENTE — Facturas ────────────────────────────────────────────────────────
router.get('/facturas', autenticar, async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM factura_saas WHERE empresa_id=$1 ORDER BY criado_em DESC',
    [req.empresaId]
  );
  res.json(rows);
});

// ── CLIENTE — Mudar de plano ──────────────────────────────────────────────────
router.post('/mudar-plano', autenticar, async (req, res) => {
  try {
    const { plano_slug } = req.body;
    const { rows:[plano] } = await query('SELECT * FROM plano_saas WHERE slug=$1', [plano_slug]);
    if (!plano) return res.status(404).json({ error: 'Plano não encontrado' });

    await query(
      'UPDATE subscricao SET plano_id=$1 WHERE empresa_id=$2',
      [plano.id, req.empresaId]
    );
    await query("UPDATE empresa SET plano=$1 WHERE id=$2", [plano_slug, req.empresaId]);

    res.json({ message: `Plano alterado para ${plano.nome}`, plano });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CLIENTE — Submeter comprovativo de transferência ─────────────────────────
router.post('/comprovativo', autenticar, async (req, res) => {
  try {
    const { comprovativo_url, mes, ano } = req.body;
    if (!comprovativo_url) return res.status(400).json({ error: 'Comprovativo obrigatório' });

    const { rows:[sub] } = await query(
      'SELECT s.*, p.preco_mensal FROM subscricao s JOIN plano_saas p ON p.id=s.plano_id WHERE s.empresa_id=$1',
      [req.empresaId]
    );

    const numero = `FT-SAAS-${new Date().getFullYear()}-${String(await getNextNum()).padStart(4,'0')}`;
    const { rows:[fat] } = await query(`
      INSERT INTO factura_saas (empresa_id, subscricao_id, numero, descricao, valor, iva, total,
        estado, metodo_pagamento, comprovativo_url, data_emissao, data_vencimento)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'pendente_validacao','transferencia',$8,CURRENT_DATE,CURRENT_DATE)
      RETURNING *
    `, [req.empresaId, sub?.id, numero,
        `Subscrição NexEdge ${sub?.plano_nome||''} — ${mes||new Date().getMonth()+1}/${ano||new Date().getFullYear()}`,
        sub?.preco_mensal||0, 0, sub?.preco_mensal||0, comprovativo_url]);

    res.status(201).json({ message: 'Comprovativo recebido! A validar em 24h.', factura: fat });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

async function getNextNum() {
  const { rows:[r] } = await query('SELECT COUNT(*)+1 AS n FROM factura_saas');
  return r.n;
}

// ── CLIENTE — Cancelar subscrição ─────────────────────────────────────────────
router.post('/cancelar', autenticar, async (req, res) => {
  try {
    const { motivo } = req.body;
    await query(
      "UPDATE subscricao SET estado='cancelada', cancelada_em=NOW(), motivo_cancelamento=$1 WHERE empresa_id=$2",
      [motivo||null, req.empresaId]
    );
    res.json({ message: 'Subscrição cancelada. Os teus dados ficam guardados por 30 dias.' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ── Marcar interesse como contactado ─────────────────────────────────────────
router.patch('/interesses/:id/contactado', async (req, res) => {
  try {
    await query(`UPDATE interesse_contacto SET contactado=true WHERE id=$1`, [req.params.id]).catch(()=>{});
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

// ── Formulário de interesse (landing page) — notifica super admins ────────────
router.post('/interesse', async (req, res) => {
  try {
    const { nome, email, empresa, telefone, plano, mensagem } = req.body;
    if (!nome || !email) return res.status(400).json({ error: 'Nome e email obrigatórios' });

    // Guardar na BD
    await query(`
      CREATE TABLE IF NOT EXISTS interesse_contacto (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        nome VARCHAR(200), email VARCHAR(200), empresa VARCHAR(200),
        telefone VARCHAR(50), plano VARCHAR(50), mensagem TEXT,
        criado_em TIMESTAMP DEFAULT NOW(), contactado BOOLEAN DEFAULT false
      )
    `).catch(()=>{});

    await query(`
      INSERT INTO interesse_contacto (nome, email, empresa, telefone, plano, mensagem)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [nome, email, empresa||null, telefone||null, plano||'growth', mensagem||null]).catch(()=>{});

    // Notificar super admins por email
    const { rows: admins } = await query(
      `SELECT email, nome_completo FROM utilizador WHERE perfil='super_admin' AND ativo=true`
    ).catch(()=>({rows:[]}));

    try {
      const { enviarEmailGenerico } = require('../services/emailService');
      for (const admin of admins) {
        await enviarEmailGenerico({
          para: admin.email,
          assunto: `🚀 Novo interesse NexEdge — ${nome} (${empresa||'sem empresa'})`,
          html: `
            <h2>Novo potencial cliente!</h2>
            <table>
              <tr><td><strong>Nome:</strong></td><td>${nome}</td></tr>
              <tr><td><strong>Email:</strong></td><td>${email}</td></tr>
              <tr><td><strong>Empresa:</strong></td><td>${empresa||'—'}</td></tr>
              <tr><td><strong>Telefone:</strong></td><td>${telefone||'—'}</td></tr>
              <tr><td><strong>Plano interesse:</strong></td><td>${plano||'—'}</td></tr>
              <tr><td><strong>Mensagem:</strong></td><td>${mensagem||'—'}</td></tr>
            </table>
            <p><a href="mailto:${email}">Responder a ${nome}</a></p>
          `
        }).catch(()=>{});
      }
    } catch(e) { /* email falha silenciosamente */ }

    res.json({ ok: true, mensagem: 'Obrigado! Entraremos em contacto brevemente.' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ── Apagar empresa e utilizador (super admin — para testes) ──────────────────
router.delete('/empresas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    // Apagar na ordem correcta (foreign keys)
    await query(`DELETE FROM log_auditoria WHERE utilizador_id IN (SELECT id FROM utilizador WHERE empresa_id=$1)`, [id]).catch(()=>{});
    await query(`DELETE FROM notificacao WHERE utilizador_id IN (SELECT id FROM utilizador WHERE empresa_id=$1)`, [id]).catch(()=>{});
    await query(`DELETE FROM interesse_contacto WHERE email IN (SELECT email FROM utilizador WHERE empresa_id=$1)`, [id]).catch(()=>{});
    await query(`DELETE FROM utilizador WHERE empresa_id=$1`, [id]).catch(()=>{});
    await query(`DELETE FROM empresa WHERE id=$1`, [id]).catch(()=>{});
    res.json({ ok: true, mensagem: 'Empresa e utilizadores apagados.' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Apagar interesse ─────────────────────────────────────────────────────────
router.delete('/interesses/:id', async (req, res) => {
  try {
    await query(`DELETE FROM interesse_contacto WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Listar interesses (super admin) ──────────────────────────────────────────
router.get('/interesses', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT i.*,
        u.ativo as utilizador_ativo,
        u.email_verificado,
        u.id as utilizador_id,
        e.id as empresa_id,
        e.ativo as empresa_ativa
      FROM interesse_contacto i
      LEFT JOIN utilizador u ON u.email = i.email AND u.perfil='admin_empresa'
      LEFT JOIN empresa e ON e.id = u.empresa_id
      ORDER BY i.criado_em DESC LIMIT 100
    `).catch(()=>({rows:[]}));
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ── Desactivar/reactivar conta (super admin) ─────────────────────────────────
router.post('/interesses/:id/toggle-ativo', async (req, res) => {
  try {
    const { id } = req.params;
    const { rows:[interesse] } = await query(`SELECT * FROM interesse_contacto WHERE id=$1`, [id]);
    if (!interesse) return res.status(404).json({ error: 'Interesse não encontrado' });

    const { rows:[util] } = await query(`
      SELECT u.id, u.ativo, u.empresa_id FROM utilizador u
      WHERE u.email=$1 AND u.perfil='admin_empresa'
    `, [interesse.email]).catch(()=>({rows:[]}));

    if (!util) return res.status(404).json({ error: 'Utilizador não encontrado.' });

    const novoEstado = !util.ativo;
    await query(`UPDATE utilizador SET ativo=$1 WHERE id=$2`, [novoEstado, util.id]);
    await query(`UPDATE empresa SET ativo=$1 WHERE id=$2`, [novoEstado, util.empresa_id]);

    res.json({ ok: true, ativo: novoEstado, mensagem: novoEstado ? 'Conta reactivada!' : 'Conta desactivada!' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Activar conta manualmente (super admin) ───────────────────────────────────
router.post('/interesses/:id/activar', async (req, res) => {
  try {
    const { id } = req.params;
    // Obter email do interesse
    const { rows:[interesse] } = await query(`SELECT * FROM interesse_contacto WHERE id=$1`, [id]);
    if (!interesse) return res.status(404).json({ error: 'Interesse não encontrado' });

    // Activar utilizador e empresa
    const { rows:[util] } = await query(`
      UPDATE utilizador SET ativo=true, email_verificado=true, token_activacao=NULL, token_activacao_expira=NULL
      WHERE email=$1 AND perfil='admin_empresa' RETURNING id, empresa_id
    `, [interesse.email]).catch(()=>({rows:[]}));

    if (!util) return res.status(404).json({ error: 'Utilizador não encontrado. O cliente pode ainda não se ter registado.' });

    await query(`UPDATE empresa SET ativo=true WHERE id=$1`, [util.empresa_id]).catch(()=>{});

    // Trial de 14 dias
    const trialFim = new Date(Date.now() + 14*86400000).toISOString().split('T')[0];
    const { rows:[plano] } = await query(`SELECT * FROM plano_saas WHERE slug='growth' LIMIT 1`).catch(()=>({rows:[null]}));
    if (plano) {
      await query(`INSERT INTO subscricao (empresa_id, plano_id, estado, trial_fim, metodo_pagamento) VALUES ($1,$2,'trial',$3,'trial') ON CONFLICT DO NOTHING`,
        [util.empresa_id, plano.id, trialFim]).catch(()=>{});
    }

    res.json({ ok: true, mensagem: 'Conta activada com sucesso!' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Reenviar email de activação (super admin) ─────────────────────────────────
router.post('/interesses/:id/reenviar', async (req, res) => {
  try {
    const { id } = req.params;
    const { rows:[interesse] } = await query(`SELECT * FROM interesse_contacto WHERE id=$1`, [id]);
    if (!interesse) return res.status(404).json({ error: 'Interesse não encontrado' });

    const novoToken = require('crypto').randomBytes(32).toString('hex');
    const expira = new Date(Date.now() + 24*60*60*1000);
    const { rows:[util] } = await query(`
      UPDATE utilizador SET token_activacao=$1, token_activacao_expira=$2
      WHERE email=$3 AND perfil='admin_empresa' RETURNING nome_completo
    `, [novoToken, expira, interesse.email]).catch(()=>({rows:[]}));

    if (!util) return res.status(404).json({ error: 'Utilizador não encontrado.' });

    const frontendUrl = process.env.FRONTEND_URL || 'https://app.nexedge.pt';
    const link = `${frontendUrl}/activar?token=${novoToken}`;

    try {
      const { enviarEmailGenerico } = require('../services/emailService');
      await enviarEmailGenerico({
        para: interesse.email,
        assunto: '✅ Activate a sua conta NexEdge',
        html: `<p>Olá ${util.nome_completo},</p>
          <p>Aqui está o seu link de activação (válido 24h):</p>
          <a href="${link}" style="background:#4F46E5;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;margin:16px 0">Activar conta →</a>
          <p style="color:#999;font-size:12px">Se não criou esta conta, ignore este email.</p>`
      });
      res.json({ ok: true, mensagem: 'Email de activação reenviado!' });
    } catch(_) {
      res.status(503).json({ error: 'Email não configurado. Configure o SMTP primeiro.' });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});
