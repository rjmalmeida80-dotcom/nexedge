'use strict';
/**
 * NexEdge — Sistema de Gestão de Senhas/Filas Premium
 * Integrado com MediaLoop para exibição em ecrãs
 * Quiosque, chamada, estatísticas, som, multi-balcão
 * Supera: Q-Matic, Wavetec, Tensator
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { autenticar } = require('../middleware/auth');

router.use(autenticar);

// ── CONFIGURAÇÃO DOS SERVIÇOS ──

router.get('/servicos', async (req, res) => {
  try {
    const r = await query(`SELECT s.*, COUNT(b.id) as num_balcoes
      FROM senha_servico s LEFT JOIN senha_balcao b ON b.servico_id=s.id
      WHERE s.empresa_id=$1 AND s.activo=true GROUP BY s.id ORDER BY s.prefixo`, [req.empresaId]).catch(()=>({rows:[]}));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/servicos', async (req, res) => {
  try {
    const { nome, prefixo, descricao, cor, icone, prioridade, tempo_medio_min } = req.body;
    const r = await query(`INSERT INTO senha_servico (empresa_id, nome, prefixo, descricao, cor, icone, prioridade, tempo_medio_min, activo)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true) RETURNING *`,
      [req.empresaId, nome, prefixo?.toUpperCase()||'A', descricao||'', cor||'#4F46E5', icone||'👤', prioridade||1, tempo_medio_min||5]);
    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── BALCÕES ──

router.get('/balcoes', async (req, res) => {
  try {
    const r = await query(`SELECT b.*, s.nome as servico_nome, s.cor as servico_cor,
      u.nome_completo as operador_nome,
      (SELECT COUNT(*) FROM medialoop_senha WHERE balcao_id=b.id AND estado='em_atendimento') as em_atendimento
      FROM senha_balcao b LEFT JOIN senha_servico s ON s.id=b.servico_id
      LEFT JOIN utilizador u ON u.id=b.operador_id
      WHERE b.empresa_id=$1 ORDER BY b.numero`, [req.empresaId]).catch(()=>({rows:[]}));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/balcoes', async (req, res) => {
  try {
    const { numero, nome, servico_id, localizacao } = req.body;
    const r = await query(`INSERT INTO senha_balcao (empresa_id, numero, nome, servico_id, localizacao, estado)
      VALUES ($1,$2,$3,$4,$5,'fechado') RETURNING *`,
      [req.empresaId, numero, nome||`Balcão ${numero}`, servico_id||null, localizacao||'']);
    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Abrir/fechar balcão
router.put('/balcoes/:id/estado', async (req, res) => {
  try {
    const { estado, operador_id } = req.body;
    await query(`UPDATE senha_balcao SET estado=$1, operador_id=$2 WHERE id=$3 AND empresa_id=$4`,
      [estado, operador_id||null, req.params.id, req.empresaId]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── EMISSÃO DE SENHAS (quiosque) ──

router.post('/emitir', async (req, res) => {
  try {
    const { servico_id, nome_cliente, prioridade_vip } = req.body;

    const servico = await query(`SELECT * FROM senha_servico WHERE id=$1 AND empresa_id=$2`, [servico_id, req.empresaId]);
    if (!servico.rows.length) return res.status(404).json({ error: 'Serviço não encontrado' });

    const s = servico.rows[0];

    // Gerar número sequencial diário
    const hoje = new Date().toISOString().slice(0,10);
    const count = await query(`SELECT COUNT(*) FROM medialoop_senha WHERE empresa_id=$1 AND servico_id=$2 AND DATE(criado_em)=$3`,
      [req.empresaId, servico_id, hoje]);
    const seq = parseInt(count.rows[0].count) + 1;
    const numero = `${s.prefixo}${seq.toString().padStart(3,'0')}`;

    // Calcular tempo de espera estimado
    const fila = await query(`SELECT COUNT(*) FROM medialoop_senha WHERE empresa_id=$1 AND servico_id=$2 AND estado='aguarda'`,
      [req.empresaId, servico_id]);
    const espera_estimada = parseInt(fila.rows[0].count) * (s.tempo_medio_min||5);

    const r = await query(`
      INSERT INTO medialoop_senha (empresa_id, servico_id, numero, nome_cliente, prioridade_vip, estado, espera_estimada_min, posicao_fila)
      VALUES ($1,$2,$3,$4,$5,'aguarda',$6,$7) RETURNING *
    `, [req.empresaId, servico_id, numero, nome_cliente||null, prioridade_vip||false,
        espera_estimada, parseInt(fila.rows[0].count)+1]);

    res.status(201).json({
      ...r.rows[0],
      servico: s,
      espera_estimada_min: espera_estimada,
      posicao_fila: parseInt(fila.rows[0].count)+1,
      mensagem: `Senha ${numero} emitida. Tempo de espera estimado: ${espera_estimada} minutos.`,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CHAMADA DE SENHAS (operador) ──

router.post('/chamar-proxima', async (req, res) => {
  try {
    const { balcao_id, servico_id } = req.body;

    const balcao = await query(`SELECT * FROM senha_balcao WHERE id=$1 AND empresa_id=$2`, [balcao_id, req.empresaId]);
    if (!balcao.rows.length) return res.status(404).json({ error: 'Balcão não encontrado' });

    // Fechar senha anterior se existir
    await query(`UPDATE medialoop_senha SET estado='atendida', atendida_em=NOW()
      WHERE empresa_id=$1 AND balcao_id=$2 AND estado='em_atendimento'`,
      [req.empresaId, balcao_id]);

    // Buscar próxima senha (VIP primeiro, depois por ordem)
    const proxima = await query(`
      SELECT s.*, sv.nome as servico_nome, sv.cor, sv.prefixo
      FROM medialoop_senha s
      JOIN senha_servico sv ON sv.id=s.servico_id
      WHERE s.empresa_id=$1 AND s.estado='aguarda'
        AND ($2::uuid IS NULL OR s.servico_id=$2)
      ORDER BY s.prioridade_vip DESC, s.criado_em ASC
      LIMIT 1
    `, [req.empresaId, servico_id||null]);

    if (!proxima.rows.length) return res.json({ mensagem: 'Sem senhas em espera', senha: null });

    const senha = proxima.rows[0];
    await query(`UPDATE medialoop_senha SET estado='chamada', balcao_id=$1, balcao_numero=$2, chamada_em=NOW()
      WHERE id=$3`, [balcao_id, balcao.rows[0].numero, senha.id]);

    // Notificar ecrãs via websocket/polling
    await query(`INSERT INTO medialoop_aviso (empresa_id, titulo, mensagem, prioridade, data_fim, tipo)
      VALUES ($1,$2,$3,'urgente',NOW()+INTERVAL '2 minutes','senha')`,
      [req.empresaId, `Senha ${senha.numero}`, `Balcão ${balcao.rows[0].numero}`]).catch(()=>{});

    res.json({
      ok: true,
      senha: { ...senha, estado:'chamada', balcao_numero: balcao.rows[0].numero },
      mensagem: `Senha ${senha.numero} chamada para Balcão ${balcao.rows[0].numero}`,
      anuncio_voz: `Senha ${senha.numero.split('').join(' ')}, balcão ${balcao.rows[0].numero}`,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Chamar senha específica (re-chamar)
router.post('/rechamar/:senhaId', async (req, res) => {
  try {
    const senha = await query(`SELECT s.*, b.numero as balcao_numero FROM medialoop_senha s
      LEFT JOIN senha_balcao b ON b.id=s.balcao_id
      WHERE s.id=$1 AND s.empresa_id=$2`, [req.params.senhaId, req.empresaId]);
    if (!senha.rows.length) return res.status(404).json({ error: 'Senha não encontrada' });

    await query(`UPDATE medialoop_senha SET chamada_em=NOW(), num_chamadas=num_chamadas+1 WHERE id=$1`, [req.params.senhaId]);

    res.json({
      ok: true,
      senha: senha.rows[0],
      anuncio_voz: `Senha ${senha.rows[0].numero.split('').join(' ')}, balcão ${senha.rows[0].balcao_numero}`,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Iniciar atendimento
router.post('/iniciar/:senhaId', async (req, res) => {
  try {
    await query(`UPDATE medialoop_senha SET estado='em_atendimento', atendimento_inicio=NOW() WHERE id=$1 AND empresa_id=$2`,
      [req.params.senhaId, req.empresaId]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Concluir atendimento
router.post('/concluir/:senhaId', async (req, res) => {
  try {
    const { notas, resultado } = req.body;
    await query(`UPDATE medialoop_senha SET estado='atendida', atendida_em=NOW(), notas=$1, resultado=$2 WHERE id=$3 AND empresa_id=$4`,
      [notas||'', resultado||'concluido', req.params.senhaId, req.empresaId]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Desistência
router.post('/desistir/:senhaId', async (req, res) => {
  try {
    await query(`UPDATE medialoop_senha SET estado='desistiu' WHERE id=$1 AND empresa_id=$2`,
      [req.params.senhaId, req.empresaId]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ESTADO DA FILA (tempo real) ──

router.get('/fila', async (req, res) => {
  try {
    const { servico_id } = req.query;
    const cond = servico_id ? 'AND s.servico_id=$2' : '';
    const params = servico_id ? [req.empresaId, servico_id] : [req.empresaId];

    const [fila, chamadas, balcoes, stats] = await Promise.all([
      query(`SELECT s.*, sv.nome as servico_nome, sv.cor, sv.prefixo
        FROM medialoop_senha s JOIN senha_servico sv ON sv.id=s.servico_id
        WHERE s.empresa_id=$1 AND s.estado='aguarda' ${cond}
        ORDER BY s.prioridade_vip DESC, s.criado_em ASC`, params),
      query(`SELECT s.*, sv.nome as servico_nome, sv.cor, b.numero as balcao_numero
        FROM medialoop_senha s JOIN senha_servico sv ON sv.id=s.servico_id
        LEFT JOIN senha_balcao b ON b.id=s.balcao_id
        WHERE s.empresa_id=$1 AND s.estado IN ('chamada','em_atendimento') ${cond}
        ORDER BY s.chamada_em DESC LIMIT 5`, params),
      query(`SELECT b.*, s.nome as servico_nome, u.nome_completo as operador_nome,
        (SELECT numero FROM medialoop_senha WHERE balcao_id=b.id AND estado='em_atendimento' LIMIT 1) as senha_actual
        FROM senha_balcao b LEFT JOIN senha_servico s ON s.id=b.servico_id
        LEFT JOIN utilizador u ON u.id=b.operador_id
        WHERE b.empresa_id=$1 ${servico_id?'AND b.servico_id=$2':''}
        ORDER BY b.numero`, params),
      query(`SELECT
        COUNT(*) FILTER (WHERE estado='aguarda') as aguarda,
        COUNT(*) FILTER (WHERE estado IN ('chamada','em_atendimento')) as em_atendimento,
        COUNT(*) FILTER (WHERE estado='atendida' AND DATE(atendida_em)=CURRENT_DATE) as atendidas_hoje,
        COUNT(*) FILTER (WHERE estado='desistiu' AND DATE(criado_em)=CURRENT_DATE) as desistencias_hoje,
        ROUND(AVG(EXTRACT(EPOCH FROM (atendimento_inicio-criado_em))/60) FILTER (WHERE estado='atendida' AND DATE(atendida_em)=CURRENT_DATE),1) as tempo_espera_medio,
        ROUND(AVG(EXTRACT(EPOCH FROM (atendida_em-atendimento_inicio))/60) FILTER (WHERE estado='atendida' AND DATE(atendida_em)=CURRENT_DATE),1) as tempo_atendimento_medio
        FROM medialoop_senha WHERE empresa_id=$1 ${cond}`, params),
    ]);

    res.json({
      fila: fila.rows,
      chamadas_activas: chamadas.rows,
      balcoes: balcoes.rows,
      stats: stats.rows[0],
      timestamp: new Date().toISOString(),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PAINEL PÚBLICO (sem auth — para TVs) ──
router.get('/painel-publico/:empresaId', async (req, res) => {
  try {
    const [chamadas, stats] = await Promise.all([
      query(`SELECT s.numero, s.estado, s.prioridade_vip, sv.nome as servico_nome, sv.cor,
        b.numero as balcao_numero, s.chamada_em
        FROM medialoop_senha s JOIN senha_servico sv ON sv.id=s.servico_id
        LEFT JOIN senha_balcao b ON b.id=s.balcao_id
        WHERE s.empresa_id=$1 AND s.estado IN ('chamada','em_atendimento')
        ORDER BY s.chamada_em DESC LIMIT 6`, [req.params.empresaId]),
      query(`SELECT COUNT(*) as aguarda FROM medialoop_senha WHERE empresa_id=$1 AND estado='aguarda'`, [req.params.empresaId]),
    ]);

    res.json({ chamadas: chamadas.rows, aguarda: stats.rows[0]?.aguarda||0, timestamp: new Date().toISOString() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ANALYTICS ──

router.get('/analytics', async (req, res) => {
  try {
    const { data } = req.query;
    const dia = data || new Date().toISOString().slice(0,10);

    const [resumo, porServico, porHora, porBalcao] = await Promise.all([
      query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE estado='atendida') as atendidas,
        COUNT(*) FILTER (WHERE estado='desistiu') as desistencias,
        ROUND(AVG(EXTRACT(EPOCH FROM (atendimento_inicio-criado_em))/60) FILTER (WHERE estado='atendida'),1) as tempo_espera_medio,
        ROUND(AVG(EXTRACT(EPOCH FROM (atendida_em-atendimento_inicio))/60) FILTER (WHERE estado='atendida'),1) as tempo_atendimento_medio,
        MAX(EXTRACT(EPOCH FROM (atendimento_inicio-criado_em))/60) FILTER (WHERE estado='atendida') as tempo_espera_max
        FROM medialoop_senha WHERE empresa_id=$1 AND DATE(criado_em)=$2`, [req.empresaId, dia]),
      query(`SELECT sv.nome, sv.cor, sv.prefixo, COUNT(*) as total,
        ROUND(AVG(EXTRACT(EPOCH FROM (atendimento_inicio-criado_em))/60) FILTER (WHERE s.estado='atendida'),1) as tempo_espera_medio
        FROM medialoop_senha s JOIN senha_servico sv ON sv.id=s.servico_id
        WHERE s.empresa_id=$1 AND DATE(s.criado_em)=$2
        GROUP BY sv.id,sv.nome,sv.cor,sv.prefixo ORDER BY total DESC`, [req.empresaId, dia]),
      query(`SELECT EXTRACT(HOUR FROM criado_em) as hora, COUNT(*) as total
        FROM medialoop_senha WHERE empresa_id=$1 AND DATE(criado_em)=$2
        GROUP BY hora ORDER BY hora`, [req.empresaId, dia]),
      query(`SELECT b.numero, b.nome, COUNT(s.id) as total_atendimentos,
        ROUND(AVG(EXTRACT(EPOCH FROM (s.atendida_em-s.atendimento_inicio))/60) FILTER (WHERE s.estado='atendida'),1) as tempo_medio
        FROM senha_balcao b LEFT JOIN medialoop_senha s ON s.balcao_id=b.id AND DATE(s.criado_em)=$2
        WHERE b.empresa_id=$1 GROUP BY b.id,b.numero,b.nome ORDER BY b.numero`, [req.empresaId, dia]),
    ]);

    res.json({ data: dia, resumo: resumo.rows[0], por_servico: porServico.rows, por_hora: porHora.rows, por_balcao: porBalcao.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
