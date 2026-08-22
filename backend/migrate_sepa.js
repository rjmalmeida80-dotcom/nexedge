'use strict';
require('dotenv').config();
const { query } = require('./src/config/database');

async function migrate() {
  console.log('🔧 SEPA Pagamentos — Migração...');

  await query(`
    CREATE TABLE IF NOT EXISTS sepa_lote (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
      nome VARCHAR(200) NOT NULL,
      descricao TEXT,
      data_execucao DATE,
      conta_debito_id UUID,
      estado VARCHAR(20) DEFAULT 'rascunho' CHECK (estado IN ('rascunho','validado','gerado','submetido','processado','erro')),
      xml_gerado_em TIMESTAMPTZ,
      criado_em TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS sepa_pagamento (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      lote_id UUID NOT NULL REFERENCES sepa_lote(id) ON DELETE CASCADE,
      empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
      fornecedor_id UUID,
      despesa_id UUID,
      nome_beneficiario VARCHAR(200) NOT NULL,
      iban_beneficiario VARCHAR(34) NOT NULL,
      bic_beneficiario VARCHAR(11),
      valor NUMERIC(12,2) NOT NULL,
      moeda VARCHAR(3) DEFAULT 'EUR',
      referencia VARCHAR(140),
      descricao TEXT,
      estado VARCHAR(20) DEFAULT 'pendente',
      criado_em TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Adicionar IBAN/BIC ao fornecedor
  await query(`ALTER TABLE fornecedor ADD COLUMN IF NOT EXISTS iban VARCHAR(34)`);
  await query(`ALTER TABLE fornecedor ADD COLUMN IF NOT EXISTS bic VARCHAR(11)`);
  await query(`ALTER TABLE fornecedor ADD COLUMN IF NOT EXISTS numero_fatura VARCHAR(100)`);

  console.log('✅ SEPA Pagamentos migrado!');
  process.exit(0);
}
migrate().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
