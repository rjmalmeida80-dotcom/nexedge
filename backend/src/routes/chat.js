'use strict';
const router = require('express').Router();
const { autenticar } = require('../middleware/auth');
const { query } = require('../config/database');

// ── Listar conversas do utilizador ────────────────────────────────────────────
router.get('/conversas', autenticar, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT c.id, c.tipo, c.nome, c.criado_em,
        (SELECT COUNT(*) FROM chat_mensagem m WHERE m.conversa_id=c.id) AS total_mensagens,
        (SELECT COUNT(*) FROM chat_mensagem m WHERE m.conversa_id=c.id
          AND m.criado_em > COALESCE(cp.ultimo_lido, '2000-01-01')) AS nao_lidas,
        (SELECT m.mensagem FROM chat_mensagem m WHERE m.conversa_id=c.id ORDER BY m.criado_em DESC LIMIT 1) AS ultima_mensagem,
        (SELECT m.criado_em FROM chat_mensagem m WHERE m.conversa_id=c.id ORDER BY m.criado_em DESC LIMIT 1) AS ultima_mensagem_em,
        ARRAY_AGG(DISTINCT u.nome_completo) FILTER(WHERE u.id != $1) AS participantes
      FROM chat_conversa c
      JOIN chat_participante cp ON cp.conversa_id=c.id AND cp.utilizador_id=$1
      JOIN chat_participante cp2 ON cp2.conversa_id=c.id
      JOIN utilizador u ON u.id=cp2.utilizador_id
      WHERE cp.utilizador_id=$1
      GROUP BY c.id, cp.ultimo_lido
      ORDER BY ultima_mensagem_em DESC NULLS LAST
    `, [req.utilizador.id]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Criar conversa ────────────────────────────────────────────────────────────
router.post('/conversas', autenticar, async (req, res) => {
  try {
    const { tipo = 'direto', nome, participantes = [] } = req.body;
    if (!participantes.length) return res.status(400).json({ error: 'Participantes obrigatórios' });

    const { rows:[c] } = await query(`
      INSERT INTO chat_conversa (empresa_id, tipo, nome, criado_por)
      VALUES ($1,$2,$3,$4) RETURNING *
    `, [req.empresaId, tipo, nome||null, req.utilizador.id]);

    // Adicionar criador + participantes
    const todos = [...new Set([req.utilizador.id, ...participantes])];
    for (const uid of todos) {
      await query(`INSERT INTO chat_participante (conversa_id, utilizador_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [c.id, uid]);
    }

    res.status(201).json(c);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Mensagens de uma conversa ─────────────────────────────────────────────────
router.get('/conversas/:id/mensagens', autenticar, async (req, res) => {
  try {
    // Verificar acesso
    const { rows:[acesso] } = await query(
      'SELECT 1 FROM chat_participante WHERE conversa_id=$1 AND utilizador_id=$2',
      [req.params.id, req.utilizador.id]
    );
    if (!acesso) return res.status(403).json({ error: 'Sem acesso' });

    const { rows } = await query(`
      SELECT m.*, u.nome_completo AS autor_nome, u.avatar_url AS autor_avatar
      FROM chat_mensagem m
      JOIN utilizador u ON u.id=m.utilizador_id
      WHERE m.conversa_id=$1
      ORDER BY m.criado_em ASC
      LIMIT 100
    `, [req.params.id]);

    // Marcar como lido
    await query(`UPDATE chat_participante SET ultimo_lido=NOW() WHERE conversa_id=$1 AND utilizador_id=$2`,
      [req.params.id, req.utilizador.id]);

    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Enviar mensagem ───────────────────────────────────────────────────────────
router.post('/conversas/:id/mensagens', autenticar, async (req, res) => {
  try {
    const { mensagem } = req.body;
    if (!mensagem?.trim()) return res.status(400).json({ error: 'Mensagem obrigatória' });

    const { rows:[acesso] } = await query(
      'SELECT 1 FROM chat_participante WHERE conversa_id=$1 AND utilizador_id=$2',
      [req.params.id, req.utilizador.id]
    );
    if (!acesso) return res.status(403).json({ error: 'Sem acesso' });

    const { rows:[m] } = await query(`
      INSERT INTO chat_mensagem (conversa_id, utilizador_id, mensagem)
      VALUES ($1,$2,$3) RETURNING *
    `, [req.params.id, req.utilizador.id, mensagem.trim()]);

    // Notificar outros participantes
    const { rows: outros } = await query(`
      SELECT cp.utilizador_id, u.empresa_id
      FROM chat_participante cp
      JOIN utilizador u ON u.id = cp.utilizador_id
      WHERE cp.conversa_id=$1 AND cp.utilizador_id != $2
    `, [req.params.id, req.utilizador.id]);

    for (const p of outros) {
      await query(`INSERT INTO notificacao (utilizador_id, titulo, mensagem, tipo, url_accao)
        VALUES ($1,$2,$3,'info','/chat')`,
        [p.utilizador_id,
         'Nova mensagem de ' + req.utilizador.nome_completo,
         mensagem.trim().substring(0,80)]
      ).catch(()=>{});
    }

    res.status(201).json({ ...m, autor_nome: req.utilizador.nome_completo });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Listar utilizadores para conversa ─────────────────────────────────────────
router.get('/utilizadores', autenticar, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT id, nome_completo, email, avatar_url, perfil,
        CASE WHEN empresa_id=$1 THEN 'mesma_empresa' ELSE 'nexedge' END AS origem
      FROM utilizador
      WHERE id != $2
        AND (empresa_id=$1 OR perfil='super_admin')
      ORDER BY origem ASC, nome_completo ASC
    `, [req.empresaId, req.utilizador.id]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Total não lidas ───────────────────────────────────────────────────────────
router.get('/nao-lidas', autenticar, async (req, res) => {
  try {
    const { rows:[r] } = await query(`
      SELECT COUNT(*) AS total FROM chat_mensagem m
      JOIN chat_participante cp ON cp.conversa_id=m.conversa_id AND cp.utilizador_id=$1
      WHERE m.utilizador_id != $1 AND m.criado_em > COALESCE(cp.ultimo_lido,'2000-01-01')
    `, [req.utilizador.id]);
    res.json({ total: parseInt(r.total||0) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
