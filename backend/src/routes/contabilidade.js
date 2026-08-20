'use strict';
const router = require('express').Router();
const { autenticar, autorizar } = require('../middleware/auth');
const { query } = require('../config/database');

const ADMIN = ['admin_empresa', 'rh', 'diretor'];
router.use(autenticar, autorizar(...ADMIN));

// ══════════════════════════════════════════════════════════════════════════════
// PLANO DE CONTAS SNC
// ══════════════════════════════════════════════════════════════════════════════
router.get('/contas', async (req, res) => {
  const { classe, tipo, search } = req.query;
  let where = 'empresa_id=$1 AND ativa=true';
  const params = [req.empresaId];
  let p = 2;
  if (classe) { where += ` AND classe=$${p++}`; params.push(classe); }
  if (tipo) { where += ` AND tipo=$${p++}`; params.push(tipo); }
  if (search) { where += ` AND (codigo ILIKE $${p} OR descricao ILIKE $${p++})`; params.push(`%${search}%`); }
  const { rows } = await query(`SELECT * FROM conta_snc WHERE ${where} ORDER BY codigo`, params);
  res.json(rows);
});

router.post('/contas', async (req, res) => {
  const { codigo, descricao, tipo, classe, natureza, conta_mae_id } = req.body;
  if (!codigo || !descricao || !tipo || !classe) return res.status(400).json({ error: 'Campos obrigatórios em falta' });
  const { rows } = await query(`
    INSERT INTO conta_snc (empresa_id, codigo, descricao, tipo, classe, natureza, conta_mae_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
  `, [req.empresaId, codigo, descricao, tipo, classe, natureza||'devedora', conta_mae_id||null]);
  res.status(201).json(rows[0]);
});

router.put('/contas/:id', async (req, res) => {
  const { descricao, ativa } = req.body;
  const { rows } = await query(
    'UPDATE conta_snc SET descricao=$1, ativa=$2 WHERE id=$3 AND empresa_id=$4 RETURNING *',
    [descricao, ativa !== false, req.params.id, req.empresaId]
  );
  res.json(rows[0]);
});

// Saldo de uma conta num período
router.get('/contas/:id/saldo', async (req, res) => {
  const { ano, mes } = req.query;
  let dateWhere = '';
  const params = [req.params.id];
  let p = 2;
  if (ano && mes) {
    dateWhere = ` AND EXTRACT(YEAR FROM l.data_lancamento)=$${p++} AND EXTRACT(MONTH FROM l.data_lancamento)=$${p++}`;
    params.push(ano, mes);
  } else if (ano) {
    dateWhere = ` AND EXTRACT(YEAR FROM l.data_lancamento)=$${p++}`;
    params.push(ano);
  }

  const { rows: [saldo] } = await query(`
    SELECT
      COALESCE(SUM(ll.debito), 0) AS total_debito,
      COALESCE(SUM(ll.credito), 0) AS total_credito,
      COALESCE(SUM(ll.debito), 0) - COALESCE(SUM(ll.credito), 0) AS saldo
    FROM lancamento_linha ll
    JOIN lancamento l ON l.id = ll.lancamento_id
    WHERE ll.conta_id=$1 AND l.empresa_id=$2 AND l.estado='validado'${dateWhere}
  `, [req.params.id, req.empresaId, ...params.slice(1)]);

  res.json(saldo);
});

// ══════════════════════════════════════════════════════════════════════════════
// LANÇAMENTOS
// ══════════════════════════════════════════════════════════════════════════════
router.get('/lancamentos', async (req, res) => {
  const { ano, mes, diario, estado, search } = req.query;
  let where = 'l.empresa_id=$1';
  const params = [req.empresaId];
  let p = 2;
  if (ano) { where += ` AND EXTRACT(YEAR FROM l.data_lancamento)=$${p++}`; params.push(ano); }
  if (mes) { where += ` AND EXTRACT(MONTH FROM l.data_lancamento)=$${p++}`; params.push(mes); }
  if (diario) { where += ` AND l.diario=$${p++}`; params.push(diario); }
  if (estado) { where += ` AND l.estado=$${p++}`; params.push(estado); }
  if (search) { where += ` AND (l.descricao ILIKE $${p} OR l.numero ILIKE $${p++})`; params.push(`%${search}%`); }

  const { rows } = await query(`
    SELECT l.*,
      COALESCE((SELECT SUM(ll.debito) FROM lancamento_linha ll WHERE ll.lancamento_id=l.id), 0) AS total_debito,
      COALESCE((SELECT SUM(ll.credito) FROM lancamento_linha ll WHERE ll.lancamento_id=l.id), 0) AS total_credito
    FROM lancamento l
    WHERE ${where}
    ORDER BY l.data_lancamento DESC, l.numero DESC
    LIMIT 200
  `, params);
  res.json(rows);
});

