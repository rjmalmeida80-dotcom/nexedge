'use strict';
const { query }    = require('../config/database');
const { criarErro }= require('../middleware/errorHandler');
const { calcularIRS: calcularIRS2025 } = require('../services/tabelasIRS2025');
const { RUBRICAS, LIMITES_2025 }       = require('../services/rubricas');

/**
 * Motor de cálculo salarial completo — legislação portuguesa 2025
 * Todas as rubricas com códigos AT (DMR) e SS (DR) correctos
 */
function calcularSalario(dados) {
  const {
    // Remuneração base
    salario_base = 0,

    // Subsídio de alimentação
    subsidio_alimentacao = 0,
    tipo_subsidio_alimentacao = 'dinheiro', // 'dinheiro' | 'cartao'
    dias_uteis = LIMITES_2025.DIAS_UTEIS_MES,
    dias_trabalhados = null, // null = mês completo

    // Horas extraordinárias
    horas_extra = 0,
    valor_hora_extra = null, // se null, calcula automaticamente

    // Trabalho nocturno
    horas_nocturnas = 0,

    // Subsídios fixos mensais
    subsidio_turno = 0,
    subsidio_risco = 0,
    subsidio_chefia = 0,
    isencao_horario = 0,
    diuturnidades = 0,

    // Subsídios anuais (meses específicos)
    subsidio_ferias = 0,
    subsidio_natal = 0,

    // Ajudas de custo
    ajudas_custo_nacionais_dias = 0,
    ajudas_custo_inter_dias = 0,
    kms_viatura_propria = 0,

    // Outros
    abono_falhas = 0,
    dias_teletrabalho = 0,
    comissoes = 0,
    premios = 0, // prémios de desempenho
    viatura_empresa_valor = 0,
    outros_abonos = [], // [{ descricao, valor, codigo_at, sujeito_irs, sujeito_ss }]

    // Descontos
    faltas_injustificadas = 0,
    adiantamento = 0,
    quotas_sindicais = 0,
    seguro_saude = 0,           // desconto ao funcionário
    seguro_saude_empresa = 0,  // custo patronal (não vai ao recibo)
    ppr = 0,
    penhora = 0,
    outros_descontos = [], // [{ descricao, valor }]

    // IRS
    estado_civil = 'nao_casado',
    num_dependentes = 0,
    deficiencia = false,
    deficiencia_dependente = false,
    irs_jovem = false,
    irs_jovem_ano = 1, // 1, 2, 3 ou 4

    // Taxas SS
    taxa_ss_func = LIMITES_2025.TAXA_SS_FUNC,
    taxa_ss_empresa = LIMITES_2025.TAXA_SS_EMPRESA,

    // Benefícios em espécie
    vale_educacao = 0,
    vale_infancia = 0,
    telemovel_empresa = 0,

    // FCT/FGCT (obrigatório contratos sem termo)
    tem_fct = true,
    tipo_contrato = 'sem_termo',

    // Seguro acidentes trabalho
    seguro_at_mensal = 0,

    // Seguro saúde agregado familiar
    seguro_saude_agregado_desconto = 0,
  } = dados;

  const diasUteis = parseInt(dias_uteis) || LIMITES_2025.DIAS_UTEIS_MES;
  const diasTrab  = dias_trabalhados !== null ? parseInt(dias_trabalhados) : diasUteis;
  const proporcao = diasTrab / diasUteis; // 1.0 se mês completo
  const base = Math.round((parseFloat(salario_base) || 0) * proporcao * 100) / 100;
  const valorHoraBase = (parseFloat(salario_base) || 0) / (diasUteis * 8);

  // ── CALCULAR CADA RUBRICA ──────────────────────────────────────────────────

  const linhas_abonos = [];
  const linhas_descontos = [];

  // Helper para adicionar rubrica
  const addAbono = (rubrica, valor, extra = {}) => {
    if (!valor || valor <= 0) return;
    linhas_abonos.push({ ...RUBRICAS[rubrica], ...extra, valor: parseFloat(valor.toFixed(2)) });
  };
  const addDesconto = (rubrica, valor, extra = {}) => {
    if (!valor || valor <= 0) return;
    linhas_descontos.push({ ...RUBRICAS[rubrica], ...extra, valor: parseFloat(valor.toFixed(2)) });
  };

  // 1. Remuneração base
  addAbono('REMUNERACAO_BASE', base);

  // 2. Diuturnidades
  if (parseFloat(diuturnidades) > 0) addAbono('DIUTURNIDADES', parseFloat(diuturnidades));

  // 3. Isenção de Horário de Trabalho
  if (parseFloat(isencao_horario) > 0) addAbono('ISENCAO_HORARIO', parseFloat(isencao_horario));

  // 4. Horas extraordinárias
  const heValor = parseFloat(horas_extra) > 0
    ? (valor_hora_extra ? parseFloat(horas_extra) * parseFloat(valor_hora_extra)
       : parseFloat(horas_extra) * valorHoraBase * 1.25) // mínimo legal 1ª hora
    : 0;
  if (heValor > 0) addAbono('HORAS_EXTRA', heValor, { horas: parseFloat(horas_extra) });

  // 5. Trabalho nocturno
  const valorNocturno = parseFloat(horas_nocturnas) * valorHoraBase * 0.25;
  if (valorNocturno > 0) addAbono('TRABALHO_NOCTURNO', valorNocturno, { horas: parseFloat(horas_nocturnas) });

  // 6. Subsídio de turno
  if (parseFloat(subsidio_turno) > 0) addAbono('SUBSIDIO_TURNO', parseFloat(subsidio_turno));

  // 7. Subsídio de risco
  if (parseFloat(subsidio_risco) > 0) addAbono('SUBSIDIO_RISCO', parseFloat(subsidio_risco));

  // 8. Subsídio de chefia
  if (parseFloat(subsidio_chefia) > 0) addAbono('SUBSIDIO_CHEFIA', parseFloat(subsidio_chefia));

  // 9. Comissões
  if (parseFloat(comissoes) > 0) addAbono('COMISSOES', parseFloat(comissoes));

  // 10. Prémios (com separação isento/sujeito — isento até 6% salário base anual)
  if (parseFloat(premios) > 0) {
    const limiteIsento = base * 12 * 0.06;
    const isentoMes = Math.min(parseFloat(premios), limiteIsento / 12);
    const sujeitoMes = Math.max(0, parseFloat(premios) - isentoMes);
    if (isentoMes > 0) addAbono('PREMIO_DESEMPENHO', isentoMes, { descricao: 'Prémio de Desempenho (parte isenta)' });
    if (sujeitoMes > 0) linhas_abonos.push({ ...RUBRICAS.PREMIO_DESEMPENHO, codigo_at: 'A', descricao: 'Prémio de Desempenho (parte sujeita)', sujeito_irs: true, valor: parseFloat(sujeitoMes.toFixed(2)) });
  }

  // 11. Subsídio de férias
  if (parseFloat(subsidio_ferias) > 0) addAbono('SUBSIDIO_FERIAS', parseFloat(subsidio_ferias));

  // 12. Subsídio de Natal
  if (parseFloat(subsidio_natal) > 0) addAbono('SUBSIDIO_NATAL', parseFloat(subsidio_natal));

  // 13. Subsídio de alimentação — separar isento/sujeito
  const subAlimTotal = Math.round((parseFloat(subsidio_alimentacao) || 0) * diasTrab * 100) / 100;
  if (subAlimTotal > 0) {
    const limiteIsento = tipo_subsidio_alimentacao === 'cartao'
      ? LIMITES_2025.SUB_REFEICAO_CARTAO * dias_uteis
      : LIMITES_2025.SUB_REFEICAO_DINHEIRO * dias_uteis;
    const isento = Math.min(subAlimTotal, limiteIsento);
    const sujeito = Math.max(0, subAlimTotal - limiteIsento);
    if (isento > 0) addAbono('SUBSIDIO_ALIMENTACAO_ISENTO', isento);
    if (sujeito > 0) addAbono('SUBSIDIO_ALIMENTACAO_SUJEITO', sujeito);
  }

  // 14. Ajudas de custo
  const diasNac = parseFloat(ajudas_custo_nacionais_dias) || 0;
  const diasInter = parseFloat(ajudas_custo_inter_dias) || 0;
  if (diasNac > 0) {
    const valIsento = Math.min(diasNac * LIMITES_2025.AJUDAS_CUSTO_NACIONAL, diasNac * LIMITES_2025.AJUDAS_CUSTO_NACIONAL);
    addAbono('AJUDAS_CUSTO_ISENTO', valIsento, { descricao: `Ajudas de Custo Nacionais (${diasNac} dias)` });
  }
  if (diasInter > 0) {
    addAbono('AJUDAS_CUSTO_ISENTO', diasInter * LIMITES_2025.AJUDAS_CUSTO_INTER, { descricao: `Ajudas de Custo Internacionais (${diasInter} dias)`, codigo_at: 'A22' });
  }

  // 15. Quilómetros em viatura própria
  const kms = parseFloat(kms_viatura_propria) || 0;
  if (kms > 0) addAbono('KMS_VIATURA_PROPRIA', kms * LIMITES_2025.KMS_VIATURA_PROPRIA, { descricao: `Deslocações Viatura Própria (${kms} km)` });

  // 16. Abono para falhas
  const abFalhas = parseFloat(abono_falhas) || 0;
  if (abFalhas > 0) {
    const isento = Math.min(abFalhas, LIMITES_2025.ABONO_FALHAS);
    const sujeito = Math.max(0, abFalhas - isento);
    if (isento > 0) addAbono('ABONO_FALHAS_ISENTO', isento);
    if (sujeito > 0) addAbono('ABONO_FALHAS_SUJEITO', sujeito);
  }

  // 17. Teletrabalho
  const diasTele = parseFloat(dias_teletrabalho) || 0;
  if (diasTele > 0) addAbono('TELETRABALHO_ISENTO', diasTele * LIMITES_2025.TELETRABALHO, { descricao: `Compensação Teletrabalho (${diasTele} dias)` });

  // 18. Viatura empresa
  if (parseFloat(viatura_empresa_valor) > 0) addAbono('VIATURA_EMPRESA', parseFloat(viatura_empresa_valor));

  // 19. Outros abonos
  for (const ab of outros_abonos) {
    if (parseFloat(ab.valor) > 0) {
      linhas_abonos.push({
        codigo_at: ab.codigo_at || 'A',
        codigo_ss: ab.codigo_ss || 'P',
        descricao: ab.descricao,
        sujeito_irs: ab.sujeito_irs !== false,
        sujeito_ss: ab.sujeito_ss !== false,
        valor: parseFloat(parseFloat(ab.valor).toFixed(2)),
        tipo: 'abono',
      });
    }
  }

  // 20. Vales de educação (isento IRS)
  if (parseFloat(vale_educacao) > 0) {
    const valMensal = parseFloat(vale_educacao);
    linhas_abonos.push({
      ...RUBRICAS.VALE_EDUCACAO,
      valor: parseFloat(valMensal.toFixed(2)),
      nota: `Isento IRS até ${LIMITES_2025.VALE_EDUCACAO_LIMITE}€/ano`,
    });
  }

  // 21. Vale de infância (isento IRS)
  if (parseFloat(vale_infancia) > 0) {
    linhas_abonos.push({
      ...RUBRICAS.VALE_INFANCIA,
      valor: parseFloat(parseFloat(vale_infancia).toFixed(2)),
    });
  }

  // ── CALCULAR BASES DE INCIDÊNCIA ──────────────────────────────────────────

  const baseIRS = linhas_abonos
    .filter(l => l.sujeito_irs)
    .reduce((s, l) => s + l.valor, 0);

  const baseSS = linhas_abonos
    .filter(l => l.sujeito_ss)
    .reduce((s, l) => s + l.valor, 0);

  const totalAbonos = linhas_abonos.reduce((s, l) => s + l.valor, 0);

  // ── DESCONTO FALTAS ───────────────────────────────────────────────────────

  const valorFalta = base / LIMITES_2025.DIAS_UTEIS_MES;
  const valorDescontoFaltas = parseFloat(faltas_injustificadas) * valorFalta;
  if (valorDescontoFaltas > 0) addDesconto('DESCONTO_FALTAS', valorDescontoFaltas);

  // ── SS FUNCIONÁRIO ────────────────────────────────────────────────────────

  const ssFunc = Math.round(baseSS * taxa_ss_func * 100) / 100;
  addDesconto('SS_FUNCIONARIO', ssFunc);

  // ── IRS ───────────────────────────────────────────────────────────────────

  let irsRetido = 0;
  if (irs_jovem) {
    // IRS Jovem: 100% isento ano 1, 75% ano 2, 50% ano 3, 25% ano 4
    const percentIsento = [1.00, 0.75, 0.50, 0.25][Math.min(parseInt(irs_jovem_ano) - 1, 3)];
    const baseIRSTributavel = baseIRS * (1 - percentIsento);
    irsRetido = calcularIRS2025(baseIRSTributavel, estado_civil, parseInt(num_dependentes), deficiencia, deficiencia_dependente);
  } else {
    irsRetido = calcularIRS2025(baseIRS, estado_civil, parseInt(num_dependentes), deficiencia, deficiencia_dependente);
  }
  if (irsRetido > 0) addDesconto('RETENCAO_IRS', irsRetido);

  // ── OUTROS DESCONTOS ──────────────────────────────────────────────────────

  // Desconto seguro saúde agregado familiar
  if (parseFloat(seguro_saude_agregado_desconto) > 0) {
    linhas_descontos.push({
      ...RUBRICAS.SEGURO_SAUDE_AGREGADO,
      valor: parseFloat(parseFloat(seguro_saude_agregado_desconto).toFixed(2)),
    });
  }

  if (parseFloat(quotas_sindicais) > 0) addDesconto('QUOTAS_SINDICAIS', parseFloat(quotas_sindicais));
  if (parseFloat(adiantamento) > 0) addDesconto('ADIANTAMENTO', parseFloat(adiantamento));
  if (parseFloat(seguro_saude) > 0) addDesconto('SEGURO_SAUDE', parseFloat(seguro_saude));
  if (parseFloat(ppr) > 0) addDesconto('PPR', parseFloat(ppr));
  if (parseFloat(penhora) > 0) addDesconto('PENHORA', parseFloat(penhora));

  for (const d of outros_descontos) {
    if (parseFloat(d.valor) > 0) {
      linhas_descontos.push({
        codigo_at: null, codigo_ss: null,
        descricao: d.descricao, valor: parseFloat(parseFloat(d.valor).toFixed(2)), tipo: 'desconto',
      });
    }
  }

  const totalDescontos = linhas_descontos.reduce((s, l) => s + l.valor, 0);
  const liquido = Math.round((totalAbonos - totalDescontos) * 100) / 100;

  // SS Empresa
  const ssEmpresa = Math.round(baseSS * taxa_ss_empresa * 100) / 100;
  const custoTotal = Math.round((totalAbonos + ssEmpresa - (dados.ajudas_custo_nacionais_dias || 0) * LIMITES_2025.AJUDAS_CUSTO_NACIONAL - (dados.ajudas_custo_inter_dias || 0) * LIMITES_2025.AJUDAS_CUSTO_INTER) * 100) / 100;

  return {
    linhas_abonos,
    linhas_descontos,
    total_abonos:         Math.round(totalAbonos * 100) / 100,
    base_incidencia_irs:  Math.round(baseIRS * 100) / 100,
    base_incidencia_ss:   Math.round(baseSS * 100) / 100,
    irs_retido:           irsRetido,
    seg_social_func:      ssFunc,
    total_descontos:      Math.round(totalDescontos * 100) / 100,
    liquido,
    seg_social_entidade:  ssEmpresa,
    custo_empresa:        Math.round((totalAbonos + ssEmpresa + parseFloat(seguro_saude_empresa||0)) * 100) / 100,
    seguro_saude_empresa: parseFloat(seguro_saude_empresa||0),

    // Custos patronais adicionais
    fct_mensal:    tem_fct && tipo_contrato === 'sem_termo'
                     ? Math.round(baseSS * LIMITES_2025.TAXA_FCT * 100) / 100 : 0,
    fgct_mensal:   tem_fct && tipo_contrato === 'sem_termo'
                     ? Math.round(baseSS * LIMITES_2025.TAXA_FGCT * 100) / 100 : 0,
    seguro_at_mensal: parseFloat(seguro_at_mensal||0),
    telemovel_empresa: parseFloat(telemovel_empresa||0),

    // Custo total real da empresa (incluindo todos os encargos)
    custo_total_real: Math.round((
      totalAbonos +
      ssEmpresa +
      parseFloat(seguro_saude_empresa||0) +
      parseFloat(seguro_at_mensal||0) +
      parseFloat(telemovel_empresa||0) +
      (tem_fct && tipo_contrato === 'sem_termo' ? baseSS * LIMITES_2025.TAXA_FCT_TOTAL : 0)
    ) * 100) / 100,
    // Dias trabalhados
    dias_uteis_mes:  diasUteis,
    dias_trabalhados: diasTrab,
    proporcao_mes:   proporcao,
    // Campos para compatibilidade com BD existente
    salario_base:         base,
    subsidio_alimentacao: subAlimTotal,
    horas_extra_valor:    heValor,
    subsidio_ferias:      parseFloat(subsidio_ferias) || 0,
    subsidio_natal:       parseFloat(subsidio_natal) || 0,
  };
}

