'use strict';
/**
 * NexEdge — MediaLoop Premium
 * Digital Signage inteligente integrado no ERP
 * Gestão de ecrãs, conteúdos, playlists, widgets, publicidade
 * Supera: ScreenCloud, Yodeck, Signagelive, Scala
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');

router.use(autenticar);
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

// ── ECRÃS ──

router.get('/ecras', async (req, res) => {
  try {
    const r = await query(`
      SELECT e.*,
        l.nome as localizacao_nome,
        (SELECT COUNT(*) FROM medialoop_conteudo WHERE ecra_id=e.id) as num_conteudos,
        (SELECT nome FROM medialoop_playlist WHERE id=e.playlist_activa_id) as playlist_nome,
        EXTRACT(EPOCH FROM (NOW() - e.ultimo_heartbeat)) as segundos_sem_heartbeat
      FROM medialoop_ecra e
      LEFT JOIN medialoop_localizacao l ON l.id=e.localizacao_id
      WHERE e.empresa_id=$1
      ORDER BY l.nome, e.nome
    `, [req.empresaId]).catch(()=>({rows:[]}));

    // Marcar online/offline (sem heartbeat há mais de 60s = offline)
    const ecras = r.rows.map(e => ({
      ...e,
      online: e.segundos_sem_heartbeat !== null && e.segundos_sem_heartbeat < 60,
    }));

    res.json(ecras);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/ecras', async (req, res) => {
  try {
    const { nome, localizacao_id, tipo, resolucao, orientacao, descricao } = req.body;
    const activation_code = crypto.randomBytes(3).toString('hex').toUpperCase();
    const device_token = crypto.randomBytes(32).toString('hex');

    const r = await query(`
      INSERT INTO medialoop_ecra (empresa_id, nome, localizacao_id, tipo, resolucao, orientacao, descricao, activation_code, device_token, estado)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'inactivo') RETURNING *
    `, [req.empresaId, nome, localizacao_id||null, tipo||'tv', resolucao||'1920x1080', orientacao||'landscape', descricao||'', activation_code, device_token]);

    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/ecras/:id', async (req, res) => {
  try {
    const d = req.body;
    const campos = ['nome','localizacao_id','tipo','resolucao','orientacao','descricao','playlist_activa_id','layout_id','estado','volume','brilho'];
    const updates = [], params = [];
    let n = 1;
    for (const c of campos) { if(d[c]!==undefined){updates.push(`${c}=$${n++}`);params.push(d[c]);}}
    params.push(req.params.id);
    await query(`UPDATE medialoop_ecra SET ${updates.join(',')} WHERE id=$${n} AND empresa_id='${req.empresaId}'`, params);
    const r = await query(`SELECT * FROM medialoop_ecra WHERE id=$1`, [req.params.id]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/ecras/:id', async (req, res) => {
  try {
    await query(`DELETE FROM medialoop_ecra WHERE id=$1 AND empresa_id=$2`, [req.params.id, req.empresaId]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Heartbeat do player (ecrã reporta que está vivo)
router.post('/ecras/:token/heartbeat', async (req, res) => {
  try {
    const { resolucao, versao, ip, conteudo_actual } = req.body;
    await query(`UPDATE medialoop_ecra SET ultimo_heartbeat=NOW(), estado='activo',
      resolucao=COALESCE($1,resolucao), versao_player=$2, ip_actual=$3, conteudo_actual=$4
      WHERE device_token=$5`,
      [resolucao||null, versao||null, ip||null, conteudo_actual||null, req.params.token]);

    // Buscar configuração actual para o player
    const r = await query(`
      SELECT e.*, p.conteudos as playlist_conteudos, p.nome as playlist_nome,
        l.nome as localizacao_nome
      FROM medialoop_ecra e
      LEFT JOIN medialoop_playlist p ON p.id=e.playlist_activa_id
      LEFT JOIN medialoop_localizacao l ON l.id=e.localizacao_id
      WHERE e.device_token=$1
    `, [req.params.token]);

    if (!r.rows.length) return res.status(404).json({ error: 'Ecrã não encontrado' });
    res.json({ ok: true, config: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Activar ecrã com código
router.post('/ecras/activar', async (req, res) => {
  try {
    const { activation_code, device_info } = req.body;
    const r = await query(`SELECT * FROM medialoop_ecra WHERE activation_code=$1 AND estado='inactivo'`, [activation_code?.toUpperCase()]);
    if (!r.rows.length) return res.status(404).json({ error: 'Código inválido ou já activado' });

    await query(`UPDATE medialoop_ecra SET estado='activo', activation_code=NULL, device_info=$1, activado_em=NOW() WHERE id=$2`,
      [JSON.stringify(device_info||{}), r.rows[0].id]);

    res.json({ ok: true, device_token: r.rows[0].device_token, ecra: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Screenshot remoto / reiniciar ecrã
router.post('/ecras/:id/comando', async (req, res) => {
  try {
    const { comando } = req.body; // 'reiniciar' | 'screenshot' | 'actualizar'
    await query(`INSERT INTO medialoop_comando (ecra_id, empresa_id, comando, estado)
      VALUES ($1,$2,$3,'pendente')`, [req.params.id, req.empresaId, comando]);
    res.json({ ok: true, mensagem: `Comando '${comando}' enviado` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Player busca comandos pendentes
router.get('/ecras/:token/comandos', async (req, res) => {
  try {
    const ecra = await query(`SELECT id FROM medialoop_ecra WHERE device_token=$1`, [req.params.token]);
    if (!ecra.rows.length) return res.json([]);
    const cmds = await query(`SELECT * FROM medialoop_comando WHERE ecra_id=$1 AND estado='pendente' ORDER BY criado_em`, [ecra.rows[0].id]);
    await query(`UPDATE medialoop_comando SET estado='enviado' WHERE ecra_id=$1 AND estado='pendente'`, [ecra.rows[0].id]);
    res.json(cmds.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── LOCALIZAÇÕES ──

router.get('/localizacoes', async (req, res) => {
  try {
    const r = await query(`SELECT l.*, COUNT(e.id) as num_ecras FROM medialoop_localizacao l
      LEFT JOIN medialoop_ecra e ON e.localizacao_id=l.id
      WHERE l.empresa_id=$1 GROUP BY l.id ORDER BY l.nome`, [req.empresaId]).catch(()=>({rows:[]}));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/localizacoes', async (req, res) => {
  try {
    const { nome, morada, cidade, pais, timezone } = req.body;
    const r = await query(`INSERT INTO medialoop_localizacao (empresa_id, nome, morada, cidade, pais, timezone)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.empresaId, nome, morada||'', cidade||'', pais||'PT', timezone||'Europe/Lisbon']);
    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CONTEÚDOS ──

router.get('/conteudos', async (req, res) => {
  try {
    const r = await query(`SELECT * FROM medialoop_conteudo WHERE empresa_id=$1 ORDER BY criado_em DESC`, [req.empresaId]).catch(()=>({rows:[]}));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/conteudos', async (req, res) => {
  try {
    const { nome, tipo, url, duracao_seg, descricao, tags, thumbnail_url } = req.body;
    if (!nome || !url) return res.status(400).json({ error: 'Nome e URL obrigatórios' });

    const r = await query(`
      INSERT INTO medialoop_conteudo (empresa_id, nome, tipo, url, duracao_seg, descricao, tags, thumbnail_url, tamanho_bytes, estado)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'activo') RETURNING *
    `, [req.empresaId, nome, tipo||'imagem', url, duracao_seg||10, descricao||'',
        JSON.stringify(tags||[]), thumbnail_url||null, 0]);
    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/conteudos/:id', async (req, res) => {
  try {
    await query(`DELETE FROM medialoop_conteudo WHERE id=$1 AND empresa_id=$2`, [req.params.id, req.empresaId]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PLAYLISTS ──

router.get('/playlists', async (req, res) => {
  try {
    const r = await query(`
      SELECT p.*,
        (SELECT COUNT(*) FROM medialoop_ecra WHERE playlist_activa_id=p.id) as num_ecras
      FROM medialoop_playlist p WHERE p.empresa_id=$1 ORDER BY p.nome
    `, [req.empresaId]).catch(()=>({rows:[]}));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/playlists', async (req, res) => {
  try {
    const { nome, descricao, conteudos, loop, ordem_aleatoria } = req.body;
    // conteudos: [{conteudo_id, duracao_seg, ordem, transicao}]
    const r = await query(`
      INSERT INTO medialoop_playlist (empresa_id, nome, descricao, conteudos, loop, ordem_aleatoria)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
    `, [req.empresaId, nome, descricao||'', JSON.stringify(conteudos||[]), loop!==false, ordem_aleatoria||false]);
    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/playlists/:id', async (req, res) => {
  try {
    const { nome, descricao, conteudos, loop, ordem_aleatoria } = req.body;
    await query(`UPDATE medialoop_playlist SET nome=$1, descricao=$2, conteudos=$3, loop=$4, ordem_aleatoria=$5 WHERE id=$6 AND empresa_id=$7`,
      [nome, descricao||'', JSON.stringify(conteudos||[]), loop!==false, ordem_aleatoria||false, req.params.id, req.empresaId]);
    const r = await query(`SELECT * FROM medialoop_playlist WHERE id=$1`, [req.params.id]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Publicar playlist em ecrã(s)
router.post('/playlists/:id/publicar', async (req, res) => {
  try {
    const { ecra_ids } = req.body; // array de IDs ou 'todos'
    if (ecra_ids === 'todos') {
      await query(`UPDATE medialoop_ecra SET playlist_activa_id=$1 WHERE empresa_id=$2`, [req.params.id, req.empresaId]);
    } else if (Array.isArray(ecra_ids)) {
      for (const eid of ecra_ids) {
        await query(`UPDATE medialoop_ecra SET playlist_activa_id=$1 WHERE id=$2 AND empresa_id=$3`, [req.params.id, eid, req.empresaId]);
      }
    }
    res.json({ ok: true, publicado_em: ecra_ids?.length || 'todos' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── LAYOUTS ──

router.get('/layouts', async (req, res) => {
  try {
    const r = await query(`SELECT * FROM medialoop_layout WHERE empresa_id=$1 OR global=true ORDER BY nome`, [req.empresaId]).catch(()=>({rows:[]}));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/layouts', async (req, res) => {
  try {
    const { nome, zonas, fundo_cor, fundo_url } = req.body;
    // zonas: [{id, tipo, x, y, largura, altura, zindex, config}]
    const r = await query(`
      INSERT INTO medialoop_layout (empresa_id, nome, zonas, fundo_cor, fundo_url)
      VALUES ($1,$2,$3,$4,$5) RETURNING *
    `, [req.empresaId, nome, JSON.stringify(zonas||defaultLayout()), fundo_cor||'#000000', fundo_url||null]);
    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

function defaultLayout() {
  return [
    { id:'principal', tipo:'media', x:0, y:0, largura:100, altura:85, zindex:1, config:{} },
    { id:'ticker', tipo:'ticker', x:0, y:85, largura:70, altura:15, zindex:2, config:{ velocidade:50 } },
    { id:'info', tipo:'widgets', x:70, y:85, largura:30, altura:15, zindex:2, config:{ widgets:['hora','temperatura'] } },
  ];
}

// ── WIDGETS ──

// Dados dinâmicos para os widgets do player
router.get('/widgets/:ecraId', async (req, res) => {
  try {
    const ecra = await query(`SELECT e.*, l.timezone, l.cidade, l.pais FROM medialoop_ecra e
      LEFT JOIN medialoop_localizacao l ON l.id=e.localizacao_id
      WHERE e.id=$1 AND e.empresa_id=$2`, [req.params.ecraId, req.empresaId]);

    if (!ecra.rows.length) return res.status(404).json({ error: 'Ecrã não encontrado' });
    const e = ecra.rows[0];

    // Aniversários hoje e próximos 7 dias
    const aniversarios = await query(`
      SELECT nome_completo, departamento, cargo, data_nascimento,
        EXTRACT(YEAR FROM AGE(NOW(), data_nascimento)) as idade
      FROM funcionario
      WHERE empresa_id=$1 AND estado='ativo'
        AND TO_CHAR(data_nascimento,'MM-DD') BETWEEN TO_CHAR(NOW(),'MM-DD') AND TO_CHAR(NOW()+INTERVAL '7 days','MM-DD')
      ORDER BY TO_CHAR(data_nascimento,'MM-DD')
      LIMIT 5
    `, [req.empresaId]).catch(()=>({rows:[]}));

    // Senhas activas (se módulo senhas activo)
    const senhas = await query(`
      SELECT s.numero, s.tipo, s.balcao, s.estado
      FROM medialoop_senha s
      WHERE s.empresa_id=$1 AND s.estado IN ('chamada','em_atendimento')
        AND s.criado_em > NOW()-INTERVAL '5 minutes'
      ORDER BY s.chamada_em DESC LIMIT 3
    `, [req.empresaId]).catch(()=>({rows:[]}));

    // Próximos eventos / avisos internos
    const avisos = await query(`
      SELECT titulo, mensagem, prioridade FROM medialoop_aviso
      WHERE empresa_id=$1 AND activo=true
        AND (data_inicio IS NULL OR data_inicio <= NOW())
        AND (data_fim IS NULL OR data_fim >= NOW())
      ORDER BY prioridade DESC, criado_em DESC LIMIT 5
    `, [req.empresaId]).catch(()=>({rows:[]}));

    res.json({
      hora_local: new Date().toLocaleTimeString('pt-PT', { hour:'2-digit', minute:'2-digit', timeZone: e.timezone||'Europe/Lisbon' }),
      data_local: new Date().toLocaleDateString('pt-PT', { weekday:'long', day:'numeric', month:'long', timeZone: e.timezone||'Europe/Lisbon' }),
      timezone: e.timezone||'Europe/Lisbon',
      cidade: e.cidade||'',
      pais: e.pais||'PT',
      aniversarios: aniversarios.rows,
      senhas: senhas.rows,
      avisos: avisos.rows,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PROGRAMAÇÃO (SCHEDULE) ──

router.get('/ecras/:id/programacao', async (req, res) => {
  try {
    const r = await query(`SELECT * FROM medialoop_programacao WHERE ecra_id=$1 AND empresa_id=$2 ORDER BY dia_semana, hora_inicio`, [req.params.id, req.empresaId]).catch(()=>({rows:[]}));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/ecras/:id/programacao', async (req, res) => {
  try {
    const { dia_semana, hora_inicio, hora_fim, playlist_id, layout_id, nome } = req.body;
    // dia_semana: 0=todos, 1=seg, 2=ter, ... 7=dom
    const r = await query(`
      INSERT INTO medialoop_programacao (ecra_id, empresa_id, nome, dia_semana, hora_inicio, hora_fim, playlist_id, layout_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
    `, [req.params.id, req.empresaId, nome||'Programação', dia_semana||0, hora_inicio, hora_fim, playlist_id||null, layout_id||null]);
    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Player busca configuração actual baseada na programação
router.get('/ecras/:token/config-actual', async (req, res) => {
  try {
    const ecra = await query(`SELECT e.*, p.conteudos, p.loop, p.ordem_aleatoria,
      l.zonas as layout_zonas, l.fundo_cor, l.fundo_url
      FROM medialoop_ecra e
      LEFT JOIN medialoop_playlist p ON p.id=e.playlist_activa_id
      LEFT JOIN medialoop_layout l ON l.id=e.layout_id
      WHERE e.device_token=$1`, [req.params.token]);

    if (!ecra.rows.length) return res.status(404).json({ error: 'Não encontrado' });

    const agora = new Date();
    const horaActual = `${agora.getHours().toString().padStart(2,'0')}:${agora.getMinutes().toString().padStart(2,'0')}`;
    const diaSemana = agora.getDay();

    // Ver se há programação específica para agora
    const prog = await query(`
      SELECT pr.*, p.conteudos, p.loop, l.zonas as layout_zonas
      FROM medialoop_programacao pr
      LEFT JOIN medialoop_playlist p ON p.id=pr.playlist_id
      LEFT JOIN medialoop_layout l ON l.id=pr.layout_id
      WHERE pr.ecra_id=$1 AND pr.hora_inicio <= $2 AND pr.hora_fim >= $2
        AND (pr.dia_semana=0 OR pr.dia_semana=$3)
      ORDER BY pr.dia_semana DESC LIMIT 1
    `, [ecra.rows[0].id, horaActual, diaSemana]);

    const config = prog.rows.length ? { ...ecra.rows[0], ...prog.rows[0] } : ecra.rows[0];
    res.json(config);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PUBLICIDADE ──

router.get('/publicidade', async (req, res) => {
  try {
    const r = await query(`SELECT c.*, cl.nome as cliente_nome FROM medialoop_campanha c
      LEFT JOIN cliente cl ON cl.id=c.cliente_id
      WHERE c.empresa_id=$1 ORDER BY c.criado_em DESC`, [req.empresaId]).catch(()=>({rows:[]}));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/publicidade', async (req, res) => {
  try {
    const { nome, cliente_id, conteudo_id, ecra_ids, data_inicio, data_fim, frequencia_min, valor_total, revenue_share_pct } = req.body;
    const r = await query(`
      INSERT INTO medialoop_campanha (empresa_id, nome, cliente_id, conteudo_id, ecra_ids,
        data_inicio, data_fim, frequencia_min, valor_total, revenue_share_pct, estado)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'activa') RETURNING *
    `, [req.empresaId, nome, cliente_id||null, conteudo_id||null,
        JSON.stringify(ecra_ids||[]), data_inicio||null, data_fim||null,
        frequencia_min||10, valor_total||0, revenue_share_pct||30]);
    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── AVISOS INTERNOS ──

router.get('/avisos', async (req, res) => {
  try {
    const r = await query(`SELECT * FROM medialoop_aviso WHERE empresa_id=$1 ORDER BY criado_em DESC`, [req.empresaId]).catch(()=>({rows:[]}));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/avisos', async (req, res) => {
  try {
    const { titulo, mensagem, prioridade, data_inicio, data_fim, ecra_ids } = req.body;
    const r = await query(`INSERT INTO medialoop_aviso (empresa_id, titulo, mensagem, prioridade, data_inicio, data_fim, ecra_ids, activo)
      VALUES ($1,$2,$3,$4,$5,$6,$7,true) RETURNING *`,
      [req.empresaId, titulo, mensagem||'', prioridade||'normal', data_inicio||null, data_fim||null, JSON.stringify(ecra_ids||[])]);
    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ANALYTICS ──

router.get('/analytics', async (req, res) => {
  try {
    const [ecras, campanhas] = await Promise.all([
      query(`SELECT
        COUNT(*) as total_ecras,
        COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (NOW()-ultimo_heartbeat)) < 60) as online,
        COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (NOW()-ultimo_heartbeat)) >= 60 OR ultimo_heartbeat IS NULL) as offline
        FROM medialoop_ecra WHERE empresa_id=$1`, [req.empresaId]),
      query(`SELECT COUNT(*) as total_campanhas, SUM(valor_total) as receita_publicidade
        FROM medialoop_campanha WHERE empresa_id=$1 AND estado='activa'`, [req.empresaId]),
    ]);

    res.json({
      ecras: ecras.rows[0],
      campanhas: campanhas.rows[0],
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── IA — SUGESTÃO DE CONTEÚDOS ──

router.post('/ia/sugerir-conteudos', async (req, res) => {
  try {
    const { contexto, tipo_ecra, publico_alvo } = req.body;
    if (!anthropic) return res.json({ sugestoes: ['Configure ANTHROPIC_API_KEY para usar sugestões IA'] });

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 800,
      messages: [{role:'user', content:`És um especialista em Digital Signage e comunicação visual corporativa.
Sugere conteúdos premium para ecrãs digitais com base neste contexto:

Tipo de ecrã: ${tipo_ecra||'TV corporativa'}
Localização: ${contexto||'escritório'}
Público: ${publico_alvo||'funcionários e visitantes'}

Sugere:
1. 5 tipos de conteúdo ideais para este ecrã
2. Duração recomendada de cada
3. Horários ideais para cada tipo
4. Métricas de eficácia a monitorizar

Responde em português de Portugal, de forma concreta e accionável.`}]
    });

    res.json({ sugestoes: response.content[0]?.text });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
