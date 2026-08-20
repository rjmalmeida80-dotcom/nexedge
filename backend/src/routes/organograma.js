'use strict';
const router = require('express').Router();
const { autenticar, autorizar } = require('../middleware/auth');
const { middlewareAuditoria }   = require('../middleware/auditoria');
const { query } = require('../config/database');
const { criarErro } = require('../middleware/errorHandler');

const ADMIN = ['admin_empresa','admin_plataforma','rh','diretor'];

router.use(autenticar, middlewareAuditoria);

// GET /api/organograma/niveis — listar níveis hierárquicos
router.get('/niveis', async (req, res) => {
  const { rows } = await query(`
    SELECT n.id, n.nome, n.nivel, n.descricao, n.cor, n.ativo, n.criado_em, n.empresa_id,
           COUNT(f.id) AS total_funcionarios
    FROM nivel_hierarquico n
    LEFT JOIN funcionario f ON f.nivel_hierarquico_id = n.id AND f.estado = 'ativo'
    WHERE (n.empresa_id = $1 OR n.empresa_id IS NULL) AND n.ativo = true
    GROUP BY n.id, n.nome, n.nivel, n.descricao, n.cor, n.ativo, n.criado_em, n.empresa_id
    ORDER BY n.nivel ASC
  `, [req.empresaId]);
  res.json(rows);
});

// POST /api/organograma/niveis — criar nível
router.post('/niveis', autorizar(...ADMIN), async (req, res) => {
  const { nome, nivel, descricao, cor } = req.body;
  if (!nome) throw criarErro('Nome é obrigatório.', 400);
  const nivelNum = parseFloat(nivel) || 99;
  
  // Usar valor temporário único para evitar conflito com index
  const tempNivel = nivelNum + (Date.now() / 1000000);
  
  const { rows } = await query(`
    INSERT INTO nivel_hierarquico (empresa_id, nome, nivel, descricao, cor)
    VALUES ($1,$2,$3,$4,$5) RETURNING *
  `, [req.empresaId, nome, tempNivel, descricao||null, cor||'#185FA5']);
  
  // Re-normalizar posições para inteiros consecutivos (1,2,3,4...)
  await query(`
    WITH ranked AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY nivel ASC, criado_em ASC) AS nova_pos
      FROM nivel_hierarquico
      WHERE empresa_id=$1 AND ativo=true
    )
    UPDATE nivel_hierarquico n
    SET nivel = r.nova_pos
    FROM ranked r
    WHERE n.id = r.id AND n.empresa_id=$1
  `, [req.empresaId]);
  
  res.status(201).json(rows[0]);
});

// PUT /api/organograma/niveis/:id — actualizar nível
router.put('/niveis/:id', autorizar(...ADMIN), async (req, res) => {
  const { nome, nivel, descricao, cor } = req.body;
  const { rows } = await query(`
    UPDATE nivel_hierarquico SET nome=$1, nivel=$2, descricao=$3, cor=$4
    WHERE id=$5 AND empresa_id=$6 RETURNING *
  `, [nome, nivel, descricao||null, cor||'#185FA5', req.params.id, req.empresaId]);
  if (!rows.length) throw criarErro('Nível não encontrado.', 404);
  res.json(rows[0]);
});

// DELETE /api/organograma/niveis/:id — desactivar nível
router.delete('/niveis/:id', autorizar(...ADMIN), async (req, res) => {
  await query(`UPDATE nivel_hierarquico SET ativo=false WHERE id=$1 AND empresa_id=$2`,
    [req.params.id, req.empresaId]);
  res.json({ mensagem: 'Nível desactivado.' });
});

