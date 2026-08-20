'use strict';
const { query } = require('../config/database');

// Dias de antecedência para alertas
const ALERTAS_CONFIG = {
  seguro:    [30, 15, 7],
  inspecao:  [30, 15, 7],
  carta:     [60, 30, 15],
  iuc:       [30, 15],
};

async function verificarAlertasFrota() {
  console.log('🚗 [FROTA] A verificar alertas automáticos...');

  try {
    // Buscar todas as empresas com frota
    const { rows: empresas } = await query(
      "SELECT DISTINCT empresa_id FROM viatura WHERE estado='ativo'"
    );

    for (const { empresa_id } of empresas) {
      await verificarEmpresa(empresa_id);
    }

    console.log('✅ [FROTA] Alertas verificados.');
  } catch (e) {
    console.error('❌ [FROTA] Erro nos alertas:', e.message);
  }
}

async function verificarEmpresa(empresaId) {
  const hoje = new Date();

  // ── 1. Seguros a vencer ────────────────────────────────────────────────────
  const { rows: seguros } = await query(`
    SELECT v.matricula, v.marca, v.modelo, vs.seguradora, vs.data_fim,
      vs.data_fim - CURRENT_DATE AS dias,
      f.email AS condutor_email, f.nome_completo AS condutor_nome
    FROM viatura_seguro vs
    JOIN viatura v ON v.id = vs.viatura_id
    LEFT JOIN funcionario f ON f.id = v.condutor_id
    WHERE v.empresa_id = $1
      AND vs.data_fim BETWEEN CURRENT_DATE AND CURRENT_DATE + 30
      AND v.estado = 'ativo'
    ORDER BY vs.data_fim ASC
  `, [empresaId]);

  for (const s of seguros) {
    const dias = parseInt(s.dias);
    if (ALERTAS_CONFIG.seguro.includes(dias)) {
      await criarNotificacao(empresaId, {
        tipo: 'frota_seguro',
        titulo: `⚠️ Seguro a vencer — ${s.matricula}`,
        mensagem: `O seguro da viatura ${s.matricula} (${s.marca} ${s.modelo}) na ${s.seguradora} vence em ${dias} dia(s). Renovar antes de ${new Date(s.data_fim).toLocaleDateString('pt-PT')}.`,
        urgencia: dias <= 7 ? 'alta' : 'media',
        dados: { matricula: s.matricula, dias, data_fim: s.data_fim },
      });
    }
  }

  // ── 2. Inspecções IPT a vencer ─────────────────────────────────────────────
  const { rows: inspecoes } = await query(`
    SELECT DISTINCT ON (v.id)
      v.id, v.matricula, v.marca, v.modelo,
      vi.data_proxima,
      vi.data_proxima - CURRENT_DATE AS dias,
      f.email AS condutor_email, f.nome_completo AS condutor_nome
    FROM viatura_inspecao vi
    JOIN viatura v ON v.id = vi.viatura_id
    LEFT JOIN funcionario f ON f.id = v.condutor_id
    WHERE v.empresa_id = $1
      AND vi.data_proxima BETWEEN CURRENT_DATE AND CURRENT_DATE + 30
      AND v.estado = 'ativo'
    ORDER BY v.id, vi.data_inspecao DESC
  `, [empresaId]);

  for (const i of inspecoes) {
    const dias = parseInt(i.dias);
    if (ALERTAS_CONFIG.inspecao.includes(dias)) {
      await criarNotificacao(empresaId, {
        tipo: 'frota_inspecao',
        titulo: `🔍 Inspecção IPT a vencer — ${i.matricula}`,
        mensagem: `A inspecção periódica da viatura ${i.matricula} (${i.marca} ${i.modelo}) vence em ${dias} dia(s), a ${new Date(i.data_proxima).toLocaleDateString('pt-PT')}. Marcar inspecção com antecedência.`,
        urgencia: dias <= 7 ? 'alta' : 'media',
        dados: { matricula: i.matricula, dias, data_proxima: i.data_proxima },
      });
    }
  }

  // ── 3. Manutenções por KM ──────────────────────────────────────────────────
  const { rows: manutencoes } = await query(`
    SELECT v.matricula, v.marca, v.modelo, v.km_actuais, v.km_proxima_manutencao,
      v.km_proxima_manutencao - v.km_actuais AS km_restantes,
      f.email AS condutor_email, f.nome_completo AS condutor_nome
    FROM viatura v
    LEFT JOIN funcionario f ON f.id = v.condutor_id
    WHERE v.empresa_id = $1
      AND v.estado = 'ativo'
      AND v.km_proxima_manutencao IS NOT NULL
      AND v.km_proxima_manutencao - v.km_actuais <= 1000
      AND v.km_proxima_manutencao - v.km_actuais > 0
  `, [empresaId]);

  for (const m of manutencoes) {
    await criarNotificacao(empresaId, {
      tipo: 'frota_manutencao',
      titulo: `🔧 Manutenção próxima — ${m.matricula}`,
      mensagem: `A viatura ${m.matricula} (${m.marca} ${m.modelo}) necessita de manutenção em ${parseInt(m.km_restantes).toLocaleString('pt-PT')} km. KM actuais: ${parseInt(m.km_actuais).toLocaleString('pt-PT')} · Próxima manutenção aos: ${parseInt(m.km_proxima_manutencao).toLocaleString('pt-PT')} km.`,
      urgencia: parseInt(m.km_restantes) <= 200 ? 'alta' : 'media',
      dados: { matricula: m.matricula, km_restantes: m.km_restantes },
    });
  }

  // ── 4. Cartas de condução a vencer ─────────────────────────────────────────
  const { rows: cartas } = await query(`
    SELECT cc.data_validade, cc.pontos_actuais,
      cc.data_validade - CURRENT_DATE AS dias,
      f.nome_completo, f.email
    FROM carta_conducao cc
    JOIN funcionario f ON f.id = cc.funcionario_id
    WHERE cc.empresa_id = $1
      AND cc.data_validade BETWEEN CURRENT_DATE AND CURRENT_DATE + 60
  `, [empresaId]);

  for (const c of cartas) {
    const dias = parseInt(c.dias);
    if (ALERTAS_CONFIG.carta.includes(dias)) {
      await criarNotificacao(empresaId, {
        tipo: 'frota_carta',
        titulo: `📋 Carta de condução a vencer — ${c.nome_completo}`,
        mensagem: `A carta de condução de ${c.nome_completo} vence em ${dias} dia(s), a ${new Date(c.data_validade).toLocaleDateString('pt-PT')}. Renovar na IMT antes do prazo.`,
        urgencia: dias <= 15 ? 'alta' : 'baixa',
        dados: { nome: c.nome_completo, dias, data_validade: c.data_validade },
      });
    }
  }

  // ── 5. Viaturas sem seguro válido ──────────────────────────────────────────
  const { rows: semSeguro } = await query(`
    SELECT v.matricula, v.marca, v.modelo
    FROM viatura v
    WHERE v.empresa_id = $1 AND v.estado = 'ativo'
      AND NOT EXISTS (
        SELECT 1 FROM viatura_seguro vs
        WHERE vs.viatura_id = v.id AND vs.data_fim >= CURRENT_DATE
      )
  `, [empresaId]);

  for (const v of semSeguro) {
    await criarNotificacao(empresaId, {
      tipo: 'frota_sem_seguro',
      titulo: `🔴 URGENTE — Viatura sem seguro válido: ${v.matricula}`,
      mensagem: `A viatura ${v.matricula} (${v.marca} ${v.modelo}) não tem seguro válido. Circular sem seguro é crime — renovar imediatamente.`,
      urgencia: 'critica',
      dados: { matricula: v.matricula },
    });
  }
}

