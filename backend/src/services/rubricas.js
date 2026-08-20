'use strict';

/**
 * RUBRICAS SALARIAIS PORTUGAL 2025
 * Fonte: Portaria n.º 33/2024 (DMR-AT) e Despacho N.º 2-I/SESS/2011 (DR-SS)
 * 
 * Cada rubrica tem:
 *   codigo_at   — código para Declaração Mensal de Remunerações (AT)
 *   codigo_ss   — código para Declaração de Remunerações (Segurança Social)
 *   descricao   — descrição que aparece no recibo
 *   sujeito_irs — se incide IRS
 *   sujeito_ss  — se incide Segurança Social
 *   limite_isencao — valor isento mensal (null = sem limite)
 *   tipo        — 'abono' ou 'desconto'
 */

const RUBRICAS = {

  // ── ABONOS ──────────────────────────────────────────────────────────────────

  // Remuneração base — sempre presente
  REMUNERACAO_BASE: {
    codigo_at: 'A',
    codigo_ss: 'P',
    descricao: 'Remuneração Base',
    sujeito_irs: true,
    sujeito_ss: true,
    limite_isencao: null,
    tipo: 'abono',
    obrigatorio: true,
  },

  // Diuturnidades — aumentos por antiguidade (CCT)
  DIUTURNIDADES: {
    codigo_at: 'A',
    codigo_ss: 'P',
    descricao: 'Diuturnidades',
    sujeito_irs: true,
    sujeito_ss: true,
    limite_isencao: null,
    tipo: 'abono',
  },

  // Isenção de Horário de Trabalho
  ISENCAO_HORARIO: {
    codigo_at: 'A',
    codigo_ss: 'P',
    descricao: 'Isenção de Horário de Trabalho',
    sujeito_irs: true,
    sujeito_ss: true,
    limite_isencao: null,
    tipo: 'abono',
  },

  // Horas extraordinárias
  HORAS_EXTRA: {
    codigo_at: 'A',
    codigo_ss: 'P',
    descricao: 'Horas Extraordinárias',
    sujeito_irs: true,
    sujeito_ss: true,
    limite_isencao: null,
    tipo: 'abono',
  },

  // Trabalho nocturno (22h-7h) — acréscimo mínimo 25% CT art. 266.º
  TRABALHO_NOCTURNO: {
    codigo_at: 'A',
    codigo_ss: 'P',
    descricao: 'Trabalho Nocturno',
    sujeito_irs: true,
    sujeito_ss: true,
    limite_isencao: null,
    tipo: 'abono',
  },

  // Subsídio de turno
  SUBSIDIO_TURNO: {
    codigo_at: 'A',
    codigo_ss: 'P',
    descricao: 'Subsídio de Turno',
    sujeito_irs: true,
    sujeito_ss: true,
    limite_isencao: null,
    tipo: 'abono',
  },

  // Subsídio de risco / penosidade / insalubridade
  SUBSIDIO_RISCO: {
    codigo_at: 'A',
    codigo_ss: 'P',
    descricao: 'Subsídio de Risco/Penosidade/Insalubridade',
    sujeito_irs: true,
    sujeito_ss: true,
    limite_isencao: null,
    tipo: 'abono',
  },

  // Subsídio de chefia / responsabilidade
  SUBSIDIO_CHEFIA: {
    codigo_at: 'A',
    codigo_ss: 'P',
    descricao: 'Subsídio de Chefia/Responsabilidade',
    sujeito_irs: true,
    sujeito_ss: true,
    limite_isencao: null,
    tipo: 'abono',
  },

  // Comissões de vendas
  COMISSOES: {
    codigo_at: 'A',
    codigo_ss: 'P',
    descricao: 'Comissões',
    sujeito_irs: true,
    sujeito_ss: true,
    limite_isencao: null,
    tipo: 'abono',
  },

  // Prémio de desempenho/produtividade — até 6% da retribuição base anual isento (A41)
  PREMIO_DESEMPENHO: {
    codigo_at: 'A41', // parte isenta; parte sujeita vai para A
    codigo_ss: 'B',
    descricao: 'Prémio de Desempenho/Produtividade',
    sujeito_irs: true, // parcialmente — calcular limite
    sujeito_ss: true,
    limite_isencao: null, // calculado dinamicamente: 6% salário base anual
    tipo: 'abono',
    nota: 'Parte isenta até 6% retribuição base anual — código A41. Parte sujeita — código A.',
  },

  // Subsídio de Férias — código próprio A3
  SUBSIDIO_FERIAS: {
    codigo_at: 'A3',
    codigo_ss: 'F',
    descricao: 'Subsídio de Férias',
    sujeito_irs: true,
    sujeito_ss: true,
    limite_isencao: null,
    tipo: 'abono',
  },

  // Subsídio de Natal — código próprio A4
  SUBSIDIO_NATAL: {
    codigo_at: 'A4',
    codigo_ss: 'N',
    descricao: 'Subsídio de Natal',
    sujeito_irs: true,
    sujeito_ss: true,
    limite_isencao: null,
    tipo: 'abono',
  },

  // Subsídio de alimentação — parte sujeita em A; parte isenta em A21
  // Limite de isenção 2025: 6,15€/dia (em dinheiro); 10,46€/dia (em cartão/voucher)
  SUBSIDIO_ALIMENTACAO_SUJEITO: {
    codigo_at: 'A',
    codigo_ss: 'R',
    descricao: 'Subsídio de Refeição (parte sujeita)',
    sujeito_irs: true,
    sujeito_ss: true,
    limite_isencao: null,
    tipo: 'abono',
  },
  SUBSIDIO_ALIMENTACAO_ISENTO: {
    codigo_at: 'A21',
    codigo_ss: null, // isento SS
    descricao: 'Subsídio de Refeição (parte isenta)',
    sujeito_irs: false,
    sujeito_ss: false,
    limite_isencao: { dinheiro: 6.15, cartao: 10.46 }, // por dia útil
    tipo: 'abono',
  },

  // Ajudas de custo — parte isenta A22; parte sujeita A
  AJUDAS_CUSTO_ISENTO: {
    codigo_at: 'A22',
    codigo_ss: null,
    descricao: 'Ajudas de Custo (parte isenta)',
    sujeito_irs: false,
    sujeito_ss: false,
    limite_isencao: { nacional: 50.20, internacional: 89.35 }, // por dia
    tipo: 'abono',
  },
  AJUDAS_CUSTO_SUJEITO: {
    codigo_at: 'A',
    codigo_ss: 'P',
    descricao: 'Ajudas de Custo (parte sujeita)',
    sujeito_irs: true,
    sujeito_ss: true,
    limite_isencao: null,
    tipo: 'abono',
  },

  // Quilómetros em viatura própria — parte isenta A22
  KMS_VIATURA_PROPRIA: {
    codigo_at: 'A22',
    codigo_ss: null,
    descricao: 'Deslocações em Viatura Própria',
    sujeito_irs: false,
    sujeito_ss: false,
    limite_isencao: 0.40, // €/km
    tipo: 'abono',
  },

  // Abono para falhas — parte isenta A23
  ABONO_FALHAS_ISENTO: {
    codigo_at: 'A23',
    codigo_ss: null,
    descricao: 'Abono para Falhas (parte isenta)',
    sujeito_irs: false,
    sujeito_ss: false,
    limite_isencao: 122.96, // mensual 2025 (5% do SMN)
    tipo: 'abono',
  },
  ABONO_FALHAS_SUJEITO: {
    codigo_at: 'A',
    codigo_ss: 'P',
    descricao: 'Abono para Falhas (parte sujeita)',
    sujeito_irs: true,
    sujeito_ss: true,
    limite_isencao: null,
    tipo: 'abono',
  },

  // Teletrabalho — compensação de despesas — parte isenta A27
  TELETRABALHO_ISENTO: {
    codigo_at: 'A27',
    codigo_ss: null,
    descricao: 'Compensação Teletrabalho (parte isenta)',
    sujeito_irs: false,
    sujeito_ss: false,
    limite_isencao: 1.00, // €/dia de teletrabalho efectivo
    tipo: 'abono',
  },

  // Utilização de viatura da empresa para fins pessoais — A66 (sujeita)
  VIATURA_EMPRESA: {
    codigo_at: 'A66',
    codigo_ss: 'P',
    descricao: 'Utilização de Viatura da Empresa (uso pessoal)',
    sujeito_irs: true,
    sujeito_ss: true,
    limite_isencao: null,
    tipo: 'abono',
    nota: 'Valor = 0,75% do valor aquisição viatura por mês',
  },

  // Habitação fornecida pela empresa — A40 (parte isenta) + A63 (parte sujeita)
  HABITACAO_EMPRESA_ISENTO: {
    codigo_at: 'A40',
    codigo_ss: null,
    descricao: 'Habitação Fornecida pela Empresa (parte isenta)',
    sujeito_irs: false,
    sujeito_ss: false,
    limite_isencao: null, // limite = renda máxima PAA do concelho
    tipo: 'abono',
  },
  HABITACAO_EMPRESA_SUJEITO: {
    codigo_at: 'A63',
    codigo_ss: 'P',
    descricao: 'Habitação Fornecida pela Empresa (parte sujeita)',
    sujeito_irs: true,
    sujeito_ss: true,
    limite_isencao: null,
    tipo: 'abono',
  },

  // IRS Jovem — regime especial isenção total/parcial — A68
  IRS_JOVEM: {
    codigo_at: 'A68',
    codigo_ss: 'P', // SS incide normalmente
    descricao: 'Remuneração — Regime IRS Jovem',
    sujeito_irs: false, // isento conforme ano do benefício
    sujeito_ss: true,
    limite_isencao: null,
    tipo: 'abono',
    nota: 'Ano 1: 100% isento. Ano 2: 75%. Ano 3: 50%. Ano 4: 25%.',
  },

  // Retroativos salariais
  RETROATIVOS: {
    codigo_at: 'A',
    codigo_ss: '6',
    descricao: 'Retroativos Salariais',
    sujeito_irs: true,
    sujeito_ss: true,
    limite_isencao: null,
    tipo: 'abono',
  },

  // Prémio de balanço/gratificação de resultado — A41 (parte isenta)
  GRATIFICACAO_BALANCO: {
    codigo_at: 'A41',
    codigo_ss: 'B',
    descricao: 'Gratificação de Balanço / Participação nos Lucros',
    sujeito_irs: false, // isento até limite
    sujeito_ss: true,
    limite_isencao: null, // limite calculado dinamicamente
    tipo: 'abono',
    nota: 'Isento IRS até 6% da retribuição base anual e sem carácter regular — A41.',
  },

  // ── DESCONTOS ────────────────────────────────────────────────────────────────

  // Retenção na Fonte — IRS
  RETENCAO_IRS: {
    codigo_at: null, // campo próprio na DMR
    codigo_ss: null,
    descricao: 'Retenção na Fonte (IRS)',
    sujeito_irs: false,
    sujeito_ss: false,
    tipo: 'desconto',
    obrigatorio: true,
  },

  // Contribuição Segurança Social — trabalhador
  SS_FUNCIONARIO: {
    codigo_at: null, // campo próprio na DMR
    codigo_ss: null,
    descricao: 'Contribuição para a Segurança Social (11%)',
    sujeito_irs: false,
    sujeito_ss: false,
    tipo: 'desconto',
    obrigatorio: true,
  },

  // Quotizações sindicais — dedutíveis no IRS do trabalhador
  QUOTAS_SINDICAIS: {
    codigo_at: null, // campo QS na DMR
    codigo_ss: null,
    descricao: 'Quotizações Sindicais',
    sujeito_irs: false,
    sujeito_ss: false,
    tipo: 'desconto',
  },

  // Desconto por faltas injustificadas
  DESCONTO_FALTAS: {
    codigo_at: null,
    codigo_ss: null,
    descricao: 'Desconto por Faltas Injustificadas',
    sujeito_irs: false,
    sujeito_ss: false,
    tipo: 'desconto',
    obrigatorio: true,
  },

  // Adiantamento de salário
  ADIANTAMENTO: {
    codigo_at: null,
    codigo_ss: null,
    descricao: 'Adiantamento de Salário',
    sujeito_irs: false,
    sujeito_ss: false,
    tipo: 'desconto',
  },

  // Seguro de saúde (plano empresa)
  SEGURO_SAUDE: {
    codigo_at: null,
    codigo_ss: null,
    descricao: 'Seguro de Saúde (desconto em folha)',
    sujeito_irs: false,
    sujeito_ss: false,
    tipo: 'desconto',
  },

  // Plano de Poupança Reforma
  PPR: {
    codigo_at: null,
    codigo_ss: null,
    descricao: 'Plano Poupança Reforma (PPR)',
    sujeito_irs: false,
    sujeito_ss: false,
    tipo: 'desconto',
  },

  // Penhora de salário (máximo 1/3 do líquido)
  PENHORA: {
    codigo_at: null,
    codigo_ss: null,
    descricao: 'Penhora de Salário',
    sujeito_irs: false,
    sujeito_ss: false,
    tipo: 'desconto',
  },
};

