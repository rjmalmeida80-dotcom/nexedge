'use strict';
const router = require('express').Router();
const { autenticar, autorizar } = require('../middleware/auth');
const { middlewareAuditoria }   = require('../middleware/auditoria');
const { query } = require('../config/database');
const { criarErro } = require('../middleware/errorHandler');

router.use(autenticar, middlewareAuditoria);

// ── LISTAR APROVAÇÕES ─────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const { rows } = await query(`
    SELECT ap.*,
           u1.nome_completo AS aprovador1_nome,
           u2.nome_completo AS aprovador2_nome,
           ur.nome_completo AS rejeitado_por_nome
    FROM aprovacao_pagamento ap
    LEFT JOIN utilizador u1 ON u1.id = ap.aprovado1_por
    LEFT JOIN utilizador u2 ON u2.id = ap.aprovado2_por
    LEFT JOIN utilizador ur ON ur.id = ap.rejeitado_por
    WHERE ap.empresa_id = $1
    ORDER BY ap.ano DESC, ap.mes DESC
  `, [req.empresaId]);
  res.json(rows);
});

// ── SUBMETER PARA APROVAÇÃO ────────────────────────────────────────────────
router.post('/submeter', autorizar('admin_empresa','rh'), async (req, res) => {
  const { ano, mes } = req.body;
  if (!ano || !mes) throw criarErro('Ano e mês são obrigatórios.', 400);

  // Calcular totais dos recibos processados
  const { rows: totais } = await query(`
    SELECT COUNT(*) AS num_funcionarios,
           SUM(total_abonos) AS total_bruto,
           SUM(liquido) AS total_liquido
    FROM recibo_vencimento
    WHERE empresa_id=$1 AND ano=$2 AND mes=$3 AND estado='processado'
  `, [req.empresaId, ano, mes]);

  if (!totais[0] || parseInt(totais[0].num_funcionarios) === 0) {
    throw criarErro('Não há salários processados para este período.', 400);
  }

  const { rows: [ap] } = await query(`
    INSERT INTO aprovacao_pagamento
      (empresa_id, ano, mes, total_bruto, total_liquido, num_funcionarios, estado)
    VALUES ($1,$2,$3,$4,$5,$6,'aguarda_aprovacao1')
    ON CONFLICT (empresa_id, ano, mes) DO UPDATE SET
      estado='aguarda_aprovacao1',
      total_bruto=EXCLUDED.total_bruto,
      total_liquido=EXCLUDED.total_liquido,
      num_funcionarios=EXCLUDED.num_funcionarios
    RETURNING *
  `, [req.empresaId, ano, mes, totais[0].total_bruto, totais[0].total_liquido, totais[0].num_funcionarios]);

  await req.auditar({ acao: 'PAGAMENTO_SUBMETIDO', tabela: 'aprovacao_pagamento', registoId: ap.id });
  res.status(201).json(ap);
});

// ── APROVAR NÍVEL 1 ────────────────────────────────────────────────────────
router.patch('/:id/aprovar1', autorizar('diretor','admin_empresa'), async (req, res) => {
  const { notas } = req.body;
  const { rows: [ap] } = await query(`
    SELECT * FROM aprovacao_pagamento WHERE id=$1 AND empresa_id=$2
  `, [req.params.id, req.empresaId]);
  if (!ap) throw criarErro('Aprovação não encontrada.', 404);
  if (ap.estado !== 'aguarda_aprovacao1') throw criarErro('Este pagamento não está pendente de aprovação de nível 1.', 400);

  // Verificar se precisa de aprovação 2 (acima do limite configurado)
  const { rows: [emp] } = await query('SELECT aprovacao_limite_nivel1 FROM empresa WHERE id=$1', [req.empresaId]);
  const limite = parseFloat(emp?.aprovacao_limite_nivel1 || 0);
  const novoEstado = (limite > 0 && parseFloat(ap.total_liquido) > limite)
    ? 'aguarda_aprovacao2' : 'aprovado';

  const { rows: [updated] } = await query(`
    UPDATE aprovacao_pagamento
    SET estado=$1, aprovado1_por=$2, aprovado1_em=NOW(), aprovado1_notas=$3
    WHERE id=$4 RETURNING *
  `, [novoEstado, req.utilizador.id, notas||null, req.params.id]);

  await req.auditar({ acao: 'PAGAMENTO_APROVADO_N1', tabela: 'aprovacao_pagamento', registoId: ap.id });
  res.json(updated);
});

// ── APROVAR NÍVEL 2 ────────────────────────────────────────────────────────
router.patch('/:id/aprovar2', autorizar('admin_empresa'), async (req, res) => {
  const { notas } = req.body;
  const { rows: [ap] } = await query(`
    SELECT * FROM aprovacao_pagamento WHERE id=$1 AND empresa_id=$2
  `, [req.params.id, req.empresaId]);
  if (!ap) throw criarErro('Aprovação não encontrada.', 404);
  if (ap.estado !== 'aguarda_aprovacao2') throw criarErro('Este pagamento não está pendente de aprovação de nível 2.', 400);

  const { rows: [updated] } = await query(`
    UPDATE aprovacao_pagamento
    SET estado='aprovado', aprovado2_por=$1, aprovado2_em=NOW(), aprovado2_notas=$2
    WHERE id=$3 RETURNING *
  `, [req.utilizador.id, notas||null, req.params.id]);

  await req.auditar({ acao: 'PAGAMENTO_APROVADO_N2', tabela: 'aprovacao_pagamento', registoId: ap.id });
  res.json(updated);
});

// ── REJEITAR ──────────────────────────────────────────────────────────────
router.patch('/:id/rejeitar', autorizar('diretor','admin_empresa'), async (req, res) => {
  const { motivo } = req.body;
  if (!motivo) throw criarErro('Motivo de rejeição é obrigatório.', 400);
  const { rows: [updated] } = await query(`
    UPDATE aprovacao_pagamento
    SET estado='rejeitado', rejeitado_por=$1, rejeitado_em=NOW(), motivo_rejeicao=$2
    WHERE id=$3 AND empresa_id=$4 RETURNING *
  `, [req.utilizador.id, motivo, req.params.id, req.empresaId]);
  if (!updated) throw criarErro('Aprovação não encontrada.', 404);
  await req.auditar({ acao: 'PAGAMENTO_REJEITADO', tabela: 'aprovacao_pagamento', registoId: req.params.id });
  res.json(updated);
});

// ── GERAR FICHEIRO SEPA XML ────────────────────────────────────────────────
router.get('/:id/sepa', async (req, res) => {
  const { rows: [ap] } = await query(`
    SELECT ap.*, e.nome AS empresa_nome, e.nif AS empresa_nif,
           e.iban_empresa, e.bic_empresa, e.banco_empresa
    FROM aprovacao_pagamento ap
    JOIN empresa e ON e.id = ap.empresa_id
    WHERE ap.id=$1 AND ap.empresa_id=$2
  `, [req.params.id, req.empresaId]);

  if (!ap) throw criarErro('Aprovação não encontrada.', 404);
  if (ap.estado !== 'aprovado') throw criarErro('Pagamento ainda não foi aprovado.', 403);

  // Buscar recibos do período
  const { rows: recibos } = await query(`
    SELECT r.liquido, r.mes, r.ano,
           f.nome_completo, f.iban, f.nif
    FROM recibo_vencimento r
    JOIN funcionario f ON f.id = r.funcionario_id
    WHERE r.empresa_id=$1 AND r.ano=$2 AND r.mes=$3
      AND r.estado='processado' AND f.iban IS NOT NULL AND f.iban != ''
    ORDER BY f.nome_completo
  `, [req.empresaId, ap.ano, ap.mes]);

  const meses = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                 'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  const mesNome = meses[ap.mes - 1];
  const msgId   = `NEXHR-${ap.ano}${String(ap.mes).padStart(2,'0')}-${Date.now()}`;
  const dtExec  = new Date().toISOString().split('T')[0];
  const total   = recibos.reduce((s, r) => s + parseFloat(r.liquido), 0).toFixed(2);
  const ibanEmp = (ap.iban_empresa || '').replace(/\s/g, '');
  const bicEmp  = ap.bic_empresa || 'CGDIPTPL';

  const txs = recibos.map((r, i) => {
    const iban = r.iban.replace(/\s/g, '');
    const val  = parseFloat(r.liquido).toFixed(2);
    return `    <CdtTrfTxInf>
      <PmtId>
        <EndToEndId>${msgId}-${String(i+1).padStart(4,'0')}</EndToEndId>
      </PmtId>
      <Amt>
        <InstdAmt Ccy="EUR">${val}</InstdAmt>
      </Amt>
      <CdtrAgt>
        <FinInstnId>
          <BIC>${bicEmp}</BIC>
        </FinInstnId>
      </CdtrAgt>
      <Cdtr>
        <Nm>${r.nome_completo}</Nm>
      </Cdtr>
      <CdtrAcct>
        <Id>
          <IBAN>${iban}</IBAN>
        </Id>
      </CdtrAcct>
      <RmtInf>
        <Ustrd>Vencimento ${mesNome} ${ap.ano} - NIF ${r.nif}</Ustrd>
      </RmtInf>
    </CdtTrfTxInf>`;
  }).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03"
          xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <CstmrCdtTrfInitn>
    <GrpHdr>
      <MsgId>${msgId}</MsgId>
      <CreDtTm>${new Date().toISOString().replace(/\..+/,'')}</CreDtTm>
      <NbOfTxs>${recibos.length}</NbOfTxs>
      <CtrlSum>${total}</CtrlSum>
      <InitgPty>
        <Nm>${ap.empresa_nome}</Nm>
        <Id>
          <OrgId>
            <Othr>
              <Id>${ap.empresa_nif}</Id>
            </Othr>
          </OrgId>
        </Id>
      </InitgPty>
    </GrpHdr>
    <PmtInf>
      <PmtInfId>${msgId}-001</PmtInfId>
      <PmtMtd>TRF</PmtMtd>
      <NbOfTxs>${recibos.length}</NbOfTxs>
      <CtrlSum>${total}</CtrlSum>
      <PmtTpInf>
        <SvcLvl>
          <Cd>SEPA</Cd>
        </SvcLvl>
      </PmtTpInf>
      <ReqdExctnDt>${dtExec}</ReqdExctnDt>
      <Dbtr>
        <Nm>${ap.empresa_nome}</Nm>
      </Dbtr>
      <DbtrAcct>
        <Id>
          <IBAN>${ibanEmp}</IBAN>
        </Id>
      </DbtrAcct>
      <DbtrAgt>
        <FinInstnId>
          <BIC>${bicEmp}</BIC>
        </FinInstnId>
      </DbtrAgt>
${txs}
    </PmtInf>
  </CstmrCdtTrfInitn>
</Document>`;

  // Marcar como gerado
  await query(`UPDATE aprovacao_pagamento SET sepa_gerado=true, sepa_gerado_em=NOW() WHERE id=$1`, [req.params.id]);
  await req.auditar({ acao: 'SEPA_GERADO', tabela: 'aprovacao_pagamento', registoId: req.params.id });

  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="SEPA_Salarios_${ap.ano}${String(ap.mes).padStart(2,'0')}.xml"`);
  res.send(xml);
});

module.exports = router;
