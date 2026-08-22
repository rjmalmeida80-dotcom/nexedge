'use strict';
require('dotenv').config();
const { query } = require('./src/config/database');

async function migrate() {
  console.log('🔧 Premium: CRM + Automações — Migração...');

  // Oportunidades
  await query(`CREATE TABLE IF NOT EXISTS oportunidade (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
    cliente_id UUID, titulo VARCHAR(300) NOT NULL, descricao TEXT,
    valor NUMERIC(14,2) DEFAULT 0, moeda VARCHAR(3) DEFAULT 'EUR',
    etapa VARCHAR(30) DEFAULT 'lead', estado VARCHAR(20) DEFAULT 'aberta',
    probabilidade INTEGER DEFAULT 10, score_ia INTEGER, analise_ia JSONB,
    data_fecho_prevista DATE, data_fecho DATE,
    responsavel_id UUID REFERENCES utilizador(id),
    origem VARCHAR(50) DEFAULT 'manual', motivo_perda TEXT,
    tags JSONB DEFAULT '[]', campos_extra JSONB DEFAULT '{}',
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  // Actividades CRM
  await query(`CREATE TABLE IF NOT EXISTS crm_actividade (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
    oportunidade_id UUID REFERENCES oportunidade(id) ON DELETE CASCADE,
    cliente_id UUID, tipo VARCHAR(30) DEFAULT 'nota',
    titulo VARCHAR(200) NOT NULL, descricao TEXT,
    data_agendada TIMESTAMPTZ, duracao_min INTEGER,
    estado VARCHAR(20) DEFAULT 'realizada',
    criado_por UUID REFERENCES utilizador(id), criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  // Automações
  await query(`CREATE TABLE IF NOT EXISTS automacao_config (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
    nome VARCHAR(200) NOT NULL, descricao TEXT,
    trigger_tipo VARCHAR(50) NOT NULL, condicoes JSONB DEFAULT '[]',
    acoes JSONB NOT NULL DEFAULT '[]', ativo BOOLEAN DEFAULT true,
    criado_por UUID REFERENCES utilizador(id), criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS automacao_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    automacao_id UUID REFERENCES automacao_config(id) ON DELETE CASCADE,
    empresa_id UUID, trigger_tipo VARCHAR(50),
    contexto JSONB, resultados JSONB,
    estado VARCHAR(20) DEFAULT 'sucesso',
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  await query(`CREATE INDEX IF NOT EXISTS idx_opp_empresa ON oportunidade(empresa_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_auto_empresa ON automacao_config(empresa_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_auto_trigger ON automacao_config(trigger_tipo)`);

  console.log('✅ Premium migrado! CRM + Automações prontos.');
  process.exit(0);
}
migrate().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
