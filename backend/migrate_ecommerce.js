'use strict';
require('dotenv').config();
const { query } = require('./src/config/database');

async function migrate() {
  console.log('🔧 E-commerce — Migração...');

  await query(`
    CREATE TABLE IF NOT EXISTS integracao_ecommerce (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
      plataforma VARCHAR(50) NOT NULL CHECK (plataforma IN ('shopify','woocommerce','moloni','prestashop','magento')),
      nome VARCHAR(200) NOT NULL,
      config JSONB NOT NULL DEFAULT '{}',
      ativo BOOLEAN DEFAULT true,
      ultimo_sync TIMESTAMPTZ,
      ultima_sync_resultado JSONB,
      criado_em TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(empresa_id, plataforma)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS encomenda (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
      numero VARCHAR(100) NOT NULL,
      origem VARCHAR(50) DEFAULT 'manual',
      origem_id VARCHAR(200),
      cliente_id UUID,
      cliente_nome VARCHAR(200),
      cliente_email VARCHAR(200),
      total NUMERIC(12,2) DEFAULT 0,
      estado VARCHAR(30) DEFAULT 'pendente' CHECK (estado IN ('pendente','confirmada','em_preparacao','enviada','entregue','cancelada','devolvida')),
      data_encomenda TIMESTAMPTZ DEFAULT NOW(),
      linhas JSONB DEFAULT '[]',
      tracking_code VARCHAR(200),
      tracking_url VARCHAR(500),
      campos_extra JSONB DEFAULT '{}',
      criado_em TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(empresa_id, origem, origem_id)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS produto (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
      nome VARCHAR(300) NOT NULL,
      referencia VARCHAR(200),
      descricao TEXT,
      preco_custo NUMERIC(10,2) DEFAULT 0,
      preco_venda NUMERIC(10,2) DEFAULT 0,
      iva_taxa NUMERIC(5,2) DEFAULT 23,
      stock_actual INTEGER DEFAULT 0,
      stock_minimo INTEGER DEFAULT 0,
      ativo BOOLEAN DEFAULT true,
      origem VARCHAR(50) DEFAULT 'manual',
      campos_extra JSONB DEFAULT '{}',
      criado_em TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(empresa_id, referencia)
    )
  `);

  await query(`CREATE INDEX IF NOT EXISTS idx_encomenda_empresa ON encomenda(empresa_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_encomenda_estado ON encomenda(estado)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_produto_empresa ON produto(empresa_id)`);

  console.log('✅ E-commerce migrado! Tabelas: integracao_ecommerce, encomenda, produto');
  process.exit(0);
}
migrate().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
