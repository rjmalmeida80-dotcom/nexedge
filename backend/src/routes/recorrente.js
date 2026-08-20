'use strict';
const router = require('express').Router();
const { autenticar, autorizar } = require('../middleware/auth');
const { query } = require('../config/database');
const { criarFaturaRecorrente, calcularProximaData } = require('../jobs/faturacaoRecorrente');

const GESTORES = ['admin_empresa','rh','diretor'];

// ── Listar serviços recorrentes ───────────────────────────────────────────────
router.get('/', autenticar, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT sr.*,
        COUNT(f.id) AS total_faturas_geradas,
        SUM(f.total) AS total_faturado
      FROM servico_recorrente sr
      LEFT JOIN fatura f ON f.servico_recorrente_id = sr.id
      WHERE sr.empresa_id=$1
      GROUP BY sr.id
      ORDER BY sr.proximo_faturacao, sr.cliente_nome
    `, [req.empresaId]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Criar serviço recorrente ──────────────────────────────────────────────────
router.post('/', autenticar, autorizar(...GESTORES), async (req, res) => {
  try {
    const {
      nome, descricao, cliente_nome, cliente_nif, cliente_email, cliente_morada,
      valor, valor_iva, taxa_iva, frequencia, dia_faturacao,
      data_inicio, data_fim, dias_vencimento, notas
    } = req.body;

    if (!nome || !descricao || !cliente_nome || !valor) {
      return res.status(400).json({ error: 'Nome, descrição, cliente e valor são obrigatórios' });
    }

    // Calcular primeira data de faturação
    const inicio = new Date(data_inicio || new Date());
    const proxFat = calcularProximaData(frequencia || 'mensal', inicio.toISOString().split('T')[0]);

    const { rows:[sr] } = await query(`
      INSERT INTO servico_recorrente (
        empresa_id, nome, descricao, cliente_nome, cliente_nif, cliente_email, cliente_morada,
        valor, valor_iva, taxa_iva, frequencia, dia_faturacao,
        data_inicio, data_fim, proximo_faturacao, dias_vencimento, notas, criado_por
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      RETURNING *
    `, [
      req.empresaId, nome, descricao, cliente_nome, cliente_nif||null, cliente_email||null, cliente_morada||null,
      valor, valor_iva||0, taxa_iva||23, frequencia||'mensal', dia_faturacao||1,
      inicio.toISOString().split('T')[0], data_fim||null, proxFat,
      dias_vencimento||30, notas||null, req.utilizador.id
    ]);

    res.status(201).json(sr);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Editar serviço recorrente ─────────────────────────────────────────────────
router.patch('/:id', autenticar, autorizar(...GESTORES), async (req, res) => {
  try {
    const { nome, descricao, valor, valor_iva, frequencia, data_fim, ativo, dias_vencimento, notas } = req.body;
    const { rows:[sr] } = await query(`
      UPDATE servico_recorrente SET
        nome=COALESCE($1,nome), descricao=COALESCE($2,descricao),
        valor=COALESCE($3,valor), valor_iva=COALESCE($4,valor_iva),
        frequencia=COALESCE($5,frequencia), data_fim=COALESCE($6,data_fim),
        ativo=COALESCE($7,ativo), dias_vencimento=COALESCE($8,dias_vencimento),
        notas=COALESCE($9,notas), actualizado_em=NOW()
      WHERE id=$10 AND empresa_id=$11 RETURNING *
    `, [nome, descricao, valor, valor_iva, frequencia, data_fim, ativo, dias_vencimento, notas, req.params.id, req.empresaId]);
    if (!sr) return res.status(404).json({ error: 'Serviço não encontrado' });
    res.json(sr);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Faturar agora (manual) ────────────────────────────────────────────────────
router.post('/:id/faturar', autenticar, autorizar(...GESTORES), async (req, res) => {
  try {
    const { rows:[sr] } = await query(
      'SELECT * FROM servico_recorrente WHERE id=$1 AND empresa_id=$2',
      [req.params.id, req.empresaId]
    );
    if (!sr) return res.status(404).json({ error: 'Serviço não encontrado' });
    const fat = await criarFaturaRecorrente(sr);
    res.json({ message: 'Fatura criada com sucesso', fatura: fat });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Pausar / Retomar ──────────────────────────────────────────────────────────
router.patch('/:id/toggle', autenticar, autorizar(...GESTORES), async (req, res) => {
  try {
    const { rows:[sr] } = await query(
      'UPDATE servico_recorrente SET ativo=NOT ativo, actualizado_em=NOW() WHERE id=$1 AND empresa_id=$2 RETURNING *',
      [req.params.id, req.empresaId]
    );
    res.json({ message: sr.ativo ? 'Serviço retomado' : 'Serviço pausado', ativo: sr.ativo });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Eliminar ──────────────────────────────────────────────────────────────────
router.delete('/:id', autenticar, autorizar('admin_empresa'), async (req, res) => {
  try {
    await query(
      'UPDATE servico_recorrente SET ativo=false, data_fim=CURRENT_DATE WHERE id=$1 AND empresa_id=$2',
      [req.params.id, req.empresaId]
    );
    res.json({ message: 'Serviço cancelado' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Histórico de faturas do serviço ──────────────────────────────────────────
router.get('/:id/faturas', autenticar, async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT * FROM fatura WHERE servico_recorrente_id=$1 AND empresa_id=$2 ORDER BY data_emissao DESC',
      [req.params.id, req.empresaId]
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
