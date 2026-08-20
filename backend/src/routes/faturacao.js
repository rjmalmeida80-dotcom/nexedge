'use strict';
const router = require('express').Router();
const { gerarPDFFatura } = require('../utils/fatura-pdf');
const { enviarEmailFatura, htmlFatura } = require('../utils/email');
const { autenticar, autorizar } = require('../middleware/auth');
const { query } = require('../config/database');
const crypto = require('crypto');

const ADMIN = ['admin_empresa', 'rh', 'diretor'];
router.use(autenticar, autorizar(...ADMIN));

// ── Utilitários ───────────────────────────────────────────────────────────────

// Gerar ATCUD: CODIGO_VALIDACAO-NUMERO
function gerarATCUD(codigoValidacao, numero) {
  return `ATCUD:${codigoValidacao || '0'}-${numero}`;
}

// Hash RSA da fatura (formato AT)
function gerarHash(dataEmissao, dataSistema, numero, total, hashAnterior, chavePrivada) {
  try {
    const dados = `${dataEmissao};${dataSistema};${numero};${total};${hashAnterior || ''}`;
    const sign = crypto.createSign('RSA-SHA1');
    sign.update(dados);
    return sign.sign(chavePrivada, 'base64');
  } catch(e) {
    // Se não há chave RSA, usar hash simples para desenvolvimento
    return crypto.createHash('sha256').update(`${dataEmissao}${numero}${total}`).digest('base64').substring(0, 40);
  }
}

// Próximo número de série
async function proximoNumero(empresaId, tipoDoc, serie) {
  const { rows } = await query(`
    UPDATE serie_faturacao SET ultimo_numero = ultimo_numero + 1
    WHERE empresa_id=$1 AND tipo_doc=$2 AND serie=$3
    RETURNING ultimo_numero
  `, [empresaId, tipoDoc, serie]);
  if (!rows.length) throw new Error(`Série ${tipoDoc} ${serie} não encontrada`);
  return rows[0].ultimo_numero;
}

// ── Clientes ──────────────────────────────────────────────────────────────────
router.get('/clientes', async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM cliente WHERE empresa_id=$1 AND ativo=true ORDER BY nome',
    [req.empresaId]
  );
  res.json(rows);
});

router.post('/clientes', async (req, res) => {
  const { nome, nif, email, telefone, morada, codigo_postal, localidade, pais } = req.body;
  if (!nome) return res.status(400).json({ error: 'Nome obrigatório' });
  const { rows } = await query(`
    INSERT INTO cliente (empresa_id, nome, nif, email, telefone, morada, codigo_postal, localidade, pais)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
  `, [req.empresaId, nome, nif||null, email||null, telefone||null, morada||null, codigo_postal||null, localidade||null, pais||'PT']);
  res.status(201).json(rows[0]);
});

router.put('/clientes/:id', async (req, res) => {
  const { nome, nif, email, telefone, morada, codigo_postal, localidade, pais } = req.body;
  const { rows } = await query(`
    UPDATE cliente SET nome=$1, nif=$2, email=$3, telefone=$4, morada=$5, codigo_postal=$6, localidade=$7, pais=$8
    WHERE id=$9 AND empresa_id=$10 RETURNING *
  `, [nome, nif||null, email||null, telefone||null, morada||null, codigo_postal||null, localidade||null, pais||'PT', req.params.id, req.empresaId]);
  res.json(rows[0]);
});

// ── Séries ────────────────────────────────────────────────────────────────────
router.get('/series', async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM serie_faturacao WHERE empresa_id=$1 ORDER BY tipo_doc, serie',
    [req.empresaId]
  );
  res.json(rows);
});

router.post('/series', async (req, res) => {
  const { tipo_doc, serie, codigo_validacao } = req.body;
  if (!tipo_doc || !serie) return res.status(400).json({ error: 'Tipo e série obrigatórios' });
  const { rows } = await query(`
    INSERT INTO serie_faturacao (empresa_id, tipo_doc, serie, codigo_validacao)
    VALUES ($1,$2,$3,$4) RETURNING *
  `, [req.empresaId, tipo_doc, serie, codigo_validacao||'0']);
  res.status(201).json(rows[0]);
});

// ── Faturas — listar ──────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const { tipo, estado, ano, mes } = req.query;
  let where = 'f.empresa_id=$1';
  const params = [req.empresaId];
  let p = 2;
  if (tipo)   { where += ` AND f.tipo_doc=$${p++}`; params.push(tipo); }
  if (estado) { where += ` AND f.estado=$${p++}`;   params.push(estado); }
  if (ano)    { where += ` AND EXTRACT(YEAR FROM f.data_emissao)=$${p++}`; params.push(ano); }
  if (mes)    { where += ` AND EXTRACT(MONTH FROM f.data_emissao)=$${p++}`; params.push(mes); }

  const { rows } = await query(`
    SELECT f.*, c.nome AS cliente_nome_reg
    FROM fatura f
    LEFT JOIN cliente c ON c.id = f.cliente_id
    WHERE ${where}
    ORDER BY f.data_emissao DESC, f.numero_doc DESC
    LIMIT 200
  `, params);
  res.json(rows);
});

