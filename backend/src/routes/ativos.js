'use strict';
const router = require('express').Router();
const { autenticar, autorizar } = require('../middleware/auth');
const { query } = require('../config/database');

const ADMIN = ['admin_empresa', 'rh', 'diretor'];
router.use(autenticar, autorizar(...ADMIN));

// ══════════════════════════════════════════════════════════════════════════════
// TAXAS DE DEPRECIAÇÃO — Portaria 467/2010 (CIRC art. 31.º)
// ══════════════════════════════════════════════════════════════════════════════
const TAXAS_CIRC = {
  'Edificios industriais':            { taxa: 0.05,  vida: 20 },
  'Edificios comerciais e servicos':  { taxa: 0.02,  vida: 50 },
  'Viaturas ligeiras de passageiros': { taxa: 0.25,  vida: 4  },
  'Viaturas ligeiras de mercadorias': { taxa: 0.25,  vida: 4  },
  'Viaturas pesadas':                 { taxa: 0.20,  vida: 5  },
  'Mobiliario e equipamento escritorio': { taxa: 0.125, vida: 8 },
  'Equipamento informatico':          { taxa: 0.333, vida: 3  },
  'Software':                         { taxa: 0.333, vida: 3  },
  'Equipamento industrial':           { taxa: 0.125, vida: 8  },
  'Ferramentas e utensilios':         { taxa: 0.25,  vida: 4  },
  'Instalacoes tecnicas':             { taxa: 0.10,  vida: 10 },
  'Equipamento de comunicacoes':      { taxa: 0.20,  vida: 5  },
  'Outros':                           { taxa: 0.125, vida: 8  },
};

router.get('/taxas-circ', (req, res) => {
  res.json(Object.entries(TAXAS_CIRC).map(([categoria, dados]) => ({
    categoria,
    taxa: dados.taxa,
    taxa_pct: (dados.taxa * 100).toFixed(1) + '%',
    vida_util: dados.vida,
  })));
});

// ══════════════════════════════════════════════════════════════════════════════
// ACTIVOS FIXOS
// ══════════════════════════════════════════════════════════════════════════════
router.get('/', async (req, res) => {
  const { estado, categoria } = req.query;
  let where = 'a.empresa_id=$1';
  const params = [req.empresaId];
  let p = 2;
  if (estado) { if (estado==='ativo') { where += " AND a.estado IN ('ativo','activo')"; } else { where += ` AND a.estado=${p++}`; params.push(estado); } }
  if (categoria) { where += ` AND a.categoria=$${p++}`; params.push(categoria); }

  const { rows } = await query(`
    SELECT a.*,
      f.nome_completo AS responsavel_nome,
      ROUND(a.valor_aquisicao - a.depreciacao_acumulada, 2) AS valor_liquido_calc
    FROM ativo_fixo a
    LEFT JOIN funcionario f ON f.id = a.responsavel_id
    WHERE ${where}
    ORDER BY a.data_aquisicao DESC
  `, params);
  res.json(rows);
});

