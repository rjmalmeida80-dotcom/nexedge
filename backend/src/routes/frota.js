'use strict';
const router = require('express').Router();
const { autenticar, autorizar } = require('../middleware/auth');
const { query } = require('../config/database');

const ADMIN = ['admin_empresa', 'rh', 'diretor'];
router.use(autenticar, autorizar(...ADMIN));

// ══════════════════════════════════════════════════════════════════════════════
// VIATURAS
// ══════════════════════════════════════════════════════════════════════════════
router.get('/viaturas', async (req, res) => {
  const { rows } = await query(`
    SELECT v.*, f.nome_completo AS condutor_nome,
      -- Seguro activo
      (SELECT vs.data_fim FROM viatura_seguro vs WHERE vs.viatura_id=v.id AND vs.data_fim >= CURRENT_DATE ORDER BY vs.data_fim DESC LIMIT 1) AS seguro_valido_ate,
      -- Proxima inspecao
      (SELECT vi.data_proxima FROM viatura_inspecao vi WHERE vi.viatura_id=v.id ORDER BY vi.data_inspecao DESC LIMIT 1) AS proxima_inspecao,
      -- Custos totais
      COALESCE((SELECT SUM(vm.custo) FROM viatura_manutencao vm WHERE vm.viatura_id=v.id), 0) +
      COALESCE((SELECT SUM(va.valor_total) FROM viatura_abastecimento va WHERE va.viatura_id=v.id), 0) AS custo_total
    FROM viatura v
    LEFT JOIN funcionario f ON f.id = v.condutor_id
    WHERE v.empresa_id=$1 AND v.estado IN ('ativo','activa')
    ORDER BY v.matricula
  `, [req.empresaId]);
  res.json(rows);
});

router.get('/viaturas/:id', async (req, res) => {
  const { rows:[v] } = await query(`
    SELECT v.*, f.nome_completo AS condutor_nome
    FROM viatura v LEFT JOIN funcionario f ON f.id=v.condutor_id
    WHERE v.id=$1 AND v.empresa_id=$2
  `, [req.params.id, req.empresaId]);
  if (!v) return res.status(404).json({ error: 'Viatura não encontrada' });

  const [seguros, inspecoes, manutencoes, abastecimentos] = await Promise.all([
    query('SELECT * FROM viatura_seguro WHERE viatura_id=$1 ORDER BY data_fim DESC', [req.params.id]),
    query('SELECT * FROM viatura_inspecao WHERE viatura_id=$1 ORDER BY data_inspecao DESC', [req.params.id]),
    query('SELECT * FROM viatura_manutencao WHERE viatura_id=$1 ORDER BY data_manutencao DESC LIMIT 20', [req.params.id]),
    query('SELECT va.*, f.nome_completo AS condutor FROM viatura_abastecimento va LEFT JOIN funcionario f ON f.id=va.condutor_id WHERE va.viatura_id=$1 ORDER BY va.data_abastecimento DESC LIMIT 20', [req.params.id]),
  ]);

  res.json({ ...v, seguros: seguros.rows, inspecoes: inspecoes.rows, manutencoes: manutencoes.rows, abastecimentos: abastecimentos.rows });
});

router.post('/viaturas', async (req, res) => {
  const { matricula, marca, modelo, ano, tipo, combustivel, cor, numero_quadro, lugares, condutor_id, localizacao, km_actuais, notas } = req.body;
  if (!matricula) return res.status(400).json({ error: 'Matrícula obrigatória' });
  const { rows:[v] } = await query(`
    INSERT INTO viatura (empresa_id, matricula, marca, modelo, ano, tipo, combustivel, cor, numero_quadro, lugares, condutor_id, localizacao, km_actuais, notas)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *
  `, [req.empresaId, matricula.toUpperCase(), marca||null, modelo||null, ano||null, tipo||'ligeiro_passageiros', combustivel||'gasolina', cor||null, numero_quadro||null, lugares||5, condutor_id||null, localizacao||null, km_actuais||0, notas||null]);
  res.status(201).json(v);
});

