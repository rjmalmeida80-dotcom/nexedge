'use strict';
const router = require('express').Router();
const { autenticar, autorizar } = require('../middleware/auth');
const { query } = require('../config/database');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

router.get('/resumo', autenticar, autorizar('admin_empresa','rh','diretor'), async (req, res) => {
  try {
    const { ano = new Date().getFullYear() - 1 } = req.query;
    const { rows } = await query(`
      SELECT f.id, f.nome_completo, f.nif, f.numero_funcionario, f.cargo,
        COALESCE(SUM(rv.total_abonos),0) AS rendimentos,
        COALESCE(SUM(rv.irs_retido),0) AS irs_total,
        COALESCE(SUM(rv.seg_social_func),0) AS ss_total,
        COALESCE(SUM(rv.liquido),0) AS liquido_total,
        COUNT(rv.id) AS meses_processados
      FROM funcionario f
      LEFT JOIN recibo_vencimento rv ON rv.funcionario_id=f.id AND rv.ano=$2
      WHERE f.empresa_id=$1 AND f.estado='ativo'
      GROUP BY f.id ORDER BY f.nome_completo
    `, [req.empresaId, ano]);
    res.json({ ano, colaboradores: rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/declaracao/:funcionarioId', autenticar, autorizar('admin_empresa','rh','diretor'), async (req, res) => {
  try {
    const { ano = new Date().getFullYear() - 1 } = req.query;
    const { rows:[func] } = await query(`
      SELECT f.*, e.nome AS empresa_nome, e.nif AS empresa_nif, e.morada AS empresa_morada
      FROM funcionario f JOIN empresa e ON e.id=f.empresa_id
      WHERE f.id=$1 AND f.empresa_id=$2
    `, [req.params.funcionarioId, req.empresaId]);
    if (!func) return res.status(404).json({ error: 'Colaborador não encontrado' });

    const { rows: recibos } = await query(
      'SELECT * FROM recibo_vencimento WHERE funcionario_id=$1 AND ano=$2 ORDER BY mes',
      [req.params.funcionarioId, ano]
    );

    const totais = recibos.reduce((a,r) => ({
      rendimentos: a.rendimentos + parseFloat(r.total_abonos||0),
      irs: a.irs + parseFloat(r.irs_retido||0),
      ss: a.ss + parseFloat(r.ss_trabalhador||0),
      liquido: a.liquido + parseFloat(r.liquido||0),
    }), { rendimentos:0, irs:0, ss:0, liquido:0 });

    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([595, 842]);
    const { width, height } = page.getSize();
    const fontR = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontB = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const fmtV = v => parseFloat(v||0).toLocaleString('pt-PT',{minimumFractionDigits:2})+'Euro';

    page.drawRectangle({ x:0, y:height-80, width, height:80, color:rgb(0.31,0.27,0.9) });
    page.drawText('NexEdge', { x:20, y:height-40, size:20, font:fontB, color:rgb(1,1,1) });
    page.drawText('DECLARACAO DE RENDIMENTOS PARA IRS', { x:20, y:height-62, size:11, font:fontB, color:rgb(0.8,0.8,1) });
    page.drawText('Ano Fiscal: ' + ano, { x:width-130, y:height-50, size:11, font:fontR, color:rgb(1,1,1) });

    let y = height - 110;
    page.drawText('ENTIDADE PAGADORA', { x:20, y, size:10, font:fontB, color:rgb(0.4,0.4,0.7) });
    y -= 16; page.drawText(func.empresa_nome||'', { x:20, y, size:12, font:fontB, color:rgb(0.1,0.1,0.1) });
    y -= 14; page.drawText('NIF: ' + (func.empresa_nif||''), { x:20, y, size:10, font:fontR, color:rgb(0.5,0.5,0.5) });
    y -= 30;

    page.drawRectangle({ x:20, y:y-50, width:width-40, height:55, color:rgb(0.96,0.96,1) });
    page.drawText('TRABALHADOR', { x:28, y:y-8, size:10, font:fontB, color:rgb(0.4,0.4,0.7) });
    page.drawText(func.nome_completo||'', { x:28, y:y-24, size:13, font:fontB, color:rgb(0.1,0.1,0.1) });
    page.drawText('NIF: ' + (func.nif||'N/D') + '   |   Nr. ' + (func.numero_funcionario||'N/D'), { x:28, y:y-40, size:10, font:fontR, color:rgb(0.5,0.5,0.5) });
    y -= 70;

    page.drawText('RENDIMENTOS E RETENCOES - ANO ' + ano, { x:20, y, size:10, font:fontB, color:rgb(0.4,0.4,0.7) });
    y -= 20;

    const linha = (label, valor, dest) => {
      page.drawRectangle({ x:20, y:y-18, width:width-40, height:22, color: dest ? rgb(0.31,0.27,0.9) : rgb(0.97,0.97,1) });
      page.drawText(label, { x:28, y:y-10, size:10, font: dest?fontB:fontR, color: dest?rgb(1,1,1):rgb(0.2,0.2,0.2) });
      page.drawText(fmtV(valor), { x:width-110, y:y-10, size:10, font: dest?fontB:fontR, color: dest?rgb(0.9,0.9,1):rgb(0.2,0.2,0.2) });
      y -= 24;
    };
    linha('Total de Rendimentos Brutos (Cat. A)', totais.rendimentos, false);
    linha('Retencao na Fonte (IRS)', totais.irs, false);
    linha('Contribuicoes para a Seguranca Social', totais.ss, false);
    linha('Total Liquido Recebido', totais.liquido, true);
    y -= 15;

    page.drawText('DETALHE MENSAL', { x:20, y, size:10, font:fontB, color:rgb(0.4,0.4,0.7) });
    y -= 16;
    page.drawRectangle({ x:20, y:y-16, width:width-40, height:18, color:rgb(0.2,0.18,0.35) });
    ['Mes','Bruto','IRS Retido','SS','Liquido'].forEach((h,i) => {
      page.drawText(h, { x:[28,130,230,340,450][i], y:y-11, size:8, font:fontB, color:rgb(1,1,1) });
    });
    y -= 18;
    const MN = {1:'Jan',2:'Fev',3:'Mar',4:'Abr',5:'Mai',6:'Jun',7:'Jul',8:'Ago',9:'Set',10:'Out',11:'Nov',12:'Dez'};
    recibos.forEach((r,i) => {
      if(i%2===0) page.drawRectangle({ x:20, y:y-13, width:width-40, height:16, color:rgb(0.97,0.97,1) });
      [MN[r.mes]||'', fmtV(r.total_abonos), fmtV(r.irs_retido), fmtV(r.ss_trabalhador), fmtV(r.liquido)]
        .forEach((v,ci) => page.drawText(v, { x:[28,130,230,340,450][ci], y:y-9, size:8, font:fontR, color:rgb(0.2,0.2,0.2) }));
      y -= 16;
    });

    y -= 20;
    page.drawLine({ start:{x:20,y}, end:{x:width-20,y}, thickness:0.5, color:rgb(0.8,0.8,0.8) });
    y -= 12;
    page.drawText('Declaracao gerada automaticamente pelo sistema NexEdge. Gerada em ' + new Date().toLocaleDateString('pt-PT'),
      { x:20, y, size:8, font:fontR, color:rgb(0.5,0.5,0.5) });
    y -= 40;
    page.drawText('Assinatura e Carimbo da Entidade Patronal: ____________________________',
      { x:20, y, size:9, font:fontR, color:rgb(0.4,0.4,0.4) });

    const pdfBytes = await pdfDoc.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="IRS_' + (func.nome_completo||'').replace(/ /g,'_') + '_' + ano + '.pdf"');
    res.send(Buffer.from(pdfBytes));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/enviar/:funcionarioId', autenticar, autorizar('admin_empresa','rh','diretor'), async (req, res) => {
  try {
    const { ano = new Date().getFullYear() - 1 } = req.body;
    const { rows:[func] } = await query(
      'SELECT nome_completo, email_pessoal, email_empresa FROM funcionario WHERE id=$1 AND empresa_id=$2',
      [req.params.funcionarioId, req.empresaId]
    );
    if (!func) return res.status(404).json({ error: 'Colaborador nao encontrado' });
    const emailDest = func.email_pessoal || func.email_empresa;
    if (!emailDest) return res.status(400).json({ error: 'Colaborador sem email' });
    const { enviar } = require('../services/emailService');
    await enviar({ remetente:'suporte', para:emailDest,
      assunto:'Declaracao de Rendimentos IRS ' + ano + ' - NexEdge',
      html:'<p>Ola <b>' + func.nome_completo + '</b>,</p><p>Segue a declaracao de rendimentos IRS do ano ' + ano + '.</p><p>NexEdge</p>' });
    res.json({ message: 'Declaracao enviada para ' + emailDest });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
