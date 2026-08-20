'use strict';
const { query } = require('../config/database');
const email = require('../services/emailService');
const crypto = require('crypto');

// ── Gerar número de fatura ────────────────────────────────────────────────────
async function gerarNumeroFatura(empresaId, serie) {
  const { rows:[ultima] } = await query(`
    SELECT numero_sequencial FROM fatura
    WHERE empresa_id=$1 AND serie=$2
    ORDER BY numero_sequencial DESC LIMIT 1
  `, [empresaId, serie]).catch(() => ({ rows:[{ numero_sequencial: 0 }] }));

  const seq = (ultima?.numero_sequencial || 0) + 1;
  const ano = new Date().getFullYear();
  return {
    numero_completo: `${serie}${ano}/${String(seq).padStart(4,'0')}`,
    numero_sequencial: seq,
    serie,
    ano,
  };
}

// ── Criar fatura recorrente ───────────────────────────────────────────────────
async function criarFaturaRecorrente(servico) {
  try {
    const { rows:[emp] } = await query(
      'SELECT * FROM empresa WHERE id=$1 AND ativo=true', [servico.empresa_id]
    );
    if (!emp) return;

    const numFat = await gerarNumeroFatura(servico.empresa_id, 'FT');
    const dataVencimento = new Date();
    dataVencimento.setDate(dataVencimento.getDate() + (servico.dias_vencimento || 30));

    const total = parseFloat(servico.valor) + parseFloat(servico.valor_iva || 0);

    const { rows:[fat] } = await query(`
      INSERT INTO fatura (
        empresa_id, numero_completo, numero_sequencial, serie, ano,
        cliente_nome, cliente_nif, cliente_email, cliente_morada,
        descricao, subtotal, total_iva, total,
        data_emissao, data_vencimento, estado,
        servico_recorrente_id, gerada_automaticamente
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
        CURRENT_DATE,$14,'emitida',$15,true)
      RETURNING *
    `, [
      servico.empresa_id,
      numFat.numero_completo, numFat.numero_sequencial, numFat.serie, numFat.ano,
      servico.cliente_nome, servico.cliente_nif, servico.cliente_email, servico.cliente_morada,
      servico.descricao,
      servico.valor, servico.valor_iva || 0, total,
      dataVencimento.toISOString().split('T')[0],
      servico.id,
    ]);

    // Actualizar próxima data de faturação
    const proxData = calcularProximaData(servico.frequencia, servico.proximo_faturacao);
    await query(
      'UPDATE servico_recorrente SET ultimo_faturacao=CURRENT_DATE, proximo_faturacao=$1, total_faturas=total_faturas+1 WHERE id=$2',
      [proxData, servico.id]
    );

    // Enviar email ao cliente
    if (servico.cliente_email) {
      await email.enviarFatura({
        email: servico.cliente_email,
        nomeCliente: servico.cliente_nome,
        empresa: emp.nome,
        numeroFatura: numFat.numero_completo,
        dataEmissao: new Date().toLocaleDateString('pt-PT'),
        dataVencimento: dataVencimento.toLocaleDateString('pt-PT'),
        total: `${parseFloat(total).toLocaleString('pt-PT',{minimumFractionDigits:2})}€`,
        iban: process.env.EMPRESA_IBAN,
      }).catch(()=>{});
    }

    console.log(`✅ Fatura recorrente criada: ${numFat.numero_completo} → ${servico.cliente_nome}`);
    return fat;
  } catch(e) {
    console.error(`❌ Erro fatura recorrente ${servico.id}:`, e.message);
    await query(
      'UPDATE servico_recorrente SET ultimo_erro=$1, ultima_tentativa=NOW() WHERE id=$2',
      [e.message, servico.id]
    ).catch(()=>{});
  }
}

// ── Calcular próxima data ─────────────────────────────────────────────────────
function calcularProximaData(frequencia, dataActual) {
  const d = new Date(dataActual);
  switch(frequencia) {
    case 'semanal':    d.setDate(d.getDate() + 7); break;
    case 'quinzenal':  d.setDate(d.getDate() + 15); break;
    case 'mensal':     d.setMonth(d.getMonth() + 1); break;
    case 'trimestral': d.setMonth(d.getMonth() + 3); break;
    case 'semestral':  d.setMonth(d.getMonth() + 6); break;
    case 'anual':      d.setFullYear(d.getFullYear() + 1); break;
    default:           d.setMonth(d.getMonth() + 1);
  }
  return d.toISOString().split('T')[0];
}

// ── JOB PRINCIPAL — Correr todos os dias às 08:00 ────────────────────────────
async function jobFaturacaoRecorrente() {
  try {
    console.log('🔄 jobFaturacaoRecorrente: a verificar...');

    const { rows: servicos } = await query(`
      SELECT sr.*, e.nome AS empresa_nome
      FROM servico_recorrente sr
      JOIN empresa e ON e.id = sr.empresa_id
      WHERE sr.ativo = true
        AND sr.proximo_faturacao <= CURRENT_DATE
        AND (sr.data_fim IS NULL OR sr.data_fim >= CURRENT_DATE)
      ORDER BY sr.proximo_faturacao
    `);

    console.log(`📋 ${servicos.length} serviços a faturar hoje`);

    let criadas = 0;
    for (const s of servicos) {
      const fat = await criarFaturaRecorrente(s);
      if (fat) criadas++;
    }

    console.log(`✅ jobFaturacaoRecorrente: ${criadas}/${servicos.length} faturas criadas`);
  } catch(e) {
    console.error('❌ jobFaturacaoRecorrente:', e.message);
  }
}

module.exports = { jobFaturacaoRecorrente, criarFaturaRecorrente, calcularProximaData };
