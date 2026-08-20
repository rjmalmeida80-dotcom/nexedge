'use strict';
const router  = require('express').Router();
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { autenticar, autorizar } = require('../middleware/auth');
const { middlewareAuditoria }   = require('../middleware/auditoria');
const { query } = require('../config/database');
const ADMIN = ['admin_empresa','admin_plataforma'];

// Upload de logo
const uploadsDir = path.join(__dirname, '../../uploads/logos');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const uploadLogo = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `logo_${req.empresaId}_${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const tipos = ['.png','.jpg','.jpeg','.svg','.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (tipos.includes(ext)) cb(null, true);
    else cb(new Error('Apenas imagens permitidas (PNG, JPG, SVG, WebP).'));
  },
});

router.use(autenticar, middlewareAuditoria);

router.get('/', async (req, res) => {
  const { rows } = await query('SELECT * FROM empresa WHERE id=$1', [req.empresaId]);
  res.json(rows[0] || {});
});
router.put('/', autorizar(...ADMIN), async (req, res) => {
  const d = req.body;
  const { rows } = await query(`
    UPDATE empresa SET nome=$1, setor=$2, morada=$3, codigo_postal=$4, localidade=$5,
      telefone=$6, email=$7, website=$8, cct_aplicavel=$9, horario_padrao=$10::jsonb,
      modulos_ativos=$11::jsonb, configuracoes=$12::jsonb,
      iban_empresa=$13, banco_empresa=$14, bic_empresa=$15,
      atualizado_em=NOW()
    WHERE id=$16 RETURNING *
  `, [d.nome, d.setor||null, d.morada||null, d.codigo_postal||null, d.localidade||null,
      d.telefone||null, d.email||null, d.website||null, d.cct_aplicavel||null,
      JSON.stringify(d.horario_padrao||{}), JSON.stringify(d.modulos_ativos||[]),
      JSON.stringify(d.configuracoes||{}),
      d.iban_empresa||null, d.banco_empresa||null, d.bic_empresa||null,
      req.empresaId]);
  await req.auditar({ acao: 'EMPRESA_ATUALIZADA', tabela: 'empresa', registoId: req.empresaId });
  const emp = rows[0];
  // Mask the API key for security - only show if exists
  if (emp) {
    emp.tem_api_key_propria = !!emp.anthropic_api_key;
    emp.anthropic_api_key = emp.anthropic_api_key ? '••••••••••••••••••••' : null;
  }
  res.json(emp);
});

// Departamentos
router.get('/departamentos', async (req, res) => {
  const { rows } = await query(
    'SELECT *, (SELECT COUNT(*) FROM funcionario WHERE departamento_id=d.id AND estado=\'ativo\') AS total_funcionarios FROM departamento d WHERE empresa_id=$1 AND ativo=true ORDER BY nome',
    [req.empresaId]);
  res.json(rows);
});
router.post('/departamentos', autorizar(...ADMIN,'rh'), async (req, res) => {
  const { rows } = await query(
    'INSERT INTO departamento (empresa_id, nome, descricao) VALUES ($1,$2,$3) RETURNING *',
    [req.empresaId, req.body.nome, req.body.descricao||null]);
  res.status(201).json(rows[0]);
});
router.put('/departamentos/:id', autorizar(...ADMIN,'rh'), async (req, res) => {
  const { rows } = await query(
    'UPDATE departamento SET nome=$1, descricao=$2 WHERE id=$3 AND empresa_id=$4 RETURNING *',
    [req.body.nome, req.body.descricao||null, req.params.id, req.empresaId]);
  res.json(rows[0]);
});

// Apagar departamento
router.delete('/departamentos/:id', autorizar(...ADMIN,'rh'), async (req, res) => {
  const { rows: funcs } = await query('SELECT COUNT(*) AS total FROM funcionario WHERE departamento_id=$1', [req.params.id]);
  if (parseInt(funcs[0].total) > 0) {
    return res.status(409).json({ error: `Não é possível eliminar. ${funcs[0].total} funcionário(s) associado(s).` });
  }
  await query('DELETE FROM departamento WHERE id=$1 AND empresa_id=$2', [req.params.id, req.empresaId]);
  res.json({ mensagem: 'Departamento eliminado.' });
});

// Locais de trabalho
router.get('/locais', async (req, res) => {
  const { rows } = await query('SELECT * FROM local_trabalho WHERE empresa_id=$1 AND ativo=true ORDER BY nome', [req.empresaId]);
  res.json(rows);
});
router.post('/locais', autorizar(...ADMIN,'rh'), async (req, res) => {
  const d = req.body;
  const { rows } = await query(
    'INSERT INTO local_trabalho (empresa_id, nome, morada, codigo_postal, localidade) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [req.empresaId, d.nome, d.morada||null, d.codigo_postal||null, d.localidade||null]);
  res.status(201).json(rows[0]);
});

// Upload de logo da empresa
router.post('/logo', autorizar(...ADMIN), uploadLogo.single('logo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Ficheiro em falta.' });
  const logoUrl = `/uploads/logos/${req.file.filename}`;
  await query('UPDATE empresa SET logo_url=$1 WHERE id=$2', [logoUrl, req.empresaId]);
  await req.auditar({ acao: 'LOGO_ATUALIZADO', tabela: 'empresa', registoId: req.empresaId });
  res.json({ logo_url: logoUrl, mensagem: 'Logo actualizado com sucesso.' });
});

// Remover logo
router.delete('/logo', autorizar(...ADMIN), async (req, res) => {
  const { rows } = await query('SELECT logo_url FROM empresa WHERE id=$1', [req.empresaId]);
  if (rows[0]?.logo_url) {
    const filePath = path.join(__dirname, '../..', rows[0].logo_url);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  await query('UPDATE empresa SET logo_url=NULL WHERE id=$1', [req.empresaId]);
  res.json({ mensagem: 'Logo removido.' });
});

// PUT /empresa/api-key — guardar chave API da empresa
// PUT /empresa/politica-aniversario
router.put('/politica-aniversario', autorizar(...ADMIN), async (req, res) => {
  const { politica_aniversario, aniversario_dia_alternativo } = req.body;
  await query(`
    UPDATE empresa SET 
      politica_aniversario = COALESCE($1, politica_aniversario),
      aniversario_dia_alternativo = COALESCE($2, aniversario_dia_alternativo)
    WHERE id = $3
  `, [politica_aniversario || null, aniversario_dia_alternativo || null, req.empresaId]);
  res.json({ mensagem: 'Política de aniversário guardada.' });
});

router.put('/api-key', autorizar(...ADMIN), async (req, res) => {
  const { anthropic_api_key, plano } = req.body;
  
  if (anthropic_api_key && !anthropic_api_key.startsWith('sk-ant-')) {
    return res.status(400).json({ error: 'Chave API inválida. Deve começar por sk-ant-' });
  }

  await query(`
    UPDATE empresa SET 
      anthropic_api_key = $1,
      plano = COALESCE($2, plano)
    WHERE id = $3
  `, [anthropic_api_key || null, plano || null, req.empresaId]);

  res.json({ mensagem: 'Configurações IA guardadas com sucesso.' });
});

module.exports = router;
