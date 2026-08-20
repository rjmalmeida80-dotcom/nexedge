// Rota PDF premium — substituir no salario.js
const PDF_ROUTE = `
router.get('/:id/pdf', async (req, res) => {
  const { query } = require('../config/database');
  const { rows } = await query(\`
    SELECT r.*, f.nome_completo, f.cargo, f.nif, f.iban, f.numero_funcionario,
           f.banco, f.num_cc, f.niss,
           e.nome AS empresa_nome, e.nif AS empresa_nif, e.morada AS empresa_morada,
           e.telefone AS empresa_telefone
    FROM recibo_vencimento r
    JOIN funcionario f ON f.id = r.funcionario_id
    JOIN empresa e ON e.id = r.empresa_id
    WHERE r.id = $1 AND r.empresa_id = $2
  \`, [req.params.id, req.empresaId]);

  if (!rows.length) return res.status(404).json({ error: 'Recibo não encontrado.' });
  const r = rows[0];
  
  const meses = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  const periodoLabel = \`\${meses[(r.mes||1)-1]} \${r.ano}\`;
  const fmt = (v) => parseFloat(v||0).toFixed(2).replace('.',',');
  const totalAbonos = parseFloat(r.total_abonos||0);
  const totalDescontos = parseFloat(r.total_descontos||0);
  const liquido = parseFloat(r.liquido||0);
  const custoEmpresa = totalAbonos + parseFloat(r.seg_social_entidade||0);

  const html = \`<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Recibo de Vencimento — \${r.nome_completo} — \${periodoLabel}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: 'Segoe UI', Arial, sans-serif; background:#F8FAFC; color:#111827; font-size:13px; }
  .page { max-width:820px; margin:0 auto; background:#fff; min-height:100vh; }

  /* Header */
  .header { background:linear-gradient(135deg,#0A0F1E 0%,#185FA5 100%); color:#fff; padding:32px 40px; display:flex; justify-content:space-between; align-items:flex-start; }
  .header-left h1 { font-size:28px; font-weight:800; letter-spacing:-0.5px; }
  .header-left h1 span { color:#1D9E75; }
  .header-left p { font-size:11px; color:#94a3b8; margin-top:4px; letter-spacing:2px; text-transform:uppercase; }
  .header-right { text-align:right; }
  .header-right .badge { background:rgba(29,158,117,0.2); border:1px solid #1D9E75; color:#1D9E75; padding:4px 12px; border-radius:20px; font-size:11px; font-weight:600; letter-spacing:1px; display:inline-block; margin-bottom:8px; }
  .header-right .periodo { font-size:20px; font-weight:700; color:#fff; }
  .header-right .data { font-size:11px; color:#94a3b8; }

  /* Info cards */
  .info-section { padding:0 40px; background:#fff; }
  .info-grid { display:grid; grid-template-columns:1fr 1fr; gap:0; border:1px solid #E5E7EB; border-radius:12px; overflow:hidden; margin:24px 0; }
  .info-card { padding:20px 24px; }
  .info-card:first-child { border-right:1px solid #E5E7EB; background:#F8FAFC; }
  .info-card h3 { font-size:10px; font-weight:700; color:#6B7280; text-transform:uppercase; letter-spacing:1.5px; margin-bottom:12px; }
  .info-row { display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px solid #F3F4F6; }
  .info-row:last-child { border:none; }
  .info-label { color:#6B7280; font-size:12px; }
  .info-value { font-weight:600; font-size:12px; color:#111827; }

  /* Tabela valores */
  .values-section { padding:0 40px 24px; }
  .values-grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
  .values-card { border:1px solid #E5E7EB; border-radius:12px; overflow:hidden; }
  .values-card-header { padding:12px 20px; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:1.5px; }
  .values-card.abonos .values-card-header { background:#ECFDF5; color:#1D9E75; border-bottom:1px solid #D1FAE5; }
  .values-card.descontos .values-card-header { background:#FEF2F2; color:#E24B4A; border-bottom:1px solid #FEE2E2; }
  .values-row { display:flex; justify-content:space-between; padding:10px 20px; border-bottom:1px solid #F9FAFB; font-size:12px; }
  .values-row:last-child { border:none; }
  .values-row .label { color:#374151; }
  .values-row .amount { font-weight:600; }
  .values-row.total { background:#F9FAFB; font-weight:700; }
  .values-card.abonos .total .amount { color:#1D9E75; font-size:13px; }
  .values-card.descontos .total .amount { color:#E24B4A; font-size:13px; }

  /* Líquido */
  .liquido-section { margin:0 40px 24px; background:linear-gradient(135deg,#185FA5,#0A0F1E); border-radius:12px; padding:24px 32px; display:flex; justify-content:space-between; align-items:center; color:#fff; }
  .liquido-label { font-size:13px; color:#94a3b8; margin-bottom:4px; }
  .liquido-value { font-size:36px; font-weight:800; letter-spacing:-1px; }
  .liquido-sub { font-size:11px; color:#64748b; margin-top:4px; }
  .liquido-right { text-align:right; }
  .custo-label { font-size:11px; color:#64748b; margin-bottom:2px; }
  .custo-value { font-size:20px; font-weight:700; color:#fff; }

  /* Acumulados */
  .acc-section { margin:0 40px 24px; }
  .acc-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; }
  .acc-card { background:#F8FAFC; border:1px solid #E5E7EB; border-radius:10px; padding:14px 18px; text-align:center; }
  .acc-card .acc-label { font-size:10px; color:#6B7280; text-transform:uppercase; letter-spacing:1px; margin-bottom:6px; }
  .acc-card .acc-value { font-size:17px; font-weight:700; color:#185FA5; }

  /* Pagamento */
  .pagamento-section { margin:0 40px 32px; background:#F0FDF4; border:1px solid #D1FAE5; border-radius:12px; padding:16px 24px; display:flex; align-items:center; gap:16px; }
  .pagamento-icon { width:40px; height:40px; background:#1D9E75; border-radius:10px; display:flex; align-items:center; justify-content:center; flex-shrink:0; font-size:18px; }
  .pagamento-label { font-size:11px; color:#6B7280; margin-bottom:2px; }
  .pagamento-value { font-size:13px; font-weight:700; color:#111827; }

  /* Footer */
  .footer { background:#F8FAFC; border-top:1px solid #E5E7EB; padding:16px 40px; display:flex; justify-content:space-between; align-items:center; }
  .footer-left { font-size:10px; color:#9CA3AF; }
  .footer-right { font-size:10px; color:#9CA3AF; }

  @media print {
    body { background:#fff; }
    .page { box-shadow:none; }
    @page { margin:0; }
  }
</style>
</head>
<body>
<div class="page">

  <!-- Header -->
  <div class="header">
    <div class="header-left">
      <h1>Nex<span>HR</span></h1>
      <p>Recibo de Vencimento</p>
    </div>
    <div class="header-right">
      <div class="badge">✓ PROCESSADO</div>
      <div class="periodo">\${periodoLabel}</div>
      <div class="data">Emitido em \${new Date().toLocaleDateString('pt-PT')}</div>
    </div>
  </div>

  <div class="info-section">
    <div class="info-grid">
      <!-- Colaborador -->
      <div class="info-card">
        <h3>Colaborador</h3>
        <div class="info-row"><span class="info-label">Nome</span><span class="info-value">\${r.nome_completo}</span></div>
        <div class="info-row"><span class="info-label">Nº Funcionário</span><span class="info-value">\${r.numero_funcionario||'—'}</span></div>
        <div class="info-row"><span class="info-label">Cargo</span><span class="info-value">\${r.cargo}</span></div>
        <div class="info-row"><span class="info-label">NIF</span><span class="info-value">\${r.nif||'—'}</span></div>
        <div class="info-row"><span class="info-label">NISS</span><span class="info-value">\${r.niss||'—'}</span></div>
      </div>
      <!-- Empresa -->
      <div class="info-card">
        <h3>Entidade Patronal</h3>
        <div class="info-row"><span class="info-label">Empresa</span><span class="info-value">\${r.empresa_nome}</span></div>
        <div class="info-row"><span class="info-label">NIF</span><span class="info-value">\${r.empresa_nif||'—'}</span></div>
        <div class="info-row"><span class="info-label">Morada</span><span class="info-value">\${r.empresa_morada||'—'}</span></div>
        <div class="info-row"><span class="info-label">Período</span><span class="info-value">\${periodoLabel}</span></div>
        <div class="info-row"><span class="info-label">Estado</span><span class="info-value" style="color:#1D9E75">✓ Processado</span></div>
      </div>
    </div>
  </div>

  <!-- Abonos e Descontos -->
  <div class="values-section">
    <div class="values-grid">
      <!-- Abonos -->
      <div class="values-card abonos">
        <div class="values-card-header">▲ Abonos</div>
        <div class="values-row"><span class="label">Salário Base</span><span class="amount">\${fmt(r.salario_base)} €</span></div>
        \${parseFloat(r.subsidio_alimentacao||0)>0?'<div class="values-row"><span class="label">Subsídio Alimentação</span><span class="amount">'+fmt(r.subsidio_alimentacao)+' €</span></div>':''}
        \${parseFloat(r.horas_extra_valor||0)>0?'<div class="values-row"><span class="label">Horas Extraordinárias</span><span class="amount">'+fmt(r.horas_extra_valor)+' €</span></div>':''}
        \${parseFloat(r.subsidio_ferias||0)>0?'<div class="values-row" style="background:#F0FDF4"><span class="label">🏖 Subsídio de Férias</span><span class="amount" style="color:#1D9E75">'+fmt(r.subsidio_ferias)+' €</span></div>':''}
        \${parseFloat(r.subsidio_natal||0)>0?'<div class="values-row" style="background:#F0FDF4"><span class="label">🎄 Subsídio de Natal</span><span class="amount" style="color:#1D9E75">'+fmt(r.subsidio_natal)+' €</span></div>':''}
        <div class="values-row total"><span class="label">Total Abonos</span><span class="amount">\${fmt(totalAbonos)} €</span></div>
      </div>
      <!-- Descontos -->
      <div class="values-card descontos">
        <div class="values-card-header">▼ Descontos</div>
        <div class="values-row"><span class="label">IRS Retido</span><span class="amount" style="color:#E24B4A">-\${fmt(r.irs_retido)} €</span></div>
        <div class="values-row"><span class="label">Segurança Social (11%)</span><span class="amount" style="color:#E24B4A">-\${fmt(r.seg_social_func)} €</span></div>
        \${parseFloat(r.outros_descontos||0)>0?'<div class="values-row"><span class="label">Outros Descontos</span><span class="amount" style="color:#E24B4A">-'+fmt(r.outros_descontos)+' €</span></div>':''}
        <div class="values-row total"><span class="label">Total Descontos</span><span class="amount">-\${fmt(totalDescontos)} €</span></div>
      </div>
    </div>
  </div>

  <!-- Valor líquido -->
  <div class="liquido-section">
    <div>
      <div class="liquido-label">Valor Líquido a Receber</div>
      <div class="liquido-value">\${fmt(liquido)} €</div>
      <div class="liquido-sub">Referente a \${periodoLabel}</div>
    </div>
    <div class="liquido-right">
      <div class="custo-label">Custo Total para a Empresa</div>
      <div class="custo-value">\${fmt(custoEmpresa)} €</div>
      <div class="custo-label" style="margin-top:4px">SS Entidade: \${fmt(r.seg_social_entidade)} €</div>
    </div>
  </div>

  <!-- Acumulados do ano -->
  <div class="acc-section">
    <div class="acc-grid">
      <div class="acc-card">
        <div class="acc-label">Acum. IRS</div>
        <div class="acc-value">\${fmt(parseFloat(r.irs_retido||0) * (r.mes||1))} €</div>
      </div>
      <div class="acc-card">
        <div class="acc-label">Acum. SS</div>
        <div class="acc-value">\${fmt(parseFloat(r.seg_social_func||0) * (r.mes||1))} €</div>
      </div>
      <div class="acc-card">
        <div class="acc-label">Acum. Líquido</div>
        <div class="acc-value">\${fmt(parseFloat(r.liquido||0) * (r.mes||1))} €</div>
      </div>
    </div>
  </div>

  <!-- Pagamento -->
  \${r.iban ? \`
  <div class="pagamento-section">
    <div class="pagamento-icon">🏦</div>
    <div>
      <div class="pagamento-label">Transferência Bancária</div>
      <div class="pagamento-value">\${r.iban}</div>
      \${r.banco ? '<div class="pagamento-label" style="margin-top:2px">'+r.banco+'</div>' : ''}
    </div>
  </div>\` : ''}

  <!-- Footer -->
  <div class="footer">
    <div class="footer-left">
      NexEdge — Plataforma de Gestão de Recursos Humanos · Portugal<br>
      Documento gerado em \${new Date().toLocaleDateString('pt-PT')} às \${new Date().toLocaleTimeString('pt-PT')}
    </div>
    <div class="footer-right">
      Nº Funcionário: \${r.numero_funcionario||'—'}<br>
      \${r.nome_completo} · \${periodoLabel}
    </div>
  </div>

</div>
<script>
  // Auto-print ao abrir
  window.onload = function() {
    // Pequeno delay para garantir que os estilos carregam
    setTimeout(() => window.print(), 500);
  }
</script>
</body>
</html>\`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});
`;
console.log('Template criado');
