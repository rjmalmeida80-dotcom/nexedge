'use strict';
const router = require('express').Router();
const { autenticar, autorizar } = require('../middleware/auth');
const { query } = require('../config/database');

router.use(autenticar, autorizar('admin_empresa', 'rh', 'diretor'));

const fmtVal = v => parseFloat(v||0).toFixed(2);
const escXML = s => (s||'').toString().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

// ══════════════════════════════════════════════════════════════════════════════
// SAF-T FATURAÇÃO (vendas)
// ══════════════════════════════════════════════════════════════════════════════
router.get('/faturacao/:ano/:mes', async (req, res) => {
  try {
  const { ano, mes } = req.params;
  const eid = req.empresaId;
  const { rows:[emp] } = await query('SELECT * FROM empresa WHERE id=$1', [eid]);

  const { rows: faturas } = await query(`
    SELECT f.*, array_agg(row_to_json(fl) ORDER BY fl.ordem) AS linhas
    FROM fatura f
    LEFT JOIN fatura_linha fl ON fl.fatura_id = f.id
    WHERE f.empresa_id=$1
      AND EXTRACT(YEAR FROM f.data_emissao)=$2
      AND EXTRACT(MONTH FROM f.data_emissao)=$3
      AND f.estado != 'anulada'
    GROUP BY f.id ORDER BY f.data_emissao, f.numero
  `, [eid, ano, mes]);

  const { rows: clientes } = await query(
    "SELECT DISTINCT cliente_nif, cliente_nome FROM fatura WHERE empresa_id=$1 AND cliente_nif IS NOT NULL",
    [eid]
  );

  const mesStr = String(mes).padStart(2,'0');
  const totalBase = faturas.reduce((s,f)=>s+parseFloat(f.subtotal||0),0);
  const totalIVA  = faturas.reduce((s,f)=>s+parseFloat(f.iva_total||0),0);
  const totalGeral= faturas.reduce((s,f)=>s+parseFloat(f.total||0),0);

  const clientesXML = clientes.map(c => `
    <Customer>
      <CustomerID>${escXML(c.cliente_nif)}</CustomerID>
      <CompanyName>${escXML(c.cliente_nome)}</CompanyName>
      <CustomerTaxID>${escXML(c.cliente_nif)}</CustomerTaxID>
      <BillingAddress><AddressDetail>—</AddressDetail><City>—</City><PostalCode>—</PostalCode><Country>PT</Country></BillingAddress>
      <SelfBillingIndicator>0</SelfBillingIndicator>
    </Customer>`).join('');

  const invoicesXML = faturas.map(f => {
    const linhas = (f.linhas||[]).filter(Boolean);
    const linesXML = linhas.map((l,i) => `
      <Line>
        <LineNumber>${i+1}</LineNumber>
        <ProductCode>SRV${String(i+1).padStart(3,'0')}</ProductCode>
        <ProductDescription>${escXML(l.descricao)}</ProductDescription>
        <Quantity>${fmtVal(l.quantidade)}</Quantity>
        <UnitOfMeasure>UN</UnitOfMeasure>
        <UnitPrice>${fmtVal(l.preco_unitario)}</UnitPrice>
        <TaxPointDate>${f.data_emissao}</TaxPointDate>
        <Description>${escXML(l.descricao)}</Description>
        <CreditAmount>${fmtVal(l.subtotal)}</CreditAmount>
        <Tax>
          <TaxType>IVA</TaxType>
          <TaxCountryRegion>PT</TaxCountryRegion>
          <TaxCode>${parseFloat(l.taxa_iva||23)===23?'NOR':parseFloat(l.taxa_iva||23)===13?'INT':'RED'}</TaxCode>
          <TaxPercentage>${fmtVal(l.taxa_iva)}</TaxPercentage>
        </Tax>
      </Line>`).join('');

    return `
    <Invoice>
      <InvoiceNo>${escXML(f.numero_completo)}</InvoiceNo>
      <ATCUD>${escXML(f.atcud||'0')}</ATCUD>
      <DocumentStatus>
        <InvoiceStatus>N</InvoiceStatus>
        <InvoiceStatusDate>${f.data_emissao}T00:00:00</InvoiceStatusDate>
        <SourceID>${escXML(emp?.nif||'')}</SourceID>
        <SourceBilling>P</SourceBilling>
      </DocumentStatus>
      <Hash>${escXML((f.hash||'').substring(0,4))}</Hash>
      <HashControl>1</HashControl>
      <Period>${mes}</Period>
      <InvoiceDate>${f.data_emissao}</InvoiceDate>
      <InvoiceType>${f.tipo_doc}</InvoiceType>
      <SpecialRegimes><SelfBillingIndicator>0</SelfBillingIndicator></SpecialRegimes>
      <SourceID>NexEdge</SourceID>
      <SystemEntryDate>${new Date(f.criado_em||Date.now()).toISOString().replace('Z','')}</SystemEntryDate>
      <CustomerID>${escXML(f.cliente_nif||'999999990')}</CustomerID>
      <DocumentTotals>
        <TaxPayable>${fmtVal(f.iva_total)}</TaxPayable>
        <NetTotal>${fmtVal(f.subtotal)}</NetTotal>
        <GrossTotal>${fmtVal(f.total)}</GrossTotal>
      </DocumentTotals>
      ${linesXML}
    </Invoice>`;
  }).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<AuditFile xmlns="urn:OECD:Standard:SAF-T:1.00:PT" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Header>
    <AuditFileVersion>1.04_01</AuditFileVersion>
    <CompanyID>${escXML(emp?.nif||'')}</CompanyID>
    <TaxRegistrationNumber>${escXML(emp?.nif||'')}</TaxRegistrationNumber>
    <TaxAccountingBasis>F</TaxAccountingBasis>
    <CompanyName>${escXML(emp?.nome||'')}</CompanyName>
    <BusinessName>${escXML(emp?.nome||'')}</BusinessName>
    <CompanyAddress>
      <AddressDetail>${escXML(emp?.morada||'')}</AddressDetail>
      <City>${escXML(emp?.localidade||'')}</City>
      <PostalCode>${escXML(emp?.codigo_postal||'')}</PostalCode>
      <Country>PT</Country>
    </CompanyAddress>
    <FiscalYear>${ano}</FiscalYear>
    <StartDate>${ano}-${mesStr}-01</StartDate>
    <EndDate>${ano}-${mesStr}-${new Date(parseInt(ano),parseInt(mes),0).getDate()}</EndDate>
    <CurrencyCode>EUR</CurrencyCode>
    <DateCreated>${new Date().toISOString().split('T')[0]}</DateCreated>
    <TaxEntity>Global</TaxEntity>
    <ProductCompanyTaxID>${escXML(emp?.nif||'')}</ProductCompanyTaxID>
    <SoftwareCertificateNumber>0000</SoftwareCertificateNumber>
    <ProductID>NexEdge</ProductID>
    <ProductVersion>4.0</ProductVersion>
  </Header>
  <MasterFiles>
    <Customer>
      <CustomerID>999999990</CustomerID>
      <CompanyName>Consumidor Final</CompanyName>
      <CustomerTaxID>999999990</CustomerTaxID>
      <BillingAddress><AddressDetail>—</AddressDetail><City>—</City><PostalCode>—</PostalCode><Country>PT</Country></BillingAddress>
      <SelfBillingIndicator>0</SelfBillingIndicator>
    </Customer>
    ${clientesXML}
  </MasterFiles>
  <SourceDocuments>
    <SalesInvoices>
      <NumberOfEntries>${faturas.length}</NumberOfEntries>
      <TotalDebit>0.00</TotalDebit>
      <TotalCredit>${fmtVal(totalGeral)}</TotalCredit>
      ${invoicesXML}
    </SalesInvoices>
  </SourceDocuments>
</AuditFile>`;

  res.setHeader('Content-Type','application/xml; charset=utf-8');
  res.setHeader('Content-Disposition',`attachment; filename="SAFT_FAT_${ano}${mesStr}_${emp?.nif||'empresa'}.xml"`);
  res.send(xml);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// SAF-T SALÁRIOS / RH
// ══════════════════════════════════════════════════════════════════════════════
router.get('/salarios/:ano/:mes', async (req, res) => {
  const { ano, mes } = req.params;
  const eid = req.empresaId;
  const mesNum = parseInt(mes);
  const { rows:[emp] } = await query('SELECT * FROM empresa WHERE id=$1', [eid]);

  const { rows: recibos } = await query(`
    SELECT rv.*, f.nome_completo, f.nif, f.niss, f.cargo, f.numero_funcionario,
           f.data_admissao, f.tipo_contrato
    FROM recibo_vencimento rv
    JOIN funcionario f ON f.id = rv.funcionario_id
    WHERE rv.empresa_id=$1 AND rv.ano=$2 AND rv.mes=$3
    ORDER BY f.nome_completo
  `, [eid, ano, mesNum]);

  const mesStr = String(mes).padStart(2,'0');
  const totalBruto = recibos.reduce((s,r)=>s+parseFloat(r.total_abonos||0),0);
  const totalIRS   = recibos.reduce((s,r)=>s+parseFloat(r.irs_retido||0),0);
  const totalSS    = recibos.reduce((s,r)=>s+parseFloat(r.seg_social_func||0),0);
  const totalSSEnt = recibos.reduce((s,r)=>s+parseFloat(r.seg_social_entidade||0),0);
  const totalLiq   = recibos.reduce((s,r)=>s+parseFloat(r.liquido||0),0);

  const recibosXML = recibos.map((r,i) => `
    <EmployeePayroll>
      <EmployeeID>${escXML(r.numero_funcionario||String(i+1).padStart(5,'0'))}</EmployeeID>
      <TaxID>${escXML(r.nif||'')}</TaxID>
      <NISS>${escXML(r.niss||'')}</NISS>
      <EmployeeName>${escXML(r.nome_completo)}</EmployeeName>
      <Category>${escXML(r.cargo)}</Category>
      <ContractType>${escXML(r.tipo_contrato||'sem_termo')}</ContractType>
      <Period>${mesNum}</Period>
      <Year>${ano}</Year>
      <GrossPay>${fmtVal(r.total_abonos)}</GrossPay>
      <BaseSalary>${fmtVal(r.salario_base)}</BaseSalary>
      <MealAllowance>${fmtVal(r.subsidio_alimentacao)}</MealAllowance>
      <HolidaySubsidy>${fmtVal(r.subsidio_ferias)}</HolidaySubsidy>
      <ChristmasSubsidy>${fmtVal(r.subsidio_natal)}</ChristmasSubsidy>
      <IRSWithheld>${fmtVal(r.irs_retido)}</IRSWithheld>
      <SSEmployeeContrib>${fmtVal(r.seg_social_func)}</SSEmployeeContrib>
      <SSEmployerContrib>${fmtVal(r.seg_social_entidade)}</SSEmployerContrib>
      <TotalDeductions>${fmtVal(r.total_descontos)}</TotalDeductions>
      <NetPay>${fmtVal(r.liquido)}</NetPay>
    </EmployeePayroll>`).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!-- SAF-T RH/Salários | ${ano}-${mesStr} | Gerado por NexEdge v4.0 -->
<!-- Empresa: ${escXML(emp?.nome||'')} | NIF: ${escXML(emp?.nif||'')} -->
<PayrollAuditFile xmlns="urn:NexEdge:SAF-T:Payroll:1.00:PT">
  <Header>
    <AuditFileVersion>1.00</AuditFileVersion>
    <CompanyID>${escXML(emp?.nif||'')}</CompanyID>
    <TaxRegistrationNumber>${escXML(emp?.nif||'')}</TaxRegistrationNumber>
    <CompanyName>${escXML(emp?.nome||'')}</CompanyName>
    <FiscalYear>${ano}</FiscalYear>
    <Period>${mesNum}</Period>
    <StartDate>${ano}-${mesStr}-01</StartDate>
    <EndDate>${ano}-${mesStr}-${new Date(parseInt(ano),parseInt(mes),0).getDate()}</EndDate>
    <CurrencyCode>EUR</CurrencyCode>
    <DateCreated>${new Date().toISOString().split('T')[0]}</DateCreated>
    <ProductID>NexEdge</ProductID>
    <ProductVersion>4.0</ProductVersion>
  </Header>
  <PayrollSummary>
    <NumberOfEmployees>${recibos.length}</NumberOfEmployees>
    <TotalGrossPay>${fmtVal(totalBruto)}</TotalGrossPay>
    <TotalIRSWithheld>${fmtVal(totalIRS)}</TotalIRSWithheld>
    <TotalSSEmployeeContrib>${fmtVal(totalSS)}</TotalSSEmployeeContrib>
    <TotalSSEmployerContrib>${fmtVal(totalSSEnt)}</TotalSSEmployerContrib>
    <TotalNetPay>${fmtVal(totalLiq)}</TotalNetPay>
  </PayrollSummary>
  <PayrollRecords>
    ${recibosXML}
  </PayrollRecords>
</PayrollAuditFile>`;

  res.setHeader('Content-Type','application/xml; charset=utf-8');
  res.setHeader('Content-Disposition',`attachment; filename="SAFT_RH_${ano}${mesStr}_${emp?.nif||'empresa'}.xml"`);
  res.send(xml);
});

// ══════════════════════════════════════════════════════════════════════════════
// SAF-T CONTABILIDADE (SNC)
// ══════════════════════════════════════════════════════════════════════════════
router.get('/contabilidade/:ano/:mes', async (req, res) => {
  const { ano, mes } = req.params;
  const eid = req.empresaId;
  const mesNum = parseInt(mes);
  const mesStr = String(mes).padStart(2,'0');
  const { rows:[emp] } = await query('SELECT * FROM empresa WHERE id=$1', [eid]);

  // Plano de contas
  const { rows: contas } = await query(
    'SELECT id, codigo, descricao AS nome, tipo, natureza FROM conta_snc WHERE empresa_id=$1 AND ativa=true ORDER BY codigo',
    [eid]
  );

  // Lançamentos do período
  const { rows: lancamentos } = await query(`
    SELECT l.*, l.diario AS diario_num, l.diario AS diario_nome, l.numero
    FROM lancamento l
    WHERE l.empresa_id=$1
      AND EXTRACT(YEAR FROM l.data_lancamento)=$2
      AND EXTRACT(MONTH FROM l.data_lancamento)=$3
      AND l.estado IN ('lançado','definitivo')
    ORDER BY l.data_lancamento, l.numero
  `, [eid, ano, mesNum]);

  // Linhas de cada lançamento
  const lancIds = lancamentos.map(l=>l.id);
  let linhasMap = {};
  if (lancIds.length) {
    const { rows: linhas } = await query(`
      SELECT ll.*, ll.conta_codigo, ll.conta_descricao AS conta_nome
      FROM lancamento_linha ll
      WHERE ll.lancamento_id = ANY($1::uuid[])
      ORDER BY ll.lancamento_id, ll.ordem
    `, [lancIds]);
    for (const l of linhas) {
      if (!linhasMap[l.lancamento_id]) linhasMap[l.lancamento_id] = [];
      linhasMap[l.lancamento_id].push(l);
    }
  }

  const totalDeb = lancamentos.reduce((s,l)=>s+parseFloat(l.total_debito||0),0);
  const totalCred = lancamentos.reduce((s,l)=>s+parseFloat(l.total_credito||0),0);

  const contasXML = contas.map(c => `
    <Account>
      <AccountID>${escXML(c.codigo)}</AccountID>
      <AccountDescription>${escXML(c.nome)}</AccountDescription>
      <OpeningDebitBalance>0.00</OpeningDebitBalance>
      <OpeningCreditBalance>0.00</OpeningCreditBalance>
      <ClosingDebitBalance>${fmtVal(c.saldo_devedor||0)}</ClosingDebitBalance>
      <ClosingCreditBalance>${fmtVal(c.saldo_credor||0)}</ClosingCreditBalance>
      <GroupingCategory>${escXML(c.tipo||'GA')}</GroupingCategory>
      <GroupingCode>${escXML((c.codigo||'').substring(0,1))}</GroupingCode>
      <TaxonomyCode>${escXML(c.codigo)}</TaxonomyCode>
    </Account>`).join('');

  const lancsXML = lancamentos.map(l => {
    const linhas = linhasMap[l.id] || [];
    const linhasXML = linhas.map((ll,i) => `
        <Line>
          <RecordID>${i+1}</RecordID>
          <AccountID>${escXML(ll.conta_codigo||"")}</AccountID>
          <SystemEntryDate>${new Date(l.criado_em||Date.now()).toISOString().replace('Z','')}</SystemEntryDate>
          <Description>${escXML(ll.descricao||l.descricao)}</Description>
          ${parseFloat(ll.debito||0)>0?`<DebitAmount>${fmtVal(ll.debito)}</DebitAmount>`:''}
          ${parseFloat(ll.credito||0)>0?`<CreditAmount>${fmtVal(ll.credito)}</CreditAmount>`:''}
        </Line>`).join('');

    return `
    <Journal>
      <JournalID>${escXML(l.diario_num||l.numero)}</JournalID>
      <Description>${escXML(l.descricao)}</Description>
      <Transaction>
        <TransactionID>${escXML(l.numero||l.id)}</TransactionID>
        <Period>${mesNum}</Period>
        <TransactionDate>${l.data_lancamento}</TransactionDate>
        <SourceID>NexEdge</SourceID>
        <Description>${escXML(l.descricao)}</Description>
        <DocArchivalNumber>${escXML(l.numero||l.id)}</DocArchivalNumber>
        <TransactionType>N</TransactionType>
        <GLPostingDate>${l.data_lancamento}</GLPostingDate>
        <Lines>${linhasXML}
        </Lines>
      </Transaction>
    </Journal>`;
  }).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<AuditFile xmlns="urn:OECD:Standard:SAF-T:1.00:PT">
  <Header>
    <AuditFileVersion>1.04_01</AuditFileVersion>
    <CompanyID>${escXML(emp?.nif||'')}</CompanyID>
    <TaxRegistrationNumber>${escXML(emp?.nif||'')}</TaxRegistrationNumber>
    <TaxAccountingBasis>C</TaxAccountingBasis>
    <CompanyName>${escXML(emp?.nome||'')}</CompanyName>
    <BusinessName>${escXML(emp?.nome||'')}</BusinessName>
    <CompanyAddress>
      <AddressDetail>${escXML(emp?.morada||'')}</AddressDetail>
      <City>${escXML(emp?.localidade||'')}</City>
      <PostalCode>${escXML(emp?.codigo_postal||'')}</PostalCode>
      <Country>PT</Country>
    </CompanyAddress>
    <FiscalYear>${ano}</FiscalYear>
    <StartDate>${ano}-${mesStr}-01</StartDate>
    <EndDate>${ano}-${mesStr}-${new Date(parseInt(ano),parseInt(mes),0).getDate()}</EndDate>
    <CurrencyCode>EUR</CurrencyCode>
    <DateCreated>${new Date().toISOString().split('T')[0]}</DateCreated>
    <TaxEntity>Global</TaxEntity>
    <ProductCompanyTaxID>${escXML(emp?.nif||'')}</ProductCompanyTaxID>
    <SoftwareCertificateNumber>0000</SoftwareCertificateNumber>
    <ProductID>NexEdge</ProductID>
    <ProductVersion>4.0</ProductVersion>
  </Header>
  <MasterFiles>
    <GeneralLedgerAccounts>
      <TaxonomyReference>PT-SNC</TaxonomyReference>
      ${contasXML}
    </GeneralLedgerAccounts>
  </MasterFiles>
  <GeneralLedgerEntries>
    <NumberOfEntries>${lancamentos.length}</NumberOfEntries>
    <TotalDebit>${fmtVal(totalDeb)}</TotalDebit>
    <TotalCredit>${fmtVal(totalCred)}</TotalCredit>
    ${lancsXML}
  </GeneralLedgerEntries>
</AuditFile>`;

  res.setHeader('Content-Type','application/xml; charset=utf-8');
  res.setHeader('Content-Disposition',`attachment; filename="SAFT_CONT_${ano}${mesStr}_${emp?.nif||'empresa'}.xml"`);
  res.send(xml);
});

// ── Resumo SAF-T — o que existe por mês ──────────────────────────────────────
router.get('/resumo/:ano', async (req, res) => {
  const { ano } = req.params;
  const eid = req.empresaId;

  const { rows: fatMeses } = await query(`
    SELECT EXTRACT(MONTH FROM data_emissao)::int AS mes, COUNT(*) AS num, SUM(total) AS total
    FROM fatura WHERE empresa_id=$1 AND EXTRACT(YEAR FROM data_emissao)=$2 AND estado!='anulada'
    GROUP BY mes ORDER BY mes
  `, [eid, ano]);

  const { rows: salMeses } = await query(`
    SELECT mes, COUNT(*) AS num, SUM(total_abonos) AS total
    FROM recibo_vencimento WHERE empresa_id=$1 AND ano=$2
    GROUP BY mes ORDER BY mes
  `, [eid, ano]);

  const { rows: contMeses } = await query(`
    SELECT EXTRACT(MONTH FROM data_lancamento)::int AS mes, COUNT(*) AS num,
           COUNT(*) AS total
    FROM lancamento WHERE empresa_id=$1
    AND EXTRACT(YEAR FROM data_lancamento)=$2
    GROUP BY mes ORDER BY mes
  `, [eid, ano]);

  res.json({
    ano,
    faturacao:      fatMeses,
    salarios:       salMeses,
    contabilidade:  contMeses,
  });
});

module.exports = router;