// ── Criar fatura ──────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { cliente_id, tipo_doc = 'FT', serie, linhas, data_emissao, data_vencimento, notas, retencao = 0 } = req.body;

  if (!linhas?.length) return res.status(400).json({ error: 'Fatura sem linhas' });
  if (!serie) return res.status(400).json({ error: 'Série obrigatória' });

  // Buscar empresa
  const { rows: [emp] } = await query('SELECT * FROM empresa WHERE id=$1', [req.empresaId]);

  // Buscar cliente
  let clienteSnap = { nome: 'Consumidor Final', nif: null, morada: null, pais: 'PT' };
  if (cliente_id) {
    const { rows: [cli] } = await query('SELECT * FROM cliente WHERE id=$1 AND empresa_id=$2', [cliente_id, req.empresaId]);
    if (cli) clienteSnap = cli;
  }

  // Próximo número
  const numero = await proximoNumero(req.empresaId, tipo_doc, serie);
  const numeroCompleto = `${tipo_doc} ${serie}/${numero}`;

  // Calcular totais
  let subtotal = 0, ivaTotal = 0;
  const linhasCalc = linhas.map((l, i) => {
    const qty = parseFloat(l.quantidade) || 1;
    const pu  = parseFloat(l.preco_unitario) || 0;
    const desc = parseFloat(l.desconto_perc) || 0;
    const taxaIva = parseFloat(l.taxa_iva ?? 23);
    const sub = Math.round(qty * pu * (1 - desc/100) * 100) / 100;
    const iva = l.motivo_isencao ? 0 : Math.round(sub * taxaIva/100 * 100) / 100;
    subtotal += sub;
    ivaTotal += iva;
    return { ...l, quantidade: qty, preco_unitario: pu, desconto_perc: desc, taxa_iva: taxaIva, subtotal: sub, iva_valor: iva, total: sub + iva, ordem: i+1 };
  });
  subtotal = Math.round(subtotal * 100) / 100;
  ivaTotal = Math.round(ivaTotal * 100) / 100;
  const total = Math.round((subtotal + ivaTotal) * 100) / 100;
  const ret   = Math.round(parseFloat(retencao) * 100) / 100;
  const totalPagar = Math.round((total - ret) * 100) / 100;

  // Hash anterior
  const { rows: [ultFatura] } = await query(`
    SELECT hash FROM fatura WHERE empresa_id=$1 AND tipo_doc=$2 AND serie=$3 ORDER BY numero DESC LIMIT 1
  `, [req.empresaId, tipo_doc, serie]);

  const hashAnterior = ultFatura?.hash || '';
  const dataEmissao = data_emissao || new Date().toISOString().split('T')[0];
  const hash = gerarHash(dataEmissao, new Date().toISOString().split('T')[0], numero, total, hashAnterior, emp.chave_privada_rsa);

  // Série
  const { rows: [serieRow] } = await query('SELECT * FROM serie_faturacao WHERE empresa_id=$1 AND tipo_doc=$2 AND serie=$3', [req.empresaId, tipo_doc, serie]);
  const atcud = gerarATCUD(serieRow?.codigo_validacao, numero);

  // Inserir fatura
  const { rows: [fatura] } = await query(`
    INSERT INTO fatura (
      empresa_id, cliente_id, serie_id, tipo_doc, serie, numero, numero_completo, atcud,
      data_emissao, data_vencimento,
      cliente_nome, cliente_nif, cliente_morada, cliente_pais,
      subtotal, iva_total, total, retencao, total_pagar,
      hash, hash_anterior, estado, notas, criado_por
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,'emitida',$22,$23
    ) RETURNING *
  `, [
    req.empresaId, cliente_id||null, serieRow?.id||null, tipo_doc, serie, numero, numeroCompleto, atcud,
    dataEmissao, data_vencimento||null,
    clienteSnap.nome, clienteSnap.nif||null, clienteSnap.morada||null, clienteSnap.pais||'PT',
    subtotal, ivaTotal, total, ret, totalPagar,
    hash, hashAnterior, notas||null, req.utilizador.id
  ]);

  // Inserir linhas
  for (const l of linhasCalc) {
    await query(`
      INSERT INTO fatura_linha (fatura_id, descricao, quantidade, preco_unitario, desconto_perc, taxa_iva, motivo_isencao, subtotal, iva_valor, total, ordem)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    `, [fatura.id, l.descricao, l.quantidade, l.preco_unitario, l.desconto_perc, l.taxa_iva, l.motivo_isencao||null, l.subtotal, l.iva_valor, l.total, l.ordem]);
  }

  res.status(201).json({ ...fatura, linhas: linhasCalc });
});

// ── Obter fatura com linhas ───────────────────────────────────────────────────

// GET /faturacao/exportar — exportar faturas para Excel
router.get('/exportar', async (req, res) => {
  const ExcelJS = require('exceljs');
  const { query } = require('../config/database');
  const { ano, mes, estado } = req.query;
  let where = 'f.empresa_id=$1';
  const params = [req.empresaId];
  let p = 2;
  if (ano) { where += ` AND EXTRACT(YEAR FROM f.data_emissao)=$${p++}`; params.push(ano); }
  if (mes) { where += ` AND EXTRACT(MONTH FROM f.data_emissao)=$${p++}`; params.push(mes); }
  if (estado) { where += ` AND f.estado=$${p++}`; params.push(estado); }
  const { rows } = await query(
    `SELECT f.numero_doc, f.tipo_doc,
            c.nome AS cliente,
            f.data_emissao, f.data_vencimento,
            f.subtotal, f.iva_total, f.total, f.valor_pago, f.estado
     FROM fatura f
     LEFT JOIN cliente c ON c.id = f.cliente_id
     WHERE ${where}
     ORDER BY f.data_emissao DESC, f.numero_doc DESC`,
    params
  );
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Faturas');
  ws.columns = [
    {header:'Número',key:'numero_doc',width:15},
    {header:'Tipo',key:'tipo_doc',width:8},
    {header:'Cliente',key:'cliente',width:30},
    {header:'Data Emissão',key:'data_emissao',width:14},
    {header:'Data Vencimento',key:'data_vencimento',width:16},
    {header:'Subtotal',key:'subtotal',width:12},
    {header:'IVA',key:'iva_total',width:10},
    {header:'Total',key:'total',width:12},
    {header:'Valor Pago',key:'valor_pago',width:12},
    {header:'Estado',key:'estado',width:12},
  ];
  ws.getRow(1).eachCell(cell => {
    cell.font={bold:true,color:{argb:'FFFFFFFF'}};
    cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF185FA5'}};
  });
  rows.forEach(r => ws.addRow(r));
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition','attachment; filename="faturas.xlsx"');
  await wb.xlsx.write(res);
  res.end();
});

