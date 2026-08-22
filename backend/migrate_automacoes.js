'use strict';
require('dotenv').config();
const { query } = require('./src/config/database');

async function migrate() {
  console.log('🔧 Migração automações...');

  // ITSM — colunas novas
  await query(`ALTER TABLE itsm_ticket ADD COLUMN IF NOT EXISTS ultimo_escalamento TIMESTAMPTZ`);
  await query(`ALTER TABLE itsm_ticket ADD COLUMN IF NOT EXISTS notificado_resolucao TIMESTAMPTZ`);

  // Funcionário — colunas onboarding/offboarding
  await query(`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS onboarding_iniciado TIMESTAMPTZ`);
  await query(`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS offboarding_iniciado TIMESTAMPTZ`);
  await query(`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS data_saida DATE`);

  // Empresa — alertas de tesouraria
  await query(`ALTER TABLE empresa ADD COLUMN IF NOT EXISTS alerta_tesouraria_valor NUMERIC(15,2)`);

  // Fatura — lembretes enviados
  await query(`ALTER TABLE fatura ADD COLUMN IF NOT EXISTS lembrete_15d_enviado TIMESTAMPTZ`);
  await query(`ALTER TABLE fatura ADD COLUMN IF NOT EXISTS lembrete_7d_enviado TIMESTAMPTZ`);
  await query(`ALTER TABLE fatura ADD COLUMN IF NOT EXISTS lembrete_3d_enviado TIMESTAMPTZ`);
  await query(`ALTER TABLE fatura ADD COLUMN IF NOT EXISTS vencida TIMESTAMPTZ`);

  console.log('✅ Migração automações completa!');
  process.exit(0);
}

migrate().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
