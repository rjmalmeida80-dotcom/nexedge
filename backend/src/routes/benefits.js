'use strict';
const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { autenticar } = require('../middleware/auth');

router.use(autenticar);

const TIPOS = {
  subsidio_alimentacao:'🍽 Subsídio Alimentação',
  subsidio_transporte:'🚌 Subsídio Transporte',
  subsidio_comunicacao:'📱 Subsídio Comunicação',
  seguro_saude:'🏥 Seguro Saúde',
  seguro_vida:'❤️ Seguro Vida',
  seguro_acidentes:'⛑️ Seguro Acidentes',
  ppr:'💰 PPR',
  plano_poupanca:'🏦 Plano Poupança',
  acoes:'📈 Acções/Stock Options',
  gimnasio:'💪 Ginásio/Saúde',
  formacao:'📚 Formação',
  creche:'👶 Creche/Educação',
  veiculo:'🚗 Veículo',
  telemovel:'📱 Telemóvel',
  computador:'💻 Computador',
  flexivel:'🎁 Benefício Flexível',
  outro:'📋 Outro',
};

// Listar benefícios da empresa
router.get('/', async (req, res) => {
  try {
    const r = await query(`
      SELECT b.*,
        (SELECT COUNT(*) FROM funcionario_beneficio WHERE beneficio_id=b.id AND estado='ativo') as num_funcionarios,
        (SELECT SUM(COALESCE(fb.valor_custom, b.valor_mensal)) FROM funcionario_beneficio fb WHERE fb.beneficio_id=b.id AND fb.estado='ativo') as custo_mensal_total
      FROM beneficio b
      WHERE b.empresa_id=$1
      ORDER BY b.tipo, b.nome
    `, [req.empresaId]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const d = req.body;
    const r = await query(`
      INSERT INTO beneficio (empresa_id,nome,tipo,descricao,valor_mensal,valor_anual,tributavel,aplicar_a,departamentos)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
    `, [req.empresaId,d.nome,d.tipo,d.descricao||'',d.valor_mensal||0,d.valor_anual||d.valor_mensal*12||0,d.tributavel||false,d.aplicar_a||'todos',JSON.stringify(d.departamentos||[])]);
    
    // Se aplicar a todos, atribuir automaticamente
    if (d.aplicar_a === 'todos') {
      const funcs = await query(`SELECT id FROM funcionario WHERE empresa_id=$1 AND estado='ativo'`, [req.empresaId]);
      for (const f of funcs.rows) {
        await query(`INSERT INTO funcionario_beneficio (funcionario_id,empresa_id,beneficio_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
          [f.id, req.empresaId, r.rows[0].id]).catch(()=>{});
      }
    }
    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', async (req, res) => {
  try {
    const d = req.body;
    const campos = ['nome','descricao','valor_mensal','valor_anual','tributavel','ativo','aplicar_a'];
    const updates = [], params = [];
    let p = 1;
    for (const c of campos) {
      if (d[c] !== undefined) { updates.push(`${c}=$${p++}`); params.push(d[c]); }
    }
    params.push(req.params.id);
    await query(`UPDATE beneficio SET ${updates.join(',')} WHERE id=$${p} AND empresa_id='${req.empresaId}'`, params);
    const r = await query(`SELECT * FROM beneficio WHERE id=$1`, [req.params.id]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Benefícios por funcionário
router.get('/funcionario/:id', async (req, res) => {
  try {
    const r = await query(`
      SELECT fb.*, b.nome, b.tipo, b.descricao, b.tributavel,
        COALESCE(fb.valor_custom, b.valor_mensal) as valor_efectivo
      FROM funcionario_beneficio fb
      JOIN beneficio b ON b.id=fb.beneficio_id
      WHERE fb.funcionario_id=$1 AND fb.empresa_id=$2
      ORDER BY b.tipo, b.nome
    `, [req.params.id, req.empresaId]);
    
    const total = r.rows.reduce((s,b) => s + parseFloat(b.valor_efectivo||0), 0);
    res.json({ beneficios: r.rows, total_mensal: total, total_anual: total * 12 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/funcionario/:id/atribuir', async (req, res) => {
  try {
    const { beneficio_id, valor_custom, data_inicio, notas } = req.body;
    const r = await query(`
      INSERT INTO funcionario_beneficio (funcionario_id,empresa_id,beneficio_id,valor_custom,data_inicio,notas)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (funcionario_id,beneficio_id,data_inicio) DO UPDATE SET valor_custom=$4, notas=$6
      RETURNING *
    `, [req.params.id, req.empresaId, beneficio_id, valor_custom||null, data_inicio||new Date().toISOString().slice(0,10), notas||null]);
    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/funcionario/:funcId/beneficio/:benId', async (req, res) => {
  try {
    await query(`UPDATE funcionario_beneficio SET estado='terminado', data_fim=CURRENT_DATE WHERE funcionario_id=$1 AND beneficio_id=$2 AND empresa_id=$3`,
      [req.params.funcId, req.params.benId, req.empresaId]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Resumo/relatório
router.get('/relatorio', async (req, res) => {
  try {
    const [totais, porTipo, topFuncionarios] = await Promise.all([
      query(`SELECT
        COUNT(DISTINCT fb.funcionario_id) as funcionarios_com_beneficios,
        COUNT(DISTINCT b.id) as beneficios_ativos,
        SUM(COALESCE(fb.valor_custom, b.valor_mensal)) as custo_mensal_total
        FROM funcionario_beneficio fb JOIN beneficio b ON b.id=fb.beneficio_id
        WHERE fb.empresa_id=$1 AND fb.estado='ativo'`, [req.empresaId]),
      query(`SELECT b.tipo, COUNT(*) as atribuicoes, SUM(COALESCE(fb.valor_custom, b.valor_mensal)) as custo_mensal
        FROM funcionario_beneficio fb JOIN beneficio b ON b.id=fb.beneficio_id
        WHERE fb.empresa_id=$1 AND fb.estado='ativo' GROUP BY b.tipo ORDER BY custo_mensal DESC`, [req.empresaId]),
      query(`SELECT f.nome_completo, COUNT(*) as num_beneficios, SUM(COALESCE(fb.valor_custom, b.valor_mensal)) as total_mensal
        FROM funcionario_beneficio fb JOIN funcionario f ON f.id=fb.funcionario_id JOIN beneficio b ON b.id=fb.beneficio_id
        WHERE fb.empresa_id=$1 AND fb.estado='ativo' GROUP BY f.id,f.nome_completo ORDER BY total_mensal DESC LIMIT 10`, [req.empresaId]),
    ]);

    const t = totais.rows[0];
    res.json({
      resumo: {
        funcionarios_com_beneficios: parseInt(t.funcionarios_com_beneficios||0),
        beneficios_ativos: parseInt(t.beneficios_ativos||0),
        custo_mensal_total: parseFloat(t.custo_mensal_total||0),
        custo_anual_total: parseFloat(t.custo_mensal_total||0) * 12,
      },
      por_tipo: porTipo.rows.map(r => ({ ...r, label: TIPOS[r.tipo]||r.tipo })),
      top_funcionarios: topFuncionarios.rows,
      tipos: TIPOS,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
