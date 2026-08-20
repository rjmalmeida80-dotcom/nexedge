'use strict';
require('dotenv').config();
const { pool } = require('./database');

async function migrarV3() {
  console.log('🚀 A migrar v3 (Onboarding, Offboarding, Equipamentos)...');
  const queries = [

    // ── Equipamentos da empresa ─────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS equipamento (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      empresa_id      UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
      funcionario_id  UUID REFERENCES funcionario(id) ON DELETE SET NULL,
      tipo            VARCHAR(50) NOT NULL, -- pc, telemovel, viatura, chave, cartao, uniforme, outro
      nome            VARCHAR(200) NOT NULL,
      marca           VARCHAR(100),
      modelo          VARCHAR(100),
      numero_serie    VARCHAR(100),
      numero_inventario VARCHAR(50),
      estado          VARCHAR(20) DEFAULT 'disponivel', -- disponivel, atribuido, em_manutencao, abatido
      data_aquisicao  DATE,
      valor_aquisicao NUMERIC(10,2),
      notas           TEXT,
      data_atribuicao DATE,
      criado_em       TIMESTAMPTZ DEFAULT NOW(),
      atualizado_em   TIMESTAMPTZ DEFAULT NOW()
    )`,

    // ── Templates de onboarding/offboarding ────────────────────────────
    `CREATE TABLE IF NOT EXISTS onboarding_template (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      empresa_id  UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
      tipo        VARCHAR(20) NOT NULL, -- onboarding, offboarding
      nome        VARCHAR(200) NOT NULL,
      descricao   TEXT,
      ativo       BOOLEAN DEFAULT true,
      criado_em   TIMESTAMPTZ DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS onboarding_template_tarefa (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      template_id     UUID NOT NULL REFERENCES onboarding_template(id) ON DELETE CASCADE,
      titulo          VARCHAR(300) NOT NULL,
      descricao       TEXT,
      responsavel     VARCHAR(50) DEFAULT 'rh', -- rh, ti, gestor, funcionario
      categoria       VARCHAR(50) DEFAULT 'geral', -- documentos, equipamentos, acessos, formacao, apresentacao
      prazo_dias      INTEGER DEFAULT 0, -- dias após admissão/saída
      obrigatorio     BOOLEAN DEFAULT true,
      ordem           INTEGER DEFAULT 0
    )`,

    // ── Processos de onboarding/offboarding por funcionário ─────────────
    `CREATE TABLE IF NOT EXISTS onboarding_processo (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      empresa_id      UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
      funcionario_id  UUID NOT NULL REFERENCES funcionario(id) ON DELETE CASCADE,
      tipo            VARCHAR(20) NOT NULL, -- onboarding, offboarding
      estado          VARCHAR(20) DEFAULT 'em_curso', -- em_curso, concluido, cancelado
      data_inicio     DATE NOT NULL,
      data_prevista   DATE,
      data_conclusao  DATE,
      notas           TEXT,
      motivo_saida    VARCHAR(100), -- so offboarding: demissao, despedimento, reforma, etc
      criado_por      UUID REFERENCES utilizador(id),
      criado_em       TIMESTAMPTZ DEFAULT NOW()
    )`,

    `CREATE TABLE IF NOT EXISTS onboarding_tarefa (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      processo_id     UUID NOT NULL REFERENCES onboarding_processo(id) ON DELETE CASCADE,
      titulo          VARCHAR(300) NOT NULL,
      descricao       TEXT,
      responsavel     VARCHAR(50) DEFAULT 'rh',
      categoria       VARCHAR(50) DEFAULT 'geral',
      prazo_data      DATE,
      concluida       BOOLEAN DEFAULT false,
      concluida_em    TIMESTAMPTZ,
      concluida_por   UUID REFERENCES utilizador(id),
      obrigatorio     BOOLEAN DEFAULT true,
      ordem           INTEGER DEFAULT 0,
      equipamento_id  UUID REFERENCES equipamento(id) ON DELETE SET NULL
    )`,

    // ── Índices ─────────────────────────────────────────────────────────
    `CREATE INDEX IF NOT EXISTS idx_equipamento_empresa ON equipamento(empresa_id)`,
    `CREATE INDEX IF NOT EXISTS idx_equipamento_funcionario ON equipamento(funcionario_id)`,
    `CREATE INDEX IF NOT EXISTS idx_onboarding_processo_func ON onboarding_processo(funcionario_id)`,
    `CREATE INDEX IF NOT EXISTS idx_onboarding_tarefa_processo ON onboarding_tarefa(processo_id)`,
  ];

  for (const q of queries) {
    try {
      await pool.query(q);
      process.stdout.write('.');
    } catch(e) {
      console.error('\n❌ Erro:', e.message);
    }
  }

  // Insert default templates
  try {
    const { rows: [emp] } = await pool.query(
      "SELECT id FROM empresa LIMIT 1"
    );
    if (emp) {
      // Check if templates already exist
      const { rows: existing } = await pool.query(
        "SELECT COUNT(*) FROM onboarding_template WHERE empresa_id=$1", [emp.id]
      );
      if (existing[0].count === '0') {
        // Onboarding template
        const { rows: [ton] } = await pool.query(
          "INSERT INTO onboarding_template (empresa_id, tipo, nome, descricao) VALUES ($1,'onboarding','Onboarding Padrão','Processo de integração de novos colaboradores') RETURNING id",
          [emp.id]
        );
        const tarefasOn = [
          ['Preparar posto de trabalho', 'Garantir que o posto de trabalho está limpo e equipado', 'rh', 'equipamentos', -3, true, 1],
          ['Configurar PC e acessos', 'Criar conta de email, acessos aos sistemas e VPN', 'ti', 'acessos', -1, true, 2],
          ['Preparar crachá e cartão de acesso', 'Emitir crachá de identificação e cartão de acesso ao edifício', 'rh', 'equipamentos', -1, true, 3],
          ['Receber documentos de admissão', 'Contrato de trabalho, declaração de IRS, ficha de dados pessoais', 'rh', 'documentos', 0, true, 4],
          ['Tour às instalações', 'Apresentar as instalações, saídas de emergência e regras internas', 'rh', 'apresentacao', 0, true, 5],
          ['Apresentação à equipa', 'Apresentar o novo colaborador aos colegas e gestor directo', 'gestor', 'apresentacao', 0, true, 6],
          ['Formação inicial obrigatória', 'Segurança no trabalho, políticas internas, RGPD', 'rh', 'formacao', 3, true, 7],
          ['Reunião com gestor directo', 'Definir objectivos do período experimental e expectativas', 'gestor', 'formacao', 5, true, 8],
          ['Revisão ao fim da 1ª semana', 'Check-in com o colaborador para identificar dúvidas ou problemas', 'rh', 'apresentacao', 7, false, 9],
          ['Avaliação do período experimental (30 dias)', 'Primeira avaliação formal do desempenho', 'gestor', 'formacao', 30, true, 10],
        ];
        for (const t of tarefasOn) {
          await pool.query(
            "INSERT INTO onboarding_template_tarefa (template_id, titulo, descricao, responsavel, categoria, prazo_dias, obrigatorio, ordem) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
            [ton.id, ...t]
          );
        }

        // Offboarding template
        const { rows: [toff] } = await pool.query(
          "INSERT INTO onboarding_template (empresa_id, tipo, nome, descricao) VALUES ($1,'offboarding','Offboarding Padrão','Processo de saída de colaboradores') RETURNING id",
          [emp.id]
        );
        const tarefasOff = [
          ['Entrevista de saída', 'Conversa para perceber os motivos da saída e recolher feedback', 'rh', 'apresentacao', 0, false, 1],
          ['Revogar acessos aos sistemas', 'Desactivar email, acessos internos, VPN, plataformas SaaS', 'ti', 'acessos', 0, true, 2],
          ['Devolução do PC', 'Verificar estado e registar devolução do computador', 'ti', 'equipamentos', 0, true, 3],
          ['Devolução do telemóvel', 'Verificar estado e registar devolução do telemóvel de serviço', 'rh', 'equipamentos', 0, false, 4],
          ['Devolução das chaves e cartão de acesso', 'Recolher todas as chaves e cartões da empresa', 'rh', 'equipamentos', 0, true, 5],
          ['Devolução de viatura', 'Registar quilómetros, estado e devolver documentos da viatura', 'rh', 'equipamentos', 0, false, 6],
          ['Liquidação final de salário', 'Calcular proporcionais, férias não gozadas e subsídios', 'rh', 'documentos', 0, true, 7],
          ['Emitir certificado de trabalho', 'Preparar declaração de funções e período de trabalho', 'rh', 'documentos', 0, true, 8],
          ['Comunicar cessação à Segurança Social', 'Registar data de cessação no portal SS', 'rh', 'documentos', 0, true, 9],
          ['Arquivar processo do colaborador', 'Guardar toda a documentação do colaborador (mínimo 5 anos)', 'rh', 'documentos', 5, true, 10],
        ];
        for (const t of tarefasOff) {
          await pool.query(
            "INSERT INTO onboarding_template_tarefa (template_id, titulo, descricao, responsavel, categoria, prazo_dias, obrigatorio, ordem) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
            [toff.id, ...t]
          );
        }
        console.log('\n✅ Templates de onboarding/offboarding criados');
      }
    }
  } catch(e) {
    console.warn('\n⚠️ Templates:', e.message);
  }

  console.log('\n✅ Migração v3 concluída!');
  await pool.end();
}

migrarV3().catch(e => { console.error('❌', e.message); process.exit(1); });
