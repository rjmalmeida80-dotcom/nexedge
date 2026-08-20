'use strict';
const router = require('express').Router();
const { autenticar } = require('../middleware/auth');
const { query } = require('../config/database');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

const MESES = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

async function gerarPDF(titulo, empresa, secoes) {
  const pdfDoc = await PDFDocument.create();
  const fontR = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontB = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  // Função para adicionar página
  function novaPage() {
    const page = pdfDoc.addPage([842, 595]); // A4 landscape
    const { width, height } = page.getSize();

    // Header
    page.drawRectangle({ x:0, y:height-50, width, height:50, color:rgb(0.31,0.27,0.9) });
    page.drawText('NexEdge', { x:20, y:height-32, size:18, font:fontB, color:rgb(1,1,1) });
    page.drawText(safe(titulo), { x:120, y:height-28, size:14, font:fontB, color:rgb(1,1,1) });
    page.drawText(safe(empresa), { x:120, y:height-42, size:9, font:fontR, color:rgb(0.8,0.8,1) });
    page.drawText(new Date().toLocaleDateString('pt-PT',{day:'2-digit',month:'long',year:'numeric'}),
      { x:width-130, y:height-32, size:9, font:fontR, color:rgb(1,1,1) });

    // Footer
    page.drawLine({ start:{x:20,y:25}, end:{x:width-20,y:25}, thickness:0.5, color:rgb(0.8,0.8,0.8) });
    page.drawText('NexEdge · nexedge.pt · Gerado automaticamente · Confidencial',
      { x:20, y:12, size:7, font:fontR, color:rgb(0.6,0.6,0.6) });
    page.drawText(`Página ${pdfDoc.getPageCount()}`,
      { x:width-60, y:12, size:7, font:fontR, color:rgb(0.6,0.6,0.6) });

    return { page, width, height, y: height - 70 };
  }

  // Função para desenhar KPI
  function desenharKPI(page, x, y, label, valor, cor) {
    const [r,g,b] = cor;
    page.drawRectangle({ x, y:y-40, width:160, height:48, color:rgb(0.08,0.06,0.14),
      borderColor:rgb(r,g,b), borderWidth:1 });
    page.drawText(safe(label), { x:x+8, y:y-12, size:8, font:fontR, color:rgb(0.6,0.6,0.7) });
    page.drawText(safe(String(valor||'')), { x:x+8, y:y-30, size:14, font:fontB, color:rgb(r,g,b) });
  }

  // Função para desenhar tabela
  function safe(v) { return String(v == null ? '' : v).replace(/[\x00-\x1F\x7F-\x9F]/g, ''); }

  function desenharTabela(page, x, startY, width, headers, rows, maxRows=20) {
    const colW = (width-x*2) / headers.length;
    let y = startY;

    // Header tabela
    page.drawRectangle({ x, y:y-16, width:width-x*2, height:18, color:rgb(0.15,0.12,0.3) });
    headers.forEach((h,i) => {
      page.drawText(h, { x:x+4+i*colW, y:y-11, size:8, font:fontB, color:rgb(0.8,0.8,1) });
    });
    y -= 18;

    // Linhas
    const visibleRows = rows.slice(0, maxRows);
    visibleRows.forEach((row, ri) => {
      if (ri % 2 === 0) {
        page.drawRectangle({ x, y:y-14, width:width-x*2, height:16, color:rgb(0.06,0.05,0.12) });
      }
      row.forEach((cell,ci) => {
        const txt = safe(String(cell||'')).substring(0,22);
        page.drawText(txt, { x:x+4+ci*colW, y:y-10, size:7.5, font:fontR, color:rgb(0.85,0.85,0.9) });
      });
      y -= 16;
    });

    if (rows.length > maxRows) {
      page.drawText(`... e mais ${rows.length-maxRows} registos`, { x:x+4, y:y-10, size:7, font:fontR, color:rgb(0.5,0.5,0.6) });
      y -= 14;
    }
    return y;
  }

  // Função para desenhar barra simples
  function desenharBarra(page, x, y, label, valor, maxValor, largura, cor) {
    const [r,g,b] = cor;
    const barW = maxValor > 0 ? Math.max(4, (valor/maxValor)*largura) : 4;
    page.drawText(label.substring(0,18), { x, y:y-10, size:7.5, font:fontR, color:rgb(0.7,0.7,0.8) });
    page.drawRectangle({ x:x+130, y:y-12, width:largura, height:10, color:rgb(0.1,0.08,0.2) });
    page.drawRectangle({ x:x+130, y:y-12, width:barW, height:10, color:rgb(r,g,b) });
    page.drawText(String(valor), { x:x+130+largura+6, y:y-10, size:7.5, font:fontB, color:rgb(r,g,b) });
  }

  // ── Gerar secções ──────────────────────────────────────────────────────────
  for (const secao of secoes) {
    const { page, width, height, y: startY } = novaPage();
    let y = startY;

    // Título da secção
    page.drawText(safe(secao.titulo||''), { x:20, y, size:13, font:fontB, color:rgb(0.65,0.63,1) });
    y -= 20;

    // KPIs
    if (secao.kpis && secao.kpis.length) {
      page.drawText('Indicadores Principais', { x:20, y, size:9, font:fontB, color:rgb(0.5,0.5,0.7) });
      y -= 14;
      const cores = [[0.51,0.51,0.98],[0.43,0.91,0.72],[0.99,0.83,0.27],[0.99,0.64,0.64]];
      secao.kpis.forEach((kpi, i) => {
        desenharKPI(page, 20 + i*170, y, kpi.label, kpi.valor, cores[i%4]);
      });
      y -= 55;
    }

    // Gráfico de barras simples
    if (secao.barras && secao.barras.dados && secao.barras.dados.length) {
      y -= 5;
      page.drawText(secao.barras.titulo || 'Distribuição', { x:20, y, size:9, font:fontB, color:rgb(0.5,0.5,0.7) });
      y -= 14;
      const maxVal = Math.max(...secao.barras.dados.map(d => parseFloat(d.valor||0)), 1);
      const cores = [[0.51,0.51,0.98],[0.43,0.91,0.72],[0.99,0.83,0.27],[0.65,0.37,0.98],[0.25,0.71,0.85]];
      secao.barras.dados.slice(0,8).forEach((d,i) => {
        desenharBarra(page, 20, y, d.label, d.valor, maxVal, 200, cores[i%5]);
        y -= 18;
      });
    }

    // Tabela principal
    if (secao.tabela && secao.tabela.headers && secao.tabela.rows) {
      y -= 10;
      page.drawText(secao.tabela.titulo || 'Detalhe', { x:20, y, size:9, font:fontB, color:rgb(0.5,0.5,0.7) });
      y -= 14;
      desenharTabela(page, 20, y, width, secao.tabela.headers, secao.tabela.rows, 18);
    }

    // Tabela secundária (coluna direita)
    if (secao.tabela2 && secao.tabela2.headers && secao.tabela2.rows && secao.tabela2.rows.length) {
      // Nova página para tabela secundária se necessário
      const { page:p2, width:w2, height:h2, y:y2 } = novaPage();
      let yy = y2;
      p2.drawText(secao.tabela2.titulo || 'Detalhe 2', { x:20, y:yy, size:9, font:fontB, color:rgb(0.5,0.5,0.7) });
      yy -= 14;
      desenharTabela(p2, 20, yy, w2, secao.tabela2.headers, secao.tabela2.rows, 25);
    }
  }

  return pdfDoc.save();
}

