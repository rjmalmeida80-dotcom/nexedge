'use strict';
const router = require('express').Router();
const { autenticar, autorizar } = require('../middleware/auth');
const { query } = require('../config/database');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const BACKUP_DIR = process.env.BACKUP_DIR || '/app/backups';

// Listar backups disponíveis
router.get('/', autenticar, autorizar('admin_empresa','super_admin'), async (req, res) => {
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.endsWith('.sql') || f.endsWith('.sql.gz') || f.endsWith('.json'))
      .map(f => {
        const stat = fs.statSync(path.join(BACKUP_DIR, f));
        return {
          nome: f,
          tamanho: stat.size,
          data: stat.mtime,
          tamanho_fmt: stat.size > 1024*1024 ? `${(stat.size/1024/1024).toFixed(1)} MB` : `${(stat.size/1024).toFixed(0)} KB`,
        };
      })
      .sort((a,b) => new Date(b.data) - new Date(a.data));
    res.json(files);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Criar backup manual (via queries SQL — não depende de pg_dump)
router.post('/criar', autenticar, autorizar('admin_empresa','super_admin'), async (req, res) => {
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const { query: dbQuery } = require('../config/database');
    const nome = `nexedge_backup_${new Date().toISOString().replace(/[:.]/g,'-').slice(0,19)}.json`;
    const ficheiro = path.join(BACKUP_DIR, nome);

    // Backup das tabelas principais da empresa
    const tabelas = ['funcionario','fatura','fatura_linha','pedido_ferias','recibo_vencimento','despesa','cliente','contrato_trabalho'];
    const dados = {};
    for (const t of tabelas) {
      try {
        const { rows } = await dbQuery(`SELECT * FROM ${t} WHERE empresa_id=$1`, [req.empresaId]).catch(()=>({rows:[]}));
        dados[t] = rows;
      } catch(e) { dados[t] = []; }
    }
    dados._meta = { empresa_id: req.empresaId, criado_em: new Date().toISOString(), versao: 'v9' };

    fs.writeFileSync(ficheiro, JSON.stringify(dados, null, 2));
    const tamanho = fs.statSync(ficheiro).size;
    res.json({ nome, tamanho, criado_em: new Date().toISOString(), mensagem: 'Backup criado com sucesso' });
  } catch(e) { res.status(500).json({ error: 'Erro ao criar backup: ' + e.message }); }
});

// Estatísticas da BD
router.get('/stats', autenticar, autorizar('admin_empresa','super_admin'), async (req, res) => {
  try {
    const { rows: tabelas } = await query(`
      SELECT schemaname, tablename,
        pg_size_pretty(pg_total_relation_size(quote_ident(schemaname)||'.'||quote_ident(tablename))) AS tamanho,
        (SELECT COUNT(*) FROM information_schema.columns WHERE table_name=tablename AND table_schema=schemaname) AS colunas
      FROM pg_tables WHERE schemaname='public'
      ORDER BY pg_total_relation_size(quote_ident(schemaname)||'.'||quote_ident(tablename)) DESC
      LIMIT 10
    `);
    const { rows:[dbSize] } = await query(`SELECT pg_size_pretty(pg_database_size(current_database())) AS tamanho`);
    res.json({ tabelas, tamanho_total: dbSize.tamanho });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
