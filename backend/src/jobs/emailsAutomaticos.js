'use strict';
const { query } = require('../config/database');
const email = require('../services/emailService');

async function alertasContratos() {
  try {
    const { rows } = await query(`
      SELECT f.nome_completo AS colaborador, f.data_fim_contrato, f.tipo_contrato,
        e.nome AS empresa, u.email AS email_gestor, u.nome_completo AS nome_gestor,
        EXTRACT(DAY FROM f.data_fim_contrato - CURRENT_DATE) AS dias
      FROM funcionario f
      JOIN empresa e ON e.id = f.empresa_id
      JOIN utilizador u ON u.empresa_id = e.id AND u.perfil IN ('admin_empresa','rh') AND u.ativo=true
      WHERE f.estado = 'ativo' AND f.data_fim_contrato IS NOT NULL
        AND f.data_fim_contrato BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'
        AND EXTRACT(DAY FROM f.data_fim_contrato - CURRENT_DATE) IN (30,15,7,3,1)
    `);
    for (const r of rows) {
      await email.enviarAlertaContrato({
        email: r.email_gestor, nomeGestor: r.nome_gestor,
        nomeColaborador: r.colaborador, tipoContrato: r.tipo_contrato || 'Contrato',
        dataFim: new Date(r.data_fim_contrato).toLocaleDateString('pt-PT'),
        diasRestantes: parseInt(r.dias),
      });
    }
    console.log(`✅ alertasContratos: ${rows.length} emails`);
  } catch(e) { console.error('❌ alertasContratos:', e.message); }
}

async function alertasTrial() {
  try {
    const { rows } = await query(`
      SELECT e.nome AS empresa, u.email, u.nome_completo AS nome,
        s.trial_fim, p.nome AS plano_nome,
        EXTRACT(DAY FROM s.trial_fim - CURRENT_DATE) AS dias
      FROM subscricao s
      JOIN empresa e ON e.id = s.empresa_id
      JOIN utilizador u ON u.empresa_id = e.id AND u.perfil='admin_empresa' AND u.ativo=true
      JOIN plano_saas p ON p.id = s.plano_id
      WHERE s.estado='trial'
        AND s.trial_fim BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '5 days'
        AND EXTRACT(DAY FROM s.trial_fim - CURRENT_DATE) IN (5,3,1)
    `);
    for (const r of rows) {
      await email.enviarAlertaTrial({
        email: r.email, nome: r.nome, empresa: r.empresa,
        diasRestantes: parseInt(r.dias), planoActual: r.plano_nome,
      });
    }
    console.log(`✅ alertasTrial: ${rows.length} emails`);
  } catch(e) { console.error('❌ alertasTrial:', e.message); }
}

async function lembretesAtraso() {
  try {
    const { rows } = await query(`
      SELECT f.numero_completo, f.data_vencimento,
        f.total - COALESCE(f.valor_pago,0) AS em_divida,
        e.nome AS empresa_emissora, f.cliente_nome, f.cliente_email,
        EXTRACT(DAY FROM CURRENT_DATE - f.data_vencimento) AS dias_atraso
      FROM fatura f
      JOIN empresa e ON e.id = f.empresa_id
      WHERE f.estado NOT IN ('paga','anulada')
        AND f.data_vencimento < CURRENT_DATE
        AND f.cliente_email IS NOT NULL
        AND f.total - COALESCE(f.valor_pago,0) > 0
        AND EXTRACT(DAY FROM CURRENT_DATE - f.data_vencimento) IN (3,7,15,30)
    `);
    for (const r of rows) {
      await email.enviarLembreteAtraso({
        email: r.cliente_email, nomeCliente: r.cliente_nome || 'Cliente',
        empresa: r.empresa_emissora, numeroFatura: r.numero_completo,
        dataVencimento: new Date(r.data_vencimento).toLocaleDateString('pt-PT'),
        diasAtraso: parseInt(r.dias_atraso),
        valorEmDivida: parseFloat(r.em_divida).toLocaleString('pt-PT',{minimumFractionDigits:2})+'€',
      });
    }
    console.log(`✅ lembretesAtraso: ${rows.length} emails`);
  } catch(e) { console.error('❌ lembretesAtraso:', e.message); }
}

