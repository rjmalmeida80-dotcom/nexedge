'use strict';

function errorHandler(err, req, res, next) {
  // Log interno
  console.error('❌ Erro:', {
    message: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    url: req.originalUrl,
    method: req.method,
  });

  // Erros de validação (Joi / express-validator)
  if (err.name === 'ValidationError' || err.isJoi) {
    return res.status(400).json({
      error: 'Dados inválidos.',
      detalhes: err.details?.map(d => d.message) || [err.message]
    });
  }

  // Erros do PostgreSQL
  if (err.code) {
    switch (err.code) {
      case '23505': // unique violation
        return res.status(409).json({ error: 'Registo duplicado. Verifique os dados introduzidos.' });
      case '23503': // foreign key violation
        return res.status(409).json({ error: 'Referência inválida. O registo relacionado não existe.' });
      case '23502': // not null violation
        return res.status(400).json({ error: `Campo obrigatório em falta: ${err.column}` });
      case '22001': // string too long
        return res.status(400).json({ error: 'Valor demasiado longo para o campo indicado.' });
    }
  }

  // Erro personalizado com status
  if (err.statusCode) {
    return res.status(err.statusCode).json({ error: err.message });
  }

  // Erro genérico
  const status = err.status || 500;
  res.status(status).json({
    error: process.env.NODE_ENV === 'production'
      ? 'Erro interno do servidor.'
      : err.message,
  });
}

function notFound(req, res) {
  res.status(404).json({ error: `Rota não encontrada: ${req.method} ${req.originalUrl}` });
}

// Cria um erro com status HTTP
function criarErro(mensagem, status = 400) {
  const err = new Error(mensagem);
  err.statusCode = status;
  return err;
}

module.exports = { errorHandler, notFound, criarErro };
