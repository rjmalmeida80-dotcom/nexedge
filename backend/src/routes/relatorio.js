'use strict';
const router = require('express').Router();
const { autenticar } = require('../middleware/auth');
const { query } = require('../config/database');

const MESES = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

// ── RH & Pessoas ──────────────────────────────────────────────────────────────
router.get('/rh', autenticar, async (req, res) => {
  try {
    const ano = parseInt(req.query.ano) || new Date().getFullYear();
    const eid = req.empresaId;

    const [kpisR, deptoR, contratoR, salMesR, faltasR, topSalR] = await Promise.all([
      // KPIs
      query(`SELECT
        COUNT(*) FILTER (WHERE estado='ativo') AS total_colaboradores,
        COUNT(*) FILTER (WHERE EXTRACT(YEAR FROM data_admissao)=$2) AS novos_ano,
        COALESCE(SUM(salario_base) FILTER (WHERE estado='ativo'),0) AS custo_mensal
        FROM funcionario WHERE empresa_id=$1`, [eid, ano]),

      // Por departamento
      query(`SELECT COALESCE(d.nome,'Sem departamento') AS departamento, COUNT(f.id) AS total
        FROM funcionario f LEFT JOIN departamento d ON d.id=f.departamento_id
        WHERE f.empresa_id=$1 AND f.estado='ativo'
        GROUP BY d.nome ORDER BY total DESC`, [eid]),

      // Por tipo contrato
      query(`SELECT COALESCE(tipo_contrato,'indefinido') AS tipo, COUNT(*) AS total
        FROM contrato_trabalho WHERE empresa_id=$1
        GROUP BY tipo_contrato ORDER BY total DESC`, [eid]),

      // Custo salarial por mês
      query(`SELECT mes, SUM(total_abonos) AS total
        FROM recibo_vencimento WHERE empresa_id=$1 AND ano=$2
        GROUP BY mes ORDER BY mes`, [eid, ano]),

      // Faltas por tipo
      query(`SELECT tipo, COUNT(*) AS total
        FROM falta WHERE empresa_id=$1 AND EXTRACT(YEAR FROM data)=$2
        GROUP BY tipo ORDER BY total DESC`, [eid, ano]).catch(()=>({rows:[]})),

      // Top salários
      query(`SELECT nome_completo AS nome, cargo, salario_base
        FROM funcionario WHERE empresa_id=$1 AND estado='ativo'
        ORDER BY salario_base DESC LIMIT 5`, [eid]),
    ]);

    const kpis = kpisR.rows[0];
    const evolucaoSalarial = MESES.map((mes, i) => ({
      mes,
      total: parseFloat(salMesR.rows.find(r => r.mes === i+1)?.total || 0),
    }));

    res.json({
      kpis: {
        total_colaboradores: kpis.total_colaboradores,
        novos_ano: kpis.novos_ano,
        rotatividade: 0,
        custo_mensal: kpis.custo_mensal,
      },
      por_departamento: deptoR.rows,
      por_contrato: contratoR.rows,
      evolucao_salarial: evolucaoSalarial,
      faltas_tipo: faltasR.rows,
      top_salarios: topSalR.rows,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Financeiro ────────────────────────────────────────────────────────────────
router.get('/financeiro', autenticar, async (req, res) => {
  try {
    const ano = parseInt(req.query.ano) || new Date().getFullYear();
    const eid = req.empresaId;

    const [kpisR, evolR, estadoR, despCatR] = await Promise.all([
      query(`SELECT
        COALESCE(SUM(total),0) AS faturacao_total,
        COALESCE(SUM(CASE WHEN estado='paga' THEN total ELSE 0 END),0) AS recebido,
        COALESCE(SUM(CASE WHEN estado!='paga' AND estado!='anulada' THEN total ELSE 0 END),0) AS em_aberto
        FROM fatura WHERE empresa_id=$1 AND EXTRACT(YEAR FROM data_emissao)=$2`, [eid, ano]),

      query(`SELECT EXTRACT(MONTH FROM data_emissao) AS mes_num,
        SUM(total) AS faturado,
        SUM(CASE WHEN estado='paga' THEN total ELSE 0 END) AS recebido
        FROM fatura WHERE empresa_id=$1 AND EXTRACT(YEAR FROM data_emissao)=$2
        GROUP BY mes_num ORDER BY mes_num`, [eid, ano]),

      query(`SELECT estado, COUNT(*) AS total, SUM(total) AS valor
        FROM fatura WHERE empresa_id=$1 AND EXTRACT(YEAR FROM data_emissao)=$2
        GROUP BY estado`, [eid, ano]),

      query(`SELECT categoria, SUM(valor) AS total
        FROM despesa WHERE empresa_id=$1 AND EXTRACT(YEAR FROM data_despesa)=$2
        GROUP BY categoria ORDER BY total DESC`, [eid, ano]).catch(()=>({rows:[]})),
    ]);

    const despTotal = despCatR.rows.reduce((a,r) => a+parseFloat(r.total||0), 0);
    const evolucao = MESES.map((mes, i) => {
      const r = evolR.rows.find(x => parseInt(x.mes_num) === i+1);
      return { mes, faturado: parseFloat(r?.faturado||0), recebido: parseFloat(r?.recebido||0) };
    });

    res.json({
      kpis: {
        faturacao_total: kpisR.rows[0].faturacao_total,
        recebido: kpisR.rows[0].recebido,
        em_aberto: kpisR.rows[0].em_aberto,
        despesas_total: despTotal,
      },
      evolucao,
      faturas_estado: estadoR.rows,
      despesas_categoria: despCatR.rows,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Comercial / CRM ───────────────────────────────────────────────────────────
router.get('/comercial', autenticar, async (req, res) => {
  try {
    const ano = parseInt(req.query.ano) || new Date().getFullYear();
    const eid = req.empresaId;

    const [kpisR, funilR, setorR, ganhosMesR] = await Promise.all([
      query(`SELECT
        COALESCE(SUM(CASE WHEN etapa NOT IN ('fechado_ganho','fechado_perdido') THEN valor ELSE 0 END),0) AS pipeline_valor,
        COALESCE(SUM(CASE WHEN etapa='fechado_ganho' THEN valor ELSE 0 END),0) AS ganhos_valor,
        COUNT(*) FILTER (WHERE etapa NOT IN ('fechado_ganho','fechado_perdido')) AS em_curso,
        COUNT(*) FILTER (WHERE etapa='fechado_ganho' AND EXTRACT(YEAR FROM data_fecho_real)=$2) AS ganhos_ano,
        COUNT(*) FILTER (WHERE etapa IN ('fechado_ganho','fechado_perdido') AND EXTRACT(YEAR FROM data_fecho_real)=$2) AS total_fechados
        FROM crm_oportunidade WHERE empresa_id=$1`, [eid, ano]),

      query(`SELECT etapa, COUNT(*) AS total, COALESCE(SUM(valor),0) AS valor
        FROM crm_oportunidade WHERE empresa_id=$1
        GROUP BY etapa ORDER BY
        CASE etapa WHEN 'lead' THEN 1 WHEN 'qualificado' THEN 2 WHEN 'proposta' THEN 3
          WHEN 'negociacao' THEN 4 WHEN 'fechado_ganho' THEN 5 ELSE 6 END`, [eid]),

      query(`SELECT COALESCE(ce.setor,'Outro') AS setor, COUNT(o.id) AS total
        FROM crm_oportunidade o
        LEFT JOIN crm_empresa ce ON ce.id=o.crm_empresa_id
        WHERE o.empresa_id=$1
        GROUP BY ce.setor ORDER BY total DESC`, [eid]),

      query(`SELECT EXTRACT(MONTH FROM data_fecho_real) AS mes_num, SUM(valor) AS valor
        FROM crm_oportunidade WHERE empresa_id=$1 AND etapa='fechado_ganho'
          AND EXTRACT(YEAR FROM data_fecho_real)=$2
        GROUP BY mes_num ORDER BY mes_num`, [eid, ano]),
    ]);

    const kpis = kpisR.rows[0];
    const taxaConversao = kpis.total_fechados > 0
      ? Math.round((kpis.ganhos_ano / kpis.total_fechados) * 100) : 0;

    const ganhosMes = MESES.map((mes, i) => ({
      mes,
      valor: parseFloat(ganhosMesR.rows.find(r => parseInt(r.mes_num) === i+1)?.valor || 0),
    }));

    res.json({
      kpis: {
        pipeline_valor: kpis.pipeline_valor,
        ganhos_valor: kpis.ganhos_valor,
        em_curso: kpis.em_curso,
        taxa_conversao: taxaConversao,
      },
      funil: funilR.rows,
      por_setor: setorR.rows,
      ganhos_mes: ganhosMes,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ── CSV de Férias ─────────────────────────────────────────────────────────────
router.get('/ferias/csv', autenticar, async (req, res) => {
  try {
    const { ano = new Date().getFullYear() } = req.query;
    const { rows } = await query(`
      SELECT f.nome_completo, f.numero_funcionario, f.cargo,
        COALESCE(d.nome,'') AS departamento,
        pf.data_inicio, pf.data_fim, pf.num_dias, pf.estado, pf.comentario
      FROM pedido_ferias pf
      JOIN funcionario f ON f.id = pf.funcionario_id
      LEFT JOIN departamento d ON d.id = f.departamento_id
      WHERE f.empresa_id=$1
        AND (EXTRACT(YEAR FROM pf.data_inicio)=$2 OR EXTRACT(YEAR FROM pf.data_fim)=$2)
      ORDER BY pf.data_inicio, f.nome_completo
    `, [req.empresaId, parseInt(ano)]);

    const fmtD = v => v ? new Date(v).toLocaleDateString('pt-PT') : '';
    const header = 'Nome;Nº Funcionário;Cargo;Departamento;Início;Fim;Dias;Estado;Comentário';
    const linhas = rows.map(r => [
      `"${r.nome_completo||''}"`, r.numero_funcionario||'', `"${r.cargo||''}"`,
      `"${r.departamento||''}"`, fmtD(r.data_inicio), fmtD(r.data_fim),
      r.num_dias||'', r.estado||'', `"${r.comentario||''}"`
    ].join(';')).join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ferias_${ano}.csv"`);
    res.send('\uFEFF' + header + '\n' + linhas);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CSV de Faltas ─────────────────────────────────────────────────────────────
router.get('/faltas/csv', autenticar, async (req, res) => {
  try {
    const { ano = new Date().getFullYear() } = req.query;
    const { rows } = await query(`
      SELECT f.nome_completo, f.numero_funcionario, f.cargo,
        fa.data_falta, fa.tipo_falta, fa.justificada, fa.motivo
      FROM falta fa
      JOIN funcionario f ON f.id = fa.funcionario_id
      WHERE f.empresa_id=$1 AND EXTRACT(YEAR FROM fa.data_falta)=$2
      ORDER BY fa.data_falta, f.nome_completo
    `, [req.empresaId, parseInt(ano)]).catch(()=>({rows:[]}));

    const fmtD = v => v ? new Date(v).toLocaleDateString('pt-PT') : '';
    const header = 'Nome;Nº Funcionário;Cargo;Data;Tipo;Justificada;Motivo';
    const linhas = rows.map(r => [
      `"${r.nome_completo||''}"`, r.numero_funcionario||'', `"${r.cargo||''}"`,
      fmtD(r.data_falta), r.tipo_falta||'', r.justificada?'Sim':'Não', `"${r.motivo||''}"`
    ].join(';')).join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="faltas_${ano}.csv"`);
    res.send('\uFEFF' + header + '\n' + linhas);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
