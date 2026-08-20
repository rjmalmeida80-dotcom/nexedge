'use strict';

require('dotenv').config();
const { pool } = require('./database');

// Migrações adicionais — Recrutamento, Avaliação, Comunicação
const migracoes = [

// ── Recrutamento ──────────────────────────────────────────────────────────────
`CREATE TABLE IF NOT EXISTS recrutamento_vagas (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  empresa_id    UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  titulo        VARCHAR(200) NOT NULL,
  departamento  VARCHAR(150),
  local         VARCHAR(150),
  descricao     TEXT,
  requisitos    TEXT,
  salario_min   NUMERIC(10,2),
  salario_max   NUMERIC(10,2),
  tipo_contrato VARCHAR(50) DEFAULT 'sem_termo',
  prioridade    VARCHAR(20) DEFAULT 'normal',
  estado        VARCHAR(20) DEFAULT 'ativa',
  criado_por    UUID REFERENCES utilizador(id),
  criado_em     TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em TIMESTAMPTZ DEFAULT NOW()
)`,

`CREATE TABLE IF NOT EXISTS recrutamento_candidatos (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  vaga_id             UUID NOT NULL REFERENCES recrutamento_vagas(id) ON DELETE CASCADE,
  empresa_id          UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  nome                VARCHAR(200) NOT NULL,
  email               VARCHAR(150) NOT NULL,
  telefone            VARCHAR(20),
  salario_pretendido  NUMERIC(10,2),
  etapa               VARCHAR(50) DEFAULT 'candidatura',
  classificacao       INTEGER CHECK (classificacao BETWEEN 1 AND 5),
  notas               TEXT,
  cv_url              TEXT,
  adicionado_por      UUID REFERENCES utilizador(id),
  criado_em           TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em       TIMESTAMPTZ DEFAULT NOW()
)`,

// ── Avaliação de Desempenho ───────────────────────────────────────────────────
`CREATE TABLE IF NOT EXISTS avaliacoes (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  empresa_id      UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  funcionario_id  UUID NOT NULL REFERENCES funcionario(id) ON DELETE CASCADE,
  avaliador_id    UUID REFERENCES utilizador(id),
  periodo         VARCHAR(20) NOT NULL,
  competencias    JSONB DEFAULT '[]'::jsonb,
  nota_global     NUMERIC(3,1),
  comentarios     TEXT,
  recomendacao    TEXT,
  estado          VARCHAR(20) DEFAULT 'rascunho',
  criado_em       TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em   TIMESTAMPTZ DEFAULT NOW()
)`,

`CREATE TABLE IF NOT EXISTS objetivos (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  empresa_id      UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  funcionario_id  UUID NOT NULL REFERENCES funcionario(id) ON DELETE CASCADE,
  titulo          VARCHAR(300) NOT NULL,
  descricao       TEXT,
  prazo           DATE NOT NULL,
  peso            INTEGER DEFAULT 20,
  progresso       INTEGER DEFAULT 0 CHECK (progresso BETWEEN 0 AND 100),
  estado          VARCHAR(30) DEFAULT 'em_curso',
  criado_por      UUID REFERENCES utilizador(id),
  criado_em       TIMESTAMPTZ DEFAULT NOW(),
  atualizado_em   TIMESTAMPTZ DEFAULT NOW()
)`,

// ── Comunicação Interna ───────────────────────────────────────────────────────
`CREATE TABLE IF NOT EXISTS comunicacao_avisos (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  empresa_id    UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  titulo        VARCHAR(300) NOT NULL,
  conteudo      TEXT NOT NULL,
  categoria     VARCHAR(50) DEFAULT 'geral',
  prioridade    VARCHAR(20) DEFAULT 'normal',
  fixado        BOOLEAN DEFAULT false,
  destinatarios VARCHAR(50) DEFAULT 'todos',
  ativo         BOOLEAN DEFAULT true,
  criado_por    UUID REFERENCES utilizador(id),
  criado_em     TIMESTAMPTZ DEFAULT NOW()
)`,

`CREATE TABLE IF NOT EXISTS avisos_leituras (
  aviso_id      UUID REFERENCES comunicacao_avisos(id) ON DELETE CASCADE,
  utilizador_id UUID REFERENCES utilizador(id) ON DELETE CASCADE,
  lido_em       TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (aviso_id, utilizador_id)
)`,

`CREATE TABLE IF NOT EXISTS comunicacao_mensagens (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  empresa_id      UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  remetente_id    UUID NOT NULL REFERENCES utilizador(id),
  destinatario_id UUID REFERENCES utilizador(id),
  mensagem        TEXT NOT NULL,
  lida            BOOLEAN DEFAULT false,
  criado_em       TIMESTAMPTZ DEFAULT NOW()
)`,

// Colunas adicionais — empresa
`ALTER TABLE empresa ADD COLUMN IF NOT EXISTS logo_url TEXT`,

// Tabela de Áreas de Negócio (flexível — cada empresa define as suas)
`CREATE TABLE IF NOT EXISTS area_negocio (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id    UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  nome          VARCHAR(100) NOT NULL,
  descricao     TEXT,
  cor           VARCHAR(7) DEFAULT '#185FA5',
  responsavel_id UUID REFERENCES funcionario(id),
  ativo         BOOLEAN DEFAULT true,
  criado_em     TIMESTAMPTZ DEFAULT NOW()
)`,

// Ligar departamentos a áreas
`ALTER TABLE departamento ADD COLUMN IF NOT EXISTS area_negocio_id UUID REFERENCES area_negocio(id)`,

// Ligar funcionários a áreas directamente (para casos sem departamento)
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS area_negocio_id UUID REFERENCES area_negocio(id)`,

// Tabela de níveis hierárquicos (flexível — cada empresa define os seus)
`CREATE TABLE IF NOT EXISTS nivel_hierarquico (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id    UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  nome          VARCHAR(100) NOT NULL,
  nivel         INTEGER NOT NULL,  -- 1=topo (CEO), 2=Director, 3=Manager, etc.
  descricao     TEXT,
  cor           VARCHAR(7) DEFAULT '#185FA5',
  ativo         BOOLEAN DEFAULT true,
  criado_em     TIMESTAMPTZ DEFAULT NOW()
)`,
`CREATE UNIQUE INDEX IF NOT EXISTS idx_nivel_empresa_nivel ON nivel_hierarquico(empresa_id, nivel)`,

// ── CONVENÇÃO COLECTIVA DE TRABALHO ──────────────────────────────────────
`CREATE TABLE IF NOT EXISTS cct (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id    UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  nome          VARCHAR(200) NOT NULL,
  codigo        VARCHAR(50),
  entidade      VARCHAR(200),
  data_publicacao DATE,
  data_vigencia   DATE,
  url_boletim   TEXT,
  ativo         BOOLEAN DEFAULT true,
  criado_em     TIMESTAMPTZ DEFAULT NOW()
)`,

// Categorias profissionais definidas pelo CCT
`CREATE TABLE IF NOT EXISTS categoria_profissional (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id    UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  cct_id        UUID REFERENCES cct(id),
  nome          VARCHAR(150) NOT NULL,
  codigo        VARCHAR(30),
  nivel         INTEGER,
  salario_minimo DECIMAL(10,2) DEFAULT 0,
  descricao     TEXT,
  ativo         BOOLEAN DEFAULT true
)`,

// Ligar empresa ao CCT principal
`ALTER TABLE empresa ADD COLUMN IF NOT EXISTS cct_id UUID REFERENCES cct(id)`,

// ── BANDAS SALARIAIS ──────────────────────────────────────────────────────
`CREATE TABLE IF NOT EXISTS banda_salarial (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id          UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  nivel_hierarquico_id UUID REFERENCES nivel_hierarquico(id),
  nome                VARCHAR(100) NOT NULL,
  salario_minimo      DECIMAL(10,2) NOT NULL,
  salario_medio       DECIMAL(10,2),
  salario_maximo      DECIMAL(10,2) NOT NULL,
  moeda               VARCHAR(3) DEFAULT 'EUR',
  ativo               BOOLEAN DEFAULT true,
  criado_em           TIMESTAMPTZ DEFAULT NOW()
)`,

// ── MODELOS DE CONTRATO ───────────────────────────────────────────────────
`CREATE TABLE IF NOT EXISTS modelo_contrato (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id    UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  nome          VARCHAR(150) NOT NULL,
  tipo_contrato VARCHAR(50) NOT NULL,
  conteudo      TEXT NOT NULL,
  ativo         BOOLEAN DEFAULT true,
  criado_em     TIMESTAMPTZ DEFAULT NOW()
)`,

// Contratos gerados para funcionários
`CREATE TABLE IF NOT EXISTS contrato_trabalho (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id      UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  funcionario_id  UUID NOT NULL REFERENCES funcionario(id),
  modelo_id       UUID REFERENCES modelo_contrato(id),
  tipo_contrato   VARCHAR(50) NOT NULL,
  data_inicio     DATE NOT NULL,
  data_fim        DATE,
  data_assinatura DATE,
  assinado        BOOLEAN DEFAULT false,
  conteudo_final  TEXT,
  pdf_url         TEXT,
  notas           TEXT,
  criado_em       TIMESTAMPTZ DEFAULT NOW()
)`,

// Centros de custo (para contabilidade analítica)
`CREATE TABLE IF NOT EXISTS centro_custo (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id    UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  codigo        VARCHAR(20) NOT NULL,
  nome          VARCHAR(100) NOT NULL,
  descricao     TEXT,
  area_negocio_id UUID REFERENCES area_negocio(id),
  responsavel_id  UUID REFERENCES funcionario(id),
  orcamento_anual DECIMAL(12,2) DEFAULT 0,
  ativo         BOOLEAN DEFAULT true,
  criado_em     TIMESTAMPTZ DEFAULT NOW()
)`,
`CREATE UNIQUE INDEX IF NOT EXISTS idx_centro_custo_codigo ON centro_custo(empresa_id, codigo)`,

// Ligar local de trabalho à área
`ALTER TABLE local_trabalho ADD COLUMN IF NOT EXISTS area_negocio_id UUID REFERENCES area_negocio(id)`,

// Ligar funcionário ao centro de custo
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS centro_custo_id UUID REFERENCES centro_custo(id)`,

// Projectos (colaboradores transversais às áreas)
`CREATE TABLE IF NOT EXISTS projeto (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id    UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  nome          VARCHAR(150) NOT NULL,
  descricao     TEXT,
  data_inicio   DATE,
  data_fim      DATE,
  estado        VARCHAR(20) DEFAULT 'ativo',
  responsavel_id UUID REFERENCES funcionario(id),
  area_negocio_id UUID REFERENCES area_negocio(id),
  orcamento     DECIMAL(12,2) DEFAULT 0,
  criado_em     TIMESTAMPTZ DEFAULT NOW()
)`,

`CREATE TABLE IF NOT EXISTS projeto_membro (
  projeto_id    UUID REFERENCES projeto(id) ON DELETE CASCADE,
  funcionario_id UUID REFERENCES funcionario(id) ON DELETE CASCADE,
  papel         VARCHAR(100),
  data_entrada  DATE DEFAULT CURRENT_DATE,
  PRIMARY KEY (projeto_id, funcionario_id)
)`,

// Adicionar campos de hierarquia ao funcionário
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS nivel_hierarquico_id UUID REFERENCES nivel_hierarquico(id)`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS responsavel_direto_id UUID REFERENCES funcionario(id)`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS utilizador_id UUID REFERENCES utilizador(id)`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS area_negocio_id UUID REFERENCES area_negocio(id)`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS centro_custo_id UUID REFERENCES centro_custo(id)`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS categoria_profissional_id UUID REFERENCES categoria_profissional(id)`,

// Regime de trabalho
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS regime_trabalho VARCHAR(20) DEFAULT 'presencial'`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS dias_presenca_semana INTEGER DEFAULT 5`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS horario_entrada TIME DEFAULT '09:00'`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS horario_saida TIME DEFAULT '18:00'`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS turno VARCHAR(20) DEFAULT 'fixo'`,

// Estágio IEFP
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS estagio_iefp BOOLEAN DEFAULT false`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS estagio_nivel VARCHAR(10)`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS estagio_orientador_id UUID REFERENCES funcionario(id)`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS estagio_comparticipacao DECIMAL(5,2) DEFAULT 0`,

// ETT — Empresa de Trabalho Temporário
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS ett BOOLEAN DEFAULT false`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS ett_empresa VARCHAR(150)`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS ett_data_fim DATE`,

// Progressão de carreira
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS data_ultima_progressao DATE`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS data_proxima_avaliacao DATE`,

// Adicionar perfis em falta ao utilizador
`ALTER TABLE utilizador DROP CONSTRAINT IF EXISTS utilizador_perfil_check`,

// Colunas adicionais — utilizador
`ALTER TABLE utilizador ADD COLUMN IF NOT EXISTS mudar_password BOOLEAN DEFAULT false`,
`ALTER TABLE utilizador ADD COLUMN IF NOT EXISTS foto_url TEXT`,

// Colunas adicionais — recibo com dias trabalhados
`ALTER TABLE recibo_vencimento ADD COLUMN IF NOT EXISTS dias_uteis_mes INTEGER DEFAULT 22`,
`ALTER TABLE recibo_vencimento ADD COLUMN IF NOT EXISTS dias_trabalhados INTEGER DEFAULT 22`,

// ── FERIADOS E DIAS ESPECIAIS ────────────────────────────────────────────
`CREATE TABLE IF NOT EXISTS feriado (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id    UUID REFERENCES empresa(id) ON DELETE CASCADE,
  nome          VARCHAR(100) NOT NULL,
  data          DATE NOT NULL,
  tipo          VARCHAR(20) DEFAULT 'nacional',
  recorrente    BOOLEAN DEFAULT true,
  ativo         BOOLEAN DEFAULT true
)`,

// Política de dias especiais da empresa
`ALTER TABLE empresa ADD COLUMN IF NOT EXISTS dia_aniversario BOOLEAN DEFAULT false`,
`ALTER TABLE empresa ADD COLUMN IF NOT EXISTS aniversario_transfere_fds BOOLEAN DEFAULT true`,
`ALTER TABLE empresa ADD COLUMN IF NOT EXISTS tolerancia_ponto_aniversario INTEGER DEFAULT 0`,
`ALTER TABLE empresa ADD COLUMN IF NOT EXISTS dias_natal INTEGER DEFAULT 0`,
`ALTER TABLE empresa ADD COLUMN IF NOT EXISTS dias_pascoa INTEGER DEFAULT 0`,
`ALTER TABLE empresa ADD COLUMN IF NOT EXISTS dias_carnaval INTEGER DEFAULT 0`,
`ALTER TABLE empresa ADD COLUMN IF NOT EXISTS email_aniversario BOOLEAN DEFAULT true`,

// ── BANCO DE HORAS ────────────────────────────────────────────────────────
`CREATE TABLE IF NOT EXISTS banco_horas (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id      UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  funcionario_id  UUID NOT NULL REFERENCES funcionario(id),
  data            DATE NOT NULL,
  horas           DECIMAL(5,2) NOT NULL,
  tipo            VARCHAR(20) NOT NULL,
  descricao       TEXT,
  aprovado        BOOLEAN DEFAULT false,
  aprovado_por    UUID REFERENCES utilizador(id),
  criado_em       TIMESTAMPTZ DEFAULT NOW()
)`,

// ── LICENÇAS ESPECIAIS ────────────────────────────────────────────────────
`CREATE TABLE IF NOT EXISTS licenca_especial (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id      UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  funcionario_id  UUID NOT NULL REFERENCES funcionario(id),
  tipo            VARCHAR(50) NOT NULL,
  data_inicio     DATE NOT NULL,
  data_fim        DATE NOT NULL,
  dias_uteis      INTEGER NOT NULL,
  motivo          TEXT,
  documentos      TEXT,
  estado          VARCHAR(20) DEFAULT 'aprovado',
  criado_por      UUID REFERENCES utilizador(id),
  criado_em       TIMESTAMPTZ DEFAULT NOW()
)`,

// ── MEDICINA DO TRABALHO ──────────────────────────────────────────────────
`CREATE TABLE IF NOT EXISTS medicina_trabalho (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id      UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  funcionario_id  UUID NOT NULL REFERENCES funcionario(id),
  tipo            VARCHAR(50) NOT NULL,
  data_exame      DATE NOT NULL,
  data_validade   DATE,
  resultado       VARCHAR(20) DEFAULT 'apto',
  medico          VARCHAR(150),
  clinica         VARCHAR(150),
  restricoes      TEXT,
  notas           TEXT,
  criado_em       TIMESTAMPTZ DEFAULT NOW()
)`,

// ── ACIDENTES DE TRABALHO ─────────────────────────────────────────────────
`CREATE TABLE IF NOT EXISTS acidente_trabalho (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id      UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  funcionario_id  UUID NOT NULL REFERENCES funcionario(id),
  data_acidente   TIMESTAMPTZ NOT NULL,
  local           VARCHAR(200),
  descricao       TEXT NOT NULL,
  gravidade       VARCHAR(20) DEFAULT 'ligeiro',
  dias_baixa      INTEGER DEFAULT 0,
  participado_act BOOLEAN DEFAULT false,
  data_participacao DATE,
  num_participacao VARCHAR(50),
  notas           TEXT,
  criado_em       TIMESTAMPTZ DEFAULT NOW()
)`,

// ── FORMAÇÃO PROFISSIONAL ─────────────────────────────────────────────────
`CREATE TABLE IF NOT EXISTS formacao (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id      UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  nome            VARCHAR(200) NOT NULL,
  entidade        VARCHAR(150),
  tipo            VARCHAR(50) DEFAULT 'interna',
  area            VARCHAR(100),
  horas           DECIMAL(5,1) NOT NULL,
  data_inicio     DATE,
  data_fim        DATE,
  local           VARCHAR(150),
  custo           DECIMAL(10,2) DEFAULT 0,
  descricao       TEXT,
  criado_em       TIMESTAMPTZ DEFAULT NOW()
)`,

`CREATE TABLE IF NOT EXISTS formacao_participante (
  formacao_id     UUID REFERENCES formacao(id) ON DELETE CASCADE,
  funcionario_id  UUID REFERENCES funcionario(id) ON DELETE CASCADE,
  estado          VARCHAR(20) DEFAULT 'inscrito',
  concluido       BOOLEAN DEFAULT false,
  nota            DECIMAL(4,1),
  certificado_url TEXT,
  criado_em       TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (formacao_id, funcionario_id)
)`,

// ── DOCUMENTOS COM VALIDADE ───────────────────────────────────────────────
`ALTER TABLE documento ADD COLUMN IF NOT EXISTS data_validade DATE`,
`ALTER TABLE documento ADD COLUMN IF NOT EXISTS tipo_documento VARCHAR(50)`,
`ALTER TABLE documento ADD COLUMN IF NOT EXISTS alerta_validade BOOLEAN DEFAULT true`,

// ── APROVAÇÕES DE PAGAMENTO ───────────────────────────────────────────────
// Aprovações de pagamento de salários
`CREATE TABLE IF NOT EXISTS aprovacao_pagamento (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id      UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  ano             INTEGER NOT NULL,
  mes             INTEGER NOT NULL,
  total_bruto     DECIMAL(12,2) NOT NULL,
  total_liquido   DECIMAL(12,2) NOT NULL,
  num_funcionarios INTEGER NOT NULL,
  estado          VARCHAR(20) DEFAULT 'pendente',
  aprovado1_por   UUID REFERENCES utilizador(id),
  aprovado1_em    TIMESTAMPTZ,
  aprovado1_notas TEXT,
  aprovado2_por   UUID REFERENCES utilizador(id),
  aprovado2_em    TIMESTAMPTZ,
  aprovado2_notas TEXT,
  rejeitado_por   UUID REFERENCES utilizador(id),
  rejeitado_em    TIMESTAMPTZ,
  motivo_rejeicao TEXT,
  sepa_gerado     BOOLEAN DEFAULT false,
  sepa_gerado_em  TIMESTAMPTZ,
  criado_em       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(empresa_id, ano, mes)
)`,

// Configuração de aprovações da empresa
`ALTER TABLE empresa ADD COLUMN IF NOT EXISTS aprovacao_nivel1_perfil VARCHAR(30) DEFAULT 'diretor'`,
`ALTER TABLE empresa ADD COLUMN IF NOT EXISTS aprovacao_nivel2_perfil VARCHAR(30) DEFAULT 'admin_empresa'`,
`ALTER TABLE empresa ADD COLUMN IF NOT EXISTS aprovacao_limite_nivel1 DECIMAL(12,2) DEFAULT 0`,
`ALTER TABLE empresa ADD COLUMN IF NOT EXISTS iban_empresa VARCHAR(35)`,
`ALTER TABLE empresa ADD COLUMN IF NOT EXISTS banco_empresa VARCHAR(100)`,
`ALTER TABLE empresa ADD COLUMN IF NOT EXISTS bic_empresa VARCHAR(11)`,

// Colunas adicionais — funcionario IRS e SS
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS estado_civil VARCHAR(30) DEFAULT 'nao_casado'`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS num_dependentes INTEGER DEFAULT 0`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS deficiencia BOOLEAN DEFAULT false`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS deficiencia_dependente BOOLEAN DEFAULT false`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS deficiencia_percentagem INTEGER DEFAULT 0`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS irs_jovem BOOLEAN DEFAULT false`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS irs_jovem_ano INTEGER DEFAULT 1`,

// Colunas adicionais — funcionario complementos salariais
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS tipo_subsidio_alimentacao VARCHAR(10) DEFAULT 'dinheiro'`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS subsidio_turno DECIMAL(10,2) DEFAULT 0`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS subsidio_risco DECIMAL(10,2) DEFAULT 0`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS subsidio_chefia DECIMAL(10,2) DEFAULT 0`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS isencao_horario DECIMAL(10,2) DEFAULT 0`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS diuturnidades DECIMAL(10,2) DEFAULT 0`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS comissoes_fixas DECIMAL(10,2) DEFAULT 0`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS abono_falhas DECIMAL(10,2) DEFAULT 0`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS dias_teletrabalho_mes INTEGER DEFAULT 0`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS viatura_empresa_valor DECIMAL(10,2) DEFAULT 0`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS kms_viatura_propria DECIMAL(10,2) DEFAULT 0`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS ajudas_custo_nacionais_dias DECIMAL(5,1) DEFAULT 0`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS ajudas_custo_inter_dias DECIMAL(5,1) DEFAULT 0`,

// Colunas adicionais — seguro de saúde e benefícios
// Agregado familiar no seguro de saúde
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS seguro_saude_agregado BOOLEAN DEFAULT false`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS seguro_saude_num_agregado INTEGER DEFAULT 0`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS seguro_saude_desconto_agregado DECIMAL(10,2) DEFAULT 0`,

// Seguro de acidentes de trabalho (obrigatório por lei)
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS seguro_acidentes_capital DECIMAL(12,2) DEFAULT 0`,

// FCT e FGCT (obrigatório contratos sem termo desde 2014)
`ALTER TABLE empresa ADD COLUMN IF NOT EXISTS fct_ativo BOOLEAN DEFAULT true`,

// Benefícios em espécie
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS vale_educacao DECIMAL(10,2) DEFAULT 0`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS vale_infancia DECIMAL(10,2) DEFAULT 0`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS telemovel_empresa DECIMAL(10,2) DEFAULT 0`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS formacao_horas_ano INTEGER DEFAULT 40`,

// Colunas adicionais — seguro de saúde valores
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS seguro_saude_empresa DECIMAL(10,2) DEFAULT 0`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS seguro_saude_funcionario DECIMAL(10,2) DEFAULT 0`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS seguro_saude_apolice VARCHAR(50)`,
`ALTER TABLE funcionario ADD COLUMN IF NOT EXISTS seguro_saude_seguradora VARCHAR(100)`,

// Colunas adicionais — recibo com linhas de detalhe
`ALTER TABLE recibo_vencimento ADD COLUMN IF NOT EXISTS linhas_detalhe JSONB`,
`ALTER TABLE recibo_vencimento ADD COLUMN IF NOT EXISTS seguro_saude_empresa DECIMAL(10,2) DEFAULT 0`,
`ALTER TABLE recibo_vencimento ADD COLUMN IF NOT EXISTS subsidio_ferias DECIMAL(10,2) DEFAULT 0`,
`ALTER TABLE recibo_vencimento ADD COLUMN IF NOT EXISTS subsidio_natal DECIMAL(10,2) DEFAULT 0`,

// Dados padrão — inserir após criar as tabelas
`INSERT INTO area_negocio (empresa_id, nome, descricao, cor)
  SELECT e.id, a.nome, a.descricao, a.cor
  FROM empresa e,
  (VALUES
    ('Gestão',       'Administração, Direcção e Gestão Executiva',        '#0A0F1E'),
    ('Comercial',    'Vendas, Marketing e Desenvolvimento de Negócio',    '#185FA5'),
    ('Operacional',  'Produção, Logística e Operações',                   '#1D9E75'),
    ('Suporte',      'RH, Financeiro, IT e Serviços Administrativos',     '#7C3AED'),
    ('Técnica',      'Engenharia, Qualidade e Investigação & Desenvolvimento', '#D97706')
  ) AS a(nome, descricao, cor)
  WHERE NOT EXISTS (SELECT 1 FROM area_negocio WHERE empresa_id=e.id)`,

`INSERT INTO nivel_hierarquico (empresa_id, nome, nivel, descricao, cor)
  SELECT e.id, n.nome, n.nivel, n.descricao, n.cor
  FROM empresa e,
  (VALUES
    ('CEO / Administrador',        1, 'Responsável máximo da organização',          '#0A0F1E'),
    ('Director',                   2, 'Director de área ou departamento',            '#185FA5'),
    ('Manager / Chefe de Divisão', 3, 'Gestor de divisão ou unidade de negócio',    '#1D9E75'),
    ('Supervisor',                 4, 'Supervisão de equipas operacionais',          '#7C3AED'),
    ('Team Leader',                5, 'Liderança de equipa de trabalho',             '#D97706'),
    ('Técnico / Especialista',     6, 'Colaborador especializado',                   '#374151'),
    ('Funcionário',                7, 'Colaborador operacional',                     '#374151'),
    ('Estagiário',                 8, 'Em regime de estágio profissional/curricular','#6B7280')
  ) AS n(nome, nivel, descricao, cor)
  WHERE NOT EXISTS (SELECT 1 FROM nivel_hierarquico WHERE empresa_id=e.id)`,

`INSERT INTO centro_custo (empresa_id, codigo, nome, descricao)
  SELECT e.id, c.codigo, c.nome, c.descricao
  FROM empresa e,
  (VALUES
    ('CC001', 'Gestão e Administração',    'Custos da direcção e administração'),
    ('CC002', 'Comercial e Marketing',     'Custos da área comercial e marketing'),
    ('CC003', 'Operações e Produção',      'Custos operacionais e produção'),
    ('CC004', 'Recursos Humanos',          'Custos do departamento de RH'),
    ('CC005', 'Tecnologias de Informação', 'Custos de IT e infraestrutura'),
    ('CC006', 'Financeiro e Contabilidade','Custos financeiros e contabilísticos')
  ) AS c(codigo, nome, descricao)
  WHERE NOT EXISTS (SELECT 1 FROM centro_custo WHERE empresa_id=e.id)`,

`ALTER TABLE feriado ADD COLUMN IF NOT EXISTS empresa_id UUID REFERENCES empresa(id) ON DELETE CASCADE`,
`ALTER TABLE feriado ADD COLUMN IF NOT EXISTS recorrente BOOLEAN DEFAULT true`,

`INSERT INTO feriado (empresa_id, nome, data, ano, tipo, recorrente)
  SELECT e.id, f.nome, f.data::DATE, EXTRACT(YEAR FROM f.data::DATE)::INTEGER, f.tipo, true
  FROM empresa e,
  (VALUES
    ('Ano Novo',                     '2025-01-01', 'nacional'),
    ('Dia da Liberdade',             '2025-04-25', 'nacional'),
    ('Dia do Trabalhador',           '2025-05-01', 'nacional'),
    ('Dia de Portugal',              '2025-06-10', 'nacional'),
    ('Assunção de Nossa Senhora',    '2025-08-15', 'nacional'),
    ('Implantação da República',     '2025-10-05', 'nacional'),
    ('Dia de Todos os Santos',       '2025-11-01', 'nacional'),
    ('Restauração da Independência', '2025-12-01', 'nacional'),
    ('Imaculada Conceição',          '2025-12-08', 'nacional'),
    ('Natal',                        '2025-12-25', 'nacional')
  ) AS f(nome, data, tipo)
  WHERE NOT EXISTS (SELECT 1 FROM feriado WHERE empresa_id=e.id)`,

// ── PERFIS PERSONALIZADOS E PERMISSÕES ───────────────────────────────────
`CREATE TABLE IF NOT EXISTS perfil_custom (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id  UUID NOT NULL REFERENCES empresa(id) ON DELETE CASCADE,
  nome        VARCHAR(80) NOT NULL,
  descricao   TEXT,
  cor         VARCHAR(7) DEFAULT '#185FA5',
  ativo       BOOLEAN DEFAULT true,
  criado_em   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(empresa_id, nome)
)`,

`CREATE TABLE IF NOT EXISTS perfil_permissao (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  perfil_id       UUID NOT NULL REFERENCES perfil_custom(id) ON DELETE CASCADE,
  modulo          VARCHAR(50) NOT NULL,
  pode_ver        BOOLEAN DEFAULT false,
  pode_editar     BOOLEAN DEFAULT false,
  pode_aprovar    BOOLEAN DEFAULT false,
  pode_apagar     BOOLEAN DEFAULT false,
  UNIQUE(perfil_id, modulo)
)`,

`CREATE TABLE IF NOT EXISTS utilizador_perfil (
  utilizador_id   UUID NOT NULL REFERENCES utilizador(id) ON DELETE CASCADE,
  perfil_id       UUID NOT NULL REFERENCES perfil_custom(id) ON DELETE CASCADE,
  criado_em       TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (utilizador_id, perfil_id)
)`,

`ALTER TABLE utilizador ADD COLUMN IF NOT EXISTS perfis TEXT[] DEFAULT '{}'`,
`ALTER TABLE empresa ADD COLUMN IF NOT EXISTS anthropic_api_key TEXT`,
`ALTER TABLE empresa ADD COLUMN IF NOT EXISTS politica_aniversario VARCHAR(20) DEFAULT 'nenhum'`,
`ALTER TABLE empresa ADD COLUMN IF NOT EXISTS aniversario_dia_alternativo VARCHAR(20) DEFAULT 'proximo_dia_util'`,
`ALTER TABLE empresa ADD COLUMN IF NOT EXISTS plano VARCHAR(20) DEFAULT 'base'`,

// Índices
`CREATE INDEX IF NOT EXISTS idx_vagas_empresa   ON recrutamento_vagas(empresa_id)`,
`CREATE INDEX IF NOT EXISTS idx_cands_vaga      ON recrutamento_candidatos(vaga_id)`,
`CREATE INDEX IF NOT EXISTS idx_aval_func       ON avaliacoes(funcionario_id)`,
`CREATE INDEX IF NOT EXISTS idx_obj_func        ON objetivos(funcionario_id)`,
`CREATE INDEX IF NOT EXISTS idx_avisos_empresa  ON comunicacao_avisos(empresa_id)`,
`CREATE INDEX IF NOT EXISTS idx_msgs_empresa    ON comunicacao_mensagens(empresa_id)`,
`CREATE INDEX IF NOT EXISTS idx_msgs_remetente  ON comunicacao_mensagens(remetente_id)`,
];

async function migrarModulosNovos() {
  const client = await pool.connect();
  try {
    console.log('🚀 A migrar novos módulos (Recrutamento, Avaliação, Comunicação)...');
    for (const m of migracoes) {
      await client.query(m);
      process.stdout.write('.');
    }
    console.log('\n✅ Migração dos novos módulos concluída!');
  } catch (err) {
    console.error('\n❌ Erro:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrarModulosNovos();

// Adicionar campo mudar_password se não existir
async function adicionarCampoMudarPassword() {
  const client = await pool.connect();
  try {
    await client.query(`ALTER TABLE utilizador ADD COLUMN IF NOT EXISTS mudar_password BOOLEAN DEFAULT false`);
    console.log('✅ Campo mudar_password adicionado');
  } finally {
    client.release();
  }
}
