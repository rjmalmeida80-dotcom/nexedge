'use strict';
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const QRCode = require('qrcode');

const AZUL = rgb(0.11, 0.29, 0.67);
const CINZA = rgb(0.45, 0.45, 0.45);
const PRETO = rgb(0, 0, 0);
const BRANCO = rgb(1, 1, 1);
const CINZA_CLARO = rgb(0.96, 0.96, 0.96);
const VERDE = rgb(0.08, 0.63, 0.35);

function fmt(v) {
  return parseFloat(v||0).toFixed(2) + ' EUR';
}
function fmtData(d) {
  if (!d) return '-';
  return new Date(d).toLocaleDateString('pt-PT');
}


// String QR code AT — formato oficial Portugal
// https://info.portaldasfinancas.gov.pt/pt/apoio_contribuinte/Faturacao/Paginas/ATCUD.aspx
function gerarStringQRAT(fatura, empresa) {
  const nif_emit = (empresa.nif || '').replace(/\D/g, '').padStart(9, '0');
  const nif_cli  = (fatura.cliente_nif || '999999990').replace(/\D/g, '').padStart(9, '0');
  const pais_cli = fatura.cliente_pais || 'PT';
  const tipo     = fatura.tipo_doc || 'FT';
  const estado   = 'N'; // N=Normal, A=Anulado
  const dataRaw  = fatura.data_emissao ? fatura.data_emissao.toString().split('T')[0] : '';
  const data     = dataRaw.replace(/-/g, '');
  const atcud    = fatura.atcud || '0';
  const espaco_fiscal = 'PT'; // Portugal Continental
  const base23   = parseFloat(fatura.subtotal || 0).toFixed(2);
  const iva23    = parseFloat(fatura.iva_total || 0).toFixed(2);
  const total    = parseFloat(fatura.total || 0).toFixed(2);
  const hash4    = (fatura.hash || '    ').substring(0, 4);
  const num_cert = '0'; // número certificado AT

  // Formato: A:NIF_emit*B:NIF_cli*C:Pais*D:Tipo*E:Estado*F:Data*G:NumDoc*H:ATCUD*I1:EspacoFiscal*I8:Base*I9:IVA*N:Total*O:Total*P:Hash4*Q:nCert
  return [
    `A:${nif_emit}`,
    `B:${nif_cli}`,
    `C:${pais_cli}`,
    `D:${tipo}`,
    `E:${estado}`,
    `F:${data}`,
    `G:${fatura.numero_completo || ''}`,
    `H:${atcud}`,
    `I1:${espaco_fiscal}`,
    `I8:${base23}`,
    `I9:${iva23}`,
    `N:${iva23}`,
    `O:${total}`,
    `P:${hash4}`,
    `Q:${num_cert}`,
    `R:${num_cert}`,
  ].join('*');
}

