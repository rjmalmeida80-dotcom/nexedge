'use strict';
/**
 * NexEdge — Motor de Automações
 * Corre via cron jobs a cada 15min / hora / dia
 * 
 * Automações implementadas:
 * 1. ITSM: escalamento por SLA breach
 * 2. ITSM: notificação ao solicitante quando resolvido
 * 3. ITSM: lembrete agente para tickets pendentes > 24h
 * 4. RH: onboarding automático novo funcionário
 * 5. RH: offboarding automático fim de contrato
 * 6. RH: alerta fim período experimental
 * 7. Faturação: lembretes vencimento (3, 7, 15 dias)
 * 8. Financeiro: alerta tesouraria saldo baixo
 */

const { query, transaction } = require('../config/database');
const { enviarEmail } = require('./emailService');

// ── ITSM AUTOMAÇÕES ────────────────────────────────────────────────────────────

/**
 * Escalamento automático: tickets com SLA breach sem resposta
 * Corre: a cada 15 minutos
 */
async function escalarTicketsSLA() {
  console.log('[Automação] A verificar SLA breaches...');
  
  // Tickets abertos com SLA violado e sem escalamento nas últimas 2h
  const r = await query(`
    SELECT t.*, e.email as empresa_email, e.nome as empresa_nome,
           u.email as atribuido_email, u.nome_completo as atribuido_nome,
           g.email as gestor_email, g.nome_completo as gestor_nome
    FROM itsm_ticket t
    JOIN empresa e ON e.id = t.empresa_id
    LEFT JOIN utilizador u ON u.id = t.atribuido_a
    LEFT JOIN utilizador g ON g.perfil IN ('admin_empresa', 'rh')
      AND g.empresa_id = t.empresa_id
      AND g.id != t.atribuido_a
    WHERE t.estado IN ('aberto', 'em_progresso')
      AND t.data_limite_resolucao < NOW()
      AND (t.ultimo_escalamento IS NULL OR t.ultimo_escalamento < NOW() - INTERVAL '2 hours')
    LIMIT 50
  `).catch(() => ({ rows: [] }));

  for (const ticket of r.rows) {
    // Registar escalamento
    await query(`
      UPDATE itsm_ticket SET ultimo_escalamento = NOW() WHERE id = $1
    `, [ticket.id]).catch(() => {});

    // Comentário automático de sistema
    await query(`
      INSERT INTO itsm_comentario (ticket_id, tipo, conteudo, "visivelParaCliente")
      VALUES ($1, 'sistema', $2, false)
    `, [
      ticket.id,
      `⚠️ ESCALAMENTO AUTOMÁTICO: SLA violado às ${new Date().toLocaleString('pt-PT')}. Prioridade: ${ticket.prioridade.toUpperCase()}.`
    ]).catch(() => {});

    // Notificação in-app ao gestor
    if (ticket.gestor_email) {
      await query(`
        INSERT INTO notificacao (utilizador_id, titulo, mensagem, tipo, url_accao)
        SELECT id, $1, $2, 'warning', '/itsm'
        FROM utilizador WHERE email = $3 AND empresa_id = $4 LIMIT 1
      `, [
        `🚨 SLA Breach: ${ticket.numero}`,
        `Ticket "${ticket.titulo}" ultrapassou o SLA. Prioridade: ${ticket.prioridade}.`,
        ticket.gestor_email,
        ticket.empresa_id
      ]).catch(() => {});
    }

    // Email de escalamento
    if (ticket.atribuido_email) {
      await enviarEmail({
        to: ticket.atribuido_email,
        subject: `[URGENTE] SLA Breach — ${ticket.numero}: ${ticket.titulo}`,
        html: `
          <div style="font-family:Inter,sans-serif;max-width:600px">
            <div style="background:#ef4444;color:white;padding:16px 24px;border-radius:8px 8px 0 0">
              <h2 style="margin:0">⚠️ SLA Breach — Acção Imediata Necessária</h2>
            </div>
            <div style="background:#fff;border:1px solid #e5e7eb;padding:24px;border-radius:0 0 8px 8px">
              <p>O ticket <strong>${ticket.numero}</strong> ultrapassou o SLA de resolução.</p>
              <table style="width:100%;border-collapse:collapse;margin:16px 0">
                <tr><td style="padding:8px;color:#6b7280">Ticket</td><td style="padding:8px;font-weight:600">${ticket.numero}</td></tr>
                <tr style="background:#f9fafb"><td style="padding:8px;color:#6b7280">Título</td><td style="padding:8px">${ticket.titulo}</td></tr>
                <tr><td style="padding:8px;color:#6b7280">Prioridade</td><td style="padding:8px;color:#ef4444;font-weight:600">${ticket.prioridade.toUpperCase()}</td></tr>
                <tr style="background:#f9fafb"><td style="padding:8px;color:#6b7280">SLA Expirou</td><td style="padding:8px;color:#ef4444">${new Date(ticket.data_limite_resolucao).toLocaleString('pt-PT')}</td></tr>
              </table>
              <a href="https://app.nexedge.pt/itsm" style="display:inline-block;background:#4f46e5;color:white;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600">
                Ver Ticket →
              </a>
            </div>
          </div>
        `
      }).catch(() => {});
    }
  }

  if (r.rows.length > 0) {
    console.log(`[Automação] ${r.rows.length} tickets escalados por SLA breach`);
  }
}