router.get('/:id', async (req, res) => {
  const { rows: [fatura] } = await query(
    'SELECT * FROM fatura WHERE id=$1 AND empresa_id=$2',
    [req.params.id, req.empresaId]
  );
  if (!fatura) return res.status(404).json({ error: 'Fatura não encontrada' });
  const { rows: linhas } = await query(
    'SELECT * FROM fatura_linha WHERE fatura_id=$1 ORDER BY ordem',
    [req.params.id]
  );
  const { rows: [emp] } = await query('SELECT * FROM empresa WHERE id=$1', [req.empresaId]);
  res.json({ ...fatura, linhas, empresa: emp });
});

// ── Anular fatura ─────────────────────────────────────────────────────────────
router.patch('/:id/anular', async (req, res) => {
  const { rows: [f] } = await query(
    "UPDATE fatura SET estado='anulada' WHERE id=$1 AND empresa_id=$2 AND estado='emitida' RETURNING *",
    [req.params.id, req.empresaId]
  );
  if (!f) return res.status(400).json({ error: 'Fatura não pode ser anulada' });
  res.json(f);
});

// ── SAF-T XML ─────────────────────────────────────────────────────────────────
router.get('/saft/:ano/:mes', async (req, res) => {
  const { ano, mes } = req.params;
  const { rows: [emp] } = await query('SELECT * FROM empresa WHERE id=$1', [req.empresaId]);
  const { rows: faturas } = await query(`
    SELECT f.*, array_agg(row_to_json(fl)) as linhas
    FROM fatura f
    LEFT JOIN fatura_linha fl ON fl.fatura_id = f.id
    WHERE f.empresa_id=$1
      AND EXTRACT(YEAR FROM f.data_emissao)=$2
      AND EXTRACT(MONTH FROM f.data_emissao)=$3
      AND f.estado != 'anulada'
    GROUP BY f.id
    ORDER BY f.data_emissao, f.numero_doc
  `, [req.empresaId, ano, mes]);

  const mesStr = String(mes).padStart(2, '0');
  const totalBase = faturas.reduce((s, f) => s + parseFloat(f.subtotal||0), 0);
  const totalIVA  = faturas.reduce((s, f) => s + parseFloat(f.iva_total||0), 0);
  const totalGeral = faturas.reduce((s, f) => s + parseFloat(f.total||0), 0);

  const linhasDoc = faturas.map(f => `
    <SourceDocuments>
      <SalesInvoices>
        <Invoice>
          <InvoiceNo>${f.numero_completo}</InvoiceNo>
          <ATCUD>${f.atcud || '0'}</ATCUD>
          <DocumentStatus>
            <InvoiceStatus>N</InvoiceStatus>
            <InvoiceStatusDate>${f.data_emissao}T00:00:00</InvoiceStatusDate>
          </DocumentStatus>
          <Hash>${(f.hash||'').substring(0,4)}</Hash>
          <InvoiceDate>${f.data_emissao}</InvoiceDate>
          <InvoiceType>${f.tipo_doc}</InvoiceType>
          <CustomerID>${f.cliente_nif || 'Consumidor Final'}</CustomerID>
          <DocumentTotals>
            <TaxPayable>${parseFloat(f.iva_total||0).toFixed(2)}</TaxPayable>
            <NetTotal>${parseFloat(f.subtotal||0).toFixed(2)}</NetTotal>
            <GrossTotal>${parseFloat(f.total||0).toFixed(2)}</GrossTotal>
          </DocumentTotals>
        </Invoice>
      </SalesInvoices>
    </SourceDocuments>`).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!-- SAF-T (PT) — ${ano}-${mesStr} | Gerado por NexEdge v4.0 -->
<!-- Submeter em: https://www.portaldasfinancas.gov.pt -->
<AuditFile xmlns="urn:OECD:Standard:SAF-T:1.00:PT">
  <Header>
    <AuditFileVersion>1.04_01</AuditFileVersion>
    <CompanyID>${emp?.nif || ''}</CompanyID>
    <TaxRegistrationNumber>${emp?.nif || ''}</TaxRegistrationNumber>
    <TaxAccountingBasis>F</TaxAccountingBasis>
    <CompanyName>${(emp?.nome||'').replace(/&/g,'&amp;')}</CompanyName>
    <BusinessName>${(emp?.nome||'').replace(/&/g,'&amp;')}</BusinessName>
    <CompanyAddress>
      <AddressDetail>${(emp?.morada||'').replace(/&/g,'&amp;')}</AddressDetail>
      <City>${emp?.localidade||''}</City>
      <PostalCode>${emp?.codigo_postal||''}</PostalCode>
      <Country>PT</Country>
    </CompanyAddress>
    <FiscalYear>${ano}</FiscalYear>
    <StartDate>${ano}-${mesStr}-01</StartDate>
    <EndDate>${ano}-${mesStr}-${new Date(parseInt(ano), parseInt(mes), 0).getDate()}</EndDate>
    <CurrencyCode>EUR</CurrencyCode>
    <DateCreated>${new Date().toISOString().split('T')[0]}</DateCreated>
    <TaxEntity>Global</TaxEntity>
    <ProductCompanyTaxID>NexEdge</ProductCompanyTaxID>
    <SoftwareCertificateNumber>0000</SoftwareCertificateNumber>
    <ProductID>NexEdge</ProductID>
    <ProductVersion>4.0</ProductVersion>
  </Header>
  ${linhasDoc}
</AuditFile>`;

  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="SAFT_${ano}${mesStr}_${emp?.nif||'empresa'}.xml"`);
  res.send(xml);
});


