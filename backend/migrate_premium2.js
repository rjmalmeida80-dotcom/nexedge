'use strict';
require('dotenv').config();
const { query } = require('./src/config/database');

async function migrate() {
  console.log('🔧 OKRs + 360 Feedback + Activos Fixos — Migração...');

  // OKRs
  await query(`CREATE TABLE IF NOT EXISTS okr_objectivo (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
    titulo VARCHAR(300) NOT NULL,
    descricao TEXT,
    nivel VARCHAR(20) DEFAULT 'empresa' CHECK (nivel IN ('empresa','equipa','individual')),
    ciclo VARCHAR(20),
    data_inicio DATE, data_fim DATE,
    responsavel_id UUID REFERENCES utilizador(id),
    objectivo_pai_id UUID REFERENCES okr_objectivo(id),
    progresso INTEGER DEFAULT 0,
    estado VARCHAR(20) DEFAULT 'activo',
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS okr_key_result (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    objectivo_id UUID NOT NULL REFERENCES okr_objectivo(id) ON DELETE CASCADE,
    empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
    titulo VARCHAR(300) NOT NULL,
    valor_inicial NUMERIC(14,2) DEFAULT 0,
    valor_actual NUMERIC(14,2) DEFAULT 0,
    valor_alvo NUMERIC(14,2) NOT NULL,
    unidade VARCHAR(30) DEFAULT '%',
    progresso INTEGER DEFAULT 0,
    ordem INTEGER DEFAULT 0,
    ultima_actualizacao TIMESTAMPTZ,
    notas TEXT,
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS okr_checkin (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    objectivo_id UUID NOT NULL REFERENCES okr_objectivo(id) ON DELETE CASCADE,
    empresa_id UUID NOT NULL,
    utilizador_id UUID REFERENCES utilizador(id),
    confianca INTEGER DEFAULT 3 CHECK (confianca BETWEEN 1 AND 5),
    notas TEXT, bloqueios TEXT,
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  // 360 Feedback
  await query(`CREATE TABLE IF NOT EXISTS avaliacao_ciclo (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
    nome VARCHAR(200) NOT NULL, tipo VARCHAR(20) DEFAULT '360',
    data_inicio DATE, data_fim DATE,
    competencias JSONB DEFAULT '[]',
    anonimo BOOLEAN DEFAULT true, auto_avaliacao BOOLEAN DEFAULT true,
    estado VARCHAR(20) DEFAULT 'planeamento',
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS avaliacao_360 (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ciclo_id UUID NOT NULL REFERENCES avaliacao_ciclo(id) ON DELETE CASCADE,
    empresa_id UUID NOT NULL,
    avaliador_id UUID REFERENCES utilizador(id),
    avaliado_id UUID REFERENCES funcionario(id),
    tipo_relacao VARCHAR(20) DEFAULT 'par',
    respostas JSONB DEFAULT '{}',
    comentario_geral TEXT,
    estado VARCHAR(20) DEFAULT 'pendente',
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS pdi (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
    funcionario_id UUID NOT NULL REFERENCES funcionario(id),
    avaliacao_id UUID,
    objetivos_desenvolvimento TEXT,
    acoes JSONB DEFAULT '[]',
    recursos TEXT,
    prazo DATE,
    estado VARCHAR(20) DEFAULT 'activo',
    criado_em TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(empresa_id, funcionario_id)
  )`);

  // Activos Fixos
  await query(`CREATE TABLE IF NOT EXISTS activo_fixo (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
    nome VARCHAR(300) NOT NULL,
    descricao TEXT,
    categoria VARCHAR(50) DEFAULT 'equipamento',
    fornecedor_id UUID,
    numero_serie VARCHAR(100),
    data_aquisicao DATE NOT NULL,
    valor_aquisicao NUMERIC(14,2) NOT NULL,
    valor_residual NUMERIC(14,2) DEFAULT 0,
    vida_util_anos INTEGER DEFAULT 5,
    taxa_depreciacao NUMERIC(6,3),
    metodo_depreciacao VARCHAR(20) DEFAULT 'linear',
    localizacao VARCHAR(200),
    responsavel_id UUID,
    estado VARCHAR(20) DEFAULT 'activo',
    data_abate DATE,
    motivo_abate TEXT,
    cod_contabilistico VARCHAR(20) DEFAULT '432',
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS depreciacao_lancamento (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL,
    activo_id UUID NOT NULL REFERENCES activo_fixo(id) ON DELETE CASCADE,
    periodo VARCHAR(7) NOT NULL,
    valor NUMERIC(12,2) NOT NULL,
    metodo VARCHAR(20),
    estado VARCHAR(20) DEFAULT 'lancado',
    criado_em TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(empresa_id, activo_id, periodo)
  )`);

  await query(`CREATE INDEX IF NOT EXISTS idx_okr_empresa ON okr_objectivo(empresa_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_avaliacao_empresa ON avaliacao_360(empresa_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_activo_empresa ON activo_fixo(empresa_id)`);

  console.log('✅ OKRs + 360 Feedback + Activos Fixos migrados!');
  process.exit(0);
}
migrate().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