// ── ENDPOINTS ──────────────────────────────────────────────────────────────────

async function listar(req, res) {
  const { ano, mes, funcionario_id } = req.query;
  const params = [req.empresaId];
  const conds  = ['r.empresa_id = $1'];
  let p = 2;
  if (ano) { conds.push(`r.ano = $${p}`); params.push(parseInt(ano)); p++; }
  if (mes) { conds.push(`r.mes = $${p}`); params.push(parseInt(mes)); p++; }
  if (funcionario_id) { conds.push(`r.funcionario_id = $${p}`); params.push(funcionario_id); p++; }

  const { rows } = await query(`
    SELECT r.*, f.nome_completo, f.cargo, f.numero_funcionario, f.departamento_id,
           d.nome AS departamento
    FROM recibo_vencimento r
    JOIN funcionario f ON f.id = r.funcionario_id
    LEFT JOIN departamento d ON d.id = f.departamento_id
    WHERE ${conds.join(' AND ')}
    ORDER BY r.ano DESC, r.mes DESC, f.nome_completo
  `, params);
  res.json(rows);
}

async function obter(req, res) {
  const { rows } = await query(`
    SELECT r.*, f.nome_completo, f.cargo, f.numero_funcionario
    FROM recibo_vencimento r
    JOIN funcionario f ON f.id = r.funcionario_id
    WHERE r.id = $1 AND r.empresa_id = $2
  `, [req.params.id, req.empresaId]);
  if (!rows.length) throw criarErro('Recibo não encontrado.', 404);
  res.json(rows[0]);
}