// ── Criar Nota de Crédito a partir de fatura ─────────────────────────────────
router.post('/:id/nota-credito', async (req, res) => {
  const { rows: [fatura] } = await query(
    "SELECT * FROM fatura WHERE id=$1 AND empresa_id=$2 AND estado='emitida'",
    [req.params.id, req.empresaId]
  );
  if (!fatura) return res.status(404).json({ error: 'Fatura não encontrada ou já anulada' });

  const { rows: linhas } = await query(
    'SELECT * FROM fatura_linha WHERE fatura_id=$1 ORDER BY ordem',
    [req.params.id]
  );

  // Criar NC
  const numero = await proximoNumero(req.empresaId, 'NC', fatura.serie);
  const numeroCompleto = `NC ${fatura.serie}/${numero}`;

  let { rows: [serieNC] } = await query(
    "SELECT * FROM serie_faturacao WHERE empresa_id=$1 AND tipo_doc='NC'",
    [req.empresaId]
  );

  // Criar série NC automaticamente se não existir
  if (!serieNC) {
    const ano = new Date().getFullYear();
    const { rows: [novaSerieNC] } = await query(
      `INSERT INTO serie_faturacao (empresa_id, tipo_doc, serie, ultimo_numero, codigo_validacao, ativa)
       VALUES ($1,'NC',$2,0,'DEMO2025',true) RETURNING *`,
      [req.empresaId, `${ano}A`]
    );
    serieNC = novaSerieNC;
  }

  const atcud = gerarATCUD(serieNC?.codigo_validacao, numero);
  const dataHoje = new Date().toISOString().split('T')[0];
  const hash = gerarHash(dataHoje, dataHoje, numero, fatura.total, '', null);

  const { rows: [nc] } = await query(`
    INSERT INTO fatura (
      empresa_id, cliente_id, serie_id, tipo_doc, serie, numero, numero_completo, atcud,
      data_emissao, cliente_nome, cliente_nif, cliente_morada, cliente_pais,
      subtotal, iva_total, total, retencao, total_pagar,
      hash, hash_anterior, estado, fatura_origem_id, notas, criado_por
    ) VALUES (
      $1,$2,$3,'NC',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,0,$15,$16,'',' emitida',$17,
      $18,$19
    ) RETURNING *
  `, [
    req.empresaId, fatura.cliente_id, serieNC?.id || null,
    fatura.serie, numero, numeroCompleto, atcud,
    dataHoje, fatura.cliente_nome, fatura.cliente_nif, fatura.cliente_morada, fatura.cliente_pais,
    fatura.subtotal, fatura.iva_total, fatura.total,
    hash, req.params.id,
    `Nota de Crédito referente a ${fatura.numero_completo}`, req.utilizador.id
  ]);

  // Copiar linhas (valores negativos)
  for (const l of linhas) {
    await query(`
      INSERT INTO fatura_linha (fatura_id, descricao, quantidade, preco_unitario, desconto_perc, taxa_iva, subtotal, iva_valor, total, ordem)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    `, [nc.id, l.descricao, l.quantidade, l.preco_unitario, l.desconto_perc, l.taxa_iva,
        -parseFloat(l.subtotal), -parseFloat(l.iva_valor), -parseFloat(l.total), l.ordem]);
  }

  res.status(201).json(nc);
});


// ── Registar pagamento ────────────────────────────────────────────────────────
router.post('/:id/pagamento', async (req, res) => {
  const { valor, metodo = 'transferencia', referencia, notas, data_pagamento } = req.body;
  if (!valor || parseFloat(valor) <= 0) return res.status(400).json({ error: 'Valor inválido' });

  const { rows: [fatura] } = await query(
    "SELECT * FROM fatura WHERE id=$1 AND empresa_id=$2 AND estado NOT IN ('anulada')",
    [req.params.id, req.empresaId]
  );
  if (!fatura) return res.status(404).json({ error: 'Fatura não encontrada' });

  // Registar pagamento
  await query(`
    INSERT INTO fatura_pagamento (fatura_id, empresa_id, data_pagamento, valor, metodo, referencia, notas, criado_por)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
  `, [req.params.id, req.empresaId, data_pagamento || new Date().toISOString().split('T')[0],
      parseFloat(valor), metodo, referencia||null, notas||null, req.utilizador.id]);

  // Actualizar total pago na fatura
  const { rows: [totais] } = await query(
    'SELECT COALESCE(SUM(valor),0) AS total_pago FROM fatura_pagamento WHERE fatura_id=$1',
    [req.params.id]
  );
  const totalPago = parseFloat(totais.total_pago);
  const totalPagar = parseFloat(fatura.total_pagar);

  let novoEstado = fatura.estado;
  if (totalPago >= totalPagar) novoEstado = 'paga';
  else if (totalPago > 0) novoEstado = 'parcialmente_paga';

  const { rows: [faturaAct] } = await query(`
    UPDATE fatura SET valor_pago=$1, estado=$2, data_pagamento=CASE WHEN $3='paga' THEN CURRENT_DATE ELSE data_pagamento END, metodo_pagamento=$4
    WHERE id=$5 RETURNING *
  `, [totalPago, novoEstado, novoEstado, metodo, req.params.id]);

  res.json({ fatura: faturaAct, total_pago: totalPago, estado: novoEstado });
});

// ── Listar pagamentos de uma fatura ──────────────────────────────────────────
router.get('/:id/pagamentos', async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM fatura_pagamento WHERE fatura_id=$1 ORDER BY data_pagamento DESC',
    [req.params.id]
  );
  res.json(rows);
});

