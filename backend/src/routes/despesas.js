'use strict';
const router = require('express').Router();
const { autenticar, autorizar } = require('../middleware/auth');
const { query } = require('../config/database');

const RH = ['admin_empresa', 'rh', 'diretor'];

// Categorias e IVA dedutível por categoria (Portugal)
const CATEGORIAS = [
  { id: 'alimentacao',      label: 'Alimentação',           iva_dedutivel: 50  },
  { id: 'transporte',       label: 'Transportes',           iva_dedutivel: 50  },
  { id: 'alojamento',       label: 'Alojamento',            iva_dedutivel: 25  },
  { id: 'combustivel',      label: 'Combustível',           iva_dedutivel: 50  },
  { id: 'comunicacoes',     label: 'Comunicações',          iva_dedutivel: 50  },
  { id: 'material',         label: 'Material de Escritório',iva_dedutivel: 100 },
  { id: 'formacao',         label: 'Formação',              iva_dedutivel: 100 },
  { id: 'representacao',    label: 'Representação',         iva_dedutivel: 25  },
  { id: 'software',         label: 'Software / Serviços',   iva_dedutivel: 100 },
  { id: 'saude',            label: 'Saúde',                 iva_dedutivel: 0   },
  { id: 'outros',           label: 'Outros',                iva_dedutivel: 50  },
];

router.get('/categorias', (req, res) => res.json(CATEGORIAS));

// ── Listar despesas ───────────────────────────────────────────────────────────
router.get('/', autenticar, async (req, res) => {
  const { estado, mes, ano, funcionario_id } = req.query;
  const perfil = req.utilizador.perfil;
  const isRH = RH.includes(perfil);

  let where = 'd.empresa_id=$1';
  const params = [req.empresaId];
  let p = 2;

  // Colaborador só vê as suas
  if (!isRH) {
    const { rows:[func] } = await query('SELECT id FROM funcionario WHERE utilizador_id=$1 AND empresa_id=$2', [req.utilizador.id, req.empresaId]);
    if (!func) return res.json([]);
    where += ` AND d.funcionario_id=$${p++}`;
    params.push(func.id);
  } else if (funcionario_id) {
    where += ` AND d.funcionario_id=$${p++}`;
    params.push(funcionario_id);
  }

  if (estado) { where += ` AND d.estado=$${p++}`; params.push(estado); }
  if (ano) { where += ` AND EXTRACT(YEAR FROM d.data_despesa)=$${p++}`; params.push(ano); }
  if (mes) { where += ` AND EXTRACT(MONTH FROM d.data_despesa)=$${p++}`; params.push(mes); }

  const { rows } = await query(`
    SELECT d.*, f.nome_completo AS funcionario_nome, f.cargo AS funcionario_cargo,
      u.nome_completo AS aprovado_por_nome
    FROM despesa d
    JOIN funcionario f ON f.id = d.funcionario_id
    LEFT JOIN utilizador u ON u.id = d.aprovado_por
    WHERE ${where}
    ORDER BY d.criado_em DESC
    LIMIT 200
  `, params);

  res.json(rows);
});

// ── Submeter despesa ──────────────────────────────────────────────────────────
router.post('/', autenticar, async (req, res) => {
  const { data_despesa, categoria, descricao, valor, iva_incluido, taxa_iva, fornecedor, numero_documento, projeto, notas, funcionario_id, comprovativo_url } = req.body;
  if (!categoria || !descricao || !valor) return res.status(400).json({ error: 'Categoria, descrição e valor são obrigatórios' });

  // Determinar funcionário
  let funcId = funcionario_id;
  if (!funcId) {
    const { rows:[func] } = await query('SELECT id FROM funcionario WHERE utilizador_id=$1 AND empresa_id=$2', [req.utilizador.id, req.empresaId]);
    funcId = func?.id;
  }
  if (!funcId) return res.status(400).json({ error: 'Funcionário não encontrado' });

  const val = parseFloat(valor);
  const taxaIva = parseFloat(taxa_iva || 0);
  const valIva = iva_incluido ? Math.round(val - (val / (1 + taxaIva/100)) * 100) / 100 : Math.round(val * taxaIva/100 * 100) / 100;
  const valSemIva = iva_incluido ? Math.round((val / (1 + taxaIva/100)) * 100) / 100 : val;

  // Verificar política
  const { rows:[politica] } = await query('SELECT * FROM politica_despesas WHERE empresa_id=$1 AND categoria=$2 AND ativa=true', [req.empresaId, categoria]);
  if (politica?.limite_por_despesa && val > politica.limite_por_despesa) {
    return res.status(400).json({ error: `Valor excede o limite por despesa para ${categoria} (${politica.limite_por_despesa}€)` });
  }

  const { rows:[nova] } = await query(`
    INSERT INTO despesa (empresa_id, funcionario_id, data_despesa, categoria, descricao, valor, iva_incluido, taxa_iva, valor_iva, valor_sem_iva, fornecedor, numero_documento, projeto, notas, comprovativo_url, estado, criado_por)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'submetida',$16) RETURNING *
  `, [req.empresaId, funcId, data_despesa||new Date().toISOString().split('T')[0], categoria, descricao, val, iva_incluido||false, taxaIva, valIva, valSemIva, fornecedor||null, numero_documento||null, projeto||null, notas||null, comprovativo_url||null, req.utilizador.id]);

  res.status(201).json(nova);
});

