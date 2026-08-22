'use strict';
/**
 * NexEdge — IVA Automático
 * Cálculo automático, declaração periódica, submissão AT
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { autenticar } = require('../middleware/auth');

router.use(autenticar);

const TAXAS_IVA = { normal: 23, intermedia: 13, reduzida: 6, isenta: 0 };

// ── APURAMENTO IVA ──

router.get('/apuramento', async (req, res) => {
  try {
    const { ano, mes, trimestre } = req.query;
    let dataInicio, dataFim, periodo;

    if (mes) {
      dataInicio = `${ano}-${mes.padStart(2,'0')}-01`;
      dataFim = new Date(ano, parseInt(mes), 0).toISOString().slice(0,10);
      periodo = `${mes.padStart(2,'0')}/${ano}`;
    } else if (trimestre) {
      const meses = {1:[1,3],2:[4,6],3:[7,9],4:[10,12]};
      const [m1,m2] = meses[trimestre];
      dataInicio = `${ano}-${m1.toString().padStart(2,'0')}-01`;
      dataFim = new Date(ano, m2, 0).toISOString().slice(0,10);
      periodo = `T${trimestre}/${ano}`;
    } else {
      return res.status(400).json({ error: 'Indica mes ou trimestre' });
    }

    // IVA Liquidado (faturas emitidas)
    const liquidado = await query(`
      SELECT
        COALESCE(taxa_iva, 23) as taxa,
        SUM(base_tributavel) as base,
        SUM(valor_iva) as iva
      FROM fatura
      WHERE empresa_id=$1
        AND data_emissao BETWEEN $2 AND $3
        AND estado NOT IN ('anulada','rascunho')
      GROUP BY taxa_iva ORDER BY taxa DESC
    `, [req.empresaId, dataInicio, dataFim]).catch(() => ({ rows: [] }));

    // IVA Dedutível (despesas/compras)
    const dedutivel = await query(`
      SELECT
        COALESCE(taxa_iva, 23) as taxa,
        SUM(valor_sem_iva) as base,
        SUM(valor_iva) as iva
      FROM despesa
      WHERE empresa_id=$1
        AND data_despesa BETWEEN $2 AND $3
        AND estado='aprovada'
      GROUP BY taxa_iva ORDER BY taxa DESC
    `, [req.empresaId, dataInicio, dataFim]).catch(() => ({ rows: [] }));

    const totalLiquidado = liquidado.rows.reduce((s,r) => s + parseFloat(r.iva||0), 0);
    const totalDedutivel = dedutivel.rows.reduce((s,r) => s + parseFloat(r.iva||0), 0);
    const saldo = totalLiquidado - totalDedutivel;

    res.json({
      periodo,
      data_inicio: dataInicio,
      data_fim: dataFim,
      iva_liquidado: {
        por_taxa: liquidado.rows,
        total: totalLiquidado,
      },
      iva_dedutivel: {
        por_taxa: dedutivel.rows,
        total: totalDedutivel,
      },
      saldo,
      situacao: saldo > 0 ? 'a_pagar' : saldo < 0 ? 'a_recuperar' : 'zero',
      prazo_entrega: calcularPrazo(ano, mes, trimestre),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

function calcularPrazo(ano, mes, trimestre) {
  if (mes) {
    // Mensal: até dia 20 do 2º mês seguinte
    const m = parseInt(mes) + 2;
    const a = m > 12 ? parseInt(ano)+1 : ano;
    return `20/${(m>12?m-12:m).toString().padStart(2,'0')}/${a}`;
  }
  // Trimestral: até dia 20 do 2º mês após o trimestre
  const prazos = {1:'20/05',2:'20/08',3:'20/11',4:'20/02'};
  const a = trimestre == 4 ? parseInt(ano)+1 : ano;
  return `${prazos[trimestre]}/${a}`;
}

// ── HISTÓRICO DE DECLARAÇÕES ──

router.get('/declaracoes', async (req, res) => {
  try {
    const r = await query(`
      SELECT * FROM declaracao_iva
      WHERE empresa_id=$1
      ORDER BY ano DESC, periodo DESC
    `, [req.empresaId]).catch(() => ({ rows: [] }));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/declaracoes', async (req, res) => {
  try {
    const { ano, periodo, tipo_periodo, dados } = req.body;
    const r = await query(`
      INSERT INTO declaracao_iva (empresa_id, ano, periodo, tipo_periodo, dados, estado, criado_em)
      VALUES ($1,$2,$3,$4,$5,'rascunho',NOW())
      ON CONFLICT (empresa_id, ano, periodo) DO UPDATE SET dados=$5, estado='rascunho'
      RETURNING *
    `, [req.empresaId, ano, periodo, tipo_periodo||'mensal', JSON.stringify(dados)]);
    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GERAR XML PARA SUBMISSÃO AT ──

router.get('/declaracoes/:id/xml', async (req, res) => {
  try {
    const r = await query(`
      SELECT d.*, e.nif, e.nome as empresa_nome
      FROM declaracao_iva d
      JOIN empresa e ON e.id=d.empresa_id
      WHERE d.id=$1 AND d.empresa_id=$2
    `, [req.params.id, req.empresaId]);

    if (!r.rows.length) return res.status(404).json({ error: 'Declaração não encontrada' });
    const decl = r.rows[0];
    const dados = typeof decl.dados === 'string' ? JSON.parse(decl.dados) : decl.dados;

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Declaracao xmlns="http://www.portaldasfinancas.gov.pt/at/vat">
  <Cabecalho>
    <NIF>${decl.nif}</NIF>
    <Designacao>${decl.empresa_nome}</Designacao>
    <Ano>${decl.ano}</Ano>
    <Periodo>${decl.periodo}</Periodo>
    <TipoPeriodo>${decl.tipo_periodo}</TipoPeriodo>
    <DataSubmissao>${new Date().toISOString().slice(0,10)}</DataSubmissao>
  </Cabecalho>
  <Campos>
    <Campo codigo="1">${(dados.iva_liquidado?.total||0).toFixed(2)}</Campo>
    <Campo codigo="2">${(dados.iva_dedutivel?.total||0).toFixed(2)}</Campo>
    <Campo codigo="3">${(dados.saldo||0).toFixed(2)}</Campo>
  </Campos>
</Declaracao>`;

    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Disposition', `attachment; filename="IVA_${decl.ano}_${decl.periodo}.xml"`);
    res.send(xml);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ALERTAS IVA ──

router.get('/alertas', async (req, res) => {
  try {
    const hoje = new Date();
    const alertas = [];

    // Verificar declarações em falta
    const decls = await query(`
      SELECT periodo FROM declaracao_iva
      WHERE empresa_id=$1 AND ano=$2 AND estado='submetida'
    `, [req.empresaId, hoje.getFullYear()]).catch(() => ({ rows: [] }));

    const periodosSubmetidos = decls.rows.map(r => r.periodo);
    const mesActual = hoje.getMonth() + 1;

    for (let m = 1; m < mesActual - 1; m++) {
      const periodo = m.toString().padStart(2,'0');
      if (!periodosSubmetidos.includes(periodo)) {
        alertas.push({
          tipo: 'declaracao_em_falta',
          mensagem: `Declaração IVA ${periodo}/${hoje.getFullYear()} não submetida`,
          urgente: true,
          periodo,
        });
      }
    }

    // Prazo próximo (próximos 10 dias)
    const proxMes = mesActual === 12 ? 1 : mesActual + 1;
    const proxAno = mesActual === 12 ? hoje.getFullYear()+1 : hoje.getFullYear();
    const prazo = new Date(proxAno, proxMes, 20);
    const diasAte = Math.ceil((prazo - hoje) / (1000*60*60*24));

    if (diasAte <= 10 && diasAte > 0) {
      alertas.push({
        tipo: 'prazo_proximo',
        mensagem: `Prazo declaração IVA em ${diasAte} dias (${prazo.toLocaleDateString('pt-PT')})`,
        urgente: diasAte <= 3,
        dias: diasAte,
      });
    }

    res.json(alertas);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
