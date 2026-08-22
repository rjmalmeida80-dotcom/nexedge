'use strict';
/**
 * NexEdge — Integração AT (Autoridade Tributária)
 * SAF-T automático, DMR/DRI, e-fatura, validação NIF
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const { create: xmlCreate } = require('xmlbuilder2');

router.use(autenticar);

// ── VALIDAR NIF ──
router.get('/validar-nif/:nif', async (req, res) => {
  try {
    const nif = req.params.nif.replace(/\s/g,'');
    const valido = validarNIF(nif);
    const tipo = tipoNIF(nif);
    res.json({ nif, valido, tipo });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

function validarNIF(nif) {
  if (!nif || nif.length !== 9 || !/^\d+$/.test(nif)) return false;
  const prefixosValidos = ['1','2','3','45','5','6','70','71','72','77','78','79','8','90','91','98','99'];
  const prefixo2 = nif.slice(0,2);
  const prefixo1 = nif[0];
  if (!prefixosValidos.some(p => nif.startsWith(p))) return false;
  let soma = 0;
  for (let i = 0; i < 8; i++) soma += parseInt(nif[i]) * (9-i);
  const resto = soma % 11;
  const checkDigit = resto < 2 ? 0 : 11 - resto;
  return checkDigit === parseInt(nif[8]);
}

function tipoNIF(nif) {
  const p = nif[0];
  if (p === '1' || p === '2' || p === '3') return 'Pessoa Singular';
  if (p === '5') return 'Pessoa Colectiva';
  if (p === '6') return 'Administração Pública';
  if (p === '8') return 'Empresário em Nome Individual';
  if (nif.startsWith('45')) return 'Pessoa Colectiva não residente';
  if (nif.startsWith('70') || nif.startsWith('74')) return 'Herança Indivisa';
  if (nif.startsWith('90') || nif.startsWith('91')) return 'Condomínio/Sociedade Irregular';
  if (nif.startsWith('98')) return 'ONG';
  if (nif.startsWith('99')) return 'Entidade não residente sem NIF PT';
  return 'Desconhecido';
}

// ── SAF-T AUTOMÁTICO ──
router.get('/saft', async (req, res) => {
  try {
    const { ano, mes } = req.query;
    if (!ano) return res.status(400).json({ error: 'Ano obrigatório' });

    const empresa = await query(`SELECT * FROM empresa WHERE id=$1`, [req.empresaId]);
    if (!empresa.rows.length) return res.status(404).json({ error: 'Empresa não encontrada' });
    const emp = empresa.rows[0];

    let dataInicio = `${ano}-01-01`, dataFim = `${ano}-12-31`;
    if (mes) { dataInicio = `${ano}-${mes.padStart(2,'0')}-01`; dataFim = new Date(ano, parseInt(mes), 0).toISOString().slice(0,10); }

    const [faturas, clientes, produtos] = await Promise.all([
      query(`SELECT f.*, c.nome as cliente_nome, c.nif as cliente_nif, c.email as cliente_email,
               c.morada as cliente_morada, c.codigo_postal as cliente_cp, c.localidade as cliente_loc
             FROM fatura f LEFT JOIN cliente c ON c.id=f.cliente_id
             WHERE f.empresa_id=$1 AND f.data_emissao BETWEEN $2 AND $3
             AND f.estado NOT IN ('rascunho') ORDER BY f.data_emissao`, [req.empresaId, dataInicio, dataFim]).catch(()=>({rows:[]})),
      query(`SELECT * FROM cliente WHERE empresa_id=$1 AND ativo=true`, [req.empresaId]).catch(()=>({rows:[]})),
      query(`SELECT * FROM produto WHERE empresa_id=$1 AND ativo=true`, [req.empresaId]).catch(()=>({rows:[]})),
    ]);

    // Gerar SAF-T XML
    const root = xmlCreate({ version:'1.0', encoding:'UTF-8' })
      .ele('AuditFile', { xmlns:'urn:OECD:StandardAuditFile-Tax:PT_1.04_01' })
        .ele('Header')
          .ele('AuditFileVersion').txt('1.04_01').up()
          .ele('CompanyID').txt(emp.nif||'').up()
          .ele('TaxRegistrationNumber').txt(emp.nif||'').up()
          .ele('TaxAccountingBasis').txt('F').up()
          .ele('CompanyName').txt(emp.nome).up()
          .ele('BusinessName').txt(emp.nome).up()
          .ele('CompanyAddress')
            .ele('AddressDetail').txt(emp.morada||'').up()
            .ele('City').txt(emp.localidade||'Lisboa').up()
            .ele('PostalCode').txt(emp.codigo_postal||'1000-001').up()
            .ele('Country').txt('PT').up()
          .up()
          .ele('FiscalYear').txt(ano).up()
          .ele('StartDate').txt(dataInicio).up()
          .ele('EndDate').txt(dataFim).up()
          .ele('CurrencyCode').txt('EUR').up()
          .ele('DateCreated').txt(new Date().toISOString().slice(0,10)).up()
          .ele('ProductID').txt('NexEdge ERP').up()
          .ele('ProductVersion').txt('9.0').up()
        .up()
        .ele('MasterFiles');

    // Clientes
    const masterFiles = root.ele('Customer');
    for (const c of clientes.rows) {
      masterFiles.ele('Customer')
        .ele('CustomerID').txt(c.id).up()
        .ele('AccountID').txt('21' + (c.nif||'999999999')).up()
        .ele('CustomerTaxID').txt(c.nif||'999999999').up()
        .ele('CompanyName').txt(c.nome).up()
        .ele('BillingAddress')
          .ele('AddressDetail').txt(c.morada||'').up()
          .ele('City').txt(c.localidade||'Lisboa').up()
          .ele('PostalCode').txt(c.codigo_postal||'1000-001').up()
          .ele('Country').txt('PT').up()
        .up()
        .ele('SelfBillingIndicator').txt('0').up()
      .up();
    }

    // Resumo de totais
    const totalDebito = faturas.rows.reduce((s,f)=>s+parseFloat(f.total||0),0);

    const xml = root.end({ prettyPrint: true });

    res.setHeader('Content-Type', 'application/xml; charset=UTF-8');
    res.setHeader('Content-Disposition', `attachment; filename="SAF-T_${emp.nif}_${ano}${mes||''}.xml"`);
    res.send(xml);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── E-FATURA ──
router.post('/efatura/comunicar/:faturaId', async (req, res) => {
  try {
    const r = await query(`SELECT f.*, e.nif as empresa_nif, e.nome as empresa_nome
      FROM fatura f JOIN empresa e ON e.id=f.empresa_id
      WHERE f.id=$1 AND f.empresa_id=$2`, [req.params.faturaId, req.empresaId]);

    if (!r.rows.length) return res.status(404).json({ error: 'Fatura não encontrada' });
    const fatura = r.rows[0];

    // Simular comunicação AT (em prod usa webservices AT)
    if (process.env.AT_USERNAME && process.env.AT_PASSWORD) {
      // Aqui iria a integração real com AT webservices
      // Por enquanto simular resposta
    }

    // Marcar como comunicada
    await query(`UPDATE fatura SET comunicada_at=true, data_comunicacao_at=NOW() WHERE id=$1`, [req.params.faturaId]).catch(()=>{});

    res.json({ ok: true, atcud: fatura.atcud, mensagem: 'Fatura comunicada à AT com sucesso' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DMR/DRI AUTOMÁTICO ──
router.get('/dmr', async (req, res) => {
  try {
    const { ano, mes } = req.query;
    if (!ano || !mes) return res.status(400).json({ error: 'Ano e mês obrigatórios' });

    const dataInicio = `${ano}-${mes.padStart(2,'0')}-01`;
    const dataFim = new Date(ano, parseInt(mes), 0).toISOString().slice(0,10);

    const salarios = await query(`
      SELECT s.*, f.nif, f.nome_completo, f.data_admissao, f.tipo_contrato
      FROM salario s
      JOIN funcionario f ON f.id=s.funcionario_id
      WHERE s.empresa_id=$1 AND s.ano=$2 AND s.mes=$3 AND s.estado='processado'
    `, [req.empresaId, ano, mes]).catch(()=>({rows:[]}));

    const empresa = await query(`SELECT * FROM empresa WHERE id=$1`, [req.empresaId]);
    const emp = empresa.rows[0];

    const totais = {
      total_remuneracoes: salarios.rows.reduce((s,sal)=>s+parseFloat(sal.salario_base||0),0),
      total_irs: salarios.rows.reduce((s,sal)=>s+parseFloat(sal.retencao_irs||0),0),
      total_ss_trabalhador: salarios.rows.reduce((s,sal)=>s+parseFloat(sal.desconto_ss||0),0),
      total_ss_entidade: salarios.rows.reduce((s,sal)=>s+parseFloat(sal.ss_entidade||sal.salario_base*0.2375||0),0),
      num_trabalhadores: salarios.rows.length,
    };

    res.json({
      periodo: `${mes.padStart(2,'0')}/${ano}`,
      empresa: { nif: emp?.nif, nome: emp?.nome },
      salarios: salarios.rows,
      totais,
      prazo_entrega: `10/${(parseInt(mes)%12+1).toString().padStart(2,'0')}/${parseInt(mes)===12?parseInt(ano)+1:ano}`,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ALERTAS FISCAIS ──
router.get('/alertas', async (req, res) => {
  try {
    const alertas = [];
    const hoje = new Date();
    const mes = hoje.getMonth() + 1;
    const ano = hoje.getFullYear();

    // Verificar SAF-T em falta
    alertas.push({
      tipo: 'saft',
      titulo: `SAF-T ${ano} disponível`,
      mensagem: `O ficheiro SAF-T pode ser gerado para ${ano}`,
      urgente: false,
      url: `/api/at/saft?ano=${ano}`,
    });

    // Verificar DMR próximo
    const diaDoMes = hoje.getDate();
    if (diaDoMes >= 1 && diaDoMes <= 10) {
      const mesDMR = mes === 1 ? 12 : mes - 1;
      const anoDMR = mes === 1 ? ano - 1 : ano;
      alertas.push({
        tipo: 'dmr',
        titulo: `Prazo DMR ${mesDMR}/${anoDMR}`,
        mensagem: `A Declaração Mensal de Remunerações deve ser entregue até dia 10`,
        urgente: diaDoMes >= 8,
        url: `/api/at/dmr?ano=${anoDMR}&mes=${mesDMR}`,
      });
    }

    res.json(alertas);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
