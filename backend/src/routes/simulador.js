'use strict';

/**
 * NexEdge — Motor de Simulação Salarial + Gerador de Proposta PDF
 * Legislação portuguesa 2025 completa
 */

const router = require('express').Router();
const { autenticar } = require('../middleware/auth');
const { criarErro } = require('../middleware/errorHandler');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

// ── Tabelas IRS 2025 ──────────────────────────────────────────────────────────
const TABELAS_IRS = [
  { ate:      7703, taxa_media: 0.1300 },
  { ate:     11623, taxa_media: 0.1495 },
  { ate:     16472, taxa_media: 0.1724 },
  { ate:     21321, taxa_media: 0.1910 },
  { ate:     27146, taxa_media: 0.2268 },
  { ate:     39791, taxa_media: 0.2745 },
  { ate:     51997, taxa_media: 0.3165 },
  { ate:     81199, taxa_media: 0.3642 },
  { ate: Infinity,  taxa_media: 0.3893 },
];

const SS_FUNC    = 0.11;
const SS_EMPRESA = 0.2375;
const DIAS_UTEIS = 22;

const MESES = [
  'Janeiro','Fevereiro','Março','Abril','Maio','Junho',
  'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'
];

function calcularIRS(brutoAnual) {
  const escalao = TABELAS_IRS.find(e => brutoAnual <= e.ate);
  return Math.round((brutoAnual * (escalao?.taxa_media || 0.3893) / 12) * 100) / 100;
}

/**
 * Calcula um mês específico
 * Sub. férias → junho (mês 6)
 * Sub. Natal  → novembro (mês 11)
 */
function calcularMes({ salarioBase, subAlimentacao, horasExtra = 0, faltas = 0, mes }) {
  const valorHora = salarioBase / (52 * 40 / 12);

  // Horas extra — CT art. 268.º
  const he1    = Math.min(horasExtra, 1);
  const heRest = Math.max(horasExtra - 1, 0);
  const valorHE = Math.round((he1 * valorHora * 1.25 + heRest * valorHora * 1.375) * 100) / 100;

  // Desconto faltas
  const descFaltas = faltas > 0
    ? Math.round((salarioBase / DIAS_UTEIS) * faltas * 100) / 100
    : 0;

  // Subsídios especiais
  const subFerias = mes === 6  ? salarioBase : 0;
  const subNatal  = mes === 11 ? salarioBase : 0;

  // Bruto base (sem sub. especiais)
  const brutoBase   = Math.round((salarioBase + valorHE - descFaltas) * 100) / 100;
  const brutoAnual  = brutoBase * 14; // 12 + férias + natal

  const ssFunc     = Math.round(brutoBase * SS_FUNC * 100) / 100;
  const irs        = calcularIRS(brutoAnual);
  const ssEmpresa  = Math.round(brutoBase * SS_EMPRESA * 100) / 100;

  // Sub. alimentação mensal (dias úteis × valor diário)
  const subAlimMensal = Math.round(subAlimentacao * DIAS_UTEIS * 100) / 100;

  const totalAbonos    = Math.round((brutoBase + subAlimMensal + subFerias + subNatal) * 100) / 100;
  const totalDescontos = Math.round((ssFunc + irs) * 100) / 100;
  const liquido        = Math.round((totalAbonos - totalDescontos) * 100) / 100;

  return {
    mes,
    nome_mes:          MESES[mes - 1],
    salario_base:      salarioBase,
    horas_extra_valor: valorHE,
    sub_alimentacao:   subAlimMensal,
    sub_ferias:        subFerias,
    sub_natal:         subNatal,
    desc_faltas:       descFaltas,
    bruto_base:        brutoBase,
    total_abonos:      totalAbonos,
    ss_funcionario:    ssFunc,
    irs_retido:        irs,
    total_descontos:   totalDescontos,
    liquido,
    ss_empresa:        ssEmpresa,
    custo_empresa:     Math.round((brutoBase + ssEmpresa) * 100) / 100,
  };
}

/**
 * Simula os 12 meses completos
 */
function simular12Meses(params) {
  const meses = [];
  for (let m = 1; m <= 12; m++) {
    meses.push(calcularMes({ ...params, mes: m }));
  }

  const totais = meses.reduce((acc, m) => {
    for (const [k, v] of Object.entries(m)) {
      if (typeof v === 'number' && k !== 'mes') {
        acc[k] = Math.round(((acc[k] || 0) + v) * 100) / 100;
      }
    }
    return acc;
  }, {});

  return {
    meses,
    totais,
    resumo: {
      liquido_medio_mensal: Math.round((totais.liquido / 12) * 100) / 100,
      custo_total_empresa:  totais.custo_empresa,
      taxa_ss_func_pct:     11,
      taxa_ss_empresa_pct:  23.75,
    }
  };
}

