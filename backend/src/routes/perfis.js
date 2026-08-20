'use strict';
const router = require('express').Router();
const { autenticar, autorizar } = require('../middleware/auth');
const { middlewareAuditoria } = require('../middleware/auditoria');
const { query } = require('../config/database');
const { criarErro } = require('../middleware/errorHandler');

const ADMIN = ['admin_empresa', 'admin_plataforma'];
const MODULOS = [
  'funcionarios', 'salarios', 'ferias', 'faltas', 'contratos',
  'pagamentos', 'recrutamento', 'avaliacoes', 'formacao', 'medicina',
  'documentos', 'relatorios', 'organograma', 'calendario', 'comunicacao',
  'simulador', 'legislacao', 'alertas', 'configuracoes'
];

router.use(autenticar, middlewareAuditoria);

// ── PERFIS PERSONALIZADOS ─────────────────────────────────────────────────

// Listar perfis da empresa
router.get('/', async (req, res) => {
  const { rows } = await query(`
    SELECT p.*,
      COUNT(up.utilizador_id) AS total_utilizadores,
      json_agg(pp.* ORDER BY pp.modulo) FILTER (WHERE pp.id IS NOT NULL) AS permissoes
    FROM perfil_custom p
    LEFT JOIN utilizador_perfil up ON up.perfil_id = p.id
    LEFT JOIN perfil_permissao pp ON pp.perfil_id = p.id
    WHERE p.empresa_id = $1 AND p.ativo = true
    GROUP BY p.id
    ORDER BY p.nome
  `, [req.empresaId]);
  res.json(rows);
});

// Criar perfil
router.post('/', autorizar(...ADMIN), async (req, res) => {
  const { nome, descricao, cor, permissoes } = req.body;
  if (!nome) throw criarErro('Nome é obrigatório.', 400);

  const { rows: [perfil] } = await query(`
    INSERT INTO perfil_custom (empresa_id, nome, descricao, cor)
    VALUES ($1,$2,$3,$4) RETURNING *
  `, [req.empresaId, nome, descricao||null, cor||'#185FA5']);

  // Insert permissions for each module
  if (permissoes && Object.keys(permissoes).length > 0) {
    for (const [modulo, perms] of Object.entries(permissoes)) {
      if (!MODULOS.includes(modulo)) continue;
      await query(`
        INSERT INTO perfil_permissao (perfil_id, modulo, pode_ver, pode_editar, pode_aprovar, pode_apagar)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (perfil_id, modulo) DO UPDATE SET
          pode_ver=$3, pode_editar=$4, pode_aprovar=$5, pode_apagar=$6
      `, [perfil.id, modulo,
          perms.ver||false, perms.editar||false,
          perms.aprovar||false, perms.apagar||false]);
    }
  }

  await req.auditar({ acao: 'PERFIL_CRIADO', tabela: 'perfil_custom', registoId: perfil.id });
  res.status(201).json(perfil);
});

// Actualizar perfil e permissões
router.put('/:id', autorizar(...ADMIN), async (req, res) => {
  const { nome, descricao, cor, permissoes } = req.body;

  const { rows: [perfil] } = await query(`
    UPDATE perfil_custom SET nome=$1, descricao=$2, cor=$3
    WHERE id=$4 AND empresa_id=$5 RETURNING *
  `, [nome, descricao||null, cor||'#185FA5', req.params.id, req.empresaId]);

  if (!perfil) throw criarErro('Perfil não encontrado.', 404);

  // Update permissions
  if (permissoes) {
    // Delete existing and reinsert
    await query('DELETE FROM perfil_permissao WHERE perfil_id=$1', [perfil.id]);
    for (const [modulo, perms] of Object.entries(permissoes)) {
      if (!MODULOS.includes(modulo)) continue;
      await query(`
        INSERT INTO perfil_permissao (perfil_id, modulo, pode_ver, pode_editar, pode_aprovar, pode_apagar)
        VALUES ($1,$2,$3,$4,$5,$6)
      `, [perfil.id, modulo,
          perms.ver||false, perms.editar||false,
          perms.aprovar||false, perms.apagar||false]);
    }
  }

  res.json(perfil);
});

