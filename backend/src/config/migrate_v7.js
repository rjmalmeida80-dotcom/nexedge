'use strict';
const { pool } = require('./database');

const migrations = [
`CREATE TABLE IF NOT EXISTS fornecedor (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  nome VARCHAR(200) NOT NULL,
  nif VARCHAR(20),
  email VARCHAR(150),
  telefone VARCHAR(20),
  morada TEXT,
  codigo_postal VARCHAR(8),
  localidade VARCHAR(100),
  pais VARCHAR(2) DEFAULT 'PT',
  iban VARCHAR(34),
  banco VARCHAR(100),
  condicoes_pagamento INTEGER DEFAULT 30,
  categoria VARCHAR(50),
  ativo BOOLEAN DEFAULT true,
  notas TEXT,
  criado_em TIMESTAMPTZ DEFAULT NOW()
)`,
`CREATE TABLE IF NOT EXISTS artigo_categoria (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  nome VARCHAR(100) NOT NULL,
  descricao TEXT,
  criado_em TIMESTAMPTZ DEFAULT NOW()
)`,
`CREATE TABLE IF NOT EXISTS artigo (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  categoria_id UUID REFERENCES artigo_categoria(id),
  codigo VARCHAR(50),
  nome VARCHAR(200) NOT NULL,
  descricao TEXT,
  tipo VARCHAR(20) DEFAULT 'produto',
  unidade VARCHAR(20) DEFAULT 'un',
  preco_venda NUMERIC(12,4) DEFAULT 0,
  preco_custo NUMERIC(12,4) DEFAULT 0,
  taxa_iva_venda NUMERIC(5,2) DEFAULT 23,
  taxa_iva_compra NUMERIC(5,2) DEFAULT 23,
  stock_atual NUMERIC(10,3) DEFAULT 0,
  stock_minimo NUMERIC(10,3) DEFAULT 0,
  stock_maximo NUMERIC(10,3) DEFAULT 0,
  localizacao VARCHAR(100),
  ativo BOOLEAN DEFAULT true,
  criado_em TIMESTAMPTZ DEFAULT NOW()
)`,
`CREATE TABLE IF NOT EXISTS compra (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  fornecedor_id UUID REFERENCES fornecedor(id),
  numero_doc VARCHAR(50),
  tipo_doc VARCHAR(20) DEFAULT 'fatura',
  data_emissao DATE NOT NULL DEFAULT CURRENT_DATE,
  data_vencimento DATE,
  fornecedor_nome VARCHAR(200),
  fornecedor_nif VARCHAR(20),
  subtotal NUMERIC(12,2) DEFAULT 0,
  iva_total NUMERIC(12,2) DEFAULT 0,
  total NUMERIC(12,2) DEFAULT 0,
  valor_pago NUMERIC(12,2) DEFAULT 0,
  estado VARCHAR(20) DEFAULT 'pendente',
  metodo_pagamento VARCHAR(30),
  data_pagamento DATE,
  categoria_despesa VARCHAR(50),
  notas TEXT,
  criado_por UUID REFERENCES utilizador(id),
  criado_em TIMESTAMPTZ DEFAULT NOW()
)`,
`CREATE TABLE IF NOT EXISTS compra_linha (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  compra_id UUID NOT NULL REFERENCES compra(id) ON DELETE CASCADE,
  artigo_id UUID REFERENCES artigo(id),
  descricao VARCHAR(300) NOT NULL,
  quantidade NUMERIC(10,3) DEFAULT 1,
  preco_unitario NUMERIC(12,4) NOT NULL,
  desconto_perc NUMERIC(5,2) DEFAULT 0,
  taxa_iva NUMERIC(5,2) DEFAULT 23,
  subtotal NUMERIC(12,2) NOT NULL,
  iva_valor NUMERIC(12,2) NOT NULL,
  total NUMERIC(12,2) NOT NULL,
  ordem INTEGER DEFAULT 1,
  actualiza_stock BOOLEAN DEFAULT true
)`,
`CREATE TABLE IF NOT EXISTS stock_movimento (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  artigo_id UUID NOT NULL REFERENCES artigo(id) ON DELETE CASCADE,
  tipo VARCHAR(20) NOT NULL,
  quantidade NUMERIC(10,3) NOT NULL,
  quantidade_anterior NUMERIC(10,3) DEFAULT 0,
  quantidade_nova NUMERIC(10,3) DEFAULT 0,
  preco_unitario NUMERIC(12,4) DEFAULT 0,
  referencia_tipo VARCHAR(20),
  referencia_id UUID,
  notas TEXT,
  criado_por UUID REFERENCES utilizador(id),
  criado_em TIMESTAMPTZ DEFAULT NOW()
)`,
];

async function migrar() {
  const client = await pool.connect();
  try {
    console.log('🔄 migrate_v7: Fornecedores, Compras, Stocks...');
    for (const sql of migrations) await client.query(sql);
    console.log('✅ migrate_v7: concluído.');
  } catch(e) {
    console.error('❌ migrate_v7:', e.message);
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { migrar };
if (require.main === module) migrar().then(() => process.exit(0)).catch(() => process.exit(1));
