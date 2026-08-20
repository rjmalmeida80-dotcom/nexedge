'use strict';

const cron = require('node-cron');
const { query } = require('../config/database');

/**
 * Calcula e atualiza o saldo de férias de todos os funcionários
 * Regra: 22 dias úteis por ano, calculados proporcionalmente
 */
async function atualizarSaldoFerias() {
  console.log('🔄 [CRON] A atualizar saldos de férias...');
  try {
    const anoAtual = new Date().getFullYear();
    // Para funcionários com admissão anterior ao ano atual: garantir 22 dias
    // Para admissões durante o ano: proporcional (2 dias por mês completo)
    await query(`
      UPDATE funcionario SET dias_ferias_saldo = (
        CASE
          WHEN EXTRACT(YEAR FROM data_admissao) < $1
          THEN 22 - COALESCE(dias_ferias_gozados, 0)
          ELSE GREATEST(0,
            FLOOR(EXTRACT(MONTH FROM AGE(NOW(), data_admissao)) * (22.0/12)) - COALESCE(dias_ferias_gozados,0)
          )
        END
      )
      WHERE estado = 'ativo'
    `, [anoAtual]);
    console.log('✅ [CRON] Saldos de férias atualizados');
  } catch (err) {
    console.error('❌ [CRON] Erro ao atualizar saldos de férias:', err.message);
  }
}

/**
 * Alerta para contratos a terminar em 30 e 60 dias
 */
async function alertarContratosTerminar() {
  console.log('🔄 [CRON] A verificar contratos a terminar...');
  try {
    const { rows } = await query(`
      SELECT f.id, f.nome_completo, f.data_fim_contrato, f.empresa_id,
             u.id AS resp_utilizador_id
      FROM funcionario f
      LEFT JOIN funcionario resp ON resp.id = f.responsavel_id
      LEFT JOIN utilizador u ON u.id = resp.utilizador_id
      WHERE f.estado = 'ativo'
        AND f.data_fim_contrato IS NOT NULL
        AND f.data_fim_contrato BETWEEN CURRENT_DATE + INTERVAL '29 days'
                                    AND CURRENT_DATE + INTERVAL '31 days'
    `);

    for (const f of rows) {
      // Notificar RH da empresa
      const { rows: rhs } = await query(
        `SELECT id FROM utilizador WHERE empresa_id=$1 AND perfil IN ('rh','admin_empresa') AND ativo=true`,
        [f.empresa_id]
      );
      for (const rh of rhs) {
        await query(`
          INSERT INTO notificacao (utilizador_id, titulo, mensagem, tipo, link)
          VALUES ($1, $2, $3, 'aviso', '/funcionarios/$4')
          ON CONFLICT DO NOTHING
        `, [rh.id,
            `Contrato a terminar — ${f.nome_completo}`,
            `O contrato de ${f.nome_completo} termina a ${f.data_fim_contrato}. Decida sobre renovação.`,
            f.id]);
      }
    }
    if (rows.length) console.log(`✅ [CRON] ${rows.length} alertas de contrato enviados`);
  } catch (err) {
    console.error('❌ [CRON] Erro em alertas de contratos:', err.message);
  }
}

/**
 * Verifica excesso de horas extra (limite 150h/ano — CT art. 268.º)
 */
async function verificarHorasExtra() {
  console.log('🔄 [CRON] A verificar horas extra acumuladas...');
  try {
    const anoAtual = new Date().getFullYear();
    const { rows } = await query(`
      SELECT f.id AS funcionario_id, f.nome_completo, f.empresa_id,
             SUM(rp.horas_extra) AS total_he
      FROM registo_ponto rp
      JOIN funcionario f ON f.id = rp.funcionario_id
      WHERE EXTRACT(YEAR FROM rp.data) = $1
      GROUP BY f.id, f.nome_completo, f.empresa_id
      HAVING SUM(rp.horas_extra) >= 130
    `, [anoAtual]);

    for (const r of rows) {
      const { rows: rhs } = await query(
        `SELECT id FROM utilizador WHERE empresa_id=$1 AND perfil IN ('rh','admin_empresa') AND ativo=true`,
        [r.empresa_id]
      );
      for (const rh of rhs) {
        await query(`
          INSERT INTO notificacao (utilizador_id, titulo, mensagem, tipo)
          VALUES ($1,$2,$3,'aviso')
        `, [rh.id,
            `⚠️ Horas extra — ${r.nome_completo}`,
            `${r.nome_completo} acumulou ${Math.round(r.total_he)}h extra em ${anoAtual}. Limite legal: 150h (CT art. 268.º).`]);
      }
    }
  } catch (err) {
    console.error('❌ [CRON] Erro ao verificar horas extra:', err.message);
  }
}