// Apagar perfil
router.delete('/:id', autorizar(...ADMIN), async (req, res) => {
  const { rows: [p] } = await query(
    'SELECT COUNT(up.utilizador_id) AS total FROM perfil_custom pc LEFT JOIN utilizador_perfil up ON up.perfil_id=pc.id WHERE pc.id=$1 AND pc.empresa_id=$2 GROUP BY pc.id',
    [req.params.id, req.empresaId]
  );
  if (p && parseInt(p.total) > 0) throw criarErro(`Não é possível apagar — ${p.total} utilizador(es) com este perfil.`, 409);
  await query('UPDATE perfil_custom SET ativo=false WHERE id=$1 AND empresa_id=$2', [req.params.id, req.empresaId]);
  res.json({ mensagem: 'Perfil desactivado.' });
});

// ── PERFIS DE UM UTILIZADOR ───────────────────────────────────────────────

// Listar perfis de um utilizador
router.get('/utilizador/:uid', async (req, res) => {
  const { rows } = await query(`
    SELECT pc.*, up.criado_em AS atribuido_em
    FROM utilizador_perfil up
    JOIN perfil_custom pc ON pc.id = up.perfil_id
    WHERE up.utilizador_id = $1 AND pc.empresa_id = $2
    ORDER BY pc.nome
  `, [req.params.uid, req.empresaId]);
  res.json(rows);
});

// Atribuir perfil a utilizador
router.post('/utilizador/:uid', autorizar(...ADMIN), async (req, res) => {
  const { perfil_id, perfil_sistema } = req.body;

  // Update sistema profile if provided
  if (perfil_sistema) {
    await query('UPDATE utilizador SET perfil=$1 WHERE id=$2 AND empresa_id=$3',
      [perfil_sistema, req.params.uid, req.empresaId]);
  }

  // Add custom profile if provided
  if (perfil_id) {
    await query(`
      INSERT INTO utilizador_perfil (utilizador_id, perfil_id)
      VALUES ($1,$2) ON CONFLICT DO NOTHING
    `, [req.params.uid, perfil_id]);

    // Update perfis array
    await query(`
      UPDATE utilizador SET perfis = array_append(
        COALESCE(perfis, '{}'),
        (SELECT nome FROM perfil_custom WHERE id=$2)
      ) WHERE id=$1 AND NOT (perfis @> ARRAY[(SELECT nome FROM perfil_custom WHERE id=$2)])
    `, [req.params.uid, perfil_id]);
  }

  res.json({ mensagem: 'Perfil atribuído.' });
});

// Remover perfil de utilizador
router.delete('/utilizador/:uid/:perfil_id', autorizar(...ADMIN), async (req, res) => {
  await query('DELETE FROM utilizador_perfil WHERE utilizador_id=$1 AND perfil_id=$2',
    [req.params.uid, req.params.perfil_id]);
  res.json({ mensagem: 'Perfil removido.' });
});

// ── VERIFICAR PERMISSÃO ───────────────────────────────────────────────────

// GET /perfis/minhas-permissoes — permissões do utilizador logado
router.get('/minhas-permissoes', async (req, res) => {
  const { rows } = await query(`
    SELECT pp.modulo, 
      bool_or(pp.pode_ver) AS pode_ver,
      bool_or(pp.pode_editar) AS pode_editar,
      bool_or(pp.pode_aprovar) AS pode_aprovar,
      bool_or(pp.pode_apagar) AS pode_apagar
    FROM utilizador_perfil up
    JOIN perfil_permissao pp ON pp.perfil_id = up.perfil_id
    WHERE up.utilizador_id = $1
    GROUP BY pp.modulo
  `, [req.utilizador.id]);

  // Convert to object: { funcionarios: { ver: true, editar: false, ... }, ... }
  const permissoes = {};
  for (const row of rows) {
    permissoes[row.modulo] = {
      ver: row.pode_ver,
      editar: row.pode_editar,
      aprovar: row.pode_aprovar,
      apagar: row.pode_apagar,
    };
  }
  res.json(permissoes);
});

module.exports = router;
