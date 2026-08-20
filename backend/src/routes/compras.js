'use strict';
const router = require('express').Router();
const { autenticar, autorizar } = require('../middleware/auth');
const { query } = require('../config/database');

const ADMIN = ['admin_empresa', 'rh', 'diretor'];
router.use(autenticar, autorizar(...ADMIN));

// ══════════════════════════════════════════════════════════════════════════════
// FORNECEDORES
// ══════════════════════════════════════════════════════════════════════════════
router.get('/fornecedores', async (req, res) => {
  const { rows } = await query('SELECT * FROM fornecedor WHERE empresa_id=$1 AND ativo=true ORDER BY nome', [req.empresaId]);
  res.json(rows);
});

router.post('/fornecedores', async (req, res) => {
  const { nome, nif, email, telefone, morada, codigo_postal, localidade, pais, iban, banco, condicoes_pagamento, categoria, notas } = req.body;
  if (!nome) return res.status(400).json({ error: 'Nome obrigatório' });
  const { rows } = await query(`
    INSERT INTO fornecedor (empresa_id, nome, nif, email, telefone, morada, codigo_postal, localidade, pais, iban, banco, condicoes_pagamento, categoria, notas)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *
  `, [req.empresaId, nome, nif||null, email||null, telefone||null, morada||null, codigo_postal||null, localidade||null, pais||'PT', iban||null, banco||null, condicoes_pagamento||30, categoria||null, notas||null]);
  res.status(201).json(rows[0]);
});

router.put('/fornecedores/:id', async (req, res) => {
  const { nome, nif, email, telefone, morada, codigo_postal, localidade, pais, iban, banco, condicoes_pagamento, categoria, notas } = req.body;
  const { rows } = await query(`
    UPDATE fornecedor SET nome=$1, nif=$2, email=$3, telefone=$4, morada=$5, codigo_postal=$6, localidade=$7, pais=$8, iban=$9, banco=$10, condicoes_pagamento=$11, categoria=$12, notas=$13
    WHERE id=$14 AND empresa_id=$15 RETURNING *
  `, [nome, nif||null, email||null, telefone||null, morada||null, codigo_postal||null, localidade||null, pais||'PT', iban||null, banco||null, condicoes_pagamento||30, categoria||null, notas||null, req.params.id, req.empresaId]);
  res.json(rows[0]);
});

