'use strict';
const router = require('express').Router();
const { autenticar, autorizar } = require('../middleware/auth');
const { query } = require('../config/database');

const RH = ['admin_empresa', 'rh', 'diretor'];
router.use(autenticar, autorizar(...RH));

// Meses em português
const MESES = ['','Janeiro','Fevereiro','Março','Abril','Maio','Junho',
  'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

// ── Listar DMRs ───────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const { rows } = await query(`
    SELECT d.*, u.nome_completo AS submetido_por_nome
    FROM dmr d
    LEFT JOIN utilizador u ON u.id = d.submetido_por
    WHERE d.empresa_id = $1
    ORDER BY d.ano DESC, d.mes DESC
  `, [req.empresaId]);
  res.json(rows);
});

// ── Dados para gerar DMR de um mês ───────────────────────────────────────────
router.get('/dados/:ano/:mes', async (req, res) => {
  const { ano, mes } = req.params;
  const eid = req.empresaId;

  const { rows: emp } = await query(`SELECT * FROM empresa WHERE id=$1`, [eid]);
  if (!emp.length) return res.status(404).json({ error: 'Empresa não encontrada' });

  // Recibos processados do mês
  const { rows: recibos } = await query(`
    SELECT
      f.nome_completo, f.nif, f.niss, f.numero_funcionario,
      f.tipo_contrato, f.data_admissao, f.data_fim_contrato,
      r.salario_base, r.subsidio_alimentacao, r.horas_extra_valor,
      r.outros_abonos, r.total_abonos, r.irs_retido,
      r.seg_social_func, r.seg_social_entidade, r.liquido,
      r.faltas_desconto, r.outros_descontos, r.total_descontos
    FROM recibo_vencimento r
    JOIN funcionario f ON f.id = r.funcionario_id
    WHERE r.empresa_id = $1 AND r.ano = $2 AND r.mes = $3
      AND r.estado = 'processado'
    ORDER BY f.nome_completo
  `, [eid, ano, mes]);

  const totalRemuneracoes = recibos.reduce((s, r) => s + parseFloat(r.total_abonos || 0), 0);
  const totalIRS = recibos.reduce((s, r) => s + parseFloat(r.irs_retido || 0), 0);
  const totalSS = recibos.reduce((s, r) => s + parseFloat(r.seg_social_func || 0) + parseFloat(r.seg_social_entidade || 0), 0);

  res.json({
    empresa: emp[0],
    periodo: { ano: parseInt(ano), mes: parseInt(mes), mes_nome: MESES[parseInt(mes)] },
    recibos,
    totais: {
      num_declarantes: recibos.length,
      total_remuneracoes: totalRemuneracoes.toFixed(2),
      total_irs: totalIRS.toFixed(2),
      total_ss: totalSS.toFixed(2),
    },
    prazo: `Até dia 10 de ${MESES[parseInt(mes) === 12 ? 1 : parseInt(mes)+1]} ${parseInt(mes) === 12 ? parseInt(ano)+1 : ano}`,
    avisos: recibos.filter(r => !r.nif).map(r => `${r.nome_completo} — NIF em falta`),
  });
});

// ── Gerar XML DMR (formato AT) ────────────────────────────────────────────────
router.get('/xml/:ano/:mes', async (req, res) => {
  const { ano, mes } = req.params;
  const eid = req.empresaId;

  const { rows: [emp] } = await query(`SELECT * FROM empresa WHERE id=$1`, [eid]);
  const { rows: recibos } = await query(`
    SELECT f.nif, f.nome_completo, f.niss, f.tipo_contrato,
      r.salario_base, r.total_abonos, r.irs_retido, r.outros_abonos
    FROM recibo_vencimento r
    JOIN funcionario f ON f.id = r.funcionario_id
    WHERE r.empresa_id=$1 AND r.ano=$2 AND r.mes=$3 AND r.estado='processado'
    ORDER BY f.nome_completo
  `, [eid, ano, mes]);

  const mesStr = String(mes).padStart(2, '0');
  const totalRem = recibos.reduce((s,r) => s + parseFloat(r.total_abonos||0), 0);
  const totalIRS = recibos.reduce((s,r) => s + parseFloat(r.irs_retido||0), 0);

  const linhasXML = recibos.map((r, i) => `
    <Declarante>
      <NumOrdem>${String(i+1).padStart(4,'0')}</NumOrdem>
      <NIF>${r.nif || '000000000'}</NIF>
      <Nome>${(r.nome_completo||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</Nome>
      <RendimentoCodigo>A</RendimentoCodigo>
      <Rendimento>${parseFloat(r.total_abonos||0).toFixed(2)}</Rendimento>
      <Retencao>${parseFloat(r.irs_retido||0).toFixed(2)}</Retencao>
      <ContribuicoesObrigatorias>${parseFloat(r.salario_base||0 * 0.11).toFixed(2)}</ContribuicoesObrigatorias>
    </Declarante>`).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!-- DMR — Declaração Mensal de Remunerações -->
<!-- Período: ${ano}-${mesStr} | Gerado por NexEdge v4.0 -->
<!-- NOTA: Validar e submeter em https://www.portaldasfinancas.gov.pt -->
<DMR xmlns="http://www.portaldasfinancas.gov.pt/dmr/schema"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Cabecalho>
    <NIF_Declarante>${emp?.nif || '000000000'}</NIF_Declarante>
    <Nome_Declarante>${(emp?.nome||'').replace(/&/g,'&amp;')}</Nome_Declarante>
    <Periodo>${ano}${mesStr}</Periodo>
    <NumDeclarantes>${recibos.length}</NumDeclarantes>
    <TotalRendimentos>${totalRem.toFixed(2)}</TotalRendimentos>
    <TotalRetencoes>${totalIRS.toFixed(2)}</TotalRetencoes>
    <DataGeracao>${new Date().toISOString().split('T')[0]}</DataGeracao>
  </Cabecalho>
  <Declarantes>${linhasXML}
  </Declarantes>
</DMR>`;

  // Guardar estado
  await query(`
    INSERT INTO dmr (empresa_id, ano, mes, estado, num_declarantes, total_remuneracoes, total_irs, xml_gerado)
    VALUES ($1,$2,$3,'gerado',$4,$5,$6,$7)
    ON CONFLICT (empresa_id, ano, mes)
    DO UPDATE SET estado='gerado', num_declarantes=$4, total_remuneracoes=$5, total_irs=$6, xml_gerado=$7
  `, [eid, ano, mes, recibos.length, totalRem, totalIRS, xml]);

  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="DMR_${ano}${mesStr}_${emp?.nif||'empresa'}.xml"`);
  res.send(xml);
});

// ── Gerar XML DRI (Segurança Social) ─────────────────────────────────────────
router.get('/dri/:ano/:mes', async (req, res) => {
  const { ano, mes } = req.params;
  const eid = req.empresaId;

  const { rows: [emp] } = await query(`SELECT * FROM empresa WHERE id=$1`, [eid]);
  const { rows: recibos } = await query(`
    SELECT f.nif, f.niss, f.nome_completo, f.tipo_contrato, f.data_admissao,
      r.salario_base, r.total_abonos, r.seg_social_func, r.seg_social_entidade,
      r.horas_extra_valor
    FROM recibo_vencimento r
    JOIN funcionario f ON f.id = r.funcionario_id
    WHERE r.empresa_id=$1 AND r.ano=$2 AND r.mes=$3 AND r.estado='processado'
    ORDER BY f.nome_completo
  `, [eid, ano, mes]);

  const mesStr = String(mes).padStart(2, '0');
  const totalRem = recibos.reduce((s,r) => s + parseFloat(r.total_abonos||0), 0);
  const totalCF = recibos.reduce((s,r) => s + parseFloat(r.seg_social_func||0), 0);
  const totalCE = recibos.reduce((s,r) => s + parseFloat(r.seg_social_entidade||0), 0);

  // Código de regime SS por tipo de contrato
  function regimeSS(tipo) {
    if (tipo === 'estagio') return '301';
    if (tipo === 'part_time') return '201';
    return '101'; // regime geral
  }

  const linhas = recibos.map((r, i) => `
    <Trabalhador>
      <NumOrdem>${String(i+1).padStart(6,'0')}</NumOrdem>
      <NISS>${r.niss || ''}</NISS>
      <NIF>${r.nif || ''}</NIF>
      <Nome>${(r.nome_completo||'').replace(/&/g,'&amp;').replace(/</g,'&lt;')}</Nome>
      <CodRegime>${regimeSS(r.tipo_contrato)}</CodRegime>
      <Remuneracao>${parseFloat(r.total_abonos||0).toFixed(2)}</Remuneracao>
      <DiasDeclarados>30</DiasDeclarados>
      <ContribuicaoTrabalhador>${parseFloat(r.seg_social_func||0).toFixed(2)}</ContribuicaoTrabalhador>
      <ContribuicaoEntidade>${parseFloat(r.seg_social_entidade||0).toFixed(2)}</ContribuicaoEntidade>
    </Trabalhador>`).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!-- DRI — Declaração de Remunerações à Segurança Social -->
<!-- Período: ${ano}-${mesStr} | Gerado por NexEdge v4.0 -->
<!-- NOTA: Submeter em https://app.seg-social.pt -->
<DRI xmlns="http://www.seg-social.pt/dri/schema">
  <Cabecalho>
    <NISS_Entidade>${emp?.niss_empresa || ''}</NISS_Entidade>
    <NIF_Entidade>${emp?.nif || ''}</NIF_Entidade>
    <Nome_Entidade>${(emp?.nome||'').replace(/&/g,'&amp;')}</Nome_Entidade>
    <Periodo>${ano}${mesStr}</Periodo>
    <NumTrabalhadores>${recibos.length}</NumTrabalhadores>
    <TotalRemuneracoes>${totalRem.toFixed(2)}</TotalRemuneracoes>
    <TotalContribuicoesTrabalhadores>${totalCF.toFixed(2)}</TotalContribuicoesTrabalhadores>
    <TotalContribuicoesEntidade>${totalCE.toFixed(2)}</TotalContribuicoesEntidade>
    <TotalContribuicoes>${(totalCF + totalCE).toFixed(2)}</TotalContribuicoes>
    <DataGeracao>${new Date().toISOString().split('T')[0]}</DataGeracao>
  </Cabecalho>
  <Trabalhadores>${linhas}
  </Trabalhadores>
</DRI>`;

  // Guardar estado
  await query(`
    INSERT INTO dri (empresa_id, ano, mes, estado, num_trabalhadores, total_remuneracoes, total_contrib_func, total_contrib_ent, xml_gerado)
    VALUES ($1,$2,$3,'gerado',$4,$5,$6,$7,$8)
    ON CONFLICT (empresa_id, ano, mes)
    DO UPDATE SET estado='gerado', num_trabalhadores=$4, total_remuneracoes=$5, total_contrib_func=$6, total_contrib_ent=$7, xml_gerado=$8
  `, [eid, ano, mes, recibos.length, totalRem, totalCF, totalCE, xml]);

  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="DRI_${ano}${mesStr}_${emp?.nif||'empresa'}.xml"`);
  res.send(xml);
});

// ── Marcar como submetido ─────────────────────────────────────────────────────
router.patch('/:tipo/:ano/:mes/submeter', async (req, res) => {
  const { tipo, ano, mes } = req.params;
  const tabela = tipo === 'dri' ? 'dri' : 'dmr';
  await query(`
    UPDATE ${tabela} SET estado='submetido', submetido_em=NOW(), submetido_por=$1
    WHERE empresa_id=$2 AND ano=$3 AND mes=$4
  `, [req.utilizador.id, req.empresaId, ano, mes]);
  res.json({ ok: true });
});

module.exports = router;
