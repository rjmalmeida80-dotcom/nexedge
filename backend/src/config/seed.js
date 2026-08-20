'use strict';

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool, query } = require('./database');

async function seed() {
  console.log('🌱 A inserir dados iniciais...');

  // ── Regras legais portuguesas base ────────────────────────────────────────
  const regrasLegais = [
    {
      codigo: 'CT_203_MAX_DIA',
      categoria: 'horario',
      titulo: 'Período máximo de trabalho diário',
      descricao: 'O período normal de trabalho não pode ser superior a 8 horas por dia.',
      valor: JSON.stringify({ horas_max: 8, com_acordo: 10 }),
      vigente_desde: '2003-12-01',
      fonte: 'Código do Trabalho, Art. 203.º'
    },
    {
      codigo: 'CT_203_MAX_SEMANA',
      categoria: 'horario',
      titulo: 'Período máximo de trabalho semanal',
      descricao: 'O período normal de trabalho não pode ser superior a 40 horas por semana.',
      valor: JSON.stringify({ horas_max: 40 }),
      vigente_desde: '2003-12-01',
      fonte: 'Código do Trabalho, Art. 203.º'
    },
    {
      codigo: 'CT_214_DESCANSO_DIARIO',
      categoria: 'horario',
      titulo: 'Descanso mínimo entre períodos de trabalho',
      descricao: 'Entre dois períodos diários de trabalho existe um descanso mínimo de 11 horas.',
      valor: JSON.stringify({ horas_min: 11 }),
      vigente_desde: '2003-12-01',
      fonte: 'Código do Trabalho, Art. 214.º'
    },
    {
      codigo: 'CT_232_FERIAS_MIN',
      categoria: 'ferias',
      titulo: 'Duração mínima das férias anuais',
      descricao: 'O trabalhador tem direito a 22 dias úteis de férias por ano.',
      valor: JSON.stringify({ dias_uteis: 22 }),
      vigente_desde: '2003-12-01',
      fonte: 'Código do Trabalho, Art. 238.º'
    },
    {
      codigo: 'CT_268_HE_LIMITE_ANO',
      categoria: 'horas_extra',
      titulo: 'Limite anual de horas extraordinárias',
      descricao: 'O trabalhador não pode prestar mais de 150 horas extraordinárias por ano (200 em PME).',
      valor: JSON.stringify({ horas_max_ano: 150, horas_max_ano_pme: 200 }),
      vigente_desde: '2003-12-01',
      fonte: 'Código do Trabalho, Art. 268.º'
    },
    {
      codigo: 'CT_268_HE_AUMENTO_1',
      categoria: 'horas_extra',
      titulo: 'Acréscimo por horas extraordinárias — 1.ª hora',
      descricao: 'A 1.ª hora ou fração de hora extraordinária em dia normal tem acréscimo de 25%.',
      valor: JSON.stringify({ acrescimo_percent: 25, hora: 1 }),
      vigente_desde: '2003-12-01',
      fonte: 'Código do Trabalho, Art. 268.º'
    },
    {
      codigo: 'CT_268_HE_AUMENTO_2',
      categoria: 'horas_extra',
      titulo: 'Acréscimo por horas extraordinárias — horas seguintes',
      descricao: 'Horas seguintes à 1.ª hora extraordinária em dia normal têm acréscimo de 37,5%.',
      valor: JSON.stringify({ acrescimo_percent: 37.5 }),
      vigente_desde: '2003-12-01',
      fonte: 'Código do Trabalho, Art. 268.º'
    },
    {
      codigo: 'CT_268_HE_DESCANSO',
      categoria: 'horas_extra',
      titulo: 'Acréscimo por horas em dia de descanso ou feriado',
      descricao: 'Trabalho em dia de descanso semanal ou feriado tem acréscimo de 50%.',
      valor: JSON.stringify({ acrescimo_percent: 50 }),
      vigente_desde: '2003-12-01',
      fonte: 'Código do Trabalho, Art. 268.º'
    },
    {
      codigo: 'CT_233_SUBSIDIO_FERIAS',
      categoria: 'subsidios',
      titulo: 'Subsídio de férias',
      descricao: 'O trabalhador tem direito a subsídio de férias de valor igual à retribuição do período de férias.',
      valor: JSON.stringify({ igual_a_salario: true }),
      vigente_desde: '2003-12-01',
      fonte: 'Código do Trabalho, Art. 264.º'
    },
    {
      codigo: 'CT_SUBSIDIO_NATAL',
      categoria: 'subsidios',
      titulo: 'Subsídio de Natal',
      descricao: 'O trabalhador tem direito a subsídio de Natal de valor igual a um mês de retribuição.',
      valor: JSON.stringify({ meses: 1 }),
      vigente_desde: '2003-12-01',
      fonte: 'Código do Trabalho, Art. 263.º'
    },
    {
      codigo: 'IRS_2025_TAXA_1',
      categoria: 'irs',
      titulo: 'Taxa de IRS — 1.º escalão 2025',
      descricao: 'Rendimento até 7.703€ — taxa de 13%.',
      valor: JSON.stringify({ limite_superior: 7703, taxa: 13, taxa_media: 13 }),
      vigente_desde: '2025-01-01',
      fonte: 'Lei do OE 2025'
    },
    {
      codigo: 'IRS_2025_TAXA_2',
      categoria: 'irs',
      titulo: 'Taxa de IRS — 2.º escalão 2025',
      descricao: 'Rendimento de 7.703€ a 11.623€ — taxa de 18%.',
      valor: JSON.stringify({ limite_inferior: 7703, limite_superior: 11623, taxa: 18, taxa_media: 14.95 }),
      vigente_desde: '2025-01-01',
      fonte: 'Lei do OE 2025'
    },
    {
      codigo: 'SS_TAXA_FUNCIONARIO',
      categoria: 'seguranca_social',
      titulo: 'Taxa de Segurança Social — Trabalhador',
      descricao: 'O trabalhador desconta 11% do salário bruto para a Segurança Social.',
      valor: JSON.stringify({ taxa_percent: 11 }),
      vigente_desde: '2011-01-01',
      fonte: 'Código dos Regimes Contributivos'
    },
    {
      codigo: 'SS_TAXA_ENTIDADE',
      categoria: 'seguranca_social',
      titulo: 'Taxa de Segurança Social — Entidade Patronal',
      descricao: 'A entidade patronal contribui com 23,75% do salário bruto para a Segurança Social.',
      valor: JSON.stringify({ taxa_percent: 23.75 }),
      vigente_desde: '2011-01-01',
      fonte: 'Código dos Regimes Contributivos'
    },
    {
      codigo: 'CT_TRABALHO_NOTURNO',
      categoria: 'horario',
      titulo: 'Trabalho noturno — acréscimo',
      descricao: 'O trabalho noturno (22h-7h) tem acréscimo de 25% face ao trabalho diurno.',
      valor: JSON.stringify({ hora_inicio: '22:00', hora_fim: '07:00', acrescimo_percent: 25 }),
      vigente_desde: '2003-12-01',
      fonte: 'Código do Trabalho, Art. 266.º'
    },
    {
      codigo: 'SMN_2025',
      categoria: 'salario',
      titulo: 'Salário Mínimo Nacional 2025',
      descricao: 'Salário mínimo nacional fixado em 870€ mensais.',
      valor: JSON.stringify({ valor_mensal: 870, valor_hora: 4.99 }),
      vigente_desde: '2025-01-01',
      fonte: 'Decreto-Lei n.º 108-A/2024'
    },
  ];

  for (const regra of regrasLegais) {
    await query(`
      INSERT INTO regra_legal (codigo, categoria, titulo, descricao, valor, vigente_desde, fonte)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)
      ON CONFLICT (codigo) DO UPDATE SET
        valor = EXCLUDED.valor,
        vigente_desde = EXCLUDED.vigente_desde
    `, [regra.codigo, regra.categoria, regra.titulo, regra.descricao,
        regra.valor, regra.vigente_desde, regra.fonte]);
  }
  console.log('✅ Regras legais inseridas');

  // ── Feriados nacionais 2025 ────────────────────────────────────────────────
  const feriados2025 = [
    { nome: 'Ano Novo',                         data: '2025-01-01' },
    { nome: 'Carnaval',                          data: '2025-03-04' },
    { nome: 'Sexta-feira Santa',                 data: '2025-04-18' },
    { nome: 'Páscoa',                            data: '2025-04-20' },
    { nome: 'Dia da Liberdade',                  data: '2025-04-25' },
    { nome: 'Dia do Trabalhador',                data: '2025-05-01' },
    { nome: 'Dia de Portugal',                   data: '2025-06-10' },
    { nome: 'Corpo de Deus',                     data: '2025-06-19' },
    { nome: 'Assunção de Nossa Senhora',         data: '2025-08-15' },
    { nome: 'República Portuguesa',              data: '2025-10-05' },
    { nome: 'Dia de Todos os Santos',            data: '2025-11-01' },
    { nome: 'Restauração da Independência',      data: '2025-12-01' },
    { nome: 'Imaculada Conceição',               data: '2025-12-08' },
    { nome: 'Natal',                             data: '2025-12-25' },
  ];

  const feriados2026 = [
    { nome: 'Ano Novo',                          data: '2026-01-01' },
    { nome: 'Sexta-feira Santa',                 data: '2026-04-03' },
    { nome: 'Páscoa',                            data: '2026-04-05' },
    { nome: 'Dia da Liberdade',                  data: '2026-04-25' },
    { nome: 'Dia do Trabalhador',                data: '2026-05-01' },
    { nome: 'Dia de Portugal',                   data: '2026-06-10' },
    { nome: 'Corpo de Deus',                     data: '2026-06-04' },
    { nome: 'Assunção de Nossa Senhora',         data: '2026-08-15' },
    { nome: 'República Portuguesa',              data: '2026-10-05' },
    { nome: 'Dia de Todos os Santos',            data: '2026-11-01' },
    { nome: 'Restauração da Independência',      data: '2026-12-01' },
    { nome: 'Imaculada Conceição',               data: '2026-12-08' },
    { nome: 'Natal',                             data: '2026-12-25' },
  ];

  for (const f of [...feriados2025, ...feriados2026]) {
    const ano = parseInt(f.data.substring(0, 4));
    await query(`
      INSERT INTO feriado (nome, data, tipo, ano)
      VALUES ($1, $2, 'nacional', $3)
      ON CONFLICT DO NOTHING
    `, [f.nome, f.data, ano]);
  }
  console.log('✅ Feriados inseridos');

  // ── Empresa e utilizador demo ──────────────────────────────────────────────
  const empresaRes = await query(`
    INSERT INTO empresa (nome, nif, setor, email, modulos_ativos)
    VALUES ('NexEdge — Demo', '123456789', 'Serviços', 'demo@empresademo.pt',
      '["funcionarios","ferias","horarios","salarios","legislacao","relatorios","documentos"]'::jsonb)
    ON CONFLICT (nif) DO UPDATE SET nome = EXCLUDED.nome
    RETURNING id
  `);
  const empresaId = empresaRes.rows[0].id;

  const adminHash = await bcrypt.hash('Admin@2025!', 12);
  const adminRes = await query(`
    INSERT INTO utilizador (empresa_id, email, password_hash, perfil, nome_completo)
    VALUES ($1, 'admin@empresademo.pt', $2, 'admin_empresa', 'Administrador Demo')
    ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
    RETURNING id
  `, [empresaId, adminHash]);

  const rhHash = await bcrypt.hash('RH@2025!', 12);
  await query(`
    INSERT INTO utilizador (empresa_id, email, password_hash, perfil, nome_completo)
    VALUES ($1, 'rh@empresademo.pt', $2, 'rh', 'Técnico de RH Demo')
    ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
  `, [empresaId, rhHash]);

  // Feriados nacionais portugueses
  await query(`
    INSERT INTO feriado (empresa_id, nome, data, ano, tipo, recorrente) VALUES
    ($1, 'Ano Novo',                    '2025-01-01', 2025, 'nacional', true),
    ($1, 'Carnaval',                    '2025-03-04', 2025, 'nacional', false),
    ($1, 'Sexta-Feira Santa',           '2025-04-18', 2025, 'nacional', false),
    ($1, 'Páscoa',                      '2025-04-20', 2025, 'nacional', false),
    ($1, 'Dia da Liberdade',            '2025-04-25', 2025, 'nacional', true),
    ($1, 'Dia do Trabalhador',          '2025-05-01', 2025, 'nacional', true),
    ($1, 'Dia de Portugal',             '2025-06-10', 2025, 'nacional', true),
    ($1, 'Corpo de Deus',               '2025-06-19', 2025, 'nacional', false),
    ($1, 'Assunção de Nossa Senhora',   '2025-08-15', 2025, 'nacional', true),
    ($1, 'Implantação da República',    '2025-10-05', 2025, 'nacional', true),
    ($1, 'Dia de Todos os Santos',      '2025-11-01', 2025, 'nacional', true),
    ($1, 'Restauração da Independência','2025-12-01', 2025, 'nacional', true),
    ($1, 'Imaculada Conceição',         '2025-12-08', 2025, 'nacional', true),
    ($1, 'Natal',                       '2025-12-25', 2025, 'nacional', true),
    ($1, 'Santo António (Lisboa)',      '2025-06-13', 2025, 'municipal', true),
    ($1, 'São João (Porto)',            '2025-06-24', 2025, 'municipal', true)
    ON CONFLICT DO NOTHING
  `, [empresaId]);
  console.log('✅ Feriados nacionais inseridos');

  // Departamentos padrão
  await query(`
    INSERT INTO departamento (empresa_id, nome, descricao)
    SELECT $1, d.nome, d.desc FROM (VALUES
      ('Administração', 'Direcção e gestão executiva'),
      ('Recursos Humanos', 'Gestão de pessoas e RH'),
      ('Comercial', 'Vendas e desenvolvimento de negócio'),
      ('Marketing', 'Marketing e comunicação'),
      ('Financeiro', 'Finanças e contabilidade'),
      ('Tecnologias de Informação', 'IT e infraestrutura'),
      ('Operações', 'Produção e logística'),
      ('Qualidade', 'Qualidade e processos')
    ) AS d(nome, desc)
    WHERE NOT EXISTS (SELECT 1 FROM departamento WHERE empresa_id=$1)
  `, [empresaId]);
  console.log('✅ Departamentos padrão inseridos');

  // Bandas salariais padrão (após níveis hierárquicos serem criados)
  await query(`
    INSERT INTO banda_salarial (empresa_id, nome, salario_minimo, salario_medio, salario_maximo)
    VALUES
    ($1, 'CEO / Administrador',        4000, 6000, 12000),
    ($1, 'Director',                   2500, 3500,  6000),
    ($1, 'Manager / Chefe de Divisão', 1800, 2500,  4000),
    ($1, 'Supervisor',                 1500, 1900,  2800),
    ($1, 'Team Leader',                1300, 1600,  2200),
    ($1, 'Técnico / Especialista',     1100, 1400,  2000),
    ($1, 'Funcionário',                 870, 1100,  1600),
    ($1, 'Estagiário',                  870,  900,  1000)
    ON CONFLICT DO NOTHING
  `, [empresaId]);
  console.log('✅ Bandas salariais inseridas');

  // Centros de custo padrão
  await query(`
    INSERT INTO centro_custo (empresa_id, codigo, nome, descricao) VALUES
    ($1, 'CC001', 'Gestão e Administração',    'Custos da direcção e administração'),
    ($1, 'CC002', 'Comercial e Marketing',     'Custos da área comercial e marketing'),
    ($1, 'CC003', 'Operações e Produção',      'Custos operacionais e produção'),
    ($1, 'CC004', 'Recursos Humanos',          'Custos do departamento de RH'),
    ($1, 'CC005', 'Tecnologias de Informação', 'Custos de IT e infraestrutura'),
    ($1, 'CC006', 'Financeiro e Contabilidade','Custos financeiros e contabilísticos')
    ON CONFLICT DO NOTHING
  `, [empresaId]);
  console.log('✅ Centros de custo inseridos');

  // Áreas de negócio padrão
  await query(`
    INSERT INTO area_negocio (empresa_id, nome, descricao, cor) VALUES
    ($1, 'Gestão',       'Administração, Direcção e Gestão Executiva',        '#0A0F1E'),
    ($1, 'Comercial',    'Vendas, Marketing e Desenvolvimento de Negócio',    '#185FA5'),
    ($1, 'Operacional',  'Produção, Logística e Operações',                   '#1D9E75'),
    ($1, 'Suporte',      'RH, Financeiro, IT e Serviços Administrativos',     '#7C3AED'),
    ($1, 'Técnica',      'Engenharia, Qualidade e Investigação & Desenvolvimento', '#D97706')
    ON CONFLICT DO NOTHING
  `, [empresaId]);
  console.log('✅ Áreas de negócio inseridas');

  // Níveis hierárquicos padrão
  await query(`
    INSERT INTO nivel_hierarquico (empresa_id, nome, nivel, descricao, cor) VALUES
    ($1, 'CEO / Administrador',        1, 'Responsável máximo da organização',          '#0A0F1E'),
    ($1, 'Director',                   2, 'Director de área ou departamento',            '#185FA5'),
    ($1, 'Manager / Chefe de Divisão', 3, 'Gestor de divisão ou unidade de negócio',    '#1D9E75'),
    ($1, 'Supervisor',                 4, 'Supervisão de equipas operacionais',          '#7C3AED'),
    ($1, 'Team Leader',                5, 'Liderança de equipa de trabalho',             '#D97706'),
    ($1, 'Técnico / Especialista',     6, 'Colaborador especializado',                   '#374151'),
    ($1, 'Funcionário',                7, 'Colaborador operacional',                     '#374151'),
    ($1, 'Estagiário',                 8, 'Em regime de estágio profissional/curricular','#6B7280')
    ON CONFLICT DO NOTHING
  `, [empresaId]);
  console.log('✅ Níveis hierárquicos inseridos');

  // ── Funcionários demo ───────────────────────────────────────────────────
  const { rows: [emp] } = await pool.query('SELECT id FROM empresa WHERE email_admin=$1', ['admin@empresademo.pt']);
  if (emp) {
    const deptRows = await pool.query('SELECT id, nome FROM departamento WHERE empresa_id=$1', [emp.id]);
    const deptos = {};
    deptRows.rows.forEach(d => deptos[d.nome] = d.id);

    const funcs = [
      { nome: 'Ana Silva', cargo: 'Gestora de RH', depto: 'Recursos Humanos', email: 'ana.silva@empresademo.pt', salario: 1800, nif: '123456789', niss: '12345678901', estado_civil: 'casado_unico_titular', dependentes: 2, admissao: '2020-03-15' },
      { nome: 'João Santos', cargo: 'Diretor Financeiro', depto: 'Financeiro', email: 'joao.santos@empresademo.pt', salario: 3200, nif: '234567890', niss: '23456789012', estado_civil: 'casado_dois_titulares', dependentes: 1, admissao: '2018-06-01' },
      { nome: 'Maria Costa', cargo: 'Técnica de Marketing', depto: 'Marketing', email: 'maria.costa@empresademo.pt', salario: 1500, nif: '345678901', niss: '34567890123', estado_civil: 'nao_casado', dependentes: 0, admissao: '2022-01-10' },
      { nome: 'Pedro Ferreira', cargo: 'Engenheiro de Software', depto: 'Tecnologias de Informação', email: 'pedro.ferreira@empresademo.pt', salario: 2400, nif: '456789012', niss: '45678901234', estado_civil: 'nao_casado', dependentes: 0, admissao: '2021-09-01' },
      { nome: 'Carla Oliveira', cargo: 'Assistente Administrativa', depto: 'Administração', email: 'carla.oliveira@empresademo.pt', salario: 1200, nif: '567890123', niss: '56789012345', estado_civil: 'casado_unico_titular', dependentes: 3, admissao: '2019-11-20' },
      { nome: 'Rui Mendes', cargo: 'Técnico Comercial', depto: 'Comercial', email: 'rui.mendes@empresademo.pt', salario: 1600, nif: '678901234', niss: '67890123456', estado_civil: 'nao_casado', dependentes: 0, admissao: '2023-02-15' },
      { nome: 'Sofia Rodrigues', cargo: 'Gestora de Qualidade', depto: 'Qualidade', email: 'sofia.rodrigues@empresademo.pt', salario: 1900, nif: '789012345', niss: '78901234567', estado_civil: 'casado_dois_titulares', dependentes: 2, admissao: '2020-07-01' },
      { nome: 'Bruno Lopes', cargo: 'Técnico de Operações', depto: 'Operações', email: 'bruno.lopes@empresademo.pt', salario: 1400, nif: '890123456', niss: '89012345678', estado_civil: 'nao_casado', dependentes: 0, admissao: '2022-05-16' },
    ];

    const hash = await bcrypt.hash('Demo@2025!', 12);
    for (let i = 0; i < funcs.length; i++) {
      const f = funcs[i];
      const num = String(i + 1).padStart(4, '0');
      const deptoId = deptos[f.depto] || null;
      try {
        const { rows: [func] } = await pool.query(`
          INSERT INTO funcionario (empresa_id, departamento_id, numero_funcionario, nome_completo, cargo,
            email_empresa, nif, niss, salario_base, subsidio_alimentacao, tipo_subsidio_alimentacao,
            estado_civil, num_dependentes, data_admissao, tipo_contrato, estado,
            horas_semanais, dias_ferias_ano, dias_ferias_saldo, num_cc, nacionalidade)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,6.15,'dinheiro',$10,$11,$12,'sem_termo','ativo',40,22,22,'000000000','Portuguesa')
          ON CONFLICT DO NOTHING RETURNING id
        `, [emp.id, deptoId, num, f.nome, f.cargo, f.email, f.nif, f.niss, f.salario, f.estado_civil, f.dependentes, f.admissao]);

        if (func) {
          const { rows: [user] } = await pool.query(`
            INSERT INTO utilizador (empresa_id, nome_completo, email, password_hash, perfil, mudar_password)
            VALUES ($1,$2,$3,$4,'funcionario',false) ON CONFLICT (email) DO NOTHING RETURNING id
          `, [emp.id, f.nome, f.email, hash]);
          if (user) {
            await pool.query('UPDATE funcionario SET utilizador_id=$1 WHERE id=$2', [user.id, func.id]);
          }
        }
      } catch(e) { console.warn('Skip funcionario demo:', f.nome, e.message); }
    }
    console.log('✅ Funcionários demo inseridos (8 colaboradores)');
  }

  console.log('✅ Dados de demonstração inseridos');
  console.log('');
  console.log('═══════════════════════════════════════');
  console.log('  CREDENCIAIS DE ACESSO (DEMO)');
  console.log('  Admin:  admin@empresademo.pt / Admin@2025!');
  console.log('  RH:     rh@empresademo.pt / RH@2025!');
  console.log('═══════════════════════════════════════');

  await pool.end();
}

seed().catch(err => {
  console.error('❌ Erro no seed:', err);
  process.exit(1);
});