/**
 * Constantes de limites legais 2025
 */
const LIMITES_2025 = {
  SMN:                     870.00,  // Salário Mínimo Nacional
  IAS:                     522.50,  // Indexante dos Apoios Sociais
  SUB_REFEICAO_DINHEIRO:   6.15,   // Limite isento/dia em dinheiro
  SUB_REFEICAO_CARTAO:     10.46,  // Limite isento/dia em cartão/voucher
  AJUDAS_CUSTO_NACIONAL:   50.20,  // Limite isento/dia deslocação nacional
  AJUDAS_CUSTO_INTER:      89.35,  // Limite isento/dia deslocação internacional
  KMS_VIATURA_PROPRIA:     0.40,   // Limite isento por km
  ABONO_FALHAS:            122.96, // Limite isento mensal (5% SMN)
  TELETRABALHO:            1.00,   // Limite isento por dia efectivo de teletrabalho
  TAXA_SS_FUNC:            0.11,   // 11% trabalhador
  TAXA_SS_EMPRESA:         0.2375, // 23,75% entidade patronal
  DIAS_UTEIS_MES:          22,     // Dias úteis médios por mês

  // FCT e FGCT — obrigatórios para contratos sem termo (Lei 70/2013)
  TAXA_FCT:                0.00925, // 0,925% da retribuição base + diuturnidades
  TAXA_FGCT:               0.00075, // 0,075% da retribuição base + diuturnidades
  TAXA_FCT_TOTAL:          0.01,    // 1% total (FCT + FGCT)

  // Seguro de acidentes de trabalho — obrigatório (Lei 98/2009)
  // Prémio calculado sobre a massa salarial anual — taxa média mercado
  TAXA_SEGURO_AT_ESCRITORIO: 0.005, // ~0,5% para escritório/administrativo
  TAXA_SEGURO_AT_COMERCIO:   0.008, // ~0,8% para comércio
  TAXA_SEGURO_AT_INDUSTRIA:  0.015, // ~1,5% para indústria/construção

  // Formação profissional obrigatória (CT art. 131.º)
  HORAS_FORMACAO_OBRIGATORIAS: 40,  // 40h/ano mínimo por trabalhador

  // Vales — limites de isenção IRS 2025
  VALE_EDUCACAO_LIMITE:    1487.40, // Anual — para filhos 7-25 anos
  VALE_INFANCIA_LIMITE:    1487.40, // Anual — creche/JI
};

