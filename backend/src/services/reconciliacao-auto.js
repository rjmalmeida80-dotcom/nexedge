'use strict';
/**
 * NexEdge — Reconciliação Bancária Automática
 * Match automático entre movimentos bancários e facturas/despesas
 * Algoritmo: valor exacto + data próxima + referência
 */

const { query, transaction } = require('../config/database');

const JANELA_DIAS = 15; // dias de tolerância na data
const SCORE_MINIMO = 70; // score mínimo para match automático (0-100)

/**
 * Calcular score de match entre movimento e documento
 */
function calcularScore(movimento, documento) {
  let score = 0;

  // 1. Valor exacto (40 pontos)
  const valorMov = Math.abs(parseFloat(movimento.valor));
  const valorDoc = parseFloat(documento.total || documento.valor_total || 0);
  if (Math.abs(valorMov - valorDoc) < 0.01) score += 40;
  else if (Math.abs(valorMov - valorDoc) / valorDoc < 0.02) score += 20; // 2% tolerância

  // 2. Data próxima (30 pontos)
  const dataMov = new Date(movimento.data);
  const dataDoc = new Date(documento.data_emissao || documento.data_despesa || documento.data);
  const difDias = Math.abs((dataMov - dataDoc) / (1000*60*60*24));
  if (difDias === 0) score += 30;
  else if (difDias <= 3) score += 25;
  else if (difDias <= 7) score += 15;
  else if (difDias <= JANELA_DIAS) score += 5;

  // 3. Referência no descritivo (30 pontos)
  const desc = (movimento.descricao || '').toLowerCase();
  const ref = (documento.numero || documento.referencia || '').toLowerCase();
  const nif = (documento.nif_cliente || documento.nif_fornecedor || '').toLowerCase();
  const nome = (documento.cliente_nome || documento.fornecedor_nome || '').toLowerCase();

  if (ref && desc.includes(ref)) score += 30;
  else if (nif && desc.includes(nif)) score += 20;
  else if (nome && nome.length > 3 && desc.includes(nome.split(' ')[0].toLowerCase())) score += 10;

  return score;
}

/**
 * Reconciliar movimentos de uma empresa
 */
