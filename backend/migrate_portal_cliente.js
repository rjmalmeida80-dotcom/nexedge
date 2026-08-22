'use strict';
require('dotenv').config();
const { query } = require('./src/config/database');

async function migrate() {
  console.log('🔧 Portal Cliente — Migração...');
  await query(`ALTER TABLE cliente ADD COLUMN IF NOT EXISTS portal_codigo VARCHAR(20)`);
  await query(`ALTER TABLE cliente ADD COLUMN IF NOT EXISTS portal_codigo_expira TIMESTAMPTZ`);
  await query(`ALTER TABLE cliente ADD COLUMN IF NOT EXISTS portal_ultimo_acesso TIMESTAMPTZ`);
  await query(`ALTER TABLE documento ADD COLUMN IF NOT EXISTS partilhado_cliente BOOLEAN DEFAULT false`).catch(()=>{});
  console.log('✅ Portal Cliente migrado!');
  process.exit(0);
}
migrate().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
