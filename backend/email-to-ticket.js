'use strict';
/**
 * NexEdge — Email to Ticket
 * Lê emails de uma caixa IMAP e cria tickets ITSM automaticamente
 * Corre como serviço separado via PM2
 * 
 * Config no .env:
 * IMAP_HOST, IMAP_PORT, IMAP_USER, IMAP_PASS, IMAP_TLS=true
 * IMAP_MAILBOX=INBOX (pasta a monitorizar)
 */

require('dotenv').config();
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const { query } = require('./src/config/database');
const { enviarEmail } = require('./src/services/emailService');

const IMAP_CONFIG = {
  host: process.env.IMAP_HOST || 'mail.nexedge.pt',
  port: parseInt(process.env.IMAP_PORT) || 993,
  user: process.env.IMAP_USER || 'suporte@nexedge.pt',
  password: process.env.IMAP_PASS || '',
  tls: process.env.IMAP_TLS !== 'false',
  tlsOptions: { rejectUnauthorized: false },
  authTimeout: 10000,
};

const INTERVALO_MS = 60 * 1000; // verificar a cada 1 minuto

async function criarTicketDeEmail(parsed, empresaId) {
  const de = parsed.from?.value?.[0];
  const email = de?.address || '';
  const nome = de?.name || email.split('@')[0] || 'Cliente';
  const assunto = parsed.subject || 'Sem assunto';
  const corpo = parsed.text || parsed.html?.replace(/<[^>]+>/g,'') || '';

  // Detectar prioridade pelo assunto
  let prioridade = 'media';
  const ass = assunto.toLowerCase();
  if (ass.includes('urgente') || ass.includes('urgente') || ass.includes('crítico') || ass.includes('down') || ass.includes('em baixo')) prioridade = 'critica';
  else if (ass.includes('importante') || ass.includes('prioritário')) prioridade = 'alta';

  // Gerar número
  const ano = new Date().getFullYear();
  const countR = await query(`SELECT COUNT(*) FROM itsm_ticket WHERE empresa_id=$1 AND EXTRACT(YEAR FROM criado_em)=$2`, [empresaId, ano]);
  const seq = (parseInt(countR.rows[0].count) + 1).toString().padStart(5, '0');
  const numero = `TK${ano}-${seq}`;

  // Calcular SLA
  const slaH = { critica:4, alta:8, media:24, baixa:72 };
  const resolucaoH = slaH[prioridade];
  const agora = new Date();
  const limiteResolucao = new Date(agora.getTime() + resolucaoH*3600000);
  const limiteResposta = new Date(agora.getTime() + (resolucaoH/4)*3600000);

  // Criar ticket
  const r = await query(`
    INSERT INTO itsm_ticket (
      empresa_id, numero, tipo, titulo, descricao, prioridade, estado,
      sla_resolucao_h, data_limite_resolucao, data_limite_resposta,
      tags, campos_extra
    ) VALUES ($1,$2,'request',$3,$4,$5,'aberto',$6,$7,$8,$9,$10)
    RETURNING id, numero
  `, [
    empresaId, numero,
    assunto.slice(0, 300),
    corpo.slice(0, 5000),
    prioridade, resolucaoH, limiteResolucao, limiteResposta,
    JSON.stringify(['email', 'portal']),
    JSON.stringify({ via: 'email', email_origem: email, nome_remetente: nome }),
  ]);

  const ticket = r.rows[0];

  // Comentário automático
  await query(`
    INSERT INTO itsm_comentario (ticket_id, tipo, conteudo, "visivelParaCliente")
    VALUES ($1,'sistema',$2,true)
  `, [ticket.id, `Ticket criado automaticamente a partir de email de ${nome} <${email}>`]);

  // Notificar equipa
  await query(`
    INSERT INTO notificacao (utilizador_id, titulo, mensagem, tipo, url_accao)
    SELECT id, $1, $2, 'info', '/itsm' FROM utilizador
    WHERE empresa_id=$3 AND perfil IN ('admin_empresa','rh') LIMIT 5
  `, [`📧 Novo ticket por email: ${numero}`, `De: ${nome} — ${assunto}`, empresaId]).catch(()=>{});

  // Email de confirmação ao remetente
  await enviarEmail({
    to: email,
    subject: `[${numero}] Pedido recebido — ${assunto}`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:600px">
        <div style="background:linear-gradient(135deg,#4f46e5,#7c3aed);color:white;padding:20px 24px;border-radius:8px 8px 0 0">
          <h2 style="margin:0">✅ Pedido recebido com sucesso</h2>
        </div>
        <div style="background:#fff;border:1px solid #e5e7eb;padding:24px;border-radius:0 0 8px 8px">
          <p>Olá ${nome},</p>
          <p>Recebemos o teu pedido e foi criado um ticket de suporte.</p>
          <div style="background:#f3f4f6;border-radius:8px;padding:16px;margin:16px 0;text-align:center">
            <div style="font-size:11px;color:#6b7280;margin-bottom:4px">Número do ticket</div>
            <div style="font-size:22px;font-weight:700;color:#4f46e5;font-family:monospace">${numero}</div>
          </div>
          <table style="width:100%;border-collapse:collapse;margin:16px 0">
            <tr><td style="padding:8px;color:#6b7280">Assunto</td><td style="padding:8px">${assunto}</td></tr>
            <tr style="background:#f9fafb"><td style="padding:8px;color:#6b7280">Prioridade</td><td style="padding:8px">${prioridade}</td></tr>
            <tr><td style="padding:8px;color:#6b7280">Prazo resposta</td><td style="padding:8px">${limiteResposta.toLocaleString('pt-PT')}</td></tr>
          </table>
          <p style="color:#6b7280;font-size:13px">Podes acompanhar o estado em: <a href="https://app.nexedge.pt/portal-suporte">Portal de Suporte</a></p>
          <p style="color:#6b7280;font-size:12px;margin-top:16px">Para adicionar informação, responde a este email com o número ${numero} no assunto.</p>
        </div>
      </div>
    `
  }).catch(() => {});

  console.log(`[Email→Ticket] Criado ${numero} de ${email}: ${assunto}`);
  return ticket;
}

async function verificarRespostas(parsed, empresaId) {
  // Verificar se é resposta a ticket existente (número no assunto)
  const assunto = parsed.subject || '';
  const match = assunto.match(/TK\d{4}-\d{5}/);
  if (!match) return false;

  const numero = match[0];
  const ticket = await query(`SELECT id FROM itsm_ticket WHERE numero=$1 AND empresa_id=$2`, [numero, empresaId]);
  if (!ticket.rows.length) return false;

  const de = parsed.from?.value?.[0];
  const corpo = parsed.text || '';

  // Adicionar como comentário
  await query(`
    INSERT INTO itsm_comentario (ticket_id, tipo, conteudo, "visivelParaCliente")
    VALUES ($1,'comentario',$2,true)
  `, [ticket.rows[0].id, `📧 Resposta por email de ${de?.name||de?.address}:\n\n${corpo.slice(0,3000)}`]);

  console.log(`[Email→Ticket] Resposta adicionada ao ${numero}`);
  return true;
}

async function processarEmail(buffer, empresaId) {
  try {
    const parsed = await simpleParser(buffer);
    
    // Ignorar emails do próprio sistema (evitar loops)
    const de = parsed.from?.value?.[0]?.address || '';
    if (de === IMAP_CONFIG.user) return;
    if (parsed.subject?.startsWith('[TK') && parsed.subject?.includes('] Pedido recebido')) return;

    // Ver se é resposta a ticket existente
    const eResposta = await verificarRespostas(parsed, empresaId);
    if (!eResposta) {
      await criarTicketDeEmail(parsed, empresaId);
    }
  } catch(e) {
    console.error('[Email→Ticket] Erro ao processar email:', e.message);
  }
}

async function getEmpresaId() {
  // Usar empresa configurada no .env ou a primeira ativa
  if (process.env.EMPRESA_ID) return process.env.EMPRESA_ID;
  const r = await query(`SELECT id FROM empresa WHERE ativo=true ORDER BY criado_em LIMIT 1`);
  return r.rows[0]?.id;
}

function verificarEmails() {
  return new Promise(async (resolve) => {
    if (!IMAP_CONFIG.password) {
      console.log('[Email→Ticket] IMAP_PASS não configurado — a saltar');
      return resolve();
    }

    const empresaId = await getEmpresaId().catch(() => null);
    if (!empresaId) { console.log('[Email→Ticket] Empresa não encontrada'); return resolve(); }

    const imap = new Imap(IMAP_CONFIG);

    imap.once('ready', () => {
      imap.openBox('INBOX', false, (err, box) => {
        if (err) { imap.end(); return resolve(); }

        // Procurar emails não lidos
        imap.search(['UNSEEN'], (err, results) => {
          if (err || !results.length) { imap.end(); return resolve(); }

          console.log(`[Email→Ticket] ${results.length} emails não lidos`);
          const fetch = imap.fetch(results, { bodies: '' });
          const promises = [];

          fetch.on('message', (msg) => {
            const buffers = [];
            msg.on('body', stream => {
              stream.on('data', chunk => buffers.push(chunk));
              stream.once('end', () => {
                promises.push(processarEmail(Buffer.concat(buffers), empresaId));
              });
            });
            // Marcar como lido
            msg.once('attributes', attrs => {
              imap.addFlags(attrs.uid, ['\\Seen'], () => {});
            });
          });

          fetch.once('end', async () => {
            await Promise.allSettled(promises);
            imap.end();
            resolve();
          });
        });
      });
    });

    imap.once('error', (err) => {
      console.error('[Email→Ticket] Erro IMAP:', err.message);
      resolve();
    });

    imap.once('end', resolve);
    imap.connect();
  });
}

// ── ARRANQUE ──
async function main() {
  console.log('✅ NexEdge Email→Ticket iniciado');
  console.log(`   IMAP: ${IMAP_CONFIG.user}@${IMAP_CONFIG.host}:${IMAP_CONFIG.port}`);
  console.log(`   Intervalo: ${INTERVALO_MS/1000}s`);

  // Verificar imediatamente e depois a cada intervalo
  await verificarEmails();
  setInterval(verificarEmails, INTERVALO_MS);
}

main().catch(console.error);
