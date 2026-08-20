'use strict';
const router = require('express').Router();
const { autenticar, autorizar } = require('../middleware/auth');
const { query } = require('../config/database');

const ADMINS = ['admin_empresa', 'diretor'];

// ── MOLONI ───────────────────────────────────────────────────────────────────
// Exportar clientes para Moloni (CSV)
router.get('/moloni/clientes/exportar', autenticar, autorizar(...ADMINS), async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT nome, nif, email, telefone, morada, codigo_postal, localidade
      FROM cliente WHERE empresa_id=$1 ORDER BY nome
    `, [req.empresaId]);

    const csv = [
      'Nome,NIF,Email,Telefone,Morada,Código Postal,Localidade',
      ...rows.map(r => [
        `"${r.nome||''}"`, r.nif||'', r.email||'', r.telefone||'',
        `"${r.morada||''}"`, r.codigo_postal||'', r.localidade||''
      ].join(','))
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="clientes_moloni.csv"');
    res.send('\ufeff' + csv); // BOM para Excel PT
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Exportar faturas para Moloni (CSV)
router.get('/moloni/faturas/exportar', autenticar, autorizar(...ADMINS), async (req, res) => {
  try {
    const { ano, mes } = req.query;
    let where = 'WHERE f.empresa_id=$1';
    const params = [req.empresaId];
    if (ano) { params.push(ano); where += ` AND EXTRACT(YEAR FROM f.data_emissao)=$${params.length}`; }
    if (mes) { params.push(mes); where += ` AND EXTRACT(MONTH FROM f.data_emissao)=$${params.length}`; }

    const { rows } = await query(`
      SELECT f.numero_completo, f.data_emissao::date, f.cliente_nome, f.cliente_nif,
        f.subtotal, f.iva_total, f.total, f.estado,
        STRING_AGG(fl.descricao || ' (qty:' || fl.quantidade || ')', '; ') AS linhas
      FROM fatura f
      LEFT JOIN fatura_linha fl ON fl.fatura_id = f.id
      ${where}
      GROUP BY f.id ORDER BY f.data_emissao DESC
    `, params);

    const csv = [
      'Número,Data,Cliente,NIF Cliente,Subtotal,IVA,Total,Estado,Linhas',
      ...rows.map(r => [
        r.numero_completo||'', r.data_emissao||'',
        `"${r.cliente_nome||''}"`, r.cliente_nif||'',
        r.subtotal||0, r.iva_total||0, r.total||0, r.estado||'',
        `"${r.linhas||''}"`
      ].join(','))
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="faturas_moloni.csv"');
    res.send('\ufeff' + csv);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Importar clientes do Moloni (CSV)
router.post('/moloni/clientes/importar', autenticar, autorizar(...ADMINS), async (req, res) => {
  try {
    const { clientes } = req.body; // Array de {nome, nif, email, telefone, morada, codigo_postal, localidade}
    if (!Array.isArray(clientes) || !clientes.length) {
      return res.status(400).json({ error: 'Lista de clientes obrigatória' });
    }

    let importados = 0, duplicados = 0, erros = 0;
    for (const c of clientes) {
      if (!c.nome) { erros++; continue; }
      try {
        await query(`
          INSERT INTO cliente (empresa_id, nome, nif, email, telefone, morada, codigo_postal, localidade)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT (empresa_id, nif) WHERE nif IS NOT NULL DO UPDATE SET
            nome=EXCLUDED.nome, email=EXCLUDED.email, telefone=EXCLUDED.telefone,
            morada=EXCLUDED.morada, actualizado_em=NOW()
        `, [req.empresaId, c.nome, c.nif||null, c.email||null, c.telefone||null,
            c.morada||null, c.codigo_postal||null, c.localidade||null]);
        importados++;
      } catch { erros++; }
    }

    res.json({ importados, duplicados, erros, total: clientes.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PHC ───────────────────────────────────────────────────────────────────────
// Exportar colaboradores para PHC (CSV formato PHC)
router.get('/phc/colaboradores/exportar', autenticar, autorizar(...ADMINS), async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT f.numero_funcionario, f.nome_completo, f.nif, f.data_nascimento::date,
        f.data_admissao::date, f.cargo, f.salario_base, f.tipo_contrato,
        f.email_empresa, f.telefone, f.iban,
        d.nome AS departamento
      FROM funcionario f
      LEFT JOIN departamento d ON d.id = f.departamento_id
      WHERE f.empresa_id=$1 AND f.estado='ativo'
      ORDER BY f.numero_funcionario
    `, [req.empresaId]);

    const csv = [
      'Nº Func.,Nome,NIF,Data Nasc.,Data Admissão,Cargo,Salário Base,Tipo Contrato,Email,Telefone,IBAN,Departamento',
      ...rows.map(r => [
        r.numero_funcionario||'', `"${r.nome_completo||''}"`,
        r.nif||'', r.data_nascimento||'', r.data_admissao||'',
        `"${r.cargo||''}"`, r.salario_base||0, r.tipo_contrato||'',
        r.email_empresa||'', r.telefone||'', r.iban||'',
        `"${r.departamento||''}"`
      ].join(','))
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="colaboradores_phc.csv"');
    res.send('\ufeff' + csv);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Exportar processamento salarial para PHC
router.get('/phc/salarios/exportar', autenticar, autorizar(...ADMINS), async (req, res) => {
  try {
    const { mes, ano } = req.query;
    const { rows } = await query(`
      SELECT f.numero_funcionario, f.nome_completo, f.nif,
        rv.mes, rv.ano, rv.salario_base, rv.total_abonos,
        rv.total_descontos, rv.liquido, rv.irs_retido, rv.ss_trabalhador
      FROM recibo_vencimento rv
      JOIN funcionario f ON f.id = rv.funcionario_id
      WHERE rv.empresa_id=$1
        ${mes ? `AND rv.mes=${parseInt(mes)}` : ''}
        ${ano ? `AND rv.ano=${parseInt(ano)}` : ''}
      ORDER BY f.numero_funcionario
    `, [req.empresaId]);

    const csv = [
      'Nº Func.,Nome,NIF,Mês,Ano,Salário Base,Total Abonos,Total Descontos,Líquido,IRS Retido,SS Trabalhador',
      ...rows.map(r => [
        r.numero_funcionario||'', `"${r.nome_completo||''}"`,
        r.nif||'', r.mes||'', r.ano||'',
        r.salario_base||0, r.total_abonos||0, r.total_descontos||0,
        r.liquido||0, r.irs_retido||0, r.ss_trabalhador||0
      ].join(','))
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="salarios_phc_${mes||''}${ano||''}.csv"`);
    res.send('\ufeff' + csv);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Importar colaboradores do PHC
router.post('/phc/colaboradores/importar', autenticar, autorizar(...ADMINS), async (req, res) => {
  try {
    const { colaboradores } = req.body;
    if (!Array.isArray(colaboradores) || !colaboradores.length) {
      return res.status(400).json({ error: 'Lista de colaboradores obrigatória' });
    }

    let importados = 0, erros = 0;
    for (const c of colaboradores) {
      if (!c.nome_completo || !c.data_admissao) { erros++; continue; }
      try {
        await query(`
          INSERT INTO funcionario (empresa_id, nome_completo, nif, cargo, salario_base,
            data_admissao, tipo_contrato, email_empresa, estado)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ativo')
          ON CONFLICT (empresa_id, nif) WHERE nif IS NOT NULL DO UPDATE SET
            nome_completo=EXCLUDED.nome_completo, cargo=EXCLUDED.cargo,
            salario_base=EXCLUDED.salario_base
        `, [req.empresaId, c.nome_completo, c.nif||null, c.cargo||'—',
            c.salario_base||0, c.data_admissao, c.tipo_contrato||'sem_termo',
            c.email_empresa||null]);
        importados++;
      } catch { erros++; }
    }
    res.json({ importados, erros, total: colaboradores.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PRIMAVERA ─────────────────────────────────────────────────────────────────
// Exportar para Primavera (formato XML simplificado)
router.get('/primavera/clientes/exportar', autenticar, autorizar(...ADMINS), async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT nome, nif, email, telefone, morada, codigo_postal, localidade
      FROM cliente WHERE empresa_id=$1 ORDER BY nome
    `, [req.empresaId]);

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Clientes xmlns="http://www.primaverabss.com">
${rows.map(r => `  <Cliente>
    <Nome>${escapeXml(r.nome||'')}</Nome>
    <NIF>${r.nif||''}</NIF>
    <Email>${r.email||''}</Email>
    <Telefone>${r.telefone||''}</Telefone>
    <Morada>${escapeXml(r.morada||'')}</Morada>
    <CodigoPostal>${r.codigo_postal||''}</CodigoPostal>
    <Localidade>${escapeXml(r.localidade||'')}</Localidade>
  </Cliente>`).join('\n')}
</Clientes>`;

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="clientes_primavera.xml"');
    res.send(xml);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Exportar artigos/serviços para Primavera
router.get('/primavera/artigos/exportar', autenticar, autorizar(...ADMINS), async (req, res) => {
  try {
    // Obter linhas de faturas únicas como artigos
    const { rows } = await query(`
      SELECT DISTINCT ON (descricao) descricao, preco_unitario, taxa_iva
      FROM fatura_linha fl
      JOIN fatura f ON f.id = fl.fatura_id
      WHERE f.empresa_id=$1
      ORDER BY descricao, preco_unitario DESC
      LIMIT 500
    `, [req.empresaId]);

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Artigos xmlns="http://www.primaverabss.com">
${rows.map((r, i) => `  <Artigo>
    <Codigo>ART${String(i+1).padStart(4,'0')}</Codigo>
    <Descricao>${escapeXml(r.descricao||'')}</Descricao>
    <PrecoVenda>${parseFloat(r.preco_unitario||0).toFixed(2)}</PrecoVenda>
    <TaxaIVA>${r.taxa_iva||23}</TaxaIVA>
  </Artigo>`).join('\n')}
</Artigos>`;

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="artigos_primavera.xml"');
    res.send(xml);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ESTADO DAS INTEGRAÇÕES ────────────────────────────────────────────────────
router.get('/estado', autenticar, async (req, res) => {
  try {
    const { rows:[emp] } = await query('SELECT nome FROM empresa WHERE id=$1', [req.empresaId]);
    const { rows:[stats] } = await query(`
      SELECT
        (SELECT COUNT(*) FROM funcionario WHERE empresa_id=$1 AND estado='ativo') AS colaboradores,
        (SELECT COUNT(*) FROM cliente WHERE empresa_id=$1) AS clientes,
        (SELECT COUNT(*) FROM fatura WHERE empresa_id=$1) AS faturas,
        (SELECT COUNT(*) FROM recibo_vencimento WHERE empresa_id=$1) AS recibos
    `, [req.empresaId]);

    res.json({
      empresa: emp?.nome,
      dados: stats,
      integracoes: [
        { id:'moloni', nome:'Moloni', disponivel:true,
          exportar:['clientes','faturas'], importar:['clientes'] },
        { id:'phc', nome:'PHC CS', disponivel:true,
          exportar:['colaboradores','salarios'], importar:['colaboradores'] },
        { id:'primavera', nome:'Primavera', disponivel:true,
          exportar:['clientes','artigos'], importar:[] },
      ]
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

function escapeXml(str) {
  return String(str||'')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = router;