router.get('/lancamentos/:id', async (req, res) => {
  const { rows: [lanc] } = await query('SELECT * FROM lancamento WHERE id=$1 AND empresa_id=$2', [req.params.id, req.empresaId]);
  if (!lanc) return res.status(404).json({ error: 'Lançamento não encontrado' });
  const { rows: linhas } = await query(`
    SELECT ll.*, c.codigo AS conta_codigo_reg, c.descricao AS conta_desc
    FROM lancamento_linha ll
    JOIN conta_snc c ON c.id = ll.conta_id
    WHERE ll.lancamento_id=$1 ORDER BY ll.ordem
  `, [req.params.id]);
  res.json({ ...lanc, linhas });
});

router.post('/lancamentos', async (req, res) => {
  const { data_lancamento, descricao, diario, documento_ref, linhas } = req.body;
  if (!descricao || !linhas?.length) return res.status(400).json({ error: 'Descrição e linhas obrigatórios' });

  // Validar equilíbrio débito/crédito
  const totalDeb = linhas.reduce((s, l) => s + parseFloat(l.debito||0), 0);
  const totalCre = linhas.reduce((s, l) => s + parseFloat(l.credito||0), 0);
  if (Math.abs(totalDeb - totalCre) > 0.01)
    return res.status(400).json({ error: `Lançamento desequilibrado: débito ${totalDeb.toFixed(2)}€ ≠ crédito ${totalCre.toFixed(2)}€` });

  // Gerar número sequencial
  const ano = new Date(data_lancamento || new Date()).getFullYear();
  const { rows: [ultimo] } = await query(
    "SELECT numero FROM lancamento WHERE empresa_id=$1 AND EXTRACT(YEAR FROM data_lancamento)=$2 AND diario=$3 ORDER BY numero DESC LIMIT 1",
    [req.empresaId, ano, diario||'OD']
  );
  const seq = ultimo ? parseInt(ultimo.numero?.split('/')?.[1]||0) + 1 : 1;
  const numero = `${diario||'OD'}/${ano}/${String(seq).padStart(4,'0')}`;

  const { rows: [lanc] } = await query(`
    INSERT INTO lancamento (empresa_id, numero, data_lancamento, descricao, diario, documento_ref, estado, criado_por)
    VALUES ($1,$2,$3,$4,$5,$6,'validado',$7) RETURNING *
  `, [req.empresaId, numero, data_lancamento||new Date().toISOString().split('T')[0], descricao, diario||'OD', documento_ref||null, req.utilizador.id]);

  for (let i = 0; i < linhas.length; i++) {
    const l = linhas[i];
    const { rows: [conta] } = await query('SELECT * FROM conta_snc WHERE id=$1 AND empresa_id=$2', [l.conta_id, req.empresaId]);
    if (!conta) continue;
    await query(`
      INSERT INTO lancamento_linha (lancamento_id, conta_id, conta_codigo, conta_descricao, debito, credito, descricao, ordem)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [lanc.id, l.conta_id, conta.codigo, conta.descricao, parseFloat(l.debito||0), parseFloat(l.credito||0), l.descricao||null, i+1]);
  }

  res.status(201).json(lanc);
});

router.delete('/lancamentos/:id', async (req, res) => {
  const { rows: [lanc] } = await query(
    "SELECT * FROM lancamento WHERE id=$1 AND empresa_id=$2 AND estado!='validado'",
    [req.params.id, req.empresaId]
  );
  if (!lanc) return res.status(400).json({ error: 'Só é possível eliminar lançamentos em rascunho' });
  await query('DELETE FROM lancamento WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// BALANCETE
// ══════════════════════════════════════════════════════════════════════════════
router.get('/balancete/:ano/:mes', async (req, res) => {
  const { ano, mes } = req.params;
  const { rows } = await query(`
    SELECT
      c.codigo, c.descricao, c.tipo, c.classe, c.natureza,
      COALESCE(SUM(ll.debito) FILTER (
        WHERE EXTRACT(YEAR FROM l.data_lancamento) < $2
        OR (EXTRACT(YEAR FROM l.data_lancamento) = $2 AND EXTRACT(MONTH FROM l.data_lancamento) < $3)
      ), 0) AS saldo_inicial_deb,
      COALESCE(SUM(ll.credito) FILTER (
        WHERE EXTRACT(YEAR FROM l.data_lancamento) < $2
        OR (EXTRACT(YEAR FROM l.data_lancamento) = $2 AND EXTRACT(MONTH FROM l.data_lancamento) < $3)
      ), 0) AS saldo_inicial_cre,
      COALESCE(SUM(ll.debito) FILTER (
        WHERE EXTRACT(YEAR FROM l.data_lancamento) = $2 AND EXTRACT(MONTH FROM l.data_lancamento) = $3
      ), 0) AS mov_deb,
      COALESCE(SUM(ll.credito) FILTER (
        WHERE EXTRACT(YEAR FROM l.data_lancamento) = $2 AND EXTRACT(MONTH FROM l.data_lancamento) = $3
      ), 0) AS mov_cre,
      COALESCE(SUM(ll.debito) FILTER (
        WHERE EXTRACT(YEAR FROM l.data_lancamento) = $2 AND EXTRACT(MONTH FROM l.data_lancamento) <= $3
      ), 0) AS total_deb,
      COALESCE(SUM(ll.credito) FILTER (
        WHERE EXTRACT(YEAR FROM l.data_lancamento) = $2 AND EXTRACT(MONTH FROM l.data_lancamento) <= $3
      ), 0) AS total_cre
    FROM conta_snc c
    LEFT JOIN lancamento_linha ll ON ll.conta_id = c.id
    LEFT JOIN lancamento l ON l.id = ll.lancamento_id AND l.empresa_id=$1 AND l.estado='validado'
    WHERE c.empresa_id=$1 AND c.ativa=true
    GROUP BY c.id, c.codigo, c.descricao, c.tipo, c.classe, c.natureza
    HAVING COALESCE(SUM(ll.debito),0) > 0 OR COALESCE(SUM(ll.credito),0) > 0
    ORDER BY c.codigo
  `, [req.empresaId, ano, mes]);

  const totais = rows.reduce((acc, r) => ({
    saldo_inicial_deb: acc.saldo_inicial_deb + parseFloat(r.saldo_inicial_deb),
    saldo_inicial_cre: acc.saldo_inicial_cre + parseFloat(r.saldo_inicial_cre),
    mov_deb: acc.mov_deb + parseFloat(r.mov_deb),
    mov_cre: acc.mov_cre + parseFloat(r.mov_cre),
    total_deb: acc.total_deb + parseFloat(r.total_deb),
    total_cre: acc.total_cre + parseFloat(r.total_cre),
  }), { saldo_inicial_deb:0, saldo_inicial_cre:0, mov_deb:0, mov_cre:0, total_deb:0, total_cre:0 });

  res.json({ linhas: rows, totais, periodo: `${ano}-${String(mes).padStart(2,'0')}` });
});

// ══════════════════════════════════════════════════════════════════════════════
// DEMONSTRAÇÃO DE RESULTADOS
// ══════════════════════════════════════════════════════════════════════════════
router.get('/demonstracao-resultados/:ano', async (req, res) => {
  const { ano } = req.params;
  const { mes } = req.query;

  let dateWhere = `EXTRACT(YEAR FROM l.data_lancamento) = $2`;
  const params = [req.empresaId, ano];
  if (mes) { dateWhere += ` AND EXTRACT(MONTH FROM l.data_lancamento) <= $3`; params.push(mes); }

  const { rows } = await query(`
    SELECT c.codigo, c.descricao, c.classe,
      COALESCE(SUM(ll.debito), 0) AS total_deb,
      COALESCE(SUM(ll.credito), 0) AS total_cre
    FROM conta_snc c
    JOIN lancamento_linha ll ON ll.conta_id = c.id
    JOIN lancamento l ON l.id = ll.lancamento_id AND l.estado='validado'
    WHERE c.empresa_id=$1 AND ${dateWhere} AND c.classe IN ('6','7','8')
    GROUP BY c.id, c.codigo, c.descricao, c.classe
    ORDER BY c.codigo
  `, params);

  const rendimentos  = rows.filter(r => r.classe === '7');
  const gastos       = rows.filter(r => r.classe === '6');
  const resultados   = rows.filter(r => r.classe === '8');

  const totalRendimentos = rendimentos.reduce((s, r) => s + (parseFloat(r.total_cre) - parseFloat(r.total_deb)), 0);
  const totalGastos      = gastos.reduce((s, r) => s + (parseFloat(r.total_deb) - parseFloat(r.total_cre)), 0);
  const resultadoLiquido = totalRendimentos - totalGastos;

  res.json({ rendimentos, gastos, resultados, totalRendimentos, totalGastos, resultadoLiquido, ano, mes: mes||null });
});

// ══════════════════════════════════════════════════════════════════════════════
// BALANÇO
// ══════════════════════════════════════════════════════════════════════════════
router.get('/balanco/:ano', async (req, res) => {
  const { ano } = req.params;
  const { rows } = await query(`
    SELECT c.codigo, c.descricao, c.classe, c.tipo, c.natureza,
      COALESCE(SUM(ll.debito), 0) - COALESCE(SUM(ll.credito), 0) AS saldo
    FROM conta_snc c
    JOIN lancamento_linha ll ON ll.conta_id = c.id
    JOIN lancamento l ON l.id = ll.lancamento_id AND l.estado='validado'
    WHERE c.empresa_id=$1 AND EXTRACT(YEAR FROM l.data_lancamento) <= $2
      AND c.classe IN ('1','2','3','4','5')
    GROUP BY c.id, c.codigo, c.descricao, c.classe, c.tipo, c.natureza
    HAVING ABS(COALESCE(SUM(ll.debito),0) - COALESCE(SUM(ll.credito),0)) > 0.01
    ORDER BY c.codigo
  `, [req.empresaId, ano]);

  const ativo       = rows.filter(r => ['1','2','3'].includes(r.classe) && parseFloat(r.saldo) > 0);
  const passivo     = rows.filter(r => r.classe === '2' && parseFloat(r.saldo) < 0);
  const capProprio  = rows.filter(r => r.classe === '5');

  const totalAtivo      = ativo.reduce((s, r) => s + Math.abs(parseFloat(r.saldo)), 0);
  const totalPassivo    = passivo.reduce((s, r) => s + Math.abs(parseFloat(r.saldo)), 0);
  const totalCapProprio = capProprio.reduce((s, r) => s + parseFloat(r.saldo), 0);

  res.json({ ativo, passivo, capProprio, totalAtivo, totalPassivo, totalCapProprio, ano });
});

// ══════════════════════════════════════════════════════════════════════════════
// RAZÃO DE CONTA
// ══════════════════════════════════════════════════════════════════════════════
router.get('/razao/:conta_id', async (req, res) => {
  const { ano, mes } = req.query;
  let where = 'll.conta_id=$1 AND l.empresa_id=$2 AND l.estado=\'validado\'';
  const params = [req.params.conta_id, req.empresaId];
  let p = 3;
  if (ano) { where += ` AND EXTRACT(YEAR FROM l.data_lancamento)=$${p++}`; params.push(ano); }
  if (mes) { where += ` AND EXTRACT(MONTH FROM l.data_lancamento)=$${p++}`; params.push(mes); }

  const { rows } = await query(`
    SELECT l.numero, l.data_lancamento, l.descricao AS desc_lancamento, l.diario,
      ll.descricao, ll.debito, ll.credito
    FROM lancamento_linha ll
    JOIN lancamento l ON l.id = ll.lancamento_id
    WHERE ${where}
    ORDER BY l.data_lancamento, l.numero
  `, params);

  let saldo = 0;
  const linhasComSaldo = rows.map(r => {
    saldo += parseFloat(r.debito||0) - parseFloat(r.credito||0);
    return { ...r, saldo_acumulado: saldo };
  });

  res.json({ linhas: linhasComSaldo, saldo_final: saldo });
});

// Dashboard contabilidade
router.get('/dashboard', async (req, res) => {
  const ano = new Date().getFullYear();
  const mes = new Date().getMonth() + 1;

  const { rows: [totais] } = await query(`
    SELECT
      COUNT(DISTINCT l.id) AS num_lancamentos,
      COALESCE(SUM(ll.debito), 0) AS total_movimento,
      COUNT(DISTINCT ll.conta_id) AS contas_usadas
    FROM lancamento l
    JOIN lancamento_linha ll ON ll.lancamento_id = l.id
    WHERE l.empresa_id=$1 AND l.estado='validado'
      AND EXTRACT(YEAR FROM l.data_lancamento)=$2
      AND EXTRACT(MONTH FROM l.data_lancamento)=$3
  `, [req.empresaId, ano, mes]);

  const { rows: [totalContas] } = await query(
    'SELECT COUNT(*) AS total FROM conta_snc WHERE empresa_id=$1 AND ativa=true',
    [req.empresaId]
  );

  const { rows: ultimosLanc } = await query(`
    SELECT l.numero, l.data_lancamento, l.descricao, l.diario,
      COALESCE(SUM(ll.debito),0) AS valor
    FROM lancamento l
    JOIN lancamento_linha ll ON ll.lancamento_id = l.id
    WHERE l.empresa_id=$1 AND l.estado='validado'
    GROUP BY l.id ORDER BY l.data_lancamento DESC, l.numero DESC LIMIT 5
  `, [req.empresaId]);

  res.json({ totais, totalContas: totalContas.total, ultimosLanc, ano, mes });
});

module.exports = router;
