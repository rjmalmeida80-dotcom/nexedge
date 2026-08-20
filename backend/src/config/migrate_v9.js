'use strict';
const { pool } = require('./database');

const migrations = [
`CREATE TABLE IF NOT EXISTS conta_snc (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  codigo VARCHAR(20) NOT NULL,
  descricao VARCHAR(200) NOT NULL,
  tipo VARCHAR(20) NOT NULL,
  classe VARCHAR(2) NOT NULL,
  natureza VARCHAR(10) DEFAULT 'devedora',
  conta_mae_id UUID REFERENCES conta_snc(id),
  ativa BOOLEAN DEFAULT true,
  sistema BOOLEAN DEFAULT false,
  criado_em TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(empresa_id, codigo)
)`,
`CREATE TABLE IF NOT EXISTS periodo_contabilistico (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  ano INTEGER NOT NULL,
  mes INTEGER NOT NULL,
  descricao VARCHAR(100),
  estado VARCHAR(20) DEFAULT 'aberto',
  fechado_em TIMESTAMPTZ,
  fechado_por UUID REFERENCES utilizador(id),
  UNIQUE(empresa_id, ano, mes)
)`,
`CREATE TABLE IF NOT EXISTS lancamento (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  periodo_id UUID REFERENCES periodo_contabilistico(id),
  numero VARCHAR(30),
  data_lancamento DATE NOT NULL DEFAULT CURRENT_DATE,
  descricao VARCHAR(300) NOT NULL,
  diario VARCHAR(20) DEFAULT 'OD',
  documento_ref VARCHAR(100),
  tipo_origem VARCHAR(30),
  origem_id UUID,
  estado VARCHAR(20) DEFAULT 'rascunho',
  criado_por UUID REFERENCES utilizador(id),
  criado_em TIMESTAMPTZ DEFAULT NOW()
)`,
`CREATE TABLE IF NOT EXISTS lancamento_linha (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lancamento_id UUID NOT NULL REFERENCES lancamento(id) ON DELETE CASCADE,
  conta_id UUID NOT NULL REFERENCES conta_snc(id),
  conta_codigo VARCHAR(20) NOT NULL,
  conta_descricao VARCHAR(200),
  debito NUMERIC(14,2) DEFAULT 0,
  credito NUMERIC(14,2) DEFAULT 0,
  descricao VARCHAR(300),
  ordem INTEGER DEFAULT 1
)`,
`CREATE INDEX IF NOT EXISTS idx_lancamento_empresa ON lancamento(empresa_id)`,
`CREATE INDEX IF NOT EXISTS idx_lancamento_data ON lancamento(data_lancamento)`,
`CREATE INDEX IF NOT EXISTS idx_linha_conta ON lancamento_linha(conta_id)`,
`CREATE INDEX IF NOT EXISTS idx_linha_lancamento ON lancamento_linha(lancamento_id)`,
];

async function migrar() {
  const client = await pool.connect();
  try {
    console.log('🔄 migrate_v9: Contabilidade SNC...');
    for (const sql of migrations) await client.query(sql);
    console.log('✅ migrate_v9: concluído.');
  } catch(e) {
    console.error('❌ migrate_v9:', e.message);
    throw e;
  } finally {
    client.release(); }
}

module.exports = { migrar };
if (require.main === module) migrar().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
