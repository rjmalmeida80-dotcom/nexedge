'use strict';
/**
 * NexEdge — WMS (Warehouse Management System) Premium
 * Gestão completa de armazém: zonas, localizações, recepção, picking, packing, expedição
 * Integrado com Logística, Compras, Faturação e IA
 * Supera: SAP EWM, Oracle WMS, Manhattan Associates
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const Anthropic = require('@anthropic-ai/sdk');
const crypto = require('crypto');

router.use(autenticar);
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

// ── DASHBOARD ──

router.get('/dashboard', async (req, res) => {
  try {
    const [kpis, alertas, movimentos, ocupacao, top_produtos] = await Promise.all([
      query(`SELECT
        COUNT(*) FILTER (WHERE tipo='recepcao' AND DATE(criado_em)=CURRENT_DATE) as recepcoes_hoje,
        COUNT(*) FILTER (WHERE tipo='picking' AND DATE(criado_em)=CURRENT_DATE) as pickings_hoje,
        COUNT(*) FILTER (WHERE tipo='expedicao' AND DATE(criado_em)=CURRENT_DATE) as expedicoes_hoje,
        COUNT(*) FILTER (WHERE estado='pendente') as tarefas_pendentes,
        COUNT(*) FILTER (WHERE estado='em_curso') as tarefas_em_curso,
        SUM(CASE WHEN tipo='recepcao' AND DATE(criado_em)=CURRENT_DATE THEN quantidade ELSE 0 END) as unidades_recebidas_hoje,
        SUM(CASE WHEN tipo='expedicao' AND DATE(criado_em)=CURRENT_DATE THEN quantidade ELSE 0 END) as unidades_expedidas_hoje
        FROM wms_movimento WHERE empresa_id=$1`, [req.empresaId]).catch(()=>({rows:[{recepcoes_hoje:0,pickings_hoje:0,expedicoes_hoje:0,tarefas_pendentes:0,tarefas_em_curso:0}]})),

      query(`SELECT a.*, p.nome as produto_nome FROM wms_alerta a
        LEFT JOIN produto p ON p.id=a.produto_id
        WHERE a.empresa_id=$1 AND a.resolvido=false ORDER BY a.prioridade DESC, a.criado_em DESC LIMIT 10`, [req.empresaId]).catch(()=>({rows:[]})),

      query(`SELECT m.*, p.nome as produto_nome, u.nome_completo as operador_nome,
        l.codigo as localizacao_codigo
        FROM wms_movimento m
        LEFT JOIN produto p ON p.id=m.produto_id
        LEFT JOIN utilizador u ON u.id=m.operador_id
        LEFT JOIN wms_localizacao l ON l.id=m.localizacao_id
        WHERE m.empresa_id=$1 ORDER BY m.criado_em DESC LIMIT 10`, [req.empresaId]).catch(()=>({rows:[]})),

      query(`SELECT z.nome, z.tipo,
        COUNT(l.id) as total_localizacoes,
        COUNT(l.id) FILTER (WHERE l.ocupada=true) as ocupadas,
        ROUND(COUNT(l.id) FILTER (WHERE l.ocupada=true)::numeric / NULLIF(COUNT(l.id),0)*100,1) as taxa_ocupacao
        FROM wms_zona z LEFT JOIN wms_localizacao l ON l.zona_id=z.id
        WHERE z.empresa_id=$1 GROUP BY z.id,z.nome,z.tipo ORDER BY taxa_ocupacao DESC`, [req.empresaId]).catch(()=>({rows:[]})),

      query(`SELECT p.nome, p.referencia, SUM(s.quantidade) as stock_total,
        SUM(s.quantidade*p.preco_venda) as valor_stock
        FROM wms_stock s JOIN produto p ON p.id=s.produto_id
        WHERE s.empresa_id=$1 GROUP BY p.id,p.nome,p.referencia
        ORDER BY valor_stock DESC LIMIT 5`, [req.empresaId]).catch(()=>({rows:[]})),
    ]);

    const stockTotal = await query(`SELECT
      COUNT(DISTINCT produto_id) as num_produtos,
      SUM(quantidade) as unidades_total,
      SUM(quantidade*p.preco_venda) as valor_total
      FROM wms_stock s JOIN produto p ON p.id=s.produto_id
      WHERE s.empresa_id=$1`, [req.empresaId]).catch(()=>({rows:[{num_produtos:0,unidades_total:0,valor_total:0}]}));

    res.json({
      kpis: kpis.rows[0],
      stock: stockTotal.rows[0],
      alertas: alertas.rows,
      movimentos_recentes: movimentos.rows,
      ocupacao_zonas: ocupacao.rows,
      top_produtos: top_produtos.rows,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ZONAS DO ARMAZÉM ──

router.get('/zonas', async (req, res) => {
  try {
    const r = await query(`
      SELECT z.*,
        COUNT(l.id) as total_localizacoes,
        COUNT(l.id) FILTER (WHERE l.ocupada=true) as ocupadas,
        ROUND(COUNT(l.id) FILTER (WHERE l.ocupada=true)::numeric/NULLIF(COUNT(l.id),0)*100,1) as taxa_ocupacao
      FROM wms_zona z LEFT JOIN wms_localizacao l ON l.zona_id=z.id
      WHERE z.empresa_id=$1 GROUP BY z.id ORDER BY z.nome
    `, [req.empresaId]).catch(()=>({rows:[]}));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/zonas', async (req, res) => {
  try {
    const { nome, tipo, descricao, temperatura_min, temperatura_max, humidade_max, cor, ordem } = req.body;
    const r = await query(`
      INSERT INTO wms_zona (empresa_id, nome, tipo, descricao, temperatura_min, temperatura_max, humidade_max, cor, ordem)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
    `, [req.empresaId, nome, tipo||'armazenagem', descricao||'',
        temperatura_min||null, temperatura_max||null, humidade_max||null,
        cor||'#4F46E5', ordem||0]);
    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Gerar localizações em massa para uma zona
router.post('/zonas/:id/gerar-localizacoes', async (req, res) => {
  try {
    const { corredores, prateleiras, posicoes, prefixo } = req.body;
    // Ex: corredor A-D, prateleira 1-5, posição 1-10 = 200 localizações
    const zona = await query(`SELECT * FROM wms_zona WHERE id=$1 AND empresa_id=$2`, [req.params.id, req.empresaId]);
    if (!zona.rows.length) return res.status(404).json({ error: 'Zona não encontrada' });

    const letras = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let criadas = 0;
    const pref = prefixo || zona.rows[0].nome.slice(0,2).toUpperCase();

    for (let c = 0; c < (corredores||3); c++) {
      for (let p = 1; p <= (prateleiras||5); p++) {
        for (let pos = 1; pos <= (posicoes||10); pos++) {
          const codigo = `${pref}-${letras[c]}-${p.toString().padStart(2,'0')}-${pos.toString().padStart(2,'0')}`;
          await query(`INSERT INTO wms_localizacao (empresa_id, zona_id, codigo, corredor, prateleira, posicao, ocupada, activa)
            VALUES ($1,$2,$3,$4,$5,$6,false,true) ON CONFLICT (empresa_id, codigo) DO NOTHING`,
            [req.empresaId, req.params.id, codigo, letras[c], p, pos]).catch(()=>{});
          criadas++;
        }
      }
    }
    res.json({ criadas, zona: zona.rows[0].nome });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── LOCALIZAÇÕES ──

router.get('/localizacoes', async (req, res) => {
  try {
    const { zona_id, ocupada, produto_id } = req.query;
    const conds = ['l.empresa_id=$1'], params = [req.empresaId];
    let n = 2;
    if (zona_id) { conds.push(`l.zona_id=$${n++}`); params.push(zona_id); }
    if (ocupada !== undefined) { conds.push(`l.ocupada=$${n++}`); params.push(ocupada==='true'); }
    if (produto_id) { conds.push(`s.produto_id=$${n++}`); params.push(produto_id); }

    const r = await query(`
      SELECT l.*, z.nome as zona_nome, z.tipo as zona_tipo, z.cor as zona_cor,
        s.produto_id, s.quantidade, s.lote, s.data_validade,
        p.nome as produto_nome, p.referencia as produto_ref
      FROM wms_localizacao l
      LEFT JOIN wms_zona z ON z.id=l.zona_id
      LEFT JOIN wms_stock s ON s.localizacao_id=l.id AND s.empresa_id=l.empresa_id
      LEFT JOIN produto p ON p.id=s.produto_id
      WHERE ${conds.join(' AND ')}
      ORDER BY l.corredor, l.prateleira, l.posicao
      LIMIT 500
    `, params).catch(()=>({rows:[]}));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Melhor localização para um produto (IA ou regras)
router.post('/localizacoes/sugerir', async (req, res) => {
  try {
    const { produto_id, quantidade, zona_preferida } = req.body;

    const produto = await query(`SELECT * FROM produto WHERE id=$1`, [produto_id]).catch(()=>({rows:[]}));
    const livres = await query(`
      SELECT l.*, z.nome as zona_nome, z.tipo
      FROM wms_localizacao l JOIN wms_zona z ON z.id=l.zona_id
      WHERE l.empresa_id=$1 AND l.ocupada=false AND l.activa=true
        ${zona_preferida?`AND l.zona_id='${zona_preferida}'`:''}
      ORDER BY l.corredor, l.prateleira, l.posicao LIMIT 10
    `, [req.empresaId]).catch(()=>({rows:[]}));

    if (!livres.rows.length) return res.status(404).json({ error: 'Sem localizações livres' });

    let sugestao = livres.rows[0];

    // IA para melhor decisão se disponível
    if (anthropic && produto.rows.length) {
      try {
        const response = await anthropic.messages.create({
          model: 'claude-sonnet-4-6', max_tokens: 300,
          messages: [{role:'user', content:`Sugere a melhor localização para armazenar este produto num armazém:
Produto: ${produto.rows[0].nome}
Categoria: ${produto.rows[0].categoria||'—'}
Peso: ${produto.rows[0].peso_kg||'—'}kg
Localizações disponíveis: ${JSON.stringify(livres.rows.map(l=>({codigo:l.codigo,zona:l.zona_nome,tipo:l.tipo})))}
Responde APENAS com o código da localização escolhida e uma razão em 20 palavras. Formato: {"codigo":"XX-A-01-01","razao":"..."}`}]
        });
        const txt = response.content[0]?.text;
        const json = JSON.parse(txt.match(/\{.*\}/s)?.[0]||'{}');
        if (json.codigo) {
          const loc = livres.rows.find(l=>l.codigo===json.codigo);
          if (loc) sugestao = { ...loc, razao_ia: json.razao };
        }
      } catch(e) {}
    }

    res.json({ sugestao, alternativas: livres.rows.slice(0,5) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── STOCK ──

router.get('/stock', async (req, res) => {
  try {
    const { produto_id, zona_id, abaixo_minimo } = req.query;
    const conds = ['s.empresa_id=$1'], params = [req.empresaId];
    let n = 2;
    if (produto_id) { conds.push(`s.produto_id=$${n++}`); params.push(produto_id); }
    if (zona_id) { conds.push(`l.zona_id=$${n++}`); params.push(zona_id); }
    if (abaixo_minimo === 'true') { conds.push(`s.quantidade <= p.stock_minimo`); }

    const r = await query(`
      SELECT s.*, p.nome as produto_nome, p.referencia, p.unidade, p.stock_minimo,
        p.preco_venda, p.preco_custo,
        l.codigo as localizacao_codigo, z.nome as zona_nome, z.cor as zona_cor,
        CASE WHEN p.stock_minimo > 0 AND s.quantidade <= p.stock_minimo THEN true ELSE false END as abaixo_minimo,
        s.quantidade * p.preco_custo as valor_custo,
        EXTRACT(DAY FROM NOW()-s.data_validade) as dias_para_validade
      FROM wms_stock s
      JOIN produto p ON p.id=s.produto_id
      LEFT JOIN wms_localizacao l ON l.id=s.localizacao_id
      LEFT JOIN wms_zona z ON z.id=l.zona_id
      WHERE ${conds.join(' AND ')}
      ORDER BY p.nome, l.codigo
    `, params).catch(()=>({rows:[]}));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Resumo de stock por produto
router.get('/stock/resumo', async (req, res) => {
  try {
    const r = await query(`
      SELECT p.id, p.nome, p.referencia, p.unidade, p.stock_minimo, p.preco_custo,
        SUM(s.quantidade) as quantidade_total,
        COUNT(DISTINCT s.localizacao_id) as num_localizacoes,
        MIN(s.data_validade) as validade_mais_proxima,
        SUM(s.quantidade * p.preco_custo) as valor_total,
        CASE WHEN p.stock_minimo > 0 AND SUM(s.quantidade) <= p.stock_minimo THEN 'critico'
             WHEN p.stock_minimo > 0 AND SUM(s.quantidade) <= p.stock_minimo*1.5 THEN 'baixo'
             ELSE 'ok' END as estado_stock
      FROM wms_stock s JOIN produto p ON p.id=s.produto_id
      WHERE s.empresa_id=$1
      GROUP BY p.id,p.nome,p.referencia,p.unidade,p.stock_minimo,p.preco_custo
      ORDER BY estado_stock DESC, p.nome
    `, [req.empresaId]).catch(()=>({rows:[]}));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── RECEPÇÃO DE MERCADORIA ──

router.get('/recepcoes', async (req, res) => {
  try {
    const r = await query(`
      SELECT r.*, f.nome as fornecedor_nome, u.nome_completo as operador_nome,
        COUNT(ri.id) as num_linhas,
        SUM(ri.quantidade_recebida) as total_unidades_recebidas
      FROM wms_recepcao r
      LEFT JOIN fornecedor f ON f.id=r.fornecedor_id
      LEFT JOIN utilizador u ON u.id=r.operador_id
      LEFT JOIN wms_recepcao_linha ri ON ri.recepcao_id=r.id
      WHERE r.empresa_id=$1
      GROUP BY r.id, f.nome, u.nome_completo
      ORDER BY r.criado_em DESC LIMIT 50
    `, [req.empresaId]).catch(()=>({rows:[]}));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/recepcoes', async (req, res) => {
  try {
    const { fornecedor_id, pedido_compra_id, referencia_externa, notas, linhas } = req.body;

    const ano = new Date().getFullYear();
    const count = await query(`SELECT COUNT(*) FROM wms_recepcao WHERE empresa_id=$1 AND EXTRACT(YEAR FROM criado_em)=$2`, [req.empresaId, ano]);
    const numero = `REC-${ano}-${(parseInt(count.rows[0].count)+1).toString().padStart(5,'0')}`;

    const r = await query(`
      INSERT INTO wms_recepcao (empresa_id, numero, fornecedor_id, pedido_compra_id, referencia_externa, notas, estado, operador_id)
      VALUES ($1,$2,$3,$4,$5,$6,'aberta',$7) RETURNING *
    `, [req.empresaId, numero, fornecedor_id||null, pedido_compra_id||null,
        referencia_externa||'', notas||'', req.utilizador.id]);

    const rec = r.rows[0];

    if (linhas?.length) {
      for (const l of linhas) {
        await query(`INSERT INTO wms_recepcao_linha (recepcao_id, produto_id, quantidade_esperada, quantidade_recebida, unidade, lote, data_validade, estado)
          VALUES ($1,$2,$3,$4,$5,$6,$7,'pendente')`,
          [rec.id, l.produto_id, l.quantidade_esperada||0, 0, l.unidade||'UN', l.lote||null, l.data_validade||null]);
      }
    }

    res.status(201).json(rec);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Dar entrada de stock (confirmação por linha)
router.post('/recepcoes/:id/dar-entrada', async (req, res) => {
  try {
    const { linhas } = req.body;
    // linhas: [{linha_id, produto_id, quantidade, localizacao_id, lote, data_validade}]

    for (const l of linhas) {
      // Actualizar linha de recepção
      await query(`UPDATE wms_recepcao_linha SET quantidade_recebida=$1, localizacao_id=$2, lote=$3, data_validade=$4, estado='recebida'
        WHERE id=$5`, [l.quantidade, l.localizacao_id||null, l.lote||null, l.data_validade||null, l.linha_id]);

      // Actualizar stock
      if (l.quantidade > 0) {
        await query(`
          INSERT INTO wms_stock (empresa_id, produto_id, localizacao_id, quantidade, lote, data_validade, ultima_movimentacao)
          VALUES ($1,$2,$3,$4,$5,$6,NOW())
          ON CONFLICT (empresa_id, produto_id, localizacao_id, COALESCE(lote,''))
          DO UPDATE SET quantidade=wms_stock.quantidade+$4, ultima_movimentacao=NOW()
        `, [req.empresaId, l.produto_id, l.localizacao_id||null, l.quantidade, l.lote||null, l.data_validade||null]).catch(async()=>{
          await query(`INSERT INTO wms_stock (empresa_id, produto_id, localizacao_id, quantidade, lote, data_validade, ultima_movimentacao)
            VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
            [req.empresaId, l.produto_id, l.localizacao_id||null, l.quantidade, l.lote||null, l.data_validade||null]).catch(()=>{});
        });

        // Marcar localização como ocupada
        if (l.localizacao_id) {
          await query(`UPDATE wms_localizacao SET ocupada=true WHERE id=$1`, [l.localizacao_id]);
        }

        // Registar movimento
        await query(`INSERT INTO wms_movimento (empresa_id, tipo, produto_id, localizacao_id, quantidade, referencia, operador_id, estado)
          VALUES ($1,'recepcao',$2,$3,$4,$5,$6,'concluido')`,
          [req.empresaId, l.produto_id, l.localizacao_id||null, l.quantidade, req.params.id, req.utilizador.id]);
      }
    }

    // Verificar se todas as linhas foram recebidas
    const pendentes = await query(`SELECT COUNT(*) FROM wms_recepcao_linha WHERE recepcao_id=$1 AND estado='pendente'`, [req.params.id]);
    if (parseInt(pendentes.rows[0].count) === 0) {
      await query(`UPDATE wms_recepcao SET estado='concluida', concluida_em=NOW() WHERE id=$1`, [req.params.id]);
    }

    // Verificar alertas de stock mínimo
    await verificarAlertasStock(req.empresaId);

    res.json({ ok: true, linhas_processadas: linhas.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PICKING ──

router.get('/picking', async (req, res) => {
  try {
    const r = await query(`
      SELECT o.*, u.nome_completo as operador_nome,
        COUNT(ol.id) as num_linhas,
        COUNT(ol.id) FILTER (WHERE ol.estado='picked') as linhas_picked,
        e.numero as encomenda_numero
      FROM wms_ordem_picking o
      LEFT JOIN utilizador u ON u.id=o.operador_id
      LEFT JOIN wms_linha_picking ol ON ol.ordem_id=o.id
      LEFT JOIN logistica_encomenda e ON e.id=o.encomenda_id
      WHERE o.empresa_id=$1
      GROUP BY o.id, u.nome_completo, e.numero
      ORDER BY o.prioridade DESC, o.criado_em ASC
    `, [req.empresaId]).catch(()=>({rows:[]}));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Criar ordem de picking
router.post('/picking', async (req, res) => {
  try {
    const { encomenda_id, linhas, prioridade, notas } = req.body;
    // linhas: [{produto_id, quantidade}]

    const ano = new Date().getFullYear();
    const count = await query(`SELECT COUNT(*) FROM wms_ordem_picking WHERE empresa_id=$1 AND EXTRACT(YEAR FROM criado_em)=$2`, [req.empresaId, ano]);
    const numero = `PK-${ano}-${(parseInt(count.rows[0].count)+1).toString().padStart(5,'0')}`;

    const r = await query(`INSERT INTO wms_ordem_picking (empresa_id, numero, encomenda_id, prioridade, notas, estado)
      VALUES ($1,$2,$3,$4,$5,'pendente') RETURNING *`,
      [req.empresaId, numero, encomenda_id||null, prioridade||'normal', notas||'']);

    const ordem = r.rows[0];

    // Sugerir localizações para cada produto (FEFO — First Expired First Out)
    for (const linha of (linhas||[])) {
      const stock = await query(`
        SELECT s.*, l.codigo as localizacao_codigo, l.corredor, l.prateleira, l.posicao
        FROM wms_stock s JOIN wms_localizacao l ON l.id=s.localizacao_id
        WHERE s.empresa_id=$1 AND s.produto_id=$2 AND s.quantidade>=$3
        ORDER BY s.data_validade ASC NULLS LAST, l.corredor, l.prateleira, l.posicao
        LIMIT 1
      `, [req.empresaId, linha.produto_id, linha.quantidade]);

      const loc = stock.rows[0];
      await query(`INSERT INTO wms_linha_picking (ordem_id, produto_id, quantidade_pedida, localizacao_id, localizacao_sugerida, estado)
        VALUES ($1,$2,$3,$4,$4,'pendente')`,
        [ordem.id, linha.produto_id, linha.quantidade, loc?.localizacao_id||null]);
    }

    res.status(201).json(ordem);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Confirmar pick de uma linha
router.put('/picking/:ordemId/linha/:linhaId/pick', async (req, res) => {
  try {
    const { quantidade_real, localizacao_id } = req.body;

    // Debitar stock
    await query(`UPDATE wms_stock SET quantidade=quantidade-$1, ultima_movimentacao=NOW()
      WHERE empresa_id=$2 AND produto_id=(SELECT produto_id FROM wms_linha_picking WHERE id=$3)
        AND localizacao_id=$4`,
      [quantidade_real, req.empresaId, req.params.linhaId, localizacao_id]);

    await query(`UPDATE wms_linha_picking SET quantidade_real=$1, localizacao_id=$2, estado='picked', picked_em=NOW(), operador_id=$3
      WHERE id=$4`, [quantidade_real, localizacao_id, req.utilizador.id, req.params.linhaId]);

    // Verificar se a localização ficou vazia
    const stockLoc = await query(`SELECT SUM(quantidade) as total FROM wms_stock WHERE localizacao_id=$1`, [localizacao_id]);
    if (parseFloat(stockLoc.rows[0]?.total||0) <= 0) {
      await query(`UPDATE wms_localizacao SET ocupada=false WHERE id=$1`, [localizacao_id]);
    }

    // Registar movimento
    const linha = await query(`SELECT * FROM wms_linha_picking WHERE id=$1`, [req.params.linhaId]);
    if (linha.rows.length) {
      await query(`INSERT INTO wms_movimento (empresa_id, tipo, produto_id, localizacao_id, quantidade, referencia, operador_id, estado)
        VALUES ($1,'picking',$2,$3,$4,$5,$6,'concluido')`,
        [req.empresaId, linha.rows[0].produto_id, localizacao_id, quantidade_real, req.params.ordemId, req.utilizador.id]);
    }

    // Verificar se ordem completa
    const pendentes = await query(`SELECT COUNT(*) FROM wms_linha_picking WHERE ordem_id=$1 AND estado='pendente'`, [req.params.ordemId]);
    if (parseInt(pendentes.rows[0].count) === 0) {
      await query(`UPDATE wms_ordem_picking SET estado='picking_concluido', concluido_em=NOW() WHERE id=$1`, [req.params.ordemId]);
    }

    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── EXPEDIÇÃO ──

router.post('/expedicao', async (req, res) => {
  try {
    const { ordem_picking_id, encomenda_id, transportadora, peso_total, volumes, notas } = req.body;

    const ano = new Date().getFullYear();
    const count = await query(`SELECT COUNT(*) FROM wms_expedicao WHERE empresa_id=$1 AND EXTRACT(YEAR FROM criado_em)=$2`, [req.empresaId, ano]);
    const numero = `EXP-${ano}-${(parseInt(count.rows[0].count)+1).toString().padStart(5,'0')}`;

    const r = await query(`
      INSERT INTO wms_expedicao (empresa_id, numero, ordem_picking_id, encomenda_id, transportadora, peso_total, num_volumes, notas, estado, operador_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pronta',$9) RETURNING *
    `, [req.empresaId, numero, ordem_picking_id||null, encomenda_id||null,
        transportadora||'', peso_total||0, volumes||1, notas||'', req.utilizador.id]);

    // Actualizar estado da encomenda logística
    if (encomenda_id) {
      await query(`UPDATE logistica_encomenda SET estado='pronta_recolha' WHERE id=$1`, [encomenda_id]).catch(()=>{});
    }

    // Marcar picking como expedido
    if (ordem_picking_id) {
      await query(`UPDATE wms_ordem_picking SET estado='expedido', expedido_em=NOW() WHERE id=$1`, [ordem_picking_id]);
    }

    await query(`INSERT INTO wms_movimento (empresa_id, tipo, quantidade, referencia, operador_id, estado)
      VALUES ($1,'expedicao',$2,$3,$4,'concluido')`,
      [req.empresaId, volumes||1, numero, req.utilizador.id]);

    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/expedicoes', async (req, res) => {
  try {
    const r = await query(`
      SELECT e.*, u.nome_completo as operador_nome, en.numero as encomenda_numero
      FROM wms_expedicao e
      LEFT JOIN utilizador u ON u.id=e.operador_id
      LEFT JOIN logistica_encomenda en ON en.id=e.encomenda_id
      WHERE e.empresa_id=$1 ORDER BY e.criado_em DESC LIMIT 50
    `, [req.empresaId]).catch(()=>({rows:[]}));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── INVENTÁRIO ──

router.post('/inventario/iniciar', async (req, res) => {
  try {
    const { zona_id, tipo, notas } = req.body;
    const ano = new Date().getFullYear();
    const count = await query(`SELECT COUNT(*) FROM wms_inventario WHERE empresa_id=$1 AND EXTRACT(YEAR FROM criado_em)=$2`, [req.empresaId, ano]);
    const numero = `INV-${ano}-${(parseInt(count.rows[0].count)+1).toString().padStart(3,'0')}`;

    const r = await query(`INSERT INTO wms_inventario (empresa_id, numero, zona_id, tipo, notas, estado, iniciado_em, iniciado_por)
      VALUES ($1,$2,$3,$4,$5,'em_curso',NOW(),$6) RETURNING *`,
      [req.empresaId, numero, zona_id||null, tipo||'total', notas||'', req.utilizador.id]);

    // Criar linhas de inventário baseadas no stock actual
    const stock = await query(`SELECT s.*, l.zona_id FROM wms_stock s LEFT JOIN wms_localizacao l ON l.id=s.localizacao_id
      WHERE s.empresa_id=$1 ${zona_id?`AND l.zona_id='${zona_id}'`:''}`, [req.empresaId]);

    for (const s of stock.rows) {
      await query(`INSERT INTO wms_inventario_linha (inventario_id, produto_id, localizacao_id, quantidade_sistema, lote)
        VALUES ($1,$2,$3,$4,$5)`,
        [r.rows[0].id, s.produto_id, s.localizacao_id, s.quantidade, s.lote||null]).catch(()=>{});
    }

    res.status(201).json({ ...r.rows[0], num_linhas: stock.rows.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/inventario/:id/linha/:linhaId/contar', async (req, res) => {
  try {
    const { quantidade_contada } = req.body;
    await query(`UPDATE wms_inventario_linha SET quantidade_contada=$1, diferenca=$1-quantidade_sistema, contado_em=NOW(), estado='contado'
      WHERE id=$2`, [quantidade_contada, req.params.linhaId]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/inventario/:id/fechar', async (req, res) => {
  try {
    // Aplicar ajustes ao stock
    const linhas = await query(`SELECT * FROM wms_inventario_linha WHERE inventario_id=$1 AND estado='contado' AND diferenca<>0`, [req.params.id]);
    for (const l of linhas.rows) {
      await query(`UPDATE wms_stock SET quantidade=quantidade+$1 WHERE produto_id=$2 AND localizacao_id=$3`,
        [l.diferenca, l.produto_id, l.localizacao_id]).catch(()=>{});
      await query(`INSERT INTO wms_movimento (empresa_id, tipo, produto_id, localizacao_id, quantidade, referencia, operador_id, estado)
        VALUES ($1,'ajuste_inventario',$2,$3,$4,$5,$6,'concluido')`,
        [req.empresaId, l.produto_id, l.localizacao_id, l.diferenca, req.params.id, req.utilizador.id]).catch(()=>{});
    }
    await query(`UPDATE wms_inventario SET estado='concluido', concluido_em=NOW() WHERE id=$1`, [req.params.id]);
    res.json({ ok: true, ajustes: linhas.rows.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── MOVIMENTOS ──

router.get('/movimentos', async (req, res) => {
  try {
    const { tipo, produto_id, data_inicio, data_fim } = req.query;
    const conds = ['m.empresa_id=$1'], params = [req.empresaId];
    let n = 2;
    if (tipo) { conds.push(`m.tipo=$${n++}`); params.push(tipo); }
    if (produto_id) { conds.push(`m.produto_id=$${n++}`); params.push(produto_id); }
    if (data_inicio) { conds.push(`m.criado_em>=$${n++}`); params.push(data_inicio); }
    if (data_fim) { conds.push(`m.criado_em<=$${n++}`); params.push(data_fim); }

    const r = await query(`
      SELECT m.*, p.nome as produto_nome, l.codigo as localizacao_codigo, u.nome_completo as operador_nome
      FROM wms_movimento m
      LEFT JOIN produto p ON p.id=m.produto_id
      LEFT JOIN wms_localizacao l ON l.id=m.localizacao_id
      LEFT JOIN utilizador u ON u.id=m.operador_id
      WHERE ${conds.join(' AND ')}
      ORDER BY m.criado_em DESC LIMIT 200
    `, params).catch(()=>({rows:[]}));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ALERTAS ──

async function verificarAlertasStock(empresaId) {
  try {
    // Produtos abaixo do stock mínimo
    const abaixo = await query(`
      SELECT p.id as produto_id, p.nome, SUM(s.quantidade) as stock_actual, p.stock_minimo
      FROM wms_stock s JOIN produto p ON p.id=s.produto_id
      WHERE s.empresa_id=$1 AND p.stock_minimo > 0
      GROUP BY p.id, p.nome, p.stock_minimo
      HAVING SUM(s.quantidade) <= p.stock_minimo
    `, [empresaId]);

    for (const p of abaixo.rows) {
      await query(`INSERT INTO wms_alerta (empresa_id, tipo, produto_id, mensagem, prioridade)
        VALUES ($1,'stock_minimo',$2,$3,'alta')
        ON CONFLICT (empresa_id, tipo, produto_id) DO UPDATE SET mensagem=$3, criado_em=NOW(), resolvido=false`,
        [empresaId, p.produto_id, `Stock de "${p.nome}" abaixo do mínimo: ${p.stock_actual} (mín: ${p.stock_minimo})`]).catch(()=>{});
    }

    // Produtos a vencer em 30 dias
    const aVencer = await query(`
      SELECT DISTINCT p.id as produto_id, p.nome, MIN(s.data_validade) as validade
      FROM wms_stock s JOIN produto p ON p.id=s.produto_id
      WHERE s.empresa_id=$1 AND s.data_validade IS NOT NULL
        AND s.data_validade BETWEEN NOW() AND NOW()+INTERVAL '30 days' AND s.quantidade > 0
      GROUP BY p.id, p.nome
    `, [empresaId]);

    for (const p of aVencer.rows) {
      await query(`INSERT INTO wms_alerta (empresa_id, tipo, produto_id, mensagem, prioridade)
        VALUES ($1,'validade_proxima',$2,$3,'media')
        ON CONFLICT (empresa_id, tipo, produto_id) DO UPDATE SET mensagem=$3, criado_em=NOW(), resolvido=false`,
        [empresaId, p.produto_id, `Produto "${p.nome}" a vencer em ${new Date(p.validade).toLocaleDateString('pt-PT')}`]).catch(()=>{});
    }
  } catch(e) { console.error('[WMS] Alertas:', e.message); }
}

router.get('/alertas', async (req, res) => {
  try {
    await verificarAlertasStock(req.empresaId);
    const r = await query(`SELECT a.*, p.nome as produto_nome FROM wms_alerta a
      LEFT JOIN produto p ON p.id=a.produto_id
      WHERE a.empresa_id=$1 AND a.resolvido=false ORDER BY a.prioridade DESC, a.criado_em DESC`, [req.empresaId]).catch(()=>({rows:[]}));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/alertas/:id/resolver', async (req, res) => {
  try {
    await query(`UPDATE wms_alerta SET resolvido=true, resolvido_em=NOW() WHERE id=$1 AND empresa_id=$2`, [req.params.id, req.empresaId]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ANALYTICS ──

router.get('/analytics', async (req, res) => {
  try {
    const { periodo = 30 } = req.query;
    const [movPorTipo, stockValor, produtividade, valorZona] = await Promise.all([
      query(`SELECT tipo, COUNT(*) as total, SUM(quantidade) as unidades
        FROM wms_movimento WHERE empresa_id=$1 AND criado_em > NOW()-($2::int * INTERVAL '1 day')
        GROUP BY tipo ORDER BY total DESC`, [req.empresaId, periodo]),
      query(`SELECT SUM(s.quantidade*p.preco_custo) as valor_custo,
        SUM(s.quantidade*p.preco_venda) as valor_venda,
        COUNT(DISTINCT s.produto_id) as num_produtos,
        SUM(s.quantidade) as unidades_total
        FROM wms_stock s JOIN produto p ON p.id=s.produto_id WHERE s.empresa_id=$1`, [req.empresaId]),
      query(`SELECT u.nome_completo, COUNT(m.id) as total_movimentos, SUM(m.quantidade) as unidades_movidas
        FROM wms_movimento m JOIN utilizador u ON u.id=m.operador_id
        WHERE m.empresa_id=$1 AND m.criado_em > NOW()-($2::int * INTERVAL '1 day')
        GROUP BY u.id,u.nome_completo ORDER BY total_movimentos DESC LIMIT 5`, [req.empresaId, periodo]),
      query(`SELECT z.nome, z.tipo, z.cor,
        COUNT(l.id) as total_locs,
        COUNT(l.id) FILTER (WHERE l.ocupada) as ocupadas,
        COALESCE(SUM(s.quantidade*p.preco_custo),0) as valor_stock
        FROM wms_zona z LEFT JOIN wms_localizacao l ON l.zona_id=z.id
        LEFT JOIN wms_stock s ON s.localizacao_id=l.id
        LEFT JOIN produto p ON p.id=s.produto_id
        WHERE z.empresa_id=$1 GROUP BY z.id,z.nome,z.tipo,z.cor ORDER BY valor_stock DESC`, [req.empresaId]),
    ]);

    res.json({
      periodo_dias: periodo,
      movimentos_por_tipo: movPorTipo.rows,
      stock_valor: stockValor.rows[0],
      produtividade_operadores: produtividade.rows,
      valor_por_zona: valorZona.rows,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── IA — OPTIMIZAÇÃO ──

router.post('/ia/optimizar-stock', async (req, res) => {
  try {
    if (!anthropic) return res.json({ sugestoes: ['Configure ANTHROPIC_API_KEY'] });

    const [stock, alertas, movimentos] = await Promise.all([
      query(`SELECT p.nome, SUM(s.quantidade) as qtd, p.stock_minimo, p.preco_custo
        FROM wms_stock s JOIN produto p ON p.id=s.produto_id WHERE s.empresa_id=$1
        GROUP BY p.id,p.nome,p.stock_minimo,p.preco_custo ORDER BY qtd DESC LIMIT 20`, [req.empresaId]),
      query(`SELECT mensagem FROM wms_alerta WHERE empresa_id=$1 AND resolvido=false LIMIT 5`, [req.empresaId]),
      query(`SELECT tipo, COUNT(*) as total FROM wms_movimento WHERE empresa_id=$1 AND criado_em > NOW()-INTERVAL '7 days' GROUP BY tipo`, [req.empresaId]),
    ]);

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 1000,
      messages: [{role:'user', content:`És um especialista em gestão de armazém (WMS). Analisa estes dados e dá recomendações concretas em PT-PT:

Top produtos por stock: ${JSON.stringify(stock.rows)}
Alertas activos: ${JSON.stringify(alertas.rows)}
Movimentos últimos 7 dias: ${JSON.stringify(movimentos.rows)}

Dá 5 recomendações específicas e accionáveis para:
1. Optimização do espaço
2. Gestão de stock
3. Melhoria de produtividade
4. Prevenção de problemas
5. Redução de custos`}]
    });

    res.json({ analise: response.content[0]?.text });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
