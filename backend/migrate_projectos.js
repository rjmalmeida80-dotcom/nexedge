'use strict';
require('dotenv').config();
const { query } = require('./src/config/database');

async function migrate() {
  console.log('🔧 Módulo Projectos — Migração...');

  await query(`
    CREATE TABLE IF NOT EXISTS projecto (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
      nome VARCHAR(300) NOT NULL,
      descricao TEXT,
      cliente_id UUID,
      responsavel_id UUID REFERENCES utilizador(id),
      estado VARCHAR(30) DEFAULT 'planeamento' CHECK (estado IN ('planeamento','ativo','em_pausa','concluido','cancelado')),
      prioridade VARCHAR(20) DEFAULT 'media' CHECK (prioridade IN ('critica','alta','media','baixa')),
      data_inicio DATE,
      data_fim_prevista DATE,
      data_fim_real DATE,
      orcamento NUMERIC(12,2) DEFAULT 0,
      custo_actual NUMERIC(12,2) DEFAULT 0,
      valor_hora NUMERIC(10,2) DEFAULT 0,
      cor VARCHAR(20) DEFAULT '#4F46E5',
      tags JSONB DEFAULT '[]',
      criado_em TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS projecto_tarefa (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      projecto_id UUID NOT NULL REFERENCES projecto(id) ON DELETE CASCADE,
      tarefa_pai_id UUID REFERENCES projecto_tarefa(id),
      titulo VARCHAR(300) NOT NULL,
      descricao TEXT,
      responsavel_id UUID REFERENCES utilizador(id),
      estado VARCHAR(30) DEFAULT 'a_fazer' CHECK (estado IN ('a_fazer','em_progresso','em_revisao','concluida','cancelada','bloqueada')),
      prioridade VARCHAR(20) DEFAULT 'media',
      data_inicio_prevista DATE,
      data_fim_prevista DATE,
      data_conclusao DATE,
      estimativa_horas NUMERIC(8,2),
      horas_registadas NUMERIC(8,2) DEFAULT 0,
      ordem INTEGER DEFAULT 0,
      tags JSONB DEFAULT '[]',
      criado_em TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS projecto_milestone (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      projecto_id UUID NOT NULL REFERENCES projecto(id) ON DELETE CASCADE,
      titulo VARCHAR(200) NOT NULL,
      descricao TEXT,
      data_prevista DATE NOT NULL,
      data_conclusao DATE,
      estado VARCHAR(20) DEFAULT 'pendente' CHECK (estado IN ('pendente','concluido','em_risco','cancelado')),
      cor VARCHAR(20) DEFAULT '#4F46E5',
      criado_em TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS projecto_membro (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      projecto_id UUID NOT NULL REFERENCES projecto(id) ON DELETE CASCADE,
      utilizador_id UUID NOT NULL REFERENCES utilizador(id) ON DELETE CASCADE,
      papel VARCHAR(30) DEFAULT 'membro' CHECK (papel IN ('gestor','membro','observador','cliente')),
      criado_em TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(projecto_id, utilizador_id)
    )
  `);

  await query(`CREATE INDEX IF NOT EXISTS idx_proj_empresa ON projecto(empresa_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_tarefa_proj ON projecto_tarefa(projecto_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_milestone_proj ON projecto_milestone(projecto_id)`);

  // Adicionar projecto_id ao time_entry se não existir
  await query(`ALTER TABLE time_entry ADD COLUMN IF NOT EXISTS projeto_id UUID REFERENCES projecto(id)`).catch(()=>{});

  console.log('✅ Módulo Projectos migrado!');
  console.log('   Tabelas: projecto, projecto_tarefa, projecto_milestone, projecto_membro');
  process.exit(0);
}
migrate().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