async function simular(req, res) {
  const resultado = calcularSalario(req.body);
  res.json(resultado);
}

async function processar(req, res) {
  const { ano, mes, funcionario_id } = req.body;
  if (!ano || !mes) throw criarErro('Ano e mês são obrigatórios.', 400);

  let sqlFunc = `
    SELECT f.*,
           COALESCE(rp.total_horas_extra, 0) AS horas_extra_mes,
           COALESCE(fal.total_faltas, 0) AS faltas_injustificadas
    FROM funcionario f
    LEFT JOIN (
      SELECT funcionario_id, SUM(horas_extra) AS total_horas_extra
      FROM registo_ponto
      WHERE EXTRACT(YEAR FROM data)=$1 AND EXTRACT(MONTH FROM data)=$2
      GROUP BY funcionario_id
    ) rp ON rp.funcionario_id = f.id
    LEFT JOIN (
      SELECT funcionario_id, COUNT(*) AS total_faltas
      FROM falta
      WHERE EXTRACT(YEAR FROM data)=$1 AND EXTRACT(MONTH FROM data)=$2
        AND tipo='injustificada'
      GROUP BY funcionario_id
    ) fal ON fal.funcionario_id = f.id
    WHERE f.empresa_id=$3 AND f.estado='ativo'
  `;
  const paramsFunc = [ano, mes, req.empresaId];
  if (funcionario_id) { sqlFunc += ` AND f.id=$4`; paramsFunc.push(funcionario_id); }

  const { rows: funcionarios } = await query(sqlFunc, paramsFunc);
  if (!funcionarios.length) throw criarErro('Nenhum funcionário ativo encontrado.', 404);

  // Determinar se é mês de subsídios
  const mesNum = parseInt(mes);
  const anoNum = parseInt(ano);

  const recibos = [];
  for (const f of funcionarios) {
    const calc = calcularSalario({
      salario_base:           f.salario_base,
      subsidio_alimentacao:   f.subsidio_alimentacao,
      tipo_subsidio_alimentacao: f.tipo_subsidio_alimentacao || 'dinheiro',
      horas_extra:            f.horas_extra_mes,
      faltas_injustificadas:  f.faltas_injustificadas,
      // Subsídios anuais
      subsidio_ferias:        mesNum === 6  ? f.salario_base : 0,
      subsidio_natal:         mesNum === 11 ? f.salario_base : 0,
      // Complementos fixos da ficha do funcionário
      subsidio_turno:         f.subsidio_turno || 0,
      subsidio_risco:         f.subsidio_risco || 0,
      subsidio_chefia:        f.subsidio_chefia || 0,
      isencao_horario:        f.isencao_horario || 0,
      diuturnidades:          f.diuturnidades || 0,
      // IRS
      estado_civil:           f.estado_civil || 'nao_casado',
      num_dependentes:        f.num_dependentes || 0,
      deficiencia:            f.deficiencia || false,
      deficiencia_dependente: f.deficiencia_dependente || false,
      irs_jovem:              f.irs_jovem || false,
      irs_jovem_ano:          f.irs_jovem_ano || 1,
      // Seguro de saúde
      seguro_saude:           f.seguro_saude_funcionario || 0,
      seguro_saude_empresa:   f.seguro_saude_empresa || 0,
    });

    // Guardar linhas do recibo em JSON
    const linhasJSON = JSON.stringify({
      abonos:   calc.linhas_abonos,
      descontos: calc.linhas_descontos,
    });

    const { rows: recibo } = await query(`
      INSERT INTO recibo_vencimento (
        funcionario_id, empresa_id, ano, mes,
        salario_base, subsidio_alimentacao, horas_extra_valor,
        subsidio_ferias, subsidio_natal,
        outros_abonos, faltas_desconto, outros_descontos,
        irs_retido, seg_social_func, seg_social_entidade,
        total_abonos, total_descontos, liquido,
        linhas_detalhe, seguro_saude_empresa,
        estado, processado_por, processado_em
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'processado',$21,NOW())
      ON CONFLICT (funcionario_id, ano, mes) DO UPDATE SET
        salario_base=EXCLUDED.salario_base,
        horas_extra_valor=EXCLUDED.horas_extra_valor,
        subsidio_ferias=EXCLUDED.subsidio_ferias,
        subsidio_natal=EXCLUDED.subsidio_natal,
        irs_retido=EXCLUDED.irs_retido,
        seg_social_func=EXCLUDED.seg_social_func,
        seg_social_entidade=EXCLUDED.seg_social_entidade,
        total_abonos=EXCLUDED.total_abonos,
        total_descontos=EXCLUDED.total_descontos,
        liquido=EXCLUDED.liquido,
        linhas_detalhe=EXCLUDED.linhas_detalhe,
        estado='processado',
        processado_por=EXCLUDED.processado_por,
        processado_em=NOW()
      RETURNING *
    `, [
      f.id, req.empresaId, anoNum, mesNum,
      calc.salario_base, calc.subsidio_alimentacao, calc.horas_extra_valor,
      calc.subsidio_ferias, calc.subsidio_natal,
      '[]', 0, '[]',
      calc.irs_retido, calc.seg_social_func, calc.seg_social_entidade,
      calc.total_abonos, calc.total_descontos, calc.liquido,
      linhasJSON, calc.seguro_saude_empresa || 0,
      req.utilizador.id,
    ]);

    recibos.push({ ...recibo[0], nome_completo: f.nome_completo });
  }

  await req.auditar({ acao: 'SALARIOS_PROCESSADOS', tabela: 'recibo_vencimento', dados_depois: { ano, mes, total: recibos.length } });
  res.json({ mensagem: `${recibos.length} recibos processados.`, recibos });
}

