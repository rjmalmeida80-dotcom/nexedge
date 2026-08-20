'use strict';

const { query } = require('../config/database');

/**
 * Regista uma ação no log de auditoria
 */
async function registarAuditoria({ empresaId, utilizadorId, acao, tabela, registoId, dadosAntes, dadosDepois, ip, userAgent }) {
  try {
    await query(`
      INSERT INTO log_auditoria
        (empresa_id, utilizador_id, acao, tabela, registo_id, dados_antes, dados_depois, ip, user_agent)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `, [
      empresaId || null,
      utilizadorId || null,
      acao,
      tabela || null,
      registoId ? String(registoId) : null,
      dadosAntes ? JSON.stringify(dadosAntes) : null,
      dadosDepois ? JSON.stringify(dadosDepois) : null,
      ip || null,
      userAgent || null,
    ]);
  } catch (err) {
    // Nunca falhar por causa de auditoria
    console.error('⚠️  Erro ao registar auditoria:', err.message);
  }
}

/**
 * Middleware que injeta função de auditoria no req
 */
function middlewareAuditoria(req, res, next) {
  req.auditar = ({ acao, tabela, registoId, dadosAntes, dadosDepois }) => {
    return registarAuditoria({
      empresaId:    req.empresaId,
      utilizadorId: req.utilizador?.id,
      acao,
      tabela,
      registoId,
      dadosAntes,
      dadosDepois,
      ip:           req.ip,
      userAgent:    req.headers['user-agent'],
    });
  };
  next();
}

module.exports = { registarAuditoria, middlewareAuditoria };
