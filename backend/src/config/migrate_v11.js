'use strict';
const { pool } = require('./database');

const migrations = [
`CREATE TABLE IF NOT EXISTS viatura (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  matricula VARCHAR(20) NOT NULL,
  marca VARCHAR(50),
  modelo VARCHAR(100),
  ano INTEGER,
  tipo VARCHAR(20) DEFAULT 'ligeiro_passageiros',
  combustivel VARCHAR(20) DEFAULT 'gasolina',
  cor VARCHAR(30),
  numero_quadro VARCHAR(50),
  numero_motor VARCHAR(50),
  potencia_cv INTEGER,
  cilindrada INTEGER,
  lugares INTEGER DEFAULT 5,
  peso_bruto NUMERIC(8,2),
  ativo_fixo_id UUID REFERENCES ativo_fixo(id),
  condutor_id UUID REFERENCES funcionario(id),
  localizacao VARCHAR(100),
  km_actuais INTEGER DEFAULT 0,
  km_proxima_manutencao INTEGER,
  estado VARCHAR(20) DEFAULT 'ativo',
  notas TEXT,
  criado_em TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(empresa_id, matricula)
)`,
`CREATE TABLE IF NOT EXISTS viatura_seguro (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  viatura_id UUID NOT NULL REFERENCES viatura(id) ON DELETE CASCADE,
  empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  seguradora VARCHAR(100) NOT NULL,
  numero_apolice VARCHAR(50),
  tipo VARCHAR(30) DEFAULT 'responsabilidade_civil',
  data_inicio DATE NOT NULL,
  data_fim DATE NOT NULL,
  premio_anual NUMERIC(10,2),
  contacto_seguradora VARCHAR(100),
  notas TEXT,
  criado_em TIMESTAMPTZ DEFAULT NOW()
)`,
`CREATE TABLE IF NOT EXISTS viatura_inspecao (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  viatura_id UUID NOT NULL REFERENCES viatura(id) ON DELETE CASCADE,
  empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  tipo VARCHAR(20) DEFAULT 'ipt',
  data_inspecao DATE NOT NULL,
  data_proxima DATE,
  resultado VARCHAR(20) DEFAULT 'aprovado',
  km_inspecao INTEGER,
  centro_inspecao VARCHAR(100),
  custo NUMERIC(8,2),
  notas TEXT,
  criado_em TIMESTAMPTZ DEFAULT NOW()
)`,
`CREATE TABLE IF NOT EXISTS viatura_manutencao (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  viatura_id UUID NOT NULL REFERENCES viatura(id) ON DELETE CASCADE,
  empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  tipo VARCHAR(50) NOT NULL,
  data_manutencao DATE NOT NULL,
  km_manutencao INTEGER,
  km_proxima INTEGER,
  data_proxima DATE,
  fornecedor VARCHAR(100),
  custo NUMERIC(10,2),
  descricao TEXT,
  criado_em TIMESTAMPTZ DEFAULT NOW()
)`,
`CREATE TABLE IF NOT EXISTS viatura_abastecimento (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  viatura_id UUID NOT NULL REFERENCES viatura(id) ON DELETE CASCADE,
  empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  condutor_id UUID REFERENCES funcionario(id),
  data_abastecimento DATE NOT NULL DEFAULT CURRENT_DATE,
  litros NUMERIC(8,3),
  preco_litro NUMERIC(8,4),
  valor_total NUMERIC(10,2),
  km_abastecimento INTEGER,
  posto VARCHAR(100),
  tipo_combustivel VARCHAR(20),
  criado_em TIMESTAMPTZ DEFAULT NOW()
)`,
`CREATE TABLE IF NOT EXISTS viatura_km (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  viatura_id UUID NOT NULL REFERENCES viatura(id) ON DELETE CASCADE,
  empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  condutor_id UUID REFERENCES funcionario(id),
  data DATE NOT NULL DEFAULT CURRENT_DATE,
  km_inicio INTEGER,
  km_fim INTEGER,
  km_percorridos INTEGER,
  destino VARCHAR(200),
  motivo VARCHAR(200),
  criado_em TIMESTAMPTZ DEFAULT NOW()
)`,
`CREATE INDEX IF NOT EXISTS idx_viatura_empresa ON viatura(empresa_id)`,
`CREATE INDEX IF NOT EXISTS idx_seguro_viatura ON viatura_seguro(viatura_id)`,
`CREATE INDEX IF NOT EXISTS idx_manut_viatura ON viatura_manutencao(viatura_id)`,
];

async function migrar() {
  const client = await pool.connect();
  try {
    console.log('🔄 migrate_v11: Gestão de Frota...');
    for (const sql of migrations) await client.query(sql);
    console.log('✅ migrate_v11: concluído.');
  } finally { client.release(); }
}

module.exports = { migrar };
if (require.main === module) migrar().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
