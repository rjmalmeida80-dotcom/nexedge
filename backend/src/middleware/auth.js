'use strict';

const jwt = require('jsonwebtoken');
const { query } = require('../config/database');

/**
 * Verifica o token JWT e adiciona req.utilizador
 */
async function autenticar(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Token de autenticação em falta.' });
    }

    const token = authHeader.split(' ')[1];
    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Sessão expirada. Faça login novamente.', codigo: 'TOKEN_EXPIRADO' });
      }
      return res.status(401).json({ error: 'Token inválido.' });
    }

    const { rows } = await query(
      `SELECT u.id, u.empresa_id, u.email, u.perfil, u.nome_completo, u.ativo,
              f.id AS funcionario_id
       FROM utilizador u
       LEFT JOIN funcionario f ON f.utilizador_id = u.id
       WHERE u.id = $1`,
      [payload.sub]
    );

    if (!rows.length || !rows[0].ativo) {
      return res.status(401).json({ error: 'Utilizador não encontrado ou inativo.' });
    }

    req.utilizador = rows[0];
    req.empresaId  = rows[0].empresa_id;

    // Se é sessão de impersonation, usar a empresa_id do token
    if (payload.impersonated_by && payload.empresa_id) {
      req.empresaId = payload.empresa_id;
      req.utilizador = {
        ...rows[0],
        empresa_id: payload.empresa_id,
        perfil: 'admin_empresa',
        impersonated_by: payload.impersonated_by,
      };
    }

    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Verifica se o utilizador tem um dos perfis permitidos
 */
function autorizar(...perfisPermitidos) {
  return (req, res, next) => {
    if (!req.utilizador) {
      return res.status(401).json({ error: 'Não autenticado.' });
    }
    if (!perfisPermitidos.includes(req.utilizador.perfil)) {
      return res.status(403).json({
        error: 'Sem permissão para aceder a este recurso.',
        perfil_necessario: perfisPermitidos,
        perfil_atual: req.utilizador.perfil
      });
    }
    next();
  };
}

/**
 * Verifica se o utilizador pertence à mesma empresa
 */
function mesmEmpresa(req, res, next) {
  const empresaHeader = req.headers['x-empresa-id'];
  if (empresaHeader && empresaHeader !== req.empresaId) {
    return res.status(403).json({ error: 'Acesso negado a recursos de outra empresa.' });
  }
  next();
}

module.exports = { autenticar, autorizar, mesmEmpresa };
