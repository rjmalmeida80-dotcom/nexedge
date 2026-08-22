'use strict';
require('dotenv').config();
const { query } = require('./src/config/database');

async function migrate() {
  console.log('🔧 Módulo de Logística — Migração...');

  // Motoristas
  await query(`CREATE TABLE IF NOT EXISTS logistica_motorista (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
    nome VARCHAR(200) NOT NULL,
    email VARCHAR(200),
    telefone VARCHAR(30),
    licenca VARCHAR(50),
    pais VARCHAR(2) DEFAULT 'PT',
    veiculo_id UUID,
    estado VARCHAR(20) DEFAULT 'disponivel' CHECK (estado IN ('disponivel','em_rota','pausa','inactivo')),
    latitude_actual NUMERIC(10,7),
    longitude_actual NUMERIC(10,7),
    ultima_posicao TIMESTAMPTZ,
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  // Veículos
  await query(`CREATE TABLE IF NOT EXISTS logistica_veiculo (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
    matricula VARCHAR(20) NOT NULL,
    modelo VARCHAR(100),
    tipo VARCHAR(30) DEFAULT 'furgao' CHECK (tipo IN ('moto','carro','furgao','camiao_pequeno','camiao','semi_reboque')),
    capacidade_kg NUMERIC(10,2) DEFAULT 1000,
    capacidade_m3 NUMERIC(8,2) DEFAULT 10,
    pais VARCHAR(2) DEFAULT 'PT',
    estado VARCHAR(20) DEFAULT 'disponivel',
    criado_em TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(empresa_id, matricula)
  )`);

  // Encomendas
  await query(`CREATE TABLE IF NOT EXISTS logistica_encomenda (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
    numero VARCHAR(30) NOT NULL UNIQUE,
    cliente_id UUID,
    origem VARCHAR(30) DEFAULT 'manual',
    remetente_nome VARCHAR(200),
    remetente_morada TEXT,
    remetente_pais VARCHAR(2) DEFAULT 'PT',
    remetente_telefone VARCHAR(30),
    destinatario_nome VARCHAR(200) NOT NULL,
    destinatario_morada TEXT,
    destinatario_codigo_postal VARCHAR(20),
    destinatario_localidade VARCHAR(100),
    destinatario_pais VARCHAR(2) DEFAULT 'PT',
    destinatario_telefone VARCHAR(30),
    destinatario_email VARCHAR(200),
    peso_kg NUMERIC(10,3) DEFAULT 0,
    volume_m3 NUMERIC(8,4) DEFAULT 0,
    num_volumes INTEGER DEFAULT 1,
    instrucoes_especiais TEXT,
    prioridade VARCHAR(20) DEFAULT 'normal' CHECK (prioridade IN ('urgente','alta','normal','baixa')),
    valor_mercadoria NUMERIC(12,2) DEFAULT 0,
    moeda VARCHAR(3) DEFAULT 'EUR',
    motorista_id UUID,
    rota_id UUID,
    recolha_id UUID,
    estado VARCHAR(30) DEFAULT 'nova',
    estado_anterior VARCHAR(30),
    data_recolha_prevista TIMESTAMPTZ,
    data_entrega_prevista TIMESTAMPTZ,
    data_entrega_real TIMESTAMPTZ,
    latitude_ultima_pos NUMERIC(10,7),
    longitude_ultima_pos NUMERIC(10,7),
    notas_operador TEXT,
    workflow_config JSONB DEFAULT '{}',
    campos_extra JSONB DEFAULT '{}',
    actualizado_em TIMESTAMPTZ DEFAULT NOW(),
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  // Histórico de estados
  await query(`CREATE TABLE IF NOT EXISTS logistica_historico (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    encomenda_id UUID NOT NULL REFERENCES logistica_encomenda(id) ON DELETE CASCADE,
    empresa_id UUID NOT NULL,
    estado VARCHAR(30),
    notas TEXT,
    utilizador_id UUID,
    latitude NUMERIC(10,7),
    longitude NUMERIC(10,7),
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  // Recolhas
  await query(`CREATE TABLE IF NOT EXISTS logistica_recolha (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
    cliente_id UUID,
    morada_recolha TEXT NOT NULL,
    contacto_nome VARCHAR(200),
    contacto_telefone VARCHAR(30),
    data_recolha DATE NOT NULL,
    janela_inicio TIME DEFAULT '09:00',
    janela_fim TIME DEFAULT '18:00',
    motorista_id UUID,
    veiculo_id UUID,
    num_volumes_estimado INTEGER DEFAULT 1,
    peso_estimado_kg NUMERIC(10,2) DEFAULT 0,
    instrucoes TEXT,
    prioridade VARCHAR(20) DEFAULT 'normal',
    estado VARCHAR(20) DEFAULT 'agendada',
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  // Rotas
  await query(`CREATE TABLE IF NOT EXISTS logistica_rota (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
    motorista_id UUID REFERENCES logistica_motorista(id),
    nome VARCHAR(200),
    data_rota DATE NOT NULL,
    estado VARCHAR(20) DEFAULT 'planeada',
    num_paragens INTEGER DEFAULT 0,
    distancia_estimada_km NUMERIC(8,2),
    tempo_estimado_min INTEGER,
    distancia_real_km NUMERIC(8,2),
    optimizada_ia BOOLEAN DEFAULT false,
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  // Paragens da rota
  await query(`CREATE TABLE IF NOT EXISTS logistica_paragem (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rota_id UUID NOT NULL REFERENCES logistica_rota(id) ON DELETE CASCADE,
    empresa_id UUID NOT NULL,
    encomenda_id UUID REFERENCES logistica_encomenda(id),
    ordem INTEGER NOT NULL,
    estado VARCHAR(20) DEFAULT 'pendente',
    chegada_real TIMESTAMPTZ,
    saida_real TIMESTAMPTZ,
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  // POD — Prova de Entrega
  await query(`CREATE TABLE IF NOT EXISTS logistica_pod (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    encomenda_id UUID NOT NULL REFERENCES logistica_encomenda(id) ON DELETE CASCADE UNIQUE,
    empresa_id UUID NOT NULL,
    recebido_por VARCHAR(200) NOT NULL,
    assinatura_base64 TEXT,
    foto_base64 TEXT,
    latitude NUMERIC(10,7),
    longitude NUMERIC(10,7),
    observacoes TEXT,
    hash_verificacao VARCHAR(64),
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  // Índices
  await query(`CREATE INDEX IF NOT EXISTS idx_log_enc_empresa ON logistica_encomenda(empresa_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_log_enc_estado ON logistica_encomenda(estado)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_log_enc_numero ON logistica_encomenda(numero)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_log_hist_enc ON logistica_historico(encomenda_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_log_rota_data ON logistica_rota(data_rota)`);

  // Adicionar FK motor -> veiculo
  await query(`ALTER TABLE logistica_motorista ADD COLUMN IF NOT EXISTS veiculo_id UUID REFERENCES logistica_veiculo(id)`).catch(()=>{});

  console.log('✅ Módulo de Logística migrado!');
  console.log('   Tabelas: logistica_motorista, logistica_veiculo, logistica_encomenda,');
  console.log('            logistica_historico, logistica_recolha, logistica_rota,');
  console.log('            logistica_paragem, logistica_pod');
  process.exit(0);
}
migrate().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
