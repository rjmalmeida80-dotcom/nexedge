'use strict';
const router = require('express').Router();
const { autenticar, autorizar } = require('../middleware/auth');
const { query } = require('../config/database');
const email = require('../services/emailService');

function gerarNumero() {
  return `TK-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}`;
}

// ── CLIENTE — Listar tickets ──────────────────────────────────────────────────
router.get('/', autenticar, async (req, res) => {
  try {
    const { estado } = req.query;
    const where = estado ? `AND t.estado=$2` : '';
    const params = estado ? [req.empresaId, estado] : [req.empresaId];
    const { rows } = await query(`
      SELECT t.*,
        u.nome_completo AS criado_por_nome,
        a.nome_completo AS atribuido_nome,
        COUNT(tm.id) AS total_mensagens,
        MAX(tm.criado_em) AS ultima_mensagem
      FROM ticket t
      LEFT JOIN utilizador u ON u.id = t.criado_por
      LEFT JOIN utilizador a ON a.id = t.atribuido_a
      LEFT JOIN ticket_mensagem tm ON tm.ticket_id = t.id
      WHERE t.empresa_id=$1 ${where}
      GROUP BY t.id, u.nome_completo, a.nome_completo
      ORDER BY t.actualizado_em DESC
    `, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CLIENTE — Criar ticket ────────────────────────────────────────────────────
router.post('/', autenticar, async (req, res) => {
  try {
    const { titulo, descricao, categoria, prioridade } = req.body;
    if (!titulo || !descricao) return res.status(400).json({ error: 'Título e descrição obrigatórios' });

    const numero = gerarNumero();
    const { rows:[ticket] } = await query(`
      INSERT INTO ticket (numero, empresa_id, criado_por, titulo, descricao, categoria, prioridade)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
    `, [numero, req.empresaId, req.utilizador.id, titulo, descricao, categoria||'geral', prioridade||'normal']);

    // Mensagem inicial automática
    await query(`
      INSERT INTO ticket_mensagem (ticket_id, autor_id, autor_nome, autor_tipo, mensagem)
      VALUES ($1,$2,$3,'cliente',$4)
    `, [ticket.id, req.utilizador.id, req.utilizador.nome_completo, descricao]);

    // Notificação interna para suporte NexEdge
    await query(`
      INSERT INTO notificacao_cliente (empresa_id, tipo, titulo, mensagem)
      VALUES ($1,'ticket_novo',$2,$3)
    `, [req.empresaId, `Novo ticket: ${titulo}`, `Ticket ${numero} criado`]).catch(()=>{});

    // Email para suporte
    try {
      const { rows:[emp] } = await query('SELECT nome FROM empresa WHERE id=$1', [req.empresaId]);
      await email.enviar({
        remetente: 'suporte',
        para: 'suporte@nexedge.pt',
        assunto: `🎫 Novo ticket ${numero} — ${emp?.nome}`,
        html: `<p>Novo ticket de suporte:<br><b>${titulo}</b><br>${descricao}</p><p>Empresa: ${emp?.nome}<br>Prioridade: ${prioridade||'normal'}</p>`,
      });
    } catch(_) {}

    res.status(201).json(ticket);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CLIENTE — Detalhe ticket + mensagens ──────────────────────────────────────
router.get('/:id', autenticar, async (req, res) => {
  try {
    const { rows:[ticket] } = await query(
      'SELECT * FROM ticket WHERE id=$1 AND empresa_id=$2',
      [req.params.id, req.empresaId]
    );
    if (!ticket) return res.status(404).json({ error: 'Ticket não encontrado' });

    const { rows: mensagens } = await query(
      'SELECT * FROM ticket_mensagem WHERE ticket_id=$1 ORDER BY criado_em',
      [req.params.id]
    );

    res.json({ ...ticket, mensagens });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CLIENTE — Responder ao ticket ─────────────────────────────────────────────
router.post('/:id/mensagem', autenticar, async (req, res) => {
  try {
    const { mensagem } = req.body;
    if (!mensagem) return res.status(400).json({ error: 'Mensagem obrigatória' });

    const { rows:[ticket] } = await query(
      'SELECT * FROM ticket WHERE id=$1 AND empresa_id=$2',
      [req.params.id, req.empresaId]
    );
    if (!ticket) return res.status(404).json({ error: 'Ticket não encontrado' });

    const { rows:[msg] } = await query(`
      INSERT INTO ticket_mensagem (ticket_id, autor_id, autor_nome, autor_tipo, mensagem)
      VALUES ($1,$2,$3,'cliente',$4) RETURNING *
    `, [ticket.id, req.utilizador.id, req.utilizador.nome_completo, mensagem]);

    // Actualizar data do ticket
    await query(
      "UPDATE ticket SET actualizado_em=NOW(), estado=CASE WHEN estado='aguarda_cliente' THEN 'em_progresso' ELSE estado END WHERE id=$1",
      [ticket.id]
    );

    res.status(201).json(msg);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CLIENTE — Fechar ticket ───────────────────────────────────────────────────
router.patch('/:id/fechar', autenticar, async (req, res) => {
  try {
    await query(
      "UPDATE ticket SET estado='fechado', fechado_em=NOW(), actualizado_em=NOW() WHERE id=$1 AND empresa_id=$2",
      [req.params.id, req.empresaId]
    );
    res.json({ message: 'Ticket fechado' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SUPORTE NEXEDGE — Ver todos os tickets ────────────────────────────────────
router.get('/admin/todos', autenticar, autorizar('super_admin'), async (req, res) => {
  try {
    const { estado, prioridade } = req.query;
    const conditions = ['1=1'];
    const params = [];
    if (estado) { params.push(estado); conditions.push(`t.estado=$${params.length}`); }
    if (prioridade) { params.push(prioridade); conditions.push(`t.prioridade=$${params.length}`); }

    const { rows } = await query(`
      SELECT t.*, e.nome AS empresa_nome, e.email AS empresa_email,
        u.nome_completo AS criado_por_nome,
        COUNT(tm.id) AS total_mensagens,
        MAX(tm.criado_em) AS ultima_mensagem
      FROM ticket t
      JOIN empresa e ON e.id = t.empresa_id
      LEFT JOIN utilizador u ON u.id = t.criado_por
      LEFT JOIN ticket_mensagem tm ON tm.ticket_id = t.id
      WHERE ${conditions.join(' AND ')}
      GROUP BY t.id, e.nome, e.email, u.nome_completo
      ORDER BY
        CASE t.prioridade WHEN 'urgente' THEN 1 WHEN 'alta' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
        t.actualizado_em DESC
    `, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SUPORTE NEXEDGE — Responder ticket ───────────────────────────────────────
router.post('/admin/:id/responder', autenticar, autorizar('super_admin'), async (req, res) => {
  try {
    const { mensagem, estado } = req.body;
    if (!mensagem) return res.status(400).json({ error: 'Mensagem obrigatória' });

    const { rows:[ticket] } = await query('SELECT t.*, e.nome AS empresa_nome FROM ticket t JOIN empresa e ON e.id=t.empresa_id WHERE t.id=$1', [req.params.id]);
    if (!ticket) return res.status(404).json({ error: 'Ticket não encontrado' });

    // Adicionar mensagem
    await query(`
      INSERT INTO ticket_mensagem (ticket_id, autor_id, autor_nome, autor_tipo, mensagem)
      VALUES ($1,$2,$3,'suporte',$4)
    `, [ticket.id, req.utilizador.id, req.utilizador.nome_completo, mensagem]);

    // Actualizar estado
    const novoEstado = estado || (mensagem ? 'aguarda_cliente' : ticket.estado);
    await query(
      'UPDATE ticket SET estado=$1, actualizado_em=NOW(), resolvido_em=CASE WHEN $1=\'resolvido\' THEN NOW() ELSE resolvido_em END WHERE id=$2',
      [novoEstado, ticket.id]
    );

    // Notificar cliente por email
    try {
      const { rows:[u] } = await query(
        'SELECT email, nome_completo FROM utilizador WHERE empresa_id=$1 AND perfil=\'admin_empresa\' LIMIT 1',
        [ticket.empresa_id]
      );
      if (u?.email) {
        await email.enviar({
          remetente: 'suporte',
          para: u.email,
          assunto: `💬 Resposta ao ticket ${ticket.numero} — ${ticket.titulo}`,
          html: `<p>Olá <b>${u.nome_completo}</b>,</p><p>A equipa NexEdge respondeu ao seu ticket <b>${ticket.numero}</b>:</p><blockquote style="border-left:3px solid #4F46E5;padding-left:16px;color:#4B5563">${mensagem}</blockquote><p><a href="https://my.nexedge.pt/tickets/${ticket.id}" style="background:#4F46E5;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none">Ver Ticket</a></p>`,
        });
      }
    } catch(_) {}

    res.json({ message: 'Resposta enviada', estado: novoEstado });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CLIENTE — Notificações ────────────────────────────────────────────────────
router.get('/notificacoes/minhas', autenticar, async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT * FROM notificacao_cliente WHERE empresa_id=$1 ORDER BY criado_em DESC LIMIT 20',
      [req.empresaId]
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.patch('/notificacoes/:id/ler', autenticar, async (req, res) => {
  await query('UPDATE notificacao_cliente SET lida=true WHERE id=$1 AND empresa_id=$2', [req.params.id, req.empresaId]);
  res.json({ ok: true });
});

module.exports = router;
