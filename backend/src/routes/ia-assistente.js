'use strict';
/**
 * NexEdge — IA Assistente Avançado
 * Análise de dados reais da empresa, previsões, sugestões, relatórios automáticos
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const Anthropic = require('@anthropic-ai/sdk');

router.use(autenticar);
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

// ── CONTEXTO EMPRESARIAL PARA IA ──

async function obterContextoEmpresa(empresaId) {
  const [empresa, kpis, alertas, funcionarios, faturas, tickets] = await Promise.all([
    query(`SELECT nome, nif, email, morada, modulos FROM empresa WHERE id=$1`, [empresaId]),
    query(`SELECT
      (SELECT COUNT(*) FROM funcionario WHERE empresa_id=$1 AND estado='ativo') as funcionarios,
      (SELECT COALESCE(SUM(total),0) FROM fatura WHERE empresa_id=$1 AND estado IN ('emitida','paga') AND data_emissao > NOW()-INTERVAL '30 days') as receita_30d,
      (SELECT COUNT(*) FROM itsm_ticket WHERE empresa_id=$1 AND estado='aberto') as tickets_abertos,
      (SELECT COUNT(*) FROM ferias WHERE empresa_id=$1 AND estado='pendente') as ferias_pendentes
      `, [empresaId]),
    query(`SELECT tipo, mensagem FROM alerta WHERE empresa_id=$1 AND lido=false ORDER BY criado_em DESC LIMIT 5`, [empresaId]).catch(()=>({rows:[]})),
    query(`SELECT departamento, COUNT(*) as total, AVG(salario_base) as salario_medio FROM funcionario WHERE empresa_id=$1 AND estado='ativo' GROUP BY departamento`, [empresaId]).catch(()=>({rows:[]})),
    query(`SELECT estado, COUNT(*) as total, SUM(total) as valor FROM fatura WHERE empresa_id=$1 AND data_emissao > NOW()-INTERVAL '90 days' GROUP BY estado`, [empresaId]).catch(()=>({rows:[]})),
    query(`SELECT prioridade, estado, COUNT(*) as total FROM itsm_ticket WHERE empresa_id=$1 GROUP BY prioridade, estado`, [empresaId]).catch(()=>({rows:[]})),
  ]);

  return {
    empresa: empresa.rows[0],
    kpis: kpis.rows[0],
    alertas: alertas.rows,
    funcionarios_por_dept: funcionarios.rows,
    faturas_resumo: faturas.rows,
    tickets_resumo: tickets.rows,
  };
}

// ── CHAT COM IA ──

router.post('/chat', async (req, res) => {
  try {
    const { mensagem, historico = [] } = req.body;
    if (!mensagem) return res.status(400).json({ error: 'Mensagem obrigatória' });

    const contexto = await obterContextoEmpresa(req.empresaId);
    const hoje = new Date().toLocaleDateString('pt-PT');

    const sistemaPrompt = `És o Assistente IA da NexEdge, uma plataforma ERP portuguesa.
Tens acesso aos dados reais da empresa em tempo real e ajudas com:
- Análise de dados e tendências
- Sugestões de melhoria operacional
- Alertas e recomendações
- Relatórios e previsões
- Resposta a questões sobre RH, Financeiro, ITSM

DADOS ACTUAIS DA EMPRESA (${hoje}):
Empresa: ${contexto.empresa?.nome} (NIF: ${contexto.empresa?.nif})
Colaboradores activos: ${contexto.kpis?.funcionarios}
Receita últimos 30 dias: ${parseFloat(contexto.kpis?.receita_30d||0).toFixed(2)}€
Tickets ITSM abertos: ${contexto.kpis?.tickets_abertos}
Férias pendentes de aprovação: ${contexto.kpis?.ferias_pendentes}

Funcionários por departamento:
${contexto.funcionarios_por_dept.map(d=>`- ${d.departamento||'Sem dept'}: ${d.total} pessoas, salário médio ${parseFloat(d.salario_medio||0).toFixed(0)}€`).join('\n')}

Faturas (90 dias):
${contexto.faturas_resumo.map(f=>`- ${f.estado}: ${f.total} faturas, ${parseFloat(f.valor||0).toFixed(2)}€`).join('\n')}

Alertas activos: ${contexto.alertas.length}

INSTRUÇÕES:
- Responde SEMPRE em Português de Portugal
- Sê conciso mas completo (usa bullet points quando adequado)
- Quando precisas de dados que não tens, diz claramente o que precisas
- Faz sugestões concretas e accionáveis
- Usa emojis com moderação para melhorar a leitura`;

    if (!anthropic) {
      return res.json({
        resposta: `Olá! Sou o Assistente IA da NexEdge.\n\nA tua empresa **${contexto.empresa?.nome}** tem:\n- 👥 **${contexto.kpis?.funcionarios}** colaboradores activos\n- 💰 **${parseFloat(contexto.kpis?.receita_30d||0).toFixed(2)}€** em receita nos últimos 30 dias\n- 🎫 **${contexto.kpis?.tickets_abertos}** tickets ITSM abertos\n\nPara activar a IA completa, configura a ANTHROPIC_API_KEY no .env.`,
        tokens_usados: 0,
      });
    }

    const messages = [
      ...historico.slice(-10), // últimas 10 mensagens
      { role: 'user', content: mensagem }
    ];

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: sistemaPrompt,
      messages,
    });

    res.json({
      resposta: response.content[0]?.text,
      tokens_usados: response.usage?.input_tokens + response.usage?.output_tokens,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ANÁLISE AUTOMÁTICA ──

router.get('/analise', async (req, res) => {
  try {
    const contexto = await obterContextoEmpresa(req.empresaId);

    if (!anthropic) {
      return res.json({
        analise: `# Análise Automática — ${contexto.empresa?.nome}\n\n## Resumo\n- Colaboradores: ${contexto.kpis?.funcionarios}\n- Receita 30d: ${parseFloat(contexto.kpis?.receita_30d||0).toFixed(2)}€\n- Tickets abertos: ${contexto.kpis?.tickets_abertos}\n\n_Configure ANTHROPIC_API_KEY para análise completa com IA._`,
        gerado_em: new Date().toISOString(),
      });
    }

    const prompt = `Analisa os dados desta empresa e gera um relatório executivo em Markdown com:
1. **Resumo Executivo** (3-4 linhas)
2. **Pontos Fortes** (o que está a correr bem)
3. **Áreas de Melhoria** (o que requer atenção)
4. **Recomendações** (3-5 acções concretas)
5. **Alertas** (riscos identificados)

Dados: ${JSON.stringify(contexto, null, 2)}`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });

    res.json({
      analise: response.content[0]?.text,
      gerado_em: new Date().toISOString(),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PREVISÃO DE RECEITA ──

router.get('/previsao-receita', async (req, res) => {
  try {
    const historico = await query(`
      SELECT TO_CHAR(data_emissao,'YYYY-MM') as mes, SUM(total) as total
      FROM fatura WHERE empresa_id=$1 AND estado IN ('emitida','paga')
        AND data_emissao > NOW()-INTERVAL '12 months'
      GROUP BY mes ORDER BY mes
    `, [req.empresaId]).catch(()=>({rows:[]}));

    const dados = historico.rows;
    if (dados.length < 3) return res.json({ previsao: [], mensagem: 'Dados insuficientes para previsão' });

    // Média móvel simples dos últimos 3 meses como previsão
    const valores = dados.map(d => parseFloat(d.total));
    const media3 = valores.slice(-3).reduce((a,b)=>a+b,0) / 3;
    const tendencia = valores.length > 1 ? (valores[valores.length-1] - valores[valores.length-2]) / valores[valores.length-2] : 0;

    const previsao = [];
    for (let i = 1; i <= 3; i++) {
      const data = new Date();
      data.setMonth(data.getMonth() + i);
      previsao.push({
        mes: data.toISOString().slice(0,7),
        previsao: Math.round(media3 * (1 + tendencia * i * 0.5)),
        confianca: Math.max(60, 90 - i * 10),
      });
    }

    res.json({ historico: dados, previsao, tendencia_pct: Math.round(tendencia * 100) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SUGESTÕES IA ──

router.get('/sugestoes', async (req, res) => {
  try {
    const contexto = await obterContextoEmpresa(req.empresaId);
    const sugestoes = [];

    // Regras de negócio para sugestões automáticas
    if (parseInt(contexto.kpis?.tickets_abertos||0) > 10) {
      sugestoes.push({ tipo:'warning', titulo:'ITSM sobrecarregado', descricao:`Tens ${contexto.kpis?.tickets_abertos} tickets abertos. Considera reforçar a equipa de suporte.`, url:'/itsm-app' });
    }
    if (parseInt(contexto.kpis?.ferias_pendentes||0) > 5) {
      sugestoes.push({ tipo:'info', titulo:'Férias por aprovar', descricao:`${contexto.kpis?.ferias_pendentes} pedidos de férias aguardam aprovação.`, url:'/ferias' });
    }

    const fatsPendentes = contexto.faturas_resumo.find(f=>f.estado==='emitida');
    if (fatsPendentes && parseFloat(fatsPendentes.valor||0) > 1000) {
      sugestoes.push({ tipo:'warning', titulo:'Cobranças pendentes', descricao:`${parseFloat(fatsPendentes.valor||0).toFixed(2)}€ em faturas por cobrar.`, url:'/faturacao' });
    }

    if (!sugestoes.length) {
      sugestoes.push({ tipo:'success', titulo:'Tudo em ordem!', descricao:'Não há alertas críticos neste momento. Continua assim!', url:null });
    }

    res.json(sugestoes);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
