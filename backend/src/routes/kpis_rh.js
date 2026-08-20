'use strict';
const router = require('express').Router();
const { autenticar, autorizar } = require('../middleware/auth');
const { query } = require('../config/database');

router.get('/', autenticar, autorizar('admin_empresa','rh','diretor'), async (req, res) => {
  try {
    const { ano = new Date().getFullYear(), mes = new Date().getMonth() + 1 } = req.query;
    const eid = req.empresaId;

    const [headcount, admissoes, saidas, faltas, salarios, contratos, ferias] = await Promise.all([
      // Headcount e variação
      query(`SELECT
        COUNT(*) FILTER(WHERE estado='ativo') AS total_activos,
        COUNT(*) FILTER(WHERE estado='ativo' AND EXTRACT(YEAR FROM data_admissao)=$2) AS admitidos_ano,
        COUNT(*) FILTER(WHERE estado='inativo' AND EXTRACT(YEAR FROM atualizado_em)=$2) AS saidas_ano,
        COALESCE(AVG(salario_base) FILTER(WHERE estado='ativo'),0) AS salario_medio,
        COALESCE(SUM(salario_base) FILTER(WHERE estado='ativo'),0) AS massa_salarial
        FROM funcionario WHERE empresa_id=$1`, [eid, ano]),

      // Admissões por mês (últimos 6 meses)
      query(`SELECT EXTRACT(MONTH FROM data_admissao) AS mes, COUNT(*) AS total
        FROM funcionario WHERE empresa_id=$1 AND EXTRACT(YEAR FROM data_admissao)=$2
        GROUP BY mes ORDER BY mes`, [eid, ano]),

      // Taxa de rotatividade
      query(`SELECT
        COUNT(*) FILTER(WHERE estado='inativo') AS total_saidas,
        COUNT(*) AS total_geral
        FROM funcionario WHERE empresa_id=$1`, [eid]),

      // Absentismo
      query(`SELECT
        COUNT(*) AS total_faltas,
        COUNT(*) FILTER(WHERE fa.tipo='injustificada') AS faltas_injust,
        COUNT(*) FILTER(WHERE fa.tipo='doenca') AS faltas_doenca,
        COUNT(*) FILTER(WHERE EXTRACT(MONTH FROM fa.data)=$2 AND EXTRACT(YEAR FROM fa.data)=$3) AS faltas_mes
        FROM falta fa
        JOIN funcionario f ON f.id=fa.funcionario_id
        WHERE f.empresa_id=$1`, [eid, mes, ano]).catch(()=>({rows:[{total_faltas:0,faltas_injust:0,faltas_doenca:0,faltas_mes:0}]})),

      // Custo salarial mensal
      query(`SELECT
        COALESCE(SUM(total_abonos),0) AS custo_bruto,
        COALESCE(SUM(seg_social_func),0) AS ss_trabalhadores,
        COALESCE(SUM(irs_retido),0) AS irs_total,
        COALESCE(SUM(liquido),0) AS liquido_total,
        COUNT(DISTINCT funcionario_id) AS processados
        FROM recibo_vencimento WHERE empresa_id=$1 AND ano=$2 AND mes=$3`, [eid, ano, mes]),

      // Contratos a expirar (próximos 60 dias)
      query(`SELECT COUNT(*) AS a_expirar
        FROM contrato_trabalho WHERE empresa_id=$1
        AND tipo_contrato != 'sem_termo'
        AND data_fim BETWEEN NOW() AND NOW() + INTERVAL '60 days'`, [eid]).catch(()=>({rows:[{a_expirar:0}]})),

      // Férias pendentes
      query(`SELECT COUNT(*) AS pendentes FROM pedido_ferias pf
        JOIN funcionario f ON f.id=pf.funcionario_id
        WHERE f.empresa_id=$1 AND pf.estado='pendente'`, [eid]),
    ]);

    const hc = headcount.rows[0];
    const total = parseInt(saidas.rows[0]?.total_geral||1);
    const totalSaidas = parseInt(saidas.rows[0]?.total_saidas||0);
    const taxaRotatividade = total > 0 ? ((totalSaidas/total)*100).toFixed(1) : 0;
    const activos = parseInt(hc.total_activos||0);
    const custoBruto = parseFloat(salarios.rows[0]?.custo_bruto||0);
    const custoPorColaborador = activos > 0 ? (custoBruto/activos).toFixed(2) : 0;
    const totalFaltas = parseInt(faltas.rows[0]?.total_faltas||0);
    const taxaAbsentismo = activos > 0 ? ((totalFaltas/(activos*22))*100).toFixed(1) : 0;

    res.json({
      periodo: { ano: parseInt(ano), mes: parseInt(mes) },
      headcount: {
        total_activos: activos,
        admitidos_ano: parseInt(hc.admitidos_ano||0),
        saidas_ano: parseInt(hc.saidas_ano||0),
        salario_medio: parseFloat(hc.salario_medio||0).toFixed(2),
        massa_salarial: parseFloat(hc.massa_salarial||0).toFixed(2),
      },
      rotatividade: {
        taxa: parseFloat(taxaRotatividade),
        total_saidas: totalSaidas,
        label: parseFloat(taxaRotatividade) < 10 ? 'Baixa' : parseFloat(taxaRotatividade) < 20 ? 'Media' : 'Alta',
      },
      absentismo: {
        total_faltas: totalFaltas,
        faltas_mes: parseInt(faltas.rows[0]?.faltas_mes||0),
        faltas_injustificadas: parseInt(faltas.rows[0]?.faltas_injust||0),
        faltas_doenca: parseInt(faltas.rows[0]?.faltas_doenca||0),
        taxa: parseFloat(taxaAbsentismo),
      },
      custos: {
        custo_bruto: custoBruto.toFixed(2),
        custo_por_colaborador: custoPorColaborador,
        irs_total: parseFloat(salarios.rows[0]?.irs_total||0).toFixed(2),
        ss_trabalhadores: parseFloat(salarios.rows[0]?.ss_trabalhadores||0).toFixed(2),
        liquido_total: parseFloat(salarios.rows[0]?.liquido_total||0).toFixed(2),
        processados: parseInt(salarios.rows[0]?.processados||0),
      },
      alertas: {
        contratos_a_expirar: parseInt(contratos.rows[0]?.a_expirar||0),
        ferias_pendentes: parseInt(ferias.rows[0]?.pendentes||0),
      },
      admissoes_por_mes: admissoes.rows,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