async function criarNotificacao(empresaId, { tipo, titulo, mensagem, urgencia, dados }) {
  try {
    // Verificar se já existe esta notificação hoje para evitar duplicados
    const { rows: existe } = await query(`
      SELECT id FROM notificacao
      WHERE empresa_id = $1 AND tipo = $2
        AND dados::text LIKE $3
        AND DATE(criado_em) = CURRENT_DATE
      LIMIT 1
    `, [empresaId, tipo, `%${dados.matricula || dados.nome || ''}%`]);

    if (existe.length) return; // Já notificado hoje

    // Buscar admins da empresa
    const { rows: admins } = await query(`
      SELECT u.id FROM utilizador u
      WHERE u.empresa_id = $1
        AND u.perfil IN ('admin_empresa', 'rh', 'diretor')
        AND u.ativo = true
      LIMIT 5
    `, [empresaId]);

    for (const admin of admins) {
      await query(`
        INSERT INTO notificacao (utilizador_id, empresa_id, tipo, titulo, mensagem, urgencia, dados, lida)
        VALUES ($1, $2, $3, $4, $5, $6, $7, false)
        ON CONFLICT DO NOTHING
      `, [admin.id, empresaId, tipo, titulo, mensagem, urgencia, JSON.stringify(dados)]);
    }

    console.log(`  📣 Notificação criada: ${titulo}`);
  } catch (e) {
    // Tabela notificacao pode ter estrutura diferente — ignorar silenciosamente
    console.log(`  ℹ️  Alerta gerado: ${titulo}`);
  }
}

module.exports = { verificarAlertasFrota };
