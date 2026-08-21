'use strict';
const express = require('express');
const router = express.Router();
const { query, transaction } = require('../config/database');
const { autenticar } = require('../middleware/auth');

router.use(autenticar);

// ── Utilidades ────────────────────────────────────────────────────────────────

function calcSLA(tipo, prioridade, sla_h_custom) {
  const tabela = {
    incident: { critica: 1, alta: 4, media: 8, baixa: 24 },
    request:  { critica: 2, alta: 8, media: 24, baixa: 72 },
    problem:  { critica: 4, alta: 8, media: 24, baixa: 48 },
    change:   { critica: 4, alta: 8, media: 24, baixa: 48 },
    task:     { critica: 2, alta: 8, media: 24, baixa: 72 },
  };
  const resolucao = sla_h_custom || tabela[tipo]?.[prioridade] || 24;
  const resposta = Math.round(resolucao / 4);
  return { resposta_h: resposta, resolucao_h: resolucao };
}

async function gerarNumero(empresaId, prefixo) {
  const ano = new Date().getFullYear();
  const tabela = prefixo === 'TK' ? 'itsm_ticket' :
                 prefixo === 'PR' ? 'itsm_problema' : 'itsm_mudanca';
  const r = await query(
    `SELECT COUNT(*) as total FROM ${tabela} WHERE empresa_id=$1 AND EXTRACT(YEAR FROM criado_em)=$2`,
    [empresaId, ano]
  );
  const seq = (parseInt(r.rows[0].total) + 1).toString().padStart(5, '0');
  return `${prefixo}${ano}-${seq}`;
}

async function adicionarActividade(ticketId, autorId, tipo, conteudo, visivel = true) {
  await query(
    `INSERT INTO itsm_comentario (ticket_id, autor_id, tipo, conteudo, "visivelParaCliente") VALUES ($1,$2,$3,$4,$5)`,
    [ticketId, autorId, tipo, conteudo, visivel]
  );
}

async function verificarSLA(ticket) {
  const agora = new Date();
  const updates = {};
  if (ticket.data_limite_resposta && !ticket.data_primeira_resposta) {
    updates.sla_resposta_cumprido = agora <= new Date(ticket.data_limite_resposta);
  }
  if (ticket.data_limite_resolucao && ticket.resolvido_em) {
    updates.sla_resolucao_cumprido = new Date(ticket.resolvido_em) <= new Date(ticket.data_limite_resolucao);
  }
  return updates;
}

// ── Setup inicial (criar categorias default) ──────────────────────────────────

