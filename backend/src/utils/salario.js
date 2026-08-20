'use strict';

// Usar tabelas IRS 2026 oficiais já implementadas
const { calcularIRS: calcularIRSOficial } = require('../services/tabelasIRS2025');

// ══════════════════════════════════════════════════════════════════════════════
// TABELAS IRS 2026 — Portugal Continental (referência)
// Fonte: AT — Despacho das tabelas de retenção na fonte 2026
// ══════════════════════════════════════════════════════════════════════════════

// Tabela IRS mensal para trabalhadores dependentes (não casados)
// [rendimento_max, taxa_marginal, parcela_abater]
const TABELA_IRS_SOLTEIRO = [
  [792,    0,      0],
  [820,    0.1400, 110.88],
  [935,    0.1650, 131.43],
  [1001,   0.2300, 192.14],
  [1123,   0.2600, 222.17],
  [1765,   0.3300, 300.78],
  [2057,   0.3450, 327.27],
  [2664,   0.3700, 378.69],
  [3193,   0.4300, 538.53],
  [4007,   0.4500, 602.39],
  [5192,   0.4800, 722.60],
  [7057,   0.5050, 852.24],
  [Infinity, 0.5300, 1028.98],
];

// Tabela IRS para casados/união de facto (1 titular)
const TABELA_IRS_CASADO_1 = [
  [792,    0,      0],
  [820,    0.1400, 110.88],
  [935,    0.1650, 131.43],
  [1001,   0.2300, 192.14],
  [1123,   0.2600, 222.17],
  [1765,   0.3300, 300.78],
  [2057,   0.3200, 282.27],
  [2664,   0.3500, 345.81],
  [3193,   0.4100, 505.65],
  [4007,   0.4300, 569.51],
  [5192,   0.4550, 669.54],
  [7057,   0.4800, 799.18],
  [Infinity, 0.5050, 975.86],
];

// Tabela IRS para casados (2 titulares)
const TABELA_IRS_CASADO_2 = [
  [1584,   0,      0],
  [1640,   0.1400, 221.76],
  [1870,   0.1650, 262.86],
  [2002,   0.2300, 384.28],
  [2246,   0.2600, 444.34],
  [3530,   0.3300, 601.56],
  [4114,   0.3200, 564.54],
  [5328,   0.3500, 691.62],
  [6386,   0.4100, 1011.30],
  [8014,   0.4300, 1139.02],
  [10384,  0.4550, 1339.08],
  [14114,  0.4800, 1598.36],
  [Infinity, 0.5050, 1951.72],
];

// Dependentes — redução por dependente (mensal)
const REDUCAO_DEPENDENTE = 21.0;

// Taxas Segurança Social 2026
const SS_TRABALHADOR = 0.11;   // 11%
const SS_ENTIDADE    = 0.2375; // 23,75%

// Salário mínimo nacional 2026
const SMN_2026 = 870.00;

// Subsídio de alimentação 2026
const SUB_ALIMENTACAO_DINHEIRO    = 6.00;  // €/dia — isento até este valor
const SUB_ALIMENTACAO_VALE        = 9.60;  // €/dia — isento até este valor (vale refeição)
const DIAS_UTEIS_MES              = 22;    // média mensal

// Horas extra — majorações legais (CT art. 268.º)
const MAJORACAO_HORAS_EXTRA_1_2H  = 0.25; // +25% primeiras 2h/dia
const MAJORACAO_HORAS_EXTRA_PLUS  = 0.375;// +37,5% horas seguintes
const MAJORACAO_FERIADO            = 0.50; // +50% trabalho em feriado
const MAJORACAO_NOCTURNO           = 0.25; // +25% trabalho nocturno (20h-7h)

