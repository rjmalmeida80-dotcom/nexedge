'use strict';
require('dotenv').config();
const { query } = require('./src/config/database');

async function migrate() {
  console.log('🔧 WMS — Migração completa...');

  // Zonas do armazém
  await query(`CREATE TABLE IF NOT EXISTS wms_zona (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
    nome VARCHAR(200) NOT NULL,
    tipo VARCHAR(30) DEFAULT 'armazenagem' CHECK (tipo IN ('recepcao','armazenagem','picking','expedicao','quarentena','devolucoes','frigorifico','perigos')),
    descricao TEXT,
    temperatura_min NUMERIC(5,1),
    temperatura_max NUMERIC(5,1),
    humidade_max NUMERIC(5,1),
    cor VARCHAR(20) DEFAULT '#4F46E5',
    ordem INTEGER DEFAULT 0,
    activa BOOLEAN DEFAULT true,
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  // Localizações (endereçamento)
  await query(`CREATE TABLE IF NOT EXISTS wms_localizacao (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
    zona_id UUID NOT NULL REFERENCES wms_zona(id) ON DELETE CASCADE,
    codigo VARCHAR(30) NOT NULL,
    corredor VARCHAR(5),
    prateleira INTEGER,
    posicao INTEGER,
    tipo VARCHAR(20) DEFAULT 'standard',
    capacidade_kg NUMERIC(10,2),
    capacidade_m3 NUMERIC(8,3),
    ocupada BOOLEAN DEFAULT false,
    activa BOOLEAN DEFAULT true,
    criado_em TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(empresa_id, codigo)
  )`);

  // Stock por localização
  await query(`CREATE TABLE IF NOT EXISTS wms_stock (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
    produto_id UUID NOT NULL REFERENCES produto(id) ON DELETE CASCADE,
    localizacao_id UUID REFERENCES wms_localizacao(id),
    quantidade NUMERIC(14,3) NOT NULL DEFAULT 0,
    lote VARCHAR(100),
    data_validade DATE,
    numero_serie VARCHAR(100),
    ultima_movimentacao TIMESTAMPTZ DEFAULT NOW(),
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  // Movimentos de stock
  await query(`CREATE TABLE IF NOT EXISTS wms_movimento (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
    tipo VARCHAR(30) NOT NULL CHECK (tipo IN ('recepcao','picking','expedicao','transferencia','ajuste_inventario','devolucao','quebra')),
    produto_id UUID REFERENCES produto(id),
    localizacao_id UUID REFERENCES wms_localizacao(id),
    localizacao_destino_id UUID REFERENCES wms_localizacao(id),
    quantidade NUMERIC(14,3) DEFAULT 0,
    referencia VARCHAR(100),
    lote VARCHAR(100),
    operador_id UUID REFERENCES utilizador(id),
    estado VARCHAR(20) DEFAULT 'concluido',
    notas TEXT,
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  // Recepções
  await query(`CREATE TABLE IF NOT EXISTS wms_recepcao (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
    numero VARCHAR(30) NOT NULL UNIQUE,
    fornecedor_id UUID REFERENCES fornecedor(id),
    pedido_compra_id UUID,
    referencia_externa VARCHAR(100),
    notas TEXT,
    estado VARCHAR(20) DEFAULT 'aberta',
    operador_id UUID REFERENCES utilizador(id),
    concluida_em TIMESTAMPTZ,
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS wms_recepcao_linha (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recepcao_id UUID NOT NULL REFERENCES wms_recepcao(id) ON DELETE CASCADE,
    produto_id UUID NOT NULL REFERENCES produto(id),
    quantidade_esperada NUMERIC(14,3) DEFAULT 0,
    quantidade_recebida NUMERIC(14,3) DEFAULT 0,
    localizacao_id UUID REFERENCES wms_localizacao(id),
    unidade VARCHAR(10) DEFAULT 'UN',
    lote VARCHAR(100),
    data_validade DATE,
    estado VARCHAR(20) DEFAULT 'pendente',
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  // Ordens de Picking
  await query(`CREATE TABLE IF NOT EXISTS wms_ordem_picking (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
    numero VARCHAR(30) NOT NULL UNIQUE,
    encomenda_id UUID REFERENCES logistica_encomenda(id),
    prioridade VARCHAR(20) DEFAULT 'normal',
    notas TEXT,
    estado VARCHAR(20) DEFAULT 'pendente',
    operador_id UUID REFERENCES utilizador(id),
    concluido_em TIMESTAMPTZ,
    expedido_em TIMESTAMPTZ,
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS wms_linha_picking (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ordem_id UUID NOT NULL REFERENCES wms_ordem_picking(id) ON DELETE CASCADE,
    produto_id UUID NOT NULL REFERENCES produto(id),
    quantidade_pedida NUMERIC(14,3) NOT NULL,
    quantidade_real NUMERIC(14,3),
    localizacao_id UUID REFERENCES wms_localizacao(id),
    localizacao_sugerida UUID REFERENCES wms_localizacao(id),
    estado VARCHAR(20) DEFAULT 'pendente',
    operador_id UUID REFERENCES utilizador(id),
    picked_em TIMESTAMPTZ,
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  // Expedição
  await query(`CREATE TABLE IF NOT EXISTS wms_expedicao (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
    numero VARCHAR(30) NOT NULL UNIQUE,
    ordem_picking_id UUID REFERENCES wms_ordem_picking(id),
    encomenda_id UUID REFERENCES logistica_encomenda(id),
    transportadora VARCHAR(200),
    peso_total NUMERIC(10,2) DEFAULT 0,
    num_volumes INTEGER DEFAULT 1,
    notas TEXT,
    estado VARCHAR(20) DEFAULT 'pronta',
    operador_id UUID REFERENCES utilizador(id),
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  // Inventário
  await query(`CREATE TABLE IF NOT EXISTS wms_inventario (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
    numero VARCHAR(30) NOT NULL,
    zona_id UUID REFERENCES wms_zona(id),
    tipo VARCHAR(20) DEFAULT 'total',
    notas TEXT,
    estado VARCHAR(20) DEFAULT 'em_curso',
    iniciado_em TIMESTAMPTZ,
    iniciado_por UUID REFERENCES utilizador(id),
    concluido_em TIMESTAMPTZ,
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS wms_inventario_linha (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    inventario_id UUID NOT NULL REFERENCES wms_inventario(id) ON DELETE CASCADE,
    produto_id UUID NOT NULL REFERENCES produto(id),
    localizacao_id UUID REFERENCES wms_localizacao(id),
    quantidade_sistema NUMERIC(14,3) DEFAULT 0,
    quantidade_contada NUMERIC(14,3),
    diferenca NUMERIC(14,3),
    lote VARCHAR(100),
    estado VARCHAR(20) DEFAULT 'pendente',
    contado_em TIMESTAMPTZ,
    criado_em TIMESTAMPTZ DEFAULT NOW()
  )`);

  // Alertas
  await query(`CREATE TABLE IF NOT EXISTS wms_alerta (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
    tipo VARCHAR(30) NOT NULL,
    produto_id UUID REFERENCES produto(id),
    mensagem TEXT NOT NULL,
    prioridade VARCHAR(20) DEFAULT 'media',
    resolvido BOOLEAN DEFAULT false,
    resolvido_em TIMESTAMPTZ,
    criado_em TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(empresa_id, tipo, produto_id)
  )`);

  // Adicionar campos ao produto se necessário
  await query(`ALTER TABLE produto ADD COLUMN IF NOT EXISTS stock_minimo NUMERIC(14,3) DEFAULT 0`).catch(()=>{});
  await query(`ALTER TABLE produto ADD COLUMN IF NOT EXISTS peso_kg NUMERIC(10,3)`).catch(()=>{});
  await query(`ALTER TABLE produto ADD COLUMN IF NOT EXISTS preco_custo NUMERIC(12,4) DEFAULT 0`).catch(()=>{});

  // Índices
  await query(`CREATE INDEX IF NOT EXISTS idx_wms_stock_empresa ON wms_stock(empresa_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_wms_stock_produto ON wms_stock(produto_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_wms_stock_loc ON wms_stock(localizacao_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_wms_mov_empresa ON wms_movimento(empresa_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_wms_loc_zona ON wms_localizacao(zona_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_wms_loc_ocupada ON wms_localizacao(ocupada)`);

  console.log('✅ WMS migrado!');
  console.log('   Tabelas: wms_zona, wms_localizacao, wms_stock, wms_movimento,');
  console.log('            wms_recepcao, wms_recepcao_linha, wms_ordem_picking,');
  console.log('            wms_linha_picking, wms_expedicao, wms_inventario,');
  console.log('            wms_inventario_linha, wms_alerta');
  process.exit(0);
}
migrate().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
