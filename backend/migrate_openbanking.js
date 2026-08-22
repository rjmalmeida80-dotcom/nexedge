'use strict';
require('dotenv').config();
const { query } = require('./src/config/database');

async function migrate() {
  console.log('🔧 Open Banking + Portal Fornecedor — Migração...');

  // Contas bancárias
  await query(`
    CREATE TABLE IF NOT EXISTS conta_bancaria (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
      banco VARCHAR(50) NOT NULL,
      iban VARCHAR(30),
      nome VARCHAR(200),
      saldo_actual NUMERIC(14,2) DEFAULT 0,
      moeda VARCHAR(3) DEFAULT 'EUR',
      ativo BOOLEAN DEFAULT true,
      psd2_token TEXT,
      psd2_expires TIMESTAMPTZ,
      ultimo_sync TIMESTAMPTZ,
      criado_em TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(empresa_id, iban)
    )
  `);

  // Extracto bancário
  await query(`
    CREATE TABLE IF NOT EXISTS extrato_bancario (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
      conta_id UUID REFERENCES conta_bancaria(id) ON DELETE CASCADE,
      data DATE NOT NULL,
      descricao TEXT,
      valor NUMERIC(14,2) NOT NULL,
      referencia VARCHAR(200),
      categoria VARCHAR(100),
      reconciliado BOOLEAN DEFAULT false,
      reconciliado_em TIMESTAMPTZ,
      reconciliado_com_tipo VARCHAR(30),
      reconciliado_com_id UUID,
      sugestao_match_tipo VARCHAR(30),
      sugestao_match_id UUID,
      sugestao_score INTEGER,
      criado_em TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(empresa_id, conta_id, data, valor, descricao)
    )
  `);

  // Portal fornecedor
  await query(`ALTER TABLE fornecedor ADD COLUMN IF NOT EXISTS portal_codigo VARCHAR(20)`);
  await query(`ALTER TABLE fornecedor ADD COLUMN IF NOT EXISTS portal_codigo_expira TIMESTAMPTZ`);
  await query(`ALTER TABLE fornecedor ADD COLUMN IF NOT EXISTS portal_ultimo_acesso TIMESTAMPTZ`);
  await query(`ALTER TABLE despesa ADD COLUMN IF NOT EXISTS pedido_compra_id UUID`);
  await query(`ALTER TABLE documento ADD COLUMN IF NOT EXISTS partilhado_fornecedor BOOLEAN DEFAULT false`);

  // Tabela fornecedor_produto para catálogo
  await query(`
    CREATE TABLE IF NOT EXISTS fornecedor_produto (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      fornecedor_id UUID NOT NULL REFERENCES fornecedor(id) ON DELETE CASCADE,
      produto_id UUID NOT NULL REFERENCES produto(id) ON DELETE CASCADE,
      preco NUMERIC(12,4) DEFAULT 0,
      disponivel BOOLEAN DEFAULT true,
      prazo_entrega INTEGER DEFAULT 0,
      criado_em TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(fornecedor_id, produto_id)
    )
  `);

  await query(`CREATE INDEX IF NOT EXISTS idx_extrato_empresa ON extrato_bancario(empresa_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_extrato_conta ON extrato_bancario(conta_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_extrato_reconciliado ON extrato_bancario(reconciliado)`);

  console.log('✅ Open Banking + Portal Fornecedor migrados!');
  process.exit(0);
}
migrate().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