// ── Aprovar despesa ───────────────────────────────────────────────────────────
router.patch('/:id/aprovar', autenticar, autorizar(...RH), async (req, res) => {
  const { rows:[d] } = await query(
    "UPDATE despesa SET estado='aprovada', aprovado_por=$1, aprovado_em=NOW() WHERE id=$2 AND empresa_id=$3 AND estado='submetida' RETURNING *",
    [req.utilizador.id, req.params.id, req.empresaId]
  );
  if (!d) return res.status(404).json({ error: 'Despesa não encontrada ou já processada' });
  res.json(d);
});

// ── Rejeitar despesa ──────────────────────────────────────────────────────────
router.patch('/:id/rejeitar', autenticar, autorizar(...RH), async (req, res) => {
  const { motivo } = req.body;
  const { rows:[d] } = await query(
    "UPDATE despesa SET estado='rejeitada', aprovado_por=$1, aprovado_em=NOW(), rejeitado_motivo=$2 WHERE id=$3 AND empresa_id=$4 AND estado='submetida' RETURNING *",
    [req.utilizador.id, motivo||null, req.params.id, req.empresaId]
  );
  if (!d) return res.status(404).json({ error: 'Despesa não encontrada' });
  res.json(d);
});

// ── Marcar como paga ──────────────────────────────────────────────────────────
router.patch('/:id/pagar', autenticar, autorizar(...RH), async (req, res) => {
  const { mes, ano } = req.body;
  const { rows:[d] } = await query(
    "UPDATE despesa SET estado='paga', pago_em=CURRENT_DATE, pago_no_salario_mes=$1, pago_no_salario_ano=$2 WHERE id=$3 AND empresa_id=$4 AND estado='aprovada' RETURNING *",
    [mes||null, ano||null, req.params.id, req.empresaId]
  );
  res.json(d);
});

// ── Aprovar em massa ──────────────────────────────────────────────────────────
router.post('/aprovar-massa', autenticar, autorizar(...RH), async (req, res) => {
  const { ids } = req.body;
  if (!ids?.length) return res.status(400).json({ error: 'Sem IDs' });
  const { rowCount } = await query(
    `UPDATE despesa SET estado='aprovada', aprovado_por=$1, aprovado_em=NOW() WHERE id=ANY($2) AND empresa_id=$3 AND estado='submetida'`,
    [req.utilizador.id, ids, req.empresaId]
  );
  res.json({ aprovadas: rowCount });
});

