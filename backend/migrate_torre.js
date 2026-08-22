'use strict';
require('dotenv').config();
const { query } = require('./src/config/database');

async function migrate() {
  console.log('🔧 Torre de Controlo — Migração...');

  await query(`CREATE TABLE IF NOT EXISTS torre_agente_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
    agente VARCHAR(50) NOT NULL,
    input_resumo TEXT,
    output_resumo TEXT,
    tokens_usados INTEGER DEFAULT 0,
    duracao_ms INTEGER,
    estado VARCHAR(20) DEFAULT 'sucesso',
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  await query(`CREATE INDEX IF NOT EXISTS idx_torre_log_empresa ON torre_agente_log(empresa_id)`);

  console.log('✅ Torre de Controlo migrada!');
  process.exit(0);
}
migrate().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
