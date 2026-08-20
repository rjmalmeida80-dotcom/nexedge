'use strict';
const { query } = require('../config/database');

// ── Criar notificação interna ─────────────────────────────────────────────────
async function criarNotificacao({ empresaId, utilizadorId, titulo, mensagem, tipo, urlAccao }) {
  try {
    await query(`
      INSERT INTO notificacao (empresa_id, utilizador_id, titulo, mensagem, tipo, url_accao, lida)
      VALUES ($1,$2,$3,$4,$5,$6,false)
    `, [empresaId||null, utilizadorId||null, titulo, mensagem||null, tipo||'info', urlAccao||null]);
  } catch(e) {
    console.error('criarNotificacao erro:', e.message);
  }
}

// ── Enviar push notification via Web Push API ─────────────────────────────────
async function enviarPush({ utilizadorId, empresaId, titulo, mensagem, urlAccao, tipo }) {
  try {
    // Criar notificação interna sempre
    await criarNotificacao({ empresaId, utilizadorId, titulo, mensagem, tipo, urlAccao });

    // Buscar subscriptions de push
    let where = '';
    const params = [];
    if (utilizadorId) { params.push(utilizadorId); where = `utilizador_id=$${params.length}`; }
    else if (empresaId) { params.push(empresaId); where = `empresa_id=$${params.length}`; }
    else return;

    const { rows: subs } = await query(
      `SELECT * FROM push_subscription WHERE ${where}`, params
    ).catch(() => ({ rows: [] }));

    if (!subs.length) return; // Sem subscriptions — só notificação interna

    // Payload do push
    const payload = JSON.stringify({
      title: titulo,
      body: mensagem || '',
      icon: '/nexhr-icon.png',
      badge: '/nexhr-icon.png',
      url: urlAccao || '/',
      tag: tipo || 'nexedge',
    });

    // Enviar para cada subscription (sem web-push library por ora — apenas log)
    for (const sub of subs) {
      console.log(`📱 [PUSH] Para: ${sub.utilizador_id} | ${titulo}`);
      // Em produção: usar web-push library com VAPID keys
      // webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth }}, payload)
    }
  } catch(e) {
    console.error('enviarPush erro:', e.message);
  }
}

// ── Notificações específicas ──────────────────────────────────────────────────
const notificacoes = {
  feriasAprovadas: ({ utilizadorId, empresaId, nome }) =>
    enviarPush({ utilizadorId, empresaId, titulo: '✅ Férias aprovadas', mensagem: `As tuas férias foram aprovadas`, urlAccao: '/ferias', tipo: 'ferias' }),

  feriaRejeitadas: ({ utilizadorId, empresaId }) =>
    enviarPush({ utilizadorId, empresaId, titulo: '❌ Férias rejeitadas', mensagem: 'O teu pedido de férias foi rejeitado', urlAccao: '/ferias', tipo: 'ferias' }),

  novoTicketResposta: ({ utilizadorId, empresaId, numero }) =>
    enviarPush({ utilizadorId, empresaId, titulo: '💬 Nova resposta no ticket', mensagem: `Ticket ${numero} tem uma nova resposta`, urlAccao: '/my-nexedge', tipo: 'ticket' }),

  salarioProcessado: ({ utilizadorId, empresaId, mes, ano }) =>
    enviarPush({ utilizadorId, empresaId, titulo: '💰 Recibo disponível', mensagem: `O teu recibo de ${mes}/${ano} está disponível`, urlAccao: '/salarios', tipo: 'salario' }),

  contratoExpirar: ({ empresaId, nome, dias }) =>
    enviarPush({ empresaId, titulo: '⚠️ Contrato a expirar', mensagem: `Contrato de ${nome} expira em ${dias} dias`, urlAccao: '/contratos', tipo: 'alerta' }),

  novaFaturaFornecedor: ({ empresaId, fornecedor, valor }) =>
    enviarPush({ empresaId, titulo: '📄 Nova fatura de fornecedor', mensagem: `${fornecedor} submeteu fatura de ${valor}`, urlAccao: '/portal-fornecedor', tipo: 'fatura' }),

  pagamentoRecebido: ({ empresaId, numero, valor }) =>
    enviarPush({ empresaId, titulo: '✅ Pagamento recebido', mensagem: `Fatura ${numero} marcada como paga — ${valor}`, urlAccao: '/faturacao', tipo: 'pagamento' }),
};

module.exports = { enviarPush, criarNotificacao, notificacoes };
