'use strict';
const nodemailer = require('nodemailer');

// Configuração do transportador de email
// Em produção: usar SMTP real (Gmail, SendGrid, Mailgun, etc.)
// Em desenvolvimento: usar Ethereal (email de teste)
async function criarTransportador() {
  if (process.env.SMTP_HOST) {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }

  // Desenvolvimento: Ethereal (captura emails sem enviar)
  const conta = await nodemailer.createTestAccount();
  const trans = nodemailer.createTransport({
    host: 'smtp.ethereal.email',
    port: 587,
    secure: false,
    auth: { user: conta.user, pass: conta.pass },
  });
  return { trans, previewUrl: true };
}

async function enviarEmailFatura({ para, assunto, html, pdfBuffer, nomePDF, remetente }) {
  try {
    const resultado = await criarTransportador();
    const trans = resultado.trans || resultado;

    const info = await trans.sendMail({
      from: remetente || process.env.EMAIL_FROM || '"NexEdge Faturação" <noreply@nexedge.pt>',
      to: para,
      subject: assunto,
      html,
      attachments: pdfBuffer ? [{
        filename: nomePDF || 'fatura.pdf',
        content: pdfBuffer,
        contentType: 'application/pdf',
      }] : [],
    });

    // Em desenvolvimento, mostrar URL de preview
    if (resultado.previewUrl) {
      const previewUrl = nodemailer.getTestMessageUrl(info);
      console.log('📧 Email de teste enviado:', previewUrl);
      return { ok: true, preview: previewUrl, messageId: info.messageId };
    }

    return { ok: true, messageId: info.messageId };
  } catch(e) {
    console.error('❌ Erro ao enviar email:', e.message);
    return { ok: false, error: e.message };
  }
}

function htmlFatura(fatura, empresa) {
  const total = parseFloat(fatura.total||0).toFixed(2);
  const vencimento = fatura.data_vencimento ? new Date(fatura.data_vencimento).toLocaleDateString('pt-PT') : '-';

  return `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif">
  <div style="max-width:600px;margin:30px auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,0.1)">

    <!-- Cabeçalho -->
    <div style="background:#1D4ED8;padding:30px;text-align:center">
      <h1 style="color:white;margin:0;font-size:24px">${empresa.nome || 'NexEdge'}</h1>
      <p style="color:rgba(255,255,255,0.8);margin:5px 0 0;font-size:14px">NIF: ${empresa.nif || ''}</p>
    </div>

    <!-- Corpo -->
    <div style="padding:30px">
      <h2 style="color:#1D4ED8;margin:0 0 5px">${fatura.numero_completo}</h2>
      <p style="color:#6B7280;margin:0 0 20px;font-size:13px">ATCUD: ${fatura.atcud || '0'}</p>

      <p style="color:#374151;font-size:15px">
        Exmo(a) Sr(a),<br><br>
        Enviamos em anexo o documento <strong>${fatura.numero_completo}</strong>
        no valor de <strong>${total} EUR</strong>.
        ${fatura.data_vencimento ? `O prazo de pagamento é até <strong>${vencimento}</strong>.` : ''}
      </p>

      <!-- Resumo -->
      <div style="background:#F9FAFB;border-radius:8px;padding:20px;margin:20px 0">
        <table style="width:100%;border-collapse:collapse">
          <tr>
            <td style="padding:6px 0;color:#6B7280;font-size:13px">Subtotal</td>
            <td style="padding:6px 0;text-align:right;font-size:13px">${parseFloat(fatura.subtotal||0).toFixed(2)} EUR</td>
          </tr>
          <tr>
            <td style="padding:6px 0;color:#6B7280;font-size:13px">IVA</td>
            <td style="padding:6px 0;text-align:right;font-size:13px">${parseFloat(fatura.iva_total||0).toFixed(2)} EUR</td>
          </tr>
          <tr style="border-top:2px solid #E5E7EB">
            <td style="padding:10px 0;font-weight:bold;font-size:16px;color:#1D4ED8">TOTAL</td>
            <td style="padding:10px 0;text-align:right;font-weight:bold;font-size:16px;color:#1D4ED8">${total} EUR</td>
          </tr>
        </table>
      </div>

      ${fatura.notas ? `<p style="color:#6B7280;font-size:13px;font-style:italic">${fatura.notas}</p>` : ''}

      <p style="color:#374151;font-size:14px;margin-top:20px">
        O documento em PDF encontra-se em anexo.<br>
        Para qualquer questão, contacte-nos.
      </p>
    </div>

    <!-- Rodapé -->
    <div style="background:#F9FAFB;padding:20px;text-align:center;border-top:1px solid #E5E7EB">
      <p style="color:#9CA3AF;font-size:11px;margin:0">
        Documento emitido por NexEdge v4.0 — Software de faturação certificado AT<br>
        Hash: ${(fatura.hash||'').substring(0,20)}...
      </p>
    </div>
  </div>
</body>
</html>`;
}

module.exports = { enviarEmailFatura, htmlFatura };
