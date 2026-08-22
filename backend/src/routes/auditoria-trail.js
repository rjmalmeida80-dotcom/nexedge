'use strict';
/**
 * NexEdge — Auditoria Trail Completa
 * Registo de todas as acções: quem, o quê, quando, de onde
 * Obrigatório para certificação ISO 27001 e compliance enterprise
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { autenticar } = require('../middleware/auth');

router.use(autenticar);

// Middleware para registar acções (adicionar ao server.js)
async function registarAuditoria(req, res, next) {
  const inicio = Date.now();
  const original = res.json.bind(res);

  res.json = function(data) {
    // Registar apenas mutações (POST, PUT, DELETE, PATCH)
    if (['POST','PUT','DELETE','PATCH'].includes(req.method) && req.utilizador) {
      const entidade = req.path.split('/')[1]; // ex: 'funcionarios'
      const entidadeId = req.params?.id || data?.id || null;
      const duracao = Date.now() - inicio;

      query(`INSERT INTO auditoria_log (empresa_id, utilizador_id, accao, entidade, entidade_id, dados_antes, dados_depois, ip, user_agent, url, metodo, duracao_ms, estado_http)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          req.empresaId, req.utilizador?.id,
          req.method === 'POST' ? 'criar' : req.method === 'PUT' ? 'editar' : req.method === 'DELETE' ? 'eliminar' : 'accao',
          entidade, entidadeId,
          JSON.stringify(req.body||{}), JSON.stringify(data||{}),
          req.ip, req.headers['user-agent']?.slice(0,200),
          req.path, req.method, duracao, res.statusCode
        ]).catch(() => {}); // nunca bloquear por erro de log
    }
    return original(data);
  };

  next();
}

// ── CONSULTAR LOG ──

router.get('/', async (req, res) => {
  try {
    const { utilizador_id, entidade, accao, data_inicio, data_fim } = req.query;
    const conds = ['al.empresa_id=$1'], params = [req.empresaId];
    let n = 2;
    if (utilizador_id) { conds.push(`al.utilizador_id=$${n++}`); params.push(utilizador_id); }
    if (entidade) { conds.push(`al.entidade=$${n++}`); params.push(entidade); }
    if (accao) { conds.push(`al.accao=$${n++}`); params.push(accao); }
    if (data_inicio) { conds.push(`al.criado_em>=$${n++}`); params.push(data_inicio); }
    if (data_fim) { conds.push(`al.criado_em<=$${n++}`); params.push(data_fim); }

    const r = await query(`
      SELECT al.*, u.nome_completo as utilizador_nome, u.email as utilizador_email
      FROM auditoria_log al
      LEFT JOIN utilizador u ON u.id=al.utilizador_id
      WHERE ${conds.join(' AND ')}
      ORDER BY al.criado_em DESC LIMIT 200
    `, params).catch(()=>({rows:[]}));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Estatísticas de auditoria
router.get('/stats', async (req, res) => {
  try {
    const [porAccao, porUtilizador, porEntidade, actividadeHoraria] = await Promise.all([
      query(`SELECT accao, COUNT(*) as total FROM auditoria_log WHERE empresa_id=$1 AND criado_em > NOW()-INTERVAL '30 days' GROUP BY accao ORDER BY total DESC`, [req.empresaId]),
      query(`SELECT u.nome_completo, COUNT(*) as total FROM auditoria_log al JOIN utilizador u ON u.id=al.utilizador_id WHERE al.empresa_id=$1 AND al.criado_em > NOW()-INTERVAL '30 days' GROUP BY u.id,u.nome_completo ORDER BY total DESC LIMIT 10`, [req.empresaId]),
      query(`SELECT entidade, COUNT(*) as total FROM auditoria_log WHERE empresa_id=$1 AND criado_em > NOW()-INTERVAL '30 days' GROUP BY entidade ORDER BY total DESC LIMIT 10`, [req.empresaId]),
      query(`SELECT EXTRACT(HOUR FROM criado_em) as hora, COUNT(*) as total FROM auditoria_log WHERE empresa_id=$1 AND criado_em > NOW()-INTERVAL '7 days' GROUP BY hora ORDER BY hora`, [req.empresaId]),
    ]).catch(()=>[{rows:[]},{rows:[]},{rows:[]},{rows:[]}]);

    res.json({
      por_accao: porAccao.rows||[],
      por_utilizador: porUtilizador.rows||[],
      por_entidade: porEntidade.rows||[],
      actividade_horaria: actividadeHoraria.rows||[],
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Exportar log para CSV
router.get('/exportar', async (req, res) => {
  try {
    const r = await query(`
      SELECT al.criado_em, u.nome_completo, u.email, al.accao, al.entidade, al.entidade_id, al.ip, al.url, al.metodo, al.estado_http
      FROM auditoria_log al LEFT JOIN utilizador u ON u.id=al.utilizador_id
      WHERE al.empresa_id=$1 ORDER BY al.criado_em DESC LIMIT 10000
    `, [req.empresaId]).catch(()=>({rows:[]}));

    const csv = ['Data,Utilizador,Email,Acção,Entidade,ID,IP,URL,Método,HTTP Status',
      ...r.rows.map(r => [r.criado_em,r.nome_completo,r.email,r.accao,r.entidade,r.entidade_id,r.ip,r.url,r.metodo,r.estado_http].map(v=>`"${v||''}"`).join(','))
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=UTF-8');
    res.setHeader('Content-Disposition', `attachment; filename="auditoria_${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = { router, registarAuditoria };
