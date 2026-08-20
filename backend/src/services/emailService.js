'use strict';
const nodemailer = require('nodemailer');

// ── Configuração do transportador ─────────────────────────────────────────────
function criarTransporte() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: {
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
    },
  });
}

// ── Template base HTML ────────────────────────────────────────────────────────
function templateBase(conteudo, rodape = '') {
  return `
<!DOCTYPE html>
<html lang="pt">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { margin: 0; padding: 0; background: #F3F4F6; font-family: Arial, sans-serif; }
    .container { max-width: 600px; margin: 32px auto; background: #fff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.08); }
    .header { background: linear-gradient(135deg, #4F46E5, #8B5CF6); padding: 32px 40px; text-align: center; }
    .header h1 { color: #fff; margin: 0; font-size: 28px; font-weight: 900; letter-spacing: -0.5px; }
    .header p { color: rgba(255,255,255,0.7); margin: 6px 0 0; font-size: 14px; }
    .body { padding: 40px; }
    .body h2 { color: #1E1B4B; font-size: 20px; margin: 0 0 16px; }
    .body p { color: #4B5563; font-size: 15px; line-height: 1.6; margin: 0 0 16px; }
    .card { background: #F9FAFB; border: 1px solid #E5E7EB; border-radius: 12px; padding: 20px 24px; margin: 20px 0; }
    .card-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #E5E7EB; font-size: 14px; }
    .card-row:last-child { border-bottom: none; }
    .card-row .label { color: #6B7280; }
    .card-row .value { color: #111827; font-weight: 600; }
    .btn { display: inline-block; background: linear-gradient(135deg, #4F46E5, #7C3AED); color: #fff !important; text-decoration: none; padding: 14px 32px; border-radius: 10px; font-weight: 700; font-size: 15px; margin: 20px 0; }
    .highlight { color: #4F46E5; font-weight: 700; }
    .success { color: #059669; font-weight: 700; }
    .warning { color: #D97706; font-weight: 700; }
    .danger { color: #DC2626; font-weight: 700; }
    .footer { background: #F9FAFB; padding: 24px 40px; text-align: center; border-top: 1px solid #E5E7EB; }
    .footer p { color: #9CA3AF; font-size: 12px; margin: 4px 0; }
    .footer a { color: #6366F1; text-decoration: none; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>⚡ nexedge</h1>
      <p>Gestão Empresarial Portuguesa</p>
    </div>
    <div class="body">
      ${conteudo}
    </div>
    <div class="footer">
      ${rodape || '<p>© 2026 NexEdge · <a href="https://nexedge.pt">nexedge.pt</a></p><p>Recebeu este email porque é utilizador da plataforma NexEdge.</p>'}
    </div>
  </div>
</body>
</html>`;
}

// ── Função de envio base ──────────────────────────────────────────────────────
// Mapeamento de remetentes por tipo de email
const REMETENTES = {
  suporte:        '"NexEdge Suporte" <suporte@nexedge.pt>',
  pagamentos:     '"NexEdge Pagamentos" <pagamentos@nexedge.pt>',
  contabilidade:  '"NexEdge Contabilidade" <contabilidade@nexedge.pt>',
  info:           '"NexEdge" <info@nexedge.pt>',
  rgpd:           '"NexEdge RGPD" <rgpd@nexedge.pt>',
};

