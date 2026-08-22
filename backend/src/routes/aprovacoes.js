'use strict';
/**
 * NexEdge — Motor de Aprovações em Cadeia
 * Multi-nível configurável: despesas, férias, compras, contratos, documentos
 * Supera: SAP Workflow, ServiceNow Approvals
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { autenticar } = require('../middleware/auth');

router.use(autenticar);

// ── CONFIGURAÇÃO DE FLUXOS ──

router.get('/fluxos', async (req, res) => {
  try {
    const r = await query(`SELECT * FROM aprovacao_fluxo WHERE empresa_id=$1 ORDER BY tipo, nome`, [req.empresaId]).catch(()=>({rows:[]}));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/fluxos', async (req, res) => {
  try {
    const { nome, tipo, niveis, condicoes, ativo } = req.body;
    // niveis: [{nivel:1, aprovador_tipo:'utilizador'|'perfil'|'chefe_directo', aprovador_id, prazo_horas}]
    const r = await query(`
      INSERT INTO aprovacao_fluxo (empresa_id, nome, tipo, niveis, condicoes, ativo)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
    `, [req.empresaId, nome, tipo, JSON.stringify(niveis||[]), JSON.stringify(condicoes||[]), ativo!==false]);
    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PEDIDOS DE APROVAÇÃO ──

router.get('/pedidos', async (req, res) => {
  try {
    const { estado, meu_pendente } = req.query;
    let sql, params;

    if (meu_pendente === 'true') {
      // Ver pedidos que estão à minha espera
      sql = `SELECT ap.*, f.nome as fluxo_nome, u.nome_completo as solicitante_nome,
        an.nivel as nivel_actual
        FROM aprovacao_pedido ap
        JOIN aprovacao_fluxo f ON f.id=ap.fluxo_id
        JOIN utilizador u ON u.id=ap.solicitante_id
        JOIN aprovacao_nivel an ON an.pedido_id=ap.id AND an.estado='pendente'
        WHERE ap.empresa_id=$1 AND an.aprovador_id=$2 AND ap.estado='em_aprovacao'
        ORDER BY ap.criado_em DESC`;
      params = [req.empresaId, req.utilizador.id];
    } else {
      sql = `SELECT ap.*, f.nome as fluxo_nome, u.nome_completo as solicitante_nome
        FROM aprovacao_pedido ap
        JOIN aprovacao_fluxo f ON f.id=ap.fluxo_id
        JOIN utilizador u ON u.id=ap.solicitante_id
        WHERE ap.empresa_id=$1 ${estado?`AND ap.estado=$2`:''} ORDER BY ap.criado_em DESC`;
      params = estado ? [req.empresaId, estado] : [req.empresaId];
    }

    const r = await query(sql, params).catch(()=>({rows:[]}));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Criar pedido de aprovação
router.post('/pedidos', async (req, res) => {
  try {
    const { fluxo_id, titulo, descricao, entidade_tipo, entidade_id, dados, urgente } = req.body;
    if (!fluxo_id || !titulo) return res.status(400).json({ error: 'Fluxo e título obrigatórios' });

    // Buscar fluxo e criar niveis
    const fluxo = await query(`SELECT * FROM aprovacao_fluxo WHERE id=$1 AND empresa_id=$2`, [fluxo_id, req.empresaId]);
    if (!fluxo.rows.length) return res.status(404).json({ error: 'Fluxo não encontrado' });

    const f = fluxo.rows[0];
    const niveis = typeof f.niveis === 'string' ? JSON.parse(f.niveis) : f.niveis;

    const pedido = await query(`
      INSERT INTO aprovacao_pedido (empresa_id, fluxo_id, titulo, descricao, entidade_tipo, entidade_id, dados, urgente, solicitante_id, estado, nivel_actual)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'em_aprovacao',1) RETURNING *
    `, [req.empresaId, fluxo_id, titulo, descricao||'', entidade_tipo||null, entidade_id||null, JSON.stringify(dados||{}), urgente||false, req.utilizador.id]);

    const p = pedido.rows[0];

    // Criar registos de nível
    for (const nivel of niveis) {
      let aprovadorId = nivel.aprovador_id;

      // Se aprovador é 'chefe_directo', buscar o chefe do solicitante
      if (nivel.aprovador_tipo === 'chefe_directo') {
        const chefe = await query(`SELECT chefe_directo_id FROM funcionario WHERE utilizador_id=$1`, [req.utilizador.id]).catch(()=>({rows:[]}));
        aprovadorId = chefe.rows[0]?.chefe_directo_id || nivel.aprovador_id;
      }

      await query(`INSERT INTO aprovacao_nivel (pedido_id, nivel, aprovador_id, aprovador_tipo, prazo_horas, estado)
        VALUES ($1,$2,$3,$4,$5,$6)`,
        [p.id, nivel.nivel, aprovadorId, nivel.aprovador_tipo||'utilizador', nivel.prazo_horas||24, nivel.nivel===1?'pendente':'aguarda']);
    }

    // Notificar primeiro aprovador
    const primeiroNivel = niveis[0];
    if (primeiroNivel?.aprovador_id) {
      await query(`INSERT INTO notificacao (utilizador_id, titulo, mensagem, tipo, url_accao)
        VALUES ($1,$2,$3,'aprovacao','/aprovacoes')`,
        [primeiroNivel.aprovador_id,
         `${urgente?'🚨 ':''}📋 Aprovação pendente: ${titulo}`,
         `${req.utilizador.nome_completo} submeteu um pedido de aprovação.`]).catch(()=>{});
    }

    res.status(201).json(p);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── APROVAR / REJEITAR ──

router.post('/pedidos/:id/aprovar', async (req, res) => {
  try {
    const { comentario } = req.body;
    const pedido = await query(`SELECT * FROM aprovacao_pedido WHERE id=$1 AND empresa_id=$2`, [req.params.id, req.empresaId]);
    if (!pedido.rows.length) return res.status(404).json({ error: 'Pedido não encontrado' });
    const p = pedido.rows[0];

    // Verificar que é o aprovador do nível actual
    const nivel = await query(`SELECT * FROM aprovacao_nivel WHERE pedido_id=$1 AND nivel=$2 AND estado='pendente'`, [p.id, p.nivel_actual]);
    if (!nivel.rows.length) return res.status(400).json({ error: 'Não és o aprovador deste nível' });

    const n = nivel.rows[0];
    if (n.aprovador_id !== req.utilizador.id && !['admin_empresa','superadmin'].includes(req.utilizador.perfil)) {
      return res.status(403).json({ error: 'Sem permissão para aprovar' });
    }

    // Aprovar este nível
    await query(`UPDATE aprovacao_nivel SET estado='aprovado', aprovado_em=NOW(), comentario=$1 WHERE id=$2`,
      [comentario||'', n.id]);

    // Verificar se há próximo nível
    const proximoNivel = await query(`SELECT * FROM aprovacao_nivel WHERE pedido_id=$1 AND nivel=$2`, [p.id, p.nivel_actual+1]);

    if (proximoNivel.rows.length) {
      // Activar próximo nível
      await query(`UPDATE aprovacao_nivel SET estado='pendente' WHERE id=$1`, [proximoNivel.rows[0].id]);
      await query(`UPDATE aprovacao_pedido SET nivel_actual=$1 WHERE id=$2`, [p.nivel_actual+1, p.id]);

      // Notificar próximo aprovador
      if (proximoNivel.rows[0].aprovador_id) {
        await query(`INSERT INTO notificacao (utilizador_id, titulo, mensagem, tipo, url_accao) VALUES ($1,$2,$3,'aprovacao','/aprovacoes')`,
          [proximoNivel.rows[0].aprovador_id, `📋 Aprovação pendente: ${p.titulo}`, `Nivel ${p.nivel_actual+1} — aguarda a tua aprovação.`]).catch(()=>{});
      }
    } else {
      // Todos os níveis aprovados!
      await query(`UPDATE aprovacao_pedido SET estado='aprovado', concluido_em=NOW() WHERE id=$1`, [p.id]);

      // Notificar solicitante
      await query(`INSERT INTO notificacao (utilizador_id, titulo, mensagem, tipo, url_accao) VALUES ($1,$2,$3,'sucesso','/aprovacoes')`,
        [p.solicitante_id, `✅ Aprovado: ${p.titulo}`, 'O teu pedido foi aprovado por todos os níveis.']).catch(()=>{});

      // Executar acção pós-aprovação
      await executarPosAprovacao(p);
    }

    res.json({ ok: true, estado: proximoNivel.rows.length ? 'em_aprovacao' : 'aprovado' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/pedidos/:id/rejeitar', async (req, res) => {
  try {
    const { motivo } = req.body;
    const pedido = await query(`SELECT * FROM aprovacao_pedido WHERE id=$1 AND empresa_id=$2`, [req.params.id, req.empresaId]);
    if (!pedido.rows.length) return res.status(404).json({ error: 'Pedido não encontrado' });
    const p = pedido.rows[0];

    await query(`UPDATE aprovacao_nivel SET estado='rejeitado', aprovado_em=NOW(), comentario=$1 WHERE pedido_id=$2 AND nivel=$3 AND estado='pendente'`,
      [motivo||'', p.id, p.nivel_actual]);
    await query(`UPDATE aprovacao_pedido SET estado='rejeitado', motivo_rejeicao=$1, concluido_em=NOW() WHERE id=$2`, [motivo||'', p.id]);

    // Notificar solicitante
    await query(`INSERT INTO notificacao (utilizador_id, titulo, mensagem, tipo, url_accao) VALUES ($1,$2,$3,'erro','/aprovacoes')`,
      [p.solicitante_id, `❌ Rejeitado: ${p.titulo}`, motivo||'Pedido rejeitado.']).catch(()=>{});

    // Reverter acção se necessário
    if (p.entidade_tipo === 'ferias') {
      await query(`UPDATE ferias SET estado='rejeitado', motivo_rejeicao=$1 WHERE id=$2`, [motivo||'', p.entidade_id]).catch(()=>{});
    }
    if (p.entidade_tipo === 'despesa') {
      await query(`UPDATE despesa SET estado='rejeitada' WHERE id=$1`, [p.entidade_id]).catch(()=>{});
    }

    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

async function executarPosAprovacao(pedido) {
  try {
    if (pedido.entidade_tipo === 'ferias') {
      await query(`UPDATE ferias SET estado='aprovado' WHERE id=$1`, [pedido.entidade_id]);
    } else if (pedido.entidade_tipo === 'despesa') {
      await query(`UPDATE despesa SET estado='aprovada' WHERE id=$1`, [pedido.entidade_id]);
    } else if (pedido.entidade_tipo === 'pedido_compra') {
      await query(`UPDATE pedido_compra SET estado='aprovado' WHERE id=$1`, [pedido.entidade_id]).catch(()=>{});
    }
  } catch(e) { console.error('[Aprovações] Erro pós-aprovação:', e.message); }
}

// Ver detalhe do pedido com histórico de níveis
router.get('/pedidos/:id', async (req, res) => {
  try {
    const [pedido, niveis] = await Promise.all([
      query(`SELECT ap.*, f.nome as fluxo_nome, u.nome_completo as solicitante_nome
        FROM aprovacao_pedido ap JOIN aprovacao_fluxo f ON f.id=ap.fluxo_id
        JOIN utilizador u ON u.id=ap.solicitante_id
        WHERE ap.id=$1 AND ap.empresa_id=$2`, [req.params.id, req.empresaId]),
      query(`SELECT an.*, u.nome_completo as aprovador_nome
        FROM aprovacao_nivel an LEFT JOIN utilizador u ON u.id=an.aprovador_id
        WHERE an.pedido_id=$1 ORDER BY an.nivel`, [req.params.id]),
    ]);
    if (!pedido.rows.length) return res.status(404).json({ error: 'Não encontrado' });
    res.json({ ...pedido.rows[0], niveis: niveis.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