// ── Dashboard financeiro ──────────────────────────────────────────────────────
router.get('/dashboard/resumo', async (req, res) => {
  const { ano = new Date().getFullYear() } = req.query;
  const eid = req.empresaId;

  // Totais por mês do ano
  const { rows: porMes } = await query(`
    SELECT
      EXTRACT(MONTH FROM data_emissao)::integer AS mes,
      COUNT(*) FILTER (WHERE estado != 'anulada') AS num_faturas,
      COALESCE(SUM(total) FILTER (WHERE estado != 'anulada'), 0) AS total_faturado,
      COALESCE(SUM(iva_total) FILTER (WHERE estado != 'anulada'), 0) AS total_iva,
      COALESCE(SUM(valor_pago) FILTER (WHERE estado != 'anulada'), 0) AS total_recebido
    FROM fatura
    WHERE empresa_id=$1 AND EXTRACT(YEAR FROM data_emissao)=$2
    GROUP BY mes ORDER BY mes
  `, [eid, ano]);

  // Faturas vencidas
  const { rows: vencidas } = await query(`
    SELECT f.*, c.nome AS cliente_nome_reg,
      CURRENT_DATE - f.data_vencimento AS dias_atraso
    FROM fatura f
    LEFT JOIN cliente c ON c.id = f.cliente_id
    WHERE f.empresa_id=$1
      AND f.estado IN ('emitida', 'parcialmente_paga')
      AND f.data_vencimento < CURRENT_DATE
    ORDER BY f.data_vencimento ASC
    LIMIT 10
  `, [eid]);

  // Top 5 clientes por faturação
  const { rows: topClientes } = await query(`
    SELECT f.cliente_nome,
      COUNT(*) AS num_faturas,
      SUM(f.total) AS total_faturado,
      SUM(f.valor_pago) AS total_recebido
    FROM fatura f
    WHERE f.empresa_id=$1
      AND f.estado != 'anulada'
      AND EXTRACT(YEAR FROM f.data_emissao)=$2
    GROUP BY f.cliente_nome
    ORDER BY total_faturado DESC
    LIMIT 5
  `, [eid, ano]);

  // Resumo geral
  const { rows: [resumo] } = await query(`
    SELECT
      COUNT(*) FILTER (WHERE estado NOT IN ('anulada','rascunho')) AS total_emitidas,
      COUNT(*) FILTER (WHERE estado = 'paga') AS total_pagas,
      COUNT(*) FILTER (WHERE estado IN ('emitida','parcialmente_paga') AND data_vencimento < CURRENT_DATE) AS total_vencidas,
      COUNT(*) FILTER (WHERE estado = 'anulada') AS total_anuladas,
      COALESCE(SUM(total) FILTER (WHERE estado NOT IN ('anulada','rascunho')), 0) AS volume_faturado,
      COALESCE(SUM(valor_pago) FILTER (WHERE estado NOT IN ('anulada','rascunho')), 0) AS volume_recebido,
      COALESCE(SUM(iva_total) FILTER (WHERE estado NOT IN ('anulada','rascunho')), 0) AS iva_total,
      COALESCE(SUM(total - valor_pago) FILTER (WHERE estado IN ('emitida','parcialmente_paga')), 0) AS em_divida
    FROM fatura
    WHERE empresa_id=$1 AND EXTRACT(YEAR FROM data_emissao)=$2
  `, [eid, ano]);

  res.json({ resumo, porMes, vencidas, topClientes });
});

// ── Mapa IVA mensal ───────────────────────────────────────────────────────────
router.get('/mapa-iva/:ano/:mes', async (req, res) => {
  const { ano, mes } = req.params;
  const { rows } = await query(`
    SELECT
      fl.taxa_iva,
      COUNT(DISTINCT f.id) AS num_docs,
      SUM(fl.subtotal) AS base_incidencia,
      SUM(fl.iva_valor) AS iva_liquidado
    FROM fatura_linha fl
    JOIN fatura f ON f.id = fl.fatura_id
    WHERE f.empresa_id=$1
      AND f.estado != 'anulada'
      AND EXTRACT(YEAR FROM f.data_emissao)=$2
      AND EXTRACT(MONTH FROM f.data_emissao)=$3
    GROUP BY fl.taxa_iva
    ORDER BY fl.taxa_iva DESC
  `, [req.empresaId, ano, mes]);

  const total_base = rows.reduce((s, r) => s + parseFloat(r.base_incidencia||0), 0);
  const total_iva  = rows.reduce((s, r) => s + parseFloat(r.iva_liquidado||0), 0);

  res.json({ linhas: rows, total_base, total_iva, periodo: `${ano}-${String(mes).padStart(2,'0')}` });
});

// ── Extracto conta-corrente por cliente ───────────────────────────────────────
router.get('/cliente/:cliente_id/extracto', async (req, res) => {
  const { rows: faturas } = await query(`
    SELECT f.numero_completo, f.tipo_doc, f.data_emissao, f.data_vencimento,
      f.total, f.valor_pago, f.estado, f.atcud,
      CASE WHEN f.data_vencimento < CURRENT_DATE AND f.estado NOT IN ('paga','anulada')
        THEN CURRENT_DATE - f.data_vencimento ELSE 0 END AS dias_atraso
    FROM fatura f
    WHERE f.empresa_id=$1 AND f.cliente_id=$2
    ORDER BY f.data_emissao DESC
  `, [req.empresaId, req.params.cliente_id]);

  const { rows: [cliente] } = await query('SELECT * FROM cliente WHERE id=$1', [req.params.cliente_id]);

  const totalFaturado = faturas.filter(f => f.estado !== 'anulada').reduce((s, f) => s + parseFloat(f.total||0), 0);
  const totalRecebido = faturas.filter(f => f.estado !== 'anulada').reduce((s, f) => s + parseFloat(f.valor_pago||0), 0);
  const totalEmDivida = totalFaturado - totalRecebido;

  res.json({ cliente, faturas, totalFaturado, totalRecebido, totalEmDivida });
});

// ── Faturas recorrentes ───────────────────────────────────────────────────────
router.get('/recorrentes', async (req, res) => {
  const { rows } = await query(
    'SELECT fr.*, c.nome AS cliente_nome FROM fatura_recorrente fr LEFT JOIN cliente c ON c.id=fr.cliente_id WHERE fr.empresa_id=$1 ORDER BY fr.proxima_emissao',
    [req.empresaId]
  );
  res.json(rows);
});

router.post('/recorrentes', async (req, res) => {
  const { cliente_id, tipo_doc, serie, descricao, linhas, dia_emissao, dias_vencimento } = req.body;
  if (!descricao || !linhas?.length || !serie) return res.status(400).json({ error: 'Campos obrigatórios em falta' });

  const hoje = new Date();
  const proxima = new Date(hoje.getFullYear(), hoje.getMonth() + 1, parseInt(dia_emissao)||1);

  const { rows: [sr] } = await query('SELECT * FROM serie_faturacao WHERE empresa_id=$1 AND tipo_doc=$2 AND serie=$3', [req.empresaId, tipo_doc||'FT', serie]);

  const { rows: [rec] } = await query(`
    INSERT INTO fatura_recorrente (empresa_id, cliente_id, serie_id, tipo_doc, serie, descricao, linhas, dia_emissao, dias_vencimento, proxima_emissao)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
  `, [req.empresaId, cliente_id||null, sr?.id||null, tipo_doc||'FT', serie, descricao, JSON.stringify(linhas), parseInt(dia_emissao)||1, parseInt(dias_vencimento)||30, proxima.toISOString().split('T')[0]]);

  res.status(201).json(rec);
});

