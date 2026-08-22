'use strict';
require('dotenv').config();
const { query } = require('./src/config/database');

async function migrate() {
  console.log('🔧 Premium 6: Copilot + Portal Motorista + Automações...');

  // PIN acesso motorista
  await query(`ALTER TABLE logistica_motorista ADD COLUMN IF NOT EXISTS pin_acesso VARCHAR(10)`);
  await query(`ALTER TABLE logistica_motorista ADD COLUMN IF NOT EXISTS ultimo_login TIMESTAMPTZ`);

  // Tabelas pedido de compra (se não existir)
  await query(`CREATE TABLE IF NOT EXISTS pedido_compra (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
    numero VARCHAR(30) NOT NULL UNIQUE,
    fornecedor_id UUID,
    descricao TEXT,
    estado VARCHAR(20) DEFAULT 'rascunho',
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS pedido_compra_linha (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pedido_id UUID NOT NULL REFERENCES pedido_compra(id) ON DELETE CASCADE,
    produto_id UUID NOT NULL REFERENCES produto(id),
    quantidade NUMERIC(14,3) NOT NULL DEFAULT 1,
    unidade VARCHAR(10) DEFAULT 'UN',
    preco_unitario NUMERIC(12,4) DEFAULT 0,
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  // Histórico copilot
  await query(`CREATE TABLE IF NOT EXISTS copilot_historico (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL,
    utilizador_id UUID,
    mensagem TEXT,
    resposta TEXT,
    modulo VARCHAR(50),
    tokens INTEGER DEFAULT 0,
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  await query(`CREATE INDEX IF NOT EXISTS idx_pc_empresa ON pedido_compra(empresa_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_copilot_empresa ON copilot_historico(empresa_id)`);

  console.log('✅ Premium 6 migrado!');
  process.exit(0);
}
migrate().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
