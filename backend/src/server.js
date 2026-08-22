'use strict';

require('dotenv').config();
require('express-async-errors');

const express = require('express');
const scheduler = require('./utils/scheduler');
const { verificarAlertasFrota } = require('./utils/frotaAlertas');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const path = require('path');
const rateLimit = require('express-rate-limit');

const { connectDB } = require('./config/database');
const { errorHandler } = require('./middleware/errorHandler');
const { notFound } = require('./middleware/notFound');
const cronJobs = require('./services/cronJobs');

// Rotas
const authRoutes = require('./routes/auth');
const empresaRoutes = require('./routes/empresa');
const funcionarioRoutes = require('./routes/funcionario');
const horarioRoutes = require('./routes/horario');
const feriasRoutes = require('./routes/ferias');
const faltaRoutes = require('./routes/falta');
const salarioRoutes = require('./routes/salario');
const legislacaoRoutes = require('./routes/legislacao');
const relatorioRoutes = require('./routes/relatorio');
const documentoRoutes = require('./routes/documento');
const dashboardRoutes = require('./routes/dashboard');
const utilizadorRoutes = require('./routes/utilizador');
const notificacaoRoutes = require('./routes/notificacao');
const simuladorRoutes    = require('./routes/simulador');
const recrutamentoRoutes = require('./routes/recrutamento');
const avaliacaoRoutes    = require('./routes/avaliacao');
const comunicacaoRoutes  = require('./routes/comunicacao');

const app = express();

// ─── Segurança ───────────────────────────────────────────────────────────────
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
    }
  }
}));

// ─── CORS ────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: (origin, callback) => {
    const allowed = [
      process.env.FRONTEND_URL,
      process.env.LANDING_URL,
      'https://nexedge.pt',
      'https://www.nexedge.pt',
      'https://dev.nexedge.pt',
      'http://localhost:5173',
      'http://localhost:3000',
      'http://localhost:8080',
    ].filter(Boolean);
    // Permitir Vercel previews (*.vercel.app) e subdomínios nexedge.pt
    if (!origin || allowed.includes(origin) || origin.endsWith('.vercel.app') || origin.endsWith('.railway.app') || origin.endsWith('.nexedge.pt')) {
      callback(null, true);
    } else {
      callback(null, false);
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Empresa-ID'],
}));

// ─── Rate limiting ────────────────────────────────────────────────────────────
const limiterGeral = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 2000,
  message: { error: 'Demasiados pedidos. Tente novamente em 15 minutos.' }
});

const limiterAuth = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 2000,
  message: { error: 'Demasiadas tentativas de autenticação. Aguarda 15 minutos.' },
  skip: (req) => {
    const ip = req.ip || req.connection.remoteAddress || '';
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  },
});

app.use('/api/', limiterGeral);
app.use('/api/auth/', limiterAuth);

// ─── Middlewares base ─────────────────────────────────────────────────────────
app.use(compression());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ─── Ficheiros estáticos (uploads) ───────────────────────────────────────────
app.use('/uploads', express.static(path.join(__dirname, '../uploads'), {
  maxAge: '1d',
  etag: true,
}));

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
    env: process.env.NODE_ENV,
  });
});