router.put('/viaturas/:id', async (req, res) => {
  const { marca, modelo, cor, condutor_id, localizacao, km_actuais, estado, notas, km_proxima_manutencao } = req.body;
  const { rows:[v] } = await query(`
    UPDATE viatura SET marca=$1, modelo=$2, cor=$3, condutor_id=$4, localizacao=$5,
      km_actuais=$6, estado=COALESCE($7,estado), notas=$8, km_proxima_manutencao=$9
    WHERE id=$10 AND empresa_id=$11 RETURNING *
  `, [marca||null, modelo||null, cor||null, condutor_id||null, localizacao||null, km_actuais||0, estado||null, notas||null, km_proxima_manutencao||null, req.params.id, req.empresaId]);
  res.json(v);
});

// ── Seguros ───────────────────────────────────────────────────────────────────
router.post('/viaturas/:id/seguros', async (req, res) => {
  const { seguradora, numero_apolice, tipo, data_inicio, data_fim, premio_anual, contacto_seguradora, notas } = req.body;
  if (!seguradora || !data_inicio || !data_fim) return res.status(400).json({ error: 'Campos obrigatórios em falta' });
  const { rows:[s] } = await query(`
    INSERT INTO viatura_seguro (viatura_id, empresa_id, seguradora, numero_apolice, tipo, data_inicio, data_fim, premio_anual, contacto_seguradora, notas)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
  `, [req.params.id, req.empresaId, seguradora, numero_apolice||null, tipo||'responsabilidade_civil', data_inicio, data_fim, premio_anual||null, contacto_seguradora||null, notas||null]);
  res.status(201).json(s);
});

// ── Inspecções ────────────────────────────────────────────────────────────────
router.post('/viaturas/:id/inspecoes', async (req, res) => {
  const { tipo, data_inspecao, data_proxima, resultado, km_inspecao, centro_inspecao, custo, notas } = req.body;
  const { rows:[i] } = await query(`
    INSERT INTO viatura_inspecao (viatura_id, empresa_id, tipo, data_inspecao, data_proxima, resultado, km_inspecao, centro_inspecao, custo, notas)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
  `, [req.params.id, req.empresaId, tipo||'ipt', data_inspecao, data_proxima||null, resultado||'aprovado', km_inspecao||null, centro_inspecao||null, custo||null, notas||null]);
  res.status(201).json(i);
});

// ── Manutenções ───────────────────────────────────────────────────────────────
router.post('/viaturas/:id/manutencoes', async (req, res) => {
  const { tipo, data_manutencao, km_manutencao, km_proxima, data_proxima, fornecedor, custo, descricao } = req.body;
  if (!tipo || !data_manutencao) return res.status(400).json({ error: 'Tipo e data obrigatórios' });
  const { rows:[m] } = await query(`
    INSERT INTO viatura_manutencao (viatura_id, empresa_id, tipo, data_manutencao, km_manutencao, km_proxima, data_proxima, fornecedor, custo, descricao)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
  `, [req.params.id, req.empresaId, tipo, data_manutencao, km_manutencao||null, km_proxima||null, data_proxima||null, fornecedor||null, custo||null, descricao||null]);

  // Actualizar km proxima manutenção na viatura
  if (km_proxima) await query('UPDATE viatura SET km_proxima_manutencao=$1 WHERE id=$2', [km_proxima, req.params.id]);
  res.status(201).json(m);
});

// ── Abastecimentos ────────────────────────────────────────────────────────────
router.post('/viaturas/:id/abastecimentos', async (req, res) => {
  const { condutor_id, data_abastecimento, litros, preco_litro, valor_total, km_abastecimento, posto, tipo_combustivel } = req.body;
  const val = valor_total || (litros && preco_litro ? parseFloat(litros) * parseFloat(preco_litro) : null);
  const { rows:[a] } = await query(`
    INSERT INTO viatura_abastecimento (viatura_id, empresa_id, condutor_id, data_abastecimento, litros, preco_litro, valor_total, km_abastecimento, posto, tipo_combustivel)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
  `, [req.params.id, req.empresaId, condutor_id||null, data_abastecimento||new Date().toISOString().split('T')[0], litros||null, preco_litro||null, val||null, km_abastecimento||null, posto||null, tipo_combustivel||null]);

  if (km_abastecimento) {
    await query('UPDATE viatura SET km_actuais=$1 WHERE id=$2 AND km_actuais < $1', [km_abastecimento, req.params.id]);
    
    // Verificar alertas automáticos após actualização de KM
    const { rows:[vAtual] } = await query('SELECT * FROM viatura WHERE id=$1', [req.params.id]);
    if (vAtual?.km_proxima_manutencao) {
      const kmRestantes = vAtual.km_proxima_manutencao - parseInt(km_abastecimento);
      if (kmRestantes <= 1000 && kmRestantes > 0) {
        a.alerta_manutencao = { tipo: 'warning', mensagem: `Manutenção em ${kmRestantes.toLocaleString('pt-PT')} km`, km_restantes: kmRestantes };
      } else if (kmRestantes <= 0) {
        a.alerta_manutencao = { tipo: 'urgent', mensagem: 'Manutenção URGENTE — KM ultrapassados!', km_restantes: kmRestantes };
      }
    }
  }
  res.status(201).json(a);
});


