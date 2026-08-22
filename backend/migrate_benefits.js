'use strict';
require('dotenv').config();
const { query } = require('./src/config/database');

async function migrate() {
  console.log('🔧 Benefits Management — Migração...');

  await query(`
    CREATE TABLE IF NOT EXISTS beneficio (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
      nome VARCHAR(200) NOT NULL,
      tipo VARCHAR(50) NOT NULL CHECK (tipo IN (
        'subsidio_alimentacao','subsidio_transporte','subsidio_comunicacao',
        'seguro_saude','seguro_vida','seguro_acidentes',
        'ppr','plano_poupanca','acoes',
        'gimnasio','formacao','creche',
        'veiculo','telemovel','computador',
        'flexivel','outro'
      )),
      descricao TEXT,
      valor_mensal NUMERIC(10,2) DEFAULT 0,
      valor_anual NUMERIC(10,2) DEFAULT 0,
      tributavel BOOLEAN DEFAULT false,
      ativo BOOLEAN DEFAULT true,
      aplicar_a VARCHAR(20) DEFAULT 'todos' CHECK (aplicar_a IN ('todos','seleccionados','departamento')),
      departamentos JSONB DEFAULT '[]',
      criado_em TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS funcionario_beneficio (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      funcionario_id UUID NOT NULL REFERENCES funcionario(id) ON DELETE CASCADE,
      empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
      beneficio_id UUID NOT NULL REFERENCES beneficio(id) ON DELETE CASCADE,
      valor_custom NUMERIC(10,2),
      data_inicio DATE NOT NULL DEFAULT CURRENT_DATE,
      data_fim DATE,
      estado VARCHAR(20) DEFAULT 'ativo' CHECK (estado IN ('ativo','suspenso','terminado')),
      notas TEXT,
      criado_em TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(funcionario_id, beneficio_id, data_inicio)
    )
  `);

  await query(`CREATE INDEX IF NOT EXISTS idx_func_benef_func ON funcionario_beneficio(funcionario_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_func_benef_empresa ON funcionario_beneficio(empresa_id)`);

  console.log('✅ Benefits Management migrado!');
  process.exit(0);
}

migrate().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
