'use strict';

const { query } = require('../config/database');

// GET /api/dashboard — KPIs principais
async function obterKPIs(req, res) {
  const empresaId = req.empresaId;
  const hoje = new Date();
  const anoAtual = hoje.getFullYear();
  const mesAtual = hoje.getMonth() + 1;

  const [
    funcionarios,
    feriasHoje,
    pedidosPendentes,
    horasExtra,
    custoMes,
    absentismo,
    contratosTerminar,
    alertasLegais,
    distribuicaoEstado,
    distribuicaoDepto,
    admissoesRecentes,
  ] = await Promise.all([

    // Total funcionários ativos
    query(`SELECT COUNT(*) AS total FROM funcionario WHERE empresa_id=$1 AND estado='ativo'`, [empresaId]),

    // De férias hoje
    query(`
      SELECT COUNT(*) AS total FROM pedido_ferias pf
      JOIN funcionario f ON f.id=pf.funcionario_id
      WHERE f.empresa_id=$1 AND pf.estado='aprovado'
        AND CURRENT_DATE BETWEEN pf.data_inicio AND pf.data_fim
    `, [empresaId]),

    // Pedidos pendentes (férias + faltas)
    query(`
      SELECT
        (SELECT COUNT(*) FROM pedido_ferias pf JOIN funcionario f ON f.id=pf.funcionario_id
         WHERE f.empresa_id=$1 AND pf.estado='pendente') +
        (SELECT COUNT(*) FROM falta fa JOIN funcionario f ON f.id=fa.funcionario_id
         WHERE f.empresa_id=$1 AND fa.estado='pendente') AS total
    `, [empresaId]),

    // Horas extra este mês
    query(`
      SELECT COALESCE(SUM(horas_extra),0) AS total FROM registo_ponto rp
      JOIN funcionario f ON f.id=rp.funcionario_id
      WHERE f.empresa_id=$1
        AND EXTRACT(YEAR FROM rp.data)=$2 AND EXTRACT(MONTH FROM rp.data)=$3
    `, [empresaId, anoAtual, mesAtual]).catch(() => ({ rows: [{ total: 0 }] })),

    // Custo total este mês
    query(`
      SELECT COALESCE(SUM(total_abonos + seg_social_entidade),0) AS total
      FROM recibo_vencimento
      WHERE empresa_id=$1 AND ano=$2 AND mes=$3
    `, [empresaId, anoAtual, mesAtual]),

    // Taxa de absentismo (faltas injustificadas este mês / dias possíveis)
    query(`
      SELECT
        COUNT(*) AS faltas,
        (SELECT COUNT(*) FROM funcionario WHERE empresa_id=$1 AND estado='ativo') AS ativos
      FROM falta fa JOIN funcionario f ON f.id=fa.funcionario_id
      WHERE f.empresa_id=$1 AND fa.tipo='injustificada'
        AND EXTRACT(YEAR FROM fa.data)=$2 AND EXTRACT(MONTH FROM fa.data)=$3
    `, [empresaId, anoAtual, mesAtual]),

    // Contratos a terminar nos próximos 60 dias
    query(`
      SELECT COUNT(*) AS total FROM funcionario
      WHERE empresa_id=$1 AND estado='ativo'
        AND data_fim_contrato IS NOT NULL
        AND data_fim_contrato BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '60 days'
    `, [empresaId]),

    // Alertas legais não lidos (tabela pode não existir)
    query(`
      SELECT COALESCE((
        SELECT COUNT(*) FROM alerta_legal
        WHERE empresa_id=$1 AND lido=false
      ), 0) AS total
    `, [empresaId]).catch(() => ({ rows: [{ total: 0 }] })),

    // Distribuição por estado
    query(`
      SELECT estado, COUNT(*) AS total FROM funcionario
      WHERE empresa_id=$1 GROUP BY estado ORDER BY total DESC
    `, [empresaId]),

    // Distribuição por departamento (top 8)
    query(`
      SELECT d.nome, COUNT(f.id) AS total
      FROM departamento d
      LEFT JOIN funcionario f ON f.departamento_id=d.id AND f.estado='ativo'
      WHERE d.empresa_id=$1
      GROUP BY d.id, d.nome
      ORDER BY total DESC LIMIT 8
    `, [empresaId]),
  ]);

  const ativosTotal = parseInt(funcionarios.rows[0].total) || 1;
  const faltasMes   = parseInt(absentismo.rows[0].faltas) || 0;
  const diasPossiveis = ativosTotal * 22; // dias úteis médios
  const taxaAbsentismo = diasPossiveis > 0 ? Math.round((faltasMes / diasPossiveis) * 1000) / 10 : 0;

  res.json({
    kpis: {
      funcionarios_ativos:    parseInt(funcionarios.rows[0].total),
      de_ferias_hoje:         parseInt(feriasHoje.rows[0].total),
      pedidos_pendentes:      parseInt(pedidosPendentes.rows[0].total),
      horas_extra_mes:        parseFloat(horasExtra.rows[0].total),
      custo_pessoal_mes:      parseFloat(custoMes.rows[0].total),
      taxa_absentismo:        taxaAbsentismo,
      contratos_a_terminar:   parseInt(contratosTerminar.rows[0].total),
      alertas_legais:         parseInt(alertasLegais.rows[0].total),
    },
    graficos: {
      por_estado:       distribuicaoEstado.rows,
      por_departamento: distribuicaoDepto.rows,
    },
    admissoes_recentes: admissoesRecentes?.rows || [],
  });
}

// GET /api/dashboard/ferias-calendario — mapa de férias
async function calendarioFerias(req, res) {
  const { ano = new Date().getFullYear(), mes } = req.query;
  let where = `f.empresa_id=$1 AND pf.estado='aprovado' AND EXTRACT(YEAR FROM pf.data_inicio)=$2`;
  const params = [req.empresaId, ano];
  if (mes) { where += ` AND EXTRACT(MONTH FROM pf.data_inicio)=$3`; params.push(parseInt(mes)); }

  const { rows } = await query(`
    SELECT pf.id, pf.data_inicio, pf.data_fim, pf.num_dias,
           f.nome_completo, f.foto_url, d.nome AS departamento
    FROM pedido_ferias pf
    JOIN funcionario f ON f.id=pf.funcionario_id
    LEFT JOIN departamento d ON d.id=f.departamento_id
    WHERE ${where}
    ORDER BY pf.data_inicio
  `, params);
  res.json(rows);
}

// GET /api/dashboard/alertas-horario — violações da lei laboral
async function alertasHorario(req, res) {
  const { rows } = await query(`
    SELECT f.nome_completo, f.numero_funcionario,
           SUM(rp.horas_extra) AS total_horas_extra,
           MAX(rp.horas_trabalhadas) AS max_horas_dia,
           COUNT(CASE WHEN rp.horas_trabalhadas > 8 THEN 1 END) AS dias_acima_limite
    FROM registo_ponto rp
    JOIN funcionario f ON f.id=rp.funcionario_id
    WHERE f.empresa_id=$1
      AND EXTRACT(YEAR FROM rp.data)=EXTRACT(YEAR FROM CURRENT_DATE)
    GROUP BY f.id, f.nome_completo, f.numero_funcionario
    HAVING SUM(rp.horas_extra) > 100 OR MAX(rp.horas_trabalhadas) > 10
    ORDER BY total_horas_extra DESC
    LIMIT 20
  `, [req.empresaId]);
  res.json(rows);
}

module.exports = { obterKPIs, calendarioFerias, alertasHorario };
