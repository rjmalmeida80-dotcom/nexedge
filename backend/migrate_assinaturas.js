'use strict';
require('dotenv').config();
const { query } = require('./src/config/database');

async function migrate() {
  console.log('🔧 Assinaturas + AT — Migração...');
  
  await query(`
    CREATE TABLE IF NOT EXISTS assinatura_pedido (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
      titulo VARCHAR(300) NOT NULL,
      documento_id UUID,
      tipo VARCHAR(50) DEFAULT 'contrato',
      mensagem TEXT,
      signatarios JSONB DEFAULT '[]',
      estado VARCHAR(20) DEFAULT 'pendente' CHECK (estado IN ('pendente','parcial','concluido','cancelado','expirado')),
      token_acesso VARCHAR(100) NOT NULL,
      expira_em TIMESTAMPTZ,
      concluido_em TIMESTAMPTZ,
      criado_por UUID REFERENCES utilizador(id),
      criado_em TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  
  await query(`CREATE INDEX IF NOT EXISTS idx_assin_empresa ON assinatura_pedido(empresa_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_assin_token ON assinatura_pedido(token_acesso)`);
  
  // Colunas AT nas faturas
  await query(`ALTER TABLE fatura ADD COLUMN IF NOT EXISTS comunicada_at BOOLEAN DEFAULT false`);
  await query(`ALTER TABLE fatura ADD COLUMN IF NOT EXISTS data_comunicacao_at TIMESTAMPTZ`);
  
  // Coluna empresa mae para multi-empresa
  await query(`ALTER TABLE empresa ADD COLUMN IF NOT EXISTS empresa_mae_id UUID REFERENCES empresa(id)`);
  await query(`ALTER TABLE empresa ADD COLUMN IF NOT EXISTS mrr_valor NUMERIC(10,2) DEFAULT 0`);
  await query(`ALTER TABLE empresa ADD COLUMN IF NOT EXISTS plano VARCHAR(50) DEFAULT 'Pro'`);
  
  console.log('✅ Migração completa!');
  process.exit(0);
}
migrate().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