async function enviar({ para, assunto, html, texto, remetente = 'suporte' }) {
  const from = REMETENTES[remetente] || REMETENTES.suporte;

  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
    console.log(`📧 [EMAIL SIMULADO] De: ${from} | Para: ${para} | Assunto: ${assunto}`);
    return { simulado: true };
  }

  // Criar transporte específico para o remetente
  const transporte = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: {
      user: process.env[`SMTP_USER_${remetente.toUpperCase()}`] || process.env.SMTP_USER,
      pass: process.env[`SMTP_PASS_${remetente.toUpperCase()}`] || process.env.SMTP_PASS,
    },
  });

  return transporte.sendMail({
    from,
    to: para,
    subject: assunto,
    html,
    text: texto || assunto,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEMPLATES DE EMAIL
// ═══════════════════════════════════════════════════════════════════════════════

// ── 1. Recibo de salário ──────────────────────────────────────────────────────
async function enviarReciboSalario({ email, nome, empresa, mes, ano, salarioBase, liquido, irs, segSocial, totalAbonos, totalDescontos }) {
  const meses = ['','Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  const fmt = v => parseFloat(v||0).toLocaleString('pt-PT',{minimumFractionDigits:2}) + '€';

  const html = templateBase(`
    <h2>O seu recibo de ${meses[mes]} ${ano} está disponível</h2>
    <p>Olá <strong>${nome}</strong>,</p>
    <p>O seu recibo de vencimento referente a <strong>${meses[mes]} ${ano}</strong> foi processado pela <strong>${empresa}</strong>.</p>

    <div class="card">
      <div class="card-row"><span class="label">Salário Base</span><span class="value">${fmt(salarioBase)}</span></div>
      <div class="card-row"><span class="label">Total Abonos</span><span class="value">${fmt(totalAbonos)}</span></div>
      <div class="card-row"><span class="label">IRS Retido</span><span class="value" style="color:#DC2626">-${fmt(irs)}</span></div>
      <div class="card-row"><span class="label">Seg. Social (11%)</span><span class="value" style="color:#DC2626">-${fmt(segSocial)}</span></div>
      <div class="card-row"><span class="label">Total Descontos</span><span class="value" style="color:#DC2626">-${fmt(totalDescontos)}</span></div>
      <div class="card-row" style="margin-top:8px;padding-top:12px;border-top:2px solid #E5E7EB">
        <span class="label" style="font-size:16px;font-weight:700;color:#111827">LÍQUIDO A RECEBER</span>
        <span class="value" style="font-size:20px;color:#059669">${fmt(liquido)}</span>
      </div>
    </div>

    <p>Pode consultar o recibo completo na plataforma NexEdge:</p>
    <a href="https://app.nexedge.pt/salarios" class="btn">Ver Recibo Completo</a>

    <p style="font-size:13px;color:#9CA3AF">Este email foi enviado automaticamente. O valor líquido será creditado na sua conta bancária conforme acordado.</p>
  `);

  return enviar({
    remetente: 'suporte',
    para: email,
    assunto: `📄 Recibo de Vencimento — ${meses[mes]} ${ano} | ${empresa}`,
    html,
  });
}

// ── 2. Fatura enviada ao cliente ──────────────────────────────────────────────
async function enviarFatura({ email, nomeCliente, empresa, numeroFatura, dataEmissao, dataVencimento, total, iban, referenciaMB }) {
  const html = templateBase(`
    <h2>Nova fatura de ${empresa}</h2>
    <p>Olá <strong>${nomeCliente}</strong>,</p>
    <p>Segue em anexo a fatura <strong>${numeroFatura}</strong> emitida por <strong>${empresa}</strong>.</p>

    <div class="card">
      <div class="card-row"><span class="label">Número de Fatura</span><span class="value highlight">${numeroFatura}</span></div>
      <div class="card-row"><span class="label">Data de Emissão</span><span class="value">${dataEmissao}</span></div>
      <div class="card-row"><span class="label">Data de Vencimento</span><span class="value warning">${dataVencimento}</span></div>
      <div class="card-row" style="padding-top:12px;border-top:2px solid #E5E7EB">
        <span class="label" style="font-size:16px;font-weight:700;color:#111827">TOTAL A PAGAR</span>
        <span class="value" style="font-size:20px;color:#4F46E5">${total}</span>
      </div>
    </div>

    ${iban ? `
    <div class="card" style="background:#EEF2FF;border-color:#C7D2FE">
      <p style="margin:0 0 8px;font-weight:700;color:#4F46E5">💳 Dados para Transferência Bancária</p>
      <div class="card-row"><span class="label">IBAN</span><span class="value" style="font-family:monospace">${iban}</span></div>
      <div class="card-row"><span class="label">Referência</span><span class="value">${numeroFatura}</span></div>
      <div class="card-row"><span class="label">Valor</span><span class="value">${total}</span></div>
    </div>` : ''}

    ${referenciaMB ? `
    <div class="card" style="background:#F0FDF4;border-color:#BBF7D0">
      <p style="margin:0 0 8px;font-weight:700;color:#059669">🏧 Pagamento por Referência Multibanco</p>
      <div class="card-row"><span class="label">Entidade</span><span class="value" style="font-family:monospace">${referenciaMB.entidade}</span></div>
      <div class="card-row"><span class="label">Referência</span><span class="value" style="font-family:monospace">${referenciaMB.referencia}</span></div>
      <div class="card-row"><span class="label">Valor</span><span class="value">${total}</span></div>
    </div>` : ''}

    <p style="font-size:13px;color:#9CA3AF">Em caso de dúvida, contacte ${empresa} directamente.</p>
  `);

  return enviar({
    remetente: 'contabilidade',
    para: email,
    assunto: `🧾 Fatura ${numeroFatura} — ${total} | ${empresa}`,
    html,
  });
}

// ── 3. Alerta de contrato a expirar ──────────────────────────────────────────
async function enviarAlertaContrato({ email, nomeGestor, nomeColaborador, tipoContrato, dataFim, diasRestantes }) {
  const urgente = diasRestantes <= 7;
  const html = templateBase(`
    <h2>${urgente ? '🚨 Urgente: ' : '⚠️ '}Contrato a expirar em ${diasRestantes} dias</h2>
    <p>Olá <strong>${nomeGestor}</strong>,</p>
    <p>O contrato do colaborador <strong>${nomeColaborador}</strong> está prestes a expirar.</p>

    <div class="card" style="${urgente ? 'background:#FEF2F2;border-color:#FECACA' : 'background:#FFFBEB;border-color:#FDE68A'}">
      <div class="card-row"><span class="label">Colaborador</span><span class="value">${nomeColaborador}</span></div>
      <div class="card-row"><span class="label">Tipo de Contrato</span><span class="value">${tipoContrato}</span></div>
      <div class="card-row"><span class="label">Data de Fim</span><span class="value ${urgente ? 'danger' : 'warning'}">${dataFim}</span></div>
      <div class="card-row"><span class="label">Dias Restantes</span><span class="value ${urgente ? 'danger' : 'warning'}">${diasRestantes} dias</span></div>
    </div>

    <p>Aceda à plataforma para renovar ou terminar o contrato:</p>
    <a href="https://app.nexedge.pt/contratos" class="btn">Gerir Contrato</a>
  `);

  return enviar({
    remetente: 'suporte',
    para: email,
    assunto: `${urgente ? '🚨 URGENTE' : '⚠️ Aviso'}: Contrato de ${nomeColaborador} expira em ${diasRestantes} dias`,
    html,
  });
}

// ── 4. Férias aprovadas/rejeitadas ────────────────────────────────────────────
async function enviarRespostaFerias({ email, nome, estado, dataInicio, dataFim, tipo, motivo }) {
  const aprovado = estado === 'aprovado';
  const html = templateBase(`
    <h2>${aprovado ? '✅ Férias aprovadas' : '❌ Férias rejeitadas'}</h2>
    <p>Olá <strong>${nome}</strong>,</p>
    <p>O seu pedido de ${tipo} foi <strong class="${aprovado ? 'success' : 'danger'}">${aprovado ? 'aprovado' : 'rejeitado'}</strong>.</p>

    <div class="card" style="${aprovado ? 'background:#F0FDF4;border-color:#BBF7D0' : 'background:#FEF2F2;border-color:#FECACA'}">
      <div class="card-row"><span class="label">Tipo</span><span class="value">${tipo}</span></div>
      <div class="card-row"><span class="label">Data Início</span><span class="value">${dataInicio}</span></div>
      <div class="card-row"><span class="label">Data Fim</span><span class="value">${dataFim}</span></div>
      <div class="card-row"><span class="label">Estado</span><span class="value ${aprovado ? 'success' : 'danger'}">${aprovado ? '✅ Aprovado' : '❌ Rejeitado'}</span></div>
      ${motivo ? `<div class="card-row"><span class="label">Motivo</span><span class="value">${motivo}</span></div>` : ''}
    </div>

    <a href="https://app.nexedge.pt/ferias" class="btn">Ver Detalhes</a>
  `);

  return enviar({
    remetente: 'suporte',
    para: email,
    assunto: `${aprovado ? '✅ Férias aprovadas' : '❌ Férias rejeitadas'} — ${dataInicio} a ${dataFim}`,
    html,
  });
}

// ── 5. Lembrete de pagamento em atraso ────────────────────────────────────────
async function enviarLembreteAtraso({ email, nomeCliente, empresa, numeroFatura, dataVencimento, diasAtraso, valorEmDivida }) {
  const urgente = diasAtraso > 15;
  const html = templateBase(`
    <h2>${urgente ? '🚨 Pagamento em atraso' : '⏰ Lembrete de pagamento'}</h2>
    <p>Olá <strong>${nomeCliente}</strong>,</p>
    <p>Verificamos que a fatura <strong>${numeroFatura}</strong> de <strong>${empresa}</strong> ainda não foi paga.</p>

    <div class="card" style="background:#FEF2F2;border-color:#FECACA">
      <div class="card-row"><span class="label">Fatura</span><span class="value highlight">${numeroFatura}</span></div>
      <div class="card-row"><span class="label">Data de Vencimento</span><span class="value">${dataVencimento}</span></div>
      <div class="card-row"><span class="label">Dias em Atraso</span><span class="value danger">${diasAtraso} dias</span></div>
      <div class="card-row" style="padding-top:12px;border-top:2px solid #E5E7EB">
        <span class="label" style="font-size:16px;font-weight:700">VALOR EM DÍVIDA</span>
        <span class="value danger" style="font-size:20px">${valorEmDivida}</span>
      </div>
    </div>

    <p>Por favor regularize a situação o mais brevemente possível para evitar a suspensão do serviço.</p>
    <a href="https://app.nexedge.pt/portal-cliente" class="btn">Pagar Agora</a>

    <p style="font-size:13px;color:#9CA3AF">Se já efectuou o pagamento, por favor ignore este email ou contacte-nos.</p>
  `);

  return enviar({
    remetente: 'pagamentos',
    para: email,
    assunto: `${urgente ? '🚨 URGENTE' : '⏰ Lembrete'}: Fatura ${numeroFatura} em atraso — ${diasAtraso} dias | ${empresa}`,
    html,
  });
}

// ── 6. Boas-vindas novo cliente ───────────────────────────────────────────────
async function enviarBoasVindas({ email, nome, empresa, password, trialFim }) {
  const html = templateBase(`
    <h2>Bem-vindo ao NexEdge, ${nome}! 🎉</h2>
    <p>A sua conta foi criada com sucesso. Tem <strong>14 dias de trial gratuito</strong> para explorar todas as funcionalidades.</p>

    <div class="card" style="background:#EEF2FF;border-color:#C7D2FE">
      <p style="margin:0 0 12px;font-weight:700;color:#4F46E5">🔑 As suas credenciais de acesso</p>
      <div class="card-row"><span class="label">Email</span><span class="value" style="font-family:monospace">${email}</span></div>
      <div class="card-row"><span class="label">Password</span><span class="value" style="font-family:monospace">${password}</span></div>
      <div class="card-row"><span class="label">Empresa</span><span class="value">${empresa}</span></div>
      <div class="card-row"><span class="label">Trial até</span><span class="value warning">${trialFim}</span></div>
    </div>

    <p><strong>Importante:</strong> altere a sua password no primeiro login.</p>
    <a href="https://app.nexedge.pt" class="btn">Aceder ao NexEdge</a>

    <p>Se tiver dúvidas, estamos disponíveis em <a href="mailto:suporte@nexedge.pt">suporte@nexedge.pt</a>.</p>
  `);

  return enviar({
    remetente: 'suporte',
    para: email,
    assunto: `🎉 Bem-vindo ao NexEdge — As suas credenciais de acesso`,
    html,
  });
}

// ── 7. Trial a expirar ────────────────────────────────────────────────────────
async function enviarAlertaTrial({ email, nome, empresa, diasRestantes, planoActual }) {
  const urgente = diasRestantes <= 2;
  const html = templateBase(`
    <h2>${urgente ? '🚨 O seu trial expira amanhã!' : `⏰ O seu trial expira em ${diasRestantes} dias`}</h2>
    <p>Olá <strong>${nome}</strong>,</p>
    <p>O trial gratuito da <strong>${empresa}</strong> no NexEdge ${urgente ? 'expira amanhã' : `expira em ${diasRestantes} dias`}.</p>

    <div class="card" style="${urgente ? 'background:#FEF2F2;border-color:#FECACA' : 'background:#FFFBEB;border-color:#FDE68A'}">
      <div class="card-row"><span class="label">Empresa</span><span class="value">${empresa}</span></div>
      <div class="card-row"><span class="label">Plano actual</span><span class="value">${planoActual}</span></div>
      <div class="card-row"><span class="label">Dias restantes</span><span class="value ${urgente ? 'danger' : 'warning'}">${diasRestantes} dias</span></div>
    </div>

    <p>Para continuar a utilizar o NexEdge sem interrupção, subscreva agora:</p>
    <a href="https://app.nexedge.pt/portal-cliente" class="btn">Activar Subscrição</a>

    <p style="font-size:13px;color:#9CA3AF">Após o fim do trial, os seus dados são mantidos durante 30 dias enquanto decide.</p>
  `);

  return enviar({
    remetente: 'suporte',
    para: email,
    assunto: `${urgente ? '🚨 URGENTE: Trial expira amanhã!' : `⏰ Trial expira em ${diasRestantes} dias`} | NexEdge`,
    html,
  });
}

// ── 8. Novo pedido de férias (notificação ao gestor) ─────────────────────────
async function enviarNovoPedidoFerias({ email, nomeGestor, nomeColaborador, dataInicio, dataFim, tipo }) {
  const html = templateBase(`
    <h2>📅 Novo pedido de férias para aprovar</h2>
    <p>Olá <strong>${nomeGestor}</strong>,</p>
    <p><strong>${nomeColaborador}</strong> submeteu um pedido de ${tipo} que necessita da sua aprovação.</p>

    <div class="card">
      <div class="card-row"><span class="label">Colaborador</span><span class="value">${nomeColaborador}</span></div>
      <div class="card-row"><span class="label">Tipo</span><span class="value">${tipo}</span></div>
      <div class="card-row"><span class="label">Data Início</span><span class="value">${dataInicio}</span></div>
      <div class="card-row"><span class="label">Data Fim</span><span class="value">${dataFim}</span></div>
    </div>

    <a href="https://app.nexedge.pt/ferias" class="btn">Aprovar ou Rejeitar</a>
  `);

  return enviar({
    remetente: 'suporte',
    para: email,
    assunto: `📅 Pedido de férias de ${nomeColaborador} — aguarda aprovação`,
    html,
  });
}

module.exports = {
  enviar,
  enviarReciboSalario,
  enviarFatura,
  enviarAlertaContrato,
  enviarRespostaFerias,
  enviarLembreteAtraso,
  enviarBoasVindas,
  enviarAlertaTrial,
  enviarNovoPedidoFerias,
};