/**
 * Notificação ao solicitante quando ticket é resolvido
 * Corre: a cada 15 minutos
 */
async function notificarResolucao() {
  const r = await query(`
    SELECT t.*, u.email as solicitante_email, u.nome_completo as solicitante_nome
    FROM itsm_ticket t
    JOIN utilizador u ON u.id = t.solicitante_id
    WHERE t.estado = 'resolvido'
      AND t.notificado_resolucao IS NULL
      AND t.resolvido_em > NOW() - INTERVAL '24 hours'
    LIMIT 50
  `).catch(() => ({ rows: [] }));

  for (const ticket of r.rows) {
    await query(`UPDATE itsm_ticket SET notificado_resolucao = NOW() WHERE id = $1`, [ticket.id]).catch(() => {});

    if (ticket.solicitante_email) {
      await enviarEmail({
        to: ticket.solicitante_email,
        subject: `✅ Resolvido: ${ticket.numero} — ${ticket.titulo}`,
        html: `
          <div style="font-family:Inter,sans-serif;max-width:600px">
            <div style="background:#10b981;color:white;padding:16px 24px;border-radius:8px 8px 0 0">
              <h2 style="margin:0">✅ O teu pedido foi resolvido</h2>
            </div>
            <div style="background:#fff;border:1px solid #e5e7eb;padding:24px;border-radius:0 0 8px 8px">
              <p>Olá ${ticket.solicitante_nome},</p>
              <p>O teu pedido <strong>${ticket.numero}</strong> foi marcado como resolvido.</p>
              <p><strong>Resolução:</strong> ${ticket.resolucao || 'Ver detalhes no portal'}</p>
              <p style="margin-top:20px">Como foi o nosso suporte? A tua opinião é importante:</p>
              <div style="display:flex;gap:8px;margin:12px 0">
                ${[1,2,3,4,5].map(n => `<a href="https://app.nexedge.pt/api/itsm/tickets/${ticket.id}/satisfacao-email?nota=${n}&token=${ticket.id}" style="font-size:24px;text-decoration:none">⭐</a>`).join('')}
              </div>
              <a href="https://app.nexedge.pt/itsm-app" style="display:inline-block;background:#4f46e5;color:white;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600;margin-top:12px">
                Ver detalhes →
              </a>
            </div>
          </div>
        `
      }).catch(() => {});
    }

    // Notificação in-app
    await query(`
      INSERT INTO notificacao (utilizador_id, titulo, mensagem, tipo, url_accao)
      VALUES ($1, $2, $3, 'success', '/itsm')
    `, [ticket.solicitante_id, `✅ Pedido resolvido: ${ticket.numero}`, ticket.titulo]).catch(() => {});
  }
}

/**
 * Lembrete agente: tickets pendentes sem actividade > 24h
 * Corre: diariamente às 9h
 */
