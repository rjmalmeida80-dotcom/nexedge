'use strict';
const { pool } = require('./database');

const migrations = [
`CREATE TABLE IF NOT EXISTS ativo_fixo (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  codigo VARCHAR(50),
  descricao VARCHAR(300) NOT NULL,
  categoria VARCHAR(100) NOT NULL,
  subcategoria VARCHAR(100),
  fornecedor_id UUID REFERENCES fornecedor(id),
  fornecedor_nome VARCHAR(200),
  numero_serie VARCHAR(100),
  numero_fatura VARCHAR(50),
  data_aquisicao DATE NOT NULL,
  data_inicio_uso DATE,
  valor_aquisicao NUMERIC(14,2) NOT NULL,
  valor_residual NUMERIC(14,2) DEFAULT 0,
  taxa_depreciacao NUMERIC(6,4) NOT NULL,
  metodo VARCHAR(20) DEFAULT 'quotas_constantes',
  vida_util_anos NUMERIC(5,2),
  depreciacao_acumulada NUMERIC(14,2) DEFAULT 0,
  valor_liquido NUMERIC(14,2),
  estado VARCHAR(20) DEFAULT 'ativo',
  localizacao VARCHAR(200),
  responsavel_id UUID REFERENCES funcionario(id),
  notas TEXT,
  criado_por UUID REFERENCES utilizador(id),
  criado_em TIMESTAMPTZ DEFAULT NOW()
)`,
`CREATE TABLE IF NOT EXISTS depreciacao_linha (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ativo_id UUID NOT NULL REFERENCES ativo_fixo(id) ON DELETE CASCADE,
  empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  ano INTEGER NOT NULL,
  valor_inicio_ano NUMERIC(14,2) NOT NULL,
  taxa_depreciacao NUMERIC(6,4) NOT NULL,
  valor_depreciacao NUMERIC(14,2) NOT NULL,
  depreciacao_acumulada NUMERIC(14,2) NOT NULL,
  valor_liquido_fim NUMERIC(14,2) NOT NULL,
  registado BOOLEAN DEFAULT false,
  criado_em TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(ativo_id, ano)
)`,
`CREATE INDEX IF NOT EXISTS idx_ativo_empresa ON ativo_fixo(empresa_id)`,
`CREATE INDEX IF NOT EXISTS idx_deprec_ativo ON depreciacao_linha(ativo_id)`,
];

async function migrar() {
  const client = await pool.connect();
  try {
    console.log('🔄 migrate_v8: Activos Fixos...');
    for (const sql of migrations) await client.query(sql);
    console.log('✅ migrate_v8: concluído.');
  } finally { client.release(); }
}

module.exports = { migrar };
if (require.main === module) migrar().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