router.post('/setup', async (req, res) => {
  try {
    const categorias = [
      { nome: 'Infraestrutura TI', icone: '🖥️', cor: '#4F46E5', sla_resposta_h: 2, sla_resolucao_h: 8 },
      { nome: 'Software & Aplicações', icone: '💻', cor: '#7C3AED', sla_resposta_h: 4, sla_resolucao_h: 24 },
      { nome: 'Recursos Humanos', icone: '👥', cor: '#059669', sla_resposta_h: 8, sla_resolucao_h: 48 },
      { nome: 'Financeiro', icone: '💰', cor: '#D97706', sla_resposta_h: 4, sla_resolucao_h: 24 },
      { nome: 'Frota & Viaturas', icone: '🚗', cor: '#DC2626', sla_resposta_h: 2, sla_resolucao_h: 8 },
      { nome: 'Instalações & Facilities', icone: '🏢', cor: '#0891B2', sla_resposta_h: 8, sla_resolucao_h: 72 },
      { nome: 'Segurança & Acessos', icone: '🔐', cor: '#B91C1C', sla_resposta_h: 1, sla_resolucao_h: 4 },
      { nome: 'Outros', icone: '📋', cor: '#6B7280', sla_resposta_h: 8, sla_resolucao_h: 72 },
    ];
    for (const [i, cat] of categorias.entries()) {
      await query(
        `INSERT INTO itsm_categoria (empresa_id, nome, icone, cor, sla_resposta_h, sla_resolucao_h, ordem)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [req.empresaId, cat.nome, cat.icone, cat.cor, cat.sla_resposta_h, cat.sla_resolucao_h, i]
      );
    }

    // Grupos default
    await query(
      `INSERT INTO itsm_grupo (empresa_id, nome, descricao) VALUES ($1,'Service Desk','Primeira linha de suporte') ON CONFLICT DO NOTHING`,
      [req.empresaId]
    );

    // SLAs default
    const slas = [
      { nome: 'Crítico 24/7', tipo: 'incident', prioridade: 'critica', resposta_h: 1, resolucao_h: 4 },
      { nome: 'Alta Prioridade', tipo: 'incident', prioridade: 'alta', resposta_h: 2, resolucao_h: 8 },
      { nome: 'Média Prioridade', tipo: 'request', prioridade: 'media', resposta_h: 4, resolucao_h: 24 },
      { nome: 'Baixa Prioridade', tipo: 'request', prioridade: 'baixa', resposta_h: 8, resolucao_h: 72 },
    ];
    for (const sla of slas) {
      await query(
        `INSERT INTO itsm_sla (empresa_id, nome, tipo, prioridade, resposta_h, resolucao_h)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [req.empresaId, sla.nome, sla.tipo, sla.prioridade, sla.resposta_h, sla.resolucao_h]
      );
    }

    res.json({ ok: true, mensagem: 'ITSM configurado com sucesso' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Dashboard / KPIs ─────────────────────────────────────────────────────────

router.get('/dashboard', async (req, res) => {
  try {
    const eid = req.empresaId;
    const [abertos, urgentes, sla_breach, por_estado, por_tipo, por_prioridade, recentes, mttr, satisfacao] = await Promise.all([
      query(`SELECT COUNT(*) FROM itsm_ticket WHERE empresa_id=$1 AND estado NOT IN ('resolvido','fechado','cancelado')`, [eid]),
      query(`SELECT COUNT(*) FROM itsm_ticket WHERE empresa_id=$1 AND prioridade IN ('critica','alta') AND estado NOT IN ('resolvido','fechado','cancelado')`, [eid]),
      query(`SELECT COUNT(*) FROM itsm_ticket WHERE empresa_id=$1 AND estado NOT IN ('resolvido','fechado','cancelado') AND data_limite_resolucao < NOW()`, [eid]),
      query(`SELECT estado, COUNT(*) as total FROM itsm_ticket WHERE empresa_id=$1 GROUP BY estado ORDER BY total DESC`, [eid]),
      query(`SELECT tipo, COUNT(*) as total FROM itsm_ticket WHERE empresa_id=$1 GROUP BY tipo ORDER BY total DESC`, [eid]),
      query(`SELECT prioridade, COUNT(*) as total FROM itsm_ticket WHERE empresa_id=$1 GROUP BY prioridade ORDER BY total DESC`, [eid]),
      query(`SELECT t.*, u.nome_completo as criado_por_nome, a.nome_completo as atribuido_nome
             FROM itsm_ticket t
             LEFT JOIN utilizador u ON u.id=t.criado_por
             LEFT JOIN utilizador a ON a.id=t.atribuido_a
             WHERE t.empresa_id=$1 AND t.estado NOT IN ('fechado','cancelado')
             ORDER BY t.criado_em DESC LIMIT 10`, [eid]),
      query(`SELECT AVG(tempo_resolucao_min) as media FROM itsm_ticket WHERE empresa_id=$1 AND tempo_resolucao_min > 0`, [eid]),
      query(`SELECT AVG(satisfacao) as media, COUNT(*) as total FROM itsm_ticket WHERE empresa_id=$1 AND satisfacao IS NOT NULL`, [eid]),
    ]);

    // SLA compliance últimos 30 dias
    const sla30 = await query(`
      SELECT
        COUNT(*) FILTER (WHERE sla_resposta_cumprido = true) as resposta_ok,
        COUNT(*) FILTER (WHERE sla_resposta_cumprido IS NOT NULL) as resposta_total,
        COUNT(*) FILTER (WHERE sla_resolucao_cumprido = true) as resolucao_ok,
        COUNT(*) FILTER (WHERE sla_resolucao_cumprido IS NOT NULL) as resolucao_total
      FROM itsm_ticket WHERE empresa_id=$1 AND criado_em > NOW() - INTERVAL '30 days'
    `, [eid]);

    const s = sla30.rows[0];
    res.json({
      kpis: {
        abertos: parseInt(abertos.rows[0].count),
        urgentes: parseInt(urgentes.rows[0].count),
        sla_breach: parseInt(sla_breach.rows[0].count),
        mttr_min: Math.round(parseFloat(mttr.rows[0]?.media || 0)),
        satisfacao_media: parseFloat(satisfacao.rows[0]?.media || 0).toFixed(1),
        satisfacao_total: parseInt(satisfacao.rows[0]?.total || 0),
        sla_resposta_pct: s.resposta_total > 0 ? Math.round((s.resposta_ok / s.resposta_total) * 100) : 100,
        sla_resolucao_pct: s.resolucao_total > 0 ? Math.round((s.resolucao_ok / s.resolucao_total) * 100) : 100,
      },
      por_estado: por_estado.rows,
      por_tipo: por_tipo.rows,
      por_prioridade: por_prioridade.rows,
      recentes: recentes.rows,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Tickets ───────────────────────────────────────────────────────────────────

router.get('/tickets', async (req, res) => {
  try {
    const { estado, tipo, prioridade, atribuido_a, categoria_id, pesquisa, page = 1, limite = 20 } = req.query;
    const conds = ['t.empresa_id=$1'], params = [req.empresaId];
    let p = 2;
    if (estado) { conds.push(`t.estado=$${p++}`); params.push(estado); }
    if (tipo) { conds.push(`t.tipo=$${p++}`); params.push(tipo); }
    if (prioridade) { conds.push(`t.prioridade=$${p++}`); params.push(prioridade); }
    if (atribuido_a) { conds.push(`t.atribuido_a=$${p++}`); params.push(atribuido_a); }
    if (categoria_id) { conds.push(`t.categoria_id=$${p++}`); params.push(categoria_id); }
    if (pesquisa) { conds.push(`(t.titulo ILIKE $${p} OR t.numero ILIKE $${p} OR t.descricao ILIKE $${p})`); params.push(`%${pesquisa}%`); p++; }

    const offset = (parseInt(page) - 1) * parseInt(limite);
    const where = conds.join(' AND ');

    const [rows, total] = await Promise.all([
      query(`SELECT t.*, c.nome as categoria_nome, c.icone as categoria_icone, c.cor as categoria_cor,
               u.nome_completo as criado_por_nome, a.nome_completo as atribuido_nome,
               s.nome_completo as solicitante_nome,
               (SELECT COUNT(*) FROM itsm_comentario WHERE ticket_id=t.id) as num_comentarios,
               CASE WHEN t.data_limite_resolucao < NOW() AND t.estado NOT IN ('resolvido','fechado','cancelado') THEN true ELSE false END as sla_violado
             FROM itsm_ticket t
             LEFT JOIN itsm_categoria c ON c.id=t.categoria_id
             LEFT JOIN utilizador u ON u.id=t.criado_por
             LEFT JOIN utilizador a ON a.id=t.atribuido_a
             LEFT JOIN utilizador s ON s.id=t.solicitante_id
             WHERE ${where} ORDER BY t.criado_em DESC LIMIT $${p} OFFSET $${p+1}`,
        [...params, parseInt(limite), offset]),
      query(`SELECT COUNT(*) FROM itsm_ticket t WHERE ${where}`, params),
    ]);

    res.json({ tickets: rows.rows, total: parseInt(total.rows[0].count), page: parseInt(page), limite: parseInt(limite) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/tickets/:id', async (req, res) => {
  try {
    const r = await query(`
      SELECT t.*,
        c.nome as categoria_nome, c.icone as categoria_icone, c.cor as categoria_cor,
        u.nome_completo as criado_por_nome, u.email as criado_por_email,
        a.nome_completo as atribuido_nome, a.email as atribuido_email,
        s.nome_completo as solicitante_nome, s.email as solicitante_email,
        CASE WHEN t.data_limite_resolucao < NOW() AND t.estado NOT IN ('resolvido','fechado','cancelado') THEN true ELSE false END as sla_violado
      FROM itsm_ticket t
      LEFT JOIN itsm_categoria c ON c.id=t.categoria_id
      LEFT JOIN utilizador u ON u.id=t.criado_por
      LEFT JOIN utilizador a ON a.id=t.atribuido_a
      LEFT JOIN utilizador s ON s.id=t.solicitante_id
      WHERE t.id=$1 AND t.empresa_id=$2
    `, [req.params.id, req.empresaId]);

    if (!r.rows.length) return res.status(404).json({ error: 'Ticket não encontrado' });

    const [comentarios, anexos] = await Promise.all([
      query(`SELECT c.*, u.nome_completo as autor_nome, u.email as autor_email
             FROM itsm_comentario c LEFT JOIN utilizador u ON u.id=c.autor_id
             WHERE c.ticket_id=$1 ORDER BY c.criado_em ASC`, [req.params.id]),
      query(`SELECT a.*, u.nome_completo as enviado_por_nome FROM itsm_anexo a
             LEFT JOIN utilizador u ON u.id=a.enviado_por WHERE a.ticket_id=$1`, [req.params.id]),
    ]);

    res.json({ ...r.rows[0], comentarios: comentarios.rows, anexos: anexos.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/tickets', async (req, res) => {
  try {
    const d = req.body;
    const numero = await gerarNumero(req.empresaId, 'TK');
    const sla = calcSLA(d.tipo || 'request', d.prioridade || 'media', d.sla_resolucao_h);
    const agora = new Date();
    const limiteResposta = new Date(agora.getTime() + sla.resposta_h * 3600000);
    const limiteResolucao = new Date(agora.getTime() + sla.resolucao_h * 3600000);

    const r = await query(`
      INSERT INTO itsm_ticket (
        empresa_id, numero, tipo, titulo, descricao, categoria_id, servico_id,
        prioridade, impacto, urgencia, criado_por, solicitante_id, atribuido_a, grupo_id,
        sla_resposta_h, sla_resolucao_h, data_limite_resposta, data_limite_resolucao,
        funcionario_id, viatura_id, tags, campos_extra
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
      RETURNING *
    `, [
      req.empresaId, numero, d.tipo || 'request', d.titulo, d.descricao,
      d.categoria_id || null, d.servico_id || null,
      d.prioridade || 'media', d.impacto || 'individual', d.urgencia || 'normal',
      req.utilizador.id, d.solicitante_id || req.utilizador.id, d.atribuido_a || null, d.grupo_id || null,
      sla.resposta_h, sla.resolucao_h, limiteResposta, limiteResolucao,
      d.funcionario_id || null, d.viatura_id || null,
      JSON.stringify(d.tags || []), JSON.stringify(d.campos_extra || {}),
    ]);

    await adicionarActividade(r.rows[0].id, req.utilizador.id, 'sistema', `Ticket criado por ${req.utilizador.nome_completo}`);

    // Notificar técnico atribuído
    if (d.atribuido_a) {
      await query(
        `INSERT INTO notificacao (utilizador_id, titulo, mensagem, tipo, url_accao)
         VALUES ($1,$2,$3,'info','/itsm')`,
        [d.atribuido_a, `Novo ticket atribuído: ${numero}`, d.titulo]
      ).catch(() => {});
    }

    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/tickets/:id', async (req, res) => {
  try {
    const d = req.body;
    const ticket = await query(`SELECT * FROM itsm_ticket WHERE id=$1 AND empresa_id=$2`, [req.params.id, req.empresaId]);
    if (!ticket.rows.length) return res.status(404).json({ error: 'Não encontrado' });
    const t = ticket.rows[0];

    const updates = [];
    const params = [];
    let p = 1;

    const campos = ['titulo','descricao','estado','prioridade','impacto','urgencia','categoria_id','servico_id','atribuido_a','grupo_id','resolucao','causa_raiz','solucao_contorno','tags','campos_extra'];
    for (const campo of campos) {
      if (d[campo] !== undefined) {
        updates.push(`${campo}=$${p++}`);
        params.push(campo === 'tags' || campo === 'campos_extra' ? JSON.stringify(d[campo]) : d[campo]);
      }
    }

    // Lógica de estado
    let actividade = null;
    if (d.estado && d.estado !== t.estado) {
      if (d.estado === 'em_progresso' && !t.data_primeira_resposta) {
        updates.push(`data_primeira_resposta=NOW()`);
        const slaCumprido = new Date() <= new Date(t.data_limite_resposta);
        updates.push(`sla_resposta_cumprido=$${p++}`);
        params.push(slaCumprido);
      }
      if (['resolvido','fechado'].includes(d.estado) && !t.resolvido_em) {
        updates.push(`resolvido_em=NOW()`);
        const agora = new Date();
        const slaCumprido = agora <= new Date(t.data_limite_resolucao);
        updates.push(`sla_resolucao_cumprido=$${p++}`);
        params.push(slaCumprido);
        const minutos = Math.round((agora - new Date(t.criado_em)) / 60000);
        updates.push(`tempo_resolucao_min=$${p++}`);
        params.push(minutos);
      }
      actividade = `Estado alterado: ${t.estado} → ${d.estado}`;
    }

    if (d.atribuido_a && d.atribuido_a !== t.atribuido_a) {
      actividade = `Atribuído a: ${d.atribuido_a_nome || d.atribuido_a}`;
      await query(
        `INSERT INTO notificacao (utilizador_id, titulo, mensagem, tipo, url_accao) VALUES ($1,$2,$3,'info','/itsm')`,
        [d.atribuido_a, `Ticket atribuído: ${t.numero}`, t.titulo]
      ).catch(() => {});
    }

    updates.push(`actualizado_em=NOW()`);
    params.push(req.params.id);
    await query(`UPDATE itsm_ticket SET ${updates.join(',')} WHERE id=$${p}`, params);
    if (actividade) await adicionarActividade(req.params.id, req.utilizador.id, 'estado', actividade);

    const updated = await query(`SELECT * FROM itsm_ticket WHERE id=$1`, [req.params.id]);
    res.json(updated.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Comentários ───────────────────────────────────────────────────────────────

router.post('/tickets/:id/comentarios', async (req, res) => {
  try {
    const { conteudo, tipo = 'comentario', nota_interna = false, tempo_gasto_min = 0 } = req.body;
    const r = await query(
      `INSERT INTO itsm_comentario (ticket_id, autor_id, conteudo, tipo, "visivelParaCliente", tempo_gasto_min)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.params.id, req.utilizador.id, conteudo, tipo, !nota_interna, tempo_gasto_min]
    );
    if (!r.rows[0].data_primeira_resposta) {
      await query(`UPDATE itsm_ticket SET data_primeira_resposta=NOW() WHERE id=$1 AND data_primeira_resposta IS NULL`, [req.params.id]);
    }
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Satisfação ────────────────────────────────────────────────────────────────

router.post('/tickets/:id/satisfacao', async (req, res) => {
  try {
    const { nota, feedback } = req.body;
    await query(
      `UPDATE itsm_ticket SET satisfacao=$1, feedback_cliente=$2 WHERE id=$3 AND empresa_id=$4`,
      [nota, feedback, req.params.id, req.empresaId]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Categorias ────────────────────────────────────────────────────────────────

router.get('/categorias', async (req, res) => {
  try {
    const r = await query(`SELECT * FROM itsm_categoria WHERE empresa_id=$1 AND ativo=true ORDER BY ordem, nome`, [req.empresaId]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/categorias', async (req, res) => {
  try {
    const { nome, descricao, icone, cor, sla_resposta_h, sla_resolucao_h } = req.body;
    const r = await query(
      `INSERT INTO itsm_categoria (empresa_id, nome, descricao, icone, cor, sla_resposta_h, sla_resolucao_h) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.empresaId, nome, descricao, icone || '🎫', cor || '#4F46E5', sla_resposta_h || 4, sla_resolucao_h || 24]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Serviços ──────────────────────────────────────────────────────────────────

router.get('/servicos', async (req, res) => {
  try {
    const r = await query(
      `SELECT s.*, c.nome as categoria_nome FROM itsm_servico s LEFT JOIN itsm_categoria c ON c.id=s.categoria_id WHERE s.empresa_id=$1 AND s.ativo=true ORDER BY s.nome`,
      [req.empresaId]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/servicos', async (req, res) => {
  try {
    const d = req.body;
    const r = await query(
      `INSERT INTO itsm_servico (empresa_id, categoria_id, nome, descricao, tipo, prioridade_default, sla_resposta_h, sla_resolucao_h, aprovacao_necessaria, aprovador_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.empresaId, d.categoria_id, d.nome, d.descricao, d.tipo || 'request', d.prioridade_default || 'media', d.sla_resposta_h || 4, d.sla_resolucao_h || 24, d.aprovacao_necessaria || false, d.aprovador_id || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Knowledge Base ────────────────────────────────────────────────────────────

router.get('/conhecimento', async (req, res) => {
  try {
    const { pesquisa, categoria_id, tipo } = req.query;
    const conds = ['k.empresa_id=$1', "k.estado='publicado'"];
    const params = [req.empresaId];
    let p = 2;
    if (categoria_id) { conds.push(`k.categoria_id=$${p++}`); params.push(categoria_id); }
    if (tipo) { conds.push(`k.tipo=$${p++}`); params.push(tipo); }
    if (pesquisa) { conds.push(`(k.titulo ILIKE $${p} OR k.conteudo ILIKE $${p})`); params.push(`%${pesquisa}%`); p++; }
    const r = await query(
      `SELECT k.*, c.nome as categoria_nome, u.nome_completo as autor_nome FROM itsm_conhecimento k
       LEFT JOIN itsm_categoria c ON c.id=k.categoria_id LEFT JOIN utilizador u ON u.id=k.autor_id
       WHERE ${conds.join(' AND ')} ORDER BY k.visualizacoes DESC, k.criado_em DESC`,
      params
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/conhecimento/:id', async (req, res) => {
  try {
    await query(`UPDATE itsm_conhecimento SET visualizacoes=visualizacoes+1 WHERE id=$1`, [req.params.id]);
    const r = await query(
      `SELECT k.*, c.nome as categoria_nome, u.nome_completo as autor_nome FROM itsm_conhecimento k
       LEFT JOIN itsm_categoria c ON c.id=k.categoria_id LEFT JOIN utilizador u ON u.id=k.autor_id
       WHERE k.id=$1 AND k.empresa_id=$2`, [req.params.id, req.empresaId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Não encontrado' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/conhecimento', async (req, res) => {
  try {
    const d = req.body;
    const r = await query(
      `INSERT INTO itsm_conhecimento (empresa_id, titulo, conteudo, categoria_id, tipo, estado, autor_id, tags, ticket_origem_id, publicado_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $6='publicado' THEN NOW() ELSE NULL END) RETURNING *`,
      [req.empresaId, d.titulo, d.conteudo, d.categoria_id || null, d.tipo || 'artigo', d.estado || 'publicado', req.utilizador.id, JSON.stringify(d.tags || []), d.ticket_origem_id || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/conhecimento/:id/util', async (req, res) => {
  try {
    const { util } = req.body;
    const campo = util ? 'util_sim' : 'util_nao';
    await query(`UPDATE itsm_conhecimento SET ${campo}=${campo}+1 WHERE id=$1 AND empresa_id=$2`, [req.params.id, req.empresaId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Problemas ─────────────────────────────────────────────────────────────────

router.get('/problemas', async (req, res) => {
  try {
    const r = await query(
      `SELECT p.*, c.nome as categoria_nome, u.nome_completo as responsavel_nome FROM itsm_problema p
       LEFT JOIN itsm_categoria c ON c.id=p.categoria_id LEFT JOIN utilizador u ON u.id=p.responsavel_id
       WHERE p.empresa_id=$1 ORDER BY p.criado_em DESC`, [req.empresaId]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/problemas', async (req, res) => {
  try {
    const d = req.body;
    const numero = await gerarNumero(req.empresaId, 'PR');
    const r = await query(
      `INSERT INTO itsm_problema (empresa_id, numero, titulo, descricao, estado, prioridade, categoria_id, responsavel_id, causa_raiz, workaround, impacto, tickets_relacionados)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [req.empresaId, numero, d.titulo, d.descricao, d.estado || 'investigacao', d.prioridade || 'media', d.categoria_id || null, d.responsavel_id || req.utilizador.id, d.causa_raiz || null, d.workaround || null, d.impacto || null, JSON.stringify(d.tickets_relacionados || [])]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/problemas/:id', async (req, res) => {
  try {
    const d = req.body;
    const campos = ['titulo','descricao','estado','prioridade','causa_raiz','solucao_definitiva','workaround','impacto'];
    const updates = [], params = [];
    let p = 1;
    for (const c of campos) {
      if (d[c] !== undefined) { updates.push(`${c}=$${p++}`); params.push(d[c]); }
    }
    if (d.estado === 'resolvido') updates.push('resolvido_em=NOW()');
    updates.push(`actualizado_em=NOW()`);
    params.push(req.params.id);
    await query(`UPDATE itsm_problema SET ${updates.join(',')} WHERE id=$${p}`, params);
    const r = await query(`SELECT * FROM itsm_problema WHERE id=$1`, [req.params.id]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Mudanças (Change Management) ──────────────────────────────────────────────

router.get('/mudancas', async (req, res) => {
  try {
    const r = await query(
      `SELECT m.*, u.nome_completo as responsavel_nome, a.nome_completo as aprovador_nome FROM itsm_mudanca m
       LEFT JOIN utilizador u ON u.id=m.responsavel_id LEFT JOIN utilizador a ON a.id=m.aprovador_id
       WHERE m.empresa_id=$1 ORDER BY m.criado_em DESC`, [req.empresaId]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/mudancas', async (req, res) => {
  try {
    const d = req.body;
    const numero = await gerarNumero(req.empresaId, 'CH');
    const r = await query(
      `INSERT INTO itsm_mudanca (empresa_id, numero, titulo, descricao, tipo, estado, prioridade, risco, responsavel_id, aprovador_id, janela_inicio, janela_fim, plano_execucao, plano_rollback, justificacao, impacto, sistemas_afectados)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [req.empresaId, numero, d.titulo, d.descricao, d.tipo || 'normal', 'rascunho', d.prioridade || 'media', d.risco || 'medio', req.utilizador.id, d.aprovador_id || null, d.janela_inicio || null, d.janela_fim || null, d.plano_execucao || null, d.plano_rollback || null, d.justificacao || null, d.impacto || null, JSON.stringify(d.sistemas_afectados || [])]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/mudancas/:id/aprovar', async (req, res) => {
  try {
    await query(
      `UPDATE itsm_mudanca SET estado='aprovado', aprovado_em=NOW(), aprovado_por=$1 WHERE id=$2 AND empresa_id=$3`,
      [req.utilizador.id, req.params.id, req.empresaId]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/mudancas/:id', async (req, res) => {
  try {
    const d = req.body;
    const campos = ['titulo','descricao','estado','prioridade','risco','plano_execucao','plano_rollback','justificacao','impacto','janela_inicio','janela_fim'];
    const updates = [], params = [];
    let p = 1;
    for (const c of campos) {
      if (d[c] !== undefined) { updates.push(`${c}=$${p++}`); params.push(d[c]); }
    }
    updates.push(`actualizado_em=NOW()`);
    params.push(req.params.id);
    await query(`UPDATE itsm_mudanca SET ${updates.join(',')} WHERE id=$${p}`, params);
    const r = await query(`SELECT * FROM itsm_mudanca WHERE id=$1`, [req.params.id]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Grupos ────────────────────────────────────────────────────────────────────

router.get('/grupos', async (req, res) => {
  try {
    const r = await query(
      `SELECT g.*, u.nome_completo as gestor_nome,
         (SELECT json_agg(json_build_object('id',ut.id,'nome',ut.nome_completo,'email',ut.email))
          FROM itsm_grupo_membro gm JOIN utilizador ut ON ut.id=gm.utilizador_id WHERE gm.grupo_id=g.id) as membros
       FROM itsm_grupo g LEFT JOIN utilizador u ON u.id=g.gestor_id
       WHERE g.empresa_id=$1 AND g.ativo=true ORDER BY g.nome`, [req.empresaId]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/grupos', async (req, res) => {
  try {
    const { nome, descricao, email, gestor_id, membros = [] } = req.body;
    const r = await query(
      `INSERT INTO itsm_grupo (empresa_id, nome, descricao, email, gestor_id) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.empresaId, nome, descricao, email, gestor_id || null]
    );
    for (const uid of membros) {
      await query(`INSERT INTO itsm_grupo_membro (grupo_id, utilizador_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [r.rows[0].id, uid]);
    }
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SLAs ──────────────────────────────────────────────────────────────────────

router.get('/slas', async (req, res) => {
  try {
    const r = await query(`SELECT * FROM itsm_sla WHERE empresa_id=$1 AND ativo=true ORDER BY tipo, prioridade`, [req.empresaId]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/slas', async (req, res) => {
  try {
    const d = req.body;
    const r = await query(
      `INSERT INTO itsm_sla (empresa_id, nome, descricao, tipo, prioridade, resposta_h, resolucao_h, horario_negocio) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.empresaId, d.nome, d.descricao, d.tipo || 'request', d.prioridade || 'media', d.resposta_h || 4, d.resolucao_h || 24, d.horario_negocio !== false]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Relatórios / Métricas ─────────────────────────────────────────────────────

router.get('/relatorios', async (req, res) => {
  try {
    const { periodo = '30' } = req.query;
    const eid = req.empresaId;
    const dias = parseInt(periodo);

    const [volume, por_tecnico, por_categoria, evolucao, breach_list] = await Promise.all([
      query(`SELECT
               COUNT(*) as total,
               COUNT(*) FILTER (WHERE estado NOT IN ('resolvido','fechado','cancelado')) as abertos,
               COUNT(*) FILTER (WHERE estado IN ('resolvido','fechado')) as resolvidos,
               AVG(tempo_resolucao_min) FILTER (WHERE tempo_resolucao_min > 0) as mttr,
               AVG(satisfacao) FILTER (WHERE satisfacao IS NOT NULL) as csat,
               COUNT(*) FILTER (WHERE sla_resolucao_cumprido = true) as sla_ok,
               COUNT(*) FILTER (WHERE sla_resolucao_cumprido IS NOT NULL) as sla_total
             FROM itsm_ticket WHERE empresa_id=$1 AND criado_em > NOW() - INTERVAL '${dias} days'`, [eid]),
      query(`SELECT u.nome_completo, COUNT(*) as total, AVG(t.tempo_resolucao_min) as mttr_medio,
               COUNT(*) FILTER (WHERE t.sla_resolucao_cumprido=true) as sla_ok
             FROM itsm_ticket t JOIN utilizador u ON u.id=t.atribuido_a
             WHERE t.empresa_id=$1 AND t.criado_em > NOW() - INTERVAL '${dias} days' AND t.atribuido_a IS NOT NULL
             GROUP BY u.id, u.nome_completo ORDER BY total DESC LIMIT 10`, [eid]),
      query(`SELECT c.nome, c.icone, c.cor, COUNT(*) as total, AVG(t.tempo_resolucao_min) as mttr_medio
             FROM itsm_ticket t JOIN itsm_categoria c ON c.id=t.categoria_id
             WHERE t.empresa_id=$1 AND t.criado_em > NOW() - INTERVAL '${dias} days'
             GROUP BY c.id, c.nome, c.icone, c.cor ORDER BY total DESC`, [eid]),
      query(`SELECT DATE(criado_em) as dia, COUNT(*) as abertos, COUNT(*) FILTER (WHERE estado IN ('resolvido','fechado')) as resolvidos
             FROM itsm_ticket WHERE empresa_id=$1 AND criado_em > NOW() - INTERVAL '${dias} days'
             GROUP BY dia ORDER BY dia`, [eid]),
      query(`SELECT t.numero, t.titulo, t.prioridade, t.data_limite_resolucao, u.nome_completo as atribuido_nome
             FROM itsm_ticket t LEFT JOIN utilizador u ON u.id=t.atribuido_a
             WHERE t.empresa_id=$1 AND t.estado NOT IN ('resolvido','fechado','cancelado') AND t.data_limite_resolucao < NOW()
             ORDER BY t.data_limite_resolucao ASC LIMIT 20`, [eid]),
    ]);

    const v = volume.rows[0];
    res.json({
      resumo: {
        total: parseInt(v.total), abertos: parseInt(v.abertos), resolvidos: parseInt(v.resolvidos),
        mttr_min: Math.round(parseFloat(v.mttr || 0)),
        csat: parseFloat(v.csat || 0).toFixed(1),
        sla_pct: v.sla_total > 0 ? Math.round((v.sla_ok / v.sla_total) * 100) : 100,
      },
      por_tecnico: por_tecnico.rows,
      por_categoria: por_categoria.rows,
      evolucao: evolucao.rows,
      breach_list: breach_list.rows,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
