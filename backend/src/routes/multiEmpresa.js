'use strict';
const router = require('express').Router();
const { autenticar, autorizar } = require('../middleware/auth');
const { query } = require('../config/database');

// ── Listar grupos do utilizador ───────────────────────────────────────────────
router.get('/grupos', autenticar, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT g.*, 
        COUNT(DISTINCT e.id) AS total_empresas,
        COUNT(DISTINCT gu2.utilizador_id) AS total_utilizadores,
        gu.papel
      FROM grupo_empresarial g
      JOIN grupo_utilizador gu ON gu.grupo_id = g.id AND gu.utilizador_id = $1
      LEFT JOIN empresa e ON e.grupo_id = g.id AND e.ativo = true
      LEFT JOIN grupo_utilizador gu2 ON gu2.grupo_id = g.id
      WHERE g.activo = true
      GROUP BY g.id, gu.papel
      ORDER BY g.nome
    `, [req.utilizador.id]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Criar grupo ───────────────────────────────────────────────────────────────
router.post('/grupos', autenticar, async (req, res) => {
  try {
    const { nome, nif, email, telefone, morada } = req.body;
    if (!nome) return res.status(400).json({ error: 'Nome obrigatório' });

    const { rows:[g] } = await query(`
      INSERT INTO grupo_empresarial (nome, nif, email, telefone, morada)
      VALUES ($1,$2,$3,$4,$5) RETURNING *
    `, [nome, nif||null, email||null, telefone||null, morada||null]);

    // Adicionar o criador como admin do grupo
    await query(`
      INSERT INTO grupo_utilizador (grupo_id, utilizador_id, papel)
      VALUES ($1,$2,'admin')
    `, [g.id, req.utilizador.id]);

    res.status(201).json(g);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Empresas do grupo ─────────────────────────────────────────────────────────
router.get('/grupos/:id/empresas', autenticar, async (req, res) => {
  try {
    // Verificar acesso ao grupo
    const { rows:[acesso] } = await query(`
      SELECT gu.papel FROM grupo_utilizador gu
      WHERE gu.grupo_id=$1 AND gu.utilizador_id=$2
    `, [req.params.id, req.utilizador.id]);
    if (!acesso) return res.status(403).json({ error: 'Sem acesso a este grupo' });

    const { rows } = await query(`
      SELECT e.id, e.nome, e.nif, e.email, e.telefone, e.morada, e.plano, e.ativo,
        (SELECT COUNT(*) FROM funcionario f WHERE f.empresa_id=e.id AND f.estado='ativo') AS colaboradores,
        (SELECT COALESCE(SUM(total),0) FROM fatura fa WHERE fa.empresa_id=e.id 
          AND EXTRACT(YEAR FROM fa.data_emissao)=EXTRACT(YEAR FROM NOW())) AS faturacao_ano
      FROM empresa e
      WHERE e.grupo_id=$1
      ORDER BY e.nome
    `, [req.params.id]);

    res.json({ empresas: rows, papel: acesso.papel });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Adicionar empresa ao grupo ────────────────────────────────────────────────
router.post('/grupos/:id/empresas', autenticar, async (req, res) => {
  try {
    const { empresa_id } = req.body;
    if (!empresa_id) return res.status(400).json({ error: 'empresa_id obrigatório' });

    // Verificar que é admin do grupo
    const { rows:[acesso] } = await query(`
      SELECT papel FROM grupo_utilizador WHERE grupo_id=$1 AND utilizador_id=$2
    `, [req.params.id, req.utilizador.id]);
    if (!acesso || acesso.papel !== 'admin') return res.status(403).json({ error: 'Apenas admins do grupo podem adicionar empresas' });

    await query('UPDATE empresa SET grupo_id=$1 WHERE id=$2', [req.params.id, empresa_id]);
    res.json({ message: 'Empresa adicionada ao grupo' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Remover empresa do grupo ──────────────────────────────────────────────────
router.delete('/grupos/:id/empresas/:empresaId', autenticar, async (req, res) => {
  try {
    const { rows:[acesso] } = await query(`
      SELECT papel FROM grupo_utilizador WHERE grupo_id=$1 AND utilizador_id=$2
    `, [req.params.id, req.utilizador.id]);
    if (!acesso || acesso.papel !== 'admin') return res.status(403).json({ error: 'Apenas admins' });

    await query('UPDATE empresa SET grupo_id=NULL WHERE id=$1 AND grupo_id=$2',
      [req.params.empresaId, req.params.id]);
    res.json({ message: 'Empresa removida do grupo' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Dashboard consolidado do grupo ───────────────────────────────────────────
router.get('/grupos/:id/dashboard', autenticar, async (req, res) => {
  try {
    const { rows:[acesso] } = await query(`
      SELECT papel FROM grupo_utilizador WHERE grupo_id=$1 AND utilizador_id=$2
    `, [req.params.id, req.utilizador.id]);
    if (!acesso) return res.status(403).json({ error: 'Sem acesso' });

    const { rows:[kpis] } = await query(`
      SELECT
        COUNT(DISTINCT e.id) AS total_empresas,
        COALESCE(SUM(f_count.total),0) AS total_colaboradores,
        COALESCE(SUM(fat_count.total),0) AS faturacao_total,
        COALESCE(SUM(fat_count.recebido),0) AS recebido_total
      FROM empresa e
      LEFT JOIN (
        SELECT empresa_id, COUNT(*) AS total FROM funcionario WHERE estado='ativo' GROUP BY empresa_id
      ) f_count ON f_count.empresa_id = e.id
      LEFT JOIN (
        SELECT empresa_id, SUM(total) AS total,
          SUM(CASE WHEN estado='paga' THEN total ELSE 0 END) AS recebido
        FROM fatura WHERE EXTRACT(YEAR FROM data_emissao)=EXTRACT(YEAR FROM NOW())
        GROUP BY empresa_id
      ) fat_count ON fat_count.empresa_id = e.id
      WHERE e.grupo_id=$1
    `, [req.params.id]);

    const { rows: empresas } = await query(`
      SELECT e.id, e.nome, e.plano,
        COALESCE(f_count.total,0) AS colaboradores,
        COALESCE(fat_count.total,0) AS faturacao,
        COALESCE(fat_count.recebido,0) AS recebido
      FROM empresa e
      LEFT JOIN (SELECT empresa_id, COUNT(*) AS total FROM funcionario WHERE estado='ativo' GROUP BY empresa_id) f_count ON f_count.empresa_id=e.id
      LEFT JOIN (SELECT empresa_id, SUM(total) AS total, SUM(CASE WHEN estado='paga' THEN total ELSE 0 END) AS recebido FROM fatura WHERE EXTRACT(YEAR FROM data_emissao)=EXTRACT(YEAR FROM NOW()) GROUP BY empresa_id) fat_count ON fat_count.empresa_id=e.id
      WHERE e.grupo_id=$1 ORDER BY e.nome
    `, [req.params.id]);

    const { rows: grupo } = await query('SELECT * FROM grupo_empresarial WHERE id=$1', [req.params.id]);

    res.json({ grupo: grupo[0], kpis: kpis, empresas });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Mudar de empresa (impersonation dentro do grupo) ─────────────────────────
router.post('/grupos/:id/mudar-empresa/:empresaId', autenticar, async (req, res) => {
  try {
    const { rows:[acesso] } = await query(`
      SELECT gu.papel FROM grupo_utilizador gu
      JOIN empresa e ON e.id=$2 AND e.grupo_id=$1
      WHERE gu.grupo_id=$1 AND gu.utilizador_id=$3
    `, [req.params.id, req.params.empresaId, req.utilizador.id]);
    if (!acesso) return res.status(403).json({ error: 'Sem acesso a esta empresa' });

    // Retornar novo token para a empresa destino
    const jwt = require('jsonwebtoken');
    const { rows:[emp] } = await query('SELECT * FROM empresa WHERE id=$1', [req.params.empresaId]);
    const { rows:[util] } = await query('SELECT * FROM utilizador WHERE id=$1', [req.utilizador.id]);

    const token = jwt.sign(
      { sub: util.id, empresaId: req.params.empresaId, perfil: util.perfil, grupo_id: req.params.id },
      process.env.JWT_SECRET || 'nexedge_secret_2026',
      { expiresIn: '8h' }
    );

    res.json({ token, empresa: { id: emp.id, nome: emp.nome }, grupo_id: req.params.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Convidar utilizador para o grupo ─────────────────────────────────────────
router.post('/grupos/:id/convidar', autenticar, async (req, res) => {
  try {
    const { utilizador_id, papel } = req.body;

    const { rows:[acesso] } = await query(`
      SELECT papel FROM grupo_utilizador WHERE grupo_id=$1 AND utilizador_id=$2
    `, [req.params.id, req.utilizador.id]);
    if (!acesso || acesso.papel !== 'admin') return res.status(403).json({ error: 'Apenas admins' });

    await query(`
      INSERT INTO grupo_utilizador (grupo_id, utilizador_id, papel)
      VALUES ($1,$2,$3) ON CONFLICT (grupo_id, utilizador_id) DO UPDATE SET papel=EXCLUDED.papel
    `, [req.params.id, utilizador_id, papel||'membro']);

    res.json({ message: 'Utilizador adicionado ao grupo' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
