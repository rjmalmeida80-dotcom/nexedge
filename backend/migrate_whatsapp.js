'use strict';
require('dotenv').config();
const { query } = require('./src/config/database');

async function migrate() {
  console.log('🔧 WhatsApp — Migração...');
  await query(`
    CREATE TABLE IF NOT EXISTS whatsapp_config (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
      provider VARCHAR(20) DEFAULT 'twilio',
      config JSONB DEFAULT '{}',
      ativo BOOLEAN DEFAULT false,
      criado_em TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(empresa_id)
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS whatsapp_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
      telefone VARCHAR(50),
      mensagem TEXT,
      estado VARCHAR(20) DEFAULT 'enviado',
      criado_em TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await query(`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS telemovel VARCHAR(30)`);
  console.log('✅ WhatsApp migrado!');
  process.exit(0);
}
migrate().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