// ── Exportar Excel (lista de faturas) ────────────────────────────────────────
router.get('/exportar/excel/:ano', async (req, res) => {
  const { ano } = req.params;
  const { mes } = req.query;
  const params = [req.empresaId, ano];
  let mesWhere = '';
  if (mes) { mesWhere = ' AND EXTRACT(MONTH FROM f.data_emissao)=$3'; params.push(mes); }

  const { rows } = await query(`
    SELECT f.numero_completo, f.tipo_doc, f.atcud, f.data_emissao, f.data_vencimento,
      f.cliente_nome, f.cliente_nif, f.subtotal, f.iva_total, f.total,
      f.valor_pago, f.estado, f.metodo_pagamento
    FROM fatura f
    WHERE f.empresa_id=$1 AND EXTRACT(YEAR FROM f.data_emissao)=$2 ${mesWhere}
      AND f.estado != 'anulada'
    ORDER BY f.data_emissao, f.numero_doc
  `, params);

  const sep = ';';
  const cabecalho = ['Numero','Tipo','ATCUD','Data Emissao','Data Vencimento','Cliente','NIF','Base','IVA','Total','Pago','Estado','Metodo Pagamento'].join(sep);
  const linhasCSV = rows.map(r => [
    r.numero_completo, r.tipo_doc, r.atcud,
    r.data_emissao ? r.data_emissao.toString().split('T')[0] : '',
    r.data_vencimento ? r.data_vencimento.toString().split('T')[0] : '',
    r.cliente_nome || '', r.cliente_nif || '',
    parseFloat(r.subtotal||0).toFixed(2),
    parseFloat(r.iva_total||0).toFixed(2),
    parseFloat(r.total||0).toFixed(2),
    parseFloat(r.valor_pago||0).toFixed(2),
    r.estado || '', r.metodo_pagamento || ''
  ].join(sep)).join('\n');

  const csv = '\uFEFF' + cabecalho + '\n' + linhasCSV;

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="Faturas_' + ano + (mes ? '_' + String(mes).padStart(2,'0') : '') + '.csv"');
  res.send(csv);
});


// ── Duplicar fatura ───────────────────────────────────────────────────────────
router.post('/:id/duplicar', async (req, res) => {
  const { rows: [orig] } = await query('SELECT * FROM fatura WHERE id=$1 AND empresa_id=$2', [req.params.id, req.empresaId]);
  if (!orig) return res.status(404).json({ error: 'Fatura não encontrada' });

  const { rows: linhas } = await query('SELECT * FROM fatura_linha WHERE fatura_id=$1 ORDER BY ordem', [req.params.id]);

  // Retornar dados para pré-preencher nova fatura (não cria — o utilizador confirma)
  res.json({
    cliente_id: orig.cliente_id,
    tipo_doc: orig.tipo_doc,
    serie: orig.serie,
    linhas: linhas.map(l => ({
      descricao: l.descricao,
      quantidade: parseFloat(l.quantidade),
      preco_unitario: parseFloat(l.preco_unitario),
      desconto_perc: parseFloat(l.desconto_perc||0),
      taxa_iva: parseFloat(l.taxa_iva),
      motivo_isencao: l.motivo_isencao,
    })),
    notas: orig.notas,
    retencao: parseFloat(orig.retencao||0),
    origem: orig.numero_completo,
  });
});

// ── Marcar como enviada por email ─────────────────────────────────────────────
router.patch('/:id/marcar-enviada', async (req, res) => {
  const { rows: [f] } = await query(
    'UPDATE fatura SET enviada_email=true, data_envio_email=NOW() WHERE id=$1 AND empresa_id=$2 RETURNING *',
    [req.params.id, req.empresaId]
  );
  res.json(f);
});

// ── Marcar como incluída no SAF-T ────────────────────────────────────────────
router.patch('/saft/:ano/:mes/marcar-incluido', async (req, res) => {
  const { ano, mes } = req.params;
  await query(`
    UPDATE fatura SET incluida_saft=true
    WHERE empresa_id=$1
      AND EXTRACT(YEAR FROM data_emissao)=$2
      AND EXTRACT(MONTH FROM data_emissao)=$3
      AND estado != 'anulada'
  `, [req.empresaId, ano, mes]);
  res.json({ ok: true });
});



// ── Descarregar PDF da fatura ─────────────────────────────────────────────────
router.get('/:id/pdf', async (req, res) => {
  const { rows: [fatura] } = await query('SELECT * FROM fatura WHERE id=$1 AND empresa_id=$2', [req.params.id, req.empresaId]);
  if (!fatura) return res.status(404).json({ error: 'Fatura não encontrada' });

  const { rows: linhas } = await query('SELECT * FROM fatura_linha WHERE fatura_id=$1 ORDER BY ordem', [req.params.id]);
  const { rows: [empresa] } = await query('SELECT * FROM empresa WHERE id=$1', [req.empresaId]);

  try {
    const pdfBuffer = await gerarPDFFatura(fatura, empresa, linhas);
    const nomeFicheiro = `${fatura.numero_completo.replace(/\//g, '-').replace(/ /g, '_')}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${nomeFicheiro}"`);
    res.send(pdfBuffer);
  } catch(e) {
    console.error('Erro ao gerar PDF:', e.message);
    res.status(500).json({ error: 'Erro ao gerar PDF: ' + e.message });
  }
});

