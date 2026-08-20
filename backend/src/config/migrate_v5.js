'use strict';
const { pool } = require('./database');

const migrations = [


// ══════════════════════════════════════════════════════════════════════════════
// MOTOR DE HORÁRIOS — campos novos no colaborador
// ══════════════════════════════════════════════════════════════════════════════
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS trabalha_feriados BOOLEAN DEFAULT false`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS trabalha_fim_semana BOOLEAN DEFAULT false`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS regime_horario VARCHAR(30) DEFAULT 'seg_sex'`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS dias_trabalho_semana VARCHAR(20) DEFAULT '1,2,3,4,5'`,
// 0=Dom,1=Seg,2=Ter,3=Qua,4=Qui,5=Sex,6=Sab
// Regimes: seg_sex, seg_sab, 24_7, turno_rotativo, personalizado

// ══════════════════════════════════════════════════════════════════════════════
// DMR — Declaração Mensal de Remunerações (AT)
// ══════════════════════════════════════════════════════════════════════════════
`CREATE TABLE IF NOT EXISTS dmr (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id      UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  ano             INTEGER NOT NULL,
  mes             INTEGER NOT NULL CHECK (mes BETWEEN 1 AND 12),
  estado          VARCHAR(30) DEFAULT 'rascunho',
  num_declarantes INTEGER DEFAULT 0,
  total_remuneracoes NUMERIC(12,2) DEFAULT 0,
  total_irs       NUMERIC(12,2) DEFAULT 0,
  xml_gerado      TEXT,
  submetido_em    TIMESTAMPTZ,
  submetido_por   UUID REFERENCES utilizador(id),
  notas           TEXT,
  criado_em       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(empresa_id, ano, mes)
)`,

// ══════════════════════════════════════════════════════════════════════════════
// DRI — Declaração de Remunerações à Segurança Social
// ══════════════════════════════════════════════════════════════════════════════
`CREATE TABLE IF NOT EXISTS dri (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id      UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  ano             INTEGER NOT NULL,
  mes             INTEGER NOT NULL CHECK (mes BETWEEN 1 AND 12),
  estado          VARCHAR(30) DEFAULT 'rascunho',
  num_trabalhadores INTEGER DEFAULT 0,
  total_remuneracoes NUMERIC(12,2) DEFAULT 0,
  total_contrib_func NUMERIC(12,2) DEFAULT 0,
  total_contrib_ent  NUMERIC(12,2) DEFAULT 0,
  xml_gerado      TEXT,
  submetido_em    TIMESTAMPTZ,
  submetido_por   UUID REFERENCES utilizador(id),
  notas           TEXT,
  criado_em       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(empresa_id, ano, mes)
)`,

// Campos NIF empresa para declarações (se não existirem)
`ALTER TABLE empresa ADD COLUMN IF NOT EXISTS niss_empresa VARCHAR(11)`,
`ALTER TABLE empresa ADD COLUMN IF NOT EXISTS cae_principal VARCHAR(10)`,

// Campo NISS no funcionário (já pode existir)
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS niss VARCHAR(11)`,


// ══════════════════════════════════════════════════════════════════════════════
// PROCESSAMENTO SALARIAL — campos extra no recibo
// ══════════════════════════════════════════════════════════════════════════════
`ALTER TABLE recibo_vencimento ADD COLUMN IF NOT EXISTS base_tributavel NUMERIC(10,2) DEFAULT 0`,
`ALTER TABLE recibo_vencimento ADD COLUMN IF NOT EXISTS horas_extra_25 NUMERIC(5,2) DEFAULT 0`,
`ALTER TABLE recibo_vencimento ADD COLUMN IF NOT EXISTS horas_extra_375 NUMERIC(5,2) DEFAULT 0`,
`ALTER TABLE recibo_vencimento ADD COLUMN IF NOT EXISTS horas_feriado NUMERIC(5,2) DEFAULT 0`,
`ALTER TABLE recibo_vencimento ADD COLUMN IF NOT EXISTS horas_nocturnas NUMERIC(5,2) DEFAULT 0`,
`ALTER TABLE recibo_vencimento ADD COLUMN IF NOT EXISTS feriados_valor NUMERIC(8,2) DEFAULT 0`,
`ALTER TABLE recibo_vencimento ADD COLUMN IF NOT EXISTS nocturno_valor NUMERIC(8,2) DEFAULT 0`,
`ALTER TABLE recibo_vencimento ADD COLUMN IF NOT EXISTS horas_extra_25_valor NUMERIC(8,2) DEFAULT 0`,
`ALTER TABLE recibo_vencimento ADD COLUMN IF NOT EXISTS horas_extra_375_valor NUMERIC(8,2) DEFAULT 0`,
`ALTER TABLE recibo_vencimento ADD COLUMN IF NOT EXISTS faltas_dias NUMERIC(5,2) DEFAULT 0`,
`ALTER TABLE recibo_vencimento ADD COLUMN IF NOT EXISTS faltas_horas NUMERIC(5,2) DEFAULT 0`,
`ALTER TABLE recibo_vencimento ADD COLUMN IF NOT EXISTS dias_trabalhados INTEGER DEFAULT 22`,
`ALTER TABLE recibo_vencimento ADD COLUMN IF NOT EXISTS sub_alimentacao_tipo VARCHAR(20) DEFAULT 'dinheiro'`,
`ALTER TABLE recibo_vencimento ADD COLUMN IF NOT EXISTS adiantamento NUMERIC(8,2) DEFAULT 0`,
`ALTER TABLE recibo_vencimento ADD COLUMN IF NOT EXISTS seg_social_entidade NUMERIC(8,2) DEFAULT 0`,
`ALTER TABLE recibo_vencimento ADD COLUMN IF NOT EXISTS custo_total_entidade NUMERIC(10,2) DEFAULT 0`,
`ALTER TABLE recibo_vencimento ADD COLUMN IF NOT EXISTS detalhes JSONB DEFAULT '{}'`,
`ALTER TABLE recibo_vencimento ADD COLUMN IF NOT EXISTS aprovado_por UUID REFERENCES utilizador(id)`,
`ALTER TABLE recibo_vencimento ADD COLUMN IF NOT EXISTS aprovado_em TIMESTAMPTZ`,
`ALTER TABLE recibo_vencimento ADD COLUMN IF NOT EXISTS notas TEXT`,

// Campos no funcionário para IRS
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS estado_civil VARCHAR(20) DEFAULT 'solteiro'`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS num_dependentes INTEGER DEFAULT 0`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS conjuge_trabalha BOOLEAN DEFAULT false`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS subsidio_alimentacao_dia NUMERIC(6,2) DEFAULT 6.00`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS sub_alimentacao_tipo VARCHAR(20) DEFAULT 'dinheiro'`,
];

async function migrar() {
  const client = await pool.connect();
  try {
    console.log('🔄 migrate_v5: DMR + DRI...');
    for (const sql of migrations) {
      await client.query(sql);
    }
    console.log('✅ migrate_v5: concluído.');
  } catch(e) {
    console.error('❌ migrate_v5:', e.message);
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { migrar };
if (require.main === module) migrar().then(() => process.exit(0)).catch(() => process.exit(1));
