'use strict';
/**
 * NexEdge — Aging de Recebimentos + Cobrança Automática
 * Análise de antiguidade de dívidas, sequências de cobrança automáticas
 * Supera: Sage, PHC, Primavera no módulo de cobranças
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { autenticar } = require('../middleware/auth');

router.use(autenticar);

// ── AGING REPORT ──

router.get('/aging', async (req, res) => {
  try {
    const hoje = new Date();

    const r = await query(`
      SELECT
        c.id as cliente_id, c.nome as cliente_nome, c.email as cliente_email,
        c.telefone as cliente_tel, c.nif as cliente_nif,
        f.id, f.numero, f.total, f.data_emissao, f.data_vencimento,
        EXTRACT(DAY FROM NOW() - f.data_vencimento) as dias_atraso,
        CASE
          WHEN f.data_vencimento >= NOW() THEN 'corrente'
          WHEN EXTRACT(DAY FROM NOW()-f.data_vencimento) BETWEEN 1 AND 30 THEN '1_30'
          WHEN EXTRACT(DAY FROM NOW()-f.data_vencimento) BETWEEN 31 AND 60 THEN '31_60'
          WHEN EXTRACT(DAY FROM NOW()-f.data_vencimento) BETWEEN 61 AND 90 THEN '61_90'
          ELSE 'mais_90'
        END as bucket
      FROM fatura f
      JOIN cliente c ON c.id=f.cliente_id
      WHERE f.empresa_id=$1 AND f.estado IN ('emitida','enviada')
        AND f.total > 0
      ORDER BY dias_atraso DESC, c.nome
    `, [req.empresaId]);

    // Agrupar por cliente
    const porCliente = {};
    for (const row of r.rows) {
      if (!porCliente[row.cliente_id]) {
        porCliente[row.cliente_id] = {
          cliente_id: row.cliente_id, cliente_nome: row.cliente_nome,
          cliente_email: row.cliente_email, cliente_tel: row.cliente_tel,
          cliente_nif: row.cliente_nif,
          corrente: 0, dias_1_30: 0, dias_31_60: 0, dias_61_90: 0, mais_90: 0,
          total: 0, faturas: [], max_atraso: 0,
        };
      }
      const cl = porCliente[row.cliente_id];
      const valor = parseFloat(row.total||0);
      cl.total += valor;
      cl.faturas.push({ numero: row.numero, valor, vencimento: row.data_vencimento, dias: Math.round(row.dias_atraso||0) });
      if (row.bucket === 'corrente') cl.corrente += valor;
      else if (row.bucket === '1_30') cl.dias_1_30 += valor;
      else if (row.bucket === '31_60') cl.dias_31_60 += valor;
      else if (row.bucket === '61_90') cl.dias_61_90 += valor;
      else cl.mais_90 += valor;
      cl.max_atraso = Math.max(cl.max_atraso, Math.round(row.dias_atraso||0));
    }

    const clientes = Object.values(porCliente);
    const resumo = {
      corrente: clientes.reduce((s,c)=>s+c.corrente,0),
      dias_1_30: clientes.reduce((s,c)=>s+c.dias_1_30,0),
      dias_31_60: clientes.reduce((s,c)=>s+c.dias_31_60,0),
      dias_61_90: clientes.reduce((s,c)=>s+c.dias_61_90,0),
      mais_90: clientes.reduce((s,c)=>s+c.mais_90,0),
      total: clientes.reduce((s,c)=>s+c.total,0),
      num_clientes: clientes.length,
    };

    res.json({ clientes: clientes.sort((a,b)=>b.total-a.total), resumo });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SEQUÊNCIAS DE COBRANÇA ──

router.get('/sequencias', async (req, res) => {
  try {
    const r = await query(`SELECT * FROM cobranca_sequencia WHERE empresa_id=$1 ORDER BY nome`, [req.empresaId]).catch(()=>({rows:[]}));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/sequencias', async (req, res) => {
  try {
    const { nome, passos } = req.body;
    // passos: [{dias_apos_vencimento, canal:'email'|'whatsapp'|'sms', assunto, mensagem}]
    const r = await query(`
      INSERT INTO cobranca_sequencia (empresa_id, nome, passos, ativo)
      VALUES ($1,$2,$3,true) RETURNING *
    `, [req.empresaId, nome, JSON.stringify(passos||defaultSequencia())]);
    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

function defaultSequencia() {
  return [
    { dias: 1, canal:'email', assunto:'Lembrete de pagamento — {{numero}}',
      mensagem:'Olá {{cliente}},\n\nRecordamos que a fatura {{numero}} no valor de {{valor}}€ venceu há 1 dia.\n\nPor favor proceda ao pagamento brevemente.\n\nObrigado.' },
    { dias: 7, canal:'email', assunto:'2º Aviso — Fatura {{numero}} por liquidar',
      mensagem:'Olá {{cliente}},\n\nA fatura {{numero}} ({{valor}}€) continua por liquidar há {{dias}} dias.\n\nSolicite esclarecimentos ou proceda ao pagamento urgentemente.' },
    { dias: 15, canal:'whatsapp', assunto:'Aviso urgente pagamento',
      mensagem:'⚠️ Olá {{cliente}}! A fatura {{numero}} de {{valor}}€ está há {{dias}} dias vencida. Contacte-nos para resolver urgentemente.' },
    { dias: 30, canal:'email', assunto:'ÚLTIMO AVISO — Fatura {{numero}}',
      mensagem:'Olá {{cliente}},\n\nEste é o último aviso antes de processar a dívida por via legal.\n\nFatura {{numero}}: {{valor}}€ — {{dias}} dias em atraso.\n\nContacte-nos HOJE.' },
  ];
}

// ── EXECUTAR COBRANÇA ──

router.post('/executar', async (req, res) => {
  try {
    const { sequencia_id, cliente_ids, forcar } = req.body;

    const seq = sequencia_id
      ? await query(`SELECT * FROM cobranca_sequencia WHERE id=$1 AND empresa_id=$2`, [sequencia_id, req.empresaId])
      : { rows: [{ passos: JSON.stringify(defaultSequencia()) }] };

    if (!seq.rows.length) return res.status(404).json({ error: 'Sequência não encontrada' });
    const passos = typeof seq.rows[0].passos === 'string' ? JSON.parse(seq.rows[0].passos) : seq.rows[0].passos;

    // Buscar faturas vencidas
    const cond = cliente_ids?.length ? `AND c.id = ANY($2::uuid[])` : '';
    const params = cliente_ids?.length ? [req.empresaId, cliente_ids] : [req.empresaId];

    const faturas = await query(`
      SELECT f.*, c.nome as cliente_nome, c.email as cliente_email, c.telemovel,
        EXTRACT(DAY FROM NOW()-f.data_vencimento) as dias_atraso
      FROM fatura f JOIN cliente c ON c.id=f.cliente_id
      WHERE f.empresa_id=$1 AND f.estado IN ('emitida','enviada')
        AND f.data_vencimento < NOW() ${cond}
    `, params);

    const { enviarEmail } = require('../services/emailService');
    let enviados = 0, erros = 0;

    for (const fat of faturas.rows) {
      const dias = Math.round(parseFloat(fat.dias_atraso||0));

      // Encontrar passo correspondente
      const passo = passos.filter(p => p.dias <= dias).sort((a,b)=>b.dias-a.dias)[0];
      if (!passo) continue;

      // Verificar se já enviou este passo
      const jaEnviou = await query(`SELECT id FROM cobranca_log WHERE fatura_id=$1 AND dias_passo=$2`,
        [fat.id, passo.dias]).catch(()=>({rows:[]}));
      if (jaEnviou.rows.length && !forcar) continue;

      const vars = { cliente: fat.cliente_nome, numero: fat.numero, valor: parseFloat(fat.total).toFixed(2), dias };
      const substituir = (txt) => txt?.replace(/\{\{(\w+)\}\}/g, (_,k)=>vars[k]||'');

      try {
        if (passo.canal === 'email' && fat.cliente_email) {
          await enviarEmail({ to: fat.cliente_email, subject: substituir(passo.assunto), html: substituir(passo.mensagem).replace(/\n/g,'<br>') });
        } else if (passo.canal === 'whatsapp' && fat.telemovel) {
          const { enviarWhatsApp } = require('./whatsapp');
          await enviarWhatsApp(fat.telemovel, substituir(passo.mensagem));
        }

        await query(`INSERT INTO cobranca_log (empresa_id, fatura_id, cliente_id, canal, dias_passo, mensagem_enviada)
          VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
          [req.empresaId, fat.id, fat.cliente_id, passo.canal, passo.dias, substituir(passo.mensagem)]).catch(()=>{});

        enviados++;
      } catch(e) { erros++; }
    }

    res.json({ enviados, erros, total_faturas: faturas.rows.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Histórico de cobranças
router.get('/log', async (req, res) => {
  try {
    const r = await query(`
      SELECT cl.*, f.numero as fatura_numero, c.nome as cliente_nome
      FROM cobranca_log cl
      JOIN fatura f ON f.id=cl.fatura_id
      JOIN cliente c ON c.id=cl.cliente_id
      WHERE cl.empresa_id=$1 ORDER BY cl.criado_em DESC LIMIT 100
    `, [req.empresaId]).catch(()=>({rows:[]}));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