router.delete('/fornecedores/:id', async (req, res) => {
  await query('UPDATE fornecedor SET ativo=false WHERE id=$1 AND empresa_id=$2', [req.params.id, req.empresaId]);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// ARTIGOS / STOCK
// ══════════════════════════════════════════════════════════════════════════════
router.get('/artigos', async (req, res) => {
  const { tipo, search, stock_baixo } = req.query;
  let where = 'a.empresa_id=$1 AND a.ativo=true';
  const params = [req.empresaId];
  let p = 2;
  if (tipo) { where += ` AND a.tipo=$${p++}`; params.push(tipo); }
  if (search) { where += ` AND (a.nome ILIKE $${p} OR a.codigo ILIKE $${p++})`; params.push(`%${search}%`); }
  if (stock_baixo === 'true') { where += ' AND a.stock_atual <= a.stock_minimo AND a.tipo=\'produto\''; }

  const { rows } = await query(`
    SELECT a.*, c.nome AS categoria_nome
    FROM artigo a
    LEFT JOIN artigo_categoria c ON c.id = a.categoria_id
    WHERE ${where}
    ORDER BY a.nome
  `, params);
  res.json(rows);
});

router.post('/artigos', async (req, res) => {
  const { codigo, nome, descricao, tipo, unidade, preco_venda, preco_custo, taxa_iva_venda, taxa_iva_compra, stock_atual, stock_minimo, stock_maximo, localizacao, categoria_id } = req.body;
  if (!nome) return res.status(400).json({ error: 'Nome obrigatório' });
  const { rows } = await query(`
    INSERT INTO artigo (empresa_id, codigo, nome, descricao, tipo, unidade, preco_venda, preco_custo, taxa_iva_venda, taxa_iva_compra, stock_atual, stock_minimo, stock_maximo, localizacao, categoria_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *
  `, [req.empresaId, codigo||null, nome, descricao||null, tipo||'produto', unidade||'un',
      preco_venda||0, preco_custo||0, taxa_iva_venda||23, taxa_iva_compra||23,
      stock_atual||0, stock_minimo||0, stock_maximo||0, localizacao||null, categoria_id||null]);
  res.status(201).json(rows[0]);
});

router.put('/artigos/:id', async (req, res) => {
  const { codigo, nome, descricao, tipo, unidade, preco_venda, preco_custo, taxa_iva_venda, taxa_iva_compra, stock_minimo, stock_maximo, localizacao, categoria_id } = req.body;
  const { rows } = await query(`
    UPDATE artigo SET codigo=$1, nome=$2, descricao=$3, tipo=$4, unidade=$5,
      preco_venda=$6, preco_custo=$7, taxa_iva_venda=$8, taxa_iva_compra=$9,
      stock_minimo=$10, stock_maximo=$11, localizacao=$12, categoria_id=$13
    WHERE id=$14 AND empresa_id=$15 RETURNING *
  `, [codigo||null, nome, descricao||null, tipo||'produto', unidade||'un',
      preco_venda||0, preco_custo||0, taxa_iva_venda||23, taxa_iva_compra||23,
      stock_minimo||0, stock_maximo||0, localizacao||null, categoria_id||null,
      req.params.id, req.empresaId]);
  res.json(rows[0]);
});

// Ajuste manual de stock
router.post('/artigos/:id/ajuste-stock', async (req, res) => {
  const { quantidade, tipo, notas } = req.body;
  const { rows: [artigo] } = await query('SELECT * FROM artigo WHERE id=$1 AND empresa_id=$2', [req.params.id, req.empresaId]);
  if (!artigo) return res.status(404).json({ error: 'Artigo não encontrado' });

  const qtdAnterior = parseFloat(artigo.stock_atual);
  const qtdNova = tipo === 'saida' ? qtdAnterior - parseFloat(quantidade) : qtdAnterior + parseFloat(quantidade);

  await query('UPDATE artigo SET stock_atual=$1 WHERE id=$2', [qtdNova, req.params.id]);
  await query(`
    INSERT INTO stock_movimento (empresa_id, artigo_id, tipo, quantidade, quantidade_anterior, quantidade_nova, notas, criado_por)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
  `, [req.empresaId, req.params.id, tipo||'entrada', parseFloat(quantidade), qtdAnterior, qtdNova, notas||null, req.utilizador.id]);

  res.json({ artigo_id: req.params.id, stock_anterior: qtdAnterior, stock_novo: qtdNova });
});

// Histórico de movimentos
router.get('/artigos/:id/movimentos', async (req, res) => {
  const { rows } = await query(`
    SELECT m.*, u.nome_completo AS criado_por_nome
    FROM stock_movimento m
    LEFT JOIN utilizador u ON u.id = m.criado_por
    WHERE m.artigo_id=$1 AND m.empresa_id=$2
    ORDER BY m.criado_em DESC LIMIT 50
  `, [req.params.id, req.empresaId]);
  res.json(rows);
});

// Alertas de stock mínimo
router.get('/artigos/alertas-stock', async (req, res) => {
  const { rows } = await query(`
    SELECT a.*, c.nome AS categoria_nome
    FROM artigo a
    LEFT JOIN artigo_categoria c ON c.id = a.categoria_id
    WHERE a.empresa_id=$1 AND a.ativo=true AND a.tipo='produto'
      AND a.stock_atual <= a.stock_minimo
    ORDER BY (a.stock_atual - a.stock_minimo) ASC
  `, [req.empresaId]);
  res.json(rows);
});

// ══════════════════════════════════════════════════════════════════════════════
// COMPRAS
// ══════════════════════════════════════════════════════════════════════════════
router.get('/compras', async (req, res) => {
  const { estado, ano, mes, fornecedor_id } = req.query;
  let where = 'c.empresa_id=$1';
  const params = [req.empresaId];
  let p = 2;
  if (estado) { where += ` AND c.estado=$${p++}`; params.push(estado); }
  if (ano) { where += ` AND EXTRACT(YEAR FROM c.data_emissao)=$${p++}`; params.push(ano); }
  if (mes) { where += ` AND EXTRACT(MONTH FROM c.data_emissao)=$${p++}`; params.push(mes); }
  if (fornecedor_id) { where += ` AND c.fornecedor_id=$${p++}`; params.push(fornecedor_id); }

  const { rows } = await query(`
    SELECT c.*, f.nome AS fornecedor_nome_reg
    FROM compra c
    LEFT JOIN fornecedor f ON f.id = c.fornecedor_id
    WHERE ${where}
    ORDER BY c.data_emissao DESC
    LIMIT 200
  `, params);
  res.json(rows);
});

router.post('/compras', async (req, res) => {
  const { fornecedor_id, numero_doc, tipo_doc, data_emissao, data_vencimento, linhas, notas, categoria_despesa } = req.body;
  if (!linhas?.length) return res.status(400).json({ error: 'Compra sem linhas' });

  const { rows: [forn] } = fornecedor_id
    ? await query('SELECT * FROM fornecedor WHERE id=$1 AND empresa_id=$2', [fornecedor_id, req.empresaId])
    : { rows: [null] };

  let subtotal = 0, ivaTotal = 0;
  const linhasCalc = linhas.map((l, i) => {
    const sub = parseFloat(l.quantidade||1) * parseFloat(l.preco_unitario||0) * (1 - (parseFloat(l.desconto_perc)||0)/100);
    const iva = sub * parseFloat(l.taxa_iva||23) / 100;
    subtotal += sub; ivaTotal += iva;
    return { ...l, subtotal: Math.round(sub*100)/100, iva_valor: Math.round(iva*100)/100, total: Math.round((sub+iva)*100)/100, ordem: i+1 };
  });

  const total = Math.round((subtotal + ivaTotal) * 100) / 100;
  const venc = data_vencimento || (() => {
    const d = new Date(data_emissao || new Date());
    d.setDate(d.getDate() + (forn?.condicoes_pagamento || 30));
    return d.toISOString().split('T')[0];
  })();

  const { rows: [compra] } = await query(`
    INSERT INTO compra (empresa_id, fornecedor_id, numero_doc, tipo_doc, data_emissao, data_vencimento, fornecedor_nome, fornecedor_nif, subtotal, iva_total, total, estado, notas, categoria_despesa, criado_por)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pendente',$12,$13,$14) RETURNING *
  `, [req.empresaId, fornecedor_id||null, numero_doc||null, tipo_doc||'fatura',
      data_emissao||new Date().toISOString().split('T')[0], venc,
      forn?.nome||null, forn?.nif||null,
      Math.round(subtotal*100)/100, Math.round(ivaTotal*100)/100, total,
      notas||null, categoria_despesa||null, req.utilizador.id]);

  // Inserir linhas e actualizar stock
  for (const l of linhasCalc) {
    await query(`
      INSERT INTO compra_linha (compra_id, artigo_id, descricao, quantidade, preco_unitario, desconto_perc, taxa_iva, subtotal, iva_valor, total, ordem, actualiza_stock)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    `, [compra.id, l.artigo_id||null, l.descricao, l.quantidade, l.preco_unitario, l.desconto_perc||0, l.taxa_iva||23, l.subtotal, l.iva_valor, l.total, l.ordem, l.actualiza_stock !== false]);

    // Actualizar stock se for produto
    if (l.artigo_id && l.actualiza_stock !== false) {
      const { rows: [art] } = await query('SELECT stock_atual FROM artigo WHERE id=$1', [l.artigo_id]);
      if (art) {
        const novoStock = parseFloat(art.stock_atual) + parseFloat(l.quantidade);
        await query('UPDATE artigo SET stock_atual=$1 WHERE id=$2', [novoStock, l.artigo_id]);
        await query(`
          INSERT INTO stock_movimento (empresa_id, artigo_id, tipo, quantidade, quantidade_anterior, quantidade_nova, preco_unitario, referencia_tipo, referencia_id, criado_por)
          VALUES ($1,$2,'entrada',$3,$4,$5,$6,'compra',$7,$8)
        `, [req.empresaId, l.artigo_id, l.quantidade, art.stock_atual, novoStock, l.preco_unitario, compra.id, req.utilizador.id]);
      }
    }
  }

  res.status(201).json({ ...compra, linhas: linhasCalc });
});

router.get('/compras/:id', async (req, res) => {
  const { rows: [compra] } = await query('SELECT * FROM compra WHERE id=$1 AND empresa_id=$2', [req.params.id, req.empresaId]);
  if (!compra) return res.status(404).json({ error: 'Compra não encontrada' });
  const { rows: linhas } = await query('SELECT cl.*, a.nome AS artigo_nome FROM compra_linha cl LEFT JOIN artigo a ON a.id=cl.artigo_id WHERE cl.compra_id=$1 ORDER BY cl.ordem', [req.params.id]);
  res.json({ ...compra, linhas });
});

// Registar pagamento de compra
router.patch('/compras/:id/pagar', async (req, res) => {
  const { valor, metodo, data_pagamento } = req.body;
  const { rows: [c] } = await query('SELECT * FROM compra WHERE id=$1 AND empresa_id=$2', [req.params.id, req.empresaId]);
  if (!c) return res.status(404).json({ error: 'Compra não encontrada' });

  const novoPago = parseFloat(c.valor_pago||0) + parseFloat(valor||0);
  const estado = novoPago >= parseFloat(c.total) ? 'paga' : 'parcialmente_paga';

  const { rows } = await query(`
    UPDATE compra SET valor_pago=$1, estado=$2, metodo_pagamento=$3, data_pagamento=$4
    WHERE id=$5 RETURNING *
  `, [novoPago, estado, metodo||'transferencia', data_pagamento||new Date().toISOString().split('T')[0], req.params.id]);
  res.json(rows[0]);
});

// Dashboard de compras
router.get('/compras/dashboard/resumo', async (req, res) => {
  const { ano = new Date().getFullYear() } = req.query;
  const { rows: [resumo] } = await query(`
    SELECT
      COUNT(*) FILTER (WHERE estado NOT IN ('anulada')) AS total_docs,
      COALESCE(SUM(total) FILTER (WHERE estado NOT IN ('anulada')), 0) AS total_compras,
      COALESCE(SUM(iva_total) FILTER (WHERE estado NOT IN ('anulada')), 0) AS total_iva,
      COALESCE(SUM(total - valor_pago) FILTER (WHERE estado IN ('pendente','parcialmente_paga')), 0) AS em_divida,
      COUNT(*) FILTER (WHERE estado IN ('pendente','parcialmente_paga') AND data_vencimento < CURRENT_DATE) AS vencidas
    FROM compra WHERE empresa_id=$1 AND EXTRACT(YEAR FROM data_emissao)=$2
  `, [req.empresaId, ano]);

  const { rows: porMes } = await query(`
    SELECT EXTRACT(MONTH FROM data_emissao)::integer AS mes,
      COALESCE(SUM(total),0) AS total
    FROM compra WHERE empresa_id=$1 AND EXTRACT(YEAR FROM data_emissao)=$2 AND estado != 'anulada'
    GROUP BY mes ORDER BY mes
  `, [req.empresaId, ano]);

  const { rows: porCategoria } = await query(`
    SELECT COALESCE(categoria_despesa,'Sem categoria') AS categoria, SUM(total) AS total, COUNT(*) AS docs
    FROM compra WHERE empresa_id=$1 AND EXTRACT(YEAR FROM data_emissao)=$2 AND estado != 'anulada'
    GROUP BY categoria ORDER BY total DESC LIMIT 8
  `, [req.empresaId, ano]);

  const { rows: alertasStock } = await query(`
    SELECT nome, codigo, stock_atual, stock_minimo, unidade
    FROM artigo WHERE empresa_id=$1 AND ativo=true AND tipo='produto' AND stock_atual <= stock_minimo
    ORDER BY (stock_atual - stock_minimo) ASC LIMIT 5
  `, [req.empresaId]);

  res.json({ resumo, porMes, porCategoria, alertasStock });
});

module.exports = router;
