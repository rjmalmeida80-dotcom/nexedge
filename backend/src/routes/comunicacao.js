'use strict';

const router  = require('express').Router();
const { autenticar, autorizar } = require('../middleware/auth');
const { middlewareAuditoria }   = require('../middleware/auditoria');
const { query }   = require('../config/database');
const { criarErro } = require('../middleware/errorHandler');

router.use(autenticar, middlewareAuditoria);

const RH = ['admin_empresa','rh','diretor'];

// ── AVISOS ────────────────────────────────────────────────────────────────────

router.get('/avisos', async (req, res) => {
  const { categoria, busca } = req.query;
  const params = [req.empresaId];
  const conds  = ['a.empresa_id=$1','a.ativo=true'];
  let p = 2;
  if (categoria) { conds.push(`a.categoria=$${p}`); params.push(categoria); p++; }
  if (busca)     { conds.push(`a.titulo ILIKE $${p}`); params.push(`%${busca}%`); p++; }

  const { rows } = await query(`
    SELECT a.*, u.nome_completo AS autor_nome,
      (SELECT COUNT(*) FROM avisos_leituras l WHERE l.aviso_id=a.id) AS total_leituras,
      EXISTS(SELECT 1 FROM avisos_leituras l WHERE l.aviso_id=a.id AND l.utilizador_id=$${p}) AS lido
    FROM comunicacao_avisos a
    LEFT JOIN utilizador u ON u.id=a.criado_por
    WHERE ${conds.join(' AND ')}
    ORDER BY a.fixado DESC, a.criado_em DESC
  `, [...params, req.utilizador.id]);
  res.json(rows);
});

router.post('/avisos', autorizar(...RH), async (req, res) => {
  const { titulo, conteudo, categoria, prioridade, fixado, destinatarios } = req.body;
  if (!titulo || !conteudo) throw criarErro('Título e conteúdo são obrigatórios.', 400);

  const { rows } = await query(`
    INSERT INTO comunicacao_avisos
      (empresa_id, titulo, conteudo, categoria, prioridade, fixado, destinatarios, criado_por, ativo)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)
    RETURNING *
  `, [req.empresaId, titulo, conteudo, categoria||'geral',
      prioridade||'normal', fixado||false,
      destinatarios||'todos', req.utilizador.id]);

  // Criar notificações para todos os utilizadores
  const { rows: utis } = await query(
    'SELECT id FROM utilizador WHERE empresa_id=$1 AND ativo=true AND id!=$2',
    [req.empresaId, req.utilizador.id]
  );
  for (const u of utis) {
    await query(`INSERT INTO notificacao (utilizador_id, titulo, mensagem, tipo, link)
      VALUES ($1,$2,$3,'info','/comunicacao')`,
      [u.id, `📢 ${titulo}`, conteudo.substring(0, 100)]);
  }

  await req.auditar({ acao: 'AVISO_PUBLICADO', registoId: rows[0].id });
  res.status(201).json(rows[0]);
});

// Marcar aviso como lido
router.post('/avisos/:id/ler', async (req, res) => {
  await query(`
    INSERT INTO avisos_leituras (aviso_id, utilizador_id)
    VALUES ($1,$2) ON CONFLICT DO NOTHING
  `, [req.params.id, req.utilizador.id]);
  res.json({ ok: true });
});

router.delete('/avisos/:id', autorizar(...RH), async (req, res) => {
  await query('UPDATE comunicacao_avisos SET ativo=false WHERE id=$1 AND empresa_id=$2',
    [req.params.id, req.empresaId]);
  res.json({ mensagem: 'Aviso removido.' });
});

// ── MENSAGENS (chat com RH) ───────────────────────────────────────────────────

router.get('/mensagens', async (req, res) => {
  const { rows } = await query(`
    SELECT m.*, u.nome_completo AS remetente_nome, u.avatar_url
    FROM comunicacao_mensagens m
    JOIN utilizador u ON u.id=m.remetente_id
    WHERE m.empresa_id=$1
      AND (m.remetente_id=$2 OR m.destinatario_id=$2)
    ORDER BY m.criado_em ASC
    LIMIT 100
  `, [req.empresaId, req.utilizador.id]);
  res.json(rows);
});

router.post('/mensagens', async (req, res) => {
  const { mensagem, destinatario_id } = req.body;
  if (!mensagem?.trim()) throw criarErro('Mensagem não pode estar vazia.', 400);

  // Se não especificar destinatário, envia para o RH
  let destId = destinatario_id;
  if (!destId) {
    const { rows: rhs } = await query(
      `SELECT id FROM utilizador WHERE empresa_id=$1 AND perfil='rh' AND ativo=true LIMIT 1`,
      [req.empresaId]
    );
    destId = rhs[0]?.id;
  }

  const { rows } = await query(`
    INSERT INTO comunicacao_mensagens (empresa_id, remetente_id, destinatario_id, mensagem)
    VALUES ($1,$2,$3,$4) RETURNING *
  `, [req.empresaId, req.utilizador.id, destId||null, mensagem.trim()]);

  // Notificar destinatário
  if (destId) {
    await query(`INSERT INTO notificacao (utilizador_id, titulo, mensagem, tipo)
      VALUES ($1,'Nova mensagem',$2,'info')`,
      [destId, mensagem.substring(0, 80)]);
  }

  res.status(201).json(rows[0]);
});

module.exports = router;
