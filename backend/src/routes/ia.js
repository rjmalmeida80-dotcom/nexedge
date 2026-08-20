'use strict';
const router = require('express').Router();
const { autenticar } = require('../middleware/auth');
const { query } = require('../config/database');

router.use(autenticar);

// Helper: get the correct API key for this empresa
async function getApiKey(empresaId) {
  try {
    const { rows } = await query(
      'SELECT anthropic_api_key FROM empresa WHERE id=$1',
      [empresaId]
    );
    return rows[0]?.anthropic_api_key || process.env.ANTHROPIC_API_KEY || '';
  } catch(e) {
    // Column might not exist if migrate_v2 not run
    return process.env.ANTHROPIC_API_KEY || '';
  }
}

// POST /ia/chat — assistente de RH com acesso aos dados reais
router.post('/chat', async (req, res) => {
  const { mensagem, contexto_extra } = req.body;
  if (!mensagem) return res.status(400).json({ error: 'Mensagem em falta.' });

  try {
    // 1. Recolher contexto relevante da BD
    const hoje = new Date().toISOString().split('T')[0];
    const mesAtual = new Date().getMonth() + 1;
    const anoAtual = new Date().getFullYear();

    // Dados gerais da empresa
    const { rows: [empresa] } = await query(
      'SELECT nome, nif, morada FROM empresa WHERE id=$1', [req.empresaId]
    );

    // KPIs básicos
    const { rows: [kpis] } = await query(`
      SELECT
        COUNT(*) FILTER (WHERE estado='ativo') AS total_ativos,
        COUNT(*) FILTER (WHERE estado='inativo') AS total_inativos,
        COUNT(*) FILTER (WHERE estado='ferias') AS total_ferias,
        COUNT(*) FILTER (WHERE estado='baixa_medica') AS total_baixa,
        ROUND(AVG(salario_base) FILTER (WHERE estado='ativo'), 2) AS salario_medio,
        SUM(salario_base) FILTER (WHERE estado='ativo') AS massa_salarial
      FROM funcionario WHERE empresa_id=$1
    `, [req.empresaId]);

    // Férias pendentes
    const { rows: feriasPend } = await query(`
      SELECT COUNT(*) AS total FROM pedido_ferias pf
      JOIN funcionario f ON f.id=pf.funcionario_id
      WHERE f.empresa_id=$1 AND pf.estado='pendente'
    `, [req.empresaId]);

    // Funcionários (lista básica para responder perguntas sobre pessoas)
    const { rows: funcionarios } = await query(`
      SELECT f.nome_completo, f.cargo, f.estado, f.salario_base,
             f.data_admissao, f.tipo_contrato, f.email_empresa,
             d.nome AS departamento,
             f.dias_ferias_saldo, f.dias_ferias_gozados
      FROM funcionario f
      LEFT JOIN departamento d ON d.id=f.departamento_id
      WHERE f.empresa_id=$1 AND f.estado='ativo'
      ORDER BY f.nome_completo
      LIMIT 50
    `, [req.empresaId]);

    // Alertas actuais
    const { rows: contratos_fim } = await query(`
      SELECT nome_completo, tipo_contrato, data_fim_contrato,
             (data_fim_contrato - CURRENT_DATE) AS dias_restantes
      FROM funcionario
      WHERE empresa_id=$1 AND estado='ativo'
        AND data_fim_contrato IS NOT NULL
        AND data_fim_contrato BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '60 days'
      ORDER BY data_fim_contrato
    `, [req.empresaId]);

    // Aniversários hoje/semana
    const { rows: aniversarios } = await query(`
      SELECT nome_completo, cargo,
             EXTRACT(DAY FROM data_nascimento) AS dia,
             EXTRACT(MONTH FROM data_nascimento) AS mes
      FROM funcionario
      WHERE empresa_id=$1 AND estado='ativo'
        AND EXTRACT(MONTH FROM data_nascimento)=$2
        AND EXTRACT(DAY FROM data_nascimento) BETWEEN $3 AND $3+7
    `, [req.empresaId, mesAtual, new Date().getDate()]);

    // Dados de Faturação
    const { rows: [fatKpis] } = await query(`
      SELECT
        COUNT(*) AS total_faturas,
        COALESCE(SUM(total),0) AS faturacao_total,
        COALESCE(SUM(CASE WHEN estado='paga' THEN total ELSE 0 END),0) AS recebido,
        COALESCE(SUM(CASE WHEN estado NOT IN ('paga','anulada') THEN total ELSE 0 END),0) AS em_aberto,
        COUNT(*) FILTER(WHERE estado NOT IN ('paga','anulada')) AS faturas_pendentes
      FROM fatura WHERE empresa_id=$1 AND EXTRACT(YEAR FROM data_emissao)=$2
    `, [req.empresaId, anoAtual]).catch(() => ({ rows:[{}] }));

    // Dados CRM
    const { rows: [crmKpis] } = await query(`
      SELECT
        COUNT(*) AS total_oportunidades,
        COALESCE(SUM(CASE WHEN etapa NOT IN ('fechado_ganho','fechado_perdido') THEN valor ELSE 0 END),0) AS pipeline_valor,
        COALESCE(SUM(CASE WHEN etapa='fechado_ganho' THEN valor ELSE 0 END),0) AS ganhos_valor,
        COUNT(*) FILTER(WHERE etapa='fechado_ganho') AS negócios_ganhos,
        COUNT(*) FILTER(WHERE etapa='fechado_perdido') AS negócios_perdidos
      FROM crm_oportunidade WHERE empresa_id=$1
    `, [req.empresaId]).catch(() => ({ rows:[{}] }));

    // Montar contexto para a IA
    const contexto = `
És um assistente empresarial especializado em gestão de recursos humanos, faturação e CRM para empresas portuguesas.
Respondes sempre em português europeu, de forma profissional mas acessível.
Tens acesso aos dados reais da empresa "${empresa?.nome}".
Respondes sempre em português europeu, de forma profissional mas acessível.
Tens acesso aos dados reais da empresa "${empresa?.nome}".

DADOS DA EMPRESA (hoje: ${hoje}):
- Colaboradores activos: ${kpis?.total_ativos || 0}
- Em férias: ${kpis?.total_ferias || 0}
- Baixa médica: ${kpis?.total_baixa || 0}
- Salário médio: ${parseFloat(kpis?.salario_medio || 0).toFixed(2)}€
- Massa salarial mensal: ${parseFloat(kpis?.massa_salarial || 0).toFixed(2)}€
- Pedidos de férias pendentes: ${feriasPend[0]?.total || 0}

COLABORADORES ACTIVOS:
${funcionarios.map(f => `- ${f.nome_completo} | ${f.cargo} | ${f.departamento || 'Sem depto'} | ${f.estado} | Salário: ${f.salario_base}€ | Férias disponíveis: ${f.dias_ferias_saldo || 0} dias`).join('\n')}

CONTRATOS A TERMINAR (próximos 60 dias):
${contratos_fim.length > 0 ? contratos_fim.map(c => `- ${c.nome_completo}: ${c.tipo_contrato} termina em ${c.dias_restantes} dias`).join('\n') : 'Nenhum'}

ANIVERSÁRIOS ESTA SEMANA:
${aniversarios.length > 0 ? aniversarios.map(a => `- ${a.nome_completo} (${a.cargo}) - dia ${a.dia}/${a.mes}`).join('\n') : 'Nenhum'}

FATURAÇÃO ${anoAtual}:
- Total faturas: ${fatKpis?.total_faturas || 0}
- Facturação total: ${parseFloat(fatKpis?.faturacao_total || 0).toFixed(2)}€
- Recebido: ${parseFloat(fatKpis?.recebido || 0).toFixed(2)}€
- Em aberto: ${parseFloat(fatKpis?.em_aberto || 0).toFixed(2)}€
- Faturas pendentes: ${fatKpis?.faturas_pendentes || 0}

CRM & PIPELINE:
- Total oportunidades: ${crmKpis?.total_oportunidades || 0}
- Valor do pipeline: ${parseFloat(crmKpis?.pipeline_valor || 0).toFixed(2)}€
- Negócios ganhos: ${crmKpis?.negócios_ganhos || 0} (${parseFloat(crmKpis?.ganhos_valor || 0).toFixed(2)}€)
- Negócios perdidos: ${crmKpis?.negócios_perdidos || 0}

${contexto_extra ? `CONTEXTO ADICIONAL:\n${contexto_extra}` : ''}

INSTRUÇÕES:
- Responde de forma directa e útil
- Usa os dados reais acima quando relevante
- Para questões de RH, cita o Código do Trabalho quando possível
- Para questões financeiras, analisa tendências e faz recomendações
- Para questões de CRM, sugere acções concretas para fechar negócios
- Mantém confidencialidade — não partilhes dados sensíveis desnecessariamente
- Podes responder a perguntas como "quantos colaboradores tenho?", "qual o total faturado?", "como está o pipeline?"
`;

    // Chamar a API do Claude
    const apiKey = await getApiKey(req.empresaId);
    if (!apiKey) return res.status(400).json({ error: 'Chave API não configurada. Configure em Configurações → Plano e IA.' });
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: contexto,
        messages: [{ role: 'user', content: mensagem }],
      }),
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({ error: { message: 'Erro desconhecido' } }));
      const msg = errData?.error?.message || JSON.stringify(errData);
      console.error('Claude API error:', msg);
      if (msg.includes('credit') || msg.includes('balance')) {
        return res.status(402).json({ error: 'Sem créditos IA. Vai a console.anthropic.com → Plans & Billing para recarregar.' });
      }
      return res.status(500).json({ error: 'Erro da IA: ' + msg });
    }

    const data = await response.json();
    const resposta = data.content?.[0]?.text || 'Sem resposta.';

    res.json({ resposta, tokens_usados: data.usage });
  } catch (e) {
    console.error('IA error:', e);
    res.status(500).json({ error: 'Erro interno: ' + e.message });
  }
});