async function simularProcessamento(req, res) {
  const { ano, mes, dias_trabalhados } = req.body;
  if (!ano || !mes) throw criarErro('Ano e mês são obrigatórios.', 400);

  const { rows: funcionarios } = await query(`
    SELECT f.*, d.nome AS departamento_nome
    FROM funcionario f
    LEFT JOIN departamento d ON d.id = f.departamento_id
    WHERE f.empresa_id=$1 AND f.estado='ativo'
    ORDER BY f.nome_completo
  `, [req.empresaId]);

  const diasUteis = 22;
  const diasTrab  = parseInt(dias_trabalhados) || diasUteis;

  const preview = funcionarios.map(f => {
    const calc = calcularSalario({
      salario_base:         f.salario_base,
      subsidio_alimentacao: f.subsidio_alimentacao,
      tipo_subsidio_alimentacao: f.tipo_subsidio_alimentacao || 'dinheiro',
      dias_trabalhados:     diasTrab,
      dias_uteis:           diasUteis,
      subsidio_turno:       f.subsidio_turno || 0,
      subsidio_risco:       f.subsidio_risco || 0,
      subsidio_chefia:      f.subsidio_chefia || 0,
      isencao_horario:      f.isencao_horario || 0,
      diuturnidades:        f.diuturnidades || 0,
      estado_civil:         f.estado_civil || 'nao_casado',
      num_dependentes:      f.num_dependentes || 0,
      deficiencia:          f.deficiencia || false,
      deficiencia_dependente: f.deficiencia_dependente || false,
      irs_jovem:            f.irs_jovem || false,
      seguro_saude_empresa: f.seguro_saude_empresa || 0,
    });

    // Check if already processed this month
    return {
      funcionario_id:    f.id,
      nome_completo:     f.nome_completo,
      cargo:             f.cargo,
      departamento:      f.departamento_nome,
      salario_base_cheio: parseFloat(f.salario_base) || 0,
      dias_trabalhados:  diasTrab,
      dias_uteis:        diasUteis,
      salario_proporcional: calc.salario_base,
      sub_alimentacao:   calc.subsidio_alimentacao,
      total_abonos:      calc.total_abonos,
      irs_retido:        calc.irs_retido,
      ss_funcionario:    calc.seg_social_func,
      total_descontos:   calc.total_descontos,
      liquido:           calc.liquido,
      custo_empresa:     calc.custo_empresa,
    };
  });

  res.json({
    mes, ano, dias_trabalhados: diasTrab, dias_uteis: diasUteis,
    total_funcionarios: preview.length,
    total_liquido: preview.reduce((s, f) => s + f.liquido, 0),
    total_custo:   preview.reduce((s, f) => s + f.custo_empresa, 0),
    funcionarios:  preview,
  });
}

module.exports = { listar, obter, simular, processar, simularProcessamento, calcularSalario };
