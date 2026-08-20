'use strict';

/**
 * Tabelas de Retenção na Fonte — IRS 2026
 * Fonte: Despacho n.º 233-A/2026 — Portal das Finanças
 * Vigência: a partir de 1 de janeiro de 2026
 *
 * Fórmula: (Remuneração × Taxa Marginal) - Parcela a Abater - (Parcela por Dependente × nº Dependentes)
 *
 * Tabelas implementadas:
 *   I   — não casado sem dependentes OU casado dois titulares
 *   II  — não casado com um ou mais dependentes
 *   III — casado único titular
 *   IV  — não casado/casado 2 titulares sem dependentes — deficiente
 *   V   — não casado com dependentes — deficiente
 *   VII — casado único titular — deficiente
 *
 * Atenção: para os escalões 2 e 3 da Tab I/II a parcela usa fórmula variável.
 * Ver calcularIRS() para lógica completa.
 */

// Tabela I / II — partilhadas (só a parcela por dependente difere: 21,43 vs 34,29)
const TABELA_I_ESCALOES = [
  { ate: 920,    taxa: 0.0000, tipo_parcela: 'fixo', parcela: 0 },
  // Escalão 2: parcela = 12,50% × 2,60 × (1273,85 - R)
  { ate: 1042,   taxa: 0.1250, tipo_parcela: 'variavel', a: 0.1250, b: 2.60, c: 1273.85 },
  // Escalão 3: parcela = 15,70% × 1,35 × (1554,83 - R)
  { ate: 1108,   taxa: 0.1570, tipo_parcela: 'variavel', a: 0.1570, b: 1.35, c: 1554.83 },
  { ate: 1154,   taxa: 0.1570, tipo_parcela: 'fixo', parcela: 94.71 },
  { ate: 1212,   taxa: 0.2120, tipo_parcela: 'fixo', parcela: 158.18 },
  { ate: 1819,   taxa: 0.2410, tipo_parcela: 'fixo', parcela: 193.33 },
  { ate: 2119,   taxa: 0.3110, tipo_parcela: 'fixo', parcela: 320.66 },
  { ate: 2499,   taxa: 0.3490, tipo_parcela: 'fixo', parcela: 401.19 },
  { ate: 3305,   taxa: 0.3836, tipo_parcela: 'fixo', parcela: 487.66 },
  { ate: 5547,   taxa: 0.3969, tipo_parcela: 'fixo', parcela: 531.62 },
  { ate: 20221,  taxa: 0.4495, tipo_parcela: 'fixo', parcela: 823.40 },
  { ate: Infinity, taxa: 0.4717, tipo_parcela: 'fixo', parcela: 1272.31 },
];

// Tabela III — casado único titular
const TABELA_III_ESCALOES = [
  { ate: 991,    taxa: 0.0000, tipo_parcela: 'fixo', parcela: 0 },
  // Escalão 2: 12,50% × 2,6 × (1372,15 - R)
  { ate: 1042,   taxa: 0.1250, tipo_parcela: 'variavel', a: 0.1250, b: 2.6, c: 1372.15 },
  // Escalão 3: 12,50% × 1,35 × (1677,85 - R)
  { ate: 1108,   taxa: 0.1250, tipo_parcela: 'variavel', a: 0.1250, b: 1.35, c: 1677.85 },
  { ate: 1119,   taxa: 0.1250, tipo_parcela: 'fixo', parcela: 96.17 },
  { ate: 1432,   taxa: 0.1272, tipo_parcela: 'fixo', parcela: 98.64 },
  { ate: 1962,   taxa: 0.1570, tipo_parcela: 'fixo', parcela: 141.32 },
  { ate: 2240,   taxa: 0.1938, tipo_parcela: 'fixo', parcela: 213.53 },
  { ate: 2773,   taxa: 0.2277, tipo_parcela: 'fixo', parcela: 289.47 },
  { ate: 3389,   taxa: 0.2570, tipo_parcela: 'fixo', parcela: 370.72 },
  { ate: 5965,   taxa: 0.2881, tipo_parcela: 'fixo', parcela: 476.12 },
  { ate: 20265,  taxa: 0.3843, tipo_parcela: 'fixo', parcela: 1049.96 },
  { ate: Infinity, taxa: 0.4717, tipo_parcela: 'fixo', parcela: 2821.13 },
];

// Tabela IV — deficiente, não casado ou casado 2 titulares, sem dependentes
const TABELA_IV_ESCALOES = [
  { ate: 1694,   taxa: 0.0000, tipo_parcela: 'fixo', parcela: 0 },
  { ate: 2063,   taxa: 0.2120, tipo_parcela: 'fixo', parcela: 359.13 },
  { ate: 2492,   taxa: 0.3110, tipo_parcela: 'fixo', parcela: 563.37 },
  { ate: 4487,   taxa: 0.3490, tipo_parcela: 'fixo', parcela: 658.07 },
  { ate: 4753,   taxa: 0.3836, tipo_parcela: 'fixo', parcela: 813.33 },
  { ate: 6687,   taxa: 0.3969, tipo_parcela: 'fixo', parcela: 876.55 },
  { ate: 20468,  taxa: 0.4495, tipo_parcela: 'fixo', parcela: 1228.29 },
  { ate: Infinity, taxa: 0.4717, tipo_parcela: 'fixo', parcela: 1682.68 },
];