// ── POST /api/simulador/calcular ──────────────────────────────────────────────
router.post('/calcular', autenticar, async (req, res) => {
  const { salario_base, sub_alimentacao = 7.63, horas_extra = 0, faltas = 0 } = req.body;
  if (!salario_base || salario_base < 870) {
    throw criarErro('Salário base mínimo: 870 € (SMN 2025)', 400);
  }
  const resultado = simular12Meses({
    salarioBase:    parseFloat(salario_base),
    subAlimentacao: parseFloat(sub_alimentacao),
    horasExtra:     parseFloat(horas_extra),
    faltas:         parseInt(faltas),
  });
  res.json(resultado);
});

// ── POST /api/simulador/proposta-pdf ─────────────────────────────────────────
router.post('/proposta-pdf', autenticar, async (req, res) => {
  const {
    candidato, cargo, empresa_candidato = '',
    salario_base, sub_alimentacao = 7.63,
    horas_extra = 0, data_inicio = '', validade = '30 dias',
  } = req.body;

  if (!candidato || !cargo || !salario_base) {
    throw criarErro('Candidato, cargo e salário são obrigatórios.', 400);
  }

  const sim = simular12Meses({
    salarioBase:    parseFloat(salario_base),
    subAlimentacao: parseFloat(sub_alimentacao),
    horasExtra:     parseFloat(horas_extra),
  });

  // Gerar PDF com pdf-lib (funciona no Node.js sem dependências nativas)
  const pdfDoc = await PDFDocument.create();
  const helvetica     = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const AZUL   = rgb(0.094, 0.373, 0.647);
  const VERDE  = rgb(0.114, 0.620, 0.459);
  const CINZA  = rgb(0.420, 0.447, 0.502);
  const LARANJA= rgb(0.961, 0.620, 0.043);
  const PRETO  = rgb(0.067, 0.094, 0.153);
  const BRANCO = rgb(1, 1, 1);
  const FUNDO  = rgb(0.973, 0.980, 0.988);
  const BORDA_C= rgb(0.898, 0.914, 0.929);

  const PW = 595.28, PH = 841.89;
  const ML = 42, MR = 42, MT = 30;

  // ── Página 1: Capa + Dados candidato + Meses 1-6 ─────────────────────────
  const pag1 = pdfDoc.addPage([PW, PH]);
  let y = PH - MT;

  function txt(page, text, x, yy, { font = helvetica, size = 9, color = PRETO } = {}) {
    page.drawText(String(text), { x, y: yy, size, font, color });
  }

  function rect(page, x, yy, w, h, { fill, stroke, sw = 0.5 } = {}) {
    const opts = { x, y: yy, width: w, height: h };
    if (fill)   page.drawRectangle({ ...opts, color: fill });
    if (stroke) page.drawRectangle({ ...opts, borderColor: stroke, borderWidth: sw });
  }

  function linha(page, x1, yy1, x2, yy2, { color = BORDA_C, sw = 0.5 } = {}) {
    page.drawLine({ start: { x: x1, y: yy1 }, end: { x: x2, y: yy2 }, thickness: sw, color });
  }

  const fmtEur = (v) => `${parseFloat(v || 0).toFixed(2).replace('.', ',')} EUR`;

  // ─── Cabeçalho azul ────────────────────────────────────────────────────────
  rect(pag1, 0, PH - 70, PW, 70, { fill: AZUL });
  txt(pag1, 'NexEdge', ML, PH - 45, { font: helveticaBold, size: 26, color: BRANCO });
  txt(pag1, 'Plataforma de Gestao de Recursos Humanos', ML, PH - 62, { font: helvetica, size: 9, color: rgb(0.8,0.9,1) });
  txt(pag1, 'PROPOSTA SALARIAL', PW - MR - 140, PH - 40, { font: helveticaBold, size: 14, color: BRANCO });
  const hoje = new Date().toLocaleDateString('pt-PT');
  txt(pag1, `Emitido em ${hoje}`, PW - MR - 140, PH - 58, { font: helvetica, size: 9, color: rgb(0.8,0.9,1) });
  y = PH - 86;

  // ─── Dados do candidato ────────────────────────────────────────────────────
  txt(pag1, 'DADOS DA PROPOSTA', ML, y, { font: helveticaBold, size: 8, color: AZUL });
  y -= 6;
  linha(pag1, ML, y, PW - MR, y, { color: AZUL, sw: 1 });
  y -= 16;

  const infos = [
    ['Candidato/a:', candidato,         'Cargo:',             cargo],
    ['Empresa:',     empresa_candidato || '—', 'Inicio previsto:',   data_inicio || '—'],
    ['Salario base:', fmtEur(salario_base),    'Validade da proposta:', validade],
  ];
  for (const [l1, v1, l2, v2] of infos) {
    rect(pag1, ML, y - 14, (PW - ML - MR) / 2 - 4, 22, { fill: FUNDO, stroke: BORDA_C });
    rect(pag1, ML + (PW - ML - MR) / 2, y - 14, (PW - ML - MR) / 2, 22, { fill: FUNDO, stroke: BORDA_C });
    txt(pag1, l1, ML + 6, y - 4, { font: helveticaBold, size: 7.5, color: CINZA });
    txt(pag1, v1, ML + 6, y - 13, { font: helveticaBold, size: 9, color: PRETO });
    txt(pag1, l2, ML + (PW - ML - MR) / 2 + 6, y - 4, { font: helveticaBold, size: 7.5, color: CINZA });
    txt(pag1, v2, ML + (PW - ML - MR) / 2 + 6, y - 13, { font: helveticaBold, size: 9, color: PRETO });
    y -= 26;
  }
  y -= 10;

  // ─── Tabela de meses ───────────────────────────────────────────────────────
  txt(pag1, 'PROJECAO ANUAL — 12 MESES', ML, y, { font: helveticaBold, size: 8, color: AZUL });
  y -= 6;
  linha(pag1, ML, y, PW - MR, y, { color: AZUL, sw: 1 });
  y -= 4;

  const TW = PW - ML - MR;
  const cols = [0.13, 0.11, 0.10, 0.11, 0.10, 0.115, 0.095, 0.095, 0.115];
  const colX = cols.reduce((acc, w, i) => {
    acc.push((acc[i] || ML) + (i > 0 ? cols[i-1] * TW : 0));
    return acc;
  }, [ML]);

  const cabHdr = ['Mes','Base','Sub.Alim','Sub.Fer','Sub.Nat','T.Abonos','IRS','SS(11%)','Liquido'];

  // Fundo cabeçalho
  rect(pag1, ML, y - 14, TW, 16, { fill: AZUL });
  for (let i = 0; i < cabHdr.length; i++) {
    txt(pag1, cabHdr[i], colX[i] + 2, y - 11, { font: helveticaBold, size: 7, color: BRANCO });
  }
  y -= 18;

  // Linhas dos meses (todos 12 numa ou duas páginas)
  function desenharMeses(page, mesesSlice, startY) {
    let yy = startY;
    for (const m of mesesSlice) {
      const especial = m.sub_ferias > 0 || m.sub_natal > 0;
      const bgCor = especial ? rgb(1, 0.984, 0.878) : (m.mes % 2 === 0 ? FUNDO : BRANCO);
      rect(page, ML, yy - 12, TW, 14, { fill: bgCor, stroke: BORDA_C, sw: 0.3 });

      const vals = [
        m.nome_mes + (especial ? ' *' : ''),
        fmtEur(m.salario_base),
        fmtEur(m.sub_alimentacao),
        m.sub_ferias > 0 ? fmtEur(m.sub_ferias) : '—',
        m.sub_natal  > 0 ? fmtEur(m.sub_natal)  : '—',
        fmtEur(m.total_abonos),
        `-${fmtEur(m.irs_retido)}`,
        `-${fmtEur(m.ss_funcionario)}`,
        fmtEur(m.liquido),
      ];
      const cores_vals = [PRETO, CINZA, CINZA, LARANJA, LARANJA, PRETO, rgb(0.89,0.29,0.29), rgb(0.89,0.29,0.29), VERDE];
      const fonts_vals = [helveticaBold, helvetica, helvetica, helveticaBold, helveticaBold, helveticaBold, helvetica, helvetica, helveticaBold];

      for (let i = 0; i < vals.length; i++) {
        txt(page, vals[i], colX[i] + 2, yy - 9, { font: fonts_vals[i], size: 7, color: cores_vals[i] });
      }
      yy -= 14;
    }
    return yy;
  }

  // Todos os 12 meses
  y = desenharMeses(pag1, sim.meses.slice(0, 12), y);
  y -= 4;

  // Linha de totais
  rect(pag1, ML, y - 14, TW, 16, { fill: AZUL });
  const totVals = [
    'TOTAL ANUAL',
    fmtEur(sim.totais.salario_base),
    fmtEur(sim.totais.sub_alimentacao),
    fmtEur(sim.totais.sub_ferias),
    fmtEur(sim.totais.sub_natal),
    fmtEur(sim.totais.total_abonos),
    fmtEur(sim.totais.irs_retido),
    fmtEur(sim.totais.ss_funcionario),
    fmtEur(sim.totais.liquido),
  ];
  for (let i = 0; i < totVals.length; i++) {
    txt(pag1, totVals[i], colX[i] + 2, y - 11, { font: helveticaBold, size: 7, color: BRANCO });
  }
  y -= 22;

  // ─── Resumo financeiro ────────────────────────────────────────────────────
  txt(pag1, 'RESUMO FINANCEIRO', ML, y, { font: helveticaBold, size: 8, color: AZUL });
  y -= 6;
  linha(pag1, ML, y, PW - MR, y, { color: AZUL, sw: 1 });
  y -= 16;

  const HM = (PW - ML - MR) / 2 - 4;
  const resumoItens = [
    ['Salario Bruto Mensal',   fmtEur(salario_base),       'Liquido Medio Mensal',    fmtEur(sim.resumo.liquido_medio_mensal)],
    ['Sub. Alimentacao/dia',   fmtEur(sub_alimentacao),    'Liquido Total Anual',      fmtEur(sim.totais.liquido)],
    ['Subsidio de Ferias',     fmtEur(salario_base),       'Custo Total Empresa/Ano',  fmtEur(sim.resumo.custo_total_empresa)],
    ['Subsidio de Natal',      fmtEur(salario_base),       'SS Empresa (23,75%/ano)',  fmtEur(sim.totais.ss_empresa)],
  ];
  for (const [l1, v1, l2, v2] of resumoItens) {
    rect(pag1, ML, y - 14, HM, 22, { fill: FUNDO, stroke: BORDA_C });
    rect(pag1, ML + HM + 4, y - 14, HM, 22, { fill: FUNDO, stroke: BORDA_C });
    txt(pag1, l1, ML + 6, y - 4, { font: helvetica, size: 7.5, color: CINZA });
    txt(pag1, v1, ML + 6, y - 13, { font: helveticaBold, size: 9, color: AZUL });
    txt(pag1, l2, ML + HM + 10, y - 4, { font: helvetica, size: 7.5, color: CINZA });
    txt(pag1, v2, ML + HM + 10, y - 13, { font: helveticaBold, size: 9, color: AZUL });
    y -= 26;
  }
  y -= 10;

  // ─── Notas legais ─────────────────────────────────────────────────────────
  linha(pag1, ML, y, PW - MR, y, { color: BORDA_C });
  y -= 10;
  const notas = [
    '* Meses destacados incluem subsidio de ferias (junho) ou subsidio de Natal (novembro)',
    'IRS calculado por taxa media 2025 (regime geral, sem dependentes) | SS trabalhador: 11% | SS empresa: 23,75%',
    'Subsidio de alimentacao isento de SS e IRS ate 7,63 EUR/dia (cartao refeicao)',
    'Simulacao gerada pelo NexEdge. Codigo do Trabalho e legislacao fiscal portuguesa 2025.',
    'Esta proposta tem caracter indicativo. Valores finais dependem da situacao fiscal do candidato.',
  ];
  for (const n of notas) {
    txt(pag1, `• ${n}`, ML, y, { font: helvetica, size: 7, color: CINZA });
    y -= 10;
  }

  // ─── Rodapé ───────────────────────────────────────────────────────────────
  linha(pag1, ML, 30, PW - MR, 30, { color: BORDA_C });
  txt(pag1, `NexEdge · Plataforma de Gestao de Recursos Humanos · nexedge.pt · Documento gerado automaticamente`, ML, 18, {
    font: helvetica, size: 7, color: CINZA
  });

  // Serializar e enviar
  const pdfBytes = await pdfDoc.save();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition',
    `attachment; filename="NexEdge_Proposta_${candidato.replace(/\s/g,'_')}_${new Date().toISOString().split('T')[0]}.pdf"`);
  res.send(Buffer.from(pdfBytes));
});

// ── GET /api/simulador/regras ─────────────────────────────────────────────────
router.get('/regras', autenticar, async (req, res) => {
  res.json({
    smn_2025: 870,
    ss_funcionario_pct: 11,
    ss_empresa_pct: 23.75,
    he_1hora_pct: 25,
    he_seguintes_pct: 37.5,
    he_descanso_pct: 50,
    trabalho_noturno_pct: 25,
    ferias_dias_ano: 22,
    sub_ferias_mes: 6,
    sub_natal_mes: 11,
    irs_tabelas: TABELAS_IRS,
    dias_uteis_mes: DIAS_UTEIS,
  });
});

module.exports = router;
module.exports.simular12Meses = simular12Meses;
