'use strict';
/**
 * NexEdge — Integração E-commerce
 * Suporta: Shopify, WooCommerce, Moloni
 * Sincroniza: encomendas, produtos, clientes, stock
 */

const express = require('express');
const router = express.Router();
const { query, transaction } = require('../config/database');
const { autenticar } = require('../middleware/auth');

router.use(autenticar);

// ── CONFIGURAÇÕES DE INTEGRAÇÃO ──

router.get('/configuracoes', async (req, res) => {
  try {
    const r = await query(`
      SELECT * FROM integracao_ecommerce
      WHERE empresa_id=$1 ORDER BY criado_em DESC
    `, [req.empresaId]).catch(() => ({ rows: [] }));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/configuracoes', async (req, res) => {
  try {
    const { plataforma, nome, config } = req.body;
    const r = await query(`
      INSERT INTO integracao_ecommerce (empresa_id, plataforma, nome, config, ativo)
      VALUES ($1,$2,$3,$4,true)
      ON CONFLICT (empresa_id, plataforma) DO UPDATE SET config=$4, nome=$3, ativo=true
      RETURNING *
    `, [req.empresaId, plataforma, nome, JSON.stringify(config)]);
    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SHOPIFY ──

async function syncShopify(integracao) {
  const { shop_domain, access_token } = integracao.config;
  const base = `https://${shop_domain}/admin/api/2024-01`;
  const headers = { 'X-Shopify-Access-Token': access_token, 'Content-Type': 'application/json' };

  let syncados = { encomendas: 0, produtos: 0, clientes: 0 };

  // Sincronizar encomendas
  const ordersRes = await fetch(`${base}/orders.json?status=any&limit=250&updated_at_min=${new Date(Date.now()-24*3600000).toISOString()}`, { headers });
  if (ordersRes.ok) {
    const { orders } = await ordersRes.json();
    for (const order of orders) {
      await query(`
        INSERT INTO encomenda (empresa_id, numero, origem, origem_id, cliente_nome, cliente_email,
          total, estado, data_encomenda, linhas, tracking_code, campos_extra)
        VALUES ($1,$2,'shopify',$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (empresa_id, origem, origem_id) DO UPDATE SET
          estado=$7, tracking_code=$10, campos_extra=$11
      `, [
        integracao.empresa_id,
        `SHOP-${order.order_number}`,
        order.id.toString(),
        order.customer ? `${order.customer.first_name} ${order.customer.last_name}` : 'Cliente',
        order.email || '',
        parseFloat(order.total_price),
        mapShopifyStatus(order.financial_status, order.fulfillment_status),
        order.created_at,
        JSON.stringify(order.line_items?.map(l => ({ produto: l.title, qty: l.quantity, preco: l.price }))),
        order.fulfillments?.[0]?.tracking_number || null,
        JSON.stringify({ shopify_id: order.id, tags: order.tags })
      ]).catch(() => {});
      syncados.encomendas++;
    }
  }

  // Sincronizar produtos
  const prodRes = await fetch(`${base}/products.json?limit=250`, { headers });
  if (prodRes.ok) {
    const { products } = await prodRes.json();
    for (const prod of products) {
      for (const variant of prod.variants || []) {
        await query(`
          INSERT INTO produto (empresa_id, nome, referencia, preco_venda, stock_actual, ativo, origem, campos_extra)
          VALUES ($1,$2,$3,$4,$5,$6,'shopify',$7)
          ON CONFLICT (empresa_id, referencia) DO UPDATE SET
            preco_venda=$4, stock_actual=$5, campos_extra=$7
        `, [
          integracao.empresa_id,
          prod.title + (variant.title !== 'Default Title' ? ` - ${variant.title}` : ''),
          variant.sku || `SHOP-${variant.id}`,
          parseFloat(variant.price),
          variant.inventory_quantity || 0,
          prod.status === 'active',
          JSON.stringify({ shopify_product_id: prod.id, shopify_variant_id: variant.id })
        ]).catch(() => {});
        syncados.produtos++;
      }
    }
  }

  return syncados;
}

function mapShopifyStatus(financial, fulfillment) {
  if (financial === 'paid' && fulfillment === 'fulfilled') return 'entregue';
  if (fulfillment === 'in_transit') return 'enviada';
  if (fulfillment === 'partial') return 'em_preparacao';
  if (financial === 'paid') return 'confirmada';
  if (financial === 'pending') return 'pendente';
  return 'pendente';
}

// ── WOOCOMMERCE ──

async function syncWooCommerce(integracao) {
  const { site_url, consumer_key, consumer_secret } = integracao.config;
  const auth = Buffer.from(`${consumer_key}:${consumer_secret}`).toString('base64');
  const base = `${site_url}/wp-json/wc/v3`;
  const headers = { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' };

  let syncados = { encomendas: 0, produtos: 0, clientes: 0 };

  // Encomendas
  const ordersRes = await fetch(`${base}/orders?per_page=100&modified_after=${new Date(Date.now()-24*3600000).toISOString()}`, { headers });
  if (ordersRes.ok) {
    const orders = await ordersRes.json();
    for (const order of orders) {
      await query(`
        INSERT INTO encomenda (empresa_id, numero, origem, origem_id, cliente_nome, cliente_email,
          total, estado, data_encomenda, linhas, campos_extra)
        VALUES ($1,$2,'woocommerce',$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (empresa_id, origem, origem_id) DO UPDATE SET estado=$7, campos_extra=$10
      `, [
        integracao.empresa_id,
        `WOO-${order.number}`,
        order.id.toString(),
        `${order.billing?.first_name} ${order.billing?.last_name}`,
        order.billing?.email || '',
        parseFloat(order.total),
        mapWooStatus(order.status),
        order.date_created,
        JSON.stringify(order.line_items?.map(l => ({ produto: l.name, qty: l.quantity, preco: l.price }))),
        JSON.stringify({ woo_id: order.id, payment_method: order.payment_method_title })
      ]).catch(() => {});
      syncados.encomendas++;
    }
  }

  // Produtos
  const prodRes = await fetch(`${base}/products?per_page=100`, { headers });
  if (prodRes.ok) {
    const products = await prodRes.json();
    for (const prod of products) {
      await query(`
        INSERT INTO produto (empresa_id, nome, referencia, preco_venda, stock_actual, ativo, origem, campos_extra)
        VALUES ($1,$2,$3,$4,$5,$6,'woocommerce',$7)
        ON CONFLICT (empresa_id, referencia) DO UPDATE SET preco_venda=$4, stock_actual=$5, campos_extra=$7
      `, [
        integracao.empresa_id,
        prod.name,
        prod.sku || `WOO-${prod.id}`,
        parseFloat(prod.price || 0),
        prod.stock_quantity || 0,
        prod.status === 'publish',
        JSON.stringify({ woo_id: prod.id, categories: prod.categories?.map(c=>c.name) })
      ]).catch(() => {});
      syncados.produtos++;
    }
  }

  return syncados;
}

function mapWooStatus(status) {
  const map = { pending:'pendente', processing:'confirmada', 'on-hold':'pendente',
    completed:'entregue', cancelled:'cancelada', refunded:'cancelada', failed:'cancelada' };
  return map[status] || 'pendente';
}

// ── SINCRONIZAÇÃO MANUAL ──

router.post('/sync/:id', async (req, res) => {
  try {
    const r = await query(`SELECT * FROM integracao_ecommerce WHERE id=$1 AND empresa_id=$2`, [req.params.id, req.empresaId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Integração não encontrada' });
    const integracao = r.rows[0];
    integracao.config = typeof integracao.config === 'string' ? JSON.parse(integracao.config) : integracao.config;

    let resultado;
    if (integracao.plataforma === 'shopify') resultado = await syncShopify(integracao);
    else if (integracao.plataforma === 'woocommerce') resultado = await syncWooCommerce(integracao);
    else return res.status(400).json({ error: 'Plataforma não suportada' });

    await query(`UPDATE integracao_ecommerce SET ultimo_sync=NOW(), ultima_sync_resultado=$1 WHERE id=$2`,
      [JSON.stringify(resultado), req.params.id]);

    res.json({ ok: true, sincronizados: resultado });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SINCRONIZAÇÃO AUTOMÁTICA (chamada pelo cron) ──

async function syncTodas(empresaId) {
  const r = await query(`SELECT * FROM integracao_ecommerce WHERE ativo=true${empresaId?' AND empresa_id=$1':''}`,
    empresaId ? [empresaId] : []).catch(() => ({ rows: [] }));

  for (const integ of r.rows) {
    integ.config = typeof integ.config === 'string' ? JSON.parse(integ.config) : integ.config;
    try {
      let res;
      if (integ.plataforma === 'shopify') res = await syncShopify(integ);
      else if (integ.plataforma === 'woocommerce') res = await syncWooCommerce(integ);
      console.log(`[E-commerce] ${integ.plataforma} sincronizado:`, res);
      await query(`UPDATE integracao_ecommerce SET ultimo_sync=NOW() WHERE id=$1`, [integ.id]);
    } catch(e) {
      console.error(`[E-commerce] Erro ${integ.plataforma}:`, e.message);
    }
  }
}

// ── ENCOMENDAS (listagem) ──

router.get('/encomendas', async (req, res) => {
  try {
    const { estado, origem, limite=50 } = req.query;
    const conds = ['empresa_id=$1'], params = [req.empresaId];
    let p = 2;
    if (estado) { conds.push(`estado=$${p++}`); params.push(estado); }
    if (origem) { conds.push(`origem=$${p++}`); params.push(origem); }
    params.push(parseInt(limite));

    const r = await query(`
      SELECT * FROM encomenda WHERE ${conds.join(' AND ')}
      ORDER BY data_encomenda DESC LIMIT $${p}
    `, params).catch(() => ({ rows: [] }));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── WEBHOOK SHOPIFY ──

router.post('/webhook/shopify/:empresaId', async (req, res) => {
  try {
    const { empresaId } = req.params;
    const topic = req.headers['x-shopify-topic'];
    const data = req.body;

    if (topic === 'orders/create' || topic === 'orders/updated') {
      const integ = await query(`SELECT * FROM integracao_ecommerce WHERE empresa_id=$1 AND plataforma='shopify'`, [empresaId]);
      if (integ.rows.length) {
        await query(`
          INSERT INTO encomenda (empresa_id,numero,origem,origem_id,cliente_nome,cliente_email,total,estado,data_encomenda,linhas,campos_extra)
          VALUES ($1,$2,'shopify',$3,$4,$5,$6,$7,$8,$9,$10)
          ON CONFLICT (empresa_id,origem,origem_id) DO UPDATE SET estado=$7, campos_extra=$10
        `, [
          empresaId, `SHOP-${data.order_number}`, data.id.toString(),
          data.customer ? `${data.customer.first_name} ${data.customer.last_name}` : 'Cliente',
          data.email || '', parseFloat(data.total_price),
          mapShopifyStatus(data.financial_status, data.fulfillment_status),
          data.created_at,
          JSON.stringify(data.line_items?.map(l=>({produto:l.title,qty:l.quantity,preco:l.price}))),
          JSON.stringify({ shopify_id: data.id })
        ]).catch(() => {});
      }
    }
    res.status(200).json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── WEBHOOK WOOCOMMERCE ──

router.post('/webhook/woocommerce/:empresaId', async (req, res) => {
  try {
    const { empresaId } = req.params;
    const order = req.body;
    await query(`
      INSERT INTO encomenda (empresa_id,numero,origem,origem_id,cliente_nome,cliente_email,total,estado,data_encomenda,linhas,campos_extra)
      VALUES ($1,$2,'woocommerce',$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (empresa_id,origem,origem_id) DO UPDATE SET estado=$7
    `, [
      empresaId, `WOO-${order.number}`, order.id.toString(),
      `${order.billing?.first_name} ${order.billing?.last_name}`,
      order.billing?.email || '', parseFloat(order.total),
      mapWooStatus(order.status), order.date_created,
      JSON.stringify(order.line_items?.map(l=>({produto:l.name,qty:l.quantity,preco:l.price}))),
      JSON.stringify({ woo_id: order.id })
    ]).catch(() => {});
    res.status(200).json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = { router, syncTodas };