// Tabela VII — deficiente, casado único titular
const TABELA_VII_ESCALOES = [
  { ate: 2325,   taxa: 0.0000, tipo_parcela: 'fixo', parcela: 0 },
  { ate: 3494,   taxa: 0.2277, tipo_parcela: 'fixo', parcela: 529.41 },
  { ate: 3761,   taxa: 0.2570, tipo_parcela: 'fixo', parcela: 631.79 },
  { ate: 6687,   taxa: 0.2881, tipo_parcela: 'fixo', parcela: 748.76 },
  { ate: 20468,  taxa: 0.4244, tipo_parcela: 'fixo', parcela: 1660.20 },
  { ate: Infinity, taxa: 0.4717, tipo_parcela: 'fixo', parcela: 2628.34 },
];

function calcularParcela(escalao, R) {
  if (escalao.tipo_parcela === 'fixo') return escalao.parcela;
  // variavel: parcela = a × b × (c - R)
  return escalao.a * escalao.b * (escalao.c - R);
}

function encontrarEscalao(tabela, R) {
  return tabela.find(e => R <= e.ate);
}

/**
 * Calcula a retenção na fonte de IRS
 * @param {number} salarioBruto - Remuneração mensal bruta
 * @param {string} estadoCivil - 'nao_casado' | 'casado_unico_titular' | 'casado_dois_titulares'
 * @param {number} numDependentes - Número de dependentes (0, 1, 2, ...)
 * @param {boolean} deficiencia - Grau de incapacidade >= 60%
 * @param {boolean} irsJovem - Regime IRS Jovem activo
 * @param {number} irsJovemAno - Ano de trabalho para o regime IRS Jovem (1 a 10)
 * @returns {number} Valor da retenção em euros (arredondado à unidade inferior)
 */
function calcularIRS(salarioBruto, estadoCivil = 'nao_casado', numDependentes = 0, deficiencia = false, irsJovem = false, irsJovemAno = 1) {
  const R = salarioBruto;

  let tabela, parcelaAdicional;

  if (deficiencia) {
    if (estadoCivil === 'casado_unico_titular') {
      tabela = TABELA_VII_ESCALOES;
      parcelaAdicional = 42.86;
    } else {
      tabela = TABELA_IV_ESCALOES;
      parcelaAdicional = (estadoCivil === 'casado_dois_titulares') ? 21.43 : 34.29;
    }
  } else if (estadoCivil === 'casado_unico_titular') {
    tabela = TABELA_III_ESCALOES;
    parcelaAdicional = 42.86;
  } else if (numDependentes > 0) {
    // Tabela II — não casado com dependentes
    tabela = TABELA_I_ESCALOES;
    parcelaAdicional = 34.29;
  } else {
    // Tabela I — não casado sem dependentes OU casado dois titulares
    tabela = TABELA_I_ESCALOES;
    parcelaAdicional = 21.43;
  }

  const escalao = encontrarEscalao(tabela, R);
  if (!escalao || escalao.taxa === 0) return 0;

  const parcela = calcularParcela(escalao, R);
  
  let taxa = escalao.taxa;

  // 3 ou mais dependentes: redução de 1 ponto percentual na taxa marginal
  if (numDependentes >= 3) taxa = Math.max(0, taxa - 0.01);

  let retencao = (R * taxa) - parcela - (parcelaAdicional * numDependentes);

  // Deficiência no dependente: +84,82 (não casado/casado único) ou +42,41 (casado 2 titulares) por dependente
  // Simplificação: não implementado (exige flag por dependente)

  // IRS Jovem: isenção progressiva por ano de trabalho
  if (irsJovem && irsJovemAno >= 1 && irsJovemAno <= 10) {
    const percentagens = [1.00, 0.75, 0.50, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25];
    const isencao = percentagens[irsJovemAno - 1] || 0;
    retencao = retencao * (1 - isencao);
  }

  // Não pode ser negativo; arredonda à unidade inferior
  return Math.max(0, Math.floor(retencao));
}

/**
 * Calcula contribuições à Segurança Social
 */
function calcularSS(salarioBruto, tipoContrato = 'sem_termo') {
  const TAXA_FUNCIONARIO = 0.11;   // 11%
  const TAXA_EMPRESA     = 0.2375; // 23,75%
  const FCT              = 0.00925;
  const FGCT             = 0.00075;

  // Estágio IEFP: taxa reduzida para empresa (2% nos primeiros 12 meses)
  const taxaEmpresaEfetiva = tipoContrato === 'estagio_iefp' ? 0.02 : TAXA_EMPRESA;

  return {
    funcionario: Math.round(salarioBruto * TAXA_FUNCIONARIO * 100) / 100,
    empresa:     Math.round(salarioBruto * taxaEmpresaEfetiva * 100) / 100,
    fct:         tipoContrato === 'sem_termo' ? Math.round(salarioBruto * FCT * 100) / 100 : 0,
    fgct:        tipoContrato === 'sem_termo' ? Math.round(salarioBruto * FGCT * 100) / 100 : 0,
  };
}

/**
 * Valor diário de subsídio de alimentação isento de IRS/SS
 */
const SUBSIDIO_ALIMENTACAO = {
  dinheiro: 6.15,   // €/dia — isento até este valor
  cartao:   10.46,  // €/dia em cartão refeição — isento até este valor
};

/**
 * Salário Mínimo Nacional 2026
 */
const SALARIO_MINIMO = 920;

module.exports = {
  calcularIRS,
  calcularSS,
  SUBSIDIO_ALIMENTACAO,
  SALARIO_MINIMO,
};
