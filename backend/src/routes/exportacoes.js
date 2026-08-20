'use strict';
const router = require('express').Router();
const { autenticar, autorizar } = require('../middleware/auth');
const { query } = require('../config/database');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

// ── Exportar recibos de um mês em ZIP (PDF por colaborador) ──────────────────
router.get('/recibos/lote', autenticar, autorizar('admin_empresa','rh','diretor'), async (req, res) => {
  try {
    const { mes, ano } = req.query;
    if (!mes || !ano) return res.status(400).json({ error: 'Mês e ano obrigatórios' });

    const { rows: recibos } = await query(`
      SELECT rv.*, f.nome_completo, f.cargo, f.nif, f.numero_funcionario,
        e.nome AS empresa_nome, e.nif AS empresa_nif
      FROM recibo_vencimento rv
      JOIN funcionario f ON f.id = rv.funcionario_id
      JOIN empresa e ON e.id = rv.empresa_id
      WHERE rv.empresa_id=$1 AND rv.mes=$2 AND rv.ano=$3
      ORDER BY f.nome_completo
    `, [req.empresaId, parseInt(mes), parseInt(ano)]);

    if (!recibos.length) return res.status(404).json({ error: 'Sem recibos para este período' });

    const MESES = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

    // Criar PDF consolidado com todos os recibos
    const pdfDoc = await PDFDocument.create();
    const fontR = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontB = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    for (const r of recibos) {
      const page = pdfDoc.addPage([595, 842]); // A4 portrait
      const { width, height } = page.getSize();

      // Header empresa
      page.drawRectangle({ x:0, y:height-70, width, height:70, color:rgb(0.31,0.27,0.9) });
      page.drawText(r.empresa_nome || 'Empresa', { x:20, y:height-35, size:16, font:fontB, color:rgb(1,1,1) });
      page.drawText(`NIF: ${r.empresa_nif||''}`, { x:20, y:height-52, size:10, font:fontR, color:rgb(0.8,0.8,1) });
      page.drawText('RECIBO DE VENCIMENTO', { x:width-200, y:height-35, size:12, font:fontB, color:rgb(1,1,1) });
      page.drawText(`${MESES[parseInt(mes)-1]} ${ano}`, { x:width-200, y:height-52, size:10, font:fontR, color:rgb(0.8,0.8,1) });

      // Dados colaborador
      page.drawRectangle({ x:20, y:height-130, width:width-40, height:50, color:rgb(0.97,0.97,1) });
      page.drawText(r.nome_completo || '', { x:30, y:height-100, size:13, font:fontB, color:rgb(0.2,0.2,0.2) });
      page.drawText(`${r.cargo||''}  |  NIF: ${r.nif||''}  |  Nº ${r.numero_funcionario||''}`, { x:30, y:height-118, size:9, font:fontR, color:rgb(0.5,0.5,0.5) });

      // Tabela de abonos/descontos
      let y = height - 160;
      const col1 = 30, col2 = 350, col3 = width - 80;

      // Headers tabela
      page.drawLine({ start:{x:20,y:y+2}, end:{x:width-20,y:y+2}, thickness:1, color:rgb(0.8,0.8,0.9) });
      page.drawText('DESCRIÇÃO', { x:col1, y:y-12, size:9, font:fontB, color:rgb(0.4,0.4,0.6) });
      page.drawText('ABONOS', { x:col2, y:y-12, size:9, font:fontB, color:rgb(0.4,0.4,0.6) });
      page.drawText('DESCONTOS', { x:col3-40, y:y-12, size:9, font:fontB, color:rgb(0.4,0.4,0.6) });
      y -= 28;

      const fmtV = v => parseFloat(v||0).toFixed(2)+'€';
      const linha = (desc, abono, desconto) => {
        page.drawText(desc, { x:col1, y, size:9, font:fontR, color:rgb(0.2,0.2,0.2) });
        if (abono) page.drawText(fmtV(abono), { x:col2, y, size:9, font:fontR, color:rgb(0.1,0.5,0.2) });
        if (desconto) page.drawText(fmtV(desconto), { x:col3-20, y, size:9, font:fontR, color:rgb(0.7,0.1,0.1) });
        y -= 18;
      };

      linha('Salário Base', r.salario_base, null);
      if (r.sub_alimentacao > 0) linha('Subsídio de Alimentação', r.sub_alimentacao, null);
      if (r.horas_extra > 0) linha('Horas Extra', r.horas_extra, null);
      if (r.outros_abonos > 0) linha('Outros Abonos', r.outros_abonos, null);
      linha('IRS Retido', null, r.irs_retido);
      linha('Segurança Social (11%)', null, r.ss_trabalhador);
      if (r.outros_descontos > 0) linha('Outros Descontos', null, r.outros_descontos);

      y -= 10;
      page.drawLine({ start:{x:20,y:y+4}, end:{x:width-20,y:y+4}, thickness:1, color:rgb(0.8,0.8,0.9) });
      y -= 8;

      // Totais
      page.drawText('TOTAL ABONOS', { x:col1, y, size:10, font:fontB, color:rgb(0.2,0.2,0.2) });
      page.drawText(fmtV(r.total_abonos), { x:col2, y, size:10, font:fontB, color:rgb(0.1,0.5,0.2) });
      y -= 20;
      page.drawText('TOTAL DESCONTOS', { x:col1, y, size:10, font:fontB, color:rgb(0.2,0.2,0.2) });
      page.drawText(fmtV(r.total_descontos), { x:col3-20, y, size:10, font:fontB, color:rgb(0.7,0.1,0.1) });
      y -= 30;

      // Líquido
      page.drawRectangle({ x:20, y:y-8, width:width-40, height:32, color:rgb(0.31,0.27,0.9) });
      page.drawText('VENCIMENTO LIQUIDO', { x:30, y:y+6, size:12, font:fontB, color:rgb(1,1,1) });
      page.drawText(fmtV(r.liquido), { x:width-100, y:y+6, size:14, font:fontB, color:rgb(0.9,0.9,1) });

      // Rodapé
      page.drawLine({ start:{x:20,y:60}, end:{x:width-20,y:60}, thickness:0.5, color:rgb(0.8,0.8,0.8) });
      page.drawText('Assinatura do Trabalhador: ____________________________', { x:20, y:40, size:8, font:fontR, color:rgb(0.5,0.5,0.5) });
      page.drawText(`Processado por NexEdge · ${new Date().toLocaleDateString('pt-PT')}`, { x:width-220, y:40, size:8, font:fontR, color:rgb(0.5,0.5,0.5) });
    }

    const pdfBytes = await pdfDoc.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="recibos_${MESES[parseInt(mes)-1]}_${ano}.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } catch(e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// ── Pesquisa global ───────────────────────────────────────────────────────────
router.get('/pesquisa', autenticar, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json({ resultados: [] });

    const termo = `%${q}%`;
    const eid = req.empresaId;

    const [funcs, faturas, clientes, crm] = await Promise.all([
      query(`SELECT 'colaborador' AS tipo, id, nome_completo AS titulo, cargo AS subtitulo, '/funcionarios/' || id AS url
        FROM funcionario WHERE empresa_id=$1 AND (nome_completo ILIKE $2 OR email_empresa ILIKE $2 OR nif ILIKE $2) AND estado='ativo' LIMIT 5`,
        [eid, termo]),
      query(`SELECT 'fatura' AS tipo, id, numero_completo AS titulo, cliente_nome AS subtitulo, '/faturacao' AS url
        FROM fatura WHERE empresa_id=$1 AND (numero_completo ILIKE $2 OR cliente_nome ILIKE $2 OR cliente_nif ILIKE $2) LIMIT 5`,
        [eid, termo]),
      query(`SELECT 'cliente' AS tipo, id, nome AS titulo, nif AS subtitulo, '/crm' AS url
        FROM cliente WHERE empresa_id=$1 AND (nome ILIKE $2 OR nif ILIKE $2 OR email ILIKE $2) LIMIT 5`,
        [eid, termo]),
      query(`SELECT 'crm' AS tipo, id, titulo, COALESCE(valor::text,'') AS subtitulo, '/crm' AS url
        FROM crm_oportunidade WHERE empresa_id=$1 AND titulo ILIKE $2 LIMIT 5`,
        [eid, termo]).catch(()=>({rows:[]})),
    ]);

    const resultados = [
      ...funcs.rows.map(r => ({...r, icone:'👤'})),
      ...faturas.rows.map(r => ({...r, icone:'📄'})),
      ...clientes.rows.map(r => ({...r, icone:'🏢'})),
      ...crm.rows.map(r => ({...r, icone:'🎯'})),
    ];

    res.json({ resultados, total: resultados.length, termo: q });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ── Exportar colaboradores CSV ────────────────────────────────────────────────
router.get('/colaboradores/csv', autenticar, autorizar('admin_empresa','rh','diretor','super_admin'), async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT f.numero_funcionario, f.nome_completo, f.cargo, f.email_empresa, f.email_pessoal,
        f.nif, f.niss, f.data_admissao, f.data_nascimento, f.salario_base,
        f.subsidio_alimentacao, f.tipo_contrato, f.estado, f.telemovel, f.telefone,
        f.morada, f.codigo_postal, f.localidade, f.iban, f.banco,
        COALESCE(d.nome,'') AS departamento
      FROM funcionario f
      LEFT JOIN departamento d ON d.id = f.departamento_id
      WHERE f.empresa_id=$1 ORDER BY f.nome_completo
    `, [req.empresaId]);

    if (!rows.length) return res.status(404).json({ error: 'Sem colaboradores para exportar' });

    const fmt = (v) => v == null ? '' : String(v).replace(/"/g, '""');
    const fmtDate = (v) => v ? new Date(v).toLocaleDateString('pt-PT') : '';
    const fmtNum = (v) => v == null ? '' : parseFloat(v).toFixed(2);

    const header = [
      'Nº Funcionário','Nome Completo','Cargo','Email Empresa','Email Pessoal',
      'NIF','NISS','Data Admissão','Data Nascimento','Salário Base',
      'Sub. Alimentação','Tipo Contrato','Estado','Telemóvel','Telefone',
      'Morada','Código Postal','Localidade','IBAN','Banco','Departamento'
    ].join(';');

    const linhas = rows.map(r => [
      fmt(r.numero_funcionario), fmt(r.nome_completo), fmt(r.cargo),
      fmt(r.email_empresa), fmt(r.email_pessoal), fmt(r.nif), fmt(r.niss),
      fmtDate(r.data_admissao), fmtDate(r.data_nascimento),
      fmtNum(r.salario_base), fmtNum(r.subsidio_alimentacao),
      fmt(r.tipo_contrato), fmt(r.estado), fmt(r.telemovel), fmt(r.telefone),
      fmt(r.morada), fmt(r.codigo_postal), fmt(r.localidade),
      fmt(r.iban), fmt(r.banco), fmt(r.departamento)
    ].join(';')).join('\n');

    const csv = '\uFEFF' + header + '\n' + linhas;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="colaboradores_${new Date().toISOString().substring(0,10)}.csv"`);
    res.send(csv);
  } catch(e) { console.error(e); res.status(500).json({ error: e.message }); }
});

module.exports = router;