async function gerarPDFFatura(fatura, empresa, linhas, pagamentos = []) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const { width, height } = page.getSize();
  const fontR = await doc.embedFont(StandardFonts.Helvetica);
  const fontB = await doc.embedFont(StandardFonts.HelveticaBold);

  let y = height - 40;
  const mL = 45;
  const mR = width - 45;

  // Cabeçalho azul
  page.drawRectangle({ x: 0, y: height - 90, width, height: 90, color: AZUL });
  page.drawText((empresa.nome || 'Empresa').substring(0, 40), { x: mL, y: height - 32, size: 15, font: fontB, color: BRANCO });
  page.drawText('NIF: ' + (empresa.nif || ''), { x: mL, y: height - 48, size: 8, font: fontR, color: rgb(0.8,0.8,1) });
  if (empresa.morada) page.drawText(empresa.morada.substring(0,50), { x: mL, y: height - 62, size: 7.5, font: fontR, color: rgb(0.8,0.8,1) });

  const tipos = { FT:'FATURA', FR:'FATURA-RECIBO', NC:'NOTA DE CREDITO', RC:'RECIBO' };
  page.drawText(tipos[fatura.tipo_doc] || fatura.tipo_doc, { x: 390, y: height - 30, size: 14, font: fontB, color: BRANCO });
  page.drawText(fatura.numero_completo || '', { x: 390, y: height - 48, size: 10, font: fontR, color: rgb(0.8,0.8,1) });
  y = height - 108;

  // ATCUD
  page.drawRectangle({ x: mL, y: y - 16, width: mR - mL, height: 20, color: CINZA_CLARO });
  page.drawText('ATCUD: ' + (fatura.atcud || '0'), { x: mL + 5, y: y - 11, size: 7.5, font: fontR, color: CINZA });
  y -= 32;

  // Emitente / Cliente
  page.drawText('EMITENTE', { x: mL, y, size: 7.5, font: fontB, color: AZUL });
  page.drawText('CLIENTE', { x: 320, y, size: 7.5, font: fontB, color: AZUL });
  y -= 13;

  const emit = [empresa.nome||'', 'NIF: '+(empresa.nif||''), empresa.morada||''].filter(Boolean);
  const cli  = [fatura.cliente_nome||'Consumidor Final', fatura.cliente_nif?'NIF: '+fatura.cliente_nif:'', fatura.cliente_morada||''].filter(Boolean);
  const maxL = Math.max(emit.length, cli.length);
  for (let i = 0; i < maxL; i++) {
    if (emit[i]) page.drawText(emit[i].substring(0,40), { x: mL, y, size: 8, font: i===0?fontB:fontR, color: PRETO });
    if (cli[i])  page.drawText(cli[i].substring(0,40),  { x: 320, y, size: 8, font: i===0?fontB:fontR, color: PRETO });
    y -= 12;
  }
  y -= 14;

  // Datas
  const datas = [['Emissao', fmtData(fatura.data_emissao)], ['Vencimento', fmtData(fatura.data_vencimento)], ['Estado', (fatura.estado||'').toUpperCase()]];
  datas.forEach(([l, v], i) => {
    page.drawText(l + ':', { x: mL + i*160, y, size: 7.5, font: fontB, color: CINZA });
    page.drawText(v, { x: mL + i*160, y: y - 11, size: 8.5, font: fontR, color: PRETO });
  });
  y -= 30;

  page.drawLine({ start:{x:mL,y}, end:{x:mR,y}, thickness:0.5, color:rgb(0.8,0.8,0.8) });
  y -= 14;

  // Cabeçalho tabela
  page.drawRectangle({ x: mL, y: y - 15, width: mR - mL, height: 19, color: AZUL });
  [
    { x: mL+4,    t: 'Descricao' },
    { x: mL+228,  t: 'Qtd' },
    { x: mL+268,  t: 'P.Unit.' },
    { x: mL+326,  t: 'Desc%' },
    { x: mL+368,  t: 'IVA' },
    { x: mL+404,  t: 'Total' },
  ].forEach(c => page.drawText(c.t, { x: c.x, y: y - 11, size: 7.5, font: fontB, color: BRANCO }));
  y -= 20;

  // Linhas
  linhas.forEach((l, i) => {
    page.drawRectangle({ x: mL, y: y - 13, width: mR - mL, height: 17, color: i%2===0?BRANCO:CINZA_CLARO });
    page.drawText((l.descricao||'').substring(0,44), { x: mL+4, y: y-9, size: 7.5, font: fontR, color: PRETO });
    page.drawText(parseFloat(l.quantidade||1).toFixed(2), { x: mL+228, y: y-9, size: 7.5, font: fontR, color: PRETO });
    page.drawText(parseFloat(l.preco_unitario||0).toFixed(2), { x: mL+268, y: y-9, size: 7.5, font: fontR, color: PRETO });
    page.drawText(parseFloat(l.desconto_perc||0).toFixed(0)+'%', { x: mL+326, y: y-9, size: 7.5, font: fontR, color: PRETO });
    page.drawText(parseFloat(l.taxa_iva||23).toFixed(0)+'%', { x: mL+368, y: y-9, size: 7.5, font: fontR, color: PRETO });
    page.drawText(parseFloat(l.total||0).toFixed(2)+' EUR', { x: mL+404, y: y-9, size: 7.5, font: fontB, color: PRETO });
    y -= 17;
  });
  y -= 10;

  // Totais
  const tX = 360;
  const rows = [
    ['Subtotal', fmt(fatura.subtotal), false],
    ['IVA', fmt(fatura.iva_total), false],
    ['TOTAL', fmt(fatura.total), true],
  ];
  if (parseFloat(fatura.retencao||0) > 0) {
    rows.push(['Retencao', '-' + fmt(fatura.retencao), false]);
    rows.push(['TOTAL A PAGAR', fmt(fatura.total_pagar), true]);
  }
  if (parseFloat(fatura.valor_pago||0) > 0) {
    rows.push(['Valor Pago', fmt(fatura.valor_pago), false]);
    const pp = parseFloat(fatura.total_pagar||0) - parseFloat(fatura.valor_pago||0);
    if (pp > 0.01) rows.push(['Por Pagar', fmt(pp), false]);
  }

  rows.forEach(([label, val, bold]) => {
    if (bold) page.drawRectangle({ x: tX - 5, y: y - 13, width: mR - tX + 5, height: 17, color: AZUL });
    page.drawText(label + ':', { x: tX, y: y - 9, size: 8.5, font: fontB, color: bold?BRANCO:CINZA });
    page.drawText(val, { x: mR - fontB.widthOfTextAtSize(val, 9) - 2, y: y - 9, size: 9, font: fontB, color: bold?BRANCO:PRETO });
    y -= 17;
  });

  // Notas
  if (fatura.notas) {
    y -= 10;
    page.drawText('Notas: ' + fatura.notas.substring(0,100), { x: mL, y, size: 8, font: fontR, color: CINZA });
  }

  // QR Code AT
  try {
    const qrStr = gerarStringQRAT(fatura, empresa);
    // Gerar como buffer PNG directamente
    const qrBuffer = await QRCode.toBuffer(qrStr, { 
      type: 'png', 
      width: 100, 
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#000000', light: '#ffffff' }
    });
    const qrImage = await doc.embedPng(qrBuffer);
    const qrSize = 80;
    // Colocar QR no canto superior direito dentro do cabeçalho azul
    const qrX = width - qrSize - 10;
    const qrY = height - qrSize - 5;
    page.drawImage(qrImage, { x: qrX, y: qrY, width: qrSize, height: qrSize });
  } catch(e) {
    console.error('QR code ERRO:', e.message, e.stack ? e.stack.split('\n')[1] : '');
  }

  // Rodapé
  page.drawLine({ start:{x:mL,y:50}, end:{x:mR,y:50}, thickness:0.5, color:rgb(0.8,0.8,0.8) });
  page.drawText('Hash: ' + (fatura.hash||'').substring(0,40) + '...', { x: mL, y: 38, size: 6, font: fontR, color: CINZA });
  page.drawText('Processado por NexEdge v4.0 — Software certificado AT', { x: mL, y: 26, size: 7, font: fontR, color: CINZA });

  return Buffer.from(await doc.save());
}

module.exports = { gerarPDFFatura };
