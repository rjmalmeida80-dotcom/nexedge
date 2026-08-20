'use strict';
const router  = require('express').Router();
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const { calcularSalario, verificarSMN } = require('../utils/salario');
const ctrl    = require('../controllers/salarioController');
const { autenticar, autorizar } = require('../middleware/auth');
const { middlewareAuditoria }   = require('../middleware/auditoria');
const { query } = require('../config/database');
const RH = ['admin_empresa','rh','diretor'];

router.use(autenticar, middlewareAuditoria);

router.get('/',          autorizar(...RH), ctrl.listar);

// GET /salarios/exportar — exportar recibos para Excel
router.get('/exportar', autorizar(...RH), async (req, res) => {
  const ExcelJS = require('exceljs');
  const { query } = require('../config/database');
  const { ano, mes } = req.query;
  let where = 'r.empresa_id=$1';
  const params = [req.empresaId];
  let p = 2;
  if (ano) { where += ` AND r.ano=$${p++}`; params.push(ano); }
  if (mes) { where += ` AND r.mes=$${p++}`; params.push(mes); }
  const { rows } = await query(
    `SELECT f.nome_completo, r.ano, r.mes, r.salario_base,
            r.subsidio_alimentacao, r.total_abonos, r.liquido,
            r.total_descontos, r.irs_retido, r.seg_social_func
     FROM recibo_vencimento r
     JOIN funcionario f ON f.id = r.funcionario_id
     WHERE ${where}
     ORDER BY r.ano DESC, r.mes DESC, f.nome_completo`,
    params
  );
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Salários');
  ws.columns = [
    {header:'Nome',key:'nome_completo',width:25},
    {header:'Ano',key:'ano',width:8},
    {header:'Mês',key:'mes',width:8},
    {header:'Salário Base',key:'salario_base',width:14},
    {header:'Sub. Alimentação',key:'subsidio_alimentacao',width:18},
    {header:'Total Abonos',key:'total_abonos',width:14},
    {header:'IRS',key:'irs_retido',width:10},
    {header:'Seg. Social',key:'seg_social_func',width:12},
    {header:'Líquido',key:'liquido',width:14},
  ];
  ws.getRow(1).eachCell(cell => {
    cell.font={bold:true,color:{argb:'FFFFFFFF'}};
    cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF185FA5'}};
  });
  rows.forEach(r => ws.addRow(r));
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition','attachment; filename="salarios.xlsx"');
  await wb.xlsx.write(res);
  res.end();
});

router.get('/:id',       ctrl.obter);
router.post('/calcular', autorizar(...RH), ctrl.simular);
router.post('/processar',autorizar(...RH), ctrl.processar);
router.post('/simular-processamento', autorizar(...RH), ctrl.simularProcessamento);

