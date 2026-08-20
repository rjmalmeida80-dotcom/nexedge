'use strict';
const router = require('express').Router();
const { autenticar, autorizar } = require('../middleware/auth');
const { query } = require('../config/database');

router.use(autenticar, autorizar('admin_empresa', 'rh', 'diretor'));

// ── Listar declarações ────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM modelo3_irs WHERE empresa_id=$1 ORDER BY ano DESC',
    [req.empresaId]
  );
  res.json(rows);
});

// ── Gerar/actualizar declaração do ano ───────────────────────────────────────
router.post('/gerar/:ano', async (req, res) => {
  const ano = parseInt(req.params.ano);
  const eid = req.empresaId;

  // Buscar todos os recibos processados do ano
  const { rows: recibos } = await query(`
    SELECT
      f.id AS funcionario_id,
      f.nome_completo,
      f.nif,
      SUM(rp.total_abonos) AS rendimento_bruto,
      SUM(COALESCE(rp.irs_retido,0)) AS retencao_irs,
      SUM(COALESCE(rp.seg_social_func,0)) AS contribuicoes_ss
    FROM recibo_vencimento rp
    JOIN funcionario f ON f.id = rp.funcionario_id
    WHERE rp.empresa_id=$1
      AND rp.ano=$2
      AND rp.estado IN ('processado','pago','emitido')
      AND f.nif IS NOT NULL
    GROUP BY f.id, f.nome_completo, f.nif
    HAVING SUM(COALESCE(rp.irs_retido,0)) > 0
    ORDER BY f.nome_completo
  `, [eid, ano]);

  // Criar ou actualizar declaração
  const { rows:[emp] } = await query('SELECT * FROM empresa WHERE id=$1', [eid]);

  const totalRend = recibos.reduce((s,r) => s + parseFloat(r.rendimento_bruto||0), 0);
  const totalRet  = recibos.reduce((s,r) => s + parseFloat(r.retencao_irs||0), 0);

  const { rows:[decl] } = await query(`
    INSERT INTO modelo3_irs (empresa_id, ano, estado, total_rendimentos, total_retencoes, total_contribuintes)
    VALUES ($1,$2,'rascunho',$3,$4,$5)
    ON CONFLICT (empresa_id, ano) DO UPDATE SET
      total_rendimentos=$3, total_retencoes=$4, total_contribuintes=$5, estado='rascunho'
    RETURNING *
  `, [eid, ano, totalRend, totalRet, recibos.length]);

  // Limpar linhas anteriores e reinserir
  await query('DELETE FROM modelo3_linha WHERE modelo3_id=$1', [decl.id]);

  for (const r of recibos) {
    await query(`
      INSERT INTO modelo3_linha (modelo3_id, funcionario_id, nif_titular, nome_titular, ano_rendimento,
        codigo_rendimento, rendimento_bruto, retencao_irs, contribuicoes_ss)
      VALUES ($1,$2,$3,$4,$5,'A',$6,$7,$8)
    `, [decl.id, r.funcionario_id, r.nif, r.nome_completo, ano,
        r.rendimento_bruto, r.retencao_irs, r.contribuicoes_ss]);
  }

  res.json({ ...decl, linhas: recibos, empresa: emp });
});

// ── Obter declaração com linhas ───────────────────────────────────────────────
router.get('/:ano', async (req, res) => {
  const { rows:[decl] } = await query(
    'SELECT * FROM modelo3_irs WHERE empresa_id=$1 AND ano=$2',
    [req.empresaId, req.params.ano]
  );

  if (!decl) return res.status(404).json({ error: 'Declaração não encontrada. Clica em Gerar.' });

  const { rows: linhas } = await query(
    'SELECT * FROM modelo3_linha WHERE modelo3_id=$1 ORDER BY nome_titular',
    [decl.id]
  );

  const { rows:[emp] } = await query('SELECT * FROM empresa WHERE id=$1', [req.empresaId]);

  res.json({ ...decl, linhas, empresa: emp });
});

