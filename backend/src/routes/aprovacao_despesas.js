'use strict';
const router = require('express').Router();
const { autenticar, autorizar } = require('../middleware/auth');
const { query } = require('../config/database');

// ── Listar despesas (filtrado por perfil) ─────────────────────────────────────
router.get('/', autenticar, async (req, res) => {
  try {
    const { estado, pagina = 1 } = req.query;
    const perfil = req.utilizador.perfil;
    const eid = req.empresaId;
    let where = 'WHERE d.empresa_id=$1';
    const params = [eid];

    // Colaborador só vê as suas
    if (perfil === 'colaborador') {
      const { rows:[func] } = await query(
        `SELECT id FROM funcionario WHERE utilizador_id=$1 OR email_empresa=(SELECT email FROM utilizador WHERE id=$1) LIMIT 1`,
        [req.utilizador.id]
      );
      if (func) { params.push(func.id); where += ` AND d.funcionario_id=$${params.length}`; }
    }

    if (estado) { params.push(estado); where += ` AND d.estado_aprovacao=$${params.length}`; }

    const offset = (parseInt(pagina)-1)*20;
    const { rows } = await query(`
      SELECT d.*, f.nome_completo AS funcionario_nome, f.cargo AS funcionario_cargo
      FROM despesa d
      JOIN funcionario f ON f.id=d.funcionario_id
      ${where}
      ORDER BY d.criado_em DESC LIMIT 20 OFFSET ${offset}
    `, params);

    const { rows:[tot] } = await query(`SELECT COUNT(*) FROM despesa d ${where}`, params);
    res.json({ despesas: rows, total: parseInt(tot.count) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Submeter despesa (colaborador) ────────────────────────────────────────────
router.post('/', autenticar, async (req, res) => {
  try {
    const { descricao, categoria, valor, data_despesa, notas, funcionario_id } = req.body;
    if (!descricao || !valor) return res.status(400).json({ error: 'Descrição e valor obrigatórios' });

    // 1. Se o body já traz funcionario_id — usar directamente
    let funcIdFinal = funcionario_id || null;

    // 2. Tentar encontrar funcionário ligado ao utilizador logado
    if (!funcIdFinal) {
      const { rows:[func] } = await query(
        `SELECT f.id FROM funcionario f
         WHERE f.utilizador_id=$1 AND f.empresa_id=$2
         LIMIT 1`,
        [req.utilizador.id, req.empresaId]
      );
      funcIdFinal = func?.id || null;
    }

    // 3. Tentar pelo email
    if (!funcIdFinal) {
      const { rows:[u] } = await query('SELECT email FROM utilizador WHERE id=$1', [req.utilizador.id]);
      if (u?.email) {
        const { rows:[func2] } = await query(
          `SELECT id FROM funcionario WHERE empresa_id=$1 AND (email_empresa=$2 OR email_pessoal=$2) LIMIT 1`,
          [req.empresaId, u.email]
        );
        funcIdFinal = func2?.id || null;
      }
    }

    if (!funcIdFinal) return res.status(400).json({ error: 'Selecciona o colaborador para a despesa. O teu utilizador não tem funcionário associado.' });

    const { rows:[d] } = await query(`
      INSERT INTO despesa (empresa_id, funcionario_id, descricao, categoria, valor, data_despesa, notas, estado_aprovacao, submetido_em)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'pendente_gestor', NOW())
      RETURNING *
    `, [req.empresaId, funcIdFinal, descricao, categoria||'outro', valor, data_despesa||new Date(), notas||null]);

    // Notificar gestores
    const { rows: gestores } = await query(
      `SELECT id FROM utilizador WHERE empresa_id=$1 AND perfil IN ('admin_empresa','rh','diretor') AND ativo=true`,
      [req.empresaId]
    );
    for (const g of gestores) {
      await query(`INSERT INTO notificacao (utilizador_id, titulo, mensagem, tipo, url_accao)
        VALUES ($1,$3,$4,'info','/despesas')`,
        [g.id, `Nova despesa para aprovar`, `Despesa "${descricao}" de ${parseFloat(valor).toFixed(2)}€ aguarda aprovação`]
      ).catch(()=>{});
    }

    res.status(201).json(d);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Aprovar despesa (gestor → financeiro) ─────────────────────────────────────
router.patch('/:id/aprovar-gestor', autenticar, autorizar('admin_empresa','rh','diretor'), async (req, res) => {
  try {
    const { rows:[d] } = await query(`
      UPDATE despesa SET estado_aprovacao='pendente_financeiro',
        aprovado_gestor_por=$1, aprovado_gestor_em=NOW()
      WHERE id=$2 AND empresa_id=$3 AND estado_aprovacao='pendente_gestor'
      RETURNING *
    `, [req.utilizador.id, req.params.id, req.empresaId]);

    if (!d) return res.status(400).json({ error: 'Despesa não encontrada ou já processada' });

    // Notificar financeiro
    const { rows: fin } = await query(
      `SELECT id FROM utilizador WHERE empresa_id=$1 AND perfil IN ('admin_empresa','diretor') AND ativo=true`,
      [req.empresaId]
    );
    for (const f of fin) {
      await query(`INSERT INTO notificacao (utilizador_id, titulo, mensagem, tipo, url_accao)
        VALUES ($1,$3,$4,'info','/despesas')`,
        [f.id, req.empresaId, `Despesa aprovada pelo gestor — aguarda financeiro`,
         `"${d.descricao}" (${parseFloat(d.valor).toFixed(2)}€) precisa de aprovação final`]
      ).catch(()=>{});
    }

    res.json(d);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Aprovação final financeiro ────────────────────────────────────────────────
router.patch('/:id/aprovar-financeiro', autenticar, autorizar('admin_empresa','diretor'), async (req, res) => {
  try {
    const { rows:[d] } = await query(`
      UPDATE despesa SET estado_aprovacao='aprovado',
        aprovado_financeiro_por=$1, aprovado_financeiro_em=NOW()
      WHERE id=$2 AND empresa_id=$3 AND estado_aprovacao='pendente_financeiro'
      RETURNING *, (SELECT funcionario_id FROM despesa WHERE id=$2) AS func_id
    `, [req.utilizador.id, req.params.id, req.empresaId]);

    if (!d) return res.status(400).json({ error: 'Despesa não encontrada ou já processada' });
    res.json(d);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Rejeitar despesa ──────────────────────────────────────────────────────────
router.patch('/:id/rejeitar', autenticar, autorizar('admin_empresa','rh','diretor'), async (req, res) => {
  try {
    const { motivo } = req.body;
    const { rows:[d] } = await query(`
      UPDATE despesa SET estado_aprovacao='rejeitado', notas=COALESCE(notas||' | ','') || $1
      WHERE id=$2 AND empresa_id=$3
      RETURNING *
    `, [`Rejeitado: ${motivo||'sem motivo'}`, req.params.id, req.empresaId]);
    if (!d) return res.status(404).json({ error: 'Não encontrado' });
    res.json(d);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Stats de despesas ─────────────────────────────────────────────────────────
router.get('/stats', autenticar, autorizar('admin_empresa','rh','diretor'), async (req, res) => {
  try {
    const { rows:[s] } = await query(`SELECT
      COUNT(*) FILTER(WHERE estado_aprovacao='pendente_gestor') AS pendente_gestor,
      COUNT(*) FILTER(WHERE estado_aprovacao='pendente_financeiro') AS pendente_financeiro,
      COUNT(*) FILTER(WHERE estado_aprovacao='aprovado') AS aprovado,
      COUNT(*) FILTER(WHERE estado_aprovacao='rejeitado') AS rejeitado,
      COALESCE(SUM(valor) FILTER(WHERE estado_aprovacao='aprovado'),0) AS valor_aprovado,
      COALESCE(SUM(valor) FILTER(WHERE estado_aprovacao='pendente_gestor' OR estado_aprovacao='pendente_financeiro'),0) AS valor_pendente
      FROM despesa WHERE empresa_id=$1 AND EXTRACT(YEAR FROM criado_em)=EXTRACT(YEAR FROM NOW())
    `, [req.empresaId]);
    res.json(s);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
