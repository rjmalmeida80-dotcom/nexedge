'use strict';
/**
 * NexEdge — Portal do Motorista
 * PWA mobile-first para motoristas: rota, POD, localização, entregas
 * Acesso por token dedicado, sem login complexo
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// Auth motorista (token simples)
async function autMotorista(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Não autenticado' });
  try {
    const decoded = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
    if (decoded.tipo !== 'motorista') return res.status(403).json({ error: 'Acesso negado' });
    req.motoristaId = decoded.motorista_id;
    req.empresaId = decoded.empresa_id;
    next();
  } catch(e) { res.status(401).json({ error: 'Token inválido' }); }
}

// Login do motorista (código PIN simples)
router.post('/login', async (req, res) => {
  try {
    const { pin, empresa_id } = req.body;
    const r = await query(`SELECT m.*, e.nome as empresa_nome FROM logistica_motorista m
      JOIN empresa e ON e.id=m.empresa_id
      WHERE m.pin_acesso=$1 AND m.empresa_id=$2 AND m.estado!='inactivo'`,
      [pin, empresa_id]);

    if (!r.rows.length) return res.status(401).json({ error: 'PIN inválido' });
    const m = r.rows[0];

    const token = jwt.sign(
      { tipo:'motorista', motorista_id:m.id, empresa_id:m.empresa_id },
      process.env.JWT_SECRET, { expiresIn:'12h' }
    );

    await query(`UPDATE logistica_motorista SET ultimo_login=NOW() WHERE id=$1`, [m.id]);
    res.json({ token, motorista: { id:m.id, nome:m.nome, empresa:m.empresa_nome } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Gerar PIN para motorista (admin)
router.post('/gerar-pin/:motoristaId', async (req, res) => {
  try {
    const { autenticar } = require('../middleware/auth');
    const pin = Math.floor(1000 + Math.random() * 9000).toString();
    await query(`UPDATE logistica_motorista SET pin_acesso=$1 WHERE id=$2`, [pin, req.params.motoristaId]);
    res.json({ pin, mensagem: `PIN gerado: ${pin}` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.use(autMotorista);

// ── PERFIL DO MOTORISTA ──
router.get('/perfil', async (req, res) => {
  try {
    const r = await query(`SELECT m.*, v.matricula, v.modelo, v.tipo, v.capacidade_kg
      FROM logistica_motorista m LEFT JOIN logistica_veiculo v ON v.id=m.veiculo_id
      WHERE m.id=$1`, [req.motoristaId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Motorista não encontrado' });
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ENTREGAS DO DIA ──
router.get('/entregas', async (req, res) => {
  try {
    const { data } = req.query;
    const dia = data || new Date().toISOString().slice(0,10);

    const r = await query(`
      SELECT e.*, r.nome as rota_nome,
        p.ordem as ordem_entrega
      FROM logistica_encomenda e
      LEFT JOIN logistica_rota r ON r.id=e.rota_id
      LEFT JOIN logistica_paragem p ON p.encomenda_id=e.id
      WHERE e.motorista_id=$1
        AND e.estado NOT IN ('entregue','cancelada')
        AND (DATE(e.data_entrega_prevista)=$2 OR e.estado IN ('em_transito','em_entrega','recolhida'))
      ORDER BY COALESCE(p.ordem,999), e.prioridade DESC, e.data_entrega_prevista
    `, [req.motoristaId, dia]);

    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ACTUALIZAR LOCALIZAÇÃO GPS ──
router.post('/localizacao', async (req, res) => {
  try {
    const { latitude, longitude, velocidade_kmh } = req.body;
    await query(`UPDATE logistica_motorista SET latitude_actual=$1, longitude_actual=$2, ultima_posicao=NOW() WHERE id=$3`,
      [latitude, longitude, req.motoristaId]);

    // Actualizar localização nas encomendas em trânsito deste motorista
    await query(`UPDATE logistica_encomenda SET latitude_ultima_pos=$1, longitude_ultima_pos=$2 WHERE motorista_id=$3 AND estado='em_transito'`,
      [latitude, longitude, req.motoristaId]);

    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── MUDAR ESTADO ENTREGA ──
router.put('/entregas/:id/estado', async (req, res) => {
  try {
    const { estado, notas, latitude, longitude } = req.body;

    const transicoes = {
      recolhida: ['em_transito'],
      em_transito: ['em_entrega'],
      em_entrega: ['entregue','problema'],
      problema: ['em_transito','em_entrega'],
    };

    const enc = await query(`SELECT * FROM logistica_encomenda WHERE id=$1 AND motorista_id=$2`, [req.params.id, req.motoristaId]);
    if (!enc.rows.length) return res.status(404).json({ error: 'Encomenda não encontrada' });

    const permitidos = transicoes[enc.rows[0].estado] || [];
    if (!permitidos.includes(estado)) return res.status(400).json({ error: `Transição inválida: ${enc.rows[0].estado} → ${estado}` });

    await query(`UPDATE logistica_encomenda SET estado=$1, actualizado_em=NOW()
      ${estado==='entregue'?',data_entrega_real=NOW()':''}
      WHERE id=$2`, [estado, req.params.id]);

    await query(`INSERT INTO logistica_historico (encomenda_id, empresa_id, estado, notas, latitude, longitude)
      VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.params.id, req.empresaId, estado, notas||'', latitude||null, longitude||null]);

    res.json({ ok: true, novo_estado: estado });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POD — PROVA DE ENTREGA ──
router.post('/entregas/:id/pod', async (req, res) => {
  try {
    const { recebido_por, assinatura_base64, foto_base64, latitude, longitude, observacoes } = req.body;
    if (!recebido_por) return res.status(400).json({ error: 'Nome de quem recebeu obrigatório' });

    const hash = crypto.createHash('sha256')
      .update(`${req.params.id}|${recebido_por}|${new Date().toISOString()}`)
      .digest('hex');

    await query(`INSERT INTO logistica_pod (encomenda_id, empresa_id, recebido_por, assinatura_base64, foto_base64, latitude, longitude, observacoes, hash_verificacao)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (encomenda_id) DO UPDATE SET recebido_por=$3, assinatura_base64=$4, foto_base64=$5, latitude=$6, longitude=$7, observacoes=$8, hash_verificacao=$9`,
      [req.params.id, req.empresaId, recebido_por, assinatura_base64||null, foto_base64||null, latitude||null, longitude||null, observacoes||'', hash]);

    // Marcar como entregue
    await query(`UPDATE logistica_encomenda SET estado='entregue', data_entrega_real=NOW() WHERE id=$1`, [req.params.id]);
    await query(`INSERT INTO logistica_historico (encomenda_id, empresa_id, estado, notas, latitude, longitude)
      VALUES ($1,$2,'entregue',$3,$4,$5)`,
      [req.params.id, req.empresaId, `POD: Entregue a ${recebido_por}`, latitude||null, longitude||null]);

    res.json({ ok: true, hash });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ESTATÍSTICAS DO MOTORISTA ──
router.get('/stats', async (req, res) => {
  try {
    const r = await query(`SELECT
      COUNT(*) FILTER (WHERE estado='entregue' AND DATE(actualizado_em)=CURRENT_DATE) as entregues_hoje,
      COUNT(*) FILTER (WHERE estado NOT IN ('entregue','cancelada')) as pendentes,
      COUNT(*) FILTER (WHERE estado='entregue' AND data_entrega_real <= data_entrega_prevista AND DATE(actualizado_em)=CURRENT_DATE) as no_prazo_hoje,
      COUNT(*) FILTER (WHERE estado='entregue' AND DATE(actualizado_em)>=CURRENT_DATE-7) as entregues_semana
      FROM logistica_encomenda WHERE motorista_id=$1`, [req.motoristaId]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