// ── Dashboard ─────────────────────────────────────────────────────────────────
router.get('/dashboard', autenticar, autorizar(...RH), async (req, res) => {
  const ano = new Date().getFullYear();
  const mes = new Date().getMonth() + 1;

  const { rows:[resumo] } = await query(`
    SELECT
      COUNT(*) FILTER (WHERE estado='submetida') AS pendentes,
      COUNT(*) FILTER (WHERE estado='aprovada') AS aprovadas,
      COUNT(*) FILTER (WHERE estado='paga') AS pagas,
      COUNT(*) FILTER (WHERE estado='rejeitada') AS rejeitadas,
      COALESCE(SUM(valor) FILTER (WHERE estado='submetida'), 0) AS valor_pendente,
      COALESCE(SUM(valor) FILTER (WHERE estado='aprovada'), 0) AS valor_aprovado,
      COALESCE(SUM(valor) FILTER (WHERE estado='paga' AND EXTRACT(YEAR FROM data_despesa)=$2), 0) AS valor_pago_ano,
      COALESCE(SUM(valor_iva) FILTER (WHERE estado NOT IN ('rejeitada')), 0) AS iva_recuperavel
    FROM despesa WHERE empresa_id=$1
  `, [req.empresaId, ano]);

  const { rows: porCategoria } = await query(`
    SELECT categoria, COUNT(*) AS num, SUM(valor) AS total
    FROM despesa WHERE empresa_id=$1 AND estado NOT IN ('rejeitada')
      AND EXTRACT(YEAR FROM data_despesa)=$2
    GROUP BY categoria ORDER BY total DESC
  `, [req.empresaId, ano]);

  const { rows: pendentes } = await query(`
    SELECT d.*, f.nome_completo AS funcionario_nome
    FROM despesa d JOIN funcionario f ON f.id=d.funcionario_id
    WHERE d.empresa_id=$1 AND d.estado='submetida'
    ORDER BY d.criado_em ASC LIMIT 10
  `, [req.empresaId]);

  const { rows: porColaborador } = await query(`
    SELECT f.nome_completo, COUNT(*) AS num_despesas, SUM(d.valor) AS total
    FROM despesa d JOIN funcionario f ON f.id=d.funcionario_id
    WHERE d.empresa_id=$1 AND d.estado NOT IN ('rejeitada')
      AND EXTRACT(YEAR FROM d.data_despesa)=$2
      AND EXTRACT(MONTH FROM d.data_despesa)=$3
    GROUP BY f.nome_completo ORDER BY total DESC LIMIT 5
  `, [req.empresaId, ano, mes]);

  res.json({ resumo, porCategoria, pendentes, porColaborador });
});

// ── Relatório para contabilidade ──────────────────────────────────────────────
router.get('/relatorio/:ano/:mes', autenticar, autorizar(...RH), async (req, res) => {
  const { ano, mes } = req.params;
  const { rows } = await query(`
    SELECT d.data_despesa, d.categoria, d.descricao, d.fornecedor,
      d.numero_documento, f.nome_completo AS funcionario, f.nif AS funcionario_nif,
      d.valor, d.taxa_iva, d.valor_iva, d.valor_sem_iva, d.estado, d.projeto
    FROM despesa d
    JOIN funcionario f ON f.id = d.funcionario_id
    WHERE d.empresa_id=$1 AND d.estado IN ('aprovada','paga')
      AND EXTRACT(YEAR FROM d.data_despesa)=$2
      AND EXTRACT(MONTH FROM d.data_despesa)=$3
    ORDER BY d.data_despesa, f.nome_completo
  `, [req.empresaId, ano, mes]);

  const totalValor = rows.reduce((s,r) => s+parseFloat(r.valor||0), 0);
  const totalIva = rows.reduce((s,r) => s+parseFloat(r.valor_iva||0), 0);

  res.json({ linhas: rows, totalValor, totalIva, periodo: `${ano}-${String(mes).padStart(2,'0')}` });
});

// ── Políticas de despesas ─────────────────────────────────────────────────────
router.get('/politicas', autenticar, autorizar(...RH), async (req, res) => {
  const { rows } = await query('SELECT * FROM politica_despesas WHERE empresa_id=$1 ORDER BY categoria', [req.empresaId]);
  res.json(rows);
});

router.post('/politicas', autenticar, autorizar(...RH), async (req, res) => {
  const { categoria, limite_por_despesa, limite_mensal, requer_recibo_acima, iva_dedutivel_pct } = req.body;
  const { rows } = await query(`
    INSERT INTO politica_despesas (empresa_id, categoria, limite_por_despesa, limite_mensal, requer_recibo_acima, iva_dedutivel_pct)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (empresa_id, categoria) DO UPDATE SET
      limite_por_despesa=$3, limite_mensal=$4, requer_recibo_acima=$5, iva_dedutivel_pct=$6
    RETURNING *
  `, [req.empresaId, categoria, limite_por_despesa||null, limite_mensal||null, requer_recibo_acima||0, iva_dedutivel_pct||50]);
  res.json(rows[0]);
});

module.exports = router;