// ── Gerar XML para AT ─────────────────────────────────────────────────────────
router.get('/:ano/xml', async (req, res) => {
  const { rows:[decl] } = await query(
    'SELECT * FROM modelo3_irs WHERE empresa_id=$1 AND ano=$2',
    [req.empresaId, req.params.ano]
  );
  if (!decl) return res.status(404).json({ error: 'Declaração não encontrada' });

  const { rows: linhas } = await query(
    'SELECT * FROM modelo3_linha WHERE modelo3_id=$1 ORDER BY nome_titular',
    [decl.id]
  );
  const { rows:[emp] } = await query('SELECT * FROM empresa WHERE id=$1', [req.empresaId]);

  const ano = req.params.ano;

  // Quadro 7 — rendimentos do trabalho dependente (código A)
  const quadro7 = linhas.map((l, i) => `
      <Rend num="${i+1}">
        <CodRend>${l.codigo_rendimento||'A'}</CodRend>
        <NIF>${l.nif_titular}</NIF>
        <Titular>${(l.nome_titular||'').replace(/&/g,'&amp;').substring(0,60)}</Titular>
        <ValorRend>${parseFloat(l.rendimento_bruto||0).toFixed(2)}</ValorRend>
        <RetIRS>${parseFloat(l.retencao_irs||0).toFixed(2)}</RetIRS>
        <ContribSS>${parseFloat(l.contribuicoes_ss||0).toFixed(2)}</ContribSS>
        <QuotaSindical>0.00</QuotaSindical>
      </Rend>`).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Modelo 3 IRS — Declaração Anual de Retenções na Fonte -->
<!-- Ano: ${ano} | Gerado por NexEdge v4.0 em ${new Date().toISOString().split('T')[0]} -->
<!-- Submeter em: https://www.portaldasfinancas.gov.pt -->
<Declaracao xmlns="http://www.dgci.min-financas.pt/modelos/Mod3">
  <Identificacao>
    <NIF>${emp?.nif||''}</NIF>
    <Designacao>${(emp?.nome||'').replace(/&/g,'&amp;')}</Designacao>
    <Ano>${ano}</Ano>
    <TipoDecl>1</TipoDecl>
    <DataCriacao>${new Date().toISOString().split('T')[0]}</DataCriacao>
  </Identificacao>
  <Quadro7>
    <TotalRendimentos>${parseFloat(decl.total_rendimentos||0).toFixed(2)}</TotalRendimentos>
    <TotalRetencoes>${parseFloat(decl.total_retencoes||0).toFixed(2)}</TotalRetencoes>
    <NumTitulares>${linhas.length}</NumTitulares>
    <Rendimentos>${quadro7}
    </Rendimentos>
  </Quadro7>
</Declaracao>`;

  // Guardar XML na declaração
  await query('UPDATE modelo3_irs SET xml_gerado=$1 WHERE id=$2', [xml, decl.id]);

  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="Modelo3_IRS_${ano}_${emp?.nif||'empresa'}.xml"`);
  res.send(xml);
});

// ── Marcar como submetida ─────────────────────────────────────────────────────
router.patch('/:ano/submeter', async (req, res) => {
  const { numero_declaracao } = req.body;
  const { rows:[decl] } = await query(`
    UPDATE modelo3_irs SET estado='submetida', data_submissao=CURRENT_DATE, numero_declaracao=$1
    WHERE empresa_id=$2 AND ano=$3 RETURNING *
  `, [numero_declaracao||null, req.empresaId, req.params.ano]);
  res.json(decl);
});

// ── Resumo para simulador (sem gerar declaração) ──────────────────────────────
router.get('/simulador/:ano', async (req, res) => {
  const { rows } = await query(`
    SELECT
      f.nome_completo, f.nif, f.cargo,
      COUNT(rp.id) AS num_meses,
      SUM(rp.salario_base) AS total_base,
      SUM(COALESCE(rp.subsidio_alimentacao,0)) AS total_subsidio_alimentacao,
      SUM(rp.total_abonos) AS rendimento_bruto,
      SUM(COALESCE(rp.irs_retido,0)) AS retencao_irs,
      SUM(COALESCE(rp.seg_social_func,0)) AS contribuicoes_ss,
      SUM(rp.liquido) AS rendimento_liquido
    FROM recibo_vencimento rp
    JOIN funcionario f ON f.id = rp.funcionario_id
    WHERE rp.empresa_id=$1 AND rp.ano=$2 AND rp.estado IN ('processado','pago','emitido')
    GROUP BY f.id, f.nome_completo, f.nif, f.cargo
    ORDER BY f.nome_completo
  `, [req.empresaId, req.params.ano]);

  const totais = rows.reduce((acc, r) => ({
    rendimento_bruto:   acc.rendimento_bruto   + parseFloat(r.rendimento_bruto||0),
    retencao_irs:       acc.retencao_irs       + parseFloat(r.retencao_irs||0),
    contribuicoes_ss:   acc.contribuicoes_ss   + parseFloat(r.contribuicoes_ss||0),
    rendimento_liquido: acc.rendimento_liquido + parseFloat(r.rendimento_liquido||0),
  }), { rendimento_bruto:0, retencao_irs:0, contribuicoes_ss:0, rendimento_liquido:0 });

  res.json({ ano: req.params.ano, funcionarios: rows, totais });
});

module.exports = router;