// POST /ia/gerar-descricao-vaga — gerar descrição de vaga automaticamente
router.post('/gerar-descricao-vaga', async (req, res) => {
  const apiKey = await getApiKey(req.empresaId);
  if (!apiKey) return res.status(400).json({ error: 'Chave API nao configurada.' });
  const { cargo, departamento, salario_min, salario_max, requisitos } = req.body;

  const prompt = `Cria uma descrição profissional para uma vaga de emprego em Portugal para o cargo de "${cargo}"${departamento ? ` no departamento de ${departamento}` : ''}${salario_min ? `, com salário entre ${salario_min}€ e ${salario_max}€` : ''}.
${requisitos ? `Requisitos específicos: ${requisitos}` : ''}

A descrição deve incluir:
1. Descrição do cargo (3-4 linhas)
2. Principais responsabilidades (5-6 pontos)
3. Requisitos obrigatórios (4-5 pontos)
4. Requisitos preferenciais (3-4 pontos)
5. O que oferecemos (3-4 pontos)

Usa linguagem inclusiva e profissional. Formato em português europeu.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await response.json();
  if (data.error) return res.status(502).json({ error: 'Erro IA: ' + (data.error.message || JSON.stringify(data.error)) });
  const iaText = data.content?.[0]?.text || '';
  res.json({ descricao: iaText, requisitos: '' });
});

// POST /ia/triar-curriculo — triagem de currículo para uma vaga
router.post('/triar-curriculo', async (req, res) => {
  const apiKey = await getApiKey(req.empresaId);
  if (!apiKey) return res.status(400).json({ error: 'Chave API nao configurada.' });
  const { curriculo, vaga_titulo, vaga_requisitos } = req.body;

  const prompt = `Analisa este currículo para a vaga de "${vaga_titulo}" e dá-me:
1. Pontuação de adequação (0-100%)
2. Pontos fortes do candidato
3. Pontos fracos / lacunas
4. Recomendação: Avançar / Considerar / Rejeitar
5. Sugestões de perguntas para entrevista

${vaga_requisitos ? `Requisitos da vaga: ${vaga_requisitos}\n\n` : ''}
CURRÍCULO:
${curriculo}

Responde em português europeu, de forma estruturada e objectiva.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await response.json();
  if (data.error) return res.status(502).json({ error: 'Erro IA: ' + (data.error.message || JSON.stringify(data.error)) });
  res.json({ analise: data.content?.[0]?.text || '' });
});