async function lembreteTicketsPendentes() {
  const r = await query(`
    SELECT t.*, u.email as agente_email, u.nome_completo as agente_nome
    FROM itsm_ticket t
    JOIN utilizador u ON u.id = t.atribuido_a
    WHERE t.estado IN ('aberto', 'em_progresso', 'pendente')
      AND t.atribuido_a IS NOT NULL
      AND t.actualizado_em < NOW() - INTERVAL '24 hours'
    ORDER BY t.prioridade DESC, t.criado_em ASC
    LIMIT 100
  `).catch(() => ({ rows: [] }));

  // Agrupar por agente
  const porAgente = {};
  for (const ticket of r.rows) {
    if (!porAgente[ticket.atribuido_a]) {
      porAgente[ticket.atribuido_a] = { email: ticket.agente_email, nome: ticket.agente_nome, tickets: [] };
    }
    porAgente[ticket.atribuido_a].tickets.push(ticket);
  }

  for (const [agId, ag] of Object.entries(porAgente)) {
    if (!ag.email) continue;
    const urgentes = ag.tickets.filter(t => ['critica','alta'].includes(t.prioridade));
    
    await enviarEmail({
      to: ag.email,
      subject: `📋 ${ag.tickets.length} tickets pendentes aguardam a tua atenção`,
      html: `
        <div style="font-family:Inter,sans-serif;max-width:600px">
          <div style="background:#4f46e5;color:white;padding:16px 24px;border-radius:8px 8px 0 0">
            <h2 style="margin:0">📋 Resumo de Tickets Pendentes</h2>
          </div>
          <div style="background:#fff;border:1px solid #e5e7eb;padding:24px;border-radius:0 0 8px 8px">
            <p>Olá ${ag.nome},</p>
            <p>Tens <strong>${ag.tickets.length} tickets</strong> sem actividade nas últimas 24 horas${urgentes.length ? ` (${urgentes.length} urgentes!)` : ''}.</p>
            <table style="width:100%;border-collapse:collapse;margin:16px 0">
              <tr style="background:#f3f4f6"><th style="padding:8px;text-align:left">Número</th><th style="padding:8px;text-align:left">Título</th><th style="padding:8px">Prioridade</th></tr>
              ${ag.tickets.slice(0,10).map(t=>`
                <tr style="border-bottom:1px solid #e5e7eb">
                  <td style="padding:8px;font-family:monospace;color:#6b7280">${t.numero}</td>
                  <td style="padding:8px">${t.titulo}</td>
                  <td style="padding:8px;text-align:center;color:${t.prioridade==='critica'?'#ef4444':t.prioridade==='alta'?'#f97316':'#f59e0b'}">${t.prioridade}</td>
                </tr>`).join('')}
            </table>
            <a href="https://app.nexedge.pt/itsm-app" style="display:inline-block;background:#4f46e5;color:white;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600">
              Gerir Tickets →
            </a>
          </div>
        </div>
      `
    }).catch(() => {});
  }

  if (r.rows.length > 0) {
    console.log(`[Automação] Lembretes enviados para ${Object.keys(porAgente).length} agentes`);
  }
}

// ── RH AUTOMAÇÕES ──────────────────────────────────────────────────────────────

/**
 * Onboarding automático: novo funcionário
 * Corre: diariamente às 8h
 * Trigger: funcionários com data_admissao = hoje ou amanhã
 */
