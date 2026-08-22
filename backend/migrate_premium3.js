'use strict';
require('dotenv').config();
const { query } = require('./src/config/database');

async function migrate() {
  console.log('🔧 Relatório Único + Competências + Centros Custo — Migração...');

  // Relatório Único
  await query(`CREATE TABLE IF NOT EXISTS relatorio_unico (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
    ano INTEGER NOT NULL,
    dados JSONB DEFAULT '{}',
    estado VARCHAR(20) DEFAULT 'rascunho',
    submetido_em TIMESTAMPTZ,
    actualizado_em TIMESTAMPTZ DEFAULT NOW(),
    criado_em TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(empresa_id, ano)
  )`);

  // Competências
  await query(`CREATE TABLE IF NOT EXISTS competencia (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID REFERENCES empresa(id) ON DELETE CASCADE,
    nome VARCHAR(200) NOT NULL,
    categoria VARCHAR(50) DEFAULT 'tecnica',
    descricao TEXT,
    niveis_descricao JSONB DEFAULT '{}',
    global BOOLEAN DEFAULT false,
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS funcionario_competencia (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL,
    funcionario_id UUID NOT NULL REFERENCES funcionario(id) ON DELETE CASCADE,
    competencia_id UUID NOT NULL REFERENCES competencia(id) ON DELETE CASCADE,
    nivel INTEGER DEFAULT 0 CHECK (nivel BETWEEN 0 AND 5),
    validado BOOLEAN DEFAULT false,
    notas TEXT,
    avaliado_por UUID REFERENCES utilizador(id),
    avaliado_em TIMESTAMPTZ,
    criado_em TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(funcionario_id, competencia_id)
  )`);

  await query(`CREATE TABLE IF NOT EXISTS cargo_competencia (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL,
    cargo VARCHAR(200) NOT NULL,
    competencia_id UUID NOT NULL REFERENCES competencia(id) ON DELETE CASCADE,
    nivel_minimo INTEGER DEFAULT 3,
    UNIQUE(empresa_id, cargo, competencia_id)
  )`);

  // Centros de Custo
  await query(`CREATE TABLE IF NOT EXISTS centro_custo (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
    codigo VARCHAR(20) NOT NULL,
    nome VARCHAR(200) NOT NULL,
    descricao TEXT,
    responsavel_id UUID REFERENCES utilizador(id),
    orcamento_anual NUMERIC(14,2) DEFAULT 0,
    cc_pai_id UUID REFERENCES centro_custo(id),
    ativo BOOLEAN DEFAULT true,
    criado_em TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(empresa_id, codigo)
  )`);

  // Adicionar centro_custo_id às tabelas existentes
  await query(`ALTER TABLE fatura ADD COLUMN IF NOT EXISTS centro_custo_id UUID REFERENCES centro_custo(id)`);
  await query(`ALTER TABLE despesa ADD COLUMN IF NOT EXISTS centro_custo_id UUID REFERENCES centro_custo(id)`);
  await query(`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS habilitacoes VARCHAR(50)`);
  await query(`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS data_nascimento DATE`);
  await query(`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS genero VARCHAR(1)`);
  await query(`ALTER TABLE empresa ADD COLUMN IF NOT EXISTS cae VARCHAR(10)`);
  await query(`ALTER TABLE empresa ADD COLUMN IF NOT EXISTS natureza_juridica VARCHAR(30)`);
  await query(`ALTER TABLE empresa ADD COLUMN IF NOT EXISTS capital_social NUMERIC(14,2)`);
  await query(`ALTER TABLE empresa ADD COLUMN IF NOT EXISTS ano_constituicao INTEGER`);

  await query(`CREATE INDEX IF NOT EXISTS idx_cc_empresa ON centro_custo(empresa_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_comp_empresa ON competencia(empresa_id)`);

  console.log('✅ Premium 3 migrado!');
  process.exit(0);
}
migrate().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