// Adicionar novas rubricas
Object.assign(RUBRICAS, {

  // FCT — Fundo de Compensação do Trabalho (custo patronal obrigatório)
  FCT: {
    codigo_at: null,
    codigo_ss: null,
    descricao: 'Fundo de Compensação do Trabalho (FCT — 0,925%)',
    sujeito_irs: false,
    sujeito_ss: false,
    tipo: 'custo_patronal',
    obrigatorio: true,
    nota: 'Obrigatório para contratos sem termo. Depositado no fundo FCT mensalmente.',
  },

  // FGCT — Fundo de Garantia de Compensação do Trabalho
  FGCT: {
    codigo_at: null,
    codigo_ss: null,
    descricao: 'Fundo de Garantia de Compensação (FGCT — 0,075%)',
    sujeito_irs: false,
    sujeito_ss: false,
    tipo: 'custo_patronal',
    obrigatorio: true,
  },

  // Seguro de acidentes de trabalho (obrigatório por lei)
  SEGURO_ACIDENTES_TRABALHO: {
    codigo_at: null,
    codigo_ss: null,
    descricao: 'Seguro de Acidentes de Trabalho',
    sujeito_irs: false,
    sujeito_ss: false,
    tipo: 'custo_patronal',
    obrigatorio: true,
    nota: 'Obrigatório por Lei 98/2009. Prémio anual calculado sobre massa salarial.',
  },

  // Desconto agregado familiar no seguro de saúde
  SEGURO_SAUDE_AGREGADO: {
    codigo_at: null,
    codigo_ss: null,
    descricao: 'Seguro de Saúde — Agregado Familiar (desconto)',
    sujeito_irs: false,
    sujeito_ss: false,
    tipo: 'desconto',
  },

  // Vale de educação (isento IRS até limite anual)
  VALE_EDUCACAO: {
    codigo_at: 'A',  // sujeito se exceder limite; isento abaixo do limite
    codigo_ss: null,
    descricao: 'Vale de Educação',
    sujeito_irs: false, // isento até 1.487,40€/ano
    sujeito_ss: false,
    limite_isencao: 1487.40,
    tipo: 'abono',
    nota: 'Isento IRS para filhos dos 7 aos 25 anos.',
  },

  // Vale de infância (creche/jardim infância — isento IRS)
  VALE_INFANCIA: {
    codigo_at: 'A',
    codigo_ss: null,
    descricao: 'Vale de Infância (Creche/Jardim de Infância)',
    sujeito_irs: false,
    sujeito_ss: false,
    limite_isencao: 1487.40,
    tipo: 'abono',
    nota: 'Isento IRS para filhos até 7 anos.',
  },

  // Telemóvel de função (custo empresa — não é rendimento do trabalhador)
  TELEMOVEL_EMPRESA: {
    codigo_at: null,
    codigo_ss: null,
    descricao: 'Telemóvel de Função',
    sujeito_irs: false,
    sujeito_ss: false,
    tipo: 'custo_patronal',
    nota: 'Custo da empresa. Não é rendimento do trabalhador se for para uso profissional.',
  },

});

module.exports = { RUBRICAS, LIMITES_2025 };