// GET /api/organograma/arvore — árvore hierárquica completa
router.get('/arvore', async (req, res) => {
  const { rows: niveis } = await query(`
    SELECT n.id, n.nome, n.nivel, n.descricao, n.cor, n.ativo, n.criado_em, n.empresa_id,
           COUNT(f.id) AS total_funcionarios
    FROM nivel_hierarquico n
    LEFT JOIN funcionario f ON f.nivel_hierarquico_id = n.id AND f.estado = 'ativo'
    WHERE (n.empresa_id = $1 OR n.empresa_id IS NULL) AND n.ativo = true
    GROUP BY n.id, n.nome, n.nivel, n.descricao, n.cor, n.ativo, n.criado_em, n.empresa_id
    ORDER BY n.nivel ASC
  `, [req.empresaId]);

  const { rows: funcionarios } = await query(`
    SELECT f.id, f.nome_completo, f.cargo, f.foto_url, f.estado,
           f.nivel_hierarquico_id, f.responsavel_direto_id,
           f.salario_base, f.email_empresa,
           n.nome AS nivel_nome, n.cor AS nivel_cor, n.nivel AS nivel_num,
           r.nome_completo AS responsavel_nome
    FROM funcionario f
    LEFT JOIN nivel_hierarquico n ON n.id = f.nivel_hierarquico_id
    LEFT JOIN funcionario r ON r.id = f.responsavel_direto_id
    WHERE f.empresa_id = $1 AND f.estado = 'ativo'
    ORDER BY n.nivel ASC NULLS LAST, f.nome_completo ASC
  `, [req.empresaId]);

  // Construir árvore
  const arvore = niveis.map(n => ({
    ...n,
    funcionarios: funcionarios.filter(f => f.nivel_hierarquico_id === n.id),
  }));

  res.json({ niveis: arvore, total_funcionarios: funcionarios.length });
});

// GET /api/organograma/subordinados/:id — subordinados directos de um funcionário
router.get('/subordinados/:id', async (req, res) => {
  const { rows } = await query(`
    SELECT f.*, n.nome AS nivel_nome, n.cor AS nivel_cor
    FROM funcionario f
    LEFT JOIN nivel_hierarquico n ON n.id = f.nivel_hierarquico_id
    WHERE f.responsavel_direto_id = $1 AND f.empresa_id = $2 AND f.estado = 'ativo'
    ORDER BY f.nome_completo
  `, [req.params.id, req.empresaId]);
  res.json(rows);
});

// ── CENTROS DE CUSTO ──────────────────────────────────────────────────────

router.get('/centros-custo', async (req, res) => {
  const { rows } = await query(`
    SELECT cc.*, COUNT(f.id) AS total_funcionarios,
           r.nome_completo AS responsavel_nome,
           a.nome AS area_nome
    FROM centro_custo cc
    LEFT JOIN funcionario f ON f.centro_custo_id = cc.id AND f.estado = 'ativo'
    LEFT JOIN funcionario r ON r.id = cc.responsavel_id
    LEFT JOIN area_negocio a ON a.id = cc.area_negocio_id
    WHERE cc.empresa_id = $1 AND cc.ativo = true
    GROUP BY cc.id, r.nome_completo, a.nome
    ORDER BY cc.codigo
  `, [req.empresaId]);
  res.json(rows);
});

router.post('/centros-custo', autorizar(...ADMIN), async (req, res) => {
  const { codigo, nome, descricao, area_negocio_id, responsavel_id, orcamento_anual } = req.body;
  if (!codigo || !nome) throw criarErro('Código e nome são obrigatórios.', 400);
  const { rows } = await query(`
    INSERT INTO centro_custo (empresa_id, codigo, nome, descricao, area_negocio_id, responsavel_id, orcamento_anual)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
  `, [req.empresaId, codigo, nome, descricao||null, area_negocio_id||null, responsavel_id||null, orcamento_anual||0]);
  res.status(201).json(rows[0]);
});

router.put('/centros-custo/:id', autorizar(...ADMIN), async (req, res) => {
  const { codigo, nome, descricao, area_negocio_id, responsavel_id, orcamento_anual } = req.body;
  const { rows } = await query(`
    UPDATE centro_custo SET codigo=$1, nome=$2, descricao=$3, area_negocio_id=$4,
      responsavel_id=$5, orcamento_anual=$6
    WHERE id=$7 AND empresa_id=$8 RETURNING *
  `, [codigo, nome, descricao||null, area_negocio_id||null, responsavel_id||null, orcamento_anual||0, req.params.id, req.empresaId]);
  if (!rows.length) throw criarErro('Centro de custo não encontrado.', 404);
  res.json(rows[0]);
});