/**
 * Reset anual do saldo de férias (1 de janeiro)
 */
async function resetAnualFerias() {
  console.log('🔄 [CRON] Reset anual de saldos de férias...');
  try {
    await query(`
      UPDATE funcionario SET
        dias_ferias_gozados = 0,
        dias_ferias_saldo = dias_ferias_ano
      WHERE estado = 'ativo'
    `);

    // Inserir feriados do novo ano automaticamente
    const anoNovo = new Date().getFullYear();
    console.log(`✅ [CRON] Saldos de férias resetados para ${anoNovo}`);
  } catch (err) {
    console.error('❌ [CRON] Erro no reset anual:', err.message);
  }
}


/**
 * Limpar contas trial não activadas após 24h
 */
async function limparContasNaoActivadas() {
  try {
    // Encontrar utilizadores criados há mais de 24h que ainda não activaram
    const { rows: utilizadores } = await query(`
      SELECT u.id, u.email, u.empresa_id, u.nome_completo
      FROM utilizador u
      WHERE u.email_verificado = false
        AND u.ativo = false
        AND u.token_activacao IS NOT NULL
        AND u.token_activacao_expira < NOW()
        AND u.perfil = 'admin_empresa'
    `).catch(()=>({rows:[]}));

    if (!utilizadores.length) return;

    for (const u of utilizadores) {
      // Apagar logs e referências
      await query(`DELETE FROM log_auditoria WHERE utilizador_id=$1`, [u.id]).catch(()=>{});
      await query(`DELETE FROM notificacao WHERE utilizador_id=$1`, [u.id]).catch(()=>{});
      // Apagar utilizador e empresa
      await query(`DELETE FROM utilizador WHERE id=$1`, [u.id]).catch(()=>{});
      await query(`DELETE FROM empresa WHERE id=$1 AND ativo=false`, [u.empresa_id]).catch(()=>{});
      // Actualizar mensagem no interesse
      await query(`UPDATE interesse_contacto SET mensagem='Registo expirado — link não activado (24h)' WHERE email=$1`, [u.email]).catch(()=>{});
      console.log(`[CRON] Conta expirada limpa: ${u.email}`);
    }
    console.log(`✅ [CRON] ${utilizadores.length} contas expiradas limpas`);
  } catch(e) {
    console.error('❌ [CRON] Erro limpeza contas:', e.message);
  }
}

