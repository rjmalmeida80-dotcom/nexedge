'use strict';
/**
 * NexEdge — Open Banking PSD2
 * Ligação directa a bancos PT: CGD, BPI, Millennium, Santander, Novobanco
 * Importação de extractos, categorização automática, reconciliação
 */

const express = require('express');
const router = express.Router();
const { query, transaction } = require('../config/database');
const { autenticar } = require('../middleware/auth');

router.use(autenticar);

const BANCOS_SUPORTADOS = {
  cgd:         { nome: 'Caixa Geral de Depósitos', pais: 'PT', bic: 'CGDIPTPL' },
  bpi:         { nome: 'Banco BPI', pais: 'PT', bic: 'BBPIPTPL' },
  millennium:  { nome: 'Millennium BCP', pais: 'PT', bic: 'BCOMPTPL' },
  santander:   { nome: 'Santander Portugal', pais: 'PT', bic: 'BSCHPTPL' },
  novobanco:   { nome: 'Novo Banco', pais: 'PT', bic: 'ESEFPTPL' },
  abanca:      { nome: 'Abanca', pais: 'PT', bic: 'CAGLESMMXXX' },
  montepio:    { nome: 'Montepio', pais: 'PT', bic: 'MPIOPTPL' },
};

// Categorização automática por descritivo
const CATEGORIAS = [
  { keywords: ['salario','salário','vencimento','ordenado'], categoria: 'Recursos Humanos', tipo: 'credito' },
  { keywords: ['fatura','factura','invoice'], categoria: 'Faturação', tipo: 'credito' },
  { keywords: ['irs','irc','iva','at-','finanças','at '], categoria: 'Impostos', tipo: 'debito' },
  { keywords: ['ss ','segurança social','seg social'], categoria: 'Segurança Social', tipo: 'debito' },
  { keywords: ['renda','arrendamento','aluguer'], categoria: 'Instalações', tipo: 'debito' },
  { keywords: ['electricidade','enel','edp','gás','água','saneamento'], categoria: 'Utilities', tipo: 'debito' },
  { keywords: ['telefon','tmn','nos ','vodafone','meo ','internet'], categoria: 'Comunicações', tipo: 'debito' },
  { keywords: ['seguro','seguros','fidelidade','allianz','zurich'], categoria: 'Seguros', tipo: 'debito' },
  { keywords: ['fornecedor','supplier','compra'], categoria: 'Fornecedores', tipo: 'debito' },
  { keywords: ['combustivel','combustível','galp','bp ','repsol'], categoria: 'Frota', tipo: 'debito' },
  { keywords: ['restaurante','cafe','café','alimentação','supermercado'], categoria: 'Alimentação', tipo: 'debito' },
  { keywords: ['transferência','transfer','mbway','multibanco'], categoria: 'Transferências', tipo: 'ambos' },
];

function categorizarMovimento(descricao) {
  const desc = (descricao||'').toLowerCase();
  for (const cat of CATEGORIAS) {
    if (cat.keywords.some(k => desc.includes(k))) {
      return cat.categoria;
    }
  }
  return 'Outros';
}

// ── CONTAS BANCÁRIAS ──

