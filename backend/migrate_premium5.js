'use strict';
require('dotenv').config();
const { query } = require('./src/config/database');

async function migrate() {
  console.log('🔧 Turnos + Orçamentos + 2FA + Contratos — Migração...');

  // Turnos
  await query(`CREATE TABLE IF NOT EXISTS turno (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
    funcionario_id UUID NOT NULL REFERENCES funcionario(id) ON DELETE CASCADE,
    data DATE NOT NULL,
    hora_inicio TIME NOT NULL,
    hora_fim TIME NOT NULL,
    tipo VARCHAR(20) DEFAULT 'normal',
    notas TEXT,
    estado VARCHAR(20) DEFAULT 'publicado',
    criado_em TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(funcionario_id, data, hora_inicio)
  )`);

  await query(`CREATE TABLE IF NOT EXISTS turno_padrao (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
    nome VARCHAR(100) NOT NULL,
    hora_inicio TIME NOT NULL,
    hora_fim TIME NOT NULL,
    dias_semana JSONB DEFAULT '[1,2,3,4,5]',
    cor VARCHAR(20) DEFAULT '#4F46E5',
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  // Orçamentos
  await query(`CREATE TABLE IF NOT EXISTS orcamento (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
    nome VARCHAR(200) NOT NULL,
    ano INTEGER NOT NULL,
    versao INTEGER DEFAULT 1,
    tipo VARCHAR(20) DEFAULT 'anual',
    estado VARCHAR(20) DEFAULT 'rascunho',
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS orcamento_linha (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    orcamento_id UUID NOT NULL REFERENCES orcamento(id) ON DELETE CASCADE,
    empresa_id UUID NOT NULL,
    categoria VARCHAR(100),
    descricao TEXT,
    tipo VARCHAR(20) DEFAULT 'custo',
    centro_custo_id UUID,
    valor NUMERIC(14,2) DEFAULT 0,
    jan NUMERIC(12,2) DEFAULT 0, fev NUMERIC(12,2) DEFAULT 0,
    mar NUMERIC(12,2) DEFAULT 0, abr NUMERIC(12,2) DEFAULT 0,
    mai NUMERIC(12,2) DEFAULT 0, jun NUMERIC(12,2) DEFAULT 0,
    jul NUMERIC(12,2) DEFAULT 0, ago NUMERIC(12,2) DEFAULT 0,
    set NUMERIC(12,2) DEFAULT 0, out NUMERIC(12,2) DEFAULT 0,
    nov NUMERIC(12,2) DEFAULT 0, dez NUMERIC(12,2) DEFAULT 0,
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  // 2FA
  await query(`ALTER TABLE utilizador ADD COLUMN IF NOT EXISTS twofa_ativo BOOLEAN DEFAULT false`);
  await query(`ALTER TABLE utilizador ADD COLUMN IF NOT EXISTS twofa_secret VARCHAR(64)`);
  await query(`ALTER TABLE utilizador ADD COLUMN IF NOT EXISTS twofa_secret_temp VARCHAR(64)`);
  await query(`ALTER TABLE utilizador ADD COLUMN IF NOT EXISTS twofa_backup_codes JSONB`);

  // Preferência turno
  await query(`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS preferencia_turno VARCHAR(20) DEFAULT 'manha'`);
  await query(`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS horas_semanais INTEGER DEFAULT 40`);

  await query(`CREATE INDEX IF NOT EXISTS idx_turno_empresa ON turno(empresa_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_turno_func ON turno(funcionario_id, data)`);

  console.log('✅ Premium 5 migrado!');
  process.exit(0);
}
migrate().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