router.delete('/centros-custo/:id', autorizar(...ADMIN), async (req, res) => {
  await query('UPDATE centro_custo SET ativo=false WHERE id=$1 AND empresa_id=$2', [req.params.id, req.empresaId]);
  res.json({ mensagem: 'Centro de custo desactivado.' });
});

// ── PROJECTOS ─────────────────────────────────────────────────────────────

router.get('/projetos', async (req, res) => {
  const { rows } = await query(`
    SELECT p.*, COUNT(pm.funcionario_id) AS total_membros,
           r.nome_completo AS responsavel_nome,
           a.nome AS area_nome
    FROM projeto p
    LEFT JOIN projeto_membro pm ON pm.projeto_id = p.id
    LEFT JOIN funcionario r ON r.id = p.responsavel_id
    LEFT JOIN area_negocio a ON a.id = p.area_negocio_id
    WHERE p.empresa_id = $1
    GROUP BY p.id, r.nome_completo, a.nome
    ORDER BY p.estado, p.nome
  `, [req.empresaId]);
  res.json(rows);
});

router.post('/projetos', autorizar(...ADMIN), async (req, res) => {
  const { nome, descricao, data_inicio, data_fim, responsavel_id, area_negocio_id, orcamento } = req.body;
  if (!nome) throw criarErro('Nome é obrigatório.', 400);
  const { rows } = await query(`
    INSERT INTO projeto (empresa_id, nome, descricao, data_inicio, data_fim, responsavel_id, area_negocio_id, orcamento)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
  `, [req.empresaId, nome, descricao||null, data_inicio||null, data_fim||null, responsavel_id||null, area_negocio_id||null, orcamento||0]);
  res.status(201).json(rows[0]);
});

router.post('/projetos/:id/membros', autorizar(...ADMIN), async (req, res) => {
  const { funcionario_id, papel } = req.body;
  await query(`
    INSERT INTO projeto_membro (projeto_id, funcionario_id, papel)
    VALUES ($1,$2,$3) ON CONFLICT DO NOTHING
  `, [req.params.id, funcionario_id, papel||null]);
  res.json({ mensagem: 'Membro adicionado.' });
});

router.get('/projetos/:id/membros', async (req, res) => {
  const { rows } = await query(`
    SELECT f.id, f.nome_completo, f.cargo, pm.papel, pm.data_entrada,
           n.nome AS nivel_nome, n.cor AS nivel_cor
    FROM projeto_membro pm
    JOIN funcionario f ON f.id = pm.funcionario_id
    LEFT JOIN nivel_hierarquico n ON n.id = f.nivel_hierarquico_id
    WHERE pm.projeto_id = $1
    ORDER BY f.nome_completo
  `, [req.params.id]);
  res.json(rows);
});

// ── ÁREAS DE NEGÓCIO ─────────────────────────────────────────────────────

// GET /api/organograma/areas
router.get('/areas', async (req, res) => {
  const { rows } = await query(`
    SELECT a.*,
           COUNT(DISTINCT f.id) AS total_funcionarios,
           COUNT(DISTINCT d.id) AS total_departamentos,
           r.nome_completo AS responsavel_nome
    FROM area_negocio a
    LEFT JOIN departamento d ON d.area_negocio_id = a.id AND d.ativo = true
    LEFT JOIN funcionario f ON (f.departamento_id = d.id OR f.area_negocio_id = a.id) AND f.estado = 'ativo'
    LEFT JOIN funcionario r ON r.id = a.responsavel_id
    WHERE a.empresa_id = $1 AND a.ativo = true
    GROUP BY a.id, a.nome, a.descricao, a.cor, a.ativo, a.criado_em, a.empresa_id, a.responsavel_id, r.nome_completo
    ORDER BY a.nome ASC
  `, [req.empresaId]);
  res.json(rows);
});