// ─── Rotas da API ─────────────────────────────────────────────────────────────
app.use('/api/auth',          authRoutes);
app.use('/api/empresa',       empresaRoutes);
app.use('/api/funcionarios',  funcionarioRoutes);
app.use('/api/horarios',      horarioRoutes);
app.use('/api/ferias',        feriasRoutes);
app.use('/api/faltas',        faltaRoutes);
app.use('/api/presencas',     faltaRoutes); // alias
app.use('/api/salarios',      salarioRoutes);
app.use('/api/organograma', require('./routes/organograma'));
app.use('/api/contratos',   require('./routes/contratos'));
app.use('/api/pagamentos',  require('./routes/pagamentos'));
app.use('/api/ia',        require('./routes/ia'));
app.use('/api/perfis',     require('./routes/perfis'));
app.use('/api/monitor-legal', require('./routes/monitorLegal'));
app.use('/api/equipamentos',  require('./routes/equipamentos'));
app.use('/api/onboarding',    require('./routes/onboarding'));
app.use('/api/alertas',    require('./routes/alertas'));
app.use('/api/calendario',  require('./routes/calendario'));
app.use('/api/formacao',    require('./routes/formacao'));
app.use('/api/medicina',    require('./routes/medicina'));
app.use('/api/legislacao',    legislacaoRoutes);
app.use('/api/relatorios',    relatorioRoutes);
app.use('/api/2fa',               require('./routes/twofa'));
app.use('/api/chat',               require('./routes/chat'));
app.use('/api/templates-contratos', require('./routes/templates_contratos'));
app.use('/api/extractos-bancarios', require('./routes/extractos_bancarios'));
app.use('/api/portal-colaborador', require('./routes/portal_colaborador'));
app.use('/api/aprovacao-despesas', require('./routes/aprovacao_despesas'));
app.use('/api/irs-anual',         require('./routes/irs_anual'));
app.use('/api/kpis-rh',           require('./routes/kpis_rh'));
app.use('/api/exportacoes',       require('./routes/exportacoes'));
app.use('/api/infra',             require('./routes/infra'));
app.use('/api/multi-empresa',     require('./routes/multiEmpresa'));
app.use('/api/integracoes',       require('./routes/integracoes'));
app.use('/api/auditoria',         require('./routes/auditoria'));
app.use('/api/backups',           require('./routes/backups'));
app.use('/api/relatorios-pdf',    require('./routes/relatorio_pdf'));
app.use('/api/documentos',    documentoRoutes);
app.use('/api/dashboard',     dashboardRoutes);
app.use('/api/utilizadores',  utilizadorRoutes);
app.use('/api/notificacoes',  notificacaoRoutes);
app.use('/api/simulador',     simuladorRoutes);
app.use('/api/recrutamento',  recrutamentoRoutes);
app.use('/api/avaliacao',     avaliacaoRoutes);
app.use('/api/comunicacao',   comunicacaoRoutes);
app.use('/api/logistica', require('./routes/logistica'));
app.use('/api/turnos', require('./routes/turnos-rotativos'));
app.use('/api/orcamentos', require('./routes/orcamentos'));
app.use('/api/auth/2fa', require('./routes/auth-2fa'));
app.use('/api/logistica', require('./routes/logistica'));
app.use('/api/turnos', require('./routes/turnos-rotativos'));
app.use('/api/orcamentos', require('./routes/orcamentos'));
app.use('/api/auth/2fa', require('./routes/auth-2fa'));
app.use('/api/aging', require('./routes/aging-cobranca'));
app.use('/api/contratos', require('./routes/gestao-contratos'));
app.use('/api/auditoria', require('./routes/auditoria-trail').router);
app.use('/api/webhooks', require('./routes/webhooks').router);
app.use('/api/relatorio-unico', require('./routes/relatorio-unico'));
app.use('/api/dmr',             require('./routes/dmr'));
app.use('/api/faturacao',       require('./routes/faturacao'));
app.use('/api/compras',         require('./routes/compras'));
app.use('/api/ativos',          require('./routes/ativos'));
app.use('/api/contabilidade',   require('./routes/contabilidade'));
app.use('/api/despesas',        require('./routes/despesas'));
app.use('/api/frota',           require('./routes/frota'));
app.use('/api/turnos-rotativos', require('./routes/turnosRotativos'));
app.use('/api/modelo3',          require('./routes/modelo3'));
app.use('/api/saft',             require('./routes/saft'));
app.use('/api/saas/metrics', require('./routes/saas-metrics'));
app.use('/api/logistica', require('./routes/logistica'));
app.use('/api/turnos', require('./routes/turnos-rotativos'));
app.use('/api/orcamentos', require('./routes/orcamentos'));
app.use('/api/auth/2fa', require('./routes/auth-2fa'));
app.use('/api/logistica', require('./routes/logistica'));
app.use('/api/turnos', require('./routes/turnos-rotativos'));
app.use('/api/orcamentos', require('./routes/orcamentos'));
app.use('/api/auth/2fa', require('./routes/auth-2fa'));
app.use('/api/aging', require('./routes/aging-cobranca'));
app.use('/api/contratos', require('./routes/gestao-contratos'));
app.use('/api/auditoria', require('./routes/auditoria-trail').router);
app.use('/api/webhooks', require('./routes/webhooks').router);
app.use('/api/relatorio-unico', require('./routes/relatorio-unico'));
app.use('/api/competencias', require('./routes/gestao-competencias'));
app.use('/api/centros-custo', require('./routes/centros-custo'));
app.use('/api/okrs', require('./routes/okrs'));
app.use('/api/feedback-360', require('./routes/feedback-360'));
app.use('/api/activos-fixos', require('./routes/activos-fixos'));
app.use('/api/sepa', require('./routes/sepa-pagamentos'));
app.use('/api/aprovacoes', require('./routes/aprovacoes'));
app.use('/api/crm/pipeline', require('./routes/crm-premium'));
app.use('/api/automacoes-config', require('./routes/automacoes-premium').router);
app.use('/api/openbanking', require('./routes/open-banking'));
app.use('/api/portal-fornecedor', require('./routes/portal-fornecedor'));
app.use('/api/projectos', require('./routes/projectos'));
app.use('/api/assinaturas', require('./routes/assinatura-digital'));
app.use('/api/multi-empresa', require('./routes/multi-empresa'));
app.use('/api/ia', require('./routes/ia-assistente'));
app.use('/api/at', require('./routes/at-integracao'));
app.use('/api/whatsapp', require('./routes/whatsapp').router);
app.use('/api/ecommerce', require('./routes/ecommerce-sync').router);
app.use('/api/iva', require('./routes/iva-automatico'));
app.use('/api/portal-cliente', require('./routes/portal-cliente'));
app.use('/api/benefits', require('./routes/benefits'));
app.use('/api/equidade-salarial', require('./routes/equidade-salarial'));
app.use('/api/saas/metrics', require('./routes/saas-metrics'));
app.use('/api/saas',             require('./routes/saas'));
app.use('/api/addons',           require('./routes/addons'));
app.use('/api/superadmin',       require('./routes/superadmin'));
app.use('/api/at',               require('./routes/at'));
app.use('/api/tickets',          require('./routes/tickets'));
app.use('/api/recorrente',       require('./routes/recorrente'));
app.use('/api/crm',              require('./routes/crm'));
app.use('/api/logistica', require('./routes/logistica'));
app.use('/api/turnos', require('./routes/turnos-rotativos'));
app.use('/api/orcamentos', require('./routes/orcamentos'));
app.use('/api/auth/2fa', require('./routes/auth-2fa'));
app.use('/api/logistica', require('./routes/logistica'));
app.use('/api/turnos', require('./routes/turnos-rotativos'));
app.use('/api/orcamentos', require('./routes/orcamentos'));
app.use('/api/auth/2fa', require('./routes/auth-2fa'));
app.use('/api/aging', require('./routes/aging-cobranca'));
app.use('/api/contratos', require('./routes/gestao-contratos'));
app.use('/api/auditoria', require('./routes/auditoria-trail').router);
app.use('/api/webhooks', require('./routes/webhooks').router);
app.use('/api/relatorio-unico', require('./routes/relatorio-unico'));
app.use('/api/competencias', require('./routes/gestao-competencias'));
app.use('/api/centros-custo', require('./routes/centros-custo'));
app.use('/api/okrs', require('./routes/okrs'));
app.use('/api/feedback-360', require('./routes/feedback-360'));
app.use('/api/activos-fixos', require('./routes/activos-fixos'));
app.use('/api/sepa', require('./routes/sepa-pagamentos'));
app.use('/api/aprovacoes', require('./routes/aprovacoes'));
app.use('/api/crm/pipeline', require('./routes/crm-premium'));
app.use('/api/automacoes-config', require('./routes/automacoes-premium').router);
app.use('/api/openbanking', require('./routes/open-banking'));
app.use('/api/portal-fornecedor', require('./routes/portal-fornecedor'));
app.use('/api/projectos', require('./routes/projectos'));
app.use('/api/assinaturas',      require('./routes/assinaturas'));
app.use('/api/logistica', require('./routes/logistica'));
app.use('/api/turnos', require('./routes/turnos-rotativos'));
app.use('/api/orcamentos', require('./routes/orcamentos'));
app.use('/api/auth/2fa', require('./routes/auth-2fa'));
app.use('/api/logistica', require('./routes/logistica'));
app.use('/api/turnos', require('./routes/turnos-rotativos'));
app.use('/api/orcamentos', require('./routes/orcamentos'));
app.use('/api/auth/2fa', require('./routes/auth-2fa'));
app.use('/api/aging', require('./routes/aging-cobranca'));
app.use('/api/contratos', require('./routes/gestao-contratos'));
app.use('/api/auditoria', require('./routes/auditoria-trail').router);
app.use('/api/webhooks', require('./routes/webhooks').router);
app.use('/api/relatorio-unico', require('./routes/relatorio-unico'));
app.use('/api/competencias', require('./routes/gestao-competencias'));
app.use('/api/centros-custo', require('./routes/centros-custo'));
app.use('/api/okrs', require('./routes/okrs'));
app.use('/api/feedback-360', require('./routes/feedback-360'));
app.use('/api/activos-fixos', require('./routes/activos-fixos'));
app.use('/api/sepa', require('./routes/sepa-pagamentos'));
app.use('/api/aprovacoes', require('./routes/aprovacoes'));
app.use('/api/crm/pipeline', require('./routes/crm-premium'));
app.use('/api/automacoes-config', require('./routes/automacoes-premium').router);
app.use('/api/openbanking',      require('./routes/openbanking'));
app.use('/api/perfil-empresa', require('./routes/perfil_empresa'));
app.use('/api/itsm/portal', require('./routes/itsm-portal'));
app.use('/api/itsm/chatbot', require('./routes/itsm-chatbot'));
app.use('/api/time-tracking', require('./routes/time-tracking'));
app.use('/api/itsm',          require('./routes/itsm'));
app.use('/api/portal-fornecedor', require('./routes/portalFornecedor'));