// POST /ia/gerar-relatorio — gerar relatório mensal de RH
router.post('/gerar-relatorio', async (req, res) => {
  const apiKey = await getApiKey(req.empresaId);
  if (!apiKey) return res.status(400).json({ error: 'Chave API nao configurada.' });
  const { mes, ano } = req.body;

  // Recolher dados para o relatório
  const { rows: [kpis] } = await query(`
    SELECT
      COUNT(*) FILTER (WHERE estado='ativo') AS ativos,
      COUNT(*) FILTER (WHERE estado='inativo') AS inativos,
      COUNT(*) FILTER (WHERE data_admissao >= date_trunc('month', make_date($2::int, $1::int, 1))) AS novas_admissoes,
      ROUND(AVG(salario_base) FILTER (WHERE estado='ativo'), 2) AS salario_medio,
      SUM(salario_base) FILTER (WHERE estado='ativo') AS massa_salarial
    FROM funcionario WHERE empresa_id=$3
  `, [mes, ano, req.empresaId]);

  const { rows: [faltas] } = await query(`
    SELECT COUNT(*) AS total, SUM(num_dias) AS dias_total
    FROM falta f
    JOIN funcionario fu ON fu.id=f.funcionario_id
    WHERE fu.empresa_id=$1
      AND EXTRACT(MONTH FROM f.data)=$2
      AND EXTRACT(YEAR FROM f.data)=$3
  `, [req.empresaId, mes, ano]);

  const prompt = `Gera um relatório mensal de Recursos Humanos para ${mes}/${ano} em português europeu.

DADOS DO MÊS:
- Colaboradores activos: ${kpis?.ativos || 0}
- Novas admissões: ${kpis?.novas_admissoes || 0}
- Saídas: ${kpis?.inativos || 0}
- Salário médio: ${kpis?.salario_medio || 0}€
- Massa salarial: ${kpis?.massa_salarial || 0}€
- Faltas registadas: ${faltas?.total || 0} (${faltas?.dias_total || 0} dias)

O relatório deve incluir:
1. Sumário executivo (3-4 linhas)
2. Movimentos de pessoal (admissões e saídas)
3. Análise de absentismo
4. Custos com pessoal
5. Pontos de atenção e recomendações
6. Próximos passos

Tom profissional, adequado para apresentar à administração.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await response.json();
  if (data.error) return res.status(502).json({ error: 'Erro IA: ' + (data.error.message || JSON.stringify(data.error)) });
  res.json({ relatorio: data.content?.[0]?.text || '' });
});


// POST /ia/onboarding — gerar checklist de onboarding para novo funcionário
router.post('/onboarding', async (req, res) => {
  const apiKey = await getApiKey(req.empresaId);
  if (!apiKey) return res.status(400).json({ error: 'Chave API nao configurada.' });
  const { nome, cargo, departamento, data_admissao, tipo_contrato } = req.body;

  const prompt = `Cria uma checklist de onboarding completa para um novo colaborador em Portugal.

Dados:
- Nome: ${nome}
- Cargo: ${cargo}
- Departamento: ${departamento || 'Geral'}
- Data de admissão: ${data_admissao}
- Tipo de contrato: ${tipo_contrato || 'Sem termo'}

A checklist deve incluir tarefas para:
1. Antes do primeiro dia (RH)
2. Primeiro dia
3. Primeira semana
4. Primeiro mês
5. Primeiros 3 meses

Para cada tarefa indica: responsável (RH/Gestor/IT/Jurídico) e prazo.
Inclui obrigações legais portuguesas como comunicação à Segurança Social, exame médico de admissão, etc.
Formato em português europeu, prático e directo.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1500, messages: [{ role: 'user', content: prompt }] }),
  });
  const data = await response.json();
  if (data.error) return res.status(502).json({ error: 'Erro IA: ' + (data.error.message || JSON.stringify(data.error)) });
  res.json({ checklist: data.content?.[0]?.text || '' });
});

