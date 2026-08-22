'use strict';
/**
 * NexEdge — Automações Avançadas
 * Atribuição automática motoristas, faturação pós-POD,
 * reposição stock, relatório semanal, alertas preditivos
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const Anthropic = require('@anthropic-ai/sdk');

router.use(autenticar);
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

// ── ATRIBUIÇÃO AUTOMÁTICA DE MOTORISTAS ──

router.post('/atribuir-motoristas', async (req, res) => {
  try {
    const { data } = req.body;
    const dia = data || new Date().toISOString().slice(0,10);

    // Encomendas sem motorista
    const semMotorista = await query(`SELECT e.id, e.numero, e.destinatario_pais, e.peso_kg, e.prioridade, e.data_entrega_prevista
      FROM logistica_encomenda e WHERE e.empresa_id=$1 AND e.motorista_id IS NULL AND e.estado IN ('confirmada','em_preparacao','pronta_recolha')
      ORDER BY e.prioridade DESC, e.data_entrega_prevista ASC`, [req.empresaId]);

    // Motoristas disponíveis com veículos
    const motoristas = await query(`SELECT m.id, m.nome, m.pais, v.capacidade_kg, v.tipo,
      (SELECT SUM(peso_kg) FROM logistica_encomenda WHERE motorista_id=m.id AND estado NOT IN ('entregue','cancelada')) as carga_actual
      FROM logistica_motorista m LEFT JOIN logistica_veiculo v ON v.id=m.veiculo_id
      WHERE m.empresa_id=$1 AND m.estado='disponivel'`, [req.empresaId]);

    if (!semMotorista.rows.length) return res.json({ atribuidas: 0, mensagem: 'Todas as encomendas têm motorista' });
    if (!motoristas.rows.length) return res.json({ atribuidas: 0, mensagem: 'Sem motoristas disponíveis' });

    let atribuidas = 0;
    const log = [];

    for (const enc of semMotorista.rows) {
      // Encontrar melhor motorista: mesmo país, com capacidade livre
      const melhor = motoristas.rows.find(m =>
        (m.pais === enc.destinatario_pais || !m.pais) &&
        (parseFloat(m.capacidade_kg||1000) - parseFloat(m.carga_actual||0)) >= parseFloat(enc.peso_kg||0)
      ) || motoristas.rows[0]; // fallback: qualquer motorista disponível

      if (melhor) {
        await query(`UPDATE logistica_encomenda SET motorista_id=$1, actualizado_em=NOW() WHERE id=$2`, [melhor.id, enc.id]);
        // Actualizar carga do motorista no array local
        const idx = motoristas.rows.findIndex(m=>m.id===melhor.id);
        if (idx>=0) motoristas.rows[idx].carga_actual = (parseFloat(motoristas.rows[idx].carga_actual||0) + parseFloat(enc.peso_kg||0)).toString();

        await query(`INSERT INTO logistica_historico (encomenda_id, empresa_id, estado, notas) VALUES ($1,$2,NULL,'Motorista atribuído automaticamente: '+$3)`,
          [enc.id, req.empresaId, melhor.nome]).catch(()=>{});

        log.push({ encomenda: enc.numero, motorista: melhor.nome });
        atribuidas++;
      }
    }

    res.json({ atribuidas, total_sem_motorista: semMotorista.rows.length, log });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── FATURAÇÃO AUTOMÁTICA PÓS-POD ──

router.post('/faturar-pos-pod', async (req, res) => {
  try {
    // Buscar encomendas entregues nas últimas 24h sem fatura
    const entregues = await query(`
      SELECT e.*, c.id as cliente_id_fat, c.nome as cliente_nome, c.email as cliente_email
      FROM logistica_encomenda e
      LEFT JOIN cliente c ON c.id=e.cliente_id
      LEFT JOIN logistica_pod pod ON pod.encomenda_id=e.id
      WHERE e.empresa_id=$1 AND e.estado='entregue' AND pod.id IS NOT NULL
        AND e.data_entrega_real > NOW()-INTERVAL '24 hours'
        AND NOT EXISTS (SELECT 1 FROM fatura f WHERE f.origem='logistica' AND f.descricao LIKE '%'||e.numero||'%')
        AND c.id IS NOT NULL
    `, [req.empresaId]);

    let faturadas = 0;
    for (const enc of entregues.rows) {
      const paises = {PT:5,CH:25,FR:15,DE:18,ES:12};
      const valorFrete = (paises[enc.destinatario_pais]||10) + parseFloat(enc.peso_kg||0)*0.5;

      const ano = new Date().getFullYear();
      const count = await query(`SELECT COUNT(*) FROM fatura WHERE empresa_id=$1 AND EXTRACT(YEAR FROM data_emissao)=$2`, [req.empresaId, ano]);
      const seq = (parseInt(count.rows[0].count)+1).toString().padStart(6,'0');

      await query(`INSERT INTO fatura (empresa_id, numero, cliente_id, data_emissao, data_vencimento, total, estado, descricao, origem)
        VALUES ($1,$2,$3,NOW(),NOW()+INTERVAL '30 days',$4,'emitida',$5,'logistica')`,
        [req.empresaId, `FT${ano}/${seq}`, enc.cliente_id_fat, valorFrete,
         `Frete encomenda ${enc.numero} — ${enc.destinatario_localidade}, ${enc.destinatario_pais}`]);

      faturadas++;
    }

    res.json({ faturadas, pendentes: entregues.rows.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── REPOSIÇÃO AUTOMÁTICA DE STOCK ──

router.post('/repor-stock', async (req, res) => {
  try {
    const abaixoMinimo = await query(`
      SELECT p.id, p.nome, p.referencia, p.stock_minimo, SUM(s.quantidade) as stock_actual,
        p.stock_minimo * 2 as quantidade_repor
      FROM wms_stock s JOIN produto p ON p.id=s.produto_id
      WHERE s.empresa_id=$1 AND p.stock_minimo > 0
      GROUP BY p.id,p.nome,p.referencia,p.stock_minimo
      HAVING SUM(s.quantidade) <= p.stock_minimo
        AND NOT EXISTS (SELECT 1 FROM pedido_compra_linha pcl JOIN pedido_compra pc ON pc.id=pcl.pedido_id
          WHERE pcl.produto_id=p.id AND pc.estado NOT IN ('recebido','cancelado') AND pc.empresa_id=$1)
    `, [req.empresaId]).catch(()=>({rows:[]}));

    let criados = 0;
    for (const p of abaixoMinimo.rows) {
      // Criar pedido de compra automático
      const ano = new Date().getFullYear();
      const count = await query(`SELECT COUNT(*) FROM pedido_compra WHERE empresa_id=$1 AND EXTRACT(YEAR FROM criado_em)=$2`, [req.empresaId, ano]).catch(()=>({rows:[{count:0}]}));
      const num = `PC-${ano}-${(parseInt(count.rows[0].count)+1).toString().padStart(5,'0')}`;

      const pc = await query(`INSERT INTO pedido_compra (empresa_id, numero, descricao, estado, criado_em)
        VALUES ($1,$2,$3,'rascunho',NOW()) RETURNING id`,
        [req.empresaId, num, `Reposição automática — stock abaixo mínimo`]).catch(()=>({rows:[]}));

      if (pc.rows.length) {
        await query(`INSERT INTO pedido_compra_linha (pedido_id, produto_id, quantidade, unidade)
          VALUES ($1,$2,$3,'UN')`,
          [pc.rows[0].id, p.id, p.quantidade_repor]).catch(()=>{});

        // Resolver alerta
        await query(`UPDATE wms_alerta SET resolvido=true, resolvido_em=NOW() WHERE empresa_id=$1 AND produto_id=$2 AND tipo='stock_minimo'`,
          [req.empresaId, p.id]).catch(()=>{});

        // Notificar responsável de compras
        await query(`INSERT INTO notificacao (utilizador_id, titulo, mensagem, tipo)
          SELECT id, $1, $2, 'compras' FROM utilizador WHERE empresa_id=$3 AND perfil IN ('admin_empresa','compras') LIMIT 1`,
          [`📦 Pedido de compra automático: ${num}`,
           `Stock de "${p.nome}" abaixo do mínimo. Pedido ${num} criado automaticamente.`,
           req.empresaId]).catch(()=>{});

        criados++;
      }
    }

    res.json({ pedidos_criados: criados, produtos_abaixo_minimo: abaixoMinimo.rows.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ALERTAS PREDITIVOS ──

router.get('/alertas-preditivos', async (req, res) => {
  try {
    const alertas = [];

    // Prever atrasos baseado em padrões históricos
    const emTransito = await query(`
      SELECT e.id, e.numero, e.destinatario_nome, e.destinatario_pais,
        e.data_entrega_prevista, e.estado, m.nome as motorista,
        EXTRACT(HOUR FROM e.data_entrega_prevista - NOW()) as horas_restantes,
        (SELECT AVG(EXTRACT(EPOCH FROM (data_entrega_real-data_entrega_prevista))/3600)
          FROM logistica_encomenda h WHERE h.empresa_id=e.empresa_id
            AND h.destinatario_pais=e.destinatario_pais AND h.estado='entregue'
            AND h.data_entrega_real > NOW()-INTERVAL '30 days') as atraso_medio_historico_h
      FROM logistica_encomenda e
      LEFT JOIN logistica_motorista m ON m.id=e.motorista_id
      WHERE e.empresa_id=$1 AND e.estado IN ('em_transito','em_entrega')
        AND e.data_entrega_prevista IS NOT NULL
    `, [req.empresaId]).catch(()=>({rows:[]}));

    for (const e of emTransito.rows) {
      const horasRestantes = parseFloat(e.horas_restantes||0);
      const atrasoMedio = parseFloat(e.atraso_medio_historico_h||0);

      let probAtraso = 0;
      if (atrasoMedio > 0 && horasRestantes < atrasoMedio * 2) probAtraso = Math.min(95, Math.round(atrasoMedio/horasRestantes*50));
      else if (horasRestantes < 1) probAtraso = 85;
      else if (horasRestantes < 2) probAtraso = 60;

      if (probAtraso >= 50) {
        alertas.push({
          tipo: 'atraso_previsto',
          encomenda: e.numero,
          destinatario: e.destinatario_nome,
          pais: e.destinatario_pais,
          motorista: e.motorista||'—',
          horas_restantes: Math.round(horasRestantes),
          probabilidade_atraso: probAtraso,
          recomendacao: probAtraso >= 80
            ? 'Contactar motorista imediatamente e notificar cliente'
            : 'Monitorizar de perto — risco moderado de atraso',
          prioridade: probAtraso >= 80 ? 'critica' : 'alta',
        });
      }
    }

    // Stock vai esgotar em X dias (baseado em velocidade de saída)
    const stockVelocidade = await query(`
      SELECT p.nome, p.id as produto_id, SUM(s.quantidade) as stock_actual,
        (SELECT SUM(ABS(m.quantidade))/30.0 FROM wms_movimento m WHERE m.produto_id=p.id AND m.empresa_id=$1
          AND m.tipo IN ('picking','expedicao') AND m.criado_em > NOW()-INTERVAL '30 days') as saida_diaria
      FROM wms_stock s JOIN produto p ON p.id=s.produto_id
      WHERE s.empresa_id=$1 GROUP BY p.id,p.nome HAVING SUM(s.quantidade)>0
    `, [req.empresaId]).catch(()=>({rows:[]}));

    for (const s of stockVelocidade.rows) {
      const saidaDiaria = parseFloat(s.saida_diaria||0);
      if (saidaDiaria > 0) {
        const diasRestantes = Math.round(parseFloat(s.stock_actual)/saidaDiaria);
        if (diasRestantes <= 7 && diasRestantes > 0) {
          alertas.push({
            tipo: 'stock_esgota',
            produto: s.nome,
            stock_actual: parseFloat(s.stock_actual),
            saida_diaria: Math.round(saidaDiaria*10)/10,
            dias_restantes: diasRestantes,
            probabilidade_rutura: Math.min(95, Math.round((7-diasRestantes)/7*100)+50),
            recomendacao: `Encomendar stock urgente — esgota em ~${diasRestantes} dias`,
            prioridade: diasRestantes <= 3 ? 'critica' : 'alta',
          });
        }
      }
    }

    alertas.sort((a,b) => (b.probabilidade_atraso||b.probabilidade_rutura||0) - (a.probabilidade_atraso||a.probabilidade_rutura||0));

    res.json({ alertas, timestamp: new Date().toISOString(), total: alertas.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SIMULADOR DE PREÇOS DE FRETE ──

router.post('/simular-frete', async (req, res) => {
  try {
    const { origem_pais, destino_pais, peso_kg, volume_m3, urgente } = req.body;

    const tarifasBase = {
      PT: { PT:5, CH:45, FR:25, DE:35, ES:20 },
      CH: { CH:15, PT:45, FR:30, DE:25, ES:40 },
      FR: { FR:8, PT:25, CH:30, DE:20, ES:15 },
      DE: { DE:8, PT:35, CH:25, FR:20, ES:28 },
      ES: { ES:6, PT:20, CH:40, FR:15, DE:28 },
    };

    const origem = origem_pais || 'PT';
    const destino = destino_pais || 'PT';
    const tarifaBase = (tarifasBase[origem]?.[destino]) || 20;

    // Calcular peso taxável (maior entre peso real e volume)
    const pesoVolumetrico = (volume_m3||0) * 250; // 1m³ = 250kg equivalente
    const pesoTaxavel = Math.max(parseFloat(peso_kg||0), pesoVolumetrico);

    const custoBase = tarifaBase + (pesoTaxavel * 0.5);
    const suplementoUrgente = urgente ? custoBase * 0.4 : 0;
    const total = Math.round((custoBase + suplementoUrgente) * 100) / 100;

    // Prazo estimado
    const prazos = {
      'PT-PT':1,'PT-ES':2,'PT-FR':3,'PT-DE':4,'PT-CH':3,
      'CH-CH':1,'CH-DE':1,'CH-FR':2,'CH-PT':3,'CH-ES':3,
    };
    const prazoKey = `${origem}-${destino}`;
    const prazo = urgente ? 1 : (prazos[prazoKey] || 5);

    res.json({
      origem_pais: origem,
      destino_pais: destino,
      peso_real_kg: peso_kg||0,
      volume_m3: volume_m3||0,
      peso_taxavel_kg: pesoTaxavel,
      urgente: !!urgente,
      preco: {
        base: Math.round(custoBase*100)/100,
        suplemento_urgente: Math.round(suplementoUrgente*100)/100,
        total,
        moeda: origem==='CH'||destino==='CH' ? 'CHF' : 'EUR',
      },
      prazo_dias: prazo,
      opcoes: [
        { servico:'Standard', preco: total, dias: prazo },
        { servico:'Expresso', preco: Math.round(total*1.4*100)/100, dias: Math.max(1,prazo-1) },
        { servico:'Económico', preco: Math.round(total*0.75*100)/100, dias: prazo+2 },
      ]
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── RELATÓRIO EXECUTIVO ──

router.post('/relatorio-executivo', async (req, res) => {
  try {
    const { enviar_email } = req.body;

    const [kpisLog, kpisRH, kpisFin, kpisWMS, topAlerts] = await Promise.all([
      query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE estado='entregue' AND actualizado_em > NOW()-INTERVAL '7 days') as entregues_semana, COUNT(*) FILTER (WHERE estado='problema') as problemas FROM logistica_encomenda WHERE empresa_id=$1`, [req.empresaId]).catch(()=>({rows:[{}]})),
      query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE estado='ativo') as ativos FROM funcionario WHERE empresa_id=$1`, [req.empresaId]).catch(()=>({rows:[{}]})),
      query(`SELECT SUM(total) FILTER (WHERE estado='paga' AND data_emissao > NOW()-INTERVAL '7 days') as recebido_semana, COUNT(*) FILTER (WHERE estado='emitida') as faturas_pendentes FROM fatura WHERE empresa_id=$1`, [req.empresaId]).catch(()=>({rows:[{}]})),
      query(`SELECT COUNT(DISTINCT produto_id) as produtos, SUM(quantidade*p.preco_custo) as valor FROM wms_stock s JOIN produto p ON p.id=s.produto_id WHERE s.empresa_id=$1`, [req.empresaId]).catch(()=>({rows:[{}]})),
      query(`SELECT tipo, mensagem FROM wms_alerta WHERE empresa_id=$1 AND resolvido=false ORDER BY prioridade DESC LIMIT 5`, [req.empresaId]).catch(()=>({rows:[]})),
    ]);

    let analise_ia = '';
    if (anthropic) {
      const r = await anthropic.messages.create({
        model:'claude-sonnet-4-6', max_tokens:800,
        messages:[{role:'user',content:`Cria um relatório executivo semanal em PT-PT (máx 300 palavras) com base nestes dados:
Logística: ${JSON.stringify(kpisLog.rows[0])}
RH: ${JSON.stringify(kpisRH.rows[0])}
Financeiro: ${JSON.stringify(kpisFin.rows[0])}
WMS: ${JSON.stringify(kpisWMS.rows[0])}
Alertas: ${JSON.stringify(topAlerts.rows)}
Inclui: resumo da semana, pontos positivos, alertas e 3 recomendações prioritárias.`}]
      }).catch(()=>({content:[{text:'Erro ao gerar análise IA'}]}));
      analise_ia = r.content[0]?.text;
    }

    const relatorio = {
      gerado_em: new Date().toISOString(),
      periodo: 'Última semana',
      kpis: {
        logistica: kpisLog.rows[0],
        rh: kpisRH.rows[0],
        financeiro: kpisFin.rows[0],
        wms: kpisWMS.rows[0],
      },
      alertas: topAlerts.rows,
      analise_ia,
    };

    if (enviar_email) {
      const empresa = await query(`SELECT e.nome, u.email FROM empresa e JOIN utilizador u ON u.empresa_id=e.id WHERE e.id=$1 AND u.perfil='admin_empresa' LIMIT 1`, [req.empresaId]).catch(()=>({rows:[]}));
      if (empresa.rows.length) {
        const { enviarEmail } = require('../services/emailService');
        await enviarEmail({
          to: empresa.rows[0].email,
          subject: `📊 Relatório Executivo NexEdge — ${new Date().toLocaleDateString('pt-PT')}`,
          html: `<div style="font-family:Inter,sans-serif;max-width:600px">
            <h2>📊 Relatório Executivo Semanal</h2>
            <p>${analise_ia?.replace(/\n/g,'<br>')}</p>
            <hr/>
            <p style="color:#6b7280;font-size:12px">NexEdge ERP — Relatório automático</p>
          </div>`
        }).catch(()=>{});
      }
    }

    res.json(relatorio);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
