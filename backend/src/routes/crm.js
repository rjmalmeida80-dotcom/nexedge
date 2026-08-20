'use strict';
const router = require('express').Router();
const { autenticar, autorizar } = require('../middleware/auth');
const { query } = require('../config/database');

const GESTORES = ['admin_empresa','rh','diretor','team_leader'];

// ═══════════════════════════════════════════════════════════════════
// DASHBOARD CRM
// ═══════════════════════════════════════════════════════════════════
router.get('/dashboard', autenticar, async (req, res) => {
  try {
    const { rows:[stats] } = await query(`
      SELECT
        COUNT(DISTINCT o.id) AS total_oportunidades,
        COUNT(DISTINCT CASE WHEN o.etapa='lead' THEN o.id END) AS leads,
        COUNT(DISTINCT CASE WHEN o.etapa='qualificado' THEN o.id END) AS qualificados,
        COUNT(DISTINCT CASE WHEN o.etapa='proposta' THEN o.id END) AS propostas,
        COUNT(DISTINCT CASE WHEN o.etapa='negociacao' THEN o.id END) AS negociacao,
        COUNT(DISTINCT CASE WHEN o.etapa='fechado_ganho' THEN o.id END) AS ganhos,
        COUNT(DISTINCT CASE WHEN o.etapa='fechado_perdido' THEN o.id END) AS perdidos,
        COALESCE(SUM(CASE WHEN o.etapa NOT IN ('fechado_ganho','fechado_perdido') THEN o.valor END), 0) AS pipeline_valor,
        COALESCE(SUM(CASE WHEN o.etapa='fechado_ganho' THEN o.valor END), 0) AS ganhos_valor,
        COUNT(DISTINCT ce.id) AS total_empresas,
        COUNT(DISTINCT cc.id) AS total_contactos
      FROM empresa e
      LEFT JOIN crm_oportunidade o ON o.empresa_id = e.id
      LEFT JOIN crm_empresa ce ON ce.empresa_id = e.id
      LEFT JOIN crm_contacto cc ON cc.empresa_id = e.id
      WHERE e.id=$1
    `, [req.empresaId]);

    // Tarefas em atraso
    const { rows: tarefasAtraso } = await query(`
      SELECT t.*, u.nome_completo AS responsavel_nome
      FROM crm_tarefa t
      LEFT JOIN utilizador u ON u.id = t.responsavel_id
      WHERE t.empresa_id=$1 AND t.estado='pendente'
        AND t.data_vencimento < CURRENT_DATE
      ORDER BY t.data_vencimento
      LIMIT 5
    `, [req.empresaId]);

    // Oportunidades a fechar este mês
    const { rows: aFechar } = await query(`
      SELECT o.*, ce.nome AS empresa_nome, u.nome_completo AS responsavel_nome
      FROM crm_oportunidade o
      LEFT JOIN crm_empresa ce ON ce.id = o.crm_empresa_id
      LEFT JOIN utilizador u ON u.id = o.responsavel_id
      WHERE o.empresa_id=$1
        AND o.etapa NOT IN ('fechado_ganho','fechado_perdido')
        AND o.data_fecho_prevista BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'
      ORDER BY o.data_fecho_prevista
      LIMIT 5
    `, [req.empresaId]);

    res.json({ stats, tarefasAtraso, aFechar });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════
// EMPRESAS CRM
// ═══════════════════════════════════════════════════════════════════
router.get('/empresas', autenticar, async (req, res) => {
  try {
    const { busca, setor } = req.query;
    let where = 'WHERE ce.empresa_id=$1';
    const params = [req.empresaId];
    if (busca) { params.push(`%${busca}%`); where += ` AND (ce.nome ILIKE $${params.length} OR ce.email ILIKE $${params.length})`; }
    if (setor) { params.push(setor); where += ` AND ce.setor=$${params.length}`; }

    const { rows } = await query(`
      SELECT ce.*,
        COUNT(DISTINCT cc.id) AS total_contactos,
        COUNT(DISTINCT o.id) AS total_oportunidades,
        COALESCE(SUM(CASE WHEN o.etapa='fechado_ganho' THEN o.valor END),0) AS total_ganho
      FROM crm_empresa ce
      LEFT JOIN crm_contacto cc ON cc.crm_empresa_id = ce.id
      LEFT JOIN crm_oportunidade o ON o.crm_empresa_id = ce.id
      ${where}
      GROUP BY ce.id
      ORDER BY ce.actualizado_em DESC
    `, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/empresas', autenticar, async (req, res) => {
  try {
    const { nome, nif, setor, dimensao, website, telefone, email, morada, cidade, notas, tags } = req.body;
    if (!nome) return res.status(400).json({ error: 'Nome obrigatório' });
    const { rows:[ce] } = await query(`
      INSERT INTO crm_empresa (empresa_id, nome, nif, setor, dimensao, website, telefone, email, morada, cidade, notas, tags, criado_por)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *
    `, [req.empresaId, nome, nif||null, setor||null, dimensao||null, website||null, telefone||null, email||null, morada||null, cidade||null, notas||null, JSON.stringify(tags||[]), req.utilizador.id]);
    res.status(201).json(ce);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.patch('/empresas/:id', autenticar, async (req, res) => {
  try {
    const { nome, nif, setor, dimensao, website, telefone, email, morada, cidade, notas } = req.body;
    const { rows:[ce] } = await query(`
      UPDATE crm_empresa SET nome=COALESCE($1,nome), nif=COALESCE($2,nif),
        setor=COALESCE($3,setor), dimensao=COALESCE($4,dimensao),
        website=COALESCE($5,website), telefone=COALESCE($6,telefone),
        email=COALESCE($7,email), morada=COALESCE($8,morada),
        cidade=COALESCE($9,cidade), notas=COALESCE($10,notas),
        actualizado_em=NOW()
      WHERE id=$11 AND empresa_id=$12 RETURNING *
    `, [nome,nif,setor,dimensao,website,telefone,email,morada,cidade,notas,req.params.id,req.empresaId]);
    res.json(ce);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════
// CONTACTOS
// ═══════════════════════════════════════════════════════════════════
router.get('/contactos', autenticar, async (req, res) => {
  try {
    const { busca, crm_empresa_id } = req.query;
    let where = 'WHERE cc.empresa_id=$1';
    const params = [req.empresaId];
    if (busca) { params.push(`%${busca}%`); where += ` AND (cc.nome ILIKE $${params.length} OR cc.email ILIKE $${params.length})`; }
    if (crm_empresa_id) { params.push(crm_empresa_id); where += ` AND cc.crm_empresa_id=$${params.length}`; }

    const { rows } = await query(`
      SELECT cc.*, ce.nome AS empresa_nome
      FROM crm_contacto cc
      LEFT JOIN crm_empresa ce ON ce.id = cc.crm_empresa_id
      ${where}
      ORDER BY cc.nome
    `, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/contactos', autenticar, async (req, res) => {
  try {
    const { crm_empresa_id, nome, cargo, email, telefone, linkedin, notas, decisor } = req.body;
    if (!nome) return res.status(400).json({ error: 'Nome obrigatório' });
    const { rows:[cc] } = await query(`
      INSERT INTO crm_contacto (empresa_id, crm_empresa_id, nome, cargo, email, telefone, linkedin, notas, decisor)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
    `, [req.empresaId, crm_empresa_id||null, nome, cargo||null, email||null, telefone||null, linkedin||null, notas||null, decisor||false]);
    res.status(201).json(cc);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════
// PIPELINE / OPORTUNIDADES
// ═══════════════════════════════════════════════════════════════════
router.get('/oportunidades', autenticar, async (req, res) => {
  try {
    const { etapa, responsavel_id } = req.query;
    let where = 'WHERE o.empresa_id=$1';
    const params = [req.empresaId];
    if (etapa) { params.push(etapa); where += ` AND o.etapa=$${params.length}`; }
    if (responsavel_id) { params.push(responsavel_id); where += ` AND o.responsavel_id=$${params.length}`; }

    const { rows } = await query(`
      SELECT o.*, ce.nome AS cliente_nome, ce.setor AS cliente_setor,
        cc.nome AS contacto_nome, cc.cargo AS contacto_cargo,
        u.nome_completo AS responsavel_nome
      FROM crm_oportunidade o
      LEFT JOIN crm_empresa ce ON ce.id = o.crm_empresa_id
      LEFT JOIN crm_contacto cc ON cc.id = o.crm_contacto_id
      LEFT JOIN utilizador u ON u.id = o.responsavel_id
      ${where}
      ORDER BY o.data_fecho_prevista NULLS LAST, o.valor DESC
    `, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/oportunidades', autenticar, async (req, res) => {
  try {
    const { crm_empresa_id, crm_contacto_id, titulo, descricao, valor, etapa,
            probabilidade, data_fecho_prevista, responsavel_id, fonte, prioridade } = req.body;
    if (!titulo) return res.status(400).json({ error: 'Título obrigatório' });

    const { rows:[o] } = await query(`
      INSERT INTO crm_oportunidade (empresa_id, crm_empresa_id, crm_contacto_id, titulo, descricao,
        valor, etapa, probabilidade, data_fecho_prevista, responsavel_id, fonte, prioridade, criado_por)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *
    `, [req.empresaId, crm_empresa_id||null, crm_contacto_id||null, titulo, descricao||null,
        valor||null, etapa||'lead', probabilidade||10, data_fecho_prevista||null,
        responsavel_id||req.utilizador.id, fonte||null, prioridade||'normal', req.utilizador.id]);
    res.status(201).json(o);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.patch('/oportunidades/:id', autenticar, async (req, res) => {
  try {
    const { titulo, valor, etapa, probabilidade, data_fecho_prevista,
            responsavel_id, motivo_perda, prioridade, descricao } = req.body;

    // Se fechou, registar data real
    const dataFechoReal = ['fechado_ganho','fechado_perdido'].includes(etapa) ? 'CURRENT_DATE' : 'data_fecho_real';

    const { rows:[o] } = await query(`
      UPDATE crm_oportunidade SET
        titulo=COALESCE($1,titulo), valor=COALESCE($2,valor),
        etapa=COALESCE($3,etapa), probabilidade=COALESCE($4,probabilidade),
        data_fecho_prevista=COALESCE($5,data_fecho_prevista),
        responsavel_id=COALESCE($6,responsavel_id),
        motivo_perda=COALESCE($7,motivo_perda),
        prioridade=COALESCE($8,prioridade),
        descricao=COALESCE($9,descricao),
        data_fecho_real=CASE WHEN $3 IN ('fechado_ganho','fechado_perdido') THEN CURRENT_DATE ELSE data_fecho_real END,
        actualizado_em=NOW()
      WHERE id=$10 AND empresa_id=$11 RETURNING *
    `, [titulo,valor,etapa,probabilidade,data_fecho_prevista,responsavel_id,motivo_perda,prioridade,descricao,req.params.id,req.empresaId]);
    res.json(o);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════
// INTERACÇÕES
// ═══════════════════════════════════════════════════════════════════
// Listar todas as interacções da empresa
router.get('/interacoes', autenticar, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT i.*, u.nome_completo AS utilizador_nome,
        o.titulo AS oportunidade_titulo, e.nome AS empresa_nome
      FROM crm_interacao i
      LEFT JOIN utilizador u ON u.id = i.criado_por
      LEFT JOIN crm_oportunidade o ON o.id = i.oportunidade_id
      LEFT JOIN crm_empresa e ON e.id = i.crm_empresa_id
      WHERE i.empresa_id=$1
      ORDER BY i.data_interacao DESC
      LIMIT 100
    `, [req.empresaId]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/interacoes/:oportunidade_id', autenticar, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT i.*, u.nome_completo AS criado_por_nome
      FROM crm_interacao i
      LEFT JOIN utilizador u ON u.id = i.criado_por
      WHERE i.oportunidade_id=$1 AND i.empresa_id=$2
      ORDER BY i.data_interacao DESC
    `, [req.params.oportunidade_id, req.empresaId]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/interacoes', autenticar, async (req, res) => {
  try {
    const { oportunidade_id, crm_empresa_id, crm_contacto_id, tipo,
            titulo, descricao, notas, data_interacao, duracao_minutos, resultado, proxima_accao, proximo_passo, data_proxima_accao } = req.body;
    const notas_final = notas || descricao || '';
    if (!tipo) return res.status(400).json({ error: 'Tipo obrigatório' });

    const { rows:[i] } = await query(`
      INSERT INTO crm_interacao (empresa_id, oportunidade_id, crm_empresa_id, crm_contacto_id,
        tipo, titulo, descricao, data_interacao, duracao_minutos, resultado, proxima_accao, data_proxima_accao, criado_por)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *
    `, [req.empresaId, oportunidade_id||null, crm_empresa_id||null, crm_contacto_id||null,
        tipo, titulo||null, notas_final, data_interacao||new Date(), duracao_minutos||null,
        resultado||null, proxima_accao||proximo_passo||null, data_proxima_accao||null, req.utilizador.id]);

    // Se há próxima acção, criar tarefa automaticamente
    if (proxima_accao && data_proxima_accao) {
      await query(`
        INSERT INTO crm_tarefa (empresa_id, oportunidade_id, titulo, tipo, data_vencimento, responsavel_id, criado_por)
        VALUES ($1,$2,$3,'followup',$4,$5,$5)
      `, [req.empresaId, oportunidade_id||null, proxima_accao, data_proxima_accao, req.utilizador.id]).catch(()=>{});
    }

    res.status(201).json(i);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════
// TAREFAS
// ═══════════════════════════════════════════════════════════════════
router.get('/tarefas', autenticar, async (req, res) => {
  try {
    const { estado, responsavel_id } = req.query;
    let where = 'WHERE t.empresa_id=$1';
    const params = [req.empresaId];
    if (estado) { params.push(estado); where += ` AND t.estado=$${params.length}`; }
    if (responsavel_id) { params.push(responsavel_id); where += ` AND t.responsavel_id=$${params.length}`; }

    const { rows } = await query(`
      SELECT t.*, u.nome_completo AS responsavel_nome,
        o.titulo AS oportunidade_titulo, ce.nome AS empresa_nome
      FROM crm_tarefa t
      LEFT JOIN utilizador u ON u.id = t.responsavel_id
      LEFT JOIN crm_oportunidade o ON o.id = t.oportunidade_id
      LEFT JOIN crm_empresa ce ON ce.id = t.crm_empresa_id
      ${where}
      ORDER BY t.data_vencimento NULLS LAST, t.prioridade DESC
    `, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/tarefas', autenticar, async (req, res) => {
  try {
    const { oportunidade_id, crm_empresa_id, titulo, descricao, tipo, prioridade, data_vencimento, responsavel_id } = req.body;
    if (!titulo) return res.status(400).json({ error: 'Título obrigatório' });
    const { rows:[t] } = await query(`
      INSERT INTO crm_tarefa (empresa_id, oportunidade_id, crm_empresa_id, titulo, descricao, tipo, prioridade, data_vencimento, responsavel_id, criado_por)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *
    `, [req.empresaId, oportunidade_id||null, crm_empresa_id||null, titulo, descricao||null,
        tipo||'tarefa', prioridade||'normal', data_vencimento||null, responsavel_id||req.utilizador.id]);
    res.status(201).json(t);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.patch('/tarefas/:id/concluir', autenticar, async (req, res) => {
  try {
    const { rows:[t] } = await query(
      "UPDATE crm_tarefa SET estado='concluida', data_conclusao=CURRENT_DATE WHERE id=$1 AND empresa_id=$2 RETURNING *",
      [req.params.id, req.empresaId]
    );
    res.json(t);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