// ─── Tratamento de erros ──────────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

// ─── Arranque ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;

async function start() {
  try {
    await connectDB();
    console.log('✅ Base de dados conectada');

    // Migrações automáticas v4 (Relatório Único)
    try {
      const { migrar: migrarV4 } = require('./config/migrate_v4');
      await migrarV4();
    } catch(e) { console.warn('⚠️  migrate_v4 (não bloqueante):', e.message); }

    // Migrações automáticas v5 (DMR + DRI)
    try {
      const { migrar: migrarV5 } = require('./config/migrate_v5');
      await migrarV5();
    } catch(e) { console.warn('⚠️  migrate_v5 (não bloqueante):', e.message); }

    // Migrações automáticas v6 (Faturação AT)
    try {
      const { migrar: migrarV6 } = require('./config/migrate_v6');
      await migrarV6();
    } catch(e) { console.warn('⚠️  migrate_v6 (não bloqueante):', e.message); }

    // Migrações automáticas v7 (Fornecedores, Compras, Stocks)
    try {
      const { migrar: migrarV7 } = require('./config/migrate_v7');
      await migrarV7();
    } catch(e) { console.warn('⚠️  migrate_v7 (não bloqueante):', e.message); }

    // Migrações automáticas v8 (Activos Fixos)
    try {
      const { migrar: migrarV8 } = require('./config/migrate_v8');
      await migrarV8();
    } catch(e) { console.warn('⚠️  migrate_v8 (não bloqueante):', e.message); }

    // Migrações automáticas v9 (Contabilidade SNC)
    try {
      const { migrar: migrarV9 } = require('./config/migrate_v9');
      await migrarV9();
    } catch(e) { console.warn('⚠️  migrate_v9 (não bloqueante):', e.message); }

    // Migrações automáticas v10 (Despesas)
    try {
      const { migrar: migrarV10 } = require('./config/migrate_v10');
      await migrarV10();
    } catch(e) { console.warn('⚠️  migrate_v10 (não bloqueante):', e.message); }

    // Migrações automáticas v11 (Frota)
    try {
      const { migrar: migrarV11 } = require('./config/migrate_v11');
      await migrarV11();
    } catch(e) { console.warn('⚠️  migrate_v11 (não bloqueante):', e.message); }
    // Migrações automáticas v12 (ERP Adaptativo)
    try {
      const { migrar: migrarV12 } = require('./config/migrate_v12');
      await migrarV12();
    } catch(e) { console.warn('⚠️  migrate_v12 (não bloqueante):', e.message); }

    app.listen(PORT, () => {
      console.log(`✅ NexEdge — Servidor na porta ${PORT}`);
      console.log(`✅ Ambiente: ${process.env.NODE_ENV}`);
    });

    // Iniciar tarefas automáticas (cron)
    cronJobs.iniciar();
    console.log('✅ Tarefas automáticas iniciadas');

  } catch (err) {
    console.error('❌ Erro ao iniciar servidor:', err);
    process.exit(1);
  }
}

start();

module.exports = app;