// POST /ia/risco-saida — analisar risco de saída de um colaborador
router.post('/risco-saida', async (req, res) => {
  const apiKey = await getApiKey(req.empresaId);
  if (!apiKey) return res.status(400).json({ error: 'Chave API nao configurada.' });
  const { funcionario_id } = req.body;

  const { rows: [f] } = await query(`
    SELECT f.nome_completo, f.cargo, f.data_admissao, f.salario_base,
           f.data_proxima_avaliacao,
           d.nome AS departamento,
           COUNT(fa.id) FILTER (WHERE fa.data >= CURRENT_DATE - INTERVAL '6 months') AS faltas_6meses,
           COUNT(pf.id) FILTER (WHERE pf.estado = 'aprovado') AS ferias_gozadas
    FROM funcionario f
    LEFT JOIN departamento d ON d.id = f.departamento_id
    LEFT JOIN falta fa ON fa.funcionario_id = f.id
    LEFT JOIN pedido_ferias pf ON pf.funcionario_id = f.id
    WHERE f.id = $1 AND f.empresa_id = $2
    GROUP BY f.id, d.nome
  `, [funcionario_id, req.empresaId]);

  if (!f) return res.status(404).json({ error: 'Funcionário não encontrado.' });

  const anos = Math.floor((new Date() - new Date(f.data_admissao)) / (365.25 * 24 * 3600 * 1000));

  const prompt = `Analisa o risco de saída deste colaborador com base nos dados disponíveis:

- Nome: ${f.nome_completo}
- Cargo: ${f.cargo}
- Departamento: ${f.departamento || 'N/D'}
- Anos de serviço: ${anos}
- Salário base: ${f.salario_base}€
- Faltas nos últimos 6 meses: ${f.faltas_6meses || 0}
- Férias gozadas: ${f.ferias_gozadas || 0} períodos

Avalia:
1. Nível de risco de saída (Baixo / Médio / Alto / Crítico) com justificação
2. Principais factores de risco identificados
3. Sinais de alerta
4. Recomendações concretas para reter o colaborador
5. Acções prioritárias nos próximos 30 dias

Sê objectivo e prático. Responde em português europeu.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }),
  });
  const data = await response.json();
  if (data.error) return res.status(502).json({ error: 'Erro IA: ' + (data.error.message || JSON.stringify(data.error)) });
  res.json({ analise: data.content?.[0]?.text || '', funcionario: f });
});

// POST /ia/sugerir-formacao — sugerir formações com base nas avaliações
router.post('/sugerir-formacao', async (req, res) => {
  const apiKey = await getApiKey(req.empresaId);
  if (!apiKey) return res.status(400).json({ error: 'Chave API nao configurada.' });
  const { funcionario_id } = req.body;

  const { rows: [f] } = await query(`
    SELECT f.nome_completo, f.cargo, d.nome AS departamento,
           f.formacao_horas_ano,
           COALESCE(SUM(fp.horas_completadas), 0) AS horas_feitas
    FROM funcionario f
    LEFT JOIN departamento d ON d.id = f.departamento_id
    LEFT JOIN formacao_participante fp ON fp.funcionario_id = f.id AND fp.concluido = true
    WHERE f.id = $1 AND f.empresa_id = $2
    GROUP BY f.id, d.nome
  `, [funcionario_id, req.empresaId]);

  if (!f) return res.status(404).json({ error: 'Funcionário não encontrado.' });

  const prompt = `Sugere um plano de formação para este colaborador:

- Nome: ${f.nome_completo}
- Cargo: ${f.cargo}
- Departamento: ${f.departamento || 'N/D'}
- Horas de formação obrigatória/ano: ${f.formacao_horas_ano || 40}h
- Horas já realizadas: ${f.horas_feitas || 0}h

Sugere:
1. 3-5 formações específicas e relevantes para o cargo em Portugal
2. Para cada formação: tema, duração estimada, tipo (online/presencial), e onde encontrar (plataformas gratuitas como IEFP, Coursera, etc.)
3. Plano de implementação nos próximos 6 meses
4. Como estas formações beneficiam a empresa

Foca em formações práticas e acessíveis, preferencialmente gratuitas ou de baixo custo.
Responde em português europeu.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }),
  });
  const data = await response.json();
  if (data.error) return res.status(502).json({ error: 'Erro IA: ' + (data.error.message || JSON.stringify(data.error)) });
  res.json({ sugestoes: data.content?.[0]?.text || '' });
});

