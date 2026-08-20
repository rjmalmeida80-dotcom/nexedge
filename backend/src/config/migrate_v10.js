'use strict';
const { pool } = require('./database');

const migrations = [
`CREATE TABLE IF NOT EXISTS despesa (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  funcionario_id UUID NOT NULL REFERENCES funcionario(id),
  data_despesa DATE NOT NULL DEFAULT CURRENT_DATE,
  categoria VARCHAR(50) NOT NULL,
  descricao VARCHAR(300) NOT NULL,
  valor NUMERIC(10,2) NOT NULL,
  iva_incluido BOOLEAN DEFAULT false,
  taxa_iva NUMERIC(5,2) DEFAULT 0,
  valor_iva NUMERIC(10,2) DEFAULT 0,
  valor_sem_iva NUMERIC(10,2),
  moeda VARCHAR(3) DEFAULT 'EUR',
  fornecedor VARCHAR(200),
  numero_documento VARCHAR(100),
  projeto VARCHAR(100),
  notas TEXT,
  recibo_url TEXT,
  estado VARCHAR(20) DEFAULT 'submetida',
  aprovado_por UUID REFERENCES utilizador(id),
  aprovado_em TIMESTAMPTZ,
  rejeitado_motivo TEXT,
  pago_em DATE,
  pago_no_salario_mes INTEGER,
  pago_no_salario_ano INTEGER,
  criado_por UUID REFERENCES utilizador(id),
  criado_em TIMESTAMPTZ DEFAULT NOW()
)`,
`CREATE TABLE IF NOT EXISTS politica_despesas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  categoria VARCHAR(50) NOT NULL,
  limite_por_despesa NUMERIC(10,2),
  limite_mensal NUMERIC(10,2),
  requer_recibo_acima NUMERIC(10,2) DEFAULT 0,
  iva_dedutivel_pct NUMERIC(5,2) DEFAULT 0,
  ativa BOOLEAN DEFAULT true,
  UNIQUE(empresa_id, categoria)
)`,
`CREATE INDEX IF NOT EXISTS idx_despesa_empresa ON despesa(empresa_id)`,
`CREATE INDEX IF NOT EXISTS idx_despesa_func ON despesa(funcionario_id)`,
`CREATE INDEX IF NOT EXISTS idx_despesa_estado ON despesa(estado)`,
];

async function migrar() {
  const client = await pool.connect();
  try {
    console.log('🔄 migrate_v10: Módulo de Despesas...');
    for (const sql of migrations) await client.query(sql);
    console.log('✅ migrate_v10: concluído.');
  } finally { client.release(); }
}

module.exports = { migrar };
if (require.main === module) migrar().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