// ── Enviar fatura por email ───────────────────────────────────────────────────
router.post('/:id/enviar-email', async (req, res) => {
  const { email_destino, mensagem_extra } = req.body;

  const { rows: [fatura] } = await query('SELECT * FROM fatura WHERE id=$1 AND empresa_id=$2', [req.params.id, req.empresaId]);
  if (!fatura) return res.status(404).json({ error: 'Fatura não encontrada' });

  const { rows: linhas } = await query('SELECT * FROM fatura_linha WHERE fatura_id=$1 ORDER BY ordem', [req.params.id]);
  const { rows: [empresa] } = await query('SELECT * FROM empresa WHERE id=$1', [req.empresaId]);

  // Email do cliente ou email fornecido
  let emailPara = email_destino;
  if (!emailPara && fatura.cliente_id) {
    const { rows: [cli] } = await query('SELECT email FROM cliente WHERE id=$1', [fatura.cliente_id]);
    emailPara = cli?.email;
  }
  if (!emailPara) return res.status(400).json({ error: 'Email de destino não encontrado. Indica um email manualmente.' });

  try {
    const pdfBuffer = await gerarPDFFatura(fatura, empresa, linhas);
    const nomePDF = `${fatura.numero_completo.replace(/\//g, '-').replace(/ /g, '_')}.pdf`;
    const html = htmlFatura(fatura, empresa);

    const resultado = await enviarEmailFatura({
      para: emailPara,
      assunto: `${fatura.numero_completo} — ${empresa.nome}`,
      html,
      pdfBuffer,
      nomePDF,
    });

    if (resultado.ok) {
      // Marcar como enviada
      await query('UPDATE fatura SET enviada_email=true, data_envio_email=NOW() WHERE id=$1', [req.params.id]);
      res.json({ ok: true, preview: resultado.preview, messageId: resultado.messageId });
    } else {
      res.status(500).json({ error: resultado.error });
    }
  } catch(e) {
    res.status(500).json({ error: 'Erro ao enviar email: ' + e.message });
  }
});