async function onboardingAutomatico() {
  const r = await query(`
    SELECT f.*, e.nome as empresa_nome, u.email as rh_email
    FROM funcionario f
    JOIN empresa e ON e.id = f.empresa_id
    LEFT JOIN utilizador u ON u.empresa_id = f.empresa_id AND u.perfil = 'rh'
    WHERE f.data_admissao BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '1 day'
      AND f.onboarding_iniciado IS NULL
      AND f.estado = 'ativo'
    LIMIT 20
  `).catch(() => ({ rows: [] }));

  for (const func of r.rows) {
    // Marcar onboarding iniciado
    await query(`UPDATE funcionario SET onboarding_iniciado = NOW() WHERE id = $1`, [func.id]).catch(() => {});

    // Criar ticket ITSM de onboarding
    const numero = `TK${new Date().getFullYear()}-ONB-${func.id.slice(0,8).toUpperCase()}`;
    await query(`
      INSERT INTO itsm_ticket (
        empresa_id, numero, tipo, titulo, descricao, prioridade, estado,
        funcionario_id, tags
      ) VALUES ($1, $2, 'task', $3, $4, 'alta', 'aberto', $5, $6)
      ON CONFLICT DO NOTHING
    `, [
      func.empresa_id,
      numero,
      `Onboarding: ${func.nome_completo}`,
      `Checklist de onboarding para ${func.nome_completo}\n\nCargo: ${func.cargo || '—'}\nDepartamento: ${func.departamento || '—'}\nData admissão: ${new Date(func.data_admissao).toLocaleDateString('pt-PT')}\n\nTarefas:\n- [ ] Criar conta de utilizador\n- [ ] Configurar email\n- [ ] Atribuir equipamento\n- [ ] Dar acesso aos sistemas\n- [ ] Apresentar à equipa\n- [ ] Enviar manual de acolhimento`,
      func.id,
      JSON.stringify(['onboarding', 'rh'])
    ]).catch(() => {});

    // Notificação à equipa RH
    await query(`
      INSERT INTO notificacao (utilizador_id, titulo, mensagem, tipo, url_accao)
      SELECT id, $1, $2, 'info', '/funcionarios'
      FROM utilizador WHERE empresa_id = $3 AND perfil IN ('rh', 'admin_empresa')
    `, [
      `👋 Novo colaborador: ${func.nome_completo}`,
      `${func.nome_completo} começa amanhã. Ticket de onboarding criado: ${numero}`,
      func.empresa_id
    ]).catch(() => {});

    console.log(`[Automação] Onboarding iniciado para ${func.nome_completo}`);
  }
}

/**
 * Alerta fim de período experimental
 * Corre: diariamente às 8h
 */
async function alertaFimExperimental() {
  const r = await query(`
    SELECT f.*, e.nome as empresa_nome
    FROM funcionario f
    JOIN empresa e ON e.id = f.empresa_id
    WHERE f.data_admissao + INTERVAL '90 days' BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'
      AND f.estado = 'ativo'
      AND f.tipo_contrato IN ('termo_certo', 'sem_termo')
    LIMIT 50
  `).catch(() => ({ rows: [] }));

  for (const func of r.rows) {
    const diasRestantes = Math.ceil((new Date(func.data_admissao).getTime() + 90*24*3600*1000 - Date.now()) / (24*3600*1000));
    
    await query(`
      INSERT INTO notificacao (utilizador_id, titulo, mensagem, tipo, url_accao)
      SELECT id, $1, $2, 'warning', '/funcionarios'
      FROM utilizador WHERE empresa_id = $3 AND perfil IN ('rh', 'admin_empresa')
      ON CONFLICT DO NOTHING
    `, [
      `⏰ Fim período experimental: ${func.nome_completo}`,
      `O período experimental de ${func.nome_completo} termina em ${diasRestantes} dias. Decisão necessária.`,
      func.empresa_id
    ]).catch(() => {});
  }

  if (r.rows.length > 0) {
    console.log(`[Automação] ${r.rows.length} alertas período experimental enviados`);
  }
}

/**
 * Offboarding automático: fim de contrato
 * Corre: diariamente às 8h
 */
