'use strict';
const router = require('express').Router();
const { autenticar } = require('../middleware/auth');
const { query } = require('../config/database');

router.use(autenticar);

router.get('/', async (req, res) => {
  try {
    const empresaId = req.empresaId;
    const hoje = new Date();
    const mes = hoje.getMonth() + 1;
    const ano = hoje.getFullYear();
    const alertas = [];

    // Aniversários hoje
    try {
      const { rows: aniversarios } = await query(`
        SELECT id, nome_completo, cargo,
               EXTRACT(DAY FROM data_nascimento) AS dia,
               EXTRACT(MONTH FROM data_nascimento) AS mes
        FROM funcionario
        WHERE empresa_id=$1 AND estado='ativo'
          AND data_nascimento IS NOT NULL
          AND EXTRACT(MONTH FROM data_nascimento)=$2
          AND EXTRACT(DAY FROM data_nascimento)=$3
      `, [empresaId, mes, hoje.getDate()]);
      for (const f of aniversarios) {
        alertas.push({
          tipo: 'aniversario',
          icone: '🎂',
          titulo: `Aniversário — ${f.nome_completo}`,
          mensagem: `${f.cargo} faz anos hoje! 🎉`,
          prioridade: 'baixa',
          acao: 'Enviar parabéns',
          funcionario_id: f.id,
          url: `/funcionarios/${f.id}`,
        });
      }
    } catch(e) { console.warn('alertas aniversarios:', e.message); }

    // Contratos a terminar nos próximos 30 dias
    try {
      const { rows: contratos } = await query(`
        SELECT nome_completo, cargo, tipo_contrato,
               data_fim_contrato,
               (data_fim_contrato - CURRENT_DATE) AS dias_restantes
        FROM funcionario
        WHERE empresa_id=$1 AND estado='ativo'
          AND data_fim_contrato IS NOT NULL
          AND data_fim_contrato BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'
        ORDER BY data_fim_contrato
      `, [empresaId]);
      for (const c of contratos) {
        alertas.push({
          tipo: 'contrato',
          icone: '📄',
          titulo: `Contrato a terminar — ${c.nome_completo}`,
          mensagem: `${c.tipo_contrato} termina em ${c.dias_restantes} dia(s)`,
          prioridade: c.dias_restantes <= 7 ? 'critica' : 'alta',
        });
      }
    } catch(e) { console.warn('alertas contratos:', e.message); }

    // Férias pendentes
    try {
      const { rows: feriasPend } = await query(`
        SELECT pf.id, f.nome_completo, pf.data_inicio, pf.data_fim
        FROM pedido_ferias pf
        JOIN funcionario f ON f.id = pf.funcionario_id
        WHERE f.empresa_id=$1 AND pf.estado='pendente'
        ORDER BY pf.data_inicio
        LIMIT 10
      `, [empresaId]);
      for (const f of feriasPend) {
        alertas.push({
          tipo: 'ferias',
          icone: '🏖️',
          titulo: `Férias pendentes — ${f.nome_completo}`,
          mensagem: `Pedido de ${new Date(f.data_inicio).toLocaleDateString('pt-PT')} a ${new Date(f.data_fim).toLocaleDateString('pt-PT')} aguarda aprovação`,
          prioridade: 'media',
        });
      }
    } catch(e) { console.warn('alertas ferias:', e.message); }

    // Salários não processados (após dia 25)
    try {
      if (hoje.getDate() >= 25) {
        const { rows: salPend } = await query(`
          SELECT COUNT(*) AS total
          FROM funcionario f
          WHERE f.empresa_id=$1 AND f.estado='ativo'
            AND NOT EXISTS (
              SELECT 1 FROM recibo_vencimento rv
              WHERE rv.funcionario_id=f.id AND rv.mes=$2 AND rv.ano=$3
            )
        `, [empresaId, mes, ano]);
        const total = parseInt(salPend[0]?.total || 0);
        if (total > 0) {
          alertas.push({
            tipo: 'salarios',
            icone: '💰',
            titulo: `Salários por processar — ${total} colaborador(es)`,
            mensagem: `${total} colaborador(es) ainda não têm recibo processado para ${mes}/${ano}`,
            prioridade: 'alta',
          });
        }
      }
    } catch(e) { console.warn('alertas salarios:', e.message); }

    // Exames médicos a expirar
    try {
      const { rows: exames } = await query(`
        SELECT f.nome_completo, mt.data_proximo_exame,
               COALESCE(mt.tipo, mt.tipo_exame, 'Periódico') AS tipo_exame
        FROM medicina_trabalho mt
        JOIN funcionario f ON f.id = mt.funcionario_id
        WHERE f.empresa_id=$1
          AND mt.data_proximo_exame IS NOT NULL
          AND mt.data_proximo_exame BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'
        ORDER BY mt.data_proximo_exame
        LIMIT 10
      `, [empresaId]);
      for (const e of exames) {
        alertas.push({
          tipo: 'medicina',
          icone: '🏥',
          titulo: `Exame médico — ${e.nome_completo}`,
          mensagem: `${e.tipo_exame} previsto para ${new Date(e.data_proximo_exame).toLocaleDateString('pt-PT')}`,
          prioridade: 'media',
        });
      }
    } catch(e) { console.warn('alertas medicina:', e.message); }

    // Obrigações legais
    try {
      const alertasLegais = [];
      if (mes === 1) alertasLegais.push({ titulo: 'Mapa de Quadros de Pessoal', msg: 'Entregar até 15 de Fevereiro' });
      if (mes === 1) alertasLegais.push({ titulo: 'Relatório Único', msg: 'Entregar até 15 de Março' });
      if (mes === 4) alertasLegais.push({ titulo: 'Declaração Modelo 10', msg: 'Entregar até 30 de Abril' });
      for (const al of alertasLegais) {
        alertas.push({
          tipo: 'legal',
          icone: '⚖️',
          titulo: al.titulo,
          mensagem: al.msg,
          prioridade: 'alta',
        });
      }
    } catch(e) { console.warn('alertas legais:', e.message); }

    const criticos = alertas.filter(a => a.prioridade === 'critica').length;

    // Add legal alerts
    try {
      const { rows: legais } = await query(
        'SELECT * FROM alerta_legal WHERE empresa_id=$1 AND lido=false ORDER BY criado_em DESC LIMIT 5',
        [empresaId]
      );
      for (const l of legais) {
        alertas.push({
          tipo: 'legal',
          icone: '⚖️',
          titulo: l.titulo,
          mensagem: l.descricao,
          prioridade: l.impacto === 'critico' ? 'critica' : l.impacto === 'alto' ? 'alta' : 'media',
          url: l.url_fonte,
          id: l.id,
        });
      }
    } catch(e) { /* tabela pode não existir ainda */ }

    res.json({
      total: alertas.length,
      criticos,
      alertas,
    });

  } catch (err) {
    console.error('Erro em /alertas:', err);
    res.status(500).json({ error: 'Erro ao carregar alertas: ' + err.message });
  }
});

module.exports = router;