// ── Alertas automáticos ───────────────────────────────────────────────────────
router.get('/alertas', async (req, res) => {
  try {
    // Viaturas com manutenção próxima (km actuais >= km próxima manutenção - 1000)
    const { rows: manutencoes } = await query(
      "SELECT matricula, marca, modelo, km_actuais, km_proxima_manutencao FROM viatura WHERE empresa_id=$1 AND estado IN ('ativo','activa') AND km_proxima_manutencao IS NOT NULL AND km_actuais >= km_proxima_manutencao - 1000 ORDER BY matricula",
      [req.empresaId]
    );
    // Seguros e IUC via tabela seguro_viatura
    const { rows: seguros } = await query(
      "SELECT v.matricula, v.marca, v.modelo, s.data_fim FROM seguro_viatura s JOIN viatura v ON v.id=s.viatura_id WHERE v.empresa_id=$1 AND s.data_fim >= CURRENT_DATE AND s.data_fim <= CURRENT_DATE + INTERVAL '30 days' ORDER BY s.data_fim",
      [req.empresaId]
    ).catch(() => ({ rows: [] }));
    res.json({ alertas: { manutencoes, seguros }, total: manutencoes.length + seguros.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Dashboard ─────────────────────────────────────────────────────────────────
router.get('/dashboard', async (req, res) => {
  const eid = req.empresaId;
  const hoje = new Date().toISOString().split('T')[0];
  const em30dias = new Date(Date.now() + 30*24*60*60*1000).toISOString().split('T')[0];

  const { rows:[resumo] } = await query(`
    SELECT
      COUNT(*) FILTER (WHERE estado IN ('ativo','activa')) AS total_viaturas,
      COUNT(*) FILTER (WHERE estado='inativo') AS inativas,
      COALESCE(SUM(km_actuais) FILTER (WHERE estado IN ('ativo','activa')), 0) AS km_totais
    FROM viatura WHERE empresa_id=$1
  `, [eid]);

  // Custos do mês
  const mesAtual = new Date().getMonth() + 1;
  const anoAtual = new Date().getFullYear();
  const { rows:[custos] } = await query(`
    SELECT
      COALESCE((SELECT SUM(custo) FROM viatura_manutencao vm JOIN viatura v ON v.id=vm.viatura_id WHERE v.empresa_id=$1 AND EXTRACT(MONTH FROM vm.data_manutencao)=$2 AND EXTRACT(YEAR FROM vm.data_manutencao)=$3), 0) AS custo_manutencao,
      COALESCE((SELECT SUM(valor_total) FROM viatura_abastecimento va JOIN viatura v ON v.id=va.viatura_id WHERE v.empresa_id=$1 AND EXTRACT(MONTH FROM va.data_abastecimento)=$2 AND EXTRACT(YEAR FROM va.data_abastecimento)=$3), 0) AS custo_combustivel,
      COALESCE((SELECT SUM(premio_anual)/12 FROM viatura_seguro vs JOIN viatura v ON v.id=vs.viatura_id WHERE v.empresa_id=$1 AND vs.data_fim >= $4), 0) AS custo_seguros
  `, [eid, mesAtual, anoAtual, hoje]);

  // Alertas — seguros a vencer
  const { rows: segurosVencer } = await query(`
    SELECT v.matricula, v.marca, v.modelo, vs.seguradora, vs.data_fim,
      vs.data_fim - CURRENT_DATE AS dias_restantes
    FROM viatura_seguro vs JOIN viatura v ON v.id=vs.viatura_id
    WHERE v.empresa_id=$1 AND vs.data_fim BETWEEN $2 AND $3
    ORDER BY vs.data_fim ASC
  `, [eid, hoje, em30dias]);

  // Alertas — inspecções a vencer
  const { rows: inspecoesVencer } = await query(`
    SELECT v.matricula, v.marca, v.modelo, vi.data_proxima,
      vi.data_proxima - CURRENT_DATE AS dias_restantes
    FROM viatura_inspecao vi JOIN viatura v ON v.id=vi.viatura_id
    WHERE v.empresa_id=$1 AND vi.data_proxima BETWEEN $2 AND $3
    ORDER BY vi.data_proxima ASC
  `, [eid, hoje, em30dias]);

  // Alertas — km manutenção
  const { rows: kmAlert } = await query(`
    SELECT matricula, marca, modelo, km_actuais, km_proxima_manutencao,
      km_proxima_manutencao - km_actuais AS km_restantes
    FROM viatura WHERE empresa_id=$1 AND estado IN ('ativo','activa')
      AND km_proxima_manutencao IS NOT NULL
      AND km_proxima_manutencao - km_actuais <= 1000
    ORDER BY km_restantes ASC
  `, [eid]);

  // Custos por viatura
  const { rows: porViatura } = await query(`
    SELECT v.matricula, v.marca, v.modelo,
      COALESCE((SELECT SUM(custo) FROM viatura_manutencao WHERE viatura_id=v.id), 0) +
      COALESCE((SELECT SUM(valor_total) FROM viatura_abastecimento WHERE viatura_id=v.id), 0) AS custo_total
    FROM viatura v WHERE v.empresa_id=$1 AND v.estado IN ('ativo','activa')
    ORDER BY custo_total DESC LIMIT 5
  `, [eid]);

  res.json({
    resumo: { ...resumo, ...custos, custo_total_mes: parseFloat(custos.custo_manutencao||0)+parseFloat(custos.custo_combustivel||0)+parseFloat(custos.custo_seguros||0) },
    alertas: { segurosVencer, inspecoesVencer, kmAlert },
    porViatura,
  });
});


// ══════════════════════════════════════════════════════════════════════════════
// MULTAS
// ══════════════════════════════════════════════════════════════════════════════
router.get('/multas', async (req, res) => {
  const { rows } = await query(`
    SELECT vm.*, v.matricula, v.marca, v.modelo, f.nome_completo AS condutor_nome
    FROM viatura_multa vm
    JOIN viatura v ON v.id = vm.viatura_id
    LEFT JOIN funcionario f ON f.id = vm.condutor_id
    WHERE vm.empresa_id=$1
    ORDER BY vm.data_multa DESC
  `, [req.empresaId]);
  res.json(rows);
});

router.post('/multas', async (req, res) => {
  const { viatura_id, condutor_id, data_multa, local, infracao, valor, pontos_perdidos, numero_processo, notas } = req.body;
  if (!viatura_id || !data_multa) return res.status(400).json({ error: 'Viatura e data obrigatórios' });
  const { rows:[m] } = await query(`
    INSERT INTO viatura_multa (viatura_id, empresa_id, condutor_id, data_multa, local, infracao, valor, pontos_perdidos, numero_processo, estado, notas)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pendente',$10) RETURNING *
  `, [viatura_id, req.empresaId, condutor_id||null, data_multa, local||null, infracao||null, valor||null, pontos_perdidos||0, numero_processo||null, notas||null]);
  res.status(201).json(m);
});

router.patch('/multas/:id/pagar', async (req, res) => {
  const { rows:[m] } = await query(
    "UPDATE viatura_multa SET estado='paga', data_pagamento=CURRENT_DATE WHERE id=$1 AND empresa_id=$2 RETURNING *",
    [req.params.id, req.empresaId]
  );
  res.json(m);
});

// ══════════════════════════════════════════════════════════════════════════════
// CARTAS DE CONDUÇÃO
// ══════════════════════════════════════════════════════════════════════════════
router.get('/cartas', async (req, res) => {
  const { rows } = await query(`
    SELECT cc.*, f.nome_completo, f.cargo
    FROM carta_conducao cc
    JOIN funcionario f ON f.id = cc.funcionario_id
    WHERE cc.empresa_id=$1
    ORDER BY f.nome_completo
  `, [req.empresaId]);
  res.json(rows);
});

router.post('/cartas', async (req, res) => {
  const { funcionario_id, numero_carta, categorias, data_emissao, data_validade, pontos_actuais, notas } = req.body;
  if (!funcionario_id) return res.status(400).json({ error: 'Funcionário obrigatório' });
  const { rows:[c] } = await query(`
    INSERT INTO carta_conducao (empresa_id, funcionario_id, numero_carta, categorias, data_emissao, data_validade, pontos_actuais, notas)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (empresa_id, funcionario_id) DO UPDATE SET
      numero_carta=$3, categorias=$4, data_emissao=$5, data_validade=$6, pontos_actuais=$7, notas=$8
    RETURNING *
  `, [req.empresaId, funcionario_id, numero_carta||null, categorias||'B', data_emissao||null, data_validade||null, pontos_actuais||12, notas||null]);
  res.status(201).json(c);
});



// ══════════════════════════════════════════════════════════════════════════════
// CARTÕES FROTA
// ══════════════════════════════════════════════════════════════════════════════
router.get('/cartoes', async (req, res) => {
  const { rows } = await query(`
    SELECT cf.*, v.matricula, v.marca, v.modelo, f.nome_completo AS condutor_nome,
      COALESCE((SELECT SUM(ct.valor) FROM cartao_transacao ct WHERE ct.cartao_id=cf.id
        AND EXTRACT(MONTH FROM ct.data_transacao)=EXTRACT(MONTH FROM NOW())
        AND EXTRACT(YEAR FROM ct.data_transacao)=EXTRACT(YEAR FROM NOW())), 0) AS gasto_mes
    FROM cartao_frota cf
    LEFT JOIN viatura v ON v.id=cf.viatura_id
    LEFT JOIN funcionario f ON f.id=cf.condutor_id
    WHERE cf.empresa_id=$1 AND cf.ativo=true
    ORDER BY v.matricula
  `, [req.empresaId]);
  res.json(rows);
});

router.post('/cartoes', async (req, res) => {
  const { viatura_id, numero_cartao, fornecedor, condutor_id, tipo_combustivel, limite_mensal, notas } = req.body;
  if (!numero_cartao || !fornecedor) return res.status(400).json({ error: 'Número e fornecedor obrigatórios' });
  const { rows:[c] } = await query(`
    INSERT INTO cartao_frota (empresa_id, viatura_id, numero_cartao, fornecedor, condutor_id, tipo_combustivel, limite_mensal, notas)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
  `, [req.empresaId, viatura_id||null, numero_cartao, fornecedor, condutor_id||null, tipo_combustivel||'todos', limite_mensal||null, notas||null]);
  res.status(201).json(c);
});

// Importar CSV do cartão frota
router.post('/cartoes/:id/importar-csv', async (req, res) => {
  const { linhas } = req.body; // Array de transacções
  if (!linhas?.length) return res.status(400).json({ error: 'Sem dados para importar' });

  const { rows:[cartao] } = await query('SELECT * FROM cartao_frota WHERE id=$1 AND empresa_id=$2', [req.params.id, req.empresaId]);
  if (!cartao) return res.status(404).json({ error: 'Cartão não encontrado' });

  let importadas = 0;
  for (const l of linhas) {
    try {
      await query(`
        INSERT INTO cartao_transacao (cartao_id, viatura_id, empresa_id, data_transacao, tipo, descricao, litros, preco_litro, valor, km_viatura, posto, localidade, importado)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true)
      `, [cartao.id, cartao.viatura_id, req.empresaId,
          l.data_transacao, l.tipo||'combustivel', l.descricao||null,
          l.litros||null, l.preco_litro||null, parseFloat(l.valor||0),
          l.km_viatura||null, l.posto||null, l.localidade||null]);

      // Actualizar KM da viatura se disponível
      if (l.km_viatura && cartao.viatura_id) {
        await query('UPDATE viatura SET km_actuais=$1 WHERE id=$2 AND km_actuais < $1', [l.km_viatura, cartao.viatura_id]);
      }
      importadas++;
    } catch(e) { /* linha duplicada — ignorar */ }
  }

  // Sincronizar com tabela de abastecimentos
  const { rows: trans } = await query(`
    SELECT * FROM cartao_transacao WHERE cartao_id=$1 AND tipo='combustivel' AND importado=true
    AND NOT EXISTS (
      SELECT 1 FROM viatura_abastecimento va
      WHERE va.viatura_id=$2 AND va.data_abastecimento=ct.data_transacao::date AND va.valor_total=ct.valor
    )
  `, [cartao.id, cartao.viatura_id]);

  for (const t of trans) {
    if (cartao.viatura_id) {
      await query(`
        INSERT INTO viatura_abastecimento (viatura_id, empresa_id, data_abastecimento, litros, preco_litro, valor_total, km_abastecimento, posto)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING
      `, [cartao.viatura_id, req.empresaId, t.data_transacao, t.litros, t.preco_litro, t.valor, t.km_viatura, t.posto]);
    }
  }

  res.json({ importadas, total: linhas.length });
});

router.get('/cartoes/:id/transacoes', async (req, res) => {
  const { mes, ano } = req.query;
  let where = 'ct.cartao_id=$1';
  const params = [req.params.id];
  let p = 2;
  if (ano) { where += ` AND EXTRACT(YEAR FROM ct.data_transacao)=$${p++}`; params.push(ano); }
  if (mes) { where += ` AND EXTRACT(MONTH FROM ct.data_transacao)=$${p++}`; params.push(mes); }

  const { rows } = await query(`
    SELECT ct.* FROM cartao_transacao ct WHERE ${where} ORDER BY ct.data_transacao DESC LIMIT 100
  `, params);
  res.json(rows);
});

// ══════════════════════════════════════════════════════════════════════════════
// IUC — Imposto Único de Circulação
// ══════════════════════════════════════════════════════════════════════════════
router.get('/iuc', async (req, res) => {
  const anoAtual = new Date().getFullYear();
  const { rows } = await query(`
    SELECT vi.*, v.matricula, v.marca, v.modelo, v.ano AS ano_viatura, v.mes_matricula, v.iuc_valor_anual
    FROM viatura_iuc vi
    JOIN viatura v ON v.id=vi.viatura_id
    WHERE vi.empresa_id=$1 AND vi.ano=$2
    ORDER BY vi.mes_vencimento
  `, [req.empresaId, anoAtual]);

  // Viaturas sem IUC registado este ano
  const { rows: semIuc } = await query(`
    SELECT v.* FROM viatura v
    WHERE v.empresa_id=$1 AND v.estado IN ('ativo','activa')
      AND NOT EXISTS (SELECT 1 FROM viatura_iuc vi WHERE vi.viatura_id=v.id AND vi.ano=$2)
  `, [req.empresaId, anoAtual]);

  res.json({ registados: rows, sem_iuc: semIuc, ano: anoAtual });
});

router.post('/iuc', async (req, res) => {
  const { viatura_id, ano, valor, mes_vencimento } = req.body;
  if (!viatura_id) return res.status(400).json({ error: 'Viatura obrigatória' });
  const anoAtual = ano || new Date().getFullYear();
  const { rows:[iuc] } = await query(`
    INSERT INTO viatura_iuc (viatura_id, empresa_id, ano, valor, mes_vencimento, estado)
    VALUES ($1,$2,$3,$4,$5,'pendente')
    ON CONFLICT (viatura_id, ano) DO UPDATE SET valor=$4, mes_vencimento=$5
    RETURNING *
  `, [viatura_id, req.empresaId, anoAtual, valor||null, mes_vencimento||null]);

  // Actualizar valor anual na viatura
  if (valor) await query('UPDATE viatura SET iuc_valor_anual=$1 WHERE id=$2', [valor, viatura_id]);
  res.status(201).json(iuc);
});

router.patch('/iuc/:id/pagar', async (req, res) => {
  const { rows:[iuc] } = await query(
    "UPDATE viatura_iuc SET estado='pago', data_pagamento=CURRENT_DATE WHERE id=$1 AND empresa_id=$2 RETURNING *",
    [req.params.id, req.empresaId]
  );
  res.json(iuc);
});

// ══════════════════════════════════════════════════════════════════════════════
// CALCULAR PRÓXIMA INSPECÇÃO AUTOMATICAMENTE
// ══════════════════════════════════════════════════════════════════════════════
router.get('/viaturas/:id/proxima-inspecao', async (req, res) => {
  const { rows:[v] } = await query('SELECT * FROM viatura WHERE id=$1 AND empresa_id=$2', [req.params.id, req.empresaId]);
  if (!v) return res.status(404).json({ error: 'Viatura não encontrada' });

  const anoActual = new Date().getFullYear();
  const idadeViatura = v.ano ? anoActual - v.ano : 0;

  // Regras PT — Decreto-Lei 127/2013
  let periodicidadeAnos = 2;
  let descricao = '';

  if (v.tipo === 'pesado') {
    periodicidadeAnos = 0.5; // 6 meses
    descricao = 'Pesado — inspecção semestral obrigatória';
  } else if (v.tipo === 'ligeiro_mercadorias') {
    periodicidadeAnos = 1;
    descricao = 'Ligeiro mercadorias — inspecção anual';
  } else if (idadeViatura < 4) {
    periodicidadeAnos = 999; // Isento
    descricao = 'Viatura < 4 anos — isenta de inspecção';
  } else if (idadeViatura < 7) {
    periodicidadeAnos = 2;
    descricao = 'Viatura 4-7 anos — inspecção de 2 em 2 anos';
  } else {
    periodicidadeAnos = 1;
    descricao = 'Viatura > 7 anos — inspecção anual';
  }

  // Buscar última inspecção
  const { rows:[ultima] } = await query(
    'SELECT * FROM viatura_inspecao WHERE viatura_id=$1 ORDER BY data_inspecao DESC LIMIT 1',
    [req.params.id]
  );

  let proximaData = null;
  if (ultima && periodicidadeAnos < 999) {
    const dataUltima = new Date(ultima.data_inspecao);
    dataUltima.setMonth(dataUltima.getMonth() + Math.round(periodicidadeAnos * 12));
    proximaData = dataUltima.toISOString().split('T')[0];
  }

  res.json({
    viatura_id: v.id,
    matricula: v.matricula,
    ano_viatura: v.ano,
    idade_anos: idadeViatura,
    tipo: v.tipo,
    periodicidade_anos: periodicidadeAnos,
    descricao,
    ultima_inspecao: ultima ? ultima.data_inspecao : null,
    proxima_inspecao_calculada: proximaData,
    isenta: periodicidadeAnos >= 999,
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// CUSTO POR KM — calculado automaticamente
// ══════════════════════════════════════════════════════════════════════════════
router.get('/viaturas/:id/custo-km', async (req, res) => {
  const { rows:[v] } = await query('SELECT * FROM viatura WHERE id=$1 AND empresa_id=$2', [req.params.id, req.empresaId]);
  if (!v) return res.status(404).json({ error: 'Viatura não encontrada' });

  const { rows:[custos] } = await query(`
    SELECT
      COALESCE(SUM(va.valor_total), 0) AS total_combustivel,
      COALESCE(SUM(va.litros), 0) AS total_litros,
      COUNT(va.id) AS num_abastecimentos,
      MIN(va.km_abastecimento) AS km_inicio,
      MAX(va.km_abastecimento) AS km_fim
    FROM viatura_abastecimento va
    WHERE va.viatura_id=$1
  `, [req.params.id]);

  const { rows:[manutCustos] } = await query(`
    SELECT COALESCE(SUM(vm.custo), 0) AS total_manutencao
    FROM viatura_manutencao vm WHERE vm.viatura_id=$1
  `, [req.params.id]);

  const kmTotal = custos.km_fim && custos.km_inicio ? custos.km_fim - custos.km_inicio : v.km_actuais || 0;
  const totalCustos = parseFloat(custos.total_combustivel||0) + parseFloat(manutCustos.total_manutencao||0);
  const custoPorKm = kmTotal > 0 ? totalCustos / kmTotal : 0;
  const consumoMedio = custos.total_litros > 0 && kmTotal > 0 ? (parseFloat(custos.total_litros) / kmTotal * 100) : 0;

  res.json({
    matricula: v.matricula,
    km_actuais: v.km_actuais,
    km_registados: kmTotal,
    total_combustivel: parseFloat(custos.total_combustivel||0),
    total_manutencao: parseFloat(manutCustos.total_manutencao||0),
    total_custos: totalCustos,
    custo_por_km: Math.round(custoPorKm * 100) / 100,
    consumo_medio_l100km: Math.round(consumoMedio * 100) / 100,
    num_abastecimentos: parseInt(custos.num_abastecimentos||0),
  });
});

module.exports = router;
