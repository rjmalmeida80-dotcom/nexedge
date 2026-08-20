'use strict';

const router  = require('express').Router();
const { autenticar, autorizar } = require('../middleware/auth');
const { middlewareAuditoria }   = require('../middleware/auditoria');
const { query }   = require('../config/database');
const { criarErro } = require('../middleware/errorHandler');

// ── Rota raiz (alias de /vagas) ───────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { rows } = await query("SELECT * FROM recrutamento_vagas WHERE empresa_id=$1 ORDER BY criado_em DESC", [req.empresaId]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

const RH = ['admin_empresa','admin_plataforma','rh','diretor'];
router.use(autenticar, middlewareAuditoria);

// ── VAGAS ─────────────────────────────────────────────────────────────────────

// GET /api/recrutamento/vagas
router.get('/vagas', async (req, res) => {
  const { estado, busca } = req.query;
  const params = [req.empresaId];
  const conds  = ['empresa_id=$1'];
  let p = 2;
  if (estado) { conds.push(`estado=$${p}`); params.push(estado); p++; }
  if (busca)  { conds.push(`(titulo ILIKE $${p} OR departamento ILIKE $${p})`); params.push(`%${busca}%`); p++; }

  const { rows } = await query(`
    SELECT v.*,
      (SELECT COUNT(*) FROM recrutamento_candidatos c WHERE c.vaga_id=v.id) AS total_candidatos
    FROM recrutamento_vagas v
    WHERE ${conds.join(' AND ')}
    ORDER BY v.criado_em DESC
  `, params);
  res.json(rows);
});

// POST /api/recrutamento/vagas
router.post('/vagas', autorizar(...RH), async (req, res) => {
  const { titulo, departamento, local, descricao, requisitos,
          salario_min, salario_max, tipo_contrato, prioridade } = req.body;
  if (!titulo) throw criarErro('Título obrigatório.', 400);

  const { rows } = await query(`
    INSERT INTO recrutamento_vagas
      (empresa_id, titulo, departamento, local, descricao, requisitos,
       salario_min, salario_max, tipo_contrato, prioridade, estado, criado_por)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ativa',$11)
    RETURNING *
  `, [req.empresaId, titulo, departamento||null, local||null, descricao||null,
      requisitos||null, salario_min||null, salario_max||null,
      tipo_contrato||'sem_termo', prioridade||'normal', req.utilizador.id]);

  await req.auditar({ acao: 'VAGA_CRIADA', tabela: 'recrutamento_vagas', registoId: rows[0].id });
  res.status(201).json(rows[0]);
});

// PATCH /api/recrutamento/vagas/:id
router.patch('/vagas/:id', autorizar(...RH), async (req, res) => {
  const campos = ['titulo','departamento','local','descricao','requisitos',
                  'salario_min','salario_max','tipo_contrato','prioridade','estado'];
  const sets = []; const vals = []; let p = 1;
  for (const c of campos) {
    if (req.body[c] !== undefined) { sets.push(`${c}=$${p}`); vals.push(req.body[c]); p++; }
  }
  if (!sets.length) throw criarErro('Nenhum campo para atualizar.', 400);
  vals.push(req.params.id, req.empresaId);
  const { rows } = await query(
    `UPDATE recrutamento_vagas SET ${sets.join(',')} WHERE id=$${p} AND empresa_id=$${p+1} RETURNING *`,
    vals
  );
  if (!rows.length) throw criarErro('Vaga não encontrada.', 404);
  res.json(rows[0]);
});

// DELETE /api/recrutamento/vagas/:id
router.delete('/vagas/:id', autorizar(...RH), async (req, res) => {
  await query(`UPDATE recrutamento_vagas SET estado='arquivada' WHERE id=$1 AND empresa_id=$2`,
    [req.params.id, req.empresaId]);
  res.json({ mensagem: 'Vaga arquivada.' });
});

// ── CANDIDATOS ────────────────────────────────────────────────────────────────

// GET /api/recrutamento/vagas/:id/candidatos
router.get('/vagas/:id/candidatos', async (req, res) => {
  const { rows } = await query(`
    SELECT c.* FROM recrutamento_candidatos c
    JOIN recrutamento_vagas v ON v.id=c.vaga_id
    WHERE c.vaga_id=$1 AND v.empresa_id=$2
    ORDER BY c.classificacao DESC NULLS LAST, c.criado_em DESC
  `, [req.params.id, req.empresaId]);
  res.json(rows);
});

// POST /api/recrutamento/vagas/:id/candidatos
router.post('/vagas/:id/candidatos', autorizar(...RH), async (req, res) => {
  const { nome, email, telefone, salario_pretendido, notas, cv_url } = req.body;
  if (!nome || !email) throw criarErro('Nome e email são obrigatórios.', 400);

  const { rows } = await query(`
    INSERT INTO recrutamento_candidatos
      (vaga_id, empresa_id, nome, email, telefone, salario_pretendido,
       notas, cv_url, etapa, adicionado_por)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'candidatura',$9)
    RETURNING *
  `, [req.params.id, req.empresaId, nome, email, telefone||null,
      salario_pretendido||null, notas||null, cv_url||null, req.utilizador.id]);

  await req.auditar({ acao: 'CANDIDATO_ADICIONADO', registoId: rows[0].id });
  res.status(201).json(rows[0]);
});

// PATCH /api/recrutamento/candidatos/:id
router.patch('/candidatos/:id', autorizar(...RH), async (req, res) => {
  const { etapa, classificacao, notas, salario_pretendido } = req.body;
  const { rows } = await query(`
    UPDATE recrutamento_candidatos SET
      etapa=COALESCE($1,etapa),
      classificacao=COALESCE($2,classificacao),
      notas=COALESCE($3,notas),
      salario_pretendido=COALESCE($4,salario_pretendido),
      atualizado_em=NOW()
    WHERE id=$5 AND empresa_id=$6
    RETURNING *
  `, [etapa||null, classificacao||null, notas||null,
      salario_pretendido||null, req.params.id, req.empresaId]);
  if (!rows.length) throw criarErro('Candidato não encontrado.', 404);
  res.json(rows[0]);
});

// GET /api/recrutamento/pipeline — todos os candidatos agrupados por etapa
router.get('/pipeline', async (req, res) => {
  const { rows } = await query(`
    SELECT c.*, v.titulo AS vaga_titulo
    FROM recrutamento_candidatos c
    JOIN recrutamento_vagas v ON v.id=c.vaga_id
    WHERE c.empresa_id=$1
    ORDER BY c.etapa, c.classificacao DESC
  `, [req.empresaId]);

  const pipeline = {};
  for (const c of rows) {
    if (!pipeline[c.etapa]) pipeline[c.etapa] = [];
    pipeline[c.etapa].push(c);
  }
  res.json(pipeline);
});

module.exports = router;