async function offboardingAutomatico() {
  const r = await query(`
    SELECT f.*, e.nome as empresa_nome
    FROM funcionario f
    JOIN empresa e ON e.id = f.empresa_id
    WHERE f.data_saida BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'
      AND f.estado = 'ativo'
      AND f.offboarding_iniciado IS NULL
    LIMIT 20
  `).catch(() => ({ rows: [] }));

  for (const func of r.rows) {
    await query(`UPDATE funcionario SET offboarding_iniciado = NOW() WHERE id = $1`, [func.id]).catch(() => {});

    const diasRestantes = Math.ceil((new Date(func.data_saida).getTime() - Date.now()) / (24*3600*1000));
    const numero = `TK${new Date().getFullYear()}-OFF-${func.id.slice(0,8).toUpperCase()}`;

    // Ticket de offboarding
    await query(`
      INSERT INTO itsm_ticket (
        empresa_id, numero, tipo, titulo, descricao, prioridade, estado, funcionario_id, tags
      ) VALUES ($1, $2, 'task', $3, $4, 'alta', 'aberto', $5, $6)
      ON CONFLICT DO NOTHING
    `, [
      func.empresa_id, numero,
      `Offboarding: ${func.nome_completo}`,
      `Checklist de offboarding para ${func.nome_completo}\n\nData saída: ${new Date(func.data_saida).toLocaleDateString('pt-PT')}\nDias restantes: ${diasRestantes}\n\nTarefas:\n- [ ] Revogar acessos aos sistemas\n- [ ] Desactivar conta de email\n- [ ] Recolher equipamento\n- [ ] Liquidação de vencimento final\n- [ ] Carta de cessação\n- [ ] Entrevista de saída`,
      func.id, JSON.stringify(['offboarding', 'rh'])
    ]).catch(() => {});

    await query(`
      INSERT INTO notificacao (utilizador_id, titulo, mensagem, tipo, url_accao)
      SELECT id, $1, $2, 'warning', '/funcionarios'
      FROM utilizador WHERE empresa_id = $3 AND perfil IN ('rh', 'admin_empresa')
    `, [
      `🚪 Offboarding: ${func.nome_completo}`,
      `${func.nome_completo} sai em ${diasRestantes} dias. Ticket de offboarding criado.`,
      func.empresa_id
    ]).catch(() => {});

    console.log(`[Automação] Offboarding iniciado para ${func.nome_completo}`);
  }
}

// ── FATURAÇÃO AUTOMAÇÕES ────────────────────────────────────────────────────────

/**
 * Lembretes de vencimento de faturas
 * Corre: diariamente às 9h
 */
async function lembretesVencimento() {
  const diasAlerta = [15, 7, 3, 0]; // dias antes do vencimento

  for (const dias of diasAlerta) {
    const r = await query(`
      SELECT f.*, c.nome as cliente_nome, c.email as cliente_email,
             e.nome as empresa_nome, e.email as empresa_email
      FROM fatura f
      JOIN cliente c ON c.id = f.cliente_id
      JOIN empresa e ON e.id = f.empresa_id
      WHERE f.estado = 'emitida'
        AND f.data_vencimento::date = CURRENT_DATE + INTERVAL '${dias} days'
        AND f.lembrete_${dias}d_enviado IS NULL
      LIMIT 100
    `).catch(() => ({ rows: [] }));

    for (const fat of r.rows) {
      // Marcar lembrete enviado
      const col = dias === 0 ? 'vencida' : `lembrete_${dias}d_enviado`;
      await query(`UPDATE fatura SET ${col} = NOW() WHERE id = $1`, [fat.id]).catch(() => {});

      if (fat.cliente_email) {
        const urgencia = dias === 0 ? '🚨 VENCIDA HOJE' : dias <= 3 ? '⚠️ Vence em breve' : '📋 Lembrete';
        await enviarEmail({
          to: fat.cliente_email,
          subject: `${urgencia} — Fatura ${fat.numero} — ${fat.empresa_nome}`,
          html: `
            <div style="font-family:Inter,sans-serif;max-width:600px">
              <div style="background:${dias===0?'#ef4444':dias<=3?'#f97316':'#4f46e5'};color:white;padding:16px 24px;border-radius:8px 8px 0 0">
                <h2 style="margin:0">${urgencia}</h2>
              </div>
              <div style="background:#fff;border:1px solid #e5e7eb;padding:24px;border-radius:0 0 8px 8px">
                <p>Exmo(a) ${fat.cliente_nome},</p>
                <p>A fatura <strong>${fat.numero}</strong> ${dias === 0 ? 'vence hoje' : `vence em ${dias} dias`}.</p>
                <table style="width:100%;border-collapse:collapse;margin:16px 0">
                  <tr><td style="padding:8px;color:#6b7280">Fatura</td><td style="padding:8px;font-weight:600">${fat.numero}</td></tr>
                  <tr style="background:#f9fafb"><td style="padding:8px;color:#6b7280">Valor</td><td style="padding:8px;font-weight:600;color:#4f46e5">${parseFloat(fat.total||0).toFixed(2)} €</td></tr>
                  <tr><td style="padding:8px;color:#6b7280">Vencimento</td><td style="padding:8px${dias<=3?';color:#ef4444;font-weight:600':''}">${new Date(fat.data_vencimento).toLocaleDateString('pt-PT')}</td></tr>
                </table>
                <p style="color:#6b7280;font-size:13px">Para efectuar o pagamento ou esclarecimentos, contacte ${fat.empresa_email}.</p>
              </div>
            </div>
          `
        }).catch(() => {});
      }
    }

    if (r.rows.length > 0) {
      console.log(`[Automação] ${r.rows.length} lembretes de vencimento (${dias} dias) enviados`);
    }
  }
}

