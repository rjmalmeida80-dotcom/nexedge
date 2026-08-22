'use strict';
/**
 * NexEdge — Chatbot IA ITSM
 * Primeiro contacto automático via IA
 * - Sugere artigos da KB
 * - Resolve problemas simples (reset password, etc)
 * - Cria ticket se necessário
 * - Usa Claude AI com dados reais da BD
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Obter empresa por defeito (para sessões sem auth)
async function getEmpresaDefault() {
  const r = await query(`SELECT id FROM empresa WHERE ativo=true ORDER BY criado_em LIMIT 1`);
  return r.rows[0]?.id;
}

// Sessões de chat (em memória, TTL 1h)
const sessoes = new Map();
const TTL = 60 * 60 * 1000;

function limparSessoes() {
  const agora = Date.now();
  for (const [id, s] of sessoes.entries()) {
    if (agora - s.criado > TTL) sessoes.delete(id);
  }
}
setInterval(limparSessoes, 10 * 60 * 1000);

// Obter contexto da KB para o chatbot
async function obterContextoKB(empresaId, pergunta) {
  const r = await query(`
    SELECT titulo, conteudo, tipo FROM itsm_conhecimento
    WHERE empresa_id=$1 AND estado='publicado'
      AND (titulo ILIKE $2 OR conteudo ILIKE $2)
    ORDER BY visualizacoes DESC LIMIT 5
  `, [empresaId, `%${pergunta.slice(0,50)}%`]).catch(() => ({ rows: [] }));
  return r.rows;
}

// ── INICIAR SESSÃO ──
router.post('/sessao', async (req, res) => {
  try {
    const sessaoId = `chat_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const { nome, email } = req.body;

    const empresaId = req.empresaId || await getEmpresaDefault();
    sessoes.set(sessaoId, {
      id: sessaoId,
      nome: nome || 'Utilizador',
      email: email || '',
      empresaId,
      mensagens: [],
      criado: Date.now(),
      ticketCriado: null,
    });

    res.json({
      sessao_id: sessaoId,
      mensagem: `Olá ${nome || ''}! 👋 Sou o assistente de suporte NexEdge.\n\nComo posso ajudar hoje? Podes descrever o teu problema ou pedido e vou tentar resolver ou encaminhar para a equipa certa.`,
      opcoes: ['Tenho um problema técnico', 'Preciso de acesso/password', 'Quero fazer um pedido', 'Outra questão'],
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ENVIAR MENSAGEM ──
router.post('/mensagem', async (req, res) => {
  try {
    const { sessao_id, mensagem } = req.body;
    if (!sessao_id || !mensagem) return res.status(400).json({ error: 'sessao_id e mensagem obrigatórios' });

    const sessao = sessoes.get(sessao_id);
    if (!sessao) return res.status(404).json({ error: 'Sessão expirada. Inicia uma nova conversa.' });

    // Adicionar mensagem do utilizador
    sessao.mensagens.push({ role: 'user', content: mensagem });

    // Obter artigos KB relevantes
    const kb = sessao.empresaId ? await obterContextoKB(sessao.empresaId, mensagem) : [];

    // Contexto do sistema para a IA
    const sistemaPrompt = `És o assistente de suporte técnico da NexEdge, uma plataforma ERP portuguesa.

Utilizador: ${sessao.nome} (${sessao.email})
Data/Hora: ${new Date().toLocaleString('pt-PT')}

${kb.length ? `Base de Conhecimento relevante:
${kb.map(a => `## ${a.titulo}\n${a.conteudo.slice(0,500)}`).join('\n\n')}` : ''}

INSTRUÇÕES:
1. Responde SEMPRE em Português de Portugal
2. Sê conciso e directo (máx 3 parágrafos)
3. Se encontrares uma solução na KB, apresenta-a claramente
4. Se o problema for simples (reset password, how-to), resolve-o directamente
5. Se precisar de criar ticket, responde com JSON no formato:
   {"criar_ticket": true, "titulo": "...", "descricao": "...", "prioridade": "media|alta|critica", "tipo": "request|incident"}
6. Se o problema estiver resolvido, responde com JSON:
   {"resolvido": true, "solucao": "..."}
7. Nunca inventes informação técnica — se não souberes, cria o ticket

Problemas que podes resolver sem ticket:
- Instruções de uso da plataforma
- Explicações de funcionalidades
- Orientação sobre processos RH/Faturação
- FAQ geral

Problemas que requerem ticket:
- Erros técnicos específicos
- Pedidos de acesso/permissões
- Problemas de dados
- Integrações externas
- Hardware/Infraestrutura`;

    // Chamar Claude
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system: sistemaPrompt,
      messages: sessao.mensagens,
    });

    const resposta = response.content[0]?.text || 'Não consegui processar o teu pedido.';

    // Adicionar resposta ao histórico
    sessao.mensagens.push({ role: 'assistant', content: resposta });

    // Verificar se a IA quer criar ticket
    let ticketInfo = null;
    let resolvido = false;
    let opcoes = [];

    try {
      const jsonMatch = resposta.match(/\{[^}]*"criar_ticket"[^}]*\}/s) ||
                        resposta.match(/\{[^}]*"resolvido"[^}]*\}/s);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.criar_ticket && !sessao.ticketCriado) {
          ticketInfo = parsed;
        }
        if (parsed.resolvido) {
          resolvido = true;
          opcoes = ['Sim, está resolvido ✅', 'Não, ainda tenho o problema'];
        }
      }
    } catch(e) {}

    // Criar ticket automaticamente se necessário
    let ticketCriado = null;
    if (ticketInfo && sessao.empresaId) {
      try {
        const ano = new Date().getFullYear();
        const countR = await query(`SELECT COUNT(*) FROM itsm_ticket WHERE empresa_id=$1 AND EXTRACT(YEAR FROM criado_em)=$2`, [sessao.empresaId, ano]);
        const seq = (parseInt(countR.rows[0].count) + 1).toString().padStart(5,'0');
        const numero = `TK${ano}-${seq}`;
        const slaH = { critica:4, alta:8, media:24, baixa:72 };
        const resolucaoH = slaH[ticketInfo.prioridade||'media'];
        const agora = new Date();

        const r = await query(`
          INSERT INTO itsm_ticket (empresa_id,numero,tipo,titulo,descricao,prioridade,estado,
            sla_resolucao_h,data_limite_resolucao,data_limite_resposta,tags,campos_extra)
          VALUES ($1,$2,$3,$4,$5,$6,'aberto',$7,$8,$9,$10,$11) RETURNING id,numero
        `, [
          sessao.empresaId, numero, ticketInfo.tipo||'request',
          ticketInfo.titulo, `${ticketInfo.descricao}\n\nConversação chatbot:\n${sessao.mensagens.map(m=>`${m.role}: ${m.content}`).join('\n')}`,
          ticketInfo.prioridade||'media', resolucaoH,
          new Date(agora.getTime()+resolucaoH*3600000),
          new Date(agora.getTime()+(resolucaoH/4)*3600000),
          JSON.stringify(['chatbot','ia']),
          JSON.stringify({ via:'chatbot', nome_contacto:sessao.nome, email_contacto:sessao.email }),
        ]);

        ticketCriado = r.rows[0];
        sessao.ticketCriado = ticketCriado;

        await query(`INSERT INTO itsm_comentario (ticket_id,tipo,conteudo,"visivelParaCliente") VALUES ($1,'sistema',$2,true)`,
          [ticketCriado.id, `Ticket criado automaticamente via Chatbot IA por ${sessao.nome}`]);

        opcoes = ['Ver estado do ticket', 'Nova questão'];
      } catch(e) {
        console.error('[Chatbot] Erro ao criar ticket:', e.message);
      }
    }

    if (!opcoes.length && !resolvido) {
      opcoes = ['Isso resolveu o problema ✅', 'Preciso de mais ajuda', 'Falar com um técnico'];
    }

    // Texto limpo (sem JSON)
    const textoLimpo = resposta.replace(/\{[^}]*"criar_ticket"[^}]*\}/gs, '').replace(/\{[^}]*"resolvido"[^}]*\}/gs, '').trim();

    res.json({
      mensagem: textoLimpo || (ticketCriado ? `Criei o ticket **${ticketCriado.numero}** para a tua questão. A equipa de suporte irá contactar-te brevemente.` : resposta),
      ticket_criado: ticketCriado,
      resolvido,
      opcoes,
      historico: sessao.mensagens.length,
    });

  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── FECHAR SESSÃO / AVALIAR ──
router.post('/sessao/:id/fechar', async (req, res) => {
  try {
    const sessao = sessoes.get(req.params.id);
    if (!sessao) return res.json({ ok: true });

    const { satisfacao, feedback } = req.body;
    if (satisfacao && sessao.ticketCriado) {
      await query(`UPDATE itsm_ticket SET satisfacao=$1, feedback_cliente=$2 WHERE id=$3`,
        [satisfacao, feedback, sessao.ticketCriado.id]).catch(()=>{});
    }

    sessoes.delete(req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
