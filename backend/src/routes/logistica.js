'use strict';
/**
 * NexEdge — Módulo de Logística Premium
 * Gestão completa: encomendas, recolhas, entregas, tracking, POD
 * Multi-país: CH, PT, FR, DE, ES
 * Supera: Onfleet, Route4Me, GetSwift, Bringg
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const Anthropic = require('@anthropic-ai/sdk');
const crypto = require('crypto');

router.use(autenticar);
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

// ── PAÍSES SUPORTADOS ──
const PAISES = {
  CH: { nome:'Suíça', moeda:'CHF', idioma:'de', timezone:'Europe/Zurich', prefixo:'+41', formato_cp:/^\d{4}$/ },
  PT: { nome:'Portugal', moeda:'EUR', idioma:'pt', timezone:'Europe/Lisbon', prefixo:'+351', formato_cp:/^\d{4}-\d{3}$/ },
  FR: { nome:'França', moeda:'EUR', idioma:'fr', timezone:'Europe/Paris', prefixo:'+33', formato_cp:/^\d{5}$/ },
  DE: { nome:'Alemanha', moeda:'EUR', idioma:'de', timezone:'Europe/Berlin', prefixo:'+49', formato_cp:/^\d{5}$/ },
  ES: { nome:'Espanha', moeda:'EUR', idioma:'es', timezone:'Europe/Madrid', prefixo:'+34', formato_cp:/^\d{5}$/ },
};

// ── GERAR NÚMERO ENCOMENDA ──
async function gerarNumeroEncomenda(empresaId) {
  const ano = new Date().getFullYear();
  const r = await query(`SELECT COUNT(*) FROM logistica_encomenda WHERE empresa_id=$1 AND EXTRACT(YEAR FROM criado_em)=$2`, [empresaId, ano]);
  const seq = (parseInt(r.rows[0].count)+1).toString().padStart(6,'0');
  return `ORD-${ano}-${seq}`;
}

// ── DASHBOARD OPERACIONAL ──
router.get('/dashboard', async (req, res) => {
  try {
    const [kpis, urgentes, motoristas, porEstado, hoje] = await Promise.all([
      query(`SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE estado='nova') as novas,
        COUNT(*) FILTER (WHERE estado='em_preparacao') as em_preparacao,
        COUNT(*) FILTER (WHERE estado='em_transito') as em_transito,
        COUNT(*) FILTER (WHERE estado='entregue' AND DATE(actualizado_em)=CURRENT_DATE) as entregues_hoje,
        COUNT(*) FILTER (WHERE estado='problema') as problemas,
        COUNT(*) FILTER (WHERE estado NOT IN ('entregue','cancelada') AND data_entrega_prevista < NOW()) as atrasadas
        FROM logistica_encomenda WHERE empresa_id=$1`, [req.empresaId]),
      query(`SELECT e.numero, e.estado, e.destinatario_nome, e.destinatario_morada,
        e.data_entrega_prevista, m.nome as motorista_nome
        FROM logistica_encomenda e LEFT JOIN logistica_motorista m ON m.id=e.motorista_id
        WHERE e.empresa_id=$1 AND e.estado='problema'
        ORDER BY e.criado_em DESC LIMIT 10`, [req.empresaId]),
      query(`SELECT m.*, v.matricula, v.capacidade_kg,
        COUNT(e.id) FILTER (WHERE e.estado='em_transito') as entregas_activas
        FROM logistica_motorista m
        LEFT JOIN logistica_veiculo v ON v.id=m.veiculo_id
        LEFT JOIN logistica_encomenda e ON e.motorista_id=m.id
        WHERE m.empresa_id=$1 AND m.estado='disponivel'
        GROUP BY m.id, v.matricula, v.capacidade_kg`, [req.empresaId]).catch(()=>({rows:[]})),
      query(`SELECT estado, COUNT(*) as total FROM logistica_encomenda
        WHERE empresa_id=$1 GROUP BY estado ORDER BY total DESC`, [req.empresaId]),
      query(`SELECT
        COUNT(*) FILTER (WHERE DATE(criado_em)=CURRENT_DATE) as criadas_hoje,
        COUNT(*) FILTER (WHERE estado='entregue' AND DATE(actualizado_em)=CURRENT_DATE) as entregues_hoje,
        ROUND(AVG(EXTRACT(EPOCH FROM (actualizado_em-criado_em))/3600) FILTER (WHERE estado='entregue' AND DATE(actualizado_em)=CURRENT_DATE),1) as tempo_medio_entrega_h
        FROM logistica_encomenda WHERE empresa_id=$1`, [req.empresaId]),
    ]);

    res.json({
      kpis: kpis.rows[0],
      urgentes: urgentes.rows,
      motoristas_disponiveis: motoristas.rows,
      por_estado: porEstado.rows,
      hoje: hoje.rows[0],
      paises: PAISES,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ENCOMENDAS ──
router.get('/encomendas', async (req, res) => {
  try {
    const { estado, motorista_id, data_inicio, data_fim, pais, search } = req.query;
    const conds = ['e.empresa_id=$1'], params = [req.empresaId];
    let n = 2;
    if (estado) { conds.push(`e.estado=$${n++}`); params.push(estado); }
    if (motorista_id) { conds.push(`e.motorista_id=$${n++}`); params.push(motorista_id); }
    if (data_inicio) { conds.push(`e.data_entrega_prevista>=$${n++}`); params.push(data_inicio); }
    if (data_fim) { conds.push(`e.data_entrega_prevista<=$${n++}`); params.push(data_fim); }
    if (pais) { conds.push(`e.destinatario_pais=$${n++}`); params.push(pais); }
    if (search) { conds.push(`(e.numero ILIKE $${n} OR e.destinatario_nome ILIKE $${n} OR e.destinatario_email ILIKE $${n})`); params.push(`%${search}%`); n++; }

    const r = await query(`
      SELECT e.*,
        m.nome as motorista_nome, m.telefone as motorista_tel,
        v.matricula,
        c.nome as cliente_nome,
        EXTRACT(EPOCH FROM (NOW()-e.criado_em))/3600 as horas_em_sistema,
        CASE WHEN e.data_entrega_prevista < NOW() AND e.estado NOT IN ('entregue','cancelada')
          THEN EXTRACT(DAY FROM NOW()-e.data_entrega_prevista) ELSE NULL END as dias_atraso
      FROM logistica_encomenda e
      LEFT JOIN logistica_motorista m ON m.id=e.motorista_id
      LEFT JOIN logistica_veiculo v ON v.id=m.veiculo_id
      LEFT JOIN cliente c ON c.id=e.cliente_id
      WHERE ${conds.join(' AND ')}
      ORDER BY e.criado_em DESC LIMIT 200
    `, params);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/encomendas', async (req, res) => {
  try {
    const d = req.body;
    const numero = await gerarNumeroEncomenda(req.empresaId);
    const pais = d.destinatario_pais || 'PT';
    const paisConfig = PAISES[pais] || PAISES.PT;

    const r = await query(`
      INSERT INTO logistica_encomenda (
        empresa_id, numero, cliente_id, origem,
        remetente_nome, remetente_morada, remetente_pais, remetente_telefone,
        destinatario_nome, destinatario_morada, destinatario_codigo_postal,
        destinatario_localidade, destinatario_pais, destinatario_telefone, destinatario_email,
        peso_kg, volume_m3, num_volumes, instrucoes_especiais,
        prioridade, valor_mercadoria, moeda,
        data_recolha_prevista, data_entrega_prevista,
        estado, workflow_config, campos_extra
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,'nova',$25,$26)
      RETURNING *
    `, [
      req.empresaId, numero, d.cliente_id||null, d.origem||'manual',
      d.remetente_nome||'', d.remetente_morada||'', d.remetente_pais||'PT', d.remetente_telefone||'',
      d.destinatario_nome, d.destinatario_morada, d.destinatario_codigo_postal||'',
      d.destinatario_localidade||'', pais, d.destinatario_telefone||'', d.destinatario_email||'',
      d.peso_kg||0, d.volume_m3||0, d.num_volumes||1, d.instrucoes_especiais||'',
      d.prioridade||'normal', d.valor_mercadoria||0, paisConfig.moeda,
      d.data_recolha_prevista||null, d.data_entrega_prevista||null,
      JSON.stringify(d.workflow_config||defaultWorkflow()),
      JSON.stringify(d.campos_extra||{})
    ]);

    const encomenda = r.rows[0];

    // Registo histórico
    await registarHistorico(encomenda.id, req.empresaId, 'nova', 'Encomenda criada', req.utilizador.id);

    // Notificar destinatário
    if (encomenda.destinatario_email) {
      notificarDestinatario(encomenda, 'confirmacao').catch(()=>{});
    }

    res.status(201).json(encomenda);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Mudar estado da encomenda (com validação de workflow)
router.put('/encomendas/:id/estado', async (req, res) => {
  try {
    const { estado, notas, latitude, longitude } = req.body;
    const enc = await query(`SELECT * FROM logistica_encomenda WHERE id=$1 AND empresa_id=$2`, [req.params.id, req.empresaId]);
    if (!enc.rows.length) return res.status(404).json({ error: 'Encomenda não encontrada' });
    const e = enc.rows[0];

    // Validar transição de estado
    const transicoes = getTransicoesPermitidas(e.estado);
    if (!transicoes.includes(estado)) {
      return res.status(400).json({ error: `Transição inválida: ${e.estado} → ${estado}`, permitidas: transicoes });
    }

    await query(`UPDATE logistica_encomenda SET estado=$1, actualizado_em=NOW(),
      ${estado==='entregue'?'data_entrega_real=NOW(),':''} ${notas?'notas_operador=$3,':''}
      ${latitude?`latitude_ultima_pos=${latitude}, longitude_ultima_pos=${longitude},`:''}
      estado_anterior=$2 WHERE id=$4`,
      [estado, e.estado, notas||e.notas_operador, req.params.id].filter((_,i)=>notas||i!==2));

    await registarHistorico(req.params.id, req.empresaId, estado, notas||`Estado alterado para ${estado}`, req.utilizador.id, latitude, longitude);

    // Notificações automáticas por estado
    if (['em_transito','em_entrega','entregue','problema'].includes(estado)) {
      notificarDestinatario(e, estado).catch(()=>{});
    }

    // Disparar webhook
    const { dispararWebhook } = require('./webhooks');
    await dispararWebhook(req.empresaId, `encomenda.${estado}`, { numero: e.numero, estado, destinatario: e.destinatario_nome }).catch(()=>{});

    const updated = await query(`SELECT * FROM logistica_encomenda WHERE id=$1`, [req.params.id]);
    res.json(updated.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Atribuir motorista
router.put('/encomendas/:id/atribuir', async (req, res) => {
  try {
    const { motorista_id } = req.body;
    await query(`UPDATE logistica_encomenda SET motorista_id=$1, actualizado_em=NOW() WHERE id=$2 AND empresa_id=$3`,
      [motorista_id, req.params.id, req.empresaId]);
    await registarHistorico(req.params.id, req.empresaId, null, `Motorista atribuído`, req.utilizador.id);
    const r = await query(`SELECT e.*, m.nome as motorista_nome FROM logistica_encomenda e LEFT JOIN logistica_motorista m ON m.id=e.motorista_id WHERE e.id=$1`, [req.params.id]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Detalhe com histórico completo
router.get('/encomendas/:id', async (req, res) => {
  try {
    const [enc, historico, pod] = await Promise.all([
      query(`SELECT e.*, m.nome as motorista_nome, m.telefone as motorista_tel, v.matricula
        FROM logistica_encomenda e
        LEFT JOIN logistica_motorista m ON m.id=e.motorista_id
        LEFT JOIN logistica_veiculo v ON v.id=m.veiculo_id
        WHERE e.id=$1 AND e.empresa_id=$2`, [req.params.id, req.empresaId]),
      query(`SELECT h.*, u.nome_completo as operador_nome FROM logistica_historico h
        LEFT JOIN utilizador u ON u.id=h.utilizador_id
        WHERE h.encomenda_id=$1 ORDER BY h.criado_em ASC`, [req.params.id]),
      query(`SELECT * FROM logistica_pod WHERE encomenda_id=$1 LIMIT 1`, [req.params.id]),
    ]);
    if (!enc.rows.length) return res.status(404).json({ error: 'Não encontrado' });
    res.json({ ...enc.rows[0], historico: historico.rows, pod: pod.rows[0]||null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── TRACKING PÚBLICO (sem auth) ──
router.get('/tracking/:numero', async (req, res) => {
  try {
    const r = await query(`
      SELECT e.numero, e.estado, e.estado_anterior,
        e.destinatario_nome, e.destinatario_localidade, e.destinatario_pais,
        e.data_recolha_prevista, e.data_entrega_prevista, e.data_entrega_real,
        e.latitude_ultima_pos, e.longitude_ultima_pos,
        m.nome as motorista_nome, m.telefone as motorista_tel,
        v.matricula
      FROM logistica_encomenda e
      LEFT JOIN logistica_motorista m ON m.id=e.motorista_id
      LEFT JOIN logistica_veiculo v ON v.id=m.veiculo_id
      WHERE e.numero=$1
    `, [req.params.numero]);
    if (!r.rows.length) return res.status(404).json({ error: 'Encomenda não encontrada' });

    const historico = await query(`SELECT estado, notas, criado_em, latitude, longitude FROM logistica_historico WHERE encomenda_id=(SELECT id FROM logistica_encomenda WHERE numero=$1) ORDER BY criado_em ASC`, [req.params.numero]);

    res.json({ ...r.rows[0], historico: historico.rows, paises: PAISES });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── RECOLHAS ──
router.get('/recolhas', async (req, res) => {
  try {
    const { data, estado } = req.query;
    const conds = ['r.empresa_id=$1'], params = [req.empresaId];
    let n = 2;
    if (data) { conds.push(`DATE(r.data_recolha)=$${n++}`); params.push(data); }
    if (estado) { conds.push(`r.estado=$${n++}`); params.push(estado); }

    const r = await query(`
      SELECT r.*, m.nome as motorista_nome, v.matricula,
        COUNT(e.id) as num_encomendas
      FROM logistica_recolha r
      LEFT JOIN logistica_motorista m ON m.id=r.motorista_id
      LEFT JOIN logistica_veiculo v ON v.id=m.veiculo_id
      LEFT JOIN logistica_encomenda e ON e.recolha_id=r.id
      WHERE ${conds.join(' AND ')}
      GROUP BY r.id, m.nome, v.matricula
      ORDER BY r.data_recolha ASC
    `, params).catch(()=>({rows:[]}));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/recolhas', async (req, res) => {
  try {
    const d = req.body;
    const r = await query(`
      INSERT INTO logistica_recolha (empresa_id, cliente_id, morada_recolha, contacto_nome, contacto_telefone,
        data_recolha, janela_inicio, janela_fim, motorista_id, veiculo_id,
        num_volumes_estimado, peso_estimado_kg, instrucoes, prioridade, estado)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'agendada') RETURNING *
    `, [req.empresaId, d.cliente_id||null, d.morada_recolha, d.contacto_nome||'',
        d.contacto_telefone||'', d.data_recolha, d.janela_inicio||'09:00', d.janela_fim||'18:00',
        d.motorista_id||null, d.veiculo_id||null, d.num_volumes_estimado||1,
        d.peso_estimado_kg||0, d.instrucoes||'', d.prioridade||'normal']);
    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── MOTORISTAS ──
router.get('/motoristas', async (req, res) => {
  try {
    const r = await query(`
      SELECT m.*, v.matricula, v.modelo, v.capacidade_kg, v.capacidade_m3,
        COUNT(e.id) FILTER (WHERE e.estado IN ('em_transito','em_entrega')) as entregas_activas,
        COUNT(e.id) FILTER (WHERE e.estado='entregue' AND DATE(e.actualizado_em)=CURRENT_DATE) as entregas_hoje,
        ROUND(COUNT(e.id) FILTER (WHERE e.estado='entregue' AND e.data_entrega_real <= e.data_entrega_prevista)::numeric /
          NULLIF(COUNT(e.id) FILTER (WHERE e.estado='entregue'),0) * 100, 1) as taxa_prazo
      FROM logistica_motorista m
      LEFT JOIN logistica_veiculo v ON v.id=m.veiculo_id
      LEFT JOIN logistica_encomenda e ON e.motorista_id=m.id
      WHERE m.empresa_id=$1
      GROUP BY m.id, v.matricula, v.modelo, v.capacidade_kg, v.capacidade_m3
      ORDER BY m.nome
    `, [req.empresaId]).catch(()=>({rows:[]}));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/motoristas', async (req, res) => {
  try {
    const { nome, email, telefone, licenca, pais, veiculo_id, estado } = req.body;
    const r = await query(`
      INSERT INTO logistica_motorista (empresa_id, nome, email, telefone, licenca, pais, veiculo_id, estado)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
    `, [req.empresaId, nome, email||'', telefone||'', licenca||'', pais||'PT', veiculo_id||null, estado||'disponivel']);
    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── VEÍCULOS ──
router.get('/veiculos', async (req, res) => {
  try {
    const r = await query(`SELECT v.*, m.nome as motorista_nome FROM logistica_veiculo v
      LEFT JOIN logistica_motorista m ON m.veiculo_id=v.id
      WHERE v.empresa_id=$1 ORDER BY v.matricula`, [req.empresaId]).catch(()=>({rows:[]}));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/veiculos', async (req, res) => {
  try {
    const { matricula, modelo, tipo, capacidade_kg, capacidade_m3, pais } = req.body;
    const r = await query(`
      INSERT INTO logistica_veiculo (empresa_id, matricula, modelo, tipo, capacidade_kg, capacidade_m3, pais, estado)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'disponivel') RETURNING *
    `, [req.empresaId, matricula, modelo||'', tipo||'furgao', capacidade_kg||1000, capacidade_m3||10, pais||'PT']);
    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ROTAS ──
router.get('/rotas', async (req, res) => {
  try {
    const { data, motorista_id } = req.query;
    const conds = ['r.empresa_id=$1'], params = [req.empresaId];
    let n = 2;
    if (data) { conds.push(`DATE(r.data_rota)=$${n++}`); params.push(data); }
    if (motorista_id) { conds.push(`r.motorista_id=$${n++}`); params.push(motorista_id); }

    const r = await query(`
      SELECT r.*, m.nome as motorista_nome, v.matricula,
        COUNT(p.id) as num_paragens,
        COUNT(p.id) FILTER (WHERE p.estado='entregue') as entregues
      FROM logistica_rota r
      LEFT JOIN logistica_motorista m ON m.id=r.motorista_id
      LEFT JOIN logistica_veiculo v ON v.id=m.veiculo_id
      LEFT JOIN logistica_paragem p ON p.rota_id=r.id
      WHERE ${conds.join(' AND ')}
      GROUP BY r.id, m.nome, v.matricula
      ORDER BY r.data_rota DESC
    `, params).catch(()=>({rows:[]}));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/rotas', async (req, res) => {
  try {
    const { motorista_id, data_rota, encomendas_ids, nome } = req.body;
    if (!motorista_id || !encomendas_ids?.length) return res.status(400).json({ error: 'Motorista e encomendas obrigatórios' });

    const r = await query(`
      INSERT INTO logistica_rota (empresa_id, motorista_id, nome, data_rota, estado, num_paragens)
      VALUES ($1,$2,$3,$4,'planeada',$5) RETURNING *
    `, [req.empresaId, motorista_id, nome||`Rota ${new Date().toLocaleDateString('pt-PT')}`, data_rota||new Date().toISOString().slice(0,10), encomendas_ids.length]);

    const rota = r.rows[0];

    // Criar paragens
    for (let i = 0; i < encomendas_ids.length; i++) {
      await query(`INSERT INTO logistica_paragem (rota_id, empresa_id, encomenda_id, ordem, estado)
        VALUES ($1,$2,$3,$4,'pendente')`,
        [rota.id, req.empresaId, encomendas_ids[i], i+1]);
      await query(`UPDATE logistica_encomenda SET rota_id=$1, estado='confirmada' WHERE id=$2`, [rota.id, encomendas_ids[i]]);
    }

    // Optimizar ordem com IA
    if (anthropic) optimizarRota(rota.id, req.empresaId).catch(()=>{});

    const rotaCompleta = await query(`SELECT r.*, m.nome as motorista_nome FROM logistica_rota r LEFT JOIN logistica_motorista m ON m.id=r.motorista_id WHERE r.id=$1`, [rota.id]);
    res.status(201).json(rotaCompleta.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── OPTIMIZAÇÃO DE ROTA COM IA ──
async function optimizarRota(rotaId, empresaId) {
  if (!anthropic) return;
  try {
    const paragens = await query(`
      SELECT p.*, e.destinatario_morada, e.destinatario_localidade, e.destinatario_codigo_postal,
        e.destinatario_pais, e.peso_kg, e.data_entrega_prevista, e.prioridade
      FROM logistica_paragem p JOIN logistica_encomenda e ON e.id=p.encomenda_id
      WHERE p.rota_id=$1 ORDER BY p.ordem
    `, [rotaId]);

    if (paragens.rows.length < 2) return;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 1000,
      messages: [{role:'user', content:`Optimiza a ordem de entrega destas paragens para minimizar a distância total.
Considera: código postal, prioridade e hora limite de entrega.

Paragens: ${JSON.stringify(paragens.rows.map((p,i)=>({
  ordem_actual: i+1,
  id: p.id,
  morada: p.destinatario_morada,
  localidade: p.destinatario_localidade,
  cp: p.destinatario_codigo_postal,
  pais: p.destinatario_pais,
  peso: p.peso_kg,
  prioridade: p.prioridade,
  prazo: p.data_entrega_prevista
})))}

Responde APENAS com JSON: {"ordem": [{"id":"uuid","nova_ordem":1}, ...], "distancia_estimada_km": 45, "tempo_estimado_min": 90}`}]
    });

    const texto = response.content[0]?.text;
    const json = JSON.parse(texto.match(/\{.*\}/s)?.[0]||'{}');

    if (json.ordem?.length) {
      for (const p of json.ordem) {
        await query(`UPDATE logistica_paragem SET ordem=$1 WHERE id=$2`, [p.nova_ordem, p.id]);
      }
      await query(`UPDATE logistica_rota SET distancia_estimada_km=$1, tempo_estimado_min=$2, optimizada_ia=true WHERE id=$3`,
        [json.distancia_estimada_km||0, json.tempo_estimado_min||0, rotaId]);
    }
  } catch(e) { console.error('[Logística] Erro optimização IA:', e.message); }
}

// ── POD (PROVA DE ENTREGA) ──
router.post('/encomendas/:id/pod', async (req, res) => {
  try {
    const { assinatura_base64, foto_base64, recebido_por, latitude, longitude, observacoes } = req.body;
    if (!recebido_por) return res.status(400).json({ error: 'Nome de quem recebeu obrigatório' });

    // Hash da prova de entrega para auditoria
    const hash = crypto.createHash('sha256')
      .update(`${req.params.id}|${recebido_por}|${new Date().toISOString()}|${assinatura_base64||''}`)
      .digest('hex');

    const r = await query(`
      INSERT INTO logistica_pod (encomenda_id, empresa_id, recebido_por, assinatura_base64,
        foto_base64, latitude, longitude, observacoes, hash_verificacao, criado_em)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
      ON CONFLICT (encomenda_id) DO UPDATE SET
        recebido_por=$3, assinatura_base64=$4, foto_base64=$5,
        latitude=$6, longitude=$7, observacoes=$8, hash_verificacao=$9
      RETURNING *
    `, [req.params.id, req.empresaId, recebido_por, assinatura_base64||null,
        foto_base64||null, latitude||null, longitude||null, observacoes||'', hash]);

    // Marcar como entregue
    await query(`UPDATE logistica_encomenda SET estado='entregue', data_entrega_real=NOW() WHERE id=$1`, [req.params.id]);
    await registarHistorico(req.params.id, req.empresaId, 'entregue',
      `Entregue a ${recebido_por}. POD registada.`, req.utilizador.id, latitude, longitude);

    // Notificar remetente e destinatário
    const enc = await query(`SELECT * FROM logistica_encomenda WHERE id=$1`, [req.params.id]);
    if (enc.rows.length) notificarDestinatario(enc.rows[0], 'entregue').catch(()=>{});

    // Faturação automática (se configurado)
    if (req.body.faturar_automatico) {
      faturarEntrega(req.params.id, req.empresaId).catch(()=>{});
    }

    res.status(201).json({ pod: r.rows[0], hash_verificacao: hash });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Verificar autenticidade do POD
router.get('/pod/verificar/:hash', async (req, res) => {
  try {
    const r = await query(`SELECT p.*, e.numero, e.destinatario_nome FROM logistica_pod p
      JOIN logistica_encomenda e ON e.id=p.encomenda_id WHERE p.hash_verificacao=$1`, [req.params.hash]);
    res.json({ valido: r.rows.length > 0, pod: r.rows[0]||null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ANALYTICS ──
router.get('/analytics', async (req, res) => {
  try {
    const { periodo = 30 } = req.query;
    const [desempenho, porPais, porMotorista, tempos] = await Promise.all([
      query(`SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE estado='entregue') as entregues,
        COUNT(*) FILTER (WHERE estado='entregue' AND data_entrega_real <= data_entrega_prevista) as no_prazo,
        COUNT(*) FILTER (WHERE estado='problema') as problemas,
        ROUND(AVG(EXTRACT(EPOCH FROM (data_entrega_real-criado_em))/3600) FILTER (WHERE estado='entregue'),1) as tempo_medio_h
        FROM logistica_encomenda WHERE empresa_id=$1 AND criado_em > NOW()-($2::int * INTERVAL '1 day')`, [req.empresaId, periodo]),
      query(`SELECT destinatario_pais as pais, COUNT(*) as total,
        COUNT(*) FILTER (WHERE estado='entregue') as entregues
        FROM logistica_encomenda WHERE empresa_id=$1 AND criado_em > NOW()-($2::int * INTERVAL '1 day')
        GROUP BY destinatario_pais ORDER BY total DESC`, [req.empresaId, periodo]),
      query(`SELECT m.nome, COUNT(e.id) as total,
        COUNT(e.id) FILTER (WHERE e.estado='entregue') as entregues,
        ROUND(COUNT(e.id) FILTER (WHERE e.estado='entregue' AND e.data_entrega_real <= e.data_entrega_prevista)::numeric /
          NULLIF(COUNT(e.id) FILTER (WHERE e.estado='entregue'),0)*100,1) as taxa_prazo
        FROM logistica_encomenda e JOIN logistica_motorista m ON m.id=e.motorista_id
        WHERE e.empresa_id=$1 AND e.criado_em > NOW()-($2::int * INTERVAL '1 day')
        GROUP BY m.id, m.nome ORDER BY total DESC LIMIT 10`, [req.empresaId, periodo]),
      query(`SELECT TO_CHAR(criado_em,'YYYY-MM-DD') as dia, COUNT(*) as criadas,
        COUNT(*) FILTER (WHERE estado='entregue') as entregues
        FROM logistica_encomenda WHERE empresa_id=$1 AND criado_em > NOW()-($2::int * INTERVAL '1 day')
        GROUP BY dia ORDER BY dia`, [req.empresaId, periodo]),
    ]);

    const d = desempenho.rows[0];
    res.json({
      periodo_dias: periodo,
      kpis: {
        ...d,
        taxa_entrega: d.total ? (d.entregues/d.total*100).toFixed(1) : 0,
        taxa_prazo: d.entregues ? (d.no_prazo/d.entregues*100).toFixed(1) : 0,
      },
      por_pais: porPais.rows.map(p => ({ ...p, nome: PAISES[p.pais]?.nome||p.pais })),
      por_motorista: porMotorista.rows,
      evolucao_diaria: tempos.rows,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── FATURAÇÃO AUTOMÁTICA PÓS-ENTREGA ──
async function faturarEntrega(encomendaId, empresaId) {
  try {
    const enc = await query(`SELECT e.*, c.id as cliente_id_fatura FROM logistica_encomenda e
      LEFT JOIN cliente c ON c.id=e.cliente_id WHERE e.id=$1`, [encomendaId]);
    if (!enc.rows.length || !enc.rows[0].cliente_id_fatura) return;

    const e = enc.rows[0];
    const valorFrete = calcularFrete(e);

    const ano = new Date().getFullYear();
    const countR = await query(`SELECT COUNT(*) FROM fatura WHERE empresa_id=$1 AND EXTRACT(YEAR FROM data_emissao)=$2`, [empresaId, ano]);
    const seq = (parseInt(countR.rows[0].count)+1).toString().padStart(6,'0');

    await query(`INSERT INTO fatura (empresa_id, numero, cliente_id, data_emissao, data_vencimento, total, estado, descricao, origem)
      VALUES ($1,$2,$3,NOW(),NOW()+INTERVAL '30 days',$4,'emitida',$5,'logistica')`,
      [empresaId, `FT${ano}/${seq}`, e.cliente_id_fatura, valorFrete,
       `Frete encomenda ${e.numero} — ${e.destinatario_localidade}, ${e.destinatario_pais}`]);
  } catch(err) { console.error('[Logística] Erro faturação:', err.message); }
}

function calcularFrete(enc) {
  const base = { PT:5, CH:25, FR:15, DE:18, ES:12 }[enc.destinatario_pais]||10;
  const pesoPaga = Math.max(enc.peso_kg||0, (enc.volume_m3||0)*250); // volume vs peso
  return base + pesoPaga * 0.5;
}

// ── HELPERS ──
function defaultWorkflow() {
  return {
    estados: ['nova','confirmada','em_preparacao','pronta_recolha','recolhida','em_transito','em_entrega','entregue'],
    transicoes: {
      nova: ['confirmada','cancelada'],
      confirmada: ['em_preparacao','cancelada'],
      em_preparacao: ['pronta_recolha'],
      pronta_recolha: ['recolhida'],
      recolhida: ['em_transito'],
      em_transito: ['em_entrega','problema'],
      em_entrega: ['entregue','problema'],
      problema: ['em_transito','em_entrega','cancelada'],
    }
  };
}

function getTransicoesPermitidas(estadoActual) {
  const wf = defaultWorkflow();
  return wf.transicoes[estadoActual] || [];
}

async function registarHistorico(encomendaId, empresaId, estado, notas, utilizadorId, lat, lon) {
  await query(`INSERT INTO logistica_historico (encomenda_id, empresa_id, estado, notas, utilizador_id, latitude, longitude)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [encomendaId, empresaId, estado||null, notas, utilizadorId||null, lat||null, lon||null]).catch(()=>{});
}

async function notificarDestinatario(enc, tipo) {
  try {
    const msgs = {
      confirmacao: `✅ Encomenda ${enc.numero} confirmada! Acompanha em: https://app.nexedge.pt/tracking/${enc.numero}`,
      em_transito: `🚚 A tua encomenda ${enc.numero} está a caminho! ETA: ${enc.data_entrega_prevista ? new Date(enc.data_entrega_prevista).toLocaleDateString('pt-PT') : 'hoje'}`,
      em_entrega: `📦 O motorista está a chegar com a tua encomenda ${enc.numero}!`,
      entregue: `✅ Encomenda ${enc.numero} entregue! Obrigado pela preferência.`,
      problema: `⚠️ Ocorreu um problema com a encomenda ${enc.numero}. Estamos a resolver. Contacte-nos se necessário.`,
    };

    const msg = msgs[tipo];
    if (!msg) return;

    if (enc.destinatario_email) {
      const { enviarEmail } = require('../services/emailService');
      await enviarEmail({
        to: enc.destinatario_email,
        subject: `${msg.slice(0,50)} — NexEdge Logística`,
        html: `<div style="font-family:Inter,sans-serif;max-width:600px"><p>${msg}</p>
          <a href="https://app.nexedge.pt/tracking/${enc.numero}" style="background:#4f46e5;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;display:inline-block;margin-top:12px">
            🔍 Ver estado da encomenda
          </a></div>`
      }).catch(()=>{});
    }

    if (enc.destinatario_telefone) {
      const { enviarWhatsApp } = require('./whatsapp');
      await enviarWhatsApp(enc.destinatario_telefone, msg).catch(()=>{});
    }
  } catch(e) {}
}

module.exports = router;
