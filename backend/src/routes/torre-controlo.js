'use strict';
/**
 * NexEdge — Torre de Controlo Logística
 * Centro de comando unificado: Logística + WMS + Frota + RH + Financeiro
 * Agentes IA, previsão de problemas, simulação What If, sustentabilidade
 * Supera: SAP Control Tower, Oracle SCM, Blue Yonder
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const Anthropic = require('@anthropic-ai/sdk');

router.use(autenticar);
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

// ── DASHBOARD PRINCIPAL DA TORRE ──

router.get('/dashboard', async (req, res) => {
  try {
    const [logistica, wms, frota, financeiro, alertas] = await Promise.all([

      // Logística em tempo real
      query(`SELECT
        COUNT(*) as total_encomendas,
        COUNT(*) FILTER (WHERE estado='em_transito') as em_transito,
        COUNT(*) FILTER (WHERE estado='em_entrega') as em_entrega,
        COUNT(*) FILTER (WHERE estado='entregue' AND DATE(actualizado_em)=CURRENT_DATE) as entregues_hoje,
        COUNT(*) FILTER (WHERE estado='problema') as problemas,
        COUNT(*) FILTER (WHERE estado NOT IN ('entregue','cancelada') AND data_entrega_prevista < NOW()) as atrasadas,
        COUNT(*) FILTER (WHERE estado='nova') as novas
        FROM logistica_encomenda WHERE empresa_id=$1`, [req.empresaId]).catch(()=>({rows:[{total_encomendas:0}]})),

      // WMS em tempo real
      query(`SELECT
        COUNT(DISTINCT s.produto_id) as produtos_em_stock,
        SUM(s.quantidade) as unidades_stock,
        SUM(s.quantidade * p.preco_custo) as valor_stock,
        COUNT(*) FILTER (WHERE a.tipo='stock_minimo' AND a.resolvido=false) as alertas_stock,
        (SELECT COUNT(*) FROM wms_ordem_picking WHERE empresa_id=$1 AND estado='pendente') as pickings_pendentes,
        (SELECT COUNT(*) FROM wms_recepcao WHERE empresa_id=$1 AND estado='aberta') as recepcoes_abertas
        FROM wms_stock s
        JOIN produto p ON p.id=s.produto_id
        LEFT JOIN wms_alerta a ON a.empresa_id=s.empresa_id
        WHERE s.empresa_id=$1`, [req.empresaId]).catch(()=>({rows:[{produtos_em_stock:0}]})),

      // Frota
      query(`SELECT
        COUNT(*) as total_motoristas,
        COUNT(*) FILTER (WHERE m.estado='disponivel') as disponiveis,
        COUNT(*) FILTER (WHERE m.estado='em_rota') as em_rota,
        COUNT(DISTINCT v.id) as total_veiculos
        FROM logistica_motorista m
        LEFT JOIN logistica_veiculo v ON v.empresa_id=m.empresa_id
        WHERE m.empresa_id=$1`, [req.empresaId]).catch(()=>({rows:[{total_motoristas:0}]})),

      // Financeiro logístico
      query(`SELECT
        COUNT(*) as faturas_pendentes,
        SUM(total) FILTER (WHERE estado IN ('emitida','enviada')) as valor_pendente,
        SUM(total) FILTER (WHERE estado='paga' AND DATE(data_emissao)=CURRENT_DATE) as recebido_hoje
        FROM fatura WHERE empresa_id=$1`, [req.empresaId]).catch(()=>({rows:[{faturas_pendentes:0}]})),

      // Alertas combinados de todos os módulos
      query(`SELECT 'logistica' as modulo, 'Encomenda atrasada' as tipo, numero as referencia, destinatario_nome as detalhe,
        EXTRACT(DAY FROM NOW()-data_entrega_prevista) as dias, 'alta' as prioridade
        FROM logistica_encomenda
        WHERE empresa_id=$1 AND estado NOT IN ('entregue','cancelada') AND data_entrega_prevista < NOW()
        UNION ALL
        SELECT 'wms', tipo, produto_id::text, mensagem, 0, prioridade
        FROM wms_alerta WHERE empresa_id=$1 AND resolvido=false
        ORDER BY prioridade DESC, dias DESC LIMIT 15`, [req.empresaId]).catch(()=>({rows:[]})),
    ]);

    // Taxa de entrega no prazo (últimos 7 dias)
    const taxaPrazo = await query(`SELECT
      ROUND(COUNT(*) FILTER (WHERE estado='entregue' AND data_entrega_real <= data_entrega_prevista)::numeric /
        NULLIF(COUNT(*) FILTER (WHERE estado='entregue'),0)*100,1) as taxa
      FROM logistica_encomenda WHERE empresa_id=$1 AND criado_em > NOW()-INTERVAL '7 days'`, [req.empresaId])
      .catch(()=>({rows:[{taxa:0}]}));

    // Evolução diária últimos 7 dias
    const evolucao = await query(`SELECT
      TO_CHAR(criado_em,'YYYY-MM-DD') as dia,
      COUNT(*) as encomendas,
      COUNT(*) FILTER (WHERE estado='entregue') as entregues
      FROM logistica_encomenda WHERE empresa_id=$1 AND criado_em > NOW()-INTERVAL '7 days'
      GROUP BY dia ORDER BY dia`, [req.empresaId]).catch(()=>({rows:[]}));

    res.json({
      timestamp: new Date().toISOString(),
      logistica: logistica.rows[0],
      wms: wms.rows[0],
      frota: frota.rows[0],
      financeiro: financeiro.rows[0],
      alertas: alertas.rows,
      taxa_prazo_7d: parseFloat(taxaPrazo.rows[0]?.taxa||0),
      evolucao_diaria: evolucao.rows,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── AGENTE IA — PLANEAMENTO AUTOMÁTICO ──

router.post('/agente/planear', async (req, res) => {
  try {
    const { data, restricoes } = req.body;
    const diaPlano = data || new Date().toISOString().slice(0,10);

    const [encomendas, motoristas, stock] = await Promise.all([
      query(`SELECT e.id, e.numero, e.destinatario_nome, e.destinatario_localidade,
        e.destinatario_pais, e.peso_kg, e.prioridade, e.data_entrega_prevista
        FROM logistica_encomenda e
        WHERE e.empresa_id=$1 AND e.estado IN ('confirmada','em_preparacao','pronta_recolha')
        ORDER BY e.prioridade DESC, e.data_entrega_prevista ASC LIMIT 30`, [req.empresaId]),
      query(`SELECT m.id, m.nome, m.pais, v.matricula, v.capacidade_kg, v.tipo
        FROM logistica_motorista m LEFT JOIN logistica_veiculo v ON v.id=m.veiculo_id
        WHERE m.empresa_id=$1 AND m.estado='disponivel'`, [req.empresaId]),
      query(`SELECT COUNT(DISTINCT produto_id) as produtos, SUM(quantidade) as unidades
        FROM wms_stock WHERE empresa_id=$1`, [req.empresaId]).catch(()=>({rows:[{produtos:0}]})),
    ]);

    if (!anthropic) {
      return res.json({
        plano: null,
        mensagem: 'Configure ANTHROPIC_API_KEY para usar o Agente de Planeamento',
        dados: { encomendas: encomendas.rows.length, motoristas: motoristas.rows.length }
      });
    }

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 2000,
      messages: [{role:'user', content:`És o Agente de Planeamento Logístico da NexEdge. Analisa os dados e cria um plano óptimo para ${diaPlano}.

ENCOMENDAS PENDENTES (${encomendas.rows.length}):
${JSON.stringify(encomendas.rows.map(e=>({num:e.numero,dest:e.destinatario_localidade,pais:e.destinatario_pais,peso:e.peso_kg,pri:e.prioridade,prazo:e.data_entrega_prevista})))}

MOTORISTAS DISPONÍVEIS (${motoristas.rows.length}):
${JSON.stringify(motoristas.rows.map(m=>({nome:m.nome,pais:m.pais,veiculo:m.matricula,cap:m.capacidade_kg})))}

RESTRIÇÕES: ${JSON.stringify(restricoes||{})}

Cria um plano de trabalho detalhado em PT-PT com:
1. Atribuição de encomendas por motorista (agrupando por zona geográfica)
2. Sequência recomendada de entregas
3. Alertas de capacidade ou prazo
4. Estimativa de horas necessárias
5. Riscos identificados e mitigações

Formato: texto estruturado, prático e accionável.`}]
    });

    // Registar execução do agente
    await query(`INSERT INTO torre_agente_log (empresa_id, agente, input_resumo, output_resumo, tokens_usados)
      VALUES ($1,'planeamento',$2,$3,$4)`,
      [req.empresaId,
       `${encomendas.rows.length} encomendas, ${motoristas.rows.length} motoristas`,
       response.content[0]?.text?.slice(0,500),
       response.usage?.input_tokens + response.usage?.output_tokens]).catch(()=>{});

    res.json({
      plano: response.content[0]?.text,
      dados: { encomendas: encomendas.rows.length, motoristas: motoristas.rows.length },
      data: diaPlano,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── AGENTE IA — DETECÇÃO E RESOLUÇÃO DE EXCEPÇÕES ──

router.post('/agente/excepcoes', async (req, res) => {
  try {
    const [atrasadas, problemas, stockCritico] = await Promise.all([
      query(`SELECT e.numero, e.destinatario_nome, e.destinatario_localidade,
        e.estado, e.data_entrega_prevista, m.nome as motorista,
        EXTRACT(DAY FROM NOW()-e.data_entrega_prevista) as dias_atraso
        FROM logistica_encomenda e LEFT JOIN logistica_motorista m ON m.id=e.motorista_id
        WHERE e.empresa_id=$1 AND e.estado NOT IN ('entregue','cancelada')
          AND e.data_entrega_prevista < NOW()
        ORDER BY dias_atraso DESC LIMIT 10`, [req.empresaId]),
      query(`SELECT * FROM wms_alerta WHERE empresa_id=$1 AND resolvido=false
        AND prioridade='alta' ORDER BY criado_em DESC LIMIT 5`, [req.empresaId]),
      query(`SELECT p.nome, SUM(s.quantidade) as stock, p.stock_minimo
        FROM wms_stock s JOIN produto p ON p.id=s.produto_id
        WHERE s.empresa_id=$1 AND p.stock_minimo > 0
        GROUP BY p.id,p.nome,p.stock_minimo HAVING SUM(s.quantidade)<=p.stock_minimo
        ORDER BY SUM(s.quantidade)/p.stock_minimo LIMIT 5`, [req.empresaId]).catch(()=>({rows:[]})),
    ]);

    if (!anthropic) {
      return res.json({
        analise: null,
        excepcoes: { atrasadas: atrasadas.rows.length, problemas: problemas.rows.length, stock_critico: stockCritico.rows.length },
        mensagem: 'Configure ANTHROPIC_API_KEY para análise IA'
      });
    }

    if (!atrasadas.rows.length && !problemas.rows.length && !stockCritico.rows.length) {
      return res.json({ analise: '✅ Nenhuma excepção crítica detectada. Operação normal.', excepcoes: { atrasadas: 0, problemas: 0, stock_critico: 0 } });
    }

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 1500,
      messages: [{role:'user', content:`És o Agente de Excepções da NexEdge. Analisa os problemas e propõe acções concretas em PT-PT.

ENCOMENDAS ATRASADAS (${atrasadas.rows.length}):
${JSON.stringify(atrasadas.rows)}

ALERTAS WMS CRÍTICOS (${problemas.rows.length}):
${JSON.stringify(problemas.rows.map(a=>a.mensagem))}

STOCK CRÍTICO (${stockCritico.rows.length}):
${JSON.stringify(stockCritico.rows)}

Para cada excepção:
1. Avalia o impacto (baixo/médio/alto/crítico)
2. Propõe acção imediata (quem faz o quê)
3. Propõe acção preventiva para evitar recorrência
4. Estima custo do problema se não resolvido

Sê directo e accionável. Prioriza por urgência.`}]
    });

    res.json({
      analise: response.content[0]?.text,
      excepcoes: {
        atrasadas: atrasadas.rows.length,
        problemas: problemas.rows.length,
        stock_critico: stockCritico.rows.length,
        detalhes: { atrasadas: atrasadas.rows, problemas: problemas.rows, stock: stockCritico.rows }
      }
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SIMULADOR "WHAT IF?" ──

router.post('/simular', async (req, res) => {
  try {
    const { cenario, parametros } = req.body;
    // cenarios: 'aumento_volume' | 'fechar_armazem' | 'perda_motoristas' | 'greve' | 'pico_sazonal' | 'novo_pais'

    const [baseLogistica, baseWMS, baseRotas] = await Promise.all([
      query(`SELECT COUNT(*) as encomendas_mes,
        AVG(EXTRACT(EPOCH FROM (data_entrega_real-criado_em))/3600) as tempo_medio_h,
        COUNT(*) FILTER (WHERE data_entrega_real <= data_entrega_prevista)::float/NULLIF(COUNT(*) FILTER (WHERE estado='entregue'),0)*100 as taxa_prazo
        FROM logistica_encomenda WHERE empresa_id=$1 AND criado_em > NOW()-INTERVAL '30 days'`, [req.empresaId]),
      query(`SELECT COUNT(DISTINCT produto_id) as produtos, SUM(quantidade*p.preco_custo) as valor_stock,
        COUNT(*) FILTER (WHERE l.ocupada) as locs_ocupadas, COUNT(*) as total_locs
        FROM wms_stock s JOIN produto p ON p.id=s.produto_id
        LEFT JOIN wms_localizacao l ON l.id=s.localizacao_id WHERE s.empresa_id=$1`, [req.empresaId]),
      query(`SELECT COUNT(*) as motoristas_disponiveis,
        COUNT(v.id) as veiculos, SUM(v.capacidade_kg) as capacidade_total_kg
        FROM logistica_motorista m LEFT JOIN logistica_veiculo v ON v.id=m.veiculo_id
        WHERE m.empresa_id=$1 AND m.estado='disponivel'`, [req.empresaId]),
    ]);

    if (!anthropic) {
      return res.json({ simulacao: null, mensagem: 'Configure ANTHROPIC_API_KEY para simulações' });
    }

    const cenarioTexto = {
      aumento_volume: `Aumento de ${parametros?.percentagem||40}% no volume de encomendas`,
      fechar_armazem: `Encerramento do armazém principal por ${parametros?.dias||7} dias`,
      perda_motoristas: `Perda de ${parametros?.percentagem||30}% dos motoristas`,
      greve: `Greve de transportadoras externas por ${parametros?.dias||3} dias`,
      pico_sazonal: `Pico sazonal (Black Friday / Natal) — aumento de ${parametros?.percentagem||200}%`,
      novo_pais: `Expansão para novo mercado: ${parametros?.pais||'Itália'}`,
    }[cenario] || `Cenário personalizado: ${cenario}`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 2000,
      messages: [{role:'user', content:`És o Simulador de Cenários da NexEdge. Simula o impacto do seguinte cenário na operação logística.

CENÁRIO: ${cenarioTexto}
PARÂMETROS: ${JSON.stringify(parametros||{})}

DADOS ACTUAIS DA EMPRESA:
- Encomendas/mês: ${baseLogistica.rows[0]?.encomendas_mes||0}
- Taxa entrega no prazo: ${parseFloat(baseLogistica.rows[0]?.taxa_prazo||0).toFixed(1)}%
- Tempo médio entrega: ${parseFloat(baseLogistica.rows[0]?.tempo_medio_h||0).toFixed(1)}h
- Motoristas disponíveis: ${baseRotas.rows[0]?.motoristas_disponiveis||0}
- Capacidade frota: ${baseRotas.rows[0]?.capacidade_total_kg||0}kg
- Produtos em stock: ${baseWMS.rows[0]?.produtos||0}
- Valor stock: ${parseFloat(baseWMS.rows[0]?.valor_stock||0).toFixed(0)}€
- Ocupação armazém: ${baseWMS.rows[0]?.total_locs>0?Math.round(baseWMS.rows[0].locs_ocupadas/baseWMS.rows[0].total_locs*100):0}%

Simula em PT-PT:
1. **Impacto Imediato** — o que acontece nas primeiras 24-48h
2. **Impacto Operacional** — efeito em entregas, SLA, capacidade
3. **Impacto Financeiro** — custos adicionais estimados, receita em risco
4. **Recursos Necessários** — motoristas, veículos, espaço, pessoal extra
5. **Plano de Contingência** — 5 acções concretas para mitigar
6. **Indicadores de Alerta** — o que monitorizar durante o cenário
7. **Recomendação** — go/no-go e quando activar o plano

Sê específico com números e timelines.`}]
    });

    res.json({
      cenario: cenarioTexto,
      parametros,
      simulacao: response.content[0]?.text,
      dados_base: {
        logistica: baseLogistica.rows[0],
        wms: baseWMS.rows[0],
        frota: baseRotas.rows[0],
      }
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PROFITABILITY ENGINE ──

router.get('/rentabilidade', async (req, res) => {
  try {
    const { periodo = 30, agrupar = 'cliente' } = req.query;

    let sql;
    if (agrupar === 'cliente') {
      sql = `SELECT c.nome as dimensao, c.id as dimensao_id,
        COUNT(e.id) as encomendas,
        SUM(f.total) as receita,
        SUM(e.peso_kg * 0.5 + 5) as custo_estimado_frete,
        SUM(f.total) - SUM(e.peso_kg * 0.5 + 5) as margem,
        ROUND((SUM(f.total) - SUM(e.peso_kg * 0.5 + 5)) / NULLIF(SUM(f.total),0) * 100, 1) as margem_pct
        FROM logistica_encomenda e
        LEFT JOIN cliente c ON c.id=e.cliente_id
        LEFT JOIN fatura f ON f.cliente_id=e.cliente_id AND DATE(f.data_emissao)=DATE(e.criado_em)
        WHERE e.empresa_id=$1 AND e.criado_em > NOW()-($2::int * INTERVAL '1 day') AND e.estado='entregue'
        GROUP BY c.id,c.nome ORDER BY receita DESC NULLS LAST LIMIT 10`;
    } else if (agrupar === 'pais') {
      sql = `SELECT destinatario_pais as dimensao, destinatario_pais as dimensao_id,
        COUNT(*) as encomendas,
        SUM(peso_kg * 0.5 + CASE destinatario_pais WHEN 'CH' THEN 25 WHEN 'FR' THEN 15 WHEN 'DE' THEN 18 WHEN 'ES' THEN 12 ELSE 5 END) as custo_estimado_frete,
        COUNT(*) * 50 as receita_estimada,
        COUNT(*) * 50 - SUM(peso_kg * 0.5 + CASE destinatario_pais WHEN 'CH' THEN 25 WHEN 'FR' THEN 15 WHEN 'DE' THEN 18 WHEN 'ES' THEN 12 ELSE 5 END) as margem,
        NULL as margem_pct
        FROM logistica_encomenda WHERE empresa_id=$1 AND estado='entregue'
          AND criado_em > NOW()-($2::int * INTERVAL '1 day')
        GROUP BY destinatario_pais ORDER BY encomendas DESC`;
    } else {
      sql = `SELECT m.nome as dimensao, m.id as dimensao_id,
        COUNT(e.id) as encomendas,
        SUM(e.peso_kg * 0.5 + 5) as custo_estimado_frete,
        COUNT(e.id) * 50 as receita_estimada,
        COUNT(e.id) * 50 - SUM(e.peso_kg * 0.5 + 5) as margem,
        ROUND((COUNT(e.id) * 50 - SUM(e.peso_kg * 0.5 + 5)) / NULLIF(COUNT(e.id) * 50, 0) * 100, 1) as margem_pct
        FROM logistica_encomenda e JOIN logistica_motorista m ON m.id=e.motorista_id
        WHERE e.empresa_id=$1 AND e.estado='entregue' AND e.criado_em > NOW()-($2::int * INTERVAL '1 day')
        GROUP BY m.id,m.nome ORDER BY margem DESC LIMIT 10`;
    }

    const r = await query(sql, [req.empresaId, periodo]).catch(()=>({rows:[]}));

    // Análise IA da rentabilidade
    let analise_ia = null;
    if (anthropic && r.rows.length) {
      try {
        const resp = await anthropic.messages.create({
          model: 'claude-sonnet-4-6', max_tokens: 600,
          messages: [{role:'user', content:`Analisa estes dados de rentabilidade logística em PT-PT (máx 150 palavras):
Dimensão: ${agrupar}
Dados: ${JSON.stringify(r.rows.slice(0,5))}
Identifica padrões, outliers e 3 recomendações concretas para melhorar a margem.`}]
        });
        analise_ia = resp.content[0]?.text;
      } catch(e) {}
    }

    res.json({ periodo_dias: periodo, agrupar, dados: r.rows, analise_ia });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── RISK ENGINE ──

router.get('/riscos', async (req, res) => {
  try {
    const riscos = [];

    // Risco 1: Encomendas em risco de SLA
    const slaRisco = await query(`SELECT COUNT(*) as total,
      SUM(CASE WHEN EXTRACT(HOUR FROM data_entrega_prevista - NOW()) < 2 THEN 1 ELSE 0 END) as critico,
      SUM(CASE WHEN EXTRACT(HOUR FROM data_entrega_prevista - NOW()) BETWEEN 2 AND 6 THEN 1 ELSE 0 END) as alto
      FROM logistica_encomenda WHERE empresa_id=$1
        AND estado IN ('em_transito','em_entrega')
        AND data_entrega_prevista IS NOT NULL
        AND data_entrega_prevista > NOW()`, [req.empresaId]).catch(()=>({rows:[{total:0}]}));

    if (parseInt(slaRisco.rows[0]?.critico||0) > 0) {
      riscos.push({ tipo:'sla_breach', prioridade:'critica', titulo:`${slaRisco.rows[0].critico} entrega(s) a menos de 2h do prazo`, impacto:'Penalizações de SLA, insatisfação cliente', acao:'Contactar motoristas imediatamente' });
    }

    // Risco 2: Stock crítico
    const stockRisco = await query(`SELECT COUNT(*) as total FROM wms_alerta WHERE empresa_id=$1 AND tipo='stock_minimo' AND resolvido=false`, [req.empresaId]).catch(()=>({rows:[{total:0}]}));
    if (parseInt(stockRisco.rows[0]?.total||0) > 0) {
      riscos.push({ tipo:'stock_critico', prioridade:'alta', titulo:`${stockRisco.rows[0].total} produto(s) abaixo do stock mínimo`, impacto:'Impossibilidade de cumprir encomendas', acao:'Criar pedidos de compra urgentes' });
    }

    // Risco 3: Sem motoristas disponíveis
    const motoristasLivres = await query(`SELECT COUNT(*) as total FROM logistica_motorista WHERE empresa_id=$1 AND estado='disponivel'`, [req.empresaId]).catch(()=>({rows:[{total:0}]}));
    const encomendasPendentes = await query(`SELECT COUNT(*) as total FROM logistica_encomenda WHERE empresa_id=$1 AND estado IN ('confirmada','pronta_recolha') AND motorista_id IS NULL`, [req.empresaId]).catch(()=>({rows:[{total:0}]}));

    if (parseInt(encomendasPendentes.rows[0]?.total||0) > 0 && parseInt(motoristasLivres.rows[0]?.total||0) === 0) {
      riscos.push({ tipo:'sem_recursos', prioridade:'alta', titulo:`${encomendasPendentes.rows[0].total} encomenda(s) sem motorista atribuído`, impacto:'Atrasos em entregas confirmadas', acao:'Contactar transportadoras externas ou redistribuir rotas' });
    }

    // Risco 4: Produtos a vencer
    const validades = await query(`SELECT COUNT(DISTINCT produto_id) as total FROM wms_stock WHERE empresa_id=$1 AND data_validade IS NOT NULL AND data_validade BETWEEN NOW() AND NOW()+INTERVAL '7 days' AND quantidade>0`, [req.empresaId]).catch(()=>({rows:[{total:0}]}));
    if (parseInt(validades.rows[0]?.total||0) > 0) {
      riscos.push({ tipo:'validade_proxima', prioridade:'media', titulo:`${validades.rows[0].total} produto(s) a vencer em 7 dias`, impacto:'Perda de stock e custo de eliminação', acao:'Priorizar expedição destes produtos (FEFO)' });
    }

    // Score de risco global
    const scoreMap = { critica: 40, alta: 20, media: 10, baixa: 5 };
    const scoreTotal = riscos.reduce((s,r) => s + (scoreMap[r.prioridade]||0), 0);
    const nivelRisco = scoreTotal >= 60 ? 'critico' : scoreTotal >= 30 ? 'alto' : scoreTotal >= 10 ? 'medio' : 'baixo';

    res.json({ riscos, score: scoreTotal, nivel: nivelRisco, timestamp: new Date().toISOString() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SUSTAINABILITY ENGINE ──

router.get('/sustentabilidade', async (req, res) => {
  try {
    const { periodo = 30 } = req.query;

    // Factor de emissão CO2 por tipo de veículo (kg CO2/km)
    const EMISSAO = { moto: 0.08, carro: 0.15, furgao: 0.22, camiao_pequeno: 0.30, camiao: 0.55 };
    const DISTANCIA_MEDIA = { PT: 50, CH: 80, FR: 120, DE: 150, ES: 100 };

    const encomendas = await query(`SELECT e.destinatario_pais, e.peso_kg, v.tipo as veiculo_tipo, COUNT(*) as total
      FROM logistica_encomenda e
      LEFT JOIN logistica_motorista m ON m.id=e.motorista_id
      LEFT JOIN logistica_veiculo v ON v.id=m.veiculo_id
      WHERE e.empresa_id=$1 AND e.estado='entregue' AND e.criado_em > NOW()-($2::int * INTERVAL '1 day')
      GROUP BY e.destinatario_pais, e.peso_kg, v.tipo`, [req.empresaId, periodo]).catch(()=>({rows:[]}));

    let co2Total = 0;
    const co2PorPais = {};

    for (const e of encomendas.rows) {
      const distancia = DISTANCIA_MEDIA[e.destinatario_pais] || 60;
      const emissao = EMISSAO[e.veiculo_tipo] || 0.22;
      const co2 = distancia * emissao * parseInt(e.total);
      co2Total += co2;
      co2PorPais[e.destinatario_pais] = (co2PorPais[e.destinatario_pais]||0) + co2;
    }

    // Análise IA de sustentabilidade
    let recomendacoes = null;
    if (anthropic) {
      try {
        const resp = await anthropic.messages.create({
          model: 'claude-sonnet-4-6', max_tokens: 600,
          messages: [{role:'user', content:`Analisa o impacto ambiental desta operação logística e dá recomendações práticas em PT-PT:
CO2 total (${periodo} dias): ${co2Total.toFixed(0)}kg
Por país: ${JSON.stringify(co2PorPais)}
Dá 5 recomendações específicas para reduzir emissões mantendo eficiência operacional.`}]
        });
        recomendacoes = resp.content[0]?.text;
      } catch(e) {}
    }

    res.json({
      periodo_dias: periodo,
      co2_total_kg: Math.round(co2Total),
      co2_por_pais: co2PorPais,
      equivalente_arvores: Math.round(co2Total / 22), // 1 árvore absorve ~22kg CO2/ano
      equivalente_km_carro: Math.round(co2Total / 0.15),
      recomendacoes_ia: recomendacoes,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── HISTÓRICO DE AGENTES ──

router.get('/agentes/log', async (req, res) => {
  try {
    const r = await query(`SELECT * FROM torre_agente_log WHERE empresa_id=$1 ORDER BY criado_em DESC LIMIT 20`, [req.empresaId]).catch(()=>({rows:[]}));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