router.get('/amortizacoes', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT a.*,
             ROUND(a.valor_aquisicao * (COALESCE(a.taxa_depreciacao,0)/100), 2) AS amortizacao_anual,
             COALESCE(a.valor_liquido, a.valor_aquisicao - a.depreciacao_acumulada) AS valor_contabilistico
      FROM ativo_fixo a
      WHERE a.empresa_id=$1 AND a.estado IN ('ativo','activo')
      ORDER BY a.descricao
    `, [req.empresaId]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/mapa-depreciacoes/:ano', async (req, res) => {
  const { ano } = req.params;
  const { rows } = await query(`
    SELECT a.codigo, a.descricao, a.categoria, a.valor_aquisicao,
      dl.valor_inicio_ano, dl.taxa_depreciacao, dl.valor_depreciacao,
      dl.depreciacao_acumulada, dl.valor_liquido_fim, dl.registado
    FROM depreciacao_linha dl
    JOIN ativo_fixo a ON a.id = dl.ativo_id
    WHERE dl.empresa_id=$1 AND dl.ano=$2 AND a.estado IN ('ativo','activo')
    ORDER BY a.categoria, a.descricao
  `, [req.empresaId, ano]);

  const total_dep = rows.reduce((s, r) => s + parseFloat(r.valor_depreciacao||0), 0);
  const total_acumulada = rows.reduce((s, r) => s + parseFloat(r.depreciacao_acumulada||0), 0);
  const total_liquido = rows.reduce((s, r) => s + parseFloat(r.valor_liquido_fim||0), 0);

  res.json({ ano, linhas: rows, total_dep, total_acumulada, total_liquido });
});

// Dashboard
router.get('/dashboard/resumo', async (req, res) => {
  const { rows: [resumo] } = await query(`
    SELECT
      COUNT(*) FILTER (WHERE estado IN ('ativo','activo')) AS total_ativos,
      COUNT(*) FILTER (WHERE estado='abatido') AS total_abatidos,
      COALESCE(SUM(valor_aquisicao) FILTER (WHERE estado IN ('ativo','activo')), 0) AS valor_bruto,
      COALESCE(SUM(depreciacao_acumulada) FILTER (WHERE estado IN ('ativo','activo')), 0) AS dep_acumulada,
      COALESCE(SUM(valor_aquisicao - depreciacao_acumulada) FILTER (WHERE estado IN ('ativo','activo')), 0) AS valor_liquido
    FROM ativo_fixo WHERE empresa_id=$1
  `, [req.empresaId]);

  const { rows: porCategoria } = await query(`
    SELECT categoria,
      COUNT(*) AS num,
      SUM(valor_aquisicao) AS valor_bruto,
      SUM(valor_aquisicao - depreciacao_acumulada) AS valor_liquido
    FROM ativo_fixo WHERE empresa_id=$1 AND estado IN ('ativo','activo')
    GROUP BY categoria ORDER BY valor_bruto DESC
  `, [req.empresaId]);

  const anoAtual = new Date().getFullYear();
  const { rows: depreciacoesAno } = await query(`
    SELECT SUM(dl.valor_depreciacao) AS total_dep_ano
    FROM depreciacao_linha dl
    JOIN ativo_fixo a ON a.id = dl.ativo_id
    WHERE dl.empresa_id=$1 AND dl.ano=$2 AND a.estado IN ('ativo','activo')
  `, [req.empresaId, anoAtual]);

  const { rows: aFimVida } = await query(`
    SELECT a.descricao, a.categoria, a.data_aquisicao, a.vida_util_anos,
      EXTRACT(YEAR FROM a.data_inicio_uso) + a.vida_util_anos AS ano_fim_vida
    FROM ativo_fixo a
    WHERE a.empresa_id=$1 AND a.estado IN ('ativo','activo')
      AND EXTRACT(YEAR FROM a.data_inicio_uso) + a.vida_util_anos <= $2 + 1
    ORDER BY ano_fim_vida
    LIMIT 5
  `, [req.empresaId, anoAtual]);

  res.json({
    resumo: {
      ...resumo,
      dep_ano_atual: parseFloat(depreciacoesAno[0]?.total_dep_ano || 0),
    },
    porCategoria,
    aFimVida,
  });
});

module.exports = router;

router.get('/:id', async (req, res) => {
  const { rows: [ativo] } = await query(`
    SELECT a.*, f.nome_completo AS responsavel_nome
    FROM ativo_fixo a
    LEFT JOIN funcionario f ON f.id = a.responsavel_id
    WHERE a.id=$1 AND a.empresa_id=$2
  `, [req.params.id, req.empresaId]);
  if (!ativo) return res.status(404).json({ error: 'Activo não encontrado' });

  const { rows: depreciacoes } = await query(
    'SELECT * FROM depreciacao_linha WHERE ativo_id=$1 ORDER BY ano',
    [req.params.id]
  );
  res.json({ ...ativo, depreciacoes });
});

router.post('/', async (req, res) => {
  const {
    codigo, descricao, categoria, subcategoria, fornecedor_nome,
    numero_serie, numero_fatura, data_aquisicao, data_inicio_uso,
    valor_aquisicao, valor_residual, taxa_depreciacao, metodo,
    vida_util_anos, localizacao, responsavel_id, notas
  } = req.body;

  if (!descricao || !categoria || !data_aquisicao || !valor_aquisicao)
    return res.status(400).json({ error: 'Campos obrigatórios: descrição, categoria, data aquisição, valor' });

  const taxa = parseFloat(taxa_depreciacao) || TAXAS_CIRC[categoria]?.taxa || 0.125;
  const vida = parseFloat(vida_util_anos) || TAXAS_CIRC[categoria]?.vida || 8;
  const valAq = parseFloat(valor_aquisicao);
  const valRes = parseFloat(valor_residual || 0);

  const { rows: [ativo] } = await query(`
    INSERT INTO ativo_fixo (
      empresa_id, codigo, descricao, categoria, subcategoria, fornecedor_nome,
      numero_serie, numero_fatura, data_aquisicao, data_inicio_uso,
      valor_aquisicao, valor_residual, taxa_depreciacao, metodo,
      vida_util_anos, depreciacao_acumulada, valor_liquido,
      localizacao, responsavel_id, notas, criado_por
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,0,$11,$16,$17,$18,$19)
    RETURNING *
  `, [
    req.empresaId, codigo||null, descricao, categoria, subcategoria||null, fornecedor_nome||null,
    numero_serie||null, numero_fatura||null, data_aquisicao, data_inicio_uso||data_aquisicao,
    valAq, valRes, taxa, metodo||'quotas_constantes',
    vida, localizacao||null, responsavel_id||null, notas||null, req.utilizador.id
  ]);

  // Gerar plano de depreciações automático
  await gerarPlanoDep(ativo, req.empresaId);

  res.status(201).json(ativo);
});

router.put('/:id', async (req, res) => {
  const { descricao, categoria, localizacao, responsavel_id, notas, estado } = req.body;
  const { rows: [ativo] } = await query(`
    UPDATE ativo_fixo SET descricao=$1, categoria=$2, localizacao=$3,
      responsavel_id=$4, notas=$5, estado=COALESCE($6, estado)
    WHERE id=$7 AND empresa_id=$8 RETURNING *
  `, [descricao, categoria, localizacao||null, responsavel_id||null, notas||null, estado||null, req.params.id, req.empresaId]);
  res.json(ativo);
});

// Abater activo
router.patch('/:id/abater', async (req, res) => {
  const { data_abate, valor_venda, motivo } = req.body;
  const { rows: [ativo] } = await query(`
    UPDATE ativo_fixo SET estado='abatido', notas=COALESCE(notas,'') || $1
    WHERE id=$2 AND empresa_id=$3 RETURNING *
  `, [`\n[ABATE ${data_abate||new Date().toISOString().split('T')[0]}] ${motivo||''} Valor venda: ${valor_venda||0}€`, req.params.id, req.empresaId]);
  res.json(ativo);
});

// ══════════════════════════════════════════════════════════════════════════════
// DEPRECIAÇÕES
// ══════════════════════════════════════════════════════════════════════════════
async function gerarPlanoDep(ativo, empresaId) {
  const dataInicio = new Date(ativo.data_inicio_uso || ativo.data_aquisicao);
  const anoInicio = dataInicio.getFullYear();
  const taxa = parseFloat(ativo.taxa_depreciacao);
  const valAq = parseFloat(ativo.valor_aquisicao);
  const valRes = parseFloat(ativo.valor_residual || 0);
  const vidaUtil = Math.ceil(1 / taxa);

  let valorRestante = valAq;
  let depAcumulada = 0;

  for (let i = 0; i < vidaUtil && valorRestante > valRes; i++) {
    const ano = anoInicio + i;
    const depAno = Math.min(
      Math.round(valAq * taxa * 100) / 100,
      Math.round((valorRestante - valRes) * 100) / 100
    );
    if (depAno <= 0) break;

    depAcumulada += depAno;
    valorRestante -= depAno;

    await query(`
      INSERT INTO depreciacao_linha (ativo_id, empresa_id, ano, valor_inicio_ano, taxa_depreciacao, valor_depreciacao, depreciacao_acumulada, valor_liquido_fim)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (ativo_id, ano) DO NOTHING
    `, [ativo.id, empresaId, ano, valorRestante + depAno, taxa, depAno, depAcumulada, Math.max(valRes, valorRestante)]);
  }
}

// Registar depreciação do ano (marcar como contabilizada)
router.patch('/:id/depreciacoes/:ano/registar', async (req, res) => {
  const { rows: [linha] } = await query(`
    UPDATE depreciacao_linha SET registado=true
    WHERE ativo_id=$1 AND ano=$2 RETURNING *
  `, [req.params.id, req.params.ano]);

  if (linha) {
    await query(`
      UPDATE ativo_fixo SET depreciacao_acumulada=$1, valor_liquido=$2
      WHERE id=$3
    `, [linha.depreciacao_acumulada, linha.valor_liquido_fim, req.params.id]);
  }
  res.json(linha);
});

// Mapa de depreciações do ano (para contabilidade)

// ── Amortizações ──────────────────────────────────────────────────────────────

