'use strict';
require('dotenv').config();
const { query } = require('./src/config/database');

async function migrate() {
  console.log('🔧 Aprovações em Cadeia + SEPA — Migração...');

  await query(`CREATE TABLE IF NOT EXISTS aprovacao_fluxo (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
    nome VARCHAR(200) NOT NULL,
    tipo VARCHAR(50) NOT NULL,
    niveis JSONB DEFAULT '[]',
    condicoes JSONB DEFAULT '[]',
    ativo BOOLEAN DEFAULT true,
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS aprovacao_pedido (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
    fluxo_id UUID REFERENCES aprovacao_fluxo(id),
    titulo VARCHAR(300) NOT NULL,
    descricao TEXT,
    entidade_tipo VARCHAR(50),
    entidade_id UUID,
    dados JSONB DEFAULT '{}',
    urgente BOOLEAN DEFAULT false,
    solicitante_id UUID REFERENCES utilizador(id),
    estado VARCHAR(20) DEFAULT 'em_aprovacao',
    nivel_actual INTEGER DEFAULT 1,
    motivo_rejeicao TEXT,
    concluido_em TIMESTAMPTZ,
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS aprovacao_nivel (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pedido_id UUID NOT NULL REFERENCES aprovacao_pedido(id) ON DELETE CASCADE,
    nivel INTEGER NOT NULL,
    aprovador_id UUID REFERENCES utilizador(id),
    aprovador_tipo VARCHAR(30) DEFAULT 'utilizador',
    prazo_horas INTEGER DEFAULT 24,
    estado VARCHAR(20) DEFAULT 'aguarda',
    comentario TEXT,
    aprovado_em TIMESTAMPTZ,
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  await query(`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS chefe_directo_id UUID REFERENCES funcionario(id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_aprov_empresa ON aprovacao_pedido(empresa_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_aprov_estado ON aprovacao_pedido(estado)`);

  console.log('✅ Aprovações + SEPA migrados!');
  process.exit(0);
}
migrate().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
