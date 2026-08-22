'use strict';
require('dotenv').config();
const { query } = require('./src/config/database');

async function migrate() {
  console.log('🔧 Time Tracking — Migração...');

  await query(`
    CREATE TABLE IF NOT EXISTS projeto (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
      nome VARCHAR(200) NOT NULL,
      descricao TEXT,
      cliente_id UUID,
      responsavel_id UUID REFERENCES utilizador(id),
      estado VARCHAR(20) DEFAULT 'ativo' CHECK (estado IN ('ativo','pausado','concluido','cancelado')),
      data_inicio DATE,
      data_fim_prevista DATE,
      data_fim_real DATE,
      orcamento_horas NUMERIC(10,2),
      valor_hora NUMERIC(10,2) DEFAULT 0,
      cor VARCHAR(20) DEFAULT '#4F46E5',
      tags JSONB DEFAULT '[]',
      criado_em TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS time_entry (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
      projeto_id UUID REFERENCES projeto(id),
      funcionario_id UUID REFERENCES funcionario(id),
      utilizador_id UUID REFERENCES utilizador(id),
      descricao TEXT,
      data DATE NOT NULL DEFAULT CURRENT_DATE,
      hora_inicio TIME,
      hora_fim TIME,
      duracao_min INTEGER NOT NULL DEFAULT 0,
      faturavel BOOLEAN DEFAULT true,
      faturado BOOLEAN DEFAULT false,
      fatura_id UUID,
      tags JSONB DEFAULT '[]',
      criado_em TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`CREATE INDEX IF NOT EXISTS idx_time_entry_projeto ON time_entry(projeto_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_time_entry_funcionario ON time_entry(funcionario_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_time_entry_data ON time_entry(data DESC)`);

  console.log('✅ Time Tracking migrado!');
  process.exit(0);
}

migrate().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
