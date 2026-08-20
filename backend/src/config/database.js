'use strict';
const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST || 'postgres',
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'plataforma_rh',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  ssl: false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});
pool.on('error', (err) => { console.error('Erro no pool:', err); });
async function connectDB() {
  const client = await pool.connect();
  try { await client.query('SELECT NOW()'); console.log('PostgreSQL conectado'); }
  finally { client.release(); }
}
async function query(text, params) {
  try { return await pool.query(text, params); }
  catch (err) { console.error('Erro na query:', err.message); throw err; }
}
async function transaction(fn) {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const r = await fn(client); await client.query('COMMIT'); return r; }
  catch (err) { await client.query('ROLLBACK'); throw err; }
  finally { client.release(); }
}
module.exports = { pool, query, transaction, connectDB };