async function recibosAutomaticos() {
  try {
    const { rows } = await query(`
      SELECT s.id, s.mes, s.ano, s.salario_base, s.liquido, s.irs_retido,
        s.seg_social_func, s.total_abonos, s.total_descontos,
        f.nome_completo, f.email, e.nome AS empresa_nome
      FROM salario s
      JOIN funcionario f ON f.id = s.funcionario_id
      JOIN empresa e ON e.id = s.empresa_id
      WHERE DATE(s.processado_em) = CURRENT_DATE
        AND (s.email_enviado IS NULL OR s.email_enviado = false)
        AND f.email IS NOT NULL AND f.email != ''
    `);
    for (const r of rows) {
      await email.enviarReciboSalario({
        email: r.email, nome: r.nome_completo, empresa: r.empresa_nome,
        mes: r.mes, ano: r.ano, salarioBase: r.salario_base,
        liquido: r.liquido, irs: r.irs_retido, segSocial: r.seg_social_func,
        totalAbonos: r.total_abonos, totalDescontos: r.total_descontos,
      });
      await query('UPDATE salario SET email_enviado=true WHERE id=$1', [r.id]).catch(()=>{});
    }
    console.log(`✅ recibosAutomaticos: ${rows.length} emails`);
  } catch(e) { console.error('❌ recibosAutomaticos:', e.message); }
}


// ── Alertas de aniversários ───────────────────────────────────────────────────
async function enviarAlertasAniversarios() {
  try {
    console.log('🎂 A verificar aniversários...');
    const { rows } = await query(`
      SELECT f.id, f.nome_completo, f.data_nascimento,
        EXTRACT(YEAR FROM AGE(f.data_nascimento)) + 1 AS proxima_idade,
        e.id AS empresa_id, e.nome AS empresa_nome,
        ARRAY_AGG(DISTINCT u.email) FILTER (WHERE u.email IS NOT NULL) AS emails_gestores
      FROM funcionario f
      JOIN empresa e ON e.id = f.empresa_id
      LEFT JOIN utilizador u ON u.empresa_id = f.empresa_id
        AND u.perfil IN ('admin_empresa','rh','diretor')
        AND u.ativo=true
      WHERE f.estado = 'ativo'
        AND f.data_nascimento IS NOT NULL
        AND EXTRACT(MONTH FROM f.data_nascimento) = EXTRACT(MONTH FROM CURRENT_DATE + INTERVAL '1 day')
        AND EXTRACT(DAY FROM f.data_nascimento) = EXTRACT(DAY FROM CURRENT_DATE + INTERVAL '1 day')
      GROUP BY f.id, e.id
    `);

    for (const func of rows) {
      // Notificação interna para todos os gestores
      const { rows: gestores } = await query(
        `SELECT id FROM utilizador WHERE empresa_id=$1 AND perfil IN ('admin_empresa','rh','diretor') AND ativo=true`,
        [func.empresa_id]
      );

      for (const g of gestores) {
        await query(`
          INSERT INTO notificacao (utilizador_id, empresa_id, titulo, mensagem, tipo, url_accao)
          VALUES ($1,$2,$3,$4,'info','/funcionarios')
        `, [g.id, func.empresa_id,
            `🎂 Aniversário amanhã — ${func.nome_completo}`,
            `${func.nome_completo} faz ${func.proxima_idade} anos amanhã. Não te esqueças de felicitar!`
        ]).catch(()=>{});
      }

      console.log(`✅ Alerta aniversário: ${func.nome_completo} (${func.empresa_nome})`);
    }

    if (rows.length === 0) console.log('Sem aniversários amanhã');
  } catch(e) { console.error('❌ Erro alertas aniversários:', e.message); }
}

module.exports = {
  enviarAlertasAniversarios, alertasContratos, alertasTrial, lembretesAtraso, recibosAutomaticos };
