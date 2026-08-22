'use strict';
require('dotenv').config();
const { query } = require('./src/config/database');

async function migrate() {
  console.log('🔧 MediaLoop + Senhas — Migração...');

  // Localizações
  await query(`CREATE TABLE IF NOT EXISTS medialoop_localizacao (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
    nome VARCHAR(200) NOT NULL,
    morada TEXT, cidade VARCHAR(100), pais VARCHAR(2) DEFAULT 'PT',
    timezone VARCHAR(50) DEFAULT 'Europe/Lisbon',
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  // Ecrãs
  await query(`CREATE TABLE IF NOT EXISTS medialoop_ecra (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
    nome VARCHAR(200) NOT NULL,
    localizacao_id UUID REFERENCES medialoop_localizacao(id),
    tipo VARCHAR(20) DEFAULT 'tv' CHECK (tipo IN ('tv','monitor','tablet','quiosque','videowall')),
    resolucao VARCHAR(20) DEFAULT '1920x1080',
    orientacao VARCHAR(20) DEFAULT 'landscape' CHECK (orientacao IN ('landscape','portrait')),
    descricao TEXT,
    activation_code VARCHAR(10),
    device_token VARCHAR(64) UNIQUE,
    device_info JSONB DEFAULT '{}',
    playlist_activa_id UUID,
    layout_id UUID,
    estado VARCHAR(20) DEFAULT 'inactivo',
    ultimo_heartbeat TIMESTAMPTZ,
    conteudo_actual TEXT,
    versao_player VARCHAR(20),
    ip_actual VARCHAR(50),
    volume INTEGER DEFAULT 50,
    brilho INTEGER DEFAULT 80,
    activado_em TIMESTAMPTZ,
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  // Conteúdos
  await query(`CREATE TABLE IF NOT EXISTS medialoop_conteudo (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
    nome VARCHAR(200) NOT NULL,
    tipo VARCHAR(20) DEFAULT 'imagem' CHECK (tipo IN ('imagem','video','url','html','pdf','ticker','widget')),
    url TEXT NOT NULL,
    duracao_seg INTEGER DEFAULT 10,
    descricao TEXT,
    tags JSONB DEFAULT '[]',
    thumbnail_url TEXT,
    tamanho_bytes BIGINT DEFAULT 0,
    estado VARCHAR(20) DEFAULT 'activo',
    visualizacoes INTEGER DEFAULT 0,
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  // Playlists
  await query(`CREATE TABLE IF NOT EXISTS medialoop_playlist (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
    nome VARCHAR(200) NOT NULL,
    descricao TEXT,
    conteudos JSONB DEFAULT '[]',
    loop BOOLEAN DEFAULT true,
    ordem_aleatoria BOOLEAN DEFAULT false,
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  // Layouts
  await query(`CREATE TABLE IF NOT EXISTS medialoop_layout (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID REFERENCES empresa(id) ON DELETE CASCADE,
    nome VARCHAR(200) NOT NULL,
    zonas JSONB DEFAULT '[]',
    fundo_cor VARCHAR(20) DEFAULT '#000000',
    fundo_url TEXT,
    global BOOLEAN DEFAULT false,
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  // Programação
  await query(`CREATE TABLE IF NOT EXISTS medialoop_programacao (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ecra_id UUID NOT NULL REFERENCES medialoop_ecra(id) ON DELETE CASCADE,
    empresa_id UUID NOT NULL,
    nome VARCHAR(200),
    dia_semana INTEGER DEFAULT 0,
    hora_inicio TIME NOT NULL,
    hora_fim TIME NOT NULL,
    playlist_id UUID REFERENCES medialoop_playlist(id),
    layout_id UUID REFERENCES medialoop_layout(id),
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  // Campanhas publicidade
  await query(`CREATE TABLE IF NOT EXISTS medialoop_campanha (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
    nome VARCHAR(200) NOT NULL,
    cliente_id UUID,
    conteudo_id UUID REFERENCES medialoop_conteudo(id),
    ecra_ids JSONB DEFAULT '[]',
    data_inicio DATE,
    data_fim DATE,
    frequencia_min INTEGER DEFAULT 10,
    valor_total NUMERIC(12,2) DEFAULT 0,
    revenue_share_pct INTEGER DEFAULT 30,
    impressoes INTEGER DEFAULT 0,
    estado VARCHAR(20) DEFAULT 'activa',
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  // Avisos internos
  await query(`CREATE TABLE IF NOT EXISTS medialoop_aviso (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
    titulo VARCHAR(200) NOT NULL,
    mensagem TEXT,
    prioridade VARCHAR(20) DEFAULT 'normal',
    data_inicio TIMESTAMPTZ,
    data_fim TIMESTAMPTZ,
    ecra_ids JSONB DEFAULT '[]',
    tipo VARCHAR(30) DEFAULT 'aviso',
    activo BOOLEAN DEFAULT true,
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  // Comandos remotos
  await query(`CREATE TABLE IF NOT EXISTS medialoop_comando (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ecra_id UUID NOT NULL REFERENCES medialoop_ecra(id) ON DELETE CASCADE,
    empresa_id UUID NOT NULL,
    comando VARCHAR(50) NOT NULL,
    estado VARCHAR(20) DEFAULT 'pendente',
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  // ── SENHAS ──

  // Serviços
  await query(`CREATE TABLE IF NOT EXISTS senha_servico (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
    nome VARCHAR(200) NOT NULL,
    prefixo VARCHAR(3) NOT NULL,
    descricao TEXT,
    cor VARCHAR(20) DEFAULT '#4F46E5',
    icone VARCHAR(10) DEFAULT '👤',
    prioridade INTEGER DEFAULT 1,
    tempo_medio_min INTEGER DEFAULT 5,
    activo BOOLEAN DEFAULT true,
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  // Balcões
  await query(`CREATE TABLE IF NOT EXISTS senha_balcao (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
    numero INTEGER NOT NULL,
    nome VARCHAR(100),
    servico_id UUID REFERENCES senha_servico(id),
    localizacao VARCHAR(200),
    operador_id UUID REFERENCES utilizador(id),
    estado VARCHAR(20) DEFAULT 'fechado' CHECK (estado IN ('aberto','fechado','pausa')),
    criado_em TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(empresa_id, numero)
  )`);

  // Senhas
  await query(`CREATE TABLE IF NOT EXISTS medialoop_senha (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
    servico_id UUID NOT NULL REFERENCES senha_servico(id),
    numero VARCHAR(10) NOT NULL,
    nome_cliente VARCHAR(200),
    prioridade_vip BOOLEAN DEFAULT false,
    estado VARCHAR(20) DEFAULT 'aguarda' CHECK (estado IN ('aguarda','chamada','em_atendimento','atendida','desistiu','expirada')),
    balcao_id UUID REFERENCES senha_balcao(id),
    balcao_numero INTEGER,
    posicao_fila INTEGER DEFAULT 0,
    espera_estimada_min INTEGER DEFAULT 0,
    num_chamadas INTEGER DEFAULT 0,
    chamada_em TIMESTAMPTZ,
    atendimento_inicio TIMESTAMPTZ,
    atendida_em TIMESTAMPTZ,
    notas TEXT,
    resultado VARCHAR(30),
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  // FKs adicionais
  await query(`ALTER TABLE medialoop_ecra ADD COLUMN IF NOT EXISTS playlist_activa_id UUID REFERENCES medialoop_playlist(id)`).catch(()=>{});
  await query(`ALTER TABLE medialoop_ecra ADD COLUMN IF NOT EXISTS layout_id UUID REFERENCES medialoop_layout(id)`).catch(()=>{});

  // Índices
  await query(`CREATE INDEX IF NOT EXISTS idx_ml_ecra_empresa ON medialoop_ecra(empresa_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_ml_senha_empresa ON medialoop_senha(empresa_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_ml_senha_estado ON medialoop_senha(estado)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_ml_ecra_token ON medialoop_ecra(device_token)`);

  console.log('✅ MediaLoop + Senhas migrados!');
  console.log('   Tabelas: medialoop_ecra, medialoop_conteudo, medialoop_playlist,');
  console.log('            medialoop_layout, medialoop_programacao, medialoop_campanha,');
  console.log('            medialoop_aviso, medialoop_comando, medialoop_senha,');
  console.log('            medialoop_localizacao, senha_servico, senha_balcao');
  process.exit(0);
}
migrate().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
