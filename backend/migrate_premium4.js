'use strict';
require('dotenv').config();
const { query } = require('./src/config/database');

async function migrate() {
  console.log('🔧 Contratos + Aging + Auditoria + Webhooks — Migração...');

  // Contratos
  await query(`CREATE TABLE IF NOT EXISTS contrato (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
    titulo VARCHAR(300) NOT NULL,
    tipo VARCHAR(30) DEFAULT 'servicos',
    descricao TEXT,
    cliente_id UUID,
    fornecedor_id UUID,
    valor NUMERIC(14,2) DEFAULT 0,
    moeda VARCHAR(3) DEFAULT 'EUR',
    data_inicio DATE,
    data_fim DATE,
    renovacao_automatica BOOLEAN DEFAULT false,
    aviso_renovacao_dias INTEGER DEFAULT 30,
    responsavel_id UUID REFERENCES utilizador(id),
    estado VARCHAR(20) DEFAULT 'rascunho',
    clausulas JSONB DEFAULT '[]',
    tags JSONB DEFAULT '[]',
    contrato_pai_id UUID REFERENCES contrato(id),
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  // Cobrança
  await query(`CREATE TABLE IF NOT EXISTS cobranca_sequencia (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
    nome VARCHAR(200) NOT NULL,
    passos JSONB DEFAULT '[]',
    ativo BOOLEAN DEFAULT true,
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS cobranca_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL,
    fatura_id UUID,
    cliente_id UUID,
    canal VARCHAR(20),
    dias_passo INTEGER,
    mensagem_enviada TEXT,
    criado_em TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(fatura_id, dias_passo)
  )`);

  // Auditoria
  await query(`CREATE TABLE IF NOT EXISTS auditoria_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID,
    utilizador_id UUID,
    accao VARCHAR(30),
    entidade VARCHAR(100),
    entidade_id UUID,
    dados_antes JSONB,
    dados_depois JSONB,
    ip VARCHAR(50),
    user_agent VARCHAR(200),
    url VARCHAR(500),
    metodo VARCHAR(10),
    duracao_ms INTEGER,
    estado_http INTEGER,
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  await query(`CREATE INDEX IF NOT EXISTS idx_audit_empresa ON auditoria_log(empresa_id, criado_em DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_audit_utilizador ON auditoria_log(utilizador_id)`);

  // Webhooks
  await query(`CREATE TABLE IF NOT EXISTS webhook (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    eventos JSONB DEFAULT '[]',
    descricao TEXT,
    secret VARCHAR(100),
    ativo BOOLEAN DEFAULT true,
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS webhook_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    webhook_id UUID REFERENCES webhook(id) ON DELETE CASCADE,
    empresa_id UUID,
    evento VARCHAR(100),
    payload TEXT,
    status_http INTEGER,
    resposta TEXT,
    sucesso BOOLEAN DEFAULT false,
    duracao_ms INTEGER,
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  await query(`CREATE INDEX IF NOT EXISTS idx_contrato_empresa ON contrato(empresa_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_webhook_empresa ON webhook(empresa_id)`);

  console.log('✅ Premium 4 migrado!');
  process.exit(0);
}
migrate().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
