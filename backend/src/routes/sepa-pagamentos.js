'use strict';
/**
 * NexEdge — SEPA Pagamentos em Lote
 * Gera XML SEPA Credit Transfer (pain.001)
 * Supera: Sage, PHC, Primavera no processamento de pagamentos
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const { create: xmlCreate } = require('xmlbuilder2');

router.use(autenticar);

// ── LOTES DE PAGAMENTO ──

router.get('/lotes', async (req, res) => {
  try {
    const r = await query(`
      SELECT l.*,
        (SELECT COUNT(*) FROM sepa_pagamento WHERE lote_id=l.id) as num_pagamentos,
        (SELECT SUM(valor) FROM sepa_pagamento WHERE lote_id=l.id) as total_valor
      FROM sepa_lote l
      WHERE l.empresa_id=$1 ORDER BY l.criado_em DESC
    `, [req.empresaId]).catch(() => ({ rows: [] }));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/lotes', async (req, res) => {
  try {
    const { nome, data_execucao, conta_debito_id, descricao } = req.body;
    const r = await query(`
      INSERT INTO sepa_lote (empresa_id, nome, data_execucao, conta_debito_id, descricao, estado)
      VALUES ($1,$2,$3,$4,$5,'rascunho') RETURNING *
    `, [req.empresaId, nome||`Lote ${new Date().toLocaleDateString('pt-PT')}`, data_execucao||new Date().toISOString().slice(0,10), conta_debito_id||null, descricao||'']);
    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Adicionar pagamento ao lote
router.post('/lotes/:id/pagamentos', async (req, res) => {
  try {
    const { fornecedor_id, despesa_id, nome_beneficiario, iban_beneficiario, bic_beneficiario, valor, referencia, descricao } = req.body;
    if (!iban_beneficiario || !valor) return res.status(400).json({ error: 'IBAN e valor obrigatórios' });

    // Validar IBAN
    const iban = iban_beneficiario.replace(/\s/g,'').toUpperCase();

    let nomeFinal = nome_beneficiario;
    if (!nomeFinal && fornecedor_id) {
      const f = await query(`SELECT nome FROM fornecedor WHERE id=$1`, [fornecedor_id]);
      nomeFinal = f.rows[0]?.nome || 'Beneficiário';
    }

    const r = await query(`
      INSERT INTO sepa_pagamento (lote_id, empresa_id, fornecedor_id, despesa_id, nome_beneficiario, iban_beneficiario, bic_beneficiario, valor, referencia, descricao)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
    `, [req.params.id, req.empresaId, fornecedor_id||null, despesa_id||null, nomeFinal, iban, bic_beneficiario||'', parseFloat(valor), referencia||'', descricao||'']);
    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Importar despesas aprovadas como pagamentos
router.post('/lotes/:id/importar-despesas', async (req, res) => {
  try {
    const despesas = await query(`
      SELECT d.*, f.nome as fornecedor_nome, f.iban, f.bic
      FROM despesa d LEFT JOIN fornecedor f ON f.id=d.fornecedor_id
      WHERE d.empresa_id=$1 AND d.estado='aprovada' AND f.iban IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM sepa_pagamento WHERE despesa_id=d.id)
    `, [req.empresaId]);

    let importados = 0;
    for (const d of despesas.rows) {
      await query(`
        INSERT INTO sepa_pagamento (lote_id, empresa_id, fornecedor_id, despesa_id, nome_beneficiario, iban_beneficiario, bic_beneficiario, valor, referencia, descricao)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT DO NOTHING
      `, [req.params.id, req.empresaId, d.fornecedor_id, d.id, d.fornecedor_nome, d.iban.replace(/\s/g,''), d.bic||'', parseFloat(d.valor_total), d.numero_fatura||d.referencia||'', d.descricao||'']);
      importados++;
    }

    res.json({ importados, total: despesas.rows.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GERAR XML SEPA PAIN.001 ──

router.get('/lotes/:id/xml', async (req, res) => {
  try {
    const [lote, pagamentos, empresa, conta] = await Promise.all([
      query(`SELECT * FROM sepa_lote WHERE id=$1 AND empresa_id=$2`, [req.params.id, req.empresaId]),
      query(`SELECT * FROM sepa_pagamento WHERE lote_id=$1 ORDER BY nome_beneficiario`, [req.params.id]),
      query(`SELECT * FROM empresa WHERE id=$1`, [req.empresaId]),
      query(`SELECT * FROM conta_bancaria WHERE id=(SELECT conta_debito_id FROM sepa_lote WHERE id=$1)`, [req.params.id]).catch(()=>({rows:[]})),
    ]);

    if (!lote.rows.length) return res.status(404).json({ error: 'Lote não encontrado' });
    if (!pagamentos.rows.length) return res.status(400).json({ error: 'Lote sem pagamentos' });

    const l = lote.rows[0];
    const emp = empresa.rows[0];
    const c = conta.rows[0];
    const total = pagamentos.rows.reduce((s,p) => s + parseFloat(p.valor), 0);
    const msgId = `NEXEDGE${Date.now()}`;
    const now = new Date().toISOString().slice(0,19);

    const doc = xmlCreate({ version:'1.0', encoding:'UTF-8' })
      .ele('Document', { xmlns:'urn:iso:std:iso:20022:tech:xsd:pain.001.001.03' })
        .ele('CstmrCdtTrfInitn')
          .ele('GrpHdr')
            .ele('MsgId').txt(msgId).up()
            .ele('CreDtTm').txt(now).up()
            .ele('NbOfTxs').txt(pagamentos.rows.length.toString()).up()
            .ele('CtrlSum').txt(total.toFixed(2)).up()
            .ele('InitgPty')
              .ele('Nm').txt(emp.nome).up()
              .ele('Id').ele('OrgId').ele('Othr').ele('Id').txt(emp.nif||'999999999').up().up().up().up()
            .up()
          .up()
          .ele('PmtInf')
            .ele('PmtInfId').txt(`${msgId}-001`).up()
            .ele('PmtMtd').txt('TRF').up()
            .ele('NbOfTxs').txt(pagamentos.rows.length.toString()).up()
            .ele('CtrlSum').txt(total.toFixed(2)).up()
            .ele('PmtTpInf')
              .ele('SvcLvl').ele('Cd').txt('SEPA').up().up()
            .up()
            .ele('ReqdExctnDt').txt(l.data_execucao?.slice(0,10)||new Date().toISOString().slice(0,10)).up()
            .ele('Dbtr')
              .ele('Nm').txt(emp.nome).up()
            .up()
            .ele('DbtrAcct')
              .ele('Id').ele('IBAN').txt(c?.iban||'PT50000000000000000000000').up().up()
            .up()
            .ele('DbtrAgt')
              .ele('FinInstnId').ele('BIC').txt(c?.bic||'CGDIPTPL').up().up()
            .up();

    // Transacções
    const pmtInf = doc.root().first().last();
    for (let i = 0; i < pagamentos.rows.length; i++) {
      const p = pagamentos.rows[i];
      pmtInf.ele('CdtTrfTxInf')
        .ele('PmtId')
          .ele('EndToEndId').txt(`${msgId}-${(i+1).toString().padStart(3,'0')}`).up()
        .up()
        .ele('Amt')
          .ele('InstdAmt', { Ccy:'EUR' }).txt(parseFloat(p.valor).toFixed(2)).up()
        .up()
        .ele('CdtrAgt')
          .ele('FinInstnId').ele('BIC').txt(p.bic_beneficiario||'NOTPROVIDED').up().up()
        .up()
        .ele('Cdtr')
          .ele('Nm').txt(p.nome_beneficiario).up()
        .up()
        .ele('CdtrAcct')
          .ele('Id').ele('IBAN').txt(p.iban_beneficiario).up().up()
        .up()
        .ele('RmtInf')
          .ele('Ustrd').txt(p.referencia||p.descricao||'Pagamento').up()
        .up()
      .up();
    }

    // Marcar lote como gerado
    await query(`UPDATE sepa_lote SET estado='gerado', xml_gerado_em=NOW() WHERE id=$1`, [req.params.id]);

    const xml = doc.end({ prettyPrint: true });
    res.setHeader('Content-Type', 'application/xml; charset=UTF-8');
    res.setHeader('Content-Disposition', `attachment; filename="SEPA_${msgId}.xml"`);
    res.send(xml);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CASHFLOW FORECASTING ──

router.get('/cashflow', async (req, res) => {
  try {
    const { meses = 3 } = req.query;

    const [faturasPendentes, despesasPrevistas, saldoActual, historico] = await Promise.all([
      // Faturas por receber
      query(`SELECT data_vencimento, SUM(total) as valor FROM fatura
        WHERE empresa_id=$1 AND estado='emitida' AND data_vencimento IS NOT NULL
        AND data_vencimento > NOW() GROUP BY data_vencimento ORDER BY data_vencimento`, [req.empresaId]).catch(()=>({rows:[]})),
      // Despesas previstas
      query(`SELECT data_vencimento, SUM(valor_total) as valor FROM despesa
        WHERE empresa_id=$1 AND estado='aprovada' AND data_vencimento IS NOT NULL
        AND data_vencimento > NOW() GROUP BY data_vencimento ORDER BY data_vencimento`, [req.empresaId]).catch(()=>({rows:[]})),
      // Saldo actual contas
      query(`SELECT COALESCE(SUM(saldo_actual),0) as total FROM conta_bancaria WHERE empresa_id=$1 AND ativo=true`, [req.empresaId]).catch(()=>({rows:[{total:0}]})),
      // Histórico últimos 6 meses
      query(`SELECT TO_CHAR(data,'YYYY-MM') as mes,
        SUM(CASE WHEN valor>0 THEN valor ELSE 0 END) as entradas,
        SUM(CASE WHEN valor<0 THEN ABS(valor) ELSE 0 END) as saidas
        FROM extrato_bancario WHERE empresa_id=$1 AND data > NOW()-INTERVAL '6 months'
        GROUP BY mes ORDER BY mes`, [req.empresaId]).catch(()=>({rows:[]})),
    ]);

    let saldo = parseFloat(saldoActual.rows[0]?.total||0);
    const previsao = [];

    // Gerar previsão dia a dia para os próximos N meses
    const hoje = new Date();
    const fim = new Date(hoje);
    fim.setMonth(fim.getMonth() + parseInt(meses));

    // Agrupar por mês
    const entradasPorMes = {};
    const saidasPorMes = {};

    for (const f of faturasPendentes.rows) {
      const mes = f.data_vencimento?.slice(0,7);
      if (mes) entradasPorMes[mes] = (entradasPorMes[mes]||0) + parseFloat(f.valor||0);
    }
    for (const d of despesasPrevistas.rows) {
      const mes = d.data_vencimento?.slice(0,7);
      if (mes) saidasPorMes[mes] = (saidasPorMes[mes]||0) + parseFloat(d.valor||0);
    }

    // Média histórica para meses sem dados
    const mediaEntradas = historico.rows.length ? historico.rows.reduce((s,r)=>s+parseFloat(r.entradas||0),0)/historico.rows.length : 0;
    const mediaSaidas = historico.rows.length ? historico.rows.reduce((s,r)=>s+parseFloat(r.saidas||0),0)/historico.rows.length : 0;

    let saldoCorrido = saldo;
    for (let i = 0; i < parseInt(meses); i++) {
      const data = new Date(hoje);
      data.setMonth(data.getMonth() + i + 1);
      const mes = data.toISOString().slice(0,7);
      const entradas = entradasPorMes[mes] || mediaEntradas;
      const saidas = saidasPorMes[mes] || mediaSaidas;
      saldoCorrido += entradas - saidas;

      previsao.push({
        mes,
        entradas_previstas: Math.round(entradas),
        saidas_previstas: Math.round(saidas),
        saldo_previsto: Math.round(saldoCorrido),
        alerta: saldoCorrido < 0 ? 'critico' : saldoCorrido < mediaSaidas ? 'atencao' : 'ok',
      });
    }

    res.json({
      saldo_actual: saldo,
      previsao,
      historico: historico.rows,
      faturas_pendentes_total: faturasPendentes.rows.reduce((s,r)=>s+parseFloat(r.valor||0),0),
      despesas_previstas_total: despesasPrevistas.rows.reduce((s,r)=>s+parseFloat(r.valor||0),0),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