// POST /api/organograma/areas
router.post('/areas', autorizar(...ADMIN), async (req, res) => {
  const { nome, descricao, cor, responsavel_id } = req.body;
  if (!nome) throw criarErro('Nome é obrigatório.', 400);
  const { rows } = await query(`
    INSERT INTO area_negocio (empresa_id, nome, descricao, cor, responsavel_id)
    VALUES ($1,$2,$3,$4,$5) RETURNING *
  `, [req.empresaId, nome, descricao||null, cor||'#185FA5', responsavel_id||null]);
  res.status(201).json(rows[0]);
});

// PUT /api/organograma/areas/:id
router.put('/areas/:id', autorizar(...ADMIN), async (req, res) => {
  const { nome, descricao, cor, responsavel_id } = req.body;
  const { rows } = await query(`
    UPDATE area_negocio SET nome=$1, descricao=$2, cor=$3, responsavel_id=$4
    WHERE id=$5 AND empresa_id=$6 RETURNING *
  `, [nome, descricao||null, cor||'#185FA5', responsavel_id||null, req.params.id, req.empresaId]);
  if (!rows.length) throw criarErro('Área não encontrada.', 404);
  res.json(rows[0]);
});

// DELETE /api/organograma/areas/:id
router.delete('/areas/:id', autorizar(...ADMIN), async (req, res) => {
  await query('UPDATE area_negocio SET ativo=false WHERE id=$1 AND empresa_id=$2',
    [req.params.id, req.empresaId]);
  res.json({ mensagem: 'Área desactivada.' });
});

// GET /api/organograma/estrutura — visão completa: Áreas > Departamentos > Funcionários
router.get('/estrutura', async (req, res) => {
  const { rows: areas } = await query(`
    SELECT a.*, r.nome_completo AS responsavel_nome
    FROM area_negocio a
    LEFT JOIN funcionario r ON r.id = a.responsavel_id
    WHERE a.empresa_id = $1 AND a.ativo = true
    ORDER BY a.nome
  `, [req.empresaId]);

  const { rows: deptos } = await query(`
    SELECT d.*, a.nome AS area_nome, a.cor AS area_cor,
           COUNT(f.id) AS total_funcionarios
    FROM departamento d
    LEFT JOIN area_negocio a ON a.id = d.area_negocio_id
    LEFT JOIN funcionario f ON f.departamento_id = d.id AND f.estado = 'ativo'
    WHERE d.empresa_id = $1 AND d.ativo = true
    GROUP BY d.id, a.nome, a.cor
    ORDER BY a.nome, d.nome
  `, [req.empresaId]);

  const { rows: funcs } = await query(`
    SELECT f.id, f.nome_completo, f.cargo, f.estado, f.salario_base,
           f.departamento_id, f.area_negocio_id,
           f.nivel_hierarquico_id, f.responsavel_direto_id,
           n.nome AS nivel_nome, n.cor AS nivel_cor, n.nivel AS nivel_num,
           resp.nome_completo AS responsavel_nome
    FROM funcionario f
    LEFT JOIN nivel_hierarquico n ON n.id = f.nivel_hierarquico_id
    LEFT JOIN funcionario resp ON resp.id = f.responsavel_direto_id
    WHERE f.empresa_id = $1 AND f.estado = 'ativo'
    ORDER BY n.nivel ASC NULLS LAST, f.nome_completo
  `, [req.empresaId]);

  // Construir estrutura
  const estrutura = areas.map(a => ({
    ...a,
    departamentos: deptos
      .filter(d => d.area_negocio_id === a.id)
      .map(d => ({
        ...d,
        funcionarios: funcs.filter(f => f.departamento_id === d.id),
      })),
    funcionarios_diretos: funcs.filter(f => f.area_negocio_id === a.id && !f.departamento_id),
  }));

  // Sem área definida
  const sem_area = {
    id: null,
    nome: 'Sem Área Definida',
    cor: '#9CA3AF',
    departamentos: deptos
      .filter(d => !d.area_negocio_id)
      .map(d => ({
        ...d,
        funcionarios: funcs.filter(f => f.departamento_id === d.id),
      })),
    funcionarios_diretos: funcs.filter(f => !f.area_negocio_id && !f.departamento_id),
  };

  res.json({ estrutura, sem_area, totais: {
    areas: areas.length,
    departamentos: deptos.length,
    funcionarios: funcs.length,
  }});
});