router.get('/contas', async (req, res) => {
  try {
    const r = await query(`
      SELECT cb.*,
        (SELECT COUNT(*) FROM extrato_bancario WHERE conta_id=cb.id) as num_movimentos,
        (SELECT MAX(data) FROM extrato_bancario WHERE conta_id=cb.id) as ultimo_movimento
      FROM conta_bancaria cb
      WHERE cb.empresa_id=$1 ORDER BY cb.criado_em DESC
    `, [req.empresaId]).catch(() => ({ rows: [] }));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/contas', async (req, res) => {
  try {
    const { banco, iban, nome, saldo_inicial, moeda } = req.body;
    if (!iban) return res.status(400).json({ error: 'IBAN obrigatório' });

    // Validar IBAN PT
    const ibanLimpo = iban.replace(/\s/g,'').toUpperCase();
    if (!ibanLimpo.startsWith('PT50') || ibanLimpo.length !== 25) {
      return res.status(400).json({ error: 'IBAN inválido — formato PT50 + 21 dígitos' });
    }

    const r = await query(`
      INSERT INTO conta_bancaria (empresa_id, banco, iban, nome, saldo_actual, moeda, ativo)
      VALUES ($1,$2,$3,$4,$5,$6,true)
      ON CONFLICT (empresa_id, iban) DO UPDATE SET nome=$4, banco=$2
      RETURNING *
    `, [req.empresaId, banco||'outro', ibanLimpo, nome||banco, parseFloat(saldo_inicial||0), moeda||'EUR']);
    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/contas/:id', async (req, res) => {
  try {
    const { nome, saldo_actual, ativo } = req.body;
    await query(`UPDATE conta_bancaria SET nome=COALESCE($1,nome), saldo_actual=COALESCE($2,saldo_actual), ativo=COALESCE($3,ativo) WHERE id=$4 AND empresa_id=$5`,
      [nome||null, saldo_actual!==undefined?saldo_actual:null, ativo!==undefined?ativo:null, req.params.id, req.empresaId]);
    const r = await query(`SELECT * FROM conta_bancaria WHERE id=$1`, [req.params.id]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── EXTRACTO BANCÁRIO ──

router.get('/extracto/:contaId', async (req, res) => {
  try {
    const { data_inicio, data_fim, reconciliado, categoria } = req.query;
    const conds = ['eb.conta_id=$1','eb.empresa_id=$2'], params = [req.params.contaId, req.empresaId];
    let n = 3;
    if (data_inicio) { conds.push(`eb.data>=$${n++}`); params.push(data_inicio); }
    if (data_fim) { conds.push(`eb.data<=$${n++}`); params.push(data_fim); }
    if (reconciliado !== undefined) { conds.push(`eb.reconciliado=$${n++}`); params.push(reconciliado==='true'); }
    if (categoria) { conds.push(`eb.categoria=$${n++}`); params.push(categoria); }

    const [movs, resumo] = await Promise.all([
      query(`SELECT eb.* FROM extrato_bancario eb WHERE ${conds.join(' AND ')} ORDER BY eb.data DESC, eb.criado_em DESC LIMIT 500`, params),
      query(`SELECT
        SUM(CASE WHEN valor>0 THEN valor ELSE 0 END) as total_creditos,
        SUM(CASE WHEN valor<0 THEN valor ELSE 0 END) as total_debitos,
        COUNT(*) as total_movimentos,
        COUNT(*) FILTER (WHERE reconciliado=true) as reconciliados,
        COUNT(*) FILTER (WHERE reconciliado=false) as por_reconciliar
        FROM extrato_bancario eb WHERE ${conds.join(' AND ')}`, params),
    ]);

    res.json({ movimentos: movs.rows, resumo: resumo.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Importar extracto (CSV/OFX manual)
router.post('/extracto/:contaId/importar', async (req, res) => {
  try {
    const { movimentos } = req.body; // Array de { data, descricao, valor, referencia }
    if (!movimentos?.length) return res.status(400).json({ error: 'Sem movimentos' });

    let importados = 0, duplicados = 0;
    for (const mov of movimentos) {
      const categoria = categorizarMovimento(mov.descricao);
      try {
        await query(`
          INSERT INTO extrato_bancario (empresa_id, conta_id, data, descricao, valor, referencia, categoria, reconciliado)
          VALUES ($1,$2,$3,$4,$5,$6,$7,false)
          ON CONFLICT (empresa_id, conta_id, data, valor, descricao) DO NOTHING
        `, [req.empresaId, req.params.contaId, mov.data, mov.descricao, parseFloat(mov.valor), mov.referencia||null, categoria]);
        importados++;
      } catch(e) { duplicados++; }
    }

    // Actualizar saldo da conta
    const ultimoSaldo = await query(`SELECT SUM(valor) as total FROM extrato_bancario WHERE conta_id=$1`, [req.params.contaId]);
    await query(`UPDATE conta_bancaria SET saldo_actual=$1, ultimo_sync=NOW() WHERE id=$2`,
      [parseFloat(ultimoSaldo.rows[0]?.total||0), req.params.contaId]);

    res.json({ importados, duplicados, total: movimentos.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Sincronização simulada Open Banking (em prod usa API do banco via ASPSP)
router.post('/contas/:id/sincronizar', async (req, res) => {
  try {
    const conta = await query(`SELECT * FROM conta_bancaria WHERE id=$1 AND empresa_id=$2`, [req.params.id, req.empresaId]);
    if (!conta.rows.length) return res.status(404).json({ error: 'Conta não encontrada' });

    // Em produção real: chamar API PSD2 do banco com token OAuth2
    // Por agora: simular importação de movimentos recentes
    const c = conta.rows[0];

    if (c.psd2_token && c.psd2_expires > new Date()) {
      // Token válido — chamar API real do banco
      // TODO: implementar per banco (CGD, BPI, etc)
      return res.json({ ok: true, mensagem: 'Sincronização PSD2 disponível em produção', novos: 0 });
    }

    res.json({
      ok: false,
      mensagem: 'Configurar ligação PSD2 nas definições da conta bancária',
      instrucoes: 'Acede ao portal do teu banco e activa o acesso API PSD2, depois cola o token aqui.',
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── RECONCILIAÇÃO ──

router.post('/reconciliar/:movId', async (req, res) => {
  try {
    const { tipo, doc_id } = req.body; // tipo: 'fatura'|'despesa', doc_id: UUID
    await query(`
      UPDATE extrato_bancario SET
        reconciliado=true, reconciliado_em=NOW(),
        reconciliado_com_tipo=$1, reconciliado_com_id=$2
      WHERE id=$3 AND empresa_id=$4
    `, [tipo, doc_id, req.params.movId, req.empresaId]);

    if (tipo === 'fatura') await query(`UPDATE fatura SET reconciliada=true WHERE id=$1`, [doc_id]).catch(()=>{});
    if (tipo === 'despesa') await query(`UPDATE despesa SET reconciliada=true WHERE id=$1`, [doc_id]).catch(()=>{});

    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/ignorar/:movId', async (req, res) => {
  try {
    await query(`UPDATE extrato_bancario SET reconciliado=true, reconciliado_com_tipo='ignorado' WHERE id=$1 AND empresa_id=$2`,
      [req.params.movId, req.empresaId]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── DASHBOARD ──

router.get('/dashboard', async (req, res) => {
  try {
    const [contas, movRecentes, porCategoria, saldoHistorico] = await Promise.all([
      query(`SELECT cb.*, (SELECT SUM(valor) FROM extrato_bancario WHERE conta_id=cb.id) as saldo_calculado
        FROM conta_bancaria cb WHERE cb.empresa_id=$1 AND cb.ativo=true`, [req.empresaId]).catch(()=>({rows:[]})),
      query(`SELECT eb.*, cb.nome as conta_nome FROM extrato_bancario eb
        JOIN conta_bancaria cb ON cb.id=eb.conta_id
        WHERE eb.empresa_id=$1 ORDER BY eb.data DESC, eb.criado_em DESC LIMIT 20`, [req.empresaId]).catch(()=>({rows:[]})),
      query(`SELECT categoria, SUM(ABS(valor)) as total, COUNT(*) as num,
        SUM(CASE WHEN valor>0 THEN valor ELSE 0 END) as creditos,
        SUM(CASE WHEN valor<0 THEN ABS(valor) ELSE 0 END) as debitos
        FROM extrato_bancario WHERE empresa_id=$1 AND data > NOW()-INTERVAL '30 days'
        GROUP BY categoria ORDER BY total DESC LIMIT 10`, [req.empresaId]).catch(()=>({rows:[]})),
      query(`SELECT TO_CHAR(data,'YYYY-MM') as mes,
        SUM(CASE WHEN valor>0 THEN valor ELSE 0 END) as creditos,
        SUM(CASE WHEN valor<0 THEN ABS(valor) ELSE 0 END) as debitos
        FROM extrato_bancario WHERE empresa_id=$1 AND data > NOW()-INTERVAL '6 months'
        GROUP BY mes ORDER BY mes`, [req.empresaId]).catch(()=>({rows:[]})),
    ]);

    const saldoTotal = contas.rows.reduce((s,c) => s + parseFloat(c.saldo_actual||c.saldo_calculado||0), 0);
    const porReconciliar = await query(`SELECT COUNT(*) as total FROM extrato_bancario WHERE empresa_id=$1 AND reconciliado=false`, [req.empresaId]).catch(()=>({rows:[{total:0}]}));

    res.json({
      contas: contas.rows,
      saldo_total: saldoTotal,
      por_reconciliar: parseInt(porReconciliar.rows[0]?.total||0),
      movimentos_recentes: movRecentes.rows,
      por_categoria: porCategoria.rows,
      historico_mensal: saldoHistorico.rows,
      bancos_suportados: BANCOS_SUPORTADOS,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