function iniciar() {
  // Atualizar saldos de férias — todos os dias às 06:00
  cron.schedule('0 6 * * *', atualizarSaldoFerias, { timezone: 'Europe/Lisbon' });

  // Alertas de contratos — todos os dias às 08:00
  cron.schedule('0 8 * * *', alertarContratosTerminar, { timezone: 'Europe/Lisbon' });

  // Verificar horas extra — todas as segundas às 07:00
  cron.schedule('0 7 * * 1', verificarHorasExtra, { timezone: 'Europe/Lisbon' });

  // Aniversários — todos os dias às 08:30 — criar notificação para RH
  cron.schedule('30 8 * * *', async () => {
    try {
      const hoje = new Date();
      const dia = hoje.getDate();
      const mes = hoje.getMonth() + 1;
      const { rows: empresas } = await query('SELECT id FROM empresa WHERE ativo=true');
      for (const emp of empresas) {
        const { rows: aniversariantes } = await query(`
          SELECT id, nome_completo, cargo, data_nascimento,
                 EXTRACT(YEAR FROM AGE(CURRENT_DATE, data_nascimento)) AS idade
          FROM funcionario
          WHERE empresa_id=$1 AND estado='ativo'
            AND EXTRACT(MONTH FROM data_nascimento)=$2
            AND EXTRACT(DAY FROM data_nascimento)=$3
        `, [emp.id, mes, dia]);
        for (const f of aniversariantes) {
          // Create notification for RH/Admin
          await query(`
            INSERT INTO notificacao (empresa_id, titulo, mensagem, tipo, referencia_id, referencia_tipo)
            VALUES ($1,$2,$3,'aniversario',$4,'funcionario')
            ON CONFLICT DO NOTHING
          `, [emp.id,
              `🎂 Aniversário — ${f.nome_completo}`,
              `${f.nome_completo} (${f.cargo}) faz ${f.idade} anos hoje! Não se esqueça de enviar os parabéns.`,
              f.id]);
        }
      }
    } catch(e) { console.warn('[CRON] Aniversários:', e.message); }
  }, { timezone: 'Europe/Lisbon' });

  // Alertas de faltas excessivas — todas as segundas às 09:00
  cron.schedule('0 9 * * 1', async () => {
    try {
      const { rows: empresas } = await query('SELECT id FROM empresa WHERE ativo=true');
      const hoje = new Date();
      const inicioMes = new Date(hoje.getFullYear(), hoje.getMonth(), 1).toISOString().split('T')[0];
      for (const emp of empresas) {
        const { rows: comFaltas } = await query(`
          SELECT f.id, f.nome_completo, f.cargo, COUNT(fa.id) AS num_faltas,
                 COUNT(CASE WHEN fa.justificada=false THEN 1 END) AS injustificadas
          FROM funcionario f
          JOIN falta fa ON fa.funcionario_id=f.id
          WHERE f.empresa_id=$1 AND f.estado='ativo'
            AND fa.data >= $2
          GROUP BY f.id
          HAVING COUNT(fa.id) >= 3
          ORDER BY num_faltas DESC
        `, [emp.id, inicioMes]);
        for (const f of comFaltas) {
          await query(`
            INSERT INTO notificacao (empresa_id, titulo, mensagem, tipo, referencia_id, referencia_tipo)
            VALUES ($1,$2,$3,'alerta_faltas',$4,'funcionario')
          `, [emp.id,
              `⚠️ Faltas excessivas — ${f.nome_completo}`,
              `${f.nome_completo} tem ${f.num_faltas} falta(s) este mês (${f.injustificadas} injustificada(s)). Considere uma conversa.`,
              f.id]);
        }
      }
    } catch(e) { console.warn('[CRON] Alertas faltas:', e.message); }
  }, { timezone: 'Europe/Lisbon' });

  // Reset anual de férias — 1 de janeiro às 00:01
  cron.schedule('1 0 1 1 *', resetAnualFerias, { timezone: 'Europe/Lisbon' });

  // Limpar contas trial não activadas (corre de hora a hora)
  cron.schedule('0 * * * *', limparContasNaoActivadas, { timezone: 'Europe/Lisbon' });
  console.log('✅ Limpeza de contas expiradas agendada (de hora a hora)');

  console.log('✅ Tarefas automáticas agendadas (fuso horário: Europe/Lisbon)');
}

module.exports = { iniciar, atualizarSaldoFerias, alertarContratosTerminar, verificarHorasExtra };

// ── TAREFAS AUTOMÁTICAS ───────────────────────────────────────────────────

/**
 * Actualizar estado de contratos expirados (diariamente à meia-noite)
 */
async function actualizarContratosExpirados() {
  try {
    const { rowCount } = await query(`
      UPDATE funcionario
      SET estado = 'inativo', atualizado_em = NOW()
      WHERE estado = 'ativo'
        AND data_fim_contrato IS NOT NULL
        AND data_fim_contrato < CURRENT_DATE
        AND tipo_contrato != 'sem_termo'
    `);
    if (rowCount > 0) console.log(`✅ [CRON] ${rowCount} contrato(s) expirado(s) marcado(s) como inativo`);
  } catch(e) { console.error('❌ [CRON] actualizarContratosExpirados:', e.message); }
}