// POST /ia/benchmark-salarial — comparar salário com mercado
router.post('/benchmark-salarial', async (req, res) => {
  const apiKey = await getApiKey(req.empresaId);
  if (!apiKey) return res.status(400).json({ error: 'Chave API nao configurada.' });
  const { cargo, salario_atual, localizacao, anos_experiencia, setor } = req.body;

  const prompt = `Faz uma análise de benchmark salarial para Portugal:

- Cargo: ${cargo}
- Salário actual: ${salario_atual}€/mês bruto
- Localização: ${localizacao || 'Portugal (média nacional)'}
- Anos de experiência: ${anos_experiencia || 'N/D'}
- Sector: ${setor || 'Geral'}

Com base no teu conhecimento do mercado de trabalho português, indica:
1. Faixa salarial típica para este cargo em Portugal (mínimo / médio / máximo)
2. Posicionamento do salário actual (abaixo / dentro / acima do mercado)
3. Diferenças regionais relevantes (Lisboa vs Porto vs resto do país)
4. Tendências salariais para este cargo
5. Recomendação: ajuste necessário ou não?

Nota: usa dados aproximados baseados no mercado português actual. 
Responde em português europeu.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }),
  });
  const data = await response.json();
  if (data.error) return res.status(502).json({ error: 'Erro IA: ' + (data.error.message || JSON.stringify(data.error)) });
  res.json({ benchmark: data.content?.[0]?.text || '' });
});

// POST /ia/analise-sentimento — analisar clima/sentimento da empresa
router.post('/analise-sentimento', async (req, res) => {
  const apiKey = await getApiKey(req.empresaId);
  if (!apiKey) return res.status(400).json({ error: 'Chave API nao configurada.' });
  // Recolher dados de faltas, avaliações e comunicações
  const { rows: stats } = await query(`
    SELECT
      COUNT(fa.id) FILTER (WHERE fa.data >= CURRENT_DATE - INTERVAL '3 months') AS faltas_3m,
      COUNT(fa.id) FILTER (WHERE fa.tipo = 'injustificada' AND fa.data >= CURRENT_DATE - INTERVAL '3 months') AS faltas_injust,
      COUNT(f.id) FILTER (WHERE f.estado = 'ativo') AS total_func,
      COUNT(f.id) FILTER (WHERE f.data_admissao >= CURRENT_DATE - INTERVAL '6 months') AS novas_admissoes,
      COUNT(f.id) FILTER (WHERE f.estado = 'inativo' AND f.atualizado_em >= CURRENT_DATE - INTERVAL '6 months') AS saidas
    FROM funcionario f
    LEFT JOIN falta fa ON fa.funcionario_id = f.id
    WHERE f.empresa_id = $1
  `, [req.empresaId]);

  const s = stats[0];
  const taxaAbsentismo = s.total_func > 0 ? (s.faltas_3m / s.total_func * 100).toFixed(1) : 0;
  const taxaRotatividade = s.total_func > 0 ? (s.saidas / s.total_func * 100).toFixed(1) : 0;

  const prompt = `Analisa o clima organizacional desta empresa com base nos dados disponíveis:

Dados dos últimos 3-6 meses:
- Total de colaboradores activos: ${s.total_func}
- Faltas nos últimos 3 meses: ${s.faltas_3m} (${taxaAbsentismo}% da força de trabalho)
- Faltas injustificadas: ${s.faltas_injust}
- Novas admissões (6 meses): ${s.novas_admissoes}
- Saídas (6 meses): ${s.saidas}
- Taxa de rotatividade: ${taxaRotatividade}%

Com base nestes indicadores:
1. Avaliação geral do clima organizacional (Positivo / Neutro / Preocupante / Crítico)
2. Principais indicadores de alerta
3. Pontos positivos identificados
4. Recomendações para melhorar o clima
5. Métricas a monitorizar mensalmente

Responde em português europeu, de forma construtiva e orientada para soluções.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }),
  });
  const data = await response.json();
  if (data.error) return res.status(502).json({ error: 'Erro IA: ' + (data.error.message || JSON.stringify(data.error)) });
  res.json({ analise: data.content?.[0]?.text || '', dados: s });
});

module.exports = router;