// ── Recibo automático ao pagar ────────────────────────────────────────────────
router.get('/:id/recibo-pdf', async (req, res) => {
  const { rows: [fatura] } = await query(
    "SELECT * FROM fatura WHERE id=$1 AND empresa_id=$2 AND estado='paga'",
    [req.params.id, req.empresaId]
  );
  if (!fatura) return res.status(404).json({ error: 'Fatura não encontrada ou ainda não paga' });

  const { rows: linhas } = await query('SELECT * FROM fatura_linha WHERE fatura_id=$1 ORDER BY ordem', [req.params.id]);
  const { rows: [empresa] } = await query('SELECT * FROM empresa WHERE id=$1', [req.empresaId]);
  const { rows: pagamentos } = await query('SELECT * FROM fatura_pagamento WHERE fatura_id=$1 ORDER BY data_pagamento', [req.params.id]);

  // Criar versão "recibo" da fatura
  const recibo = { ...fatura, tipo_doc: 'RECIBO', numero_completo: 'RECIBO — ' + fatura.numero_completo };

  try {
    const pdfBuffer = await gerarPDFFatura(recibo, empresa, linhas, pagamentos);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Recibo_${fatura.numero_completo.replace(/\//g,'-').replace(/ /g,'_')}.pdf"`);
    res.send(pdfBuffer);
  } catch(e) {
    res.status(500).json({ error: 'Erro ao gerar recibo: ' + e.message });
  }
});


// ── Lookup NIF ───────────────────────────────────────────────────────────────
router.get('/lookup-nif/:nif', async (req, res) => {
  const { nif } = req.params;
  const nifLimpo = (nif || '').replace(/\D/g, '');

  // 1. Verificar na nossa BD de clientes
  const { rows: [existente] } = await query(
    'SELECT * FROM cliente WHERE empresa_id=$1 AND nif=$2',
    [req.empresaId, nifLimpo]
  );
  if (existente) return res.json({ fonte: 'base_dados', ...existente });

  // 2. Tentar API pública nif.pt
  try {
    const resp = await fetch(
      `https://www.nif.pt/?json=1&q=${nifLimpo}&key=demo`,
      { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(4000) }
    );
    if (resp.ok) {
      const data = await resp.json();
      if (data.result === 'success' && data.records && data.records[nifLimpo]) {
        const r = data.records[nifLimpo];
        return res.json({
          fonte: 'nif_pt',
          nome: r.title || '',
          nif: nifLimpo,
          morada: r.address || '',
          codigo_postal: r.pc4 && r.pc3 ? r.pc4 + '-' + r.pc3 : '',
          localidade: r.city || '',
        });
      }
    }
  } catch(e) { /* timeout ou erro — continuar */ }

  // 3. Tentar VIES (validação europeia IVA)
  try {
    const paisCodigo = nifLimpo.length === 9 ? 'PT' : nifLimpo.substring(0, 2).toUpperCase();
    const nifSemPais = nifLimpo.replace(/^[A-Z]{2}/i, '');
    const resp2 = await fetch(
      `https://ec.europa.eu/taxation_customs/vies/rest-api/ms/PT/vat/${nifSemPais}`,
      { signal: AbortSignal.timeout(4000) }
    );
    if (resp2.ok) {
      const vies = await resp2.json();
      if (vies.isValid && vies.name) {
        return res.json({
          fonte: 'vies',
          nome: vies.name,
          nif: nifLimpo,
          morada: vies.address || '',
        });
      }
    }
  } catch(e) { /* timeout */ }

  // 4. Não encontrado — devolver NIF para o utilizador preencher manualmente
  res.json({ nif: nifLimpo, fonte: 'nao_encontrado', mensagem: 'NIF não encontrado nas bases públicas. Preenche os dados manualmente.' });
});

// ── Processar faturas recorrentes (chamado pelo agendador) ────────────────────
router.post('/recorrentes/processar', async (req, res) => {
  const hoje = new Date().toISOString().split('T')[0];
  const { rows: pendentes } = await query(`
    SELECT fr.*, c.nome AS cliente_nome, c.nif AS cliente_nif,
      c.morada AS cliente_morada, c.email AS cliente_email
    FROM fatura_recorrente fr
    LEFT JOIN cliente c ON c.id = fr.cliente_id
    WHERE fr.ativa = true
      AND fr.proxima_emissao <= $1
      AND fr.empresa_id = $2
  `, [hoje, req.empresaId]);

  const emitidas = [];
  for (const rec of pendentes) {
    try {
      const linhas = typeof rec.linhas === 'string' ? JSON.parse(rec.linhas) : rec.linhas;

      // Calcular totais
      let subtotal = 0, ivaTotal = 0;
      const linhasCalc = linhas.map((l, i) => {
        const sub = parseFloat(l.quantidade||1) * parseFloat(l.preco_unitario||0);
        const iva = sub * parseFloat(l.taxa_iva||23) / 100;
        subtotal += sub; ivaTotal += iva;
        return { ...l, subtotal: sub.toFixed(2), iva_valor: iva.toFixed(2), total: (sub+iva).toFixed(2), ordem: i+1 };
      });
      const total = subtotal + ivaTotal;

      // Próximo número
      const { rows: [sr] } = await query(
        'UPDATE serie_faturacao SET ultimo_numero=ultimo_numero+1 WHERE empresa_id=$1 AND tipo_doc=$2 AND serie=$3 RETURNING ultimo_numero, codigo_validacao',
        [rec.empresa_id, rec.tipo_doc, rec.serie]
      );
      if (!sr) continue;

      const numero = sr.ultimo_numero;
      const numeroCompleto = rec.tipo_doc + ' ' + rec.serie + '/' + numero;
      const atcud = 'ATCUD:' + (sr.codigo_validacao || '0') + '-' + numero;
      const crypto = require('crypto');
      const hash = crypto.createHash('sha256').update(hoje + numero + total).digest('base64').substring(0, 40);

      // Calcular vencimento
      const venc = new Date(hoje);
      venc.setDate(venc.getDate() + parseInt(rec.dias_vencimento || 30));

      const { rows: [fatura] } = await query(`
        INSERT INTO fatura (
          empresa_id, cliente_id, serie_id, tipo_doc, serie, numero, numero_completo, atcud,
          data_emissao, data_vencimento, cliente_nome, cliente_nif, cliente_morada,
          subtotal, iva_total, total, total_pagar, hash, hash_anterior, estado, notas
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16,$17,'','emitida',$18)
        RETURNING *
      `, [
        rec.empresa_id, rec.cliente_id, rec.serie_id, rec.tipo_doc, rec.serie,
        numero, numeroCompleto, atcud, hoje, venc.toISOString().split('T')[0],
        rec.cliente_nome, rec.cliente_nif, rec.cliente_morada,
        subtotal.toFixed(2), ivaTotal.toFixed(2), total.toFixed(2),
        hash, 'Fatura recorrente: ' + rec.descricao
      ]);

      for (const l of linhasCalc) {
        await query(`
          INSERT INTO fatura_linha (fatura_id, descricao, quantidade, preco_unitario, desconto_perc, taxa_iva, subtotal, iva_valor, total, ordem)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        `, [fatura.id, l.descricao, l.quantidade, l.preco_unitario, l.desconto_perc||0, l.taxa_iva||23, l.subtotal, l.iva_valor, l.total, l.ordem]);
      }

      // Actualizar próxima emissão (próximo mês)
      const proxima = new Date(hoje);
      proxima.setMonth(proxima.getMonth() + 1);
      proxima.setDate(parseInt(rec.dia_emissao || 1));

      await query(`
        UPDATE fatura_recorrente SET
          ultima_emissao=$1, proxima_emissao=$2, total_emitido=total_emitido+1
        WHERE id=$3
      `, [hoje, proxima.toISOString().split('T')[0], rec.id]);

      emitidas.push({ numero_completo: numeroCompleto, total: total.toFixed(2) });
    } catch(e) {
      console.error('Erro fatura recorrente:', rec.id, e.message);
    }
  }

  res.json({ processadas: emitidas.length, faturas: emitidas });
});

// ── Alertas de vencimento ─────────────────────────────────────────────────────
router.get('/alertas-vencimento', async (req, res) => {
  const { dias = 7 } = req.query;
  const { rows } = await query(`
    SELECT f.id, f.numero_completo, f.cliente_nome, f.cliente_nif,
      f.data_vencimento, f.total_pagar, f.valor_pago,
      f.total_pagar - f.valor_pago AS por_pagar,
      f.data_vencimento - CURRENT_DATE AS dias_para_vencer,
      c.email AS cliente_email
    FROM fatura f
    LEFT JOIN cliente c ON c.id = f.cliente_id
    WHERE f.empresa_id=$1
      AND f.estado IN ('emitida', 'parcialmente_paga')
      AND f.data_vencimento BETWEEN CURRENT_DATE AND CURRENT_DATE + $2::integer
    ORDER BY f.data_vencimento ASC
  `, [req.empresaId, parseInt(dias)]);

  const { rows: vencidas } = await query(`
    SELECT f.id, f.numero_completo, f.cliente_nome,
      f.data_vencimento, f.total_pagar - f.valor_pago AS por_pagar,
      CURRENT_DATE - f.data_vencimento AS dias_atraso,
      c.email AS cliente_email
    FROM fatura f
    LEFT JOIN cliente c ON c.id = f.cliente_id
    WHERE f.empresa_id=$1
      AND f.estado IN ('emitida', 'parcialmente_paga')
      AND f.data_vencimento < CURRENT_DATE
    ORDER BY f.data_vencimento ASC
  `, [req.empresaId]);

  res.json({
    a_vencer: rows,
    vencidas,
    resumo: {
      total_a_vencer: rows.reduce((s,r) => s + parseFloat(r.por_pagar||0), 0).toFixed(2),
      total_vencido: vencidas.reduce((s,r) => s + parseFloat(r.por_pagar||0), 0).toFixed(2),
      num_a_vencer: rows.length,
      num_vencidas: vencidas.length,
    }
  });
});

module.exports = router;
