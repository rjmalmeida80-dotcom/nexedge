'use strict';

const router  = require('express').Router();
const { autenticar, autorizar } = require('../middleware/auth');
const { middlewareAuditoria }   = require('../middleware/auditoria');
const { query }   = require('../config/database');
const { criarErro } = require('../middleware/errorHandler');

router.use(autenticar, middlewareAuditoria);

// GET /api/avaliacao — listar avaliações (RH vê todas, funcionário vê só as suas)
router.get('/', async (req, res) => {
  const ehRH = ['admin_empresa','rh','diretor'].includes(req.utilizador.perfil);
  const params = [req.empresaId];
  let where = 'a.empresa_id=$1';
  if (!ehRH && req.utilizador.funcionario_id) {
    where += ` AND a.funcionario_id=$2`;
    params.push(req.utilizador.funcionario_id);
  }
  const { rows } = await query(`
    SELECT a.*, f.nome_completo AS funcionario_nome,
           u.nome_completo AS avaliador_nome
    FROM avaliacoes a
    JOIN funcionario f ON f.id=a.funcionario_id
    LEFT JOIN utilizador u ON u.id=a.avaliador_id
    WHERE ${where}
    ORDER BY a.criado_em DESC
  `, params);
  res.json(rows);
});

// GET /api/avaliacao/:id
router.get('/:id', async (req, res) => {
  const { rows } = await query(`
    SELECT a.*, f.nome_completo, f.cargo, f.foto_url,
           u.nome_completo AS avaliador_nome
    FROM avaliacoes a
    JOIN funcionario f ON f.id=a.funcionario_id
    LEFT JOIN utilizador u ON u.id=a.avaliador_id
    WHERE a.id=$1 AND a.empresa_id=$2
  `, [req.params.id, req.empresaId]);
  if (!rows.length) throw criarErro('Avaliação não encontrada.', 404);
  res.json(rows[0]);
});

// POST /api/avaliacao — criar avaliação
router.post('/', autorizar('admin_empresa','rh','diretor','supervisor'), async (req, res) => {
  const { funcionario_id, periodo, competencias, nota_global, comentarios, recomendacao } = req.body;
  if (!funcionario_id || !periodo) throw criarErro('Funcionário e período são obrigatórios.', 400);

  const { rows } = await query(`
    INSERT INTO avaliacoes
      (empresa_id, funcionario_id, avaliador_id, periodo, competencias,
       nota_global, comentarios, recomendacao, estado)
    VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,'rascunho')
    RETURNING *
  `, [req.empresaId, funcionario_id, req.utilizador.id, periodo,
      JSON.stringify(competencias || []), nota_global||null,
      comentarios||null, recomendacao||null]);

  await req.auditar({ acao: 'AVALIACAO_CRIADA', tabela: 'avaliacoes', registoId: rows[0].id });
  res.status(201).json(rows[0]);
});

// PATCH /api/avaliacao/:id
router.patch('/:id', autorizar('admin_empresa','rh','diretor','supervisor'), async (req, res) => {
  const { competencias, nota_global, comentarios, recomendacao, estado } = req.body;
  const { rows } = await query(`
    UPDATE avaliacoes SET
      competencias=COALESCE($1::jsonb, competencias),
      nota_global=COALESCE($2, nota_global),
      comentarios=COALESCE($3, comentarios),
      recomendacao=COALESCE($4, recomendacao),
      estado=COALESCE($5, estado),
      atualizado_em=NOW()
    WHERE id=$6 AND empresa_id=$7
    RETURNING *
  `, [competencias ? JSON.stringify(competencias) : null,
      nota_global||null, comentarios||null, recomendacao||null,
      estado||null, req.params.id, req.empresaId]);
  if (!rows.length) throw criarErro('Avaliação não encontrada.', 404);
  res.json(rows[0]);
});

// ── OBJETIVOS ─────────────────────────────────────────────────────────────────

router.get('/objetivos/lista', async (req, res) => {
  const ehRH = ['admin_empresa','rh','diretor'].includes(req.utilizador.perfil);
  const params = [req.empresaId];
  let where = 'o.empresa_id=$1';
  if (!ehRH && req.utilizador.funcionario_id) {
    where += ` AND o.funcionario_id=$2`;
    params.push(req.utilizador.funcionario_id);
  }
  const { rows } = await query(`
    SELECT o.*, f.nome_completo FROM objetivos o
    JOIN funcionario f ON f.id=o.funcionario_id
    WHERE ${where} ORDER BY o.prazo ASC
  `, params);
  res.json(rows);
});

router.post('/objetivos', async (req, res) => {
  const { funcionario_id, titulo, descricao, prazo, peso } = req.body;
  const funcId = funcionario_id || req.utilizador.funcionario_id;
  if (!funcId || !titulo || !prazo) throw criarErro('Funcionário, título e prazo são obrigatórios.', 400);

  const { rows } = await query(`
    INSERT INTO objetivos (empresa_id, funcionario_id, titulo, descricao, prazo, peso, progresso, estado, criado_por)
    VALUES ($1,$2,$3,$4,$5,$6,0,'em_curso',$7) RETURNING *
  `, [req.empresaId, funcId, titulo, descricao||null, prazo, peso||20, req.utilizador.id]);
  res.status(201).json(rows[0]);
});

router.patch('/objetivos/:id', async (req, res) => {
  const { progresso, estado, titulo, descricao, prazo } = req.body;
  const { rows } = await query(`
    UPDATE objetivos SET
      progresso=COALESCE($1,progresso), estado=COALESCE($2,estado),
      titulo=COALESCE($3,titulo), descricao=COALESCE($4,descricao),
      prazo=COALESCE($5,prazo), atualizado_em=NOW()
    WHERE id=$6 AND empresa_id=$7 RETURNING *
  `, [progresso??null, estado||null, titulo||null, descricao||null,
      prazo||null, req.params.id, req.empresaId]);
  if (!rows.length) throw criarErro('Objetivo não encontrado.', 404);
  res.json(rows[0]);
});

module.exports = router;
