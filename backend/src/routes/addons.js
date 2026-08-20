'use strict';
const router = require('express').Router();
const { autenticar, autorizar } = require('../middleware/auth');
const { query } = require('../config/database');

// ── PÚBLICO — Listar add-ons disponíveis ─────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { tipo } = req.query;
    const where = tipo ? `WHERE a.ativo=true AND a.tipo=$1` : `WHERE a.ativo=true`;
    const params = tipo ? [tipo] : [];

    const { rows } = await query(`
      SELECT a.*,
        COALESCE(AVG(r.nota),0) AS nota_media,
        COUNT(r.id) AS total_reviews,
        COUNT(ae.id) AS total_empresas
      FROM addon a
      LEFT JOIN addon_review r ON r.addon_id = a.id
      LEFT JOIN addon_empresa ae ON ae.addon_id = a.id AND ae.estado='activo'
      ${where}
      GROUP BY a.id
      ORDER BY a.destaque DESC, a.ordem
    `, params);

    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PÚBLICO — Detalhe de um add-on ───────────────────────────────────────────
router.get('/:slug', async (req, res) => {
  try {
    const { rows:[addon] } = await query(`
      SELECT a.*,
        COALESCE(AVG(r.nota),0) AS nota_media,
        COUNT(r.id) AS total_reviews
      FROM addon a
      LEFT JOIN addon_review r ON r.addon_id = a.id
      WHERE a.slug=$1 AND a.ativo=true
      GROUP BY a.id
    `, [req.params.slug]);

    if (!addon) return res.status(404).json({ error: 'Add-on não encontrado' });

    const { rows: reviews } = await query(`
      SELECT r.*, e.nome AS empresa_nome
      FROM addon_review r
      JOIN empresa e ON e.id = r.empresa_id
      WHERE r.addon_id=$1
      ORDER BY r.criado_em DESC LIMIT 5
    `, [addon.id]);

    res.json({ ...addon, reviews });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CLIENTE — Add-ons da minha empresa ───────────────────────────────────────
router.get('/empresa/meus', autenticar, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT ae.*, a.nome, a.descricao, a.icone, a.cor, a.tipo, a.slug, a.features
      FROM addon_empresa ae
      JOIN addon a ON a.id = ae.addon_id
      WHERE ae.empresa_id=$1 AND ae.estado='activo'
      ORDER BY ae.criado_em DESC
    `, [req.empresaId]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CLIENTE — Comprar add-on ──────────────────────────────────────────────────
router.post('/comprar', autenticar, async (req, res) => {
  try {
    const { addon_slug, modelo_preco } = req.body;
    if (!addon_slug || !modelo_preco) {
      return res.status(400).json({ error: 'addon_slug e modelo_preco são obrigatórios' });
    }

    const { rows:[addon] } = await query(
      'SELECT * FROM addon WHERE slug=$1 AND ativo=true', [addon_slug]
    );
    if (!addon) return res.status(404).json({ error: 'Add-on não encontrado' });

    // Verificar se já tem
    const { rows: jatem } = await query(
      "SELECT id FROM addon_empresa WHERE empresa_id=$1 AND addon_id=$2 AND estado='activo'",
      [req.empresaId, addon.id]
    );
    if (jatem.length) return res.status(409).json({ error: 'Este add-on já está activo na tua conta' });

    const preco = modelo_preco === 'unico' ? addon.preco_unico : addon.preco_mensal;
    const dataFim = modelo_preco === 'unico' ? null :
      new Date(Date.now() + 30*86400000).toISOString().split('T')[0];

    // Criar factura
    const { rows:[emp] } = await query('SELECT * FROM empresa WHERE id=$1', [req.empresaId]);
    const numFat = `ADD-${Date.now().toString().slice(-6)}`;
    const { rows:[fat] } = await query(`
      INSERT INTO factura_saas (empresa_id, numero, descricao, valor, iva, total, estado, metodo_pagamento, data_emissao, data_vencimento)
      VALUES ($1,$2,$3,$4,0,$4,'pendente','pendente',CURRENT_DATE,CURRENT_DATE + INTERVAL '3 days') RETURNING *
    `, [req.empresaId, numFat, `Add-on: ${addon.nome} (${modelo_preco === 'unico' ? 'Pagamento único' : 'Mensal'})`, preco]);

    // Activar add-on (em produção só após pagamento confirmado)
    const { rows:[ae] } = await query(`
      INSERT INTO addon_empresa (empresa_id, addon_id, modelo_preco, preco_pago, estado, data_inicio, data_fim, factura_id)
      VALUES ($1,$2,$3,$4,'pendente_pagamento',CURRENT_DATE,$5,$6) RETURNING *
    `, [req.empresaId, addon.id, modelo_preco, preco, dataFim, fat.id]);

    res.status(201).json({
      message: 'Add-on solicitado! Será activado após confirmação do pagamento.',
      addon: { ...addon, ...ae },
      factura: fat,
      instrucoes_pagamento: `Paga ${preco}€ e envia o comprovativo em Portal → Pagamento`,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CLIENTE — Avaliar add-on ──────────────────────────────────────────────────
router.post('/:slug/avaliar', autenticar, async (req, res) => {
  try {
    const { nota, comentario } = req.body;
    if (!nota || nota < 1 || nota > 5) {
      return res.status(400).json({ error: 'Nota entre 1 e 5 obrigatória' });
    }
    const { rows:[addon] } = await query('SELECT id FROM addon WHERE slug=$1', [req.params.slug]);
    if (!addon) return res.status(404).json({ error: 'Add-on não encontrado' });

    await query(`
      INSERT INTO addon_review (addon_id, empresa_id, nota, comentario)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (addon_id, empresa_id) DO UPDATE SET nota=$3, comentario=$4
    `, [addon.id, req.empresaId, nota, comentario||null]);

    res.json({ message: 'Obrigado pela avaliação!' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN — Criar/editar add-on ───────────────────────────────────────────────
router.post('/', autenticar, autorizar('super_admin'), async (req, res) => {
  try {
    const { slug, nome, descricao, descricao_longa, tipo, modelo_preco,
            preco_unico, preco_mensal, icone, cor, features, destaque, ordem } = req.body;

    const { rows:[a] } = await query(`
      INSERT INTO addon (slug, nome, descricao, descricao_longa, tipo, modelo_preco,
        preco_unico, preco_mensal, icone, cor, features, destaque, ordem, criado_por)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *
    `, [slug, nome, descricao, descricao_longa||null, tipo, modelo_preco,
        preco_unico||null, preco_mensal||null, icone||'🔌', cor||'indigo',
        JSON.stringify(features||[]), destaque||false, ordem||0, req.utilizador.id]);

    res.status(201).json(a);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN — Activar add-on após pagamento ────────────────────────────────────
router.patch('/admin/activar/:id', autenticar, autorizar('super_admin'), async (req, res) => {
  try {
    await query(
      "UPDATE addon_empresa SET estado='activo' WHERE id=$1",
      [req.params.id]
    );
    await query(
      "UPDATE factura_saas SET estado='paga', data_pagamento=CURRENT_DATE WHERE id=(SELECT factura_id FROM addon_empresa WHERE id=$1)",
      [req.params.id]
    );
    res.json({ message: 'Add-on activado!' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN — Ver todas as compras ──────────────────────────────────────────────
router.get('/admin/compras', autenticar, autorizar('super_admin'), async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT ae.*, a.nome AS addon_nome, a.tipo, e.nome AS empresa_nome, e.email AS empresa_email
      FROM addon_empresa ae
      JOIN addon a ON a.id = ae.addon_id
      JOIN empresa e ON e.id = ae.empresa_id
      ORDER BY ae.criado_em DESC
    `);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