/**
 * Calcular diuturnidades automáticas por antiguidade (1º de cada mês)
 * Regra geral: diuturnidade após cada 3 anos de serviço (depende do CCT)
 * Por defeito: 1% do salário base por cada 3 anos completos
 */
async function calcularDiuturniades() {
  try {
    const { rows } = await query(`
      SELECT id, salario_base, data_admissao, diuturnidades
      FROM funcionario
      WHERE estado = 'ativo'
        AND data_admissao IS NOT NULL
    `);

    let actualizados = 0;
    for (const f of rows) {
      const anos = Math.floor((new Date() - new Date(f.data_admissao)) / (365.25 * 24 * 60 * 60 * 1000));
      const periodos = Math.floor(anos / 3); // 1 diuturnidade por cada 3 anos
      if (periodos > 0) {
        const novasDiut = Math.round(parseFloat(f.salario_base) * 0.01 * periodos * 100) / 100;
        if (Math.abs(novasDiut - parseFloat(f.diuturnidades || 0)) > 0.01) {
          await query('UPDATE funcionario SET diuturnidades=$1 WHERE id=$2', [novasDiut, f.id]);
          actualizados++;
        }
      }
    }
    if (actualizados > 0) console.log(`✅ [CRON] ${actualizados} diuturnidade(s) actualizadas`);
  } catch(e) { console.error('❌ [CRON] calcularDiuturnidades:', e.message); }
}

/**
 * Validar sobreposição de férias na mesma equipa (ao aprovar)
 * Esta função é chamada pelo feriasController antes de aprovar
 */
async function validarSobreposicaoFerias(funcionarioId, dataInicio, dataFim, empresaId) {
  const { rows } = await query(`
    SELECT f.id, fu.nome_completo, f.data_inicio, f.data_fim
    FROM ferias f
    JOIN funcionario fu ON fu.id = f.funcionario_id
    WHERE f.empresa_id = $1
      AND f.estado = 'aprovado'
      AND f.funcionario_id != $2
      AND fu.departamento_id = (SELECT departamento_id FROM funcionario WHERE id = $2)
      AND f.data_inicio <= $4 AND f.data_fim >= $3
  `, [empresaId, funcionarioId, dataInicio, dataFim]);
  return rows; // Array de conflitos
}

/**
 * Definir data próxima avaliação automaticamente (anual a partir da admissão)
 */
async function definirProximaAvaliacao() {
  try {
    const { rowCount } = await query(`
      UPDATE funcionario
      SET data_proxima_avaliacao = (
        data_admissao + (
          EXTRACT(YEAR FROM AGE(CURRENT_DATE, data_admissao))::INTEGER + 1
        ) * INTERVAL '1 year'
      )
      WHERE estado = 'ativo'
        AND data_admissao IS NOT NULL
        AND (data_proxima_avaliacao IS NULL OR data_proxima_avaliacao < CURRENT_DATE)
    `);
    if (rowCount > 0) console.log(`✅ [CRON] ${rowCount} data(s) de avaliação actualizadas`);
  } catch(e) { console.error('❌ [CRON] definirProximaAvaliacao:', e.message); }
}

// Registar todas as tarefas automáticas
function iniciarTarefasAutomaticas() {
  // Contratos expirados — todos os dias à meia-noite
  cron.schedule('0 0 * * *', actualizarContratosExpirados);

  // Diuturnidades — 1º de cada mês
  cron.schedule('0 1 1 * *', calcularDiuturniades);

  // Próximas avaliações — todos os dias
  cron.schedule('0 2 * * *', definirProximaAvaliacao);

  console.log('✅ Tarefas automáticas iniciadas');
}

module.exports = {
  ...module.exports,
  iniciarTarefasAutomaticas,
  validarSobreposicaoFerias,
  actualizarContratosExpirados,
  calcularDiuturniades,
};
