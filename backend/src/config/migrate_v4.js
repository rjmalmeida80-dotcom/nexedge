'use strict';
const { pool } = require('./database');

const migrations = [

// ══════════════════════════════════════════════════════════════════════════════
// RELATÓRIO ÚNICO — campos novos nos colaboradores
// ══════════════════════════════════════════════════════════════════════════════

// Código CPP (Classificação Portuguesa de Profissões)
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS cpp_codigo VARCHAR(10)`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS cpp_descricao VARCHAR(200)`,

// Nível de qualificação RU (9 níveis obrigatórios no Relatório Único)
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS nivel_qualificacao VARCHAR(50)`,

// Código CCT/IRCT aplicável ao colaborador
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS codigo_irct VARCHAR(20)`,

// Estabelecimento/local de trabalho codificado para RU
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS codigo_estabelecimento VARCHAR(20)`,

// Motivo de saída codificado (para ex-colaboradores)
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS motivo_saida_codigo VARCHAR(10)`,

// Remuneração base no início do contrato
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS remuneracao_base_inicial NUMERIC(10,2)`,

// Nível de escolaridade
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS nivel_escolaridade VARCHAR(50)`,

// ══════════════════════════════════════════════════════════════════════════════
// RELATÓRIO ÚNICO — campos novos na Formação (Anexo C)
// ══════════════════════════════════════════════════════════════════════════════
`ALTER TABLE formacao ADD COLUMN IF NOT EXISTS codigo_cnf VARCHAR(10)`,
`ALTER TABLE formacao ADD COLUMN IF NOT EXISTS nif_entidade_formadora VARCHAR(9)`,
`ALTER TABLE formacao ADD COLUMN IF NOT EXISTS modalidade VARCHAR(50)`,
`ALTER TABLE formacao ADD COLUMN IF NOT EXISTS financiamento VARCHAR(50)`,

// ══════════════════════════════════════════════════════════════════════════════
// RELATÓRIO ÚNICO — campos novos na Medicina/SST (Anexo D)
// ══════════════════════════════════════════════════════════════════════════════
`ALTER TABLE medicina_trabalho ADD COLUMN IF NOT EXISTS tecnico_sst_num_act VARCHAR(20)`,
`ALTER TABLE medicina_trabalho ADD COLUMN IF NOT EXISTS medico_cedula VARCHAR(20)`,
`ALTER TABLE medicina_trabalho ADD COLUMN IF NOT EXISTS nif_entidade_externa VARCHAR(9)`,

// ══════════════════════════════════════════════════════════════════════════════
// PRESTADORES DE SERVIÇOS (necessário para Anexo A do RU)
// ══════════════════════════════════════════════════════════════════════════════
`CREATE TABLE IF NOT EXISTS prestador_servico (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id      UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  nome            VARCHAR(200) NOT NULL,
  nif             VARCHAR(9),
  tipo            VARCHAR(50) DEFAULT 'avenca',
  cargo           VARCHAR(150),
  departamento_id UUID REFERENCES departamento(id) ON DELETE SET NULL,
  data_inicio     DATE,
  data_fim        DATE,
  valor_mensal    NUMERIC(10,2) DEFAULT 0,
  horas_mes       NUMERIC(5,1),
  ativo           BOOLEAN DEFAULT true,
  notas           TEXT,
  criado_em       TIMESTAMPTZ DEFAULT NOW()
)`,

// ══════════════════════════════════════════════════════════════════════════════
// RELATÓRIO ÚNICO — tabela principal de submissões
// ══════════════════════════════════════════════════════════════════════════════
`CREATE TABLE IF NOT EXISTS relatorio_unico (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id      UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  ano             INTEGER NOT NULL,
  estado          VARCHAR(30) DEFAULT 'rascunho',
  gerado_em       TIMESTAMPTZ,
  gerado_por      UUID REFERENCES utilizador(id),
  submetido_em    TIMESTAMPTZ,
  anexo_a_ok      BOOLEAN DEFAULT false,
  anexo_b_ok      BOOLEAN DEFAULT false,
  anexo_c_ok      BOOLEAN DEFAULT false,
  anexo_d_ok      BOOLEAN DEFAULT false,
  anexo_e_ok      BOOLEAN DEFAULT false,
  anexo_f_ok      BOOLEAN DEFAULT false,
  ficheiro_url    TEXT,
  notas           TEXT,
  criado_em       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(empresa_id, ano)
)`,

];

async function migrar() {
  const client = await pool.connect();
  try {
    console.log('🔄 migrate_v4: a aplicar migrações Relatório Único...');
    for (const sql of migrations) {
      await client.query(sql);
    }
    console.log('✅ migrate_v4: concluído.');
  } catch (e) {
    console.error('❌ migrate_v4 erro:', e.message);
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { migrar };
if (require.main === module) migrar().then(() => process.exit(0)).catch(() => process.exit(1));