// DELETE projetos/:id
router.delete('/projetos/:id', autorizar(...ADMIN), async (req, res) => {
  await query('DELETE FROM projeto WHERE id=$1 AND empresa_id=$2', [req.params.id, req.empresaId]);
  res.json({ mensagem: 'Projecto eliminado.' });
});

// PATCH projetos/:id — actualizar estado
router.patch('/projetos/:id', autorizar(...ADMIN), async (req, res) => {
  const { estado, nome, descricao, data_inicio, data_fim } = req.body;
  const { rows } = await query(`
    UPDATE projeto SET estado=COALESCE($1,estado), nome=COALESCE($2,nome),
      descricao=COALESCE($3,descricao), data_inicio=COALESCE($4,data_inicio), data_fim=COALESCE($5,data_fim)
    WHERE id=$6 AND empresa_id=$7 RETURNING *
  `, [estado||null, nome||null, descricao||null, data_inicio||null, data_fim||null, req.params.id, req.empresaId]);
  res.json(rows[0]);
});

// DELETE niveis/:id — já existe como desactivar, adicionar apagar permanente
router.delete('/niveis/:id/apagar', autorizar(...ADMIN), async (req, res) => {
  const { rows: funcs } = await query('SELECT COUNT(*) AS total FROM funcionario WHERE nivel_hierarquico_id=$1', [req.params.id]);
  if (parseInt(funcs[0].total) > 0) {
    return res.status(409).json({ error: `Não é possível apagar. ${funcs[0].total} colaborador(es) neste nível.` });
  }
  await query('DELETE FROM nivel_hierarquico WHERE id=$1 AND empresa_id=$2', [req.params.id, req.empresaId]);
  res.json({ mensagem: 'Nível eliminado.' });
});

// DELETE areas/:id/apagar
router.delete('/areas/:id/apagar', autorizar(...ADMIN), async (req, res) => {
  const { rows: funcs } = await query('SELECT COUNT(*) AS total FROM funcionario WHERE area_negocio_id=$1', [req.params.id]);
  if (parseInt(funcs[0].total) > 0) {
    return res.status(409).json({ error: `Não é possível apagar. ${funcs[0].total} colaborador(es) nesta área.` });
  }
  await query('DELETE FROM area_negocio WHERE id=$1 AND empresa_id=$2', [req.params.id, req.empresaId]);
  res.json({ mensagem: 'Área eliminada.' });
});


// GET /organograma/hierarquia — árvore simples baseada em "reporta a"
router.get('/hierarquia', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT 
        f.id, f.nome_completo, f.cargo, f.foto_url,
        f.responsavel_id,
        d.nome AS departamento,
        '#185FA5' AS departamento_cor,
        r.nome_completo AS responsavel_nome
      FROM funcionario f
      LEFT JOIN departamento d ON d.id = f.departamento_id
      LEFT JOIN funcionario r ON r.id = f.responsavel_id
      WHERE f.empresa_id = $1 AND f.estado = 'ativo'
      ORDER BY f.nome_completo
    `, [req.empresaId]);

    // Build tree structure
    const map = {};
    const roots = [];

    rows.forEach(f => { map[f.id] = { ...f, subordinados: [] }; });
    rows.forEach(f => {
      if (f.responsavel_id && map[f.responsavel_id]) {
        map[f.responsavel_id].subordinados.push(map[f.id]);
      } else {
        roots.push(map[f.id]);
      }
    });

    res.json({ hierarquia: roots, total: rows.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
