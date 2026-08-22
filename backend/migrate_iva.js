'use strict';
require('dotenv').config();
const { query } = require('./src/config/database');

async function migrate() {
  console.log('🔧 IVA Automático — Migração...');
  await query(`
    CREATE TABLE IF NOT EXISTS declaracao_iva (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
      ano INTEGER NOT NULL,
      periodo VARCHAR(10) NOT NULL,
      tipo_periodo VARCHAR(20) DEFAULT 'mensal' CHECK (tipo_periodo IN ('mensal','trimestral')),
      dados JSONB DEFAULT '{}',
      estado VARCHAR(20) DEFAULT 'rascunho' CHECK (estado IN ('rascunho','validada','submetida','aceite','rejeitada')),
      referencia_at VARCHAR(100),
      criado_em TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(empresa_id, ano, periodo)
    )
  `);
  await query(`ALTER TABLE fatura ADD COLUMN IF NOT EXISTS taxa_iva NUMERIC(5,2) DEFAULT 23`);
  await query(`ALTER TABLE fatura ADD COLUMN IF NOT EXISTS base_tributavel NUMERIC(12,2)`);
  await query(`ALTER TABLE fatura ADD COLUMN IF NOT EXISTS valor_iva NUMERIC(12,2)`);
  await query(`ALTER TABLE despesa ADD COLUMN IF NOT EXISTS taxa_iva NUMERIC(5,2) DEFAULT 23`);
  await query(`ALTER TABLE despesa ADD COLUMN IF NOT EXISTS valor_sem_iva NUMERIC(12,2)`);
  await query(`ALTER TABLE despesa ADD COLUMN IF NOT EXISTS valor_iva NUMERIC(12,2)`);
  console.log('✅ IVA migrado!');
  process.exit(0);
}
migrate().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