// ── PDF RH ────────────────────────────────────────────────────────────────────
router.get('/rh/pdf', autenticar, async (req, res) => {
  try {
    const ano = parseInt(req.query.ano) || new Date().getFullYear();
    const eid = req.empresaId;

    const [empR, kpisR, deptoR, contratoR, faltasR, topSalR, recrutR] = await Promise.all([
      query('SELECT nome FROM empresa WHERE id=$1', [eid]),
      query(`SELECT
        COUNT(*) FILTER(WHERE estado='ativo') AS total,
        COUNT(*) FILTER(WHERE EXTRACT(YEAR FROM data_admissao)=$2) AS novos,
        COALESCE(AVG(salario_base) FILTER(WHERE estado='ativo'),0) AS salario_medio,
        COUNT(*) FILTER(WHERE estado='inativo') AS inativos
        FROM funcionario WHERE empresa_id=$1`, [eid, ano]),
      query(`SELECT COALESCE(d.nome,'Sem dept') AS label, COUNT(f.id) AS valor
        FROM funcionario f LEFT JOIN departamento d ON d.id=f.departamento_id
        WHERE f.empresa_id=$1 AND f.estado='ativo' GROUP BY d.nome ORDER BY valor DESC LIMIT 8`, [eid]),
      query(`SELECT COALESCE(tipo_contrato,'indefinido') AS label, COUNT(*) AS valor
        FROM contrato_trabalho WHERE empresa_id=$1 GROUP BY tipo_contrato ORDER BY valor DESC`, [eid]),
      query(`SELECT tipo AS label, COUNT(*) AS valor FROM falta
        WHERE empresa_id=$1 AND EXTRACT(YEAR FROM data)=$2 GROUP BY tipo ORDER BY valor DESC`, [eid,ano]).catch(()=>({rows:[]})),
      query(`SELECT nome_completo, cargo, COALESCE(d.nome,'—') AS departamento,
        salario_base, estado, data_admissao::date AS admissao
        FROM funcionario f LEFT JOIN departamento d ON d.id=f.departamento_id
        WHERE f.empresa_id=$1 ORDER BY f.nome_completo LIMIT 50`, [eid]),
      query(`SELECT titulo AS label, COUNT(*) AS valor FROM vaga
        WHERE empresa_id=$1 GROUP BY titulo ORDER BY valor DESC LIMIT 5`, [eid]).catch(()=>({rows:[]})),
    ]);

    const kpis = kpisR.rows[0];
    const emp = empR.rows[0]?.nome || 'Empresa';
    const fmt = v => parseFloat(v||0).toLocaleString('pt-PT',{minimumFractionDigits:2})+'€';

    const pdfBytes = await gerarPDF(`Relatório RH ${ano}`, emp, [
      {
        titulo: `Recursos Humanos — ${ano}`,
        kpis: [
          { label:'Total Colaboradores', valor:kpis.total },
          { label:'Novos este ano', valor:kpis.novos },
          { label:'Salário Médio', valor:fmt(kpis.salario_medio) },
          { label:'Inactivos', valor:kpis.inativos },
        ],
        barras: { titulo:'Colaboradores por Departamento', dados:deptoR.rows },
        tabela: {
          titulo:'Lista de Colaboradores',
          headers:['Nome','Cargo','Departamento','Salário','Estado','Admissão'],
          rows:topSalR.rows.map(r=>[
            r.nome_completo?.substring(0,20),
            r.cargo?.substring(0,15)||'—',
            r.departamento?.substring(0,12)||'—',
            fmt(r.salario_base),
            r.estado,
            r.admissao ? new Date(r.admissao).toLocaleDateString('pt-PT') : '—',
          ]),
        },
        tabela2: contratoR.rows.length ? {
          titulo:'Tipos de Contrato',
          headers:['Tipo','Total'],
          rows:contratoR.rows.map(r=>[r.label,r.valor]),
        } : null,
      },
    ]);

    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition',`attachment; filename="relatorio_rh_${ano}.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } catch(e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// ── PDF FINANCEIRO ────────────────────────────────────────────────────────────
router.get('/financeiro/pdf', autenticar, async (req, res) => {
  try {
    const ano = parseInt(req.query.ano) || new Date().getFullYear();
    const eid = req.empresaId;

    const [empR, kpisR, faturasR, despR, estadoR] = await Promise.all([
      query('SELECT nome FROM empresa WHERE id=$1', [eid]),
      query(`SELECT
        COALESCE(SUM(total),0) AS faturacao,
        COALESCE(SUM(CASE WHEN estado='paga' THEN total ELSE 0 END),0) AS recebido,
        COALESCE(SUM(CASE WHEN estado NOT IN ('paga','anulada') THEN total ELSE 0 END),0) AS em_aberto,
        COUNT(*) AS total_faturas
        FROM fatura WHERE empresa_id=$1 AND EXTRACT(YEAR FROM data_emissao)=$2`, [eid,ano]),
      query(`SELECT EXTRACT(MONTH FROM data_emissao) AS mes, SUM(total) AS valor
        FROM fatura WHERE empresa_id=$1 AND EXTRACT(YEAR FROM data_emissao)=$2
        GROUP BY mes ORDER BY mes`, [eid,ano]),
      query(`SELECT categoria AS label, SUM(valor) AS valor FROM despesa
        WHERE empresa_id=$1 AND EXTRACT(YEAR FROM data_despesa)=$2
        GROUP BY categoria ORDER BY valor DESC LIMIT 8`, [eid,ano]).catch(()=>({rows:[]})),
      query(`SELECT numero_completo, cliente_nome, data_emissao::date AS data,
        total, estado FROM fatura
        WHERE empresa_id=$1 AND EXTRACT(YEAR FROM data_emissao)=$2
        ORDER BY data_emissao DESC LIMIT 40`, [eid,ano]),
    ]);

    const kpis = kpisR.rows[0];
    const emp = empR.rows[0]?.nome || 'Empresa';
    const fmt = v => parseFloat(v||0).toLocaleString('pt-PT',{minimumFractionDigits:2})+'€';

    // Evolução mensal como barras
    const evolucao = MESES.map((m,i) => ({
      label: m,
      valor: fmtNum(faturasR.rows.find(r=>parseInt(r.mes)===i+1)?.valor||0),
    }));

    const pdfBytes = await gerarPDF(`Relatório Financeiro ${ano}`, emp, [
      {
        titulo: `Financeiro — ${ano}`,
        kpis: [
          { label:'Facturação Total', valor:fmt(kpis.faturacao) },
          { label:'Recebido', valor:fmt(kpis.recebido) },
          { label:'Em Aberto', valor:fmt(kpis.em_aberto) },
          { label:'Total Faturas', valor:kpis.total_faturas },
        ],
        barras: { titulo:'Facturação Mensal', dados:evolucao },
        tabela: {
          titulo:'Faturas Emitidas',
          headers:['Nº Fatura','Cliente','Data','Total','Estado'],
          rows:estadoR.rows.map(r=>[
            r.numero_completo||'—',
            (r.cliente_nome||'—').substring(0,20),
            r.data ? new Date(r.data).toLocaleDateString('pt-PT') : '—',
            fmt(r.total),
            r.estado,
          ]),
        },
        tabela2: despR.rows.length ? {
          titulo:'Despesas por Categoria',
          headers:['Categoria','Total'],
          rows:despR.rows.map(r=>[r.label||'—', fmt(r.valor)]),
        } : null,
      },
    ]);

    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition',`attachment; filename="relatorio_financeiro_${ano}.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } catch(e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// ── PDF COMERCIAL ─────────────────────────────────────────────────────────────
router.get('/comercial/pdf', autenticar, async (req, res) => {
  try {
    const ano = parseInt(req.query.ano) || new Date().getFullYear();
    const eid = req.empresaId;

    const [empR, kpisR, funilR, setorR, opR] = await Promise.all([
      query('SELECT nome FROM empresa WHERE id=$1', [eid]),
      query(`SELECT
        COALESCE(SUM(CASE WHEN etapa NOT IN ('fechado_ganho','fechado_perdido') THEN valor ELSE 0 END),0) AS pipeline,
        COALESCE(SUM(CASE WHEN etapa='fechado_ganho' THEN valor ELSE 0 END),0) AS ganhos,
        COUNT(*) FILTER(WHERE etapa NOT IN ('fechado_ganho','fechado_perdido')) AS em_curso,
        COUNT(*) FILTER(WHERE etapa='fechado_ganho') AS ganhos_count
        FROM crm_oportunidade WHERE empresa_id=$1`, [eid]),
      query(`SELECT etapa AS label, COUNT(*) AS valor FROM crm_oportunidade
        WHERE empresa_id=$1 GROUP BY etapa ORDER BY valor DESC`, [eid]),
      query(`SELECT COALESCE(ce.setor,'Outro') AS label, COUNT(o.id) AS valor
        FROM crm_oportunidade o LEFT JOIN crm_empresa ce ON ce.id=o.crm_empresa_id
        WHERE o.empresa_id=$1 GROUP BY ce.setor ORDER BY valor DESC LIMIT 8`, [eid]),
      query(`SELECT o.titulo, COALESCE(ce.nome,'—') AS cliente,
        o.valor, o.etapa, o.probabilidade,
        o.data_fecho_prevista::date AS fecho
        FROM crm_oportunidade o
        LEFT JOIN crm_empresa ce ON ce.id=o.crm_empresa_id
        WHERE o.empresa_id=$1 ORDER BY o.valor DESC NULLS LAST LIMIT 40`, [eid]),
    ]);

    const kpis = kpisR.rows[0];
    const emp = empR.rows[0]?.nome || 'Empresa';
    const fmt = v => parseFloat(v||0).toLocaleString('pt-PT',{minimumFractionDigits:2})+'€';

    const pdfBytes = await gerarPDF(`Relatório Comercial ${ano}`, emp, [
      {
        titulo: `CRM & Comercial — ${ano}`,
        kpis: [
          { label:'Pipeline Total', valor:fmt(kpis.pipeline) },
          { label:'Ganhos', valor:fmt(kpis.ganhos) },
          { label:'Em Curso', valor:kpis.em_curso },
          { label:'Negócios Ganhos', valor:kpis.ganhos_count },
        ],
        barras: { titulo:'Funil de Vendas por Etapa', dados:funilR.rows },
        tabela: {
          titulo:'Oportunidades',
          headers:['Oportunidade','Cliente','Valor','Etapa','Prob.','Fecho Previsto'],
          rows:opR.rows.map(r=>[
            (r.titulo||'—').substring(0,20),
            (r.cliente||'—').substring(0,15),
            r.valor ? fmt(r.valor) : '—',
            r.etapa||'—',
            r.probabilidade ? `${r.probabilidade}%` : '—',
            r.fecho ? new Date(r.fecho).toLocaleDateString('pt-PT') : '—',
          ]),
        },
        tabela2: setorR.rows.length ? {
          titulo:'Oportunidades por Sector',
          headers:['Sector','Total'],
          rows:setorR.rows.map(r=>[r.label||'—', r.valor]),
        } : null,
      },
    ]);

    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition',`attachment; filename="relatorio_comercial_${ano}.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } catch(e) { console.error(e); res.status(500).json({ error: e.message }); }
});

function fmtNum(v) { return parseFloat(v||0).toLocaleString('pt-PT',{minimumFractionDigits:2})+'€'; }

module.exports = router;