async function reconciliarEmpresa(empresaId) {
  console.log(`[Reconciliação] A processar empresa ${empresaId}...`);

  // Buscar movimentos não reconciliados
  const movimentos = await query(`
    SELECT * FROM extrato_bancario
    WHERE empresa_id=$1
      AND reconciliado=false
      AND data > NOW() - INTERVAL '90 days'
    ORDER BY data DESC
    LIMIT 500
  `, [empresaId]).catch(() => ({ rows: [] }));

  if (!movimentos.rows.length) return { reconciliados: 0, pendentes: 0 };

  let reconciliados = 0;
  let pendentes = 0;

  for (const mov of movimentos.rows) {
    const valor = parseFloat(mov.valor);
    let melhorMatch = null;
    let melhorScore = 0;
    let tipoMatch = null;

    // Créditos → procurar faturas
    if (valor > 0) {
      const faturas = await query(`
        SELECT f.*, c.nome as cliente_nome, c.nif as nif_cliente
        FROM fatura f
        LEFT JOIN cliente c ON c.id = f.cliente_id
        WHERE f.empresa_id=$1
          AND f.estado IN ('emitida','enviada')
          AND f.total BETWEEN $2 AND $3
          AND f.data_emissao BETWEEN $4::date - INTERVAL '${JANELA_DIAS} days' AND $4::date + INTERVAL '${JANELA_DIAS} days'
          AND f.reconciliada=false
        LIMIT 10
      `, [empresaId, valor*0.98, valor*1.02, mov.data]).catch(() => ({ rows: [] }));

      for (const fat of faturas.rows) {
        const score = calcularScore(mov, fat);
        if (score > melhorScore) {
          melhorScore = score;
          melhorMatch = fat;
          tipoMatch = 'fatura';
        }
      }
    }

    // Débitos → procurar despesas/fornecedores
    if (valor < 0) {
      const despesas = await query(`
        SELECT d.*, f.nome as fornecedor_nome, f.nif as nif_fornecedor
        FROM despesa d
        LEFT JOIN fornecedor f ON f.id = d.fornecedor_id
        WHERE d.empresa_id=$1
          AND d.estado IN ('aprovada','paga')
          AND d.valor_total BETWEEN $2 AND $3
          AND d.data_despesa BETWEEN $4::date - INTERVAL '${JANELA_DIAS} days' AND $4::date + INTERVAL '${JANELA_DIAS} days'
          AND COALESCE(d.reconciliada,false)=false
        LIMIT 10
      `, [empresaId, Math.abs(valor)*0.98, Math.abs(valor)*1.02, mov.data]).catch(() => ({ rows: [] }));

      for (const desp of despesas.rows) {
        const score = calcularScore(mov, desp);
        if (score > melhorScore) {
          melhorScore = score;
          melhorMatch = desp;
          tipoMatch = 'despesa';
        }
      }
    }

    // Match automático se score >= mínimo
    if (melhorScore >= SCORE_MINIMO && melhorMatch) {
      await transaction(async (client) => {
        // Marcar movimento como reconciliado
        await client.query(`
          UPDATE extrato_bancario SET
            reconciliado=true, reconciliado_em=NOW(),
            reconciliado_com_tipo=$1, reconciliado_com_id=$2, score_match=$3
          WHERE id=$4
        `, [tipoMatch, melhorMatch.id, melhorScore, mov.id]);

        // Marcar documento como reconciliado
        if (tipoMatch === 'fatura') {
          await client.query(`UPDATE fatura SET reconciliada=true, data_pagamento=$1, estado='paga' WHERE id=$2`,
            [mov.data, melhorMatch.id]);
        } else {
          await client.query(`UPDATE despesa SET reconciliada=true, data_pagamento=$1, estado='paga' WHERE id=$2`,
            [mov.data, melhorMatch.id]);
        }

        reconciliados++;
        console.log(`[Reconciliação] ✅ Match (score ${melhorScore}): ${mov.descricao?.slice(0,40)} ↔ ${melhorMatch.numero||melhorMatch.id}`);
      }).catch((e) => {
        console.error(`[Reconciliação] Erro no match:`, e.message);
      });
    } else {
      pendentes++;
      // Se score entre 40-70, criar sugestão para revisão manual
      if (melhorScore >= 40 && melhorMatch) {
        await query(`
          UPDATE extrato_bancario SET
            sugestao_match_tipo=$1, sugestao_match_id=$2, sugestao_score=$3
          WHERE id=$4
        `, [tipoMatch, melhorMatch.id, melhorScore, mov.id]).catch(() => {});
      }
    }
  }

  // Notificar se há pendentes
  if (pendentes > 0) {
    await query(`
      INSERT INTO notificacao (utilizador_id, titulo, mensagem, tipo, url_accao)
      SELECT id, $1, $2, 'info', '/openbanking'
      FROM utilizador WHERE empresa_id=$3 AND perfil IN ('admin_empresa','financeiro') LIMIT 3
    `, [
      `🏦 Reconciliação bancária: ${pendentes} pendentes`,
      `${reconciliados} movimentos reconciliados automaticamente. ${pendentes} requerem revisão manual.`,
      empresaId
    ]).catch(() => {});
  }

  return { reconciliados, pendentes };
}

/**
 * Reconciliar todas as empresas
 * Corre diariamente às 7h
 */
async function reconciliarTodas() {
  console.log('[Reconciliação] A iniciar reconciliação automática...');
  const empresas = await query(`SELECT id FROM empresa WHERE ativo=true`).catch(() => ({ rows: [] }));
  let totalRec = 0, totalPend = 0;

  for (const emp of empresas.rows) {
    const { reconciliados, pendentes } = await reconciliarEmpresa(emp.id).catch(() => ({ reconciliados:0, pendentes:0 }));
    totalRec += reconciliados;
    totalPend += pendentes;
  }

  console.log(`[Reconciliação] Concluído: ${totalRec} reconciliados, ${totalPend} pendentes`);
}

module.exports = { reconciliarEmpresa, reconciliarTodas };
