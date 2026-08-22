'use strict';
/**
 * NexEdge — IA Copilot Universal
 * Assistente IA que responde perguntas sobre dados reais da empresa
 * Funciona em qualquer módulo: logística, RH, financeiro, WMS, etc.
 * "Mostra-me as entregas atrasadas de hoje" → responde com dados reais
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const Anthropic = require('@anthropic-ai/sdk');

router.use(autenticar);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Histórico de conversas por utilizador (em memória — em prod usar Redis)
const conversas = {};

// ── COPILOT CHAT ──

router.post('/chat', async (req, res) => {
  try {
    const { mensagem, contexto_modulo, historico } = req.body;
    if (!mensagem?.trim()) return res.status(400).json({ error: 'Mensagem obrigatória' });
    if (!anthropic) return res.json({ resposta: 'Configure ANTHROPIC_API_KEY para usar o Copilot.' });

    const sessionKey = `${req.empresaId}:${req.utilizador.id}`;

    // Recolher dados contextuais relevantes baseados na pergunta
    const dadosContexto = await recolherDados(mensagem, req.empresaId);

    // Construir mensagens
    const msgs = [
      ...(historico || []).slice(-8), // últimas 8 mensagens do histórico
      { role: 'user', content: mensagem }
    ];

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: `És o Copilot da NexEdge — assistente IA integrado no ERP da empresa "${req.utilizador.empresa_nome||''}".
Tens acesso a dados reais da empresa em tempo real.
Módulo actual: ${contexto_modulo || 'ERP geral'}
Utilizador: ${req.utilizador.nome_completo} (${req.utilizador.perfil})
Data/hora: ${new Date().toLocaleString('pt-PT')}

DADOS REAIS DA EMPRESA (actualizados agora):
${dadosContexto}

REGRAS:
- Responde SEMPRE em português de Portugal
- Sê directo e específico com os dados reais
- Usa emojis com moderação para clareza
- Quando há dados, apresenta-os de forma clara (tabelas simples se necessário)
- Se não tens dados suficientes, diz o que precisas
- Nunca inventes dados — usa apenas o que está acima
- Para acções (criar, alterar, apagar), confirma antes de executar`,
      messages: msgs
    });

    const resposta = response.content[0]?.text;

    // Guardar no histórico
    if (!conversas[sessionKey]) conversas[sessionKey] = [];
    conversas[sessionKey].push({ role: 'user', content: mensagem });
    conversas[sessionKey].push({ role: 'assistant', content: resposta });
    if (conversas[sessionKey].length > 20) conversas[sessionKey] = conversas[sessionKey].slice(-20);

    res.json({
      resposta,
      tokens: response.usage?.input_tokens + response.usage?.output_tokens,
      dados_usados: dadosContexto.slice(0, 200) + '...',
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Recolher dados relevantes baseados na pergunta
async function recolherDados(pergunta, empresaId) {
  const p = pergunta.toLowerCase();
  const dados = [];

  try {
    // Logística
    if (p.includes('entrega') || p.includes('encomenda') || p.includes('logist') || p.includes('atrasa')) {
      const r = await query(`SELECT estado, COUNT(*) as total FROM logistica_encomenda WHERE empresa_id=$1 GROUP BY estado`, [empresaId]);
      const atrasadas = await query(`SELECT numero, destinatario_nome, destinatario_localidade, EXTRACT(DAY FROM NOW()-data_entrega_prevista) as dias FROM logistica_encomenda WHERE empresa_id=$1 AND estado NOT IN ('entregue','cancelada') AND data_entrega_prevista < NOW() ORDER BY dias DESC LIMIT 5`, [empresaId]);
      dados.push(`LOGÍSTICA: ${JSON.stringify(r.rows)}`);
      if (atrasadas.rows.length) dados.push(`ATRASADAS: ${JSON.stringify(atrasadas.rows)}`);
    }

    // RH
    if (p.includes('funcionári') || p.includes('colaborad') || p.includes('falta') || p.includes('férias') || p.includes('rh')) {
      const r = await query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE estado='ativo') as ativos, COUNT(*) FILTER (WHERE estado='ferias') as ferias FROM funcionario WHERE empresa_id=$1`, [empresaId]);
      dados.push(`RH: ${JSON.stringify(r.rows[0])}`);
    }

    // Financeiro
    if (p.includes('fatura') || p.includes('pagamento') || p.includes('receita') || p.includes('dívida') || p.includes('financei')) {
      const r = await query(`SELECT COUNT(*) as total_faturas, SUM(total) FILTER (WHERE estado='emitida') as pendente, SUM(total) FILTER (WHERE estado='paga' AND data_emissao > NOW()-INTERVAL '30 days') as recebido_30d FROM fatura WHERE empresa_id=$1`, [empresaId]);
      dados.push(`FINANCEIRO: ${JSON.stringify(r.rows[0])}`);
    }

    // Stock/WMS
    if (p.includes('stock') || p.includes('armazém') || p.includes('produto') || p.includes('inventári')) {
      const r = await query(`SELECT COUNT(DISTINCT produto_id) as produtos, SUM(quantidade) as unidades FROM wms_stock WHERE empresa_id=$1`, [empresaId]).catch(()=>({rows:[{produtos:0}]}));
      const alertas = await query(`SELECT COUNT(*) as alertas FROM wms_alerta WHERE empresa_id=$1 AND resolvido=false`, [empresaId]).catch(()=>({rows:[{alertas:0}]}));
      dados.push(`WMS/STOCK: ${JSON.stringify({...r.rows[0], alertas: alertas.rows[0].alertas})}`);
    }

    // ITSM
    if (p.includes('ticket') || p.includes('problema') || p.includes('suporte') || p.includes('incidente')) {
      const r = await query(`SELECT estado, prioridade, COUNT(*) as total FROM itsm_ticket WHERE empresa_id=$1 GROUP BY estado, prioridade ORDER BY total DESC LIMIT 10`, [empresaId]).catch(()=>({rows:[]}));
      dados.push(`ITSM TICKETS: ${JSON.stringify(r.rows)}`);
    }

    // CRM
    if (p.includes('cliente') || p.includes('oportunidade') || p.includes('venda') || p.includes('pipeline') || p.includes('crm')) {
      const r = await query(`SELECT estado, COUNT(*) as total, SUM(valor) as valor_total FROM oportunidade WHERE empresa_id=$1 GROUP BY estado`, [empresaId]).catch(()=>({rows:[]}));
      dados.push(`CRM PIPELINE: ${JSON.stringify(r.rows)}`);
    }

    // Motoristas
    if (p.includes('motorista') || p.includes('condutor') || p.includes('frota') || p.includes('veículo')) {
      const r = await query(`SELECT estado, COUNT(*) as total FROM logistica_motorista WHERE empresa_id=$1 GROUP BY estado`, [empresaId]).catch(()=>({rows:[]}));
      dados.push(`MOTORISTAS: ${JSON.stringify(r.rows)}`);
    }

    // OKRs
    if (p.includes('okr') || p.includes('objectivo') || p.includes('meta') || p.includes('progresso')) {
      const r = await query(`SELECT nivel, ROUND(AVG(progresso)) as progresso_medio, COUNT(*) as total FROM okr_objectivo WHERE empresa_id=$1 AND estado='activo' GROUP BY nivel`, [empresaId]).catch(()=>({rows:[]}));
      dados.push(`OKRs: ${JSON.stringify(r.rows)}`);
    }

    // Senhas
    if (p.includes('senha') || p.includes('fila') || p.includes('atendimento') || p.includes('balcão')) {
      const r = await query(`SELECT COUNT(*) FILTER (WHERE estado='aguarda') as em_espera, COUNT(*) FILTER (WHERE estado='em_atendimento') as em_atendimento, COUNT(*) FILTER (WHERE DATE(criado_em)=CURRENT_DATE) as hoje FROM medialoop_senha WHERE empresa_id=$1`, [empresaId]).catch(()=>({rows:[{em_espera:0}]}));
      dados.push(`SENHAS/FILAS: ${JSON.stringify(r.rows[0])}`);
    }

    // Dados gerais sempre incluídos
    const geral = await query(`SELECT e.nome, e.nif, COUNT(DISTINCT u.id) as utilizadores FROM empresa e LEFT JOIN utilizador u ON u.empresa_id=e.id WHERE e.id=$1 GROUP BY e.id,e.nome,e.nif`, [empresaId]).catch(()=>({rows:[{}]}));
    dados.push(`EMPRESA: ${JSON.stringify(geral.rows[0])}`);

  } catch(e) {
    dados.push(`Erro ao recolher dados: ${e.message}`);
  }

  return dados.length ? dados.join('\n') : 'Sem dados disponíveis no momento.';
}

// Limpar histórico
router.delete('/chat/historico', async (req, res) => {
  const key = `${req.empresaId}:${req.utilizador.id}`;
  delete conversas[key];
  res.json({ ok: true });
});

// Sugestões rápidas por módulo
router.get('/sugestoes/:modulo', (req, res) => {
  const sugestoes = {
    logistica: ['Quantas entregas estão atrasadas hoje?','Qual é a taxa de entrega no prazo esta semana?','Que motoristas estão disponíveis agora?','Mostra-me as encomendas com problema'],
    wms: ['Que produtos estão abaixo do stock mínimo?','Qual é o valor total do stock?','Quantas recepções abertas temos?','Mostra alertas do armazém'],
    rh: ['Quantos funcionários estão de férias?','Qual é a distribuição por departamento?','Mostra os aniversários desta semana'],
    financeiro: ['Quanto temos em faturas por receber?','Qual foi a receita do último mês?','Mostra faturas vencidas há mais de 30 dias'],
    crm: ['Qual é o valor total do pipeline?','Quantas oportunidades estão em negociação?','Mostra oportunidades ganhas este mês'],
    itsm: ['Quantos tickets estão abertos?','Mostra tickets críticos sem resposta','Qual é o tempo médio de resolução?'],
    geral: ['Resume o estado da empresa hoje','Quais são os principais alertas agora?','Mostra o dashboard executivo','O que precisa de atenção urgente?'],
  };
  res.json(sugestoes[req.params.modulo] || sugestoes.geral);
});

// Acção rápida por voz/texto
router.post('/accao', async (req, res) => {
  try {
    const { accao, parametros } = req.body;
    // Ex: accao='criar_ticket', 'atribuir_motorista', 'aprovar_despesa'
    // Implementar acções directas que o copilot pode executar
    res.json({ ok: true, mensagem: `Acção '${accao}' registada para implementação` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
