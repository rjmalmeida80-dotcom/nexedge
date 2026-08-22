'use strict';
const cron = require('node-cron');
const automacoes = require('./automacoes');

function iniciar() {
  console.log('✅ Cron jobs a iniciar...');

  // ── A CADA 15 MINUTOS ──────────────────────────────────────────────────────
  // ITSM: escalamento SLA breach + notificações resolução
  cron.schedule('*/15 * * * *', async () => {
    await automacoes.correrTodas().catch(e => console.error('[Cron] Erro automações 15min:', e.message));
  });

  // ── A CADA HORA ────────────────────────────────────────────────────────────
  // Lembretes tickets pendentes
  cron.schedule('0 * * * *', async () => {
    await automacoes.correrHorarias().catch(e => console.error('[Cron] Erro automações horárias:', e.message));
  });

  // ── DIARIAMENTE ────────────────────────────────────────────────────────────
  // 8h: onboarding, offboarding, fim experimental, tesouraria
  cron.schedule('0 8 * * *', async () => {
    await automacoes.correrDiarias().catch(e => console.error('[Cron] Erro automações diárias:', e.message));
  }, { timezone: 'Europe/Lisbon' });

  // 9h: lembretes vencimento faturas (cron separado para garantir)
  cron.schedule('0 9 * * *', async () => {
    await automacoes.lembretesVencimento().catch(e => console.error('[Cron] Erro lembretes vencimento:', e.message));
  }, { timezone: 'Europe/Lisbon' });

  // ── EXISTENTES (manter) ────────────────────────────────────────────────────
  // Alertas legais (já existia)
  try {
    const { verificarAlertasLegais } = require('./alertasLegaisService');
    cron.schedule('0 7 * * 1', async () => {
      await verificarAlertasLegais().catch(e => console.error('[Cron] Alertas legais:', e.message));
    }, { timezone: 'Europe/Lisbon' });
  } catch(e) {}

  // Backup automático (já existia)
  try {
    const backupService = require('./backupService');
    cron.schedule('0 3 * * *', async () => {
      await backupService.fazerBackup().catch(e => console.error('[Cron] Backup:', e.message));
    }, { timezone: 'Europe/Lisbon' });
  } catch(e) {}

  // Limpeza de sessões expiradas (já existia)
  cron.schedule('0 */1 * * *', async () => {
    const { query } = require('../config/database');
    await query(`DELETE FROM portal_sessao WHERE expira_em < NOW()`).catch(() => {});
    await query(`DELETE FROM itsm_portal_sessao WHERE expira_em < NOW()`).catch(() => {});
  });

  console.log('✅ Cron jobs configurados:');
  console.log('   • A cada 15min: ITSM escalamento SLA + notificações resolução');
  console.log('   • A cada hora: lembretes tickets pendentes');
  console.log('   • 8h diário: onboarding/offboarding/experimental/tesouraria');
  console.log('   • 9h diário: lembretes vencimento faturas');
  console.log('   • 3h diário: backup automático');
  console.log('   • 7h segundas: alertas legais');
}

module.exports = { iniciar };
