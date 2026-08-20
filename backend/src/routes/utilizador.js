'use strict';
const router  = require('express').Router();
const bcryptjs = require('bcryptjs');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

// Upload de fotos de perfil
const fotosDir = path.join(__dirname, '../../uploads/fotos');
if (!fs.existsSync(fotosDir)) fs.mkdirSync(fotosDir, { recursive: true });

const uploadFoto = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, fotosDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `foto_${req.utilizador?.id || 'tmp'}_${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const tipos = ['.png', '.jpg', '.jpeg', '.webp'];
    cb(null, tipos.includes(path.extname(file.originalname).toLowerCase()));
  },
});
const { autenticar, autorizar } = require('../middleware/auth');
const { middlewareAuditoria }   = require('../middleware/auditoria');
const { query }    = require('../config/database');
const { criarErro} = require('../middleware/errorHandler');

const ADMIN = ['admin_empresa','admin_plataforma'];
router.use(autenticar, middlewareAuditoria);

// Listar utilizadores
router.get('/', autorizar(...ADMIN, 'rh'), async (req, res) => {
  const { rows } = await query(`
    SELECT u.id, u.email, u.perfil, u.nome_completo, u.ativo, u.ultimo_login,
           f.cargo, d.nome AS departamento
    FROM utilizador u
    LEFT JOIN funcionario f ON f.utilizador_id = u.id
    LEFT JOIN departamento d ON d.id = f.departamento_id
    WHERE u.empresa_id = $1
    ORDER BY u.nome_completo
  `, [req.empresaId]);
  res.json(rows);
});

// Criar utilizador
router.post('/', autorizar(...ADMIN), async (req, res) => {
  const { email, password, perfil, nome_completo } = req.body;
  if (!email || !password || !nome_completo) throw criarErro('Email, password e nome são obrigatórios.', 400);
  if (password.length < 8) throw criarErro('Password mínimo 8 caracteres.', 400);
  const hash = await bcryptjs.hash(password, 12);
  const { rows } = await query(`
    INSERT INTO utilizador (empresa_id, email, password_hash, perfil, nome_completo)
    VALUES ($1,$2,$3,$4,$5) RETURNING id, email, perfil, nome_completo
  `, [req.empresaId, email.toLowerCase(), hash, perfil||'funcionario', nome_completo]);
  await req.auditar({ acao: 'UTILIZADOR_CRIADO', tabela: 'utilizador', registoId: rows[0].id });
  res.status(201).json(rows[0]);
});

// Actualizar utilizador
router.patch('/:id', autorizar(...ADMIN), async (req, res) => {
  const { perfil, ativo, nome_completo } = req.body;
  const { rows } = await query(`
    UPDATE utilizador SET
      perfil       = COALESCE($1, perfil),
      ativo        = COALESCE($2, ativo),
      nome_completo= COALESCE($3, nome_completo),
      atualizado_em= NOW()
    WHERE id=$4 AND empresa_id=$5
    RETURNING id, email, perfil, ativo
  `, [perfil||null, ativo??null, nome_completo||null, req.params.id, req.empresaId]);
  if (!rows.length) throw criarErro('Utilizador não encontrado.', 404);
  await req.auditar({ acao: 'UTILIZADOR_ATUALIZADO', tabela: 'utilizador', registoId: req.params.id });
  res.json(rows[0]);
});

// Actualizar avatar
router.patch('/perfil/avatar', async (req, res) => {
  const { avatar_url } = req.body;
  await query('UPDATE utilizador SET avatar_url=$1 WHERE id=$2', [avatar_url, req.utilizador.id]);
  res.json({ ok: true });
});

// Reset de password pelo administrador
router.post('/:id/reset-password', autorizar(...ADMIN), async (req, res) => {
  const { nova_password } = req.body;
  if (!nova_password || nova_password.length < 8) {
    return res.status(400).json({ error: 'Password deve ter pelo menos 8 caracteres.' });
  }
  const hash = await bcryptjs.hash(nova_password, 12);
  const { rows } = await query(`
    UPDATE utilizador
    SET password_hash=$1, mudar_password=true, atualizado_em=NOW()
    WHERE id=$2 AND empresa_id=$3
    RETURNING id, nome_completo, email
  `, [hash, req.params.id, req.empresaId]);
  if (!rows.length) return res.status(404).json({ error: 'Utilizador não encontrado.' });
  await req.auditar({ acao: 'PASSWORD_RESET', tabela: 'utilizador', registoId: req.params.id });
  res.json({ mensagem: `Password de ${rows[0].nome_completo} redefinida com sucesso.` });
});

// PUT /utilizadores/:id — editar utilizador
router.put('/:id', autorizar('admin_empresa','admin_plataforma'), async (req, res) => {
  const { nome_completo, email, perfil } = req.body;
  if (!nome_completo || !email) throw criarErro('Nome e email são obrigatórios.', 400);
  const { rows } = await query(`
    UPDATE utilizador SET nome_completo=$1, email=$2, perfil=$3, atualizado_em=NOW()
    WHERE id=$4 AND empresa_id=$5 RETURNING id, nome_completo, email, perfil, ativo
  `, [nome_completo, email.toLowerCase().trim(), perfil, req.params.id, req.empresaId]);
  if (!rows.length) throw criarErro('Utilizador não encontrado.', 404);
  res.json(rows[0]);
});

// PATCH /utilizadores/:id/estado — activar/desactivar
router.patch('/:id/estado', autorizar('admin_empresa','admin_plataforma'), async (req, res) => {
  const { ativo } = req.body;
  if (req.params.id === req.utilizador.id) throw criarErro('Não pode desactivar a sua própria conta.', 400);
  const { rows } = await query(`
    UPDATE utilizador SET ativo=$1, atualizado_em=NOW()
    WHERE id=$2 AND empresa_id=$3 RETURNING id, nome_completo, ativo
  `, [ativo, req.params.id, req.empresaId]);
  if (!rows.length) throw criarErro('Utilizador não encontrado.', 404);
  res.json(rows[0]);
});

// DELETE /utilizadores/:id — apagar utilizador
router.delete('/:id', autorizar('admin_empresa','admin_plataforma'), async (req, res) => {
  if (req.params.id === req.utilizador.id) throw criarErro('Não pode eliminar a sua própria conta.', 400);
  const { rows } = await query('SELECT id FROM utilizador WHERE id=$1 AND empresa_id=$2', [req.params.id, req.empresaId]);
  if (!rows.length) throw criarErro('Utilizador não encontrado.', 404);
  await query('DELETE FROM utilizador WHERE id=$1', [req.params.id]);
  res.json({ mensagem: 'Utilizador eliminado.' });
});

// Upload foto de perfil do utilizador
router.post('/me/foto', uploadFoto.single('foto'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Ficheiro em falta.' });
  const fotoUrl = `/uploads/fotos/${req.file.filename}`;
  await query('UPDATE utilizador SET foto_url=$1 WHERE id=$2', [fotoUrl, req.utilizador.id]);
  res.json({ foto_url: fotoUrl, mensagem: 'Foto actualizada.' });
});

// Upload foto de funcionário
router.post('/:id/foto', autorizar(...ADMIN), uploadFoto.single('foto'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Ficheiro em falta.' });
  const fotoUrl = `/uploads/fotos/${req.file.filename}`;
  await query('UPDATE funcionario SET foto_url=$1 WHERE id=$2 AND empresa_id=$3', [fotoUrl, req.params.id, req.empresaId]);
  res.json({ foto_url: fotoUrl, mensagem: 'Foto do funcionário actualizada.' });
});

// DELETE /utilizadores/:id/foto — remover foto do funcionário
router.delete('/:id/foto', autorizar(...ADMIN), async (req, res) => {
  await query('UPDATE funcionario SET foto_url=NULL WHERE id=$1 AND empresa_id=$2', [req.params.id, req.empresaId]);
  res.json({ mensagem: 'Foto removida.' });
});

module.exports = router;
