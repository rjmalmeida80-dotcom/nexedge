'use strict';

require('dotenv').config();
const { pool } = require('./database');

const migrations = [

// ══════════════════════════════════════════════════════════════════════════════
// EXTENSÕES
// ══════════════════════════════════════════════════════════════════════════════
`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`,
`CREATE EXTENSION IF NOT EXISTS "pg_trgm"`,

// ══════════════════════════════════════════════════════════════════════════════
// ENUMS
// ══════════════════════════════════════════════════════════════════════════════
`DO $$ BEGIN
  CREATE TYPE perfil_utilizador AS ENUM (
    'admin_plataforma','admin_empresa','rh','diretor','supervisor','team_leader','funcionario'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$`,

`DO $$ BEGIN
  CREATE TYPE estado_pedido AS ENUM (
    'pendente','aprovado','rejeitado','cancelado'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$`,

`DO $$ BEGIN
  CREATE TYPE tipo_contrato AS ENUM (
    'sem_termo','termo_certo','termo_incerto','servicos','estagio','part_time'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$`,

`DO $$ BEGIN
  CREATE TYPE tipo_turno AS ENUM (
    'manha','tarde','noite','rotativo','fixo','flexivel'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$`,

`DO $$ BEGIN
  CREATE TYPE estado_funcionario AS ENUM (
    'ativo','inativo','suspeso','ferias','baixa_medica','licenca'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$`,

`DO $$ BEGIN
  CREATE TYPE tipo_falta AS ENUM (
    'injustificada','justificada','baixa_medica','licenca_parental',
    'falecimento_familiar','casamento','exame','outros'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$`,

`DO $$ BEGIN
  CREATE TYPE gravidade_alerta AS ENUM ('info','aviso','critico');
EXCEPTION WHEN duplicate_object THEN NULL; END $$`,

// ══════════════════════════════════════════════════════════════════════════════
// EMPRESA
// ══════════════════════════════════════════════════════════════════════════════
`CREATE TABLE IF NOT EXISTS empresa (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  nome              VARCHAR(200) NOT NULL,
  nif               VARCHAR(9) UNIQUE NOT NULL,
  cae               VARCHAR(10),
  setor             VARCHAR(100),
  morada            TEXT,
  codigo_postal     VARCHAR(8),
  localidade        VARCHAR(100),
  pais              VARCHAR(2) DEFAULT 'PT',
  telefone          VARCHAR(20),
  email             VARCHAR(150),
  website           VARCHAR(200),
  logo_url          TEXT,
  num_funcionarios  INTEGER DEFAULT 0,
  cct_aplicavel     VARCHAR(200),
  horario_padrao    JSONB DEFAULT '{"entrada":"09:00","saida":"18:00","almoco_min":60}'::jsonb,
  modulos_ativos    JSONB DEFAULT '["funcionarios","ferias","horarios"]'::jsonb,
  configuracoes     JSONB DEFAULT '{}'::jsonb,
  ativo             BOOLEAN DEFAULT true,
  criado_em         TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em     TIMESTAMPTZ DEFAULT NOW()
)`,

`CREATE TABLE IF NOT EXISTS departamento (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  empresa_id    UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  nome          VARCHAR(150) NOT NULL,
  descricao     TEXT,
  responsavel_id UUID,
  ativo         BOOLEAN DEFAULT true,
  criado_em     TIMESTAMPTZ DEFAULT NOW()
)`,

`CREATE TABLE IF NOT EXISTS local_trabalho (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  empresa_id    UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  nome          VARCHAR(150) NOT NULL,
  morada        TEXT,
  codigo_postal VARCHAR(8),
  localidade    VARCHAR(100),
  fuso_horario  VARCHAR(50) DEFAULT 'Europe/Lisbon',
  ativo         BOOLEAN DEFAULT true
)`,

// ══════════════════════════════════════════════════════════════════════════════
// UTILIZADORES & FUNCIONÁRIOS
// ══════════════════════════════════════════════════════════════════════════════
`CREATE TABLE IF NOT EXISTS utilizador (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  empresa_id        UUID REFERENCES empresa(id) ON DELETE CASCADE,
  email             VARCHAR(150) UNIQUE NOT NULL,
  password_hash     VARCHAR(255) NOT NULL,
  perfil            perfil_utilizador NOT NULL DEFAULT 'funcionario',
  nome_completo     VARCHAR(200) NOT NULL,
  telefone          VARCHAR(20),
  avatar_url        TEXT,
  ativo             BOOLEAN DEFAULT true,
  email_verificado  BOOLEAN DEFAULT false,
  ultimo_login      TIMESTAMPTZ,
  refresh_token     TEXT,
  reset_token       VARCHAR(100),
  reset_token_exp   TIMESTAMPTZ,
  criado_em         TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em     TIMESTAMPTZ DEFAULT NOW()
)`,

`CREATE TABLE IF NOT EXISTS funcionario (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  utilizador_id       UUID UNIQUE REFERENCES utilizador(id) ON DELETE SET NULL,
  empresa_id          UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  departamento_id     UUID REFERENCES departamento(id) ON DELETE SET NULL,
  local_trabalho_id   UUID REFERENCES local_trabalho(id) ON DELETE SET NULL,
  responsavel_id      UUID REFERENCES funcionario(id) ON DELETE SET NULL,

  -- Dados pessoais
  numero_funcionario  VARCHAR(20) UNIQUE,
  nome_completo       VARCHAR(200) NOT NULL,
  data_nascimento     DATE,
  genero              VARCHAR(20),
  nif                 VARCHAR(9),
  niss               VARCHAR(11),
  num_cc              VARCHAR(8),
  num_passaporte      VARCHAR(20),
  nacionalidade       VARCHAR(2) DEFAULT 'PT',

  -- Contactos
  email_pessoal       VARCHAR(150),
  email_empresa       VARCHAR(150),
  telefone            VARCHAR(20),
  telemovel           VARCHAR(20),
  morada              TEXT,
  codigo_postal       VARCHAR(8),
  localidade          VARCHAR(100),

  -- Dados profissionais
  cargo               VARCHAR(150) NOT NULL,
  categoria           VARCHAR(150),
  nivel               VARCHAR(50),
  tipo_contrato       tipo_contrato DEFAULT 'sem_termo',
  data_admissao       DATE NOT NULL,
  data_fim_contrato   DATE,
  estado              estado_funcionario DEFAULT 'ativo',

  -- Dados salariais
  salario_base        NUMERIC(10,2) DEFAULT 0,
  subsidio_alimentacao NUMERIC(8,2) DEFAULT 0,
  outros_subsidios    JSONB DEFAULT '[]'::jsonb,
  iban                VARCHAR(25),
  banco               VARCHAR(100),

  -- Horário
  tipo_turno          tipo_turno DEFAULT 'fixo',
  horas_semanais      NUMERIC(5,2) DEFAULT 40,
  horario_id          UUID,

  -- Férias
  dias_ferias_ano     INTEGER DEFAULT 22,
  dias_ferias_saldo   NUMERIC(5,1) DEFAULT 0,
  dias_ferias_gozados NUMERIC(5,1) DEFAULT 0,

  -- Metadados
  foto_url            TEXT,
  notas               TEXT,
  campos_extra        JSONB DEFAULT '{}'::jsonb,
  criado_em           TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em       TIMESTAMPTZ DEFAULT NOW()
)`,

// ══════════════════════════════════════════════════════════════════════════════
// HORÁRIOS E TURNOS
// ══════════════════════════════════════════════════════════════════════════════
`CREATE TABLE IF NOT EXISTS horario (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  empresa_id    UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  nome          VARCHAR(100) NOT NULL,
  descricao     TEXT,
  tipo          tipo_turno DEFAULT 'fixo',
  segunda       JSONB,
  terca         JSONB,
  quarta        JSONB,
  quinta        JSONB,
  sexta         JSONB,
  sabado        JSONB,
  domingo       JSONB,
  horas_semana  NUMERIC(5,2),
  ativo         BOOLEAN DEFAULT true,
  criado_em     TIMESTAMPTZ DEFAULT NOW()
)`,

`CREATE TABLE IF NOT EXISTS escala (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  empresa_id    UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  departamento_id UUID REFERENCES departamento(id),
  nome          VARCHAR(150) NOT NULL,
  data_inicio   DATE NOT NULL,
  data_fim      DATE NOT NULL,
  estado        VARCHAR(20) DEFAULT 'rascunho',
  criado_por    UUID REFERENCES utilizador(id),
  aprovado_por  UUID REFERENCES utilizador(id),
  criado_em     TIMESTAMPTZ DEFAULT NOW()
)`,

`CREATE TABLE IF NOT EXISTS turno (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  escala_id       UUID NOT NULL REFERENCES escala(id) ON DELETE CASCADE,
  funcionario_id  UUID NOT NULL REFERENCES funcionario(id) ON DELETE CASCADE,
  data            DATE NOT NULL,
  hora_entrada    TIME NOT NULL,
  hora_saida      TIME NOT NULL,
  tipo            tipo_turno DEFAULT 'fixo',
  local_id        UUID REFERENCES local_trabalho(id),
  notas           TEXT,
  confirmado      BOOLEAN DEFAULT false,
  criado_em       TIMESTAMPTZ DEFAULT NOW()
)`,

`CREATE TABLE IF NOT EXISTS registo_ponto (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  funcionario_id  UUID NOT NULL REFERENCES funcionario(id) ON DELETE CASCADE,
  data            DATE NOT NULL,
  entrada         TIMESTAMPTZ,
  saida           TIMESTAMPTZ,
  pausa_inicio    TIMESTAMPTZ,
  pausa_fim       TIMESTAMPTZ,
  horas_trabalhadas NUMERIC(5,2),
  horas_extra     NUMERIC(5,2) DEFAULT 0,
  tipo            VARCHAR(20) DEFAULT 'normal',
  observacoes     TEXT,
  criado_em       TIMESTAMPTZ DEFAULT NOW()
)`,

// ══════════════════════════════════════════════════════════════════════════════
// FÉRIAS E AUSÊNCIAS
// ══════════════════════════════════════════════════════════════════════════════
`CREATE TABLE IF NOT EXISTS pedido_ferias (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  funcionario_id  UUID NOT NULL REFERENCES funcionario(id) ON DELETE CASCADE,
  data_inicio     DATE NOT NULL,
  data_fim        DATE NOT NULL,
  num_dias        INTEGER NOT NULL,
  motivo          TEXT,
  estado          estado_pedido DEFAULT 'pendente',
  aprovado_por    UUID REFERENCES utilizador(id),
  data_aprovacao  TIMESTAMPTZ,
  comentario      TEXT,
  criado_em       TIMESTAMPTZ DEFAULT NOW()
)`,

`CREATE TABLE IF NOT EXISTS falta (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  funcionario_id  UUID NOT NULL REFERENCES funcionario(id) ON DELETE CASCADE,
  data            DATE NOT NULL,
  tipo            tipo_falta NOT NULL,
  justificada     BOOLEAN DEFAULT false,
  descricao       TEXT,
  documento_url   TEXT,
  aprovado_por    UUID REFERENCES utilizador(id),
  estado          estado_pedido DEFAULT 'pendente',
  criado_em       TIMESTAMPTZ DEFAULT NOW()
)`,

// ══════════════════════════════════════════════════════════════════════════════
// PROCESSAMENTO SALARIAL
// ══════════════════════════════════════════════════════════════════════════════
`CREATE TABLE IF NOT EXISTS recibo_vencimento (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  funcionario_id      UUID NOT NULL REFERENCES funcionario(id) ON DELETE CASCADE,
  empresa_id          UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  ano                 INTEGER NOT NULL,
  mes                 INTEGER NOT NULL CHECK (mes BETWEEN 1 AND 12),
  salario_base        NUMERIC(10,2) NOT NULL,
  subsidio_alimentacao NUMERIC(8,2) DEFAULT 0,
  horas_extra_valor   NUMERIC(8,2) DEFAULT 0,
  outros_abonos       JSONB DEFAULT '[]'::jsonb,
  faltas_desconto     NUMERIC(8,2) DEFAULT 0,
  outros_descontos    JSONB DEFAULT '[]'::jsonb,
  irs_retido          NUMERIC(8,2) DEFAULT 0,
  seg_social_func     NUMERIC(8,2) DEFAULT 0,
  seg_social_entidade NUMERIC(8,2) DEFAULT 0,
  total_abonos        NUMERIC(10,2) NOT NULL,
  total_descontos     NUMERIC(10,2) NOT NULL,
  liquido             NUMERIC(10,2) NOT NULL,
  estado              VARCHAR(20) DEFAULT 'rascunho',
  processado_por      UUID REFERENCES utilizador(id),
  processado_em       TIMESTAMPTZ,
  pdf_url             TEXT,
  criado_em           TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(funcionario_id, ano, mes)
)`,

// ══════════════════════════════════════════════════════════════════════════════
// LEGISLAÇÃO
// ══════════════════════════════════════════════════════════════════════════════
`CREATE TABLE IF NOT EXISTS regra_legal (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  codigo          VARCHAR(50) UNIQUE NOT NULL,
  categoria       VARCHAR(100) NOT NULL,
  titulo          VARCHAR(300) NOT NULL,
  descricao       TEXT,
  valor           JSONB NOT NULL,
  vigente_desde   DATE NOT NULL,
  vigente_ate     DATE,
  fonte           TEXT,
  ativa           BOOLEAN DEFAULT true,
  criado_em       TIMESTAMPTZ DEFAULT NOW()
)`,

`CREATE TABLE IF NOT EXISTS alerta_legal (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  titulo          VARCHAR(300) NOT NULL,
  descricao       TEXT NOT NULL,
  fonte_url       TEXT,
  data_publicacao DATE,
  data_vigor      DATE,
  gravidade       gravidade_alerta DEFAULT 'info',
  modulos_afetados JSONB DEFAULT '[]'::jsonb,
  regras_afetadas JSONB DEFAULT '[]'::jsonb,
  estado          VARCHAR(30) DEFAULT 'pendente',
  processado_em   TIMESTAMPTZ,
  criado_em       TIMESTAMPTZ DEFAULT NOW()
)`,

`CREATE TABLE IF NOT EXISTS aprovacao_alerta_legal (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  alerta_id       UUID NOT NULL REFERENCES alerta_legal(id),
  empresa_id      UUID NOT NULL REFERENCES empresa(id),
  decisao         VARCHAR(20) NOT NULL,
  justificacao    TEXT,
  decidido_por    UUID REFERENCES utilizador(id),
  decidido_em     TIMESTAMPTZ DEFAULT NOW()
)`,

// ══════════════════════════════════════════════════════════════════════════════
// DOCUMENTOS
// ══════════════════════════════════════════════════════════════════════════════
`CREATE TABLE IF NOT EXISTS documento (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  empresa_id      UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  funcionario_id  UUID REFERENCES funcionario(id) ON DELETE CASCADE,
  nome            VARCHAR(300) NOT NULL,
  tipo            VARCHAR(100),
  categoria       VARCHAR(100),
  url             TEXT NOT NULL,
  tamanho_bytes   INTEGER,
  mime_type       VARCHAR(100),
  confidencial    BOOLEAN DEFAULT false,
  assinado        BOOLEAN DEFAULT false,
  assinado_em     TIMESTAMPTZ,
  validade        DATE,
  notas           TEXT,
  criado_por      UUID REFERENCES utilizador(id),
  criado_em       TIMESTAMPTZ DEFAULT NOW()
)`,

// ══════════════════════════════════════════════════════════════════════════════
// NOTIFICAÇÕES
// ══════════════════════════════════════════════════════════════════════════════
`CREATE TABLE IF NOT EXISTS notificacao (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  utilizador_id   UUID NOT NULL REFERENCES utilizador(id) ON DELETE CASCADE,
  titulo          VARCHAR(200) NOT NULL,
  mensagem        TEXT,
  tipo            VARCHAR(50) DEFAULT 'info',
  link            TEXT,
  lida            BOOLEAN DEFAULT false,
  lida_em         TIMESTAMPTZ,
  criado_em       TIMESTAMPTZ DEFAULT NOW()
)`,

// ══════════════════════════════════════════════════════════════════════════════
// AUDITORIA (imutável)
// ══════════════════════════════════════════════════════════════════════════════
`CREATE TABLE IF NOT EXISTS log_auditoria (
  id              BIGSERIAL PRIMARY KEY,
  empresa_id      UUID REFERENCES empresa(id),
  utilizador_id   UUID REFERENCES utilizador(id),
  acao            VARCHAR(100) NOT NULL,
  tabela          VARCHAR(100),
  registo_id      TEXT,
  dados_antes     JSONB,
  dados_depois    JSONB,
  ip              INET,
  user_agent      TEXT,
  criado_em       TIMESTAMPTZ DEFAULT NOW()
)`,

// ══════════════════════════════════════════════════════════════════════════════
// FERIADOS
// ══════════════════════════════════════════════════════════════════════════════
`CREATE TABLE IF NOT EXISTS feriado (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  nome        VARCHAR(150) NOT NULL,
  data        DATE NOT NULL,
  tipo        VARCHAR(20) DEFAULT 'nacional',
  municipio   VARCHAR(100),
  ano         INTEGER NOT NULL,
  criado_em   TIMESTAMPTZ DEFAULT NOW()
)`,

// ══════════════════════════════════════════════════════════════════════════════
// ÍNDICES DE PERFORMANCE
// ══════════════════════════════════════════════════════════════════════════════
`CREATE INDEX IF NOT EXISTS idx_funcionario_empresa    ON funcionario(empresa_id)`,
`CREATE INDEX IF NOT EXISTS idx_funcionario_depto      ON funcionario(departamento_id)`,
`CREATE INDEX IF NOT EXISTS idx_funcionario_estado     ON funcionario(estado)`,
`CREATE INDEX IF NOT EXISTS idx_turno_funcionario      ON turno(funcionario_id)`,
`CREATE INDEX IF NOT EXISTS idx_turno_data             ON turno(data)`,
`CREATE INDEX IF NOT EXISTS idx_turno_escala           ON turno(escala_id)`,
`CREATE INDEX IF NOT EXISTS idx_ferias_funcionario     ON pedido_ferias(funcionario_id)`,
`CREATE INDEX IF NOT EXISTS idx_ferias_estado          ON pedido_ferias(estado)`,
`CREATE INDEX IF NOT EXISTS idx_ferias_datas           ON pedido_ferias(data_inicio, data_fim)`,
`CREATE INDEX IF NOT EXISTS idx_falta_funcionario      ON falta(funcionario_id)`,
`CREATE INDEX IF NOT EXISTS idx_recibo_funcionario     ON recibo_vencimento(funcionario_id)`,
`CREATE INDEX IF NOT EXISTS idx_recibo_periodo         ON recibo_vencimento(ano, mes)`,
`CREATE INDEX IF NOT EXISTS idx_notificacao_utilizador ON notificacao(utilizador_id, lida)`,
`CREATE INDEX IF NOT EXISTS idx_auditoria_empresa      ON log_auditoria(empresa_id)`,
`CREATE INDEX IF NOT EXISTS idx_auditoria_data         ON log_auditoria(criado_em DESC)`,
`CREATE INDEX IF NOT EXISTS idx_feriado_ano            ON feriado(ano, data)`,

];

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🚀 A iniciar migrações...');
    for (let i = 0; i < migrations.length; i++) {
      await client.query(migrations[i]);
      process.stdout.write('.');
    }
    console.log('\n✅ Todas as migrações concluídas com sucesso!');
  } catch (err) {
    console.error('\n❌ Erro na migração:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