// ══════════════════════════════════════════════════════════════════════════════
// FUNÇÃO: Calcular retenção IRS (usa tabelas oficiais 2026)
// ══════════════════════════════════════════════════════════════════════════════
function calcularIRS(rendimentoMensal, estadoCivil, numDependentes, titular2 = false) {
  try {
    return calcularIRSOficial(rendimentoMensal, estadoCivil, numDependentes, false, false);
  } catch(e) {
    // Fallback simples se houver erro
    if (rendimentoMensal <= 920) return 0;
    return Math.max(0, Math.round(rendimentoMensal * 0.25 * 100) / 100);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// FUNÇÃO: Calcular processamento salarial completo
// ══════════════════════════════════════════════════════════════════════════════
function calcularSalario(funcionario, opcoes = {}) {
  const {
    horas_extra_25 = 0,   // horas extra com majoração 25%
    horas_extra_375 = 0,  // horas extra com majoração 37,5%
    horas_feriado = 0,    // horas em feriado
    horas_nocturnas = 0,  // horas nocturnas
    faltas_dias = 0,      // dias de falta injustificada
    faltas_horas = 0,     // horas de falta
    sub_alimentacao_tipo = 'dinheiro', // 'dinheiro' | 'vale' | 'nenhum'
    dias_trabalhados = DIAS_UTEIS_MES,
    outros_abonos = [],   // [{descricao, valor, tributavel}]
    outros_descontos = [], // [{descricao, valor}]
    adiantamento = 0,
  } = opcoes;

  const salarioBase = parseFloat(funcionario.salario_base || 0);
  const estadoCivil = funcionario.estado_civil || 'solteiro';
  const numDependentes = parseInt(funcionario.num_dependentes || 0);
  const titular2 = funcionario.conjuge_trabalha === true;

  // ── 1. ABONOS ──────────────────────────────────────────────────────────────

  // Valor hora (salário base / 30 dias / 8 horas) — CT
  const valorHora = salarioBase / 30 / 8;

  // Subsídio de alimentação
  let subAlim = 0;
  let subAlimTributavel = 0;
  const limiteIsencao = sub_alimentacao_tipo === 'vale'
    ? SUB_ALIMENTACAO_VALE
    : SUB_ALIMENTACAO_DINHEIRO;

  if (sub_alimentacao_tipo !== 'nenhum') {
    const valorDia = parseFloat(funcionario.subsidio_alimentacao_dia || limiteIsencao);
    subAlim = valorDia * dias_trabalhados;
    const isencaoDia = limiteIsencao * dias_trabalhados;
    subAlimTributavel = Math.max(0, subAlim - isencaoDia);
  }

  // Horas extra
  const valorHorasExtra25  = horas_extra_25  * valorHora * (1 + MAJORACAO_HORAS_EXTRA_1_2H);
  const valorHorasExtra375 = horas_extra_375 * valorHora * (1 + MAJORACAO_HORAS_EXTRA_PLUS);
  const valorFeriados      = horas_feriado   * valorHora * (1 + MAJORACAO_FERIADO);
  const valorNocturno      = horas_nocturnas * valorHora * MAJORACAO_NOCTURNO; // só a majoração
  const totalHorasExtra    = valorHorasExtra25 + valorHorasExtra375 + valorFeriados + valorNocturno;

  // Outros abonos
  const totalOutrosAbonos = outros_abonos.reduce((s, a) => s + parseFloat(a.valor || 0), 0);
  const outrosAbonosTributaveis = outros_abonos
    .filter(a => a.tributavel !== false)
    .reduce((s, a) => s + parseFloat(a.valor || 0), 0);

  // Total abonos brutos
  const totalAbonos = salarioBase + subAlim + totalHorasExtra + totalOutrosAbonos;

  // ── 2. BASE TRIBUTÁVEL ─────────────────────────────────────────────────────
  // Base para IRS e SS = salário base + horas extra + abonos tributáveis + excesso subsídio alimentação
  const baseTributavel = salarioBase + totalHorasExtra + subAlimTributavel + outrosAbonosTributaveis;

  // ── 3. DESCONTOS ───────────────────────────────────────────────────────────

  // Segurança Social (sobre base tributável)
  const segSocialFunc = Math.round(baseTributavel * SS_TRABALHADOR * 100) / 100;

  // IRS (sobre rendimento bruto mensal tributável)
  const irsRetido = calcularIRS(baseTributavel, estadoCivil, numDependentes, titular2);

  // Faltas (desconto proporcional ao salário base)
  const descontoFaltas = faltas_dias > 0
    ? Math.round((salarioBase / 30) * faltas_dias * 100) / 100
    : Math.round(valorHora * faltas_horas * 100) / 100;

  // Outros descontos
  const totalOutrosDescontos = outros_descontos.reduce((s, d) => s + parseFloat(d.valor || 0), 0);

  // Total descontos
  const totalDescontos = segSocialFunc + irsRetido + descontoFaltas + totalOutrosDescontos + adiantamento;

  // ── 4. ENCARGOS DA ENTIDADE ────────────────────────────────────────────────
  const segSocialEntidade = Math.round(baseTributavel * SS_ENTIDADE * 100) / 100;
  const custoTotalEntidade = totalAbonos + segSocialEntidade;

  // ── 5. LÍQUIDO ─────────────────────────────────────────────────────────────
  const liquido = Math.round((totalAbonos - totalDescontos) * 100) / 100;

  // ── 6. RECIBO DETALHADO ────────────────────────────────────────────────────
  return {
    // Identificação
    funcionario_id: funcionario.id,
    nome_completo: funcionario.nome_completo,
    cargo: funcionario.cargo,
    nif: funcionario.nif,
    niss: funcionario.niss,

    // Abonos
    salario_base: salarioBase,
    subsidio_alimentacao: subAlim,
    subsidio_alimentacao_tributavel: subAlimTributavel,
    horas_extra_valor: Math.round(totalHorasExtra * 100) / 100,
    horas_extra_25_valor: Math.round(valorHorasExtra25 * 100) / 100,
    horas_extra_375_valor: Math.round(valorHorasExtra375 * 100) / 100,
    feriados_valor: Math.round(valorFeriados * 100) / 100,
    nocturno_valor: Math.round(valorNocturno * 100) / 100,
    outros_abonos,
    total_abonos: Math.round(totalAbonos * 100) / 100,

    // Base tributável
    base_tributavel: Math.round(baseTributavel * 100) / 100,

    // Descontos
    seg_social_func: segSocialFunc,
    irs_retido: irsRetido,
    faltas_desconto: descontoFaltas,
    outros_descontos,
    adiantamento: parseFloat(adiantamento),
    total_descontos: Math.round(totalDescontos * 100) / 100,

    // Encargos entidade
    seg_social_entidade: segSocialEntidade,
    custo_total_entidade: Math.round(custoTotalEntidade * 100) / 100,

    // Resultado
    liquido,

    // Detalhes de cálculo (para o recibo)
    detalhes: {
      valor_hora: Math.round(valorHora * 100) / 100,
      taxa_ss_func: SS_TRABALHADOR * 100,
      taxa_ss_entidade: SS_ENTIDADE * 100,
      horas_extra_25,
      horas_extra_375,
      horas_feriado,
      horas_nocturnas,
      faltas_dias,
      faltas_horas,
      dias_trabalhados,
      sub_alimentacao_tipo,
      estado_civil: estadoCivil,
      num_dependentes: numDependentes,
    }
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// FUNÇÃO: Simular recibo (sem guardar na BD)
// ══════════════════════════════════════════════════════════════════════════════
function simularRecibo(funcionario, opcoes = {}) {
  return calcularSalario(funcionario, opcoes);
}

// ══════════════════════════════════════════════════════════════════════════════
// FUNÇÃO: Verificar conformidade com SMN
// ══════════════════════════════════════════════════════════════════════════════
function verificarSMN(salarioBase) {
  if (salarioBase < SMN_2026) {
    return {
      conforme: false,
      mensagem: `Salário base (${salarioBase}€) abaixo do SMN 2026 (${SMN_2026}€)`,
      smn: SMN_2026,
    };
  }
  return { conforme: true, smn: SMN_2026 };
}

module.exports = {
  calcularSalario,
  simularRecibo,
  calcularIRS,
  verificarSMN,
  SMN_2026,
  SS_TRABALHADOR,
  SS_ENTIDADE,
  TABELA_IRS_SOLTEIRO,
  DIAS_UTEIS_MES,
};
