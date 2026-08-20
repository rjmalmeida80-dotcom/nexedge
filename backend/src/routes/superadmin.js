'use strict';
const router = require('express').Router();
const { autenticar, autorizar } = require('../middleware/auth');
const { query } = require('../config/database');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const SA = autorizar('super_admin');

// ── DASHBOARD GLOBAL ──────────────────────────────────────────────────────────
router.get('/dashboard', autenticar, SA, async (req, res) => {
  try {
    const { rows:[stats] } = await query(`
      SELECT
        COUNT(DISTINCT e.id) AS total_empresas,
        COUNT(DISTINCT CASE WHEN e.ativo THEN e.id END) AS empresas_ativas,
        COUNT(DISTINCT u.id) AS total_utilizadores,
        COUNT(DISTINCT CASE WHEN s.estado='trial' THEN s.id END) AS em_trial,
        COUNT(DISTINCT CASE WHEN s.estado='activa' THEN s.id END) AS subscricoes_ativas,
        COALESCE(SUM(CASE WHEN s.estado='activa' THEN p.preco_mensal END), 0) AS mrr
      FROM empresa e
      LEFT JOIN utilizador u ON u.empresa_id = e.id
      LEFT JOIN subscricao s ON s.empresa_id = e.id
      LEFT JOIN plano_saas p ON p.id = s.plano_id
    `);

    const { rows: empresas } = await query(`
      SELECT e.*,
             NULL AS sub_estado, NULL AS trial_fim,
             NULL AS plano_nome, 0 AS preco_mensal,
             COUNT(DISTINCT u.id) AS num_utilizadores,
             COUNT(DISTINCT f.id) AS num_colaboradores
      FROM empresa e
      LEFT JOIN utilizador u ON u.empresa_id = e.id AND u.ativo = true
      LEFT JOIN funcionario f ON f.empresa_id = e.id AND f.estado = 'ativo'
      GROUP BY e.id
      ORDER BY e.criado_em DESC
    `).catch(()=>({rows:[]}));

    const { rows: erros } = await query(`
      SELECT * FROM log_sistema WHERE tipo='erro'
      ORDER BY criado_em DESC LIMIT 20
    `).catch(() => ({ rows: [] }));

    const { rows: superadmins } = await query(`
      SELECT id, nome_completo, email, ativo, criado_em
      FROM utilizador WHERE perfil='super_admin'
      ORDER BY criado_em
    `);

    // Métricas de crescimento
    const { rows:[metricas] } = await query(`
      SELECT
        COUNT(CASE WHEN i.criado_em >= NOW() - INTERVAL '7 days' THEN 1 END) AS registos_7dias,
        COUNT(CASE WHEN i.criado_em >= NOW() - INTERVAL '30 days' THEN 1 END) AS registos_30dias,
        COUNT(CASE WHEN u.ativo=true AND u.email_verificado=true THEN 1 END) AS contas_activas,
        COUNT(CASE WHEN u.ativo=false AND u.email_verificado=false AND u.token_activacao IS NOT NULL THEN 1 END) AS aguarda_activacao,
        COUNT(CASE WHEN i.mensagem LIKE '%expirado%' THEN 1 END) AS expirados
      FROM interesse_contacto i
      LEFT JOIN utilizador u ON u.email=i.email AND u.perfil='admin_empresa'
    `).catch(()=>({rows:[{registos_7dias:0,registos_30dias:0,contas_activas:0,aguarda_activacao:0,expirados:0}]}));

    // Crescimento por dia (últimos 30 dias)
    const { rows: crescimento } = await query(`
      SELECT DATE(criado_em) as dia, COUNT(*) as total
      FROM interesse_contacto
      WHERE criado_em >= NOW() - INTERVAL '30 days'
      GROUP BY DATE(criado_em)
      ORDER BY dia
    `).catch(()=>({rows:[]}));

    res.json({ stats, empresas, erros, superadmins, metricas: metricas || {}, crescimento });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── LISTAR TODAS AS EMPRESAS ──────────────────────────────────────────────────
router.get('/empresas', autenticar, SA, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT e.*,
             s.estado AS sub_estado, s.trial_fim, s.metodo_pagamento,
             p.nome AS plano_nome, p.preco_mensal,
             COUNT(DISTINCT u.id) AS num_utilizadores,
             COUNT(DISTINCT f.id) AS num_colaboradores
      FROM empresa e
      LEFT JOIN subscricao s ON s.empresa_id = e.id
      LEFT JOIN plano_saas p ON p.id = s.plano_id
      LEFT JOIN utilizador u ON u.empresa_id = e.id AND u.ativo=true
      LEFT JOIN funcionario f ON f.empresa_id = e.id AND f.estado='ativo'
      GROUP BY e.id, s.estado, s.trial_fim, s.metodo_pagamento, p.nome, p.preco_mensal
      ORDER BY e.criado_em DESC
    `);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DETALHE DE UMA EMPRESA ────────────────────────────────────────────────────
router.get('/empresa/:id', autenticar, SA, async (req, res) => {
  try {
    const eid = req.params.id;
    const { rows:[empresa] } = await query('SELECT * FROM empresa WHERE id=$1', [eid]);
    if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada' });

    const { rows: utilizadores } = await query(
      "SELECT id, nome_completo, email, perfil, ativo, criado_em FROM utilizador WHERE empresa_id=$1 ORDER BY criado_em",
      [eid]
    );
    const { rows: subscricao } = await query(
      "SELECT s.*, p.nome AS plano_nome FROM subscricao s LEFT JOIN plano_saas p ON p.id=s.plano_id WHERE s.empresa_id=$1",
      [eid]
    );
    const { rows: facturas } = await query(
      "SELECT * FROM factura_saas WHERE empresa_id=$1 ORDER BY criado_em DESC LIMIT 10",
      [eid]
    );
    const { rows: addons } = await query(
      "SELECT ae.*, a.nome FROM addon_empresa ae JOIN addon a ON a.id=ae.addon_id WHERE ae.empresa_id=$1",
      [eid]
    );

    res.json({ empresa, utilizadores, subscricao: subscricao[0], facturas, addons });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── EDITAR EMPRESA ────────────────────────────────────────────────────────────
router.patch('/empresa/:id', autenticar, SA, async (req, res) => {
  try {
    const { nome, email, nif, plano, ativo, notas } = req.body;
    const { rows:[e] } = await query(`
      UPDATE empresa SET
        nome=COALESCE($1,nome), email=COALESCE($2,email),
        nif=COALESCE($3,nif), plano=COALESCE($4,plano),
        ativo=COALESCE($5,ativo)
      WHERE id=$6 RETURNING *
    `, [nome, email, nif, plano, ativo, req.params.id]);

    // Log
    await query(`INSERT INTO log_sistema (tipo,modulo,mensagem,empresa_id,utilizador_id)
      VALUES ('info','superadmin','Empresa editada via Super Admin',$1,$2)`,
      [req.params.id, req.utilizador.id]).catch(()=>{});

    res.json(e);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── IMPERSONAR EMPRESA (entrar como cliente) ──────────────────────────────────
router.post('/impersonar/:empresaId', autenticar, SA, async (req, res) => {
  try {
    const { motivo } = req.body;
    const { rows:[empresa] } = await query(
      'SELECT * FROM empresa WHERE id=$1 AND ativo=true', [req.params.empresaId]
    );
    if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada' });

    // Buscar admin da empresa (ou qualquer utilizador)
    let { rows:[admin] } = await query(
      "SELECT * FROM utilizador WHERE empresa_id=$1 AND ativo=true ORDER BY CASE perfil WHEN 'admin_empresa' THEN 1 WHEN 'rh' THEN 2 ELSE 3 END LIMIT 1",
      [req.params.empresaId]
    );

    // Se não há utilizador na empresa, usar o super_admin com contexto da empresa
    if (!admin) {
      admin = {
        id: req.utilizador.id,
        nome_completo: req.utilizador.nome_completo + ' (SA→' + empresa.nome + ')',
        perfil: 'admin_empresa',
      };
    }

    // Registar sessão de impersonation
    await query(`
      INSERT INTO impersonation_session (super_admin_id, empresa_id, motivo)
      VALUES ($1,$2,$3)
    `, [req.utilizador.id, req.params.empresaId, motivo||'Troubleshoot via Super Admin']);

    // Gerar token temporário (30 min) como admin da empresa
    const token = jwt.sign(
      {
        id: admin.id,
        empresa_id: empresa.id,
        perfil: 'admin_empresa',
        nome_completo: admin.nome_completo,
        empresa_nome: empresa.nome,
        impersonated_by: req.utilizador.id,
        impersonated_at: new Date().toISOString(),
      },
      process.env.JWT_SECRET,
      { expiresIn: '30m' }
    );

    // Log
    await query(`INSERT INTO log_sistema (tipo,modulo,mensagem,empresa_id,utilizador_id)
      VALUES ('acesso','superadmin',$1,$2,$3)`,
      [`Super Admin ${req.utilizador.nome_completo} entrou como ${empresa.nome}`, req.params.empresaId, req.utilizador.id]
    ).catch(()=>{});

    res.json({
      token,
      empresa: empresa.nome,
      empresa_id: empresa.id,
      admin_id: admin.id,
      admin_email: admin.email,
      expira_em: '30 minutos',
      aviso: 'Sessão de impersonation activa. Todas as acções ficam registadas.',
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── LOGS DO SISTEMA ───────────────────────────────────────────────────────────
router.get('/logs', autenticar, SA, async (req, res) => {
  try {
    const { tipo, empresa_id, limite = 50 } = req.query;
    let where = 'WHERE 1=1';
    const params = [];
    if (tipo) { params.push(tipo); where += ` AND tipo=$${params.length}`; }
    if (empresa_id) { params.push(empresa_id); where += ` AND empresa_id=$${params.length}`; }
    params.push(parseInt(limite));

    const { rows } = await query(`
      SELECT l.*, e.nome AS empresa_nome
      FROM log_sistema l
      LEFT JOIN empresa e ON e.id = l.empresa_id
      ${where}
      ORDER BY l.criado_em DESC
      LIMIT $${params.length}
    `, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── RESETAR PASSWORD DE UM UTILIZADOR ────────────────────────────────────────
router.post('/resetar-password/:userId', autenticar, SA, async (req, res) => {
  try {
    const novaSenha = crypto.randomBytes(6).toString('hex');
    const hash = await bcrypt.hash(novaSenha, 12);
    const { rows:[u] } = await query(
      'UPDATE utilizador SET password_hash=$1 WHERE id=$2 RETURNING email, nome_completo',
      [hash, req.params.userId]
    );
    if (!u) return res.status(404).json({ error: 'Utilizador não encontrado' });

    await query(`INSERT INTO log_sistema (tipo,modulo,mensagem,utilizador_id)
      VALUES ('info','superadmin',$1,$2)`,
      [`Password resetada para ${u.nome_completo} via Super Admin`, req.utilizador.id]
    ).catch(()=>{});

    res.json({ message: 'Password resetada', email: u.email, nova_password: novaSenha });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CONVIDAR NOVO SUPER ADMIN ─────────────────────────────────────────────────
router.post('/convidar', autenticar, SA, async (req, res) => {
  try {
    const { email, nome, nivel } = req.body;
    if (!email) return res.status(400).json({ error: 'Email obrigatório' });

    const token = crypto.randomBytes(32).toString('hex');
    const { rows:[convite] } = await query(`
      INSERT INTO superadmin_convite (email, nome, nivel, token, criado_por)
      VALUES ($1,$2,$3,$4,$5) RETURNING *
    `, [email, nome||null, nivel||'suporte', token, req.utilizador.id]);

    console.log(`📧 Convite Super Admin para ${email}: /super-admin/aceitar-convite/${token}`);
    res.status(201).json({
      message: `Convite enviado para ${email}`,
      token,
      link: `/api/superadmin/aceitar-convite/${token}`,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ACEITAR CONVITE ───────────────────────────────────────────────────────────
router.post('/aceitar-convite/:token', async (req, res) => {
  try {
    const { password } = req.body;
    const { rows:[convite] } = await query(
      "SELECT * FROM superadmin_convite WHERE token=$1 AND usado=false AND expira_em > NOW()",
      [req.params.token]
    );
    if (!convite) return res.status(404).json({ error: 'Convite inválido ou expirado' });

    const { rows:[empNex] } = await query("SELECT id FROM empresa WHERE email='admin@nexedge.pt' LIMIT 1");
    const hash = await bcrypt.hash(password || crypto.randomBytes(8).toString('hex'), 12);

    const { rows:[u] } = await query(`
      INSERT INTO utilizador (empresa_id, nome_completo, email, password_hash, perfil, ativo)
      VALUES ($1,$2,$3,$4,'super_admin',true)
      ON CONFLICT (email) DO UPDATE SET perfil='super_admin', password_hash=$4
      RETURNING *
    `, [empNex?.id, convite.nome||convite.email, convite.email, hash]);

    await query("UPDATE superadmin_convite SET usado=true WHERE id=$1", [convite.id]);

    res.json({ message: 'Conta Super Admin criada!', email: u.email });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── HISTÓRICO DE IMPERSONATIONS ───────────────────────────────────────────────
router.get('/impersonations', autenticar, SA, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT i.*, e.nome AS empresa_nome,
             u.nome_completo AS admin_nome, u.email AS admin_email
      FROM impersonation_session i
      JOIN empresa e ON e.id = i.empresa_id
      JOIN utilizador u ON u.id = i.super_admin_id
      ORDER BY i.iniciado_em DESC LIMIT 50
    `);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ── Analytics ─────────────────────────────────────────────────────────────────
router.get('/analytics', autenticar, SA, async (req, res) => {
  try {
    // Logins por dia (últimos 30 dias)
    const { rows: loginsPorDia } = await query(`
      SELECT DATE(ultimo_login) as dia, COUNT(*) as total
      FROM utilizador
      WHERE ultimo_login >= NOW() - INTERVAL '30 days'
        AND perfil != 'super_admin'
      GROUP BY DATE(ultimo_login)
      ORDER BY dia
    `).catch(()=>({rows:[]}));

    // Utilizadores activos hoje
    const { rows:[ativos_hoje] } = await query(`
      SELECT COUNT(DISTINCT u.id) as total
      FROM utilizador u
      WHERE u.ultimo_login >= CURRENT_DATE
        AND u.perfil != 'super_admin'
    `).catch(()=>({rows:[{total:0}]}));

    // Utilizadores activos esta semana
    const { rows:[ativos_semana] } = await query(`
      SELECT COUNT(DISTINCT u.id) as total
      FROM utilizador u
      WHERE u.ultimo_login >= NOW() - INTERVAL '7 days'
        AND u.perfil != 'super_admin'
    `).catch(()=>({rows:[{total:0}]}));

    // Utilizadores activos este mês
    const { rows:[ativos_mes] } = await query(`
      SELECT COUNT(DISTINCT u.id) as total
      FROM utilizador u
      WHERE u.ultimo_login >= NOW() - INTERVAL '30 days'
        AND u.perfil != 'super_admin'
    `).catch(()=>({rows:[{total:0}]}));

    // Registos por dia (últimos 30 dias)
    const { rows: registosPorDia } = await query(`
      SELECT DATE(criado_em) as dia, COUNT(*) as total
      FROM interesse_contacto
      WHERE criado_em >= NOW() - INTERVAL '30 days'
      GROUP BY DATE(criado_em)
      ORDER BY dia
    `).catch(()=>({rows:[]}));

    // Empresas por plano
    const { rows: empresasPorPlano } = await query(`
      SELECT 
        COALESCE(p.nome, 'Sem plano') as plano,
        COALESCE(s.estado, 'sem_sub') as estado,
        COUNT(*) as total
      FROM empresa e
      LEFT JOIN subscricao s ON s.empresa_id = e.id
      LEFT JOIN plano_saas p ON p.id = s.plano_id
      WHERE e.ativo = true
      GROUP BY p.nome, s.estado
      ORDER BY total DESC
    `).catch(()=>({rows:[]}));

    // Top empresas por actividade (mais logins)
    const { rows: topEmpresas } = await query(`
      SELECT e.nome, e.email,
        COUNT(u.id) as num_utilizadores,
        MAX(u.ultimo_login) as ultimo_acesso,
        COUNT(CASE WHEN u.ultimo_login >= NOW() - INTERVAL '7 days' THEN 1 END) as activos_semana
      FROM empresa e
      JOIN utilizador u ON u.empresa_id = e.id AND u.perfil != 'super_admin'
      WHERE e.ativo = true
      GROUP BY e.id, e.nome, e.email
      ORDER BY activos_semana DESC, ultimo_acesso DESC
      LIMIT 10
    `).catch(()=>({rows:[]}));

    // Conversão: registos → contas activas
    const { rows:[conversao] } = await query(`
      SELECT
        COUNT(*) as total_registos,
        COUNT(CASE WHEN u.ativo=true AND u.email_verificado=true THEN 1 END) as activados,
        COUNT(CASE WHEN u.ativo=false THEN 1 END) as pendentes,
        CASE WHEN COUNT(*) > 0 
          THEN ROUND(COUNT(CASE WHEN u.ativo=true AND u.email_verificado=true THEN 1 END) * 100.0 / COUNT(*), 1)
          ELSE 0 END as taxa_conversao
      FROM interesse_contacto i
      LEFT JOIN utilizador u ON u.email=i.email AND u.perfil='admin_empresa'
    `).catch(()=>({rows:[{total_registos:0,activados:0,pendentes:0,taxa_conversao:0}]}));

    res.json({
      logins_por_dia: loginsPorDia,
      registos_por_dia: registosPorDia,
      ativos_hoje: ativos_hoje?.total || 0,
      ativos_semana: ativos_semana?.total || 0,
      ativos_mes: ativos_mes?.total || 0,
      empresas_por_plano: empresasPorPlano,
      top_empresas: topEmpresas,
      conversao: conversao || {}
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
