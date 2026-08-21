'use strict';
const { query } = require('./src/config/database');

async function migrate() {
  console.log('🔧 ITSM — Migração completa...');

  // ── 1. Catálogo de Serviços ──────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS itsm_categoria (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
      nome VARCHAR(100) NOT NULL,
      descricao TEXT,
      icone VARCHAR(50) DEFAULT '🎫',
      cor VARCHAR(20) DEFAULT '#4F46E5',
      sla_resposta_h INTEGER DEFAULT 4,
      sla_resolucao_h INTEGER DEFAULT 24,
      ativo BOOLEAN DEFAULT true,
      ordem INTEGER DEFAULT 0,
      criado_em TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS itsm_servico (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
      categoria_id UUID REFERENCES itsm_categoria(id),
      nome VARCHAR(200) NOT NULL,
      descricao TEXT,
      tipo VARCHAR(30) DEFAULT 'request' CHECK (tipo IN ('incident','request','problem','change','task')),
      prioridade_default VARCHAR(20) DEFAULT 'media' CHECK (prioridade_default IN ('critica','alta','media','baixa')),
      sla_resposta_h INTEGER DEFAULT 4,
      sla_resolucao_h INTEGER DEFAULT 24,
      campos_extra JSONB DEFAULT '[]',
      aprovacao_necessaria BOOLEAN DEFAULT false,
      aprovador_id UUID REFERENCES utilizador(id),
      ativo BOOLEAN DEFAULT true,
      criado_em TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── 2. Tickets / Incidentes / Pedidos ────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS itsm_ticket (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
      numero VARCHAR(20) UNIQUE NOT NULL,
      tipo VARCHAR(30) DEFAULT 'request' CHECK (tipo IN ('incident','request','problem','change','task')),
      titulo VARCHAR(300) NOT NULL,
      descricao TEXT,
      categoria_id UUID REFERENCES itsm_categoria(id),
      servico_id UUID REFERENCES itsm_servico(id),
      prioridade VARCHAR(20) DEFAULT 'media' CHECK (prioridade IN ('critica','alta','media','baixa')),
      impacto VARCHAR(20) DEFAULT 'individual' CHECK (impacto IN ('individual','departamento','empresa','critico')),
      urgencia VARCHAR(20) DEFAULT 'normal' CHECK (urgencia IN ('planeado','normal','urgente','imediato')),
      estado VARCHAR(30) DEFAULT 'aberto' CHECK (estado IN ('aberto','em_progresso','pendente','resolvido','fechado','cancelado')),
      
      -- Pessoas
      criado_por UUID REFERENCES utilizador(id),
      solicitante_id UUID REFERENCES utilizador(id),
      atribuido_a UUID REFERENCES utilizador(id),
      grupo_id UUID,
      
      -- SLA
      sla_resposta_h INTEGER DEFAULT 4,
      sla_resolucao_h INTEGER DEFAULT 24,
      data_limite_resposta TIMESTAMPTZ,
      data_limite_resolucao TIMESTAMPTZ,
      data_primeira_resposta TIMESTAMPTZ,
      sla_resposta_cumprido BOOLEAN,
      sla_resolucao_cumprido BOOLEAN,
      
      -- Resolução
      resolucao TEXT,
      causa_raiz TEXT,
      solucao_contorno TEXT,
      satisfacao INTEGER CHECK (satisfacao BETWEEN 1 AND 5),
      feedback_cliente TEXT,
      
      -- Integrações
      funcionario_id UUID REFERENCES funcionario(id),
      viatura_id UUID,
      ativo_id UUID,
      
      -- Controlo
      tempo_resolucao_min INTEGER,
      reaberto_vezes INTEGER DEFAULT 0,
      tags JSONB DEFAULT '[]',
      campos_extra JSONB DEFAULT '{}',
      
      criado_em TIMESTAMPTZ DEFAULT NOW(),
      actualizado_em TIMESTAMPTZ DEFAULT NOW(),
      resolvido_em TIMESTAMPTZ,
      fechado_em TIMESTAMPTZ
    )
  `);

  // ── 3. Comentários / Actividade ──────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS itsm_comentario (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ticket_id UUID NOT NULL REFERENCES itsm_ticket(id) ON DELETE CASCADE,
      autor_id UUID REFERENCES utilizador(id),
      conteudo TEXT NOT NULL,
      tipo VARCHAR(20) DEFAULT 'comentario' CHECK (tipo IN ('comentario','nota_interna','resolucao','estado','atribuicao','sistema')),
      visivelParaCliente BOOLEAN DEFAULT true,
      tempo_gasto_min INTEGER DEFAULT 0,
      criado_em TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── 4. Anexos ─────────────────────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS itsm_anexo (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ticket_id UUID NOT NULL REFERENCES itsm_ticket(id) ON DELETE CASCADE,
      nome VARCHAR(300) NOT NULL,
      url TEXT NOT NULL,
      tamanho INTEGER,
      mime_type VARCHAR(100),
      enviado_por UUID REFERENCES utilizador(id),
      criado_em TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── 5. SLA Políticas ─────────────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS itsm_sla (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
      nome VARCHAR(100) NOT NULL,
      descricao TEXT,
      tipo VARCHAR(30) DEFAULT 'request',
      prioridade VARCHAR(20) DEFAULT 'media',
      resposta_h INTEGER NOT NULL DEFAULT 4,
      resolucao_h INTEGER NOT NULL DEFAULT 24,
      horario_negocio BOOLEAN DEFAULT true,
      ativo BOOLEAN DEFAULT true,
      criado_em TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── 6. Problem Management ─────────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS itsm_problema (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
      numero VARCHAR(20) UNIQUE NOT NULL,
      titulo VARCHAR(300) NOT NULL,
      descricao TEXT,
      estado VARCHAR(30) DEFAULT 'investigacao' CHECK (estado IN ('investigacao','causa_identificada','solucao_conhecida','resolvido','fechado')),
      prioridade VARCHAR(20) DEFAULT 'media',
      categoria_id UUID REFERENCES itsm_categoria(id),
      responsavel_id UUID REFERENCES utilizador(id),
      causa_raiz TEXT,
      solucao_definitiva TEXT,
      workaround TEXT,
      impacto TEXT,
      tickets_relacionados JSONB DEFAULT '[]',
      criado_em TIMESTAMPTZ DEFAULT NOW(),
      actualizado_em TIMESTAMPTZ DEFAULT NOW(),
      resolvido_em TIMESTAMPTZ
    )
  `);

  // ── 7. Change Management ──────────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS itsm_mudanca (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
      numero VARCHAR(20) UNIQUE NOT NULL,
      titulo VARCHAR(300) NOT NULL,
      descricao TEXT,
      tipo VARCHAR(30) DEFAULT 'normal' CHECK (tipo IN ('standard','normal','emergencia')),
      estado VARCHAR(30) DEFAULT 'rascunho' CHECK (estado IN ('rascunho','em_revisao','aprovado','em_execucao','concluido','cancelado','rejeitado')),
      prioridade VARCHAR(20) DEFAULT 'media',
      risco VARCHAR(20) DEFAULT 'medio' CHECK (risco IN ('baixo','medio','alto','critico')),
      responsavel_id UUID REFERENCES utilizador(id),
      aprovador_id UUID REFERENCES utilizador(id),
      janela_inicio TIMESTAMPTZ,
      janela_fim TIMESTAMPTZ,
      plano_execucao TEXT,
      plano_rollback TEXT,
      justificacao TEXT,
      impacto TEXT,
      sistemas_afectados JSONB DEFAULT '[]',
      aprovado_em TIMESTAMPTZ,
      aprovado_por UUID REFERENCES utilizador(id),
      criado_em TIMESTAMPTZ DEFAULT NOW(),
      actualizado_em TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── 8. Knowledge Base ─────────────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS itsm_conhecimento (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
      titulo VARCHAR(300) NOT NULL,
      conteudo TEXT NOT NULL,
      categoria_id UUID REFERENCES itsm_categoria(id),
      tipo VARCHAR(30) DEFAULT 'artigo' CHECK (tipo IN ('artigo','faq','workaround','procedimento','erro_conhecido')),
      estado VARCHAR(20) DEFAULT 'publicado' CHECK (estado IN ('rascunho','revisao','publicado','arquivado')),
      autor_id UUID REFERENCES utilizador(id),
      revisor_id UUID REFERENCES utilizador(id),
      visualizacoes INTEGER DEFAULT 0,
      util_sim INTEGER DEFAULT 0,
      util_nao INTEGER DEFAULT 0,
      tags JSONB DEFAULT '[]',
      ticket_origem_id UUID REFERENCES itsm_ticket(id),
      criado_em TIMESTAMPTZ DEFAULT NOW(),
      actualizado_em TIMESTAMPTZ DEFAULT NOW(),
      publicado_em TIMESTAMPTZ
    )
  `);

  // ── 9. Grupos / Equipas ───────────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS itsm_grupo (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
      nome VARCHAR(100) NOT NULL,
      descricao TEXT,
      email VARCHAR(200),
      gestor_id UUID REFERENCES utilizador(id),
      ativo BOOLEAN DEFAULT true,
      criado_em TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS itsm_grupo_membro (
      grupo_id UUID NOT NULL REFERENCES itsm_grupo(id) ON DELETE CASCADE,
      utilizador_id UUID NOT NULL REFERENCES utilizador(id) ON DELETE CASCADE,
      PRIMARY KEY (grupo_id, utilizador_id)
    )
  `);

  // ── 10. Portal de Self-Service (tokens externos) ─────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS itsm_portal_sessao (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
      email VARCHAR(200) NOT NULL,
      nome VARCHAR(200),
      token VARCHAR(100) UNIQUE NOT NULL,
      ativo BOOLEAN DEFAULT true,
      criado_em TIMESTAMPTZ DEFAULT NOW(),
      expira_em TIMESTAMPTZ DEFAULT NOW() + INTERVAL '30 days'
    )
  `);

  // ── 11. Métricas / KPIs cache ─────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS itsm_metrica_diaria (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
      data DATE NOT NULL,
      tickets_abertos INTEGER DEFAULT 0,
      tickets_resolvidos INTEGER DEFAULT 0,
      tickets_fechados INTEGER DEFAULT 0,
      sla_resposta_pct NUMERIC(5,2) DEFAULT 0,
      sla_resolucao_pct NUMERIC(5,2) DEFAULT 0,
      tempo_medio_resolucao_min INTEGER DEFAULT 0,
      satisfacao_media NUMERIC(3,2) DEFAULT 0,
      UNIQUE(empresa_id, data)
    )
  `);

  // ── Índices ───────────────────────────────────────────────────────────────
  await query(`CREATE INDEX IF NOT EXISTS idx_itsm_ticket_empresa ON itsm_ticket(empresa_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_itsm_ticket_estado ON itsm_ticket(estado)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_itsm_ticket_atribuido ON itsm_ticket(atribuido_a)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_itsm_ticket_criado ON itsm_ticket(criado_em DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_itsm_ticket_sla ON itsm_ticket(data_limite_resolucao)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_itsm_comentario_ticket ON itsm_comentario(ticket_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_itsm_conhecimento_empresa ON itsm_conhecimento(empresa_id)`);

  // ── Categorias default ────────────────────────────────────────────────────
  console.log('✅ Tabelas ITSM criadas. Seed de categorias default...');

  // Nota: as categorias default são criadas por empresa no primeiro acesso
  // via a rota /api/itsm/setup

  console.log('✅ Migração ITSM completa!');
  console.log('   Tabelas: itsm_categoria, itsm_servico, itsm_ticket,');
  console.log('            itsm_comentario, itsm_anexo, itsm_sla,');
  console.log('            itsm_problema, itsm_mudanca, itsm_conhecimento,');
  console.log('            itsm_grupo, itsm_grupo_membro, itsm_portal_sessao,');
  console.log('            itsm_metrica_diaria');
  process.exit(0);
}

migrate().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
