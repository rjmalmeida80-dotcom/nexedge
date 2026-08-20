'use strict';
const router = require('express').Router();
const { autenticar } = require('../middleware/auth');
const { middlewareAuditoria } = require('../middleware/auditoria');
const { query } = require('../config/database');
const { criarErro } = require('../middleware/errorHandler');
const multer = require('multer');
const path = require('path');
const { v4: uuid } = require('uuid');
const fs = require('fs');

const uploadsDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuid()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const permitidos = ['.pdf','.doc','.docx','.xls','.xlsx','.jpg','.jpeg','.png','.txt'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (permitidos.includes(ext)) cb(null, true);
    else cb(new Error('Tipo de ficheiro não permitido.'));
  }
});

router.use(autenticar, middlewareAuditoria);

router.get('/', async (req, res) => {
  const { funcionario_id, categoria } = req.query;
  const params = [req.empresaId]; const conds = ['d.empresa_id=$1']; let p=2;
  if (funcionario_id) { conds.push(`d.funcionario_id=$${p}`); params.push(funcionario_id); p++; }
  if (categoria) { conds.push(`d.categoria=$${p}`); params.push(categoria); p++; }
  const { rows } = await query(`
    SELECT d.*, f.nome_completo AS funcionario_nome, u.nome_completo AS criado_por_nome
    FROM documento d
    LEFT JOIN funcionario f ON f.id=d.funcionario_id
    LEFT JOIN utilizador u ON u.id=d.criado_por
    WHERE ${conds.join(' AND ')} ORDER BY d.criado_em DESC
  `, params);
  res.json(rows);
});

router.post('/', upload.single('ficheiro'), async (req, res) => {
  if (!req.file) throw criarErro('Ficheiro em falta.', 400);
  const { nome, tipo, categoria, funcionario_id, confidencial, notas } = req.body;
  const url = `/uploads/${req.file.filename}`;
  const { rows } = await query(`
    INSERT INTO documento (empresa_id, funcionario_id, nome, tipo, categoria, url,
      tamanho_bytes, mime_type, confidencial, notas, criado_por)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *
  `, [req.empresaId, funcionario_id||null, nome||req.file.originalname,
      tipo||null, categoria||null, url, req.file.size, req.file.mimetype,
      confidencial==='true', notas||null, req.utilizador.id]);
  await req.auditar({ acao: 'DOCUMENTO_CARREGADO', tabela: 'documento', registoId: rows[0].id });
  res.status(201).json(rows[0]);
});

router.get('/:id/download', async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM documento WHERE id=$1 AND empresa_id=$2',
    [req.params.id, req.empresaId]
  );
  if (!rows.length) throw criarErro('Documento não encontrado.', 404);
  const doc = rows[0];
  const filePath = path.join(__dirname, '../..', doc.url);
  if (!fs.existsSync(filePath)) throw criarErro('Ficheiro não encontrado no servidor.', 404);
  res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(doc.nome)}"`);
  res.sendFile(filePath);
});

router.delete('/:id', async (req, res) => {
  const { rows } = await query('SELECT url FROM documento WHERE id=$1 AND empresa_id=$2', [req.params.id, req.empresaId]);
  if (!rows.length) throw criarErro('Documento não encontrado.', 404);
  const filePath = path.join(__dirname, '../..', rows[0].url);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  await query('DELETE FROM documento WHERE id=$1', [req.params.id]);
  await req.auditar({ acao: 'DOCUMENTO_ELIMINADO', registoId: req.params.id });
  res.json({ mensagem: 'Documento eliminado.' });
});

module.exports = router;
