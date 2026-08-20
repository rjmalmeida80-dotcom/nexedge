'use strict';
const { pool } = require('./database');

const migrations = [

// ══════════════════════════════════════════════════════════════════════════════
// CLIENTES
// ══════════════════════════════════════════════════════════════════════════════
`CREATE TABLE IF NOT EXISTS cliente (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id      UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  nome            VARCHAR(200) NOT NULL,
  nif             VARCHAR(20),
  email           VARCHAR(150),
  telefone        VARCHAR(20),
  morada          TEXT,
  codigo_postal   VARCHAR(8),
  localidade      VARCHAR(100),
  pais            VARCHAR(2) DEFAULT 'PT',
  ativo           BOOLEAN DEFAULT true,
  notas           TEXT,
  criado_em       TIMESTAMPTZ DEFAULT NOW()
)`,

// ══════════════════════════════════════════════════════════════════════════════
// SÉRIES DE FATURAÇÃO (comunicadas à AT)
// ══════════════════════════════════════════════════════════════════════════════
`CREATE TABLE IF NOT EXISTS serie_faturacao (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id      UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  tipo_doc        VARCHAR(10) NOT NULL, -- FT, FR, NC, ND, RC
  serie           VARCHAR(20) NOT NULL, -- ex: 2025A
  ultimo_numero   INTEGER DEFAULT 0,
  codigo_validacao VARCHAR(50), -- código devolvido pela AT
  ativa           BOOLEAN DEFAULT true,
  criado_em       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(empresa_id, tipo_doc, serie)
)`,

// ══════════════════════════════════════════════════════════════════════════════
// FATURAS
// ══════════════════════════════════════════════════════════════════════════════
`CREATE TABLE IF NOT EXISTS fatura (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id      UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  cliente_id      UUID REFERENCES cliente(id),
  serie_id        UUID REFERENCES serie_faturacao(id),

  -- Identificação
  tipo_doc        VARCHAR(10) NOT NULL DEFAULT 'FT', -- FT FR NC ND RC
  serie           VARCHAR(20) NOT NULL,
  numero          INTEGER NOT NULL,
  numero_completo VARCHAR(50) NOT NULL, -- ex: FT 2025A/1
  atcud           VARCHAR(100), -- ATCUD:codigo-numero

  -- Datas
  data_emissao    DATE NOT NULL DEFAULT CURRENT_DATE,
  data_vencimento DATE,

  -- Cliente (snapshot no momento da emissão)
  cliente_nome    VARCHAR(200),
  cliente_nif     VARCHAR(20),
  cliente_morada  TEXT,
  cliente_pais    VARCHAR(2) DEFAULT 'PT',

  -- Valores
  subtotal        NUMERIC(12,2) DEFAULT 0,
  desconto        NUMERIC(12,2) DEFAULT 0,
  base_iva        NUMERIC(12,2) DEFAULT 0,
  iva_total       NUMERIC(12,2) DEFAULT 0,
  total           NUMERIC(12,2) DEFAULT 0,
  retencao        NUMERIC(12,2) DEFAULT 0,
  total_pagar     NUMERIC(12,2) DEFAULT 0,

  -- Estado
  estado          VARCHAR(20) DEFAULT 'rascunho', -- rascunho, emitida, paga, anulada
  hash            VARCHAR(172), -- hash RSA
  hash_anterior   VARCHAR(172),
  pdf_url         TEXT,

  -- Referências
  fatura_origem_id UUID REFERENCES fatura(id), -- para notas de crédito
  notas           TEXT,
  criado_por      UUID REFERENCES utilizador(id),
  criado_em       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(empresa_id, tipo_doc, serie, numero)
)`,

// ══════════════════════════════════════════════════════════════════════════════
// LINHAS DA FATURA
// ══════════════════════════════════════════════════════════════════════════════
`CREATE TABLE IF NOT EXISTS fatura_linha (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fatura_id       UUID NOT NULL REFERENCES fatura(id) ON DELETE CASCADE,
  descricao       VARCHAR(300) NOT NULL,
  quantidade      NUMERIC(10,3) DEFAULT 1,
  preco_unitario  NUMERIC(12,4) NOT NULL,
  desconto_perc   NUMERIC(5,2) DEFAULT 0,
  taxa_iva        NUMERIC(5,2) DEFAULT 23,
  motivo_isencao  VARCHAR(100), -- ex: M09 - serviços isentos
  subtotal        NUMERIC(12,2) NOT NULL,
  iva_valor       NUMERIC(12,2) NOT NULL,
  total           NUMERIC(12,2) NOT NULL,
  ordem           INTEGER DEFAULT 1
)`,

// Chaves RSA para hash das faturas
`ALTER TABLE empresa ADD COLUMN IF NOT EXISTS chave_privada_rsa TEXT`,
`ALTER TABLE empresa ADD COLUMN IF NOT EXISTS chave_publica_rsa TEXT`,
`ALTER TABLE empresa ADD COLUMN IF NOT EXISTS cert_at_numero VARCHAR(50)`,


// ══════════════════════════════════════════════════════════════════════════════
// PAGAMENTOS DE FATURAS
// ══════════════════════════════════════════════════════════════════════════════
`CREATE TABLE IF NOT EXISTS fatura_pagamento (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fatura_id       UUID NOT NULL REFERENCES fatura(id) ON DELETE CASCADE,
  empresa_id      UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  data_pagamento  DATE NOT NULL DEFAULT CURRENT_DATE,
  valor           NUMERIC(12,2) NOT NULL,
  metodo          VARCHAR(30) DEFAULT 'transferencia',
  referencia      VARCHAR(100),
  notas           TEXT,
  criado_por      UUID REFERENCES utilizador(id),
  criado_em       TIMESTAMPTZ DEFAULT NOW()
)`,

// ══════════════════════════════════════════════════════════════════════════════
// FATURAS RECORRENTES
// ══════════════════════════════════════════════════════════════════════════════
`CREATE TABLE IF NOT EXISTS fatura_recorrente (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id      UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  cliente_id      UUID REFERENCES cliente(id),
  serie_id        UUID REFERENCES serie_faturacao(id),
  tipo_doc        VARCHAR(10) DEFAULT 'FT',
  serie           VARCHAR(20) NOT NULL,
  descricao       VARCHAR(200) NOT NULL,
  linhas          JSONB NOT NULL DEFAULT '[]',
  dia_emissao     INTEGER DEFAULT 1,
  dias_vencimento INTEGER DEFAULT 30,
  proxima_emissao DATE,
  ativa           BOOLEAN DEFAULT true,
  ultima_emissao  DATE,
  total_emitido   INTEGER DEFAULT 0,
  criado_em       TIMESTAMPTZ DEFAULT NOW()
)`,

// Campos extra na fatura
`ALTER TABLE fatura ADD COLUMN IF NOT EXISTS valor_pago NUMERIC(12,2) DEFAULT 0`,
`ALTER TABLE fatura ADD COLUMN IF NOT EXISTS data_pagamento DATE`,
`ALTER TABLE fatura ADD COLUMN IF NOT EXISTS metodo_pagamento VARCHAR(30)`,
`ALTER TABLE fatura ADD COLUMN IF NOT EXISTS enviada_email BOOLEAN DEFAULT false`,
`ALTER TABLE fatura ADD COLUMN IF NOT EXISTS data_envio_email TIMESTAMPTZ`,
`ALTER TABLE fatura ADD COLUMN IF NOT EXISTS incluida_saft BOOLEAN DEFAULT false`,
`ALTER TABLE fatura ADD COLUMN IF NOT EXISTS qr_code TEXT`,
`ALTER TABLE fatura ADD COLUMN IF NOT EXISTS referencia_mb VARCHAR(50)`,
`ALTER TABLE fatura ADD COLUMN IF NOT EXISTS moeda VARCHAR(3) DEFAULT 'EUR'`,
`ALTER TABLE fatura ADD COLUMN IF NOT EXISTS taxa_cambio NUMERIC(10,6) DEFAULT 1`,
];

async function migrar() {
  const client = await pool.connect();
  try {
    console.log('🔄 migrate_v6: Faturação AT...');
    for (const sql of migrations) {
      await client.query(sql);
    }
    console.log('✅ migrate_v6: concluído.');
  } catch(e) {
    console.error('❌ migrate_v6:', e.message);
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { migrar };
if (require.main === module) migrar().then(() => process.exit(0)).catch(() => process.exit(1));
