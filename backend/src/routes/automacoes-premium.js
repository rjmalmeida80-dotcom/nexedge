'use strict';
/**
 * NexEdge — Motor de Automações Premium (no-code)
 * Configuração visual de regras: SE [trigger] ENTÃO [acção]
 * Supera: Zapier, Make, Monday Automations
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { autenticar } = require('../middleware/auth');

router.use(autenticar);

// Triggers disponíveis
const TRIGGERS = {
  ticket_criado: { label: 'Ticket criado', campos: ['prioridade','tipo','categoria'] },
  ticket_estado: { label: 'Ticket muda de estado', campos: ['estado_anterior','estado_novo'] },
  fatura_vencida: { label: 'Fatura vencida', campos: ['dias_atraso','valor'] },
  funcionario_admitido: { label: 'Novo funcionário admitido', campos: ['departamento','contrato'] },
  funcionario_saiu: { label: 'Funcionário saiu', campos: ['departamento'] },
  ferias_pedidas: { label: 'Pedido de férias submetido', campos: ['dias','departamento'] },
  oportunidade_etapa: { label: 'Oportunidade muda de etapa', campos: ['etapa_anterior','etapa_nova','valor'] },
  oportunidade_ganha: { label: 'Oportunidade ganha', campos: ['valor','cliente'] },
  despesa_aprovacao: { label: 'Despesa aguarda aprovação', campos: ['valor','categoria'] },
  projecto_atrasado: { label: 'Projecto atrasado', campos: ['dias_atraso'] },
  sla_breach: { label: 'SLA em breach', campos: ['ticket_numero','prioridade'] },
  stock_minimo: { label: 'Stock abaixo do mínimo', campos: ['produto','stock_actual'] },
};

// Acções disponíveis
const ACOES = {
  enviar_email: { label: 'Enviar email', params: ['para','assunto','corpo'] },
  enviar_whatsapp: { label: 'Enviar WhatsApp', params: ['para','mensagem'] },
  criar_notificacao: { label: 'Criar notificação interna', params: ['utilizadores','titulo','mensagem'] },
  criar_tarefa: { label: 'Criar tarefa no projecto', params: ['projecto_id','titulo','responsavel'] },
  criar_ticket: { label: 'Criar ticket ITSM', params: ['titulo','prioridade','categoria'] },
  atualizar_campo: { label: 'Actualizar campo', params: ['entidade','id','campo','valor'] },
  webhook: { label: 'Chamar webhook', params: ['url','metodo','payload'] },
  esperar: { label: 'Aguardar X horas', params: ['horas'] },
  atribuir_responsavel: { label: 'Atribuir responsável', params: ['utilizador_id'] },
};

// ── LISTAR AUTOMAÇÕES ──

router.get('/', async (req, res) => {
  try {
    const r = await query(`
      SELECT a.*,
        (SELECT COUNT(*) FROM automacao_log WHERE automacao_id=a.id) as num_execucoes,
        (SELECT MAX(criado_em) FROM automacao_log WHERE automacao_id=a.id) as ultima_execucao,
        (SELECT COUNT(*) FROM automacao_log WHERE automacao_id=a.id AND estado='erro') as num_erros
      FROM automacao_config a
      WHERE a.empresa_id=$1 ORDER BY a.criado_em DESC
    `, [req.empresaId]).catch(() => ({ rows: [] }));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/triggers', (req, res) => res.json(TRIGGERS));
router.get('/acoes', (req, res) => res.json(ACOES));

// ── CRIAR AUTOMAÇÃO ──

router.post('/', async (req, res) => {
  try {
    const { nome, descricao, trigger, condicoes, acoes, ativo } = req.body;
    if (!nome || !trigger || !acoes?.length) return res.status(400).json({ error: 'Nome, trigger e acções obrigatórios' });

    const r = await query(`
      INSERT INTO automacao_config (empresa_id, nome, descricao, trigger_tipo, condicoes, acoes, ativo, criado_por)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
    `, [req.empresaId, nome, descricao||'', trigger, JSON.stringify(condicoes||[]), JSON.stringify(acoes), ativo!==false, req.utilizador.id]);
    res.status(201).json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', async (req, res) => {
  try {
    const { nome, descricao, trigger, condicoes, acoes, ativo } = req.body;
    await query(`UPDATE automacao_config SET nome=$1, descricao=$2, trigger_tipo=$3, condicoes=$4, acoes=$5, ativo=$6 WHERE id=$7 AND empresa_id=$8`,
      [nome, descricao||'', trigger, JSON.stringify(condicoes||[]), JSON.stringify(acoes||[]), ativo!==false, req.params.id, req.empresaId]);
    const r = await query(`SELECT * FROM automacao_config WHERE id=$1`, [req.params.id]);
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    await query(`DELETE FROM automacao_config WHERE id=$1 AND empresa_id=$2`, [req.params.id, req.empresaId]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── EXECUTAR AUTOMAÇÃO MANUALMENTE ──

router.post('/:id/executar', async (req, res) => {
  try {
    const r = await query(`SELECT * FROM automacao_config WHERE id=$1 AND empresa_id=$2`, [req.params.id, req.empresaId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Automação não encontrada' });
    const resultado = await executarAutomacao(r.rows[0], req.body.contexto||{});
    res.json(resultado);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── MOTOR DE EXECUÇÃO ──

async function executarAutomacao(automacao, contexto) {
  const acoes = typeof automacao.acoes === 'string' ? JSON.parse(automacao.acoes) : automacao.acoes;
  const resultados = [];
  let estado = 'sucesso';

  for (const acao of acoes) {
    try {
      let resultado = null;

      if (acao.tipo === 'enviar_email') {
        const { enviarEmail } = require('../services/emailService');
        const para = substituirVariaveis(acao.para, contexto);
        const assunto = substituirVariaveis(acao.assunto, contexto);
        const corpo = substituirVariaveis(acao.corpo, contexto);
        await enviarEmail({ to: para, subject: assunto, html: corpo }).catch(()=>{});
        resultado = `Email enviado para ${para}`;
      }

      else if (acao.tipo === 'criar_notificacao') {
        const titulo = substituirVariaveis(acao.titulo, contexto);
        const mensagem = substituirVariaveis(acao.mensagem, contexto);
        const utilizadores = acao.utilizadores || 'admins';
        let whereUser = '';
        if (utilizadores === 'admins') whereUser = `perfil IN ('admin_empresa','rh')`;
        else if (utilizadores === 'todos') whereUser = 'ativo=true';
        else whereUser = `id='${utilizadores}'`;

        await query(`INSERT INTO notificacao (utilizador_id, titulo, mensagem, tipo)
          SELECT id, $1, $2, 'automacao' FROM utilizador WHERE empresa_id=$3 AND ${whereUser}`,
          [titulo, mensagem, automacao.empresa_id]).catch(()=>{});
        resultado = `Notificação criada: ${titulo}`;
      }

      else if (acao.tipo === 'webhook') {
        const url = substituirVariaveis(acao.url, contexto);
        const payload = acao.payload ? JSON.parse(substituirVariaveis(JSON.stringify(acao.payload), contexto)) : contexto;
        const r = await fetch(url, {
          method: acao.metodo||'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        resultado = `Webhook ${r.status}: ${url}`;
      }

      else if (acao.tipo === 'criar_ticket') {
        const titulo = substituirVariaveis(acao.titulo, contexto);
        const ano = new Date().getFullYear();
        const countR = await query(`SELECT COUNT(*) FROM itsm_ticket WHERE empresa_id=$1 AND EXTRACT(YEAR FROM criado_em)=$2`, [automacao.empresa_id, ano]);
        const seq = (parseInt(countR.rows[0].count)+1).toString().padStart(5,'0');
        const numero = `TK${ano}-${seq}`;
        await query(`INSERT INTO itsm_ticket (empresa_id,numero,tipo,titulo,prioridade,estado) VALUES ($1,$2,'task',$3,$4,'aberto')`,
          [automacao.empresa_id, numero, titulo, acao.prioridade||'media']);
        resultado = `Ticket criado: ${numero}`;
      }

      else if (acao.tipo === 'esperar') {
        // Marcar para execução futura (cron vai retomar)
        resultado = `Aguardar ${acao.horas}h`;
      }

      resultados.push({ acao: acao.tipo, estado: 'ok', resultado });
    } catch(err) {
      estado = 'erro_parcial';
      resultados.push({ acao: acao.tipo, estado: 'erro', erro: err.message });
    }
  }

  // Log
  await query(`INSERT INTO automacao_log (automacao_id, empresa_id, trigger_tipo, contexto, resultados, estado)
    VALUES ($1,$2,$3,$4,$5,$6)`,
    [automacao.id, automacao.empresa_id, automacao.trigger_tipo, JSON.stringify(contexto), JSON.stringify(resultados), estado]).catch(()=>{});

  return { estado, resultados };
}

function substituirVariaveis(texto, contexto) {
  if (!texto || typeof texto !== 'string') return texto;
  return texto.replace(/\{\{(\w+)\}\}/g, (_, key) => contexto[key] || `{{${key}}}`);
}

// ── DISPARAR POR TRIGGER (chamado internamente) ──

async function dispararTrigger(empresaId, triggerTipo, contexto) {
  try {
    const automacoes = await query(`
      SELECT * FROM automacao_config
      WHERE empresa_id=$1 AND trigger_tipo=$2 AND ativo=true
    `, [empresaId, triggerTipo]).catch(() => ({ rows: [] }));

    for (const auto of automacoes.rows) {
      const condicoes = typeof auto.condicoes === 'string' ? JSON.parse(auto.condicoes) : (auto.condicoes||[]);

      // Verificar condições
      const condicoesSatisfeitas = condicoes.every(cond => {
        const val = contexto[cond.campo];
        if (cond.operador === 'igual') return val == cond.valor;
        if (cond.operador === 'maior') return parseFloat(val) > parseFloat(cond.valor);
        if (cond.operador === 'menor') return parseFloat(val) < parseFloat(cond.valor);
        if (cond.operador === 'contem') return String(val||'').includes(cond.valor);
        return true;
      });

      if (condicoesSatisfeitas) {
        await executarAutomacao(auto, contexto).catch(e => console.error('[Automação]', e.message));
      }
    }
  } catch(e) {
    console.error('[Automações] Erro ao disparar trigger:', e.message);
  }
}

// Log de execuções
router.get('/:id/log', async (req, res) => {
  try {
    const r = await query(`SELECT * FROM automacao_log WHERE automacao_id=$1 ORDER BY criado_em DESC LIMIT 50`, [req.params.id]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = { router, dispararTrigger, executarAutomacao };