// Recibo PDF
router.get('/:id/pdf', async (req, res) => {
  const { rows } = await query(`
    SELECT r.*, 
           f.nome_completo, f.cargo, f.nif, f.iban, f.numero_funcionario,
           f.banco, f.niss, f.categoria, f.tipo_contrato, f.horas_semanais,
           r.dias_trabalhados, r.dias_trabalhados AS dias_uteis_mes,
           e.nome AS empresa_nome, e.nif AS empresa_nif, 
           e.morada AS empresa_morada, e.telefone AS empresa_telefone,
           d.nome AS departamento_nome
    FROM recibo_vencimento r
    JOIN funcionario f ON f.id = r.funcionario_id
    JOIN empresa e ON e.id = r.empresa_id
    LEFT JOIN departamento d ON d.id = f.departamento_id
    WHERE r.id = $1 AND r.empresa_id = $2
  `, [req.params.id, req.empresaId]);

  if (!rows.length) return res.status(404).json({ error: 'Recibo não encontrado.' });
  const r = rows[0];
  
  const meses = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                  'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  const mesNome = meses[(r.mes||1)-1];
  const periodo = `${mesNome} ${r.ano}`;
  const fmt = v => parseFloat(v||0).toFixed(2);
  const fmtN = v => parseFloat(v||0).toFixed(2).replace('.',',');
  
  const salBase     = parseFloat(r.salario_base||0);
  const subAlim     = parseFloat(r.subsidio_alimentacao||0);
  const heValor     = parseFloat(r.horas_extra_valor||0);
  const subFerias   = parseFloat(r.subsidio_ferias||0);
  const subNatal    = parseFloat(r.subsidio_natal||0);
  const totalAbonos = parseFloat(r.total_abonos||0);
  const irsRetido   = parseFloat(r.irs_retido||0);
  const ssFunc      = parseFloat(r.seg_social_func||0);
  const totalDesc   = parseFloat(r.total_descontos||0);
  const liquido     = parseFloat(r.liquido||0);
  const ssEmpresa   = parseFloat(r.seg_social_entidade||0);
  const seguroEmp   = parseFloat(r.seguro_saude_empresa||0);
  const fctTotal    = parseFloat(r.fct_mensal||0) + parseFloat(r.fgct_mensal||0);
  const seguroAT    = parseFloat(r.seguro_at_mensal||0);
  const telemovel   = parseFloat(r.telemovel_empresa||0);
  const custoEmp    = totalAbonos + ssEmpresa + seguroEmp + fctTotal + seguroAT + telemovel;
  
  // Acumulados estimados
  const accIRS      = (irsRetido * r.mes).toFixed(2).replace('.',',');
  const accSS       = (ssFunc * r.mes).toFixed(2).replace('.',',');
  const accLiquido  = (liquido * r.mes).toFixed(2).replace('.',',');
  const baseIncIRS  = (salBase * r.mes).toFixed(2).replace('.',',');
  const baseIncSS   = (salBase * r.mes).toFixed(2).replace('.',',');

  // Linhas de abonos
  const linhasAbonos = [
    { cod: '1000', desc: 'Salário Base', hd: r.horas_semanais ? `${r.horas_semanais}h` : '', val: fmtN(salBase) },
    ...(subAlim > 0 ? [{ cod: '1010', desc: 'Subsídio de Alimentação', hd: '', val: fmtN(subAlim) }] : []),
    ...(heValor > 0 ? [{ cod: '1020', desc: 'Horas Extraordinárias', hd: `${r.horas_extra||0}h`, val: fmtN(heValor) }] : []),
    ...(subFerias > 0 ? [{ cod: '1030', desc: 'Subsídio de Férias', hd: '', val: fmtN(subFerias) }] : []),
    ...(subNatal > 0 ? [{ cod: '1040', desc: 'Subsídio de Natal', hd: '', val: fmtN(subNatal) }] : []),
  ];

  // Linhas de descontos
  const linhasDesc = [
    { cod: '/401', desc: 'Retenção na Fonte (IRS)', hd: '', val: fmtN(irsRetido) },
    { cod: '/350', desc: 'Contribuição para a SS (11%)', hd: '', val: fmtN(ssFunc) },
  ];

  const trAbono = linhasAbonos.map(l => `
    <tr>
      <td class="cod">${l.cod}</td>
      <td>${l.desc}</td>
      <td class="num">${l.hd}</td>
      <td class="num"></td>
      <td class="num green">${l.val}</td>
      <td class="num"></td>
    </tr>`).join('');

  const trDesc = linhasDesc.map(l => `
    <tr>
      <td class="cod">${l.cod}</td>
      <td>${l.desc}</td>
      <td class="num"></td>
      <td class="num"></td>
      <td class="num"></td>
      <td class="num red">${l.val}</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8">
<title>Recibo de Vencimento — ${r.nome_completo} — ${periodo}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: Arial, sans-serif; font-size: 11px; color: #1a1a1a; background: #fff; }
  .page { width: 210mm; min-height: 297mm; margin: 0 auto; padding: 12mm 14mm; }
  
  /* Header empresa */
  .header { display: flex; justify-content: space-between; align-items: flex-start; 
            border-bottom: 2px solid #185FA5; padding-bottom: 8px; margin-bottom: 10px; }
  .empresa-nome { font-size: 16px; font-weight: 900; color: #185FA5; letter-spacing: -0.3px; }
  .empresa-nif { font-size: 10px; color: #555; margin-top: 2px; }
  .titulo-doc { text-align: right; }
  .titulo-doc h2 { font-size: 13px; font-weight: 700; color: #185FA5; }
  .titulo-doc .periodo { font-size: 18px; font-weight: 900; color: #1D9E75; margin-top: 2px; }
  .titulo-doc .emitido { font-size: 9px; color: #888; margin-top: 2px; }
  
  /* Info colaborador */
  .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0; 
               border: 1px solid #ddd; margin-bottom: 10px; }
  .info-col { padding: 6px 10px; }
  .info-col:first-child { border-right: 1px solid #ddd; background: #f8f9fa; }
  .info-col h4 { font-size: 8px; font-weight: 700; color: #185FA5; text-transform: uppercase; 
                 letter-spacing: 1px; margin-bottom: 5px; border-bottom: 1px solid #e0e0e0; padding-bottom: 3px; }
  .info-row { display: flex; justify-content: space-between; padding: 1.5px 0; font-size: 10px; }
  .info-label { color: #666; }
  .info-value { font-weight: 600; color: #1a1a1a; }
  
  /* Tabela movimentos */
  .section-title { font-size: 8px; font-weight: 700; color: #fff; background: #185FA5;
                   padding: 4px 8px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 0; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 0; }
  th { background: #e8f0fb; font-size: 8px; font-weight: 700; color: #185FA5; 
       padding: 4px 6px; text-align: left; border-bottom: 1px solid #c5d5ea; }
  th.num { text-align: right; }
  td { padding: 3px 6px; font-size: 10px; border-bottom: 1px solid #f0f0f0; }
  td.cod { color: #888; font-size: 9px; width: 45px; }
  td.num { text-align: right; }
  td.green { color: #1D9E75; font-weight: 600; }
  td.red { color: #c0392b; font-weight: 600; }
  .total-row td { background: #f0f4ff; font-weight: 700; border-top: 1.5px solid #185FA5; font-size: 11px; }
  .total-row td.green { color: #1D9E75; font-size: 12px; }
  .total-row td.red { color: #c0392b; font-size: 12px; }
  
  /* Líquido */
  .liquido-box { background: linear-gradient(135deg, #185FA5 0%, #0a3d6e 100%); 
                 color: #fff; padding: 10px 14px; margin: 8px 0;
                 display: flex; justify-content: space-between; align-items: center; }
  .liquido-label { font-size: 10px; color: #94c5f5; margin-bottom: 3px; }
  .liquido-valor { font-size: 28px; font-weight: 900; letter-spacing: -0.5px; }
  .liquido-periodo { font-size: 9px; color: #94c5f5; margin-top: 2px; }
  .custo-right { text-align: right; }
  .custo-label { font-size: 9px; color: #94c5f5; margin-bottom: 2px; }
  .custo-valor { font-size: 16px; font-weight: 700; }
  .custo-sub { font-size: 8px; color: #94c5f5; margin-top: 2px; }
  
  /* Acumulados */
  .acc-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 0; 
              border: 1px solid #ddd; margin-bottom: 8px; }
  .acc-item { padding: 5px 8px; text-align: center; border-right: 1px solid #ddd; }
  .acc-item:last-child { border-right: none; }
  .acc-label { font-size: 7.5px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px; }
  .acc-valor { font-size: 11px; font-weight: 700; color: #185FA5; }
  
  /* Pagamento */
  .pagamento { border: 1px solid #d4edda; background: #f0fdf4; padding: 6px 10px; 
               margin-bottom: 8px; display: flex; align-items: center; gap: 10px; }
  .pagamento-icon { font-size: 18px; }
  .pagamento-label { font-size: 8px; color: #666; }
  .pagamento-valor { font-size: 11px; font-weight: 700; color: #1D9E75; }
  .pagamento-banco { font-size: 9px; color: #888; }
  
  /* Encargos empresa */
  .encargos { border: 1px solid #ddd; padding: 6px 10px; margin-bottom: 8px; background: #fafafa; }
  .encargos h4 { font-size: 8px; font-weight: 700; color: #666; text-transform: uppercase; 
                 letter-spacing: 1px; margin-bottom: 4px; }
  .enc-row { display: flex; justify-content: space-between; font-size: 10px; padding: 1px 0; }
  .enc-total { font-weight: 700; border-top: 1px solid #ddd; margin-top: 3px; padding-top: 3px; }
  
  /* Footer */
  .footer { border-top: 1px solid #ddd; padding-top: 6px; 
            display: flex; justify-content: space-between; align-items: flex-end; }
  .footer-left { font-size: 8px; color: #aaa; line-height: 1.6; }
  .footer-badge { background: #185FA5; color: #fff; padding: 3px 10px; font-size: 8px; 
                  font-weight: 700; letter-spacing: 1px; }
  
  @media print {
    body { background: #fff; }
    .page { padding: 8mm 10mm; }
    @page { size: A4; margin: 0; }
  }
</style>
</head>
<body>
<div class="page">

  <!-- Header -->
  <div class="header">
    <div>
      <div class="empresa-nome">${r.empresa_nome}</div>
      <div class="empresa-nif">NIF: ${r.empresa_nif||'—'}${r.empresa_morada ? ' · ' + r.empresa_morada : ''}</div>
    </div>
    <div class="titulo-doc">
      <h2>RECIBO DE VENCIMENTO</h2>
      <div class="periodo">${periodo}</div>
      <div class="emitido">Emitido em ${new Date().toLocaleDateString('pt-PT')}</div>
    </div>
  </div>

  <!-- Info colaborador + empresa -->
  <div class="info-grid">
    <div class="info-col">
      <h4>Colaborador</h4>
      <div class="info-row"><span class="info-label">Nome</span><span class="info-value">${r.nome_completo}</span></div>
      <div class="info-row"><span class="info-label">Nº Pessoal</span><span class="info-value">${r.numero_funcionario||'—'}</span></div>
      <div class="info-row"><span class="info-label">Categoria / Cargo</span><span class="info-value">${r.cargo}${r.categoria ? ' · '+r.categoria : ''}</span></div>
      <div class="info-row"><span class="info-label">Departamento</span><span class="info-value">${r.departamento_nome||'—'}</span></div>
      <div class="info-row"><span class="info-label">NIF</span><span class="info-value">${r.nif||'—'}</span></div>
      <div class="info-row"><span class="info-label">NISS</span><span class="info-value">${r.niss||'—'}</span></div>
    </div>
    <div class="info-col">
      <h4>Dados do Contrato</h4>
      <div class="info-row"><span class="info-label">Tipo de Contrato</span><span class="info-value">${(r.tipo_contrato||'sem_termo').replace(/_/g,' ')}</span></div>
      <div class="info-row"><span class="info-label">Horário Semanal</span><span class="info-value">${r.horas_semanais||40}h / semana</span></div>
      <div class="info-row"><span class="info-label">Período</span><span class="info-value">${mesNome} de ${r.ano}</span></div>
      <div class="info-row"><span class="info-label">Dias Úteis do Mês</span><span class="info-value">${r.dias_uteis_mes||22} dias</span></div>
      <div class="info-row"><span class="info-label">Dias Trabalhados</span><span class="info-value" style="${(r.dias_trabalhados||22)<(r.dias_uteis_mes||22)?'color:#D97706;font-weight:700':''}">
        ${r.dias_trabalhados||22} dias${(r.dias_trabalhados||22)<(r.dias_uteis_mes||22)?` (${((r.dias_trabalhados||22)/(r.dias_uteis_mes||22)*100).toFixed(0)}%)`:''}</span></div>
      <div class="info-row"><span class="info-label">Salário Base</span><span class="info-value">${fmtN(r.salario_base)} €</span></div>
      <div class="info-row"><span class="info-label">Estado</span><span class="info-value" style="color:#1D9E75">✓ Processado</span></div>
    </div>
  </div>

  <!-- Movimentos -->
  <div class="section-title">Movimentos do Período</div>
  <table>
    <thead>
      <tr>
        <th style="width:45px">Cód.</th>
        <th>Designação</th>
        <th class="num" style="width:60px">Per./Hor.</th>
        <th class="num" style="width:60px">Val. Unit.</th>
        <th class="num" style="width:80px">Abonos</th>
        <th class="num" style="width:80px">Descontos</th>
      </tr>
    </thead>
    <tbody>
      ${trAbono}
      ${trDesc}
      <tr class="total-row">
        <td colspan="4" style="text-align:right; font-size:10px;">Totais</td>
        <td class="num green">${fmtN(totalAbonos)}</td>
        <td class="num red">${fmtN(totalDesc)}</td>
      </tr>
    </tbody>
  </table>

  <!-- Valor líquido -->
  <div class="liquido-box">
    <div>
      <div class="liquido-label">VALOR LÍQUIDO A RECEBER</div>
      <div class="liquido-valor">${fmtN(liquido)} €</div>
      <div class="liquido-periodo">Referente a ${periodo}</div>
    </div>
    <div class="custo-right">
      <div class="custo-label">CUSTO TOTAL EMPRESA</div>
      <div class="custo-valor">${fmtN(custoEmp)} €</div>
      <div class="custo-sub">Incl. SS Entidade: ${fmtN(ssEmpresa)} €</div>
    </div>
  </div>

  <!-- Acumulados -->
  <div class="acc-grid">
    <div class="acc-item">
      <div class="acc-label">Acum. Desc. IRS</div>
      <div class="acc-valor">${accIRS} €</div>
    </div>
    <div class="acc-item">
      <div class="acc-label">Acum. Desc. SS</div>
      <div class="acc-valor">${accSS} €</div>
    </div>
    <div class="acc-item">
      <div class="acc-label">Acum. Líquido</div>
      <div class="acc-valor">${accLiquido} €</div>
    </div>
    <div class="acc-item">
      <div class="acc-label">Base Inc. IRS</div>
      <div class="acc-valor">${baseIncIRS} €</div>
    </div>
    <div class="acc-item">
      <div class="acc-label">Base Inc. SS</div>
      <div class="acc-valor">${baseIncSS} €</div>
    </div>
    <div class="acc-item">
      <div class="acc-label">Dias Férias</div>
      <div class="acc-valor">${r.dias_ferias_ano||22}</div>
    </div>
  </div>

  <!-- Pagamento -->
  ${r.iban ? `
  <div class="pagamento">
    <div class="pagamento-icon">🏦</div>
    <div>
      <div class="pagamento-label">Transferência Bancária para</div>
      <div class="pagamento-valor">${r.iban}</div>
      ${r.banco ? `<div class="pagamento-banco">${r.banco}</div>` : ''}
    </div>
  </div>` : ''}

  <!-- Encargos empresa -->
  <div class="encargos">
    <h4>Encargos da Entidade Patronal (informativo)</h4>
    <div class="enc-row"><span>Segurança Social — Entidade Patronal (23,75%)</span><span>${fmtN(ssEmpresa)} €</span></div>
    ${parseFloat(r.seguro_saude_empresa||0)>0 ? `<div class="enc-row"><span>Seguro de Saúde — Prémio Empresa</span><span>${fmtN(r.seguro_saude_empresa)} €</span></div>` : ''}
    ${parseFloat(r.fct_mensal||0)>0 ? `<div class="enc-row"><span>FCT/FGCT (1% base)</span><span>${fmtN(r.fct_mensal + (r.fgct_mensal||0))} €</span></div>` : ''}
    ${parseFloat(r.seguro_at_mensal||0)>0 ? `<div class="enc-row"><span>Seguro Acidentes de Trabalho</span><span>${fmtN(r.seguro_at_mensal)} €</span></div>` : ''}
    ${parseFloat(r.telemovel_empresa||0)>0 ? `<div class="enc-row"><span>Telemóvel de Função</span><span>${fmtN(r.telemovel_empresa)} €</span></div>` : ''}
    <div class="enc-row enc-total"><span>Custo Total Real para a Empresa</span><span>${fmtN(custoEmp)} €</span></div>
  </div>

  <!-- Footer -->
  <div class="footer">
    <div class="footer-left">
      Processado por NexEdge — Plataforma de Gestão de Recursos Humanos · Portugal<br>
      Gerado em ${new Date().toLocaleDateString('pt-PT')} às ${new Date().toLocaleTimeString('pt-PT')}<br>
      Nº ${r.numero_funcionario||'—'} · ${r.nome_completo} · ${periodo}
    </div>
    <div class="footer-badge">✓ DOCUMENTO VÁLIDO</div>
  </div>

</div>
<script>setTimeout(()=>window.print(),500)</script>
</body>
</html>`;

  const nomeFicheiro = `Recibo_${(r.nome_completo||'').replace(/ /g,'_')}_${mesNome}_${r.ano}.html`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Disposition', `inline; filename="${nomeFicheiro}"`);
  res.send(html);
});


// ── Processar todos os colaboradores de um mês ───────────────────────────────
router.post('/processar-massa', autorizar(...RH), async (req, res) => {
  const { ano, mes } = req.body;
  if (!ano || !mes) return res.status(400).json({ error: 'Ano e mês obrigatórios' });

  const { query } = require('../config/database');
  const eid = req.empresaId;

  // Buscar todos os colaboradores activos com salário
  const { rows: funcs } = await query(`
    SELECT f.*, d.nome AS departamento_nome
    FROM funcionario f
    LEFT JOIN departamento d ON d.id = f.departamento_id
    WHERE f.empresa_id=$1 AND f.estado='ativo' AND f.salario_base > 0
    ORDER BY f.nome_completo
  `, [eid]);

  if (!funcs.length) return res.status(400).json({ error: 'Sem colaboradores activos com salário definido' });

  let processados = 0;
  let erros = [];

  for (const func of funcs) {
    try {
      // Verificar se já existe recibo para este mês
      const { rows: existente } = await query(
        'SELECT id FROM recibo_vencimento WHERE funcionario_id=$1 AND ano=$2 AND mes=$3',
        [func.id, ano, mes]
      );

      // Calcular salário com o motor
      const calc = calcularSalario(func, {
        sub_alimentacao_tipo: func.sub_alimentacao_tipo || 'dinheiro',
        subsidio_alimentacao_dia: parseFloat(func.subsidio_alimentacao_dia || 6),
        dias_trabalhados: 22,
      });

      const campos = {
        salario_base: calc.salario_base,
        subsidio_alimentacao: calc.subsidio_alimentacao,
        horas_extra_valor: calc.horas_extra_valor,
        horas_extra_25_valor: calc.horas_extra_25_valor,
        horas_extra_375_valor: calc.horas_extra_375_valor,
        feriados_valor: calc.feriados_valor,
        nocturno_valor: calc.nocturno_valor,
        base_tributavel: calc.base_tributavel,
        irs_retido: calc.irs_retido,
        seg_social_func: calc.seg_social_func,
        seg_social_entidade: calc.seg_social_entidade,
        custo_total_entidade: calc.custo_total_entidade,
        faltas_desconto: calc.faltas_desconto,
        total_abonos: calc.total_abonos,
        total_descontos: calc.total_descontos,
        liquido: calc.liquido,
        detalhes: JSON.stringify(calc.detalhes),
        estado: 'calculado',
        processado_por: req.utilizador.id,
        processado_em: new Date(),
      };

      if (existente.length) {
        // Actualizar existente
        await query(`
          UPDATE recibo_vencimento SET
            salario_base=$1, subsidio_alimentacao=$2, horas_extra_valor=$3,
            base_tributavel=$4, irs_retido=$5, seg_social_func=$6,
            seg_social_entidade=$7, custo_total_entidade=$8,
            faltas_desconto=$9, total_abonos=$10, total_descontos=$11,
            liquido=$12, detalhes=$13, estado=$14,
            processado_por=$15, processado_em=$16
          WHERE funcionario_id=$17 AND ano=$18 AND mes=$19
        `, [
          campos.salario_base, campos.subsidio_alimentacao, campos.horas_extra_valor,
          campos.base_tributavel, campos.irs_retido, campos.seg_social_func,
          campos.seg_social_entidade, campos.custo_total_entidade,
          campos.faltas_desconto, campos.total_abonos, campos.total_descontos,
          campos.liquido, campos.detalhes, campos.estado,
          campos.processado_por, campos.processado_em,
          func.id, ano, mes
        ]);
      } else {
        // Criar novo
        await query(`
          INSERT INTO recibo_vencimento (
            funcionario_id, empresa_id, ano, mes,
            salario_base, subsidio_alimentacao, horas_extra_valor,
            base_tributavel, irs_retido, seg_social_func,
            seg_social_entidade, custo_total_entidade,
            faltas_desconto, outros_abonos, outros_descontos,
            total_abonos, total_descontos, liquido,
            detalhes, estado, processado_por, processado_em
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'[]'::jsonb,'[]'::jsonb,$14,$15,$16,$17,$18,$19,$20
          )
        `, [
          func.id, eid, ano, mes,
          campos.salario_base, campos.subsidio_alimentacao, campos.horas_extra_valor,
          campos.base_tributavel, campos.irs_retido, campos.seg_social_func,
          campos.seg_social_entidade, campos.custo_total_entidade,
          campos.faltas_desconto,
          campos.total_abonos, campos.total_descontos,
          campos.liquido, campos.detalhes, campos.estado,
          campos.processado_por, campos.processado_em
        ]);
      }
      processados++;
    } catch(e) {
      console.error('Erro ao processar', func.nome_completo, e.message);
      erros.push({ funcionario: func.nome_completo, erro: e.message });
    }
  }

  res.json({
    processados,
    erros,
    mensagem: `${processados} recibo(s) calculado(s) para ${mes}/${ano}`,
  });
});


// ── Aprovar recibo (mudar estado para processado) ─────────────────────────────
router.patch('/:id/aprovar', autorizar(...RH), async (req, res) => {
  const { rows } = await query(`
    UPDATE recibo_vencimento
    SET estado='processado', processado_por=$1, processado_em=NOW()
    WHERE id=$2 AND empresa_id=$3
    RETURNING *
  `, [req.utilizador.id, req.params.id, req.empresaId]);
  if (!rows.length) return res.status(404).json({ error: 'Recibo não encontrado' });
  res.json(rows[0]);
});

module.exports = router;
