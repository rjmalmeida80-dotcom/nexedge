'use strict';
const { pool } = require('../config/database');
async function main() {
  console.log('Migracao: token_activacao...');
  await pool.query(`
    ALTER TABLE utilizador 
    ADD COLUMN IF NOT EXISTS token_activacao VARCHAR(100),
    ADD COLUMN IF NOT EXISTS token_activacao_expira TIMESTAMP
  `);
  console.log('OK colunas token_activacao adicionadas');
  await pool.end();
}
main().catch(e => { console.error('ERRO:', e.message); pool.end(); });
