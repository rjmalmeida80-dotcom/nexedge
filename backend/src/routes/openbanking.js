'use strict';
const router = require('express').Router();
const { autenticar, autorizar } = require('../middleware/auth');
const { query } = require('../config/database');

const GESTORES = ['admin_empresa','rh','diretor'];

// ── Listar contas ─────────────────────────────────────────────────────────────
router.get('/contas', autenticar, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT cb.*,
        COUNT(mb.id) AS total_movimentos,
        MAX(mb.data) AS ultimo_movimento
      FROM conta_bancaria cb
      LEFT JOIN movimento_bancario mb ON mb.conta_id = cb.id
      WHERE cb.empresa_id=$1 AND cb.activa=true
      GROUP BY cb.id
      ORDER BY cb.criado_em
    `, [req.empresaId]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Adicionar conta manualmente ───────────────────────────────────────────────
router.post('/contas', autenticar, autorizar(...GESTORES), async (req, res) => {
  try {
    const { banco, iban, bic, descricao, saldo_actual, moeda } = req.body;
    if (!banco || !iban) return res.status(400).json({ error: 'Banco e IBAN obrigatórios' });

    const ibanLimpo = iban.replace(/\s/g, '').toUpperCase();
    const { rows:[conta] } = await query(`
      INSERT INTO conta_bancaria (empresa_id, banco, iban, bic, descricao, saldo_actual, moeda)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (empresa_id, iban) DO UPDATE SET
        banco=EXCLUDED.banco, descricao=EXCLUDED.descricao,
        saldo_actual=EXCLUDED.saldo_actual, actualizado_em=NOW()
      RETURNING *
    `, [req.empresaId, banco, ibanLimpo, bic||null, descricao||null, saldo_actual||0, moeda||'EUR']);

    res.status(201).json(conta);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Actualizar saldo da conta ─────────────────────────────────────────────────
router.patch('/contas/:id/saldo', autenticar, autorizar(...GESTORES), async (req, res) => {
  try {
    const { saldo_actual } = req.body;
    const { rows:[conta] } = await query(`
      UPDATE conta_bancaria SET saldo_actual=$1, saldo_actualizado_em=NOW(), actualizado_em=NOW()
      WHERE id=$2 AND empresa_id=$3 RETURNING *
    `, [saldo_actual, req.params.id, req.empresaId]);
    res.json(conta);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Desactivar conta ──────────────────────────────────────────────────────────
router.delete('/contas/:id', autenticar, autorizar('admin_empresa'), async (req, res) => {
  try {
    await query('UPDATE conta_bancaria SET activa=false WHERE id=$1 AND empresa_id=$2',
      [req.params.id, req.empresaId]);
    res.json({ message: 'Conta removida' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Listar movimentos ─────────────────────────────────────────────────────────
router.get('/movimentos', autenticar, async (req, res) => {
  try {
    const { conta_id, reconciliado, data_inicio, data_fim, tipo } = req.query;
    let where = 'WHERE mb.empresa_id=$1';
    const params = [req.empresaId];

    if (conta_id) { params.push(conta_id); where += ` AND mb.conta_id=$${params.length}`; }
    if (reconciliado !== undefined) { params.push(reconciliado==='true'); where += ` AND mb.reconciliado=$${params.length}`; }
    if (data_inicio) { params.push(data_inicio); where += ` AND mb.data>=$${params.length}`; }
    if (data_fim) { params.push(data_fim); where += ` AND mb.data<=$${params.length}`; }
    if (tipo) { params.push(tipo); where += ` AND mb.tipo=$${params.length}`; }

    const { rows } = await query(`
      SELECT mb.*, cb.banco, cb.iban, f.numero_completo AS fatura_numero
      FROM movimento_bancario mb
      LEFT JOIN conta_bancaria cb ON cb.id = mb.conta_id
      LEFT JOIN fatura f ON f.id = mb.fatura_id
      ${where}
      ORDER BY mb.data DESC, mb.criado_em DESC
      LIMIT 200
    `, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Importar movimentos (manual/CSV) ─────────────────────────────────────────
router.post('/movimentos/importar', autenticar, autorizar(...GESTORES), async (req, res) => {
  try {
    const { conta_id, movimentos } = req.body;
    if (!Array.isArray(movimentos) || !movimentos.length) {
      return res.status(400).json({ error: 'Lista de movimentos obrigatória' });
    }

    let importados = 0;
    let duplicados = 0;

    for (const m of movimentos) {
      const { data, descricao, valor, tipo, referencia_banco } = m;
      if (!data || !descricao || valor === undefined) continue;

      // Verificar duplicado
      const { rows:[existe] } = await query(`
        SELECT id FROM movimento_bancario
        WHERE empresa_id=$1 AND data=$2 AND valor=$3 AND descricao=$4
        LIMIT 1
      `, [req.empresaId, data, valor, descricao]);

      if (existe) { duplicados++; continue; }

      await query(`
        INSERT INTO movimento_bancario (empresa_id, conta_id, data, descricao, valor, tipo, referencia_banco)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
      `, [req.empresaId, conta_id||null, data, descricao, valor,
          tipo || (parseFloat(valor) > 0 ? 'credito' : 'debito'),
          referencia_banco||null]);
      importados++;
    }

    res.json({ importados, duplicados, total: movimentos.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Reconciliar movimento com fatura ─────────────────────────────────────────
router.patch('/movimentos/:id/reconciliar', autenticar, autorizar(...GESTORES), async (req, res) => {
  try {
    const { fatura_id } = req.body;

    const { rows:[mov] } = await query(`
      UPDATE movimento_bancario SET
        reconciliado=true, reconciliado_em=NOW(),
        reconciliado_por=$1, fatura_id=$2
      WHERE id=$3 AND empresa_id=$4 RETURNING *
    `, [req.utilizador.id, fatura_id||null, req.params.id, req.empresaId]);

    if (!mov) return res.status(404).json({ error: 'Movimento não encontrado' });

    // Se tem fatura, marcar como paga
    if (fatura_id) {
      await query(
        "UPDATE fatura SET estado='paga', actualizado_em=NOW() WHERE id=$1 AND empresa_id=$2",
        [fatura_id, req.empresaId]
      ).catch(()=>{});
    }

    res.json(mov);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Reconciliação automática ──────────────────────────────────────────────────
router.post('/reconciliar-automatico', autenticar, autorizar(...GESTORES), async (req, res) => {
  try {
    // Buscar movimentos não reconciliados
    const { rows: movimentos } = await query(`
      SELECT mb.* FROM movimento_bancario mb
      WHERE mb.empresa_id=$1 AND mb.reconciliado=false AND mb.tipo='credito'
      ORDER BY mb.data DESC LIMIT 100
    `, [req.empresaId]);

    // Buscar faturas não pagas
    const { rows: faturas } = await query(`
      SELECT f.* FROM fatura f
      WHERE f.empresa_id=$1 AND f.estado IN ('emitida','enviada')
      ORDER BY f.data_emissao DESC LIMIT 100
    `, [req.empresaId]);

    let reconciliados = 0;

    for (const mov of movimentos) {
      // Tentar fazer match pelo valor exacto
      const fatura = faturas.find(f =>
        Math.abs(parseFloat(f.total) - Math.abs(parseFloat(mov.valor))) < 0.01 &&
        !f._reconciliada
      );

      if (fatura) {
        await query(`
          UPDATE movimento_bancario SET reconciliado=true, reconciliado_em=NOW(),
            fatura_id=$1, reconciliado_por=$2 WHERE id=$3
        `, [fatura.id, req.utilizador.id, mov.id]);

        await query(
          "UPDATE fatura SET estado='paga' WHERE id=$1",
          [fatura.id]
        ).catch(()=>{});

        fatura._reconciliada = true;
        reconciliados++;
      }
    }

    const msg = reconciliados > 0
      ? `${reconciliados} movimentos reconciliados automaticamente`
      : movimentos.length === 0
        ? 'Sem movimentos bancários por reconciliar. Importa extractos primeiro.'
        : faturas.length === 0
          ? 'Sem faturas por pagar para reconciliar.'
          : `Nenhum match encontrado entre ${movimentos.length} movimentos e ${faturas.length} faturas (valores não coincidem exactamente).`;

    res.json({
      message: msg,
      reconciliados,
      movimentos_analisados: movimentos.length,
      faturas_analisadas: faturas.length,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Dashboard Open Banking ────────────────────────────────────────────────────
router.get('/dashboard', autenticar, async (req, res) => {
  try {
    const { rows:[saldos] } = await query(`
      SELECT
        COUNT(*) AS total_contas,
        COALESCE(SUM(saldo_actual),0) AS saldo_total,
        COALESCE(SUM(CASE WHEN saldo_actual > 0 THEN saldo_actual ELSE 0 END),0) AS saldo_positivo
      FROM conta_bancaria WHERE empresa_id=$1 AND activa=true
    `, [req.empresaId]);

    const { rows:[movs] } = await query(`
      SELECT
        COUNT(*) AS total_movimentos,
        COUNT(CASE WHEN reconciliado=false THEN 1 END) AS por_reconciliar,
        COALESCE(SUM(CASE WHEN tipo='credito' AND data >= DATE_TRUNC('month', CURRENT_DATE) THEN ABS(valor) ELSE 0 END),0) AS entradas_mes,
        COALESCE(SUM(CASE WHEN tipo='debito' AND data >= DATE_TRUNC('month', CURRENT_DATE) THEN ABS(valor) ELSE 0 END),0) AS saidas_mes
      FROM movimento_bancario WHERE empresa_id=$1
    `, [req.empresaId]);

    const { rows: ultimosMovimentos } = await query(`
      SELECT mb.*, cb.banco
      FROM movimento_bancario mb
      LEFT JOIN conta_bancaria cb ON cb.id = mb.conta_id
      WHERE mb.empresa_id=$1
      ORDER BY mb.data DESC, mb.criado_em DESC
      LIMIT 10
    `, [req.empresaId]);

    res.json({
      saldos,
      movimentos: movs,
      ultimos_movimentos: ultimosMovimentos,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Registar movimento manual ─────────────────────────────────────────────────
router.post('/movimentos', autenticar, autorizar(...GESTORES), async (req, res) => {
  try {
    const { conta_id, data, descricao, valor, tipo, referencia_banco, categoria } = req.body;
    if (!data || !descricao || valor === undefined) {
      return res.status(400).json({ error: 'Data, descrição e valor obrigatórios' });
    }

    const { rows:[mov] } = await query(`
      INSERT INTO movimento_bancario (empresa_id, conta_id, data, descricao, valor, tipo, referencia_banco, categoria)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
    `, [req.empresaId, conta_id||null, data, descricao, valor,
        tipo || (parseFloat(valor) > 0 ? 'credito' : 'debito'),
        referencia_banco||null, categoria||null]);

    // Actualizar saldo da conta
    if (conta_id) {
      await query(`
        UPDATE conta_bancaria SET
          saldo_actual = saldo_actual + $1,
          saldo_actualizado_em = NOW()
        WHERE id=$2
      `, [parseFloat(valor), conta_id]).catch(()=>{});
    }

    res.status(201).json(mov);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
