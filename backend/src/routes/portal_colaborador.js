'use strict';
const router = require('express').Router();
const { autenticar } = require('../middleware/auth');
const { query } = require('../config/database');

// ── Dashboard do colaborador (self-service) ───────────────────────────────────
router.get('/dashboard', autenticar, async (req, res) => {
  try {
    const uid = req.utilizador.id;
    const eid = req.empresaId;

    // Encontrar funcionario_id deste utilizador
    const { rows:[func] } = await query(`
      SELECT f.*, d.nome AS departamento_nome
      FROM funcionario f
      LEFT JOIN departamento d ON d.id = f.departamento_id
      WHERE f.utilizador_id=$1 OR (f.empresa_id=$2 AND f.email_empresa=(
        SELECT email FROM utilizador WHERE id=$1
      ))
      LIMIT 1
    `, [uid, eid]);

    if (!func) return res.json({ sem_perfil: true });

    const [ferias, recibos, tarefas, notifs, faltas] = await Promise.all([
      query(`SELECT saldo_dias_disponiveis, saldo_dias_utilizados, ano
        FROM saldo_ferias WHERE funcionario_id=$1 AND ano=EXTRACT(YEAR FROM NOW())
        LIMIT 1`, [func.id]).catch(()=>({rows:[]})),
      query(`SELECT mes, ano, liquido, total_abonos, irs_retido, estado
        FROM recibo_vencimento WHERE funcionario_id=$1
        ORDER BY ano DESC, mes DESC LIMIT 3`, [func.id]),
      query(`SELECT t.titulo, t.estado, t.prioridade, t.data_limite
        FROM crm_tarefa t WHERE t.atribuido_a=$1 AND t.estado != 'concluida'
        ORDER BY t.data_limite ASC NULLS LAST LIMIT 5`, [uid]).catch(()=>({rows:[]})),
      query(`SELECT COUNT(*) AS total FROM notificacao WHERE utilizador_id=$1 AND lida=false`, [uid]),
      query(`SELECT COUNT(*) AS total FROM falta fa
        JOIN funcionario f ON f.id=fa.funcionario_id
        WHERE f.id=$1 AND EXTRACT(YEAR FROM fa.data)=EXTRACT(YEAR FROM NOW())`, [func.id]).catch(()=>({rows:[{total:0}]})),
    ]);

    const anoActual = new Date().getFullYear();
    const proximoAniversario = func.data_nascimento ? (() => {
      const d = new Date(func.data_nascimento);
      const hoje = new Date();
      let proximo = new Date(hoje.getFullYear(), d.getMonth(), d.getDate());
      if (proximo < hoje) proximo.setFullYear(hoje.getFullYear() + 1);
      const diff = Math.ceil((proximo - hoje) / (1000*60*60*24));
      return diff;
    })() : null;

    res.json({
      colaborador: {
        id: func.id,
        nome: func.nome_completo,
        cargo: func.cargo,
        departamento: func.departamento_nome,
        data_admissao: func.data_admissao,
        anos_empresa: Math.floor((new Date() - new Date(func.data_admissao)) / (1000*60*60*24*365)),
        foto_url: func.foto_url,
        aniversario_em: proximoAniversario,
      },
      ferias: {
        saldo_disponivel: ferias.rows[0]?.saldo_dias_disponiveis || 0,
        saldo_utilizado: ferias.rows[0]?.saldo_dias_utilizados || 0,
        ano: anoActual,
      },
      ultimo_recibo: recibos.rows[0] || null,
      recibos_recentes: recibos.rows,
      tarefas_pendentes: tarefas.rows,
      notificacoes_nao_lidas: parseInt(notifs.rows[0]?.total||0),
      faltas_ano: parseInt(faltas.rows[0]?.total||0),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Pedidos de férias do colaborador ─────────────────────────────────────────
router.get('/ferias', autenticar, async (req, res) => {
  try {
    const { rows:[func] } = await query(
      `SELECT f.id FROM funcionario f WHERE f.utilizador_id=$1 OR f.email_empresa=(SELECT email FROM utilizador WHERE id=$1) LIMIT 1`,
      [req.utilizador.id]
    );
    if (!func) return res.json([]);
    const { rows } = await query(
      `SELECT * FROM pedido_ferias WHERE funcionario_id=$1 ORDER BY criado_em DESC LIMIT 20`,
      [func.id]
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Recibos do colaborador ────────────────────────────────────────────────────
router.get('/recibos', autenticar, async (req, res) => {
  try {
    const { rows:[func] } = await query(
      `SELECT f.id FROM funcionario f WHERE f.utilizador_id=$1 OR f.email_empresa=(SELECT email FROM utilizador WHERE id=$1) LIMIT 1`,
      [req.utilizador.id]
    );
    if (!func) return res.json([]);
    const { rows } = await query(
      `SELECT mes, ano, salario_base, total_abonos, irs_retido, seg_social_func, liquido, estado, processado_em
       FROM recibo_vencimento WHERE funcionario_id=$1 ORDER BY ano DESC, mes DESC`,
      [func.id]
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