// ── FINANCEIRO AUTOMAÇÕES ───────────────────────────────────────────────────────

/**
 * Alerta de tesouraria: saldo baixo
 * Corre: diariamente às 8h
 */
async function alertaTesouraria() {
  // Verificar saldo estimado (baseado em facturas pagas - despesas)
  const r = await query(`
    SELECT e.id as empresa_id, e.nome,
      COALESCE((SELECT SUM(total) FROM fatura WHERE empresa_id=e.id AND estado='paga' AND data_emissao > NOW()-INTERVAL '30 days'),0) as receita_30d,
      COALESCE((SELECT SUM(valor_total) FROM despesa WHERE empresa_id=e.id AND estado='aprovada' AND data_despesa > NOW()-INTERVAL '30 days'),0) as despesas_30d,
      e.alerta_tesouraria_valor
    FROM empresa e
    WHERE e.alerta_tesouraria_valor IS NOT NULL AND e.alerta_tesouraria_valor > 0
  `).catch(() => ({ rows: [] }));

  for (const emp of r.rows) {
    const saldoEstimado = parseFloat(emp.receita_30d) - parseFloat(emp.despesas_30d);
    if (saldoEstimado < parseFloat(emp.alerta_tesouraria_valor)) {
      await query(`
        INSERT INTO notificacao (utilizador_id, titulo, mensagem, tipo, url_accao)
        SELECT id, $1, $2, 'warning', '/contabilidade'
        FROM utilizador WHERE empresa_id = $3 AND perfil IN ('admin_empresa', 'financeiro')
      `, [
        '💰 Alerta de Tesouraria',
        `Saldo estimado (${saldoEstimado.toFixed(2)}€) abaixo do limite configurado (${parseFloat(emp.alerta_tesouraria_valor).toFixed(2)}€)`,
        emp.empresa_id
      ]).catch(() => {});
    }
  }
}

// ── EXPORTAR ────────────────────────────────────────────────────────────────────

module.exports = {
  // ITSM
  escalarTicketsSLA,
  notificarResolucao,
  lembreteTicketsPendentes,
  // RH
  onboardingAutomatico,
  alertaFimExperimental,
  offboardingAutomatico,
  // Faturação
  lembretesVencimento,
  // Financeiro
  alertaTesouraria,

  // Correr todas as automações (chamado pelo cron)
  async correrTodas() {
    console.log('[Automações] A iniciar ciclo completo...');
    const inicio = Date.now();
    await Promise.allSettled([
      escalarTicketsSLA(),
      notificarResolucao(),
    ]);
    console.log(`[Automações] Ciclo de 15min concluído em ${Date.now()-inicio}ms`);
  },

  async correrHorarias() {
    console.log('[Automações] A iniciar ciclo horário...');
    await Promise.allSettled([
      lembreteTicketsPendentes(),
    ]);
  },

  async correrDiarias() {
    console.log('[Automações] A iniciar ciclo diário...');
    await Promise.allSettled([
      onboardingAutomatico(),
      alertaFimExperimental(),
      offboardingAutomatico(),
      lembretesVencimento(),
      alertaTesouraria(),
    ]);
  },
};
