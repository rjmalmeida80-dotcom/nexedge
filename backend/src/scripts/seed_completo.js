'use strict';
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const pool = new Pool({ host:'postgres', database:'plataforma_rh', user:'postgres', password:'rh_password_local' });

async function q(sql, params) {
  return pool.query(sql, params).catch(e => {
    console.warn('  ⚠️', e.message.substring(0,80));
    return { rows:[] };
  });
}

async function seed() {
  console.log('🌱 Seed completo — todos os módulos\n');

  // Buscar empresa e admin existentes
  const { rows:[emp] } = await pool.query("SELECT * FROM empresa WHERE nif='509876543' LIMIT 1");
  const { rows:[admin] } = await pool.query("SELECT * FROM utilizador WHERE email='admin@techsol.pt' LIMIT 1");
  const empId = emp.id;
  const adminId = admin.id;

  // Buscar colaboradores
  const { rows: funcs } = await pool.query(
    "SELECT f.*, d.nome AS depto_nome FROM funcionario f LEFT JOIN departamento d ON d.id=f.departamento_id WHERE f.empresa_id=$1 AND f.estado='ativo' ORDER BY f.numero_funcionario",
    [empId]
  );
  console.log(`✅ ${funcs.length} colaboradores encontrados`);

  // ── CONTRATOS DE TRABALHO ────────────────────────────────────────────────
  console.log('\n📋 Contratos de trabalho...');
  const tiposContrato = ['sem_termo', 'termo_certo', 'sem_termo', 'termo_certo', 'sem_termo',
                          'sem_termo', 'termo_certo', 'sem_termo', 'sem_termo', 'prestacao_servicos'];
  for (let i = 0; i < funcs.length; i++) {
    const f = funcs[i];
    const dataFim = tiposContrato[i] === 'termo_certo' ? `2027-0${(i%12)+1}-01` : null;
    await q(`
      INSERT INTO contrato_trabalho (empresa_id, funcionario_id, tipo_contrato, data_inicio, data_fim, notas)
      VALUES ($1,$2,$3,'2023-01-01',$4,$5)
    `, [empId, f.id, tiposContrato[i], dataFim, `Contrato de trabalho — ${f.nome_completo}`]);
  }
  console.log('✅ Contratos criados');

  // ── PRESENÇAS / REGISTO DE PONTO ─────────────────────────────────────────
  console.log('\n📋 Presenças...');
  let nPresencas = 0;
  for (const f of funcs.slice(0,5)) {
    for (let dia = 1; dia <= 20; dia++) {
      const d = new Date(2026, 6, dia); // Julho 2026
      if (d.getDay() === 0 || d.getDay() === 6) continue;
      await q(`
        INSERT INTO registo_ponto (funcionario_id, empresa_id, data, hora_entrada, hora_saida, horas_trabalhadas, horas_extra, tipo)
        VALUES ($1,$2,$3,'09:00','18:00',8,0,'normal')
      `, [f.id, empId, `2026-07-${String(dia).padStart(2,'0')}`]);
      nPresencas++;
    }
  }
  console.log(`✅ ${nPresencas} presenças criadas`);

  // ── FALTAS ────────────────────────────────────────────────────────────────
  console.log('\n📋 Faltas...');
  const tiposFalta = ['injustificada', 'justificada', 'baixa_medica', 'injustificada'];
  for (let i = 0; i < 4; i++) {
    await q(`
      INSERT INTO falta (funcionario_id, empresa_id, data, tipo, estado, motivo)
      VALUES ($1,$2,$3,$4,'aprovada',$5)
    `, [funcs[i].id, empId, `2026-07-${String(i+3).padStart(2,'0')}`, tiposFalta[i], `Falta ${tiposFalta[i]}`]);
  }
  console.log('✅ Faltas criadas');

  // ── HORÁRIOS ──────────────────────────────────────────────────────────────
  console.log('\n📋 Horários...');
  await q(`
    INSERT INTO horario_trabalho (empresa_id, nome, hora_entrada, hora_saida, horas_dia, dias_semana, ativo)
    VALUES ($1,'Horário Standard','09:00','18:00',8,'[1,2,3,4,5]',true)
  `, [empId]);
  await q(`
    INSERT INTO horario_trabalho (empresa_id, nome, hora_entrada, hora_saida, horas_dia, dias_semana, ativo)
    VALUES ($1,'Horário Flexível','08:00','17:00',8,'[1,2,3,4,5]',true)
  `, [empId]);
  console.log('✅ Horários criados');

  // ── AVALIAÇÕES ────────────────────────────────────────────────────────────
  console.log('\n📋 Avaliações...');
  for (let i = 0; i < Math.min(funcs.length, 5); i++) {
    await q(`
      INSERT INTO avaliacao_desempenho (empresa_id, funcionario_id, avaliador_id, periodo, ano,
        nota_geral, nota_objetivos, nota_competencias, estado, comentarios)
      VALUES ($1,$2,$3,'anual',2025,$4,$5,$6,'concluida',$7)
    `, [empId, funcs[i].id, adminId,
        (3.5 + i*0.3).toFixed(1), (3.0 + i*0.4).toFixed(1), (4.0 + i*0.2).toFixed(1),
        `Excelente desempenho no período. Colaborador demonstrou grande comprometimento.`]);
  }
  console.log('✅ Avaliações criadas');

  // ── FORMAÇÕES ─────────────────────────────────────────────────────────────
  console.log('\n📋 Formações...');
  const formacoes = [
    { nome:'Excel Avançado', categoria:'informatica', duracao:16, estado:'concluida' },
    { nome:'Liderança e Gestão de Equipas', categoria:'gestao', duracao:24, estado:'concluida' },
    { nome:'RGPD e Protecção de Dados', categoria:'legal', duracao:8, estado:'em_curso' },
    { nome:'Segurança no Trabalho', categoria:'sst', duracao:12, estado:'planeada' },
  ];
  for (const form of formacoes) {
    const { rows:[f] } = await q(`
      INSERT INTO formacao (empresa_id, nome, categoria, duracao_horas, data_inicio,
        data_fim, estado, entidade_formadora, local, custo)
      VALUES ($1,$2,$3,$4,'2026-05-01','2026-05-05',$5,'Formação PT','Lisboa',500)
      RETURNING id
    `, [empId, form.nome, form.categoria, form.duracao, form.estado]);
    if (f && funcs[0]) {
      await q(`
        INSERT INTO formacao_participante (formacao_id, funcionario_id, estado, nota)
        VALUES ($1,$2,'concluido',${(Math.random()*2+3).toFixed(1)})
      `, [f.id, funcs[0].id]);
    }
  }
  console.log('✅ Formações criadas');

  // ── RECRUTAMENTO ──────────────────────────────────────────────────────────
  console.log('\n📋 Recrutamento...');
  const vagas = [
    { titulo:'Desenvolvedor Full Stack', depto:'Tecnologia', estado:'aberta' },
    { titulo:'Gestor de Produto', depto:'Tecnologia', estado:'em_analise' },
    { titulo:'Técnico de RH', depto:'Recursos Humanos', estado:'fechada' },
  ];
  for (const v of vagas) {
    const { rows:[vaga] } = await q(`
      INSERT INTO vaga (empresa_id, titulo, departamento, estado, data_abertura,
        descricao, requisitos, tipo_contrato, salario_min, salario_max)
      VALUES ($1,$2,$3,$4,CURRENT_DATE,$5,$6,'sem_termo',2000,4000) RETURNING id
    `, [empId, v.titulo, v.depto, v.estado,
        `Procuramos ${v.titulo} com experiência mínima de 3 anos.`,
        'Licenciatura na área, experiência relevante, boa comunicação.']);
    if (vaga) {
      for (let c = 0; c < 3; c++) {
        await q(`
          INSERT INTO candidatura (vaga_id, empresa_id, nome, email, telefone, estado, cv_url)
          VALUES ($1,$2,$3,$4,'+351 9${c}0 000 00${c}','em_analise','https://cv.exemplo.pt/cv${c}.pdf')
        `, [vaga.id, empId, `Candidato ${c+1} para ${v.titulo}`, `candidato${c+1}@email.pt`]);
      }
    }
  }
  console.log('✅ Vagas e candidaturas criadas');

  // ── ONBOARDING ────────────────────────────────────────────────────────────
  console.log('\n📋 Onboarding...');
  for (let i = 0; i < 2; i++) {
    const { rows:[ob] } = await q(`
      INSERT INTO onboarding_processo (empresa_id, funcionario_id, data_inicio, estado, progresso)
      VALUES ($1,$2,CURRENT_DATE,'em_curso',${30 + i*20}) RETURNING id
    `, [empId, funcs[i].id]);
    if (ob) {
      const tarefas = ['Assinar contrato','Configurar email','Tour às instalações','Reunião com equipa'];
      for (let t = 0; t < tarefas.length; t++) {
        await q(`
          INSERT INTO onboarding_tarefa (processo_id, titulo, descricao, ordem, concluida)
          VALUES ($1,$2,$3,$4,$5)
        `, [ob.id, tarefas[t], `Completar: ${tarefas[t]}`, t+1, t < 2]);
      }
    }
  }
  console.log('✅ Onboarding criado');

  // ── EQUIPAMENTOS ──────────────────────────────────────────────────────────
  console.log('\n📋 Equipamentos...');
  const equips = [
    { nome:'MacBook Pro 14"', tipo:'computador', serie:'MBP2024001', valor:2499 },
    { nome:'Monitor LG 27"', tipo:'monitor', serie:'LG27001', valor:399 },
    { nome:'iPhone 15 Pro', tipo:'telemovel', serie:'IPH15001', valor:1199 },
    { nome:'Cadeira Ergonómica', tipo:'mobiliario', serie:'CAD001', valor:599 },
  ];
  for (let i = 0; i < equips.length; i++) {
    await q(`
      INSERT INTO equipamento (empresa_id, nome, tipo, numero_serie, valor_aquisicao,
        data_aquisicao, estado, funcionario_id)
      VALUES ($1,$2,$3,$4,$5,'2024-01-01','activo',$6)
    `, [empId, equips[i].nome, equips[i].tipo, equips[i].serie,
        equips[i].valor, funcs[i % funcs.length].id]);
  }
  console.log('✅ Equipamentos criados');

  // ── FROTA ─────────────────────────────────────────────────────────────────
  console.log('\n📋 Frota...');
  const viaturas = [
    { matricula:'AB-12-CD', marca:'Volkswagen', modelo:'Golf', ano:2022, combustivel:'gasolina' },
    { matricula:'EF-34-GH', marca:'Toyota', modelo:'Corolla', ano:2023, combustivel:'hibrido' },
    { matricula:'IJ-56-KL', marca:'Ford', modelo:'Transit', ano:2021, combustivel:'diesel' },
  ];
  for (const v of viaturas) {
    const { rows:[vt] } = await q(`
      INSERT INTO viatura (empresa_id, matricula, marca, modelo, ano, combustivel,
        estado, km_actuais, data_proxima_inspecao, data_fim_seguro)
      VALUES ($1,$2,$3,$4,$5,$6,'activa',${Math.floor(Math.random()*50000)+5000},
        '2027-01-01','2027-06-30') RETURNING id
    `, [empId, v.matricula, v.marca, v.modelo, v.ano, v.combustivel]);
    if (vt) {
      await q(`
        INSERT INTO manutencao_viatura (viatura_id, empresa_id, tipo, data, km, custo, descricao, estado)
        VALUES ($1,$2,'revisao','2026-03-01',${Math.floor(Math.random()*30000)},250,'Revisão anual','concluida')
      `, [vt.id, empId]);
    }
  }
  console.log('✅ Frota criada');

  // ── DESPESAS ──────────────────────────────────────────────────────────────
  console.log('\n📋 Despesas...');
  const categoriasDespesa = ['deslocacao','refeicao','hotel','material','outro'];
  for (let i = 0; i < 8; i++) {
    await q(`
      INSERT INTO despesa (empresa_id, funcionario_id, data, categoria, descricao,
        valor, estado, comprovativo_url)
      VALUES ($1,$2,'2026-07-0${(i%7)+1}',$3,$4,$5,$6,'https://comp.pt/comp${i}.pdf')
    `, [empId, funcs[i % funcs.length].id,
        categoriasDespesa[i % 5],
        `Despesa ${categoriasDespesa[i%5]} — ref ${i+1}`,
        (20 + i*15).toFixed(2),
        i < 4 ? 'aprovada' : i < 6 ? 'pendente' : 'rejeitada']);
  }
  console.log('✅ Despesas criadas');

  // ── COMPRAS ───────────────────────────────────────────────────────────────
  console.log('\n📋 Compras...');
  const fornecedores = ['Fornecedor Alpha Lda', 'Beta Supplies SA', 'Gamma Tech'];
  for (let i = 0; i < 3; i++) {
    const { rows:[oc] } = await q(`
      INSERT INTO ordem_compra (empresa_id, numero, fornecedor_nome, data_emissao,
        data_entrega_prevista, estado, total, criado_por)
      VALUES ($1,$2,$3,CURRENT_DATE, CURRENT_DATE + INTERVAL '15 days',$4,$5,$6) RETURNING id
    `, [empId, `OC-2026-00${i+1}`, fornecedores[i],
        i === 0 ? 'aprovada' : i === 1 ? 'pendente' : 'recebida',
        (500 + i*300).toFixed(2), adminId]);
    if (oc) {
      await q(`
        INSERT INTO linha_ordem_compra (ordem_compra_id, descricao, quantidade, preco_unitario, total)
        VALUES ($1,$2,${i+2},$3,$4)
      `, [oc.id, `Artigo ${i+1} — material de escritório`, (100+i*50).toFixed(2), ((i+2)*(100+i*50)).toFixed(2)]);
    }
  }
  console.log('✅ Compras criadas');

  // ── CONTABILIDADE ─────────────────────────────────────────────────────────
  console.log('\n📋 Contabilidade...');
  const lancamentos = [
    { conta:'11', descricao:'Depósito inicial caixa', debito:5000, credito:0 },
    { conta:'21', descricao:'Pagamento fornecedor Alpha', debito:0, credito:1200 },
    { conta:'31', descricao:'Compra mercadorias', debito:2500, credito:0 },
    { conta:'71', descricao:'Venda de serviços', debito:0, credito:8500 },
    { conta:'63', descricao:'Salários do mês', debito:15000, credito:0 },
  ];
  for (const l of lancamentos) {
    await q(`
      INSERT INTO lancamento_contabilistico (empresa_id, data, conta, descricao,
        debito, credito, documento_ref, criado_por)
      VALUES ($1,CURRENT_DATE,$2,$3,$4,$5,'DOC-2026-001',$6)
    `, [empId, l.conta, l.descricao, l.debito, l.credito, adminId]);
  }
  console.log('✅ Lançamentos contabilísticos criados');

  // ── ACTIVOS FIXOS ─────────────────────────────────────────────────────────
  console.log('\n📋 Activos Fixos...');
  const ativos = [
    { nome:'Servidor Dell PowerEdge', categoria:'equipamento_informatico', valor:8500, vida:5 },
    { nome:'Mobiliário Escritório', categoria:'mobiliario', valor:12000, vida:10 },
    { nome:'Ar Condicionado Split', categoria:'instalacoes', valor:2200, vida:15 },
  ];
  for (const a of ativos) {
    await q(`
      INSERT INTO ativo_fixo (empresa_id, nome, categoria, valor_aquisicao, vida_util_anos,
        data_aquisicao, estado, taxa_amortizacao)
      VALUES ($1,$2,$3,$4,$5,'2024-01-01','activo',${(100/a.vida).toFixed(2)})
    `, [empId, a.nome, a.categoria, a.valor, a.vida]);
  }
  console.log('✅ Activos fixos criados');

  // ── SAÚDE E SST ───────────────────────────────────────────────────────────
  console.log('\n📋 Saúde & SST...');
  for (let i = 0; i < Math.min(funcs.length, 5); i++) {
    await q(`
      INSERT INTO medicina_trabalho (empresa_id, funcionario_id, tipo_exame,
        data_exame, data_proximo_exame, resultado, medico, apto)
      VALUES ($1,$2,'admissao','2023-01-15','2025-01-15','Normal','Dr. Silva',true)
    `, [empId, funcs[i].id]);
  }
  await q(`
    INSERT INTO incidente_sst (empresa_id, funcionario_id, data, tipo, descricao,
      gravidade, estado, acoes_tomadas)
    VALUES ($1,$2,'2026-06-15','quase_acidente',
      'Colaborador escorregou no corredor molhado','baixa','resolvido',
      'Colocação de tapetes antiderrapantes e sinalização de aviso')
  `, [empId, funcs[0].id]);
  console.log('✅ Medicina do trabalho e incidentes criados');

  // ── DOCUMENTOS ────────────────────────────────────────────────────────────
  console.log('\n📋 Documentos...');
  const documentos = [
    { nome:'Manual de Acolhimento 2026', tipo:'manual', funcionario_id: null },
    { nome:'Política de Férias', tipo:'politica', funcionario_id: null },
    { nome:'Regulamento Interno', tipo:'regulamento', funcionario_id: null },
  ];
  for (const d of documentos) {
    await q(`
      INSERT INTO documento (empresa_id, funcionario_id, nome, tipo, url, tamanho, criado_por)
      VALUES ($1,$2,$3,$4,'https://docs.nexedge.pt/doc${Math.random().toString(36).slice(2,8)}.pdf',
        ${Math.floor(Math.random()*500000)+50000},$5)
    `, [empId, d.funcionario_id, d.nome, d.tipo, adminId]);
  }
  console.log('✅ Documentos criados');

  // ── COMUNICAÇÃO INTERNA ───────────────────────────────────────────────────
  console.log('\n📋 Comunicação Interna...');
  const avisos = [
    { titulo:'Reunião Geral — 15 Agosto', conteudo:'Reunião geral de colaboradores dia 15 de Agosto às 10h.', tipo:'aviso' },
    { titulo:'Novo Processo de Férias 2026', conteudo:'O processo de pedido de férias foi simplificado.', tipo:'noticia' },
    { titulo:'Bem-vindo Miguel Santos!', conteudo:'A equipa dá as boas-vindas ao novo DevOps Engineer.', tipo:'noticia' },
  ];
  for (const a of avisos) {
    await q(`
      INSERT INTO aviso_interno (empresa_id, titulo, conteudo, tipo, autor_id, publicado)
      VALUES ($1,$2,$3,$4,$5,true)
    `, [empId, a.titulo, a.conteudo, a.tipo, adminId]);
  }
  console.log('✅ Comunicação interna criada');

  // ── ALERTAS LEGAIS ────────────────────────────────────────────────────────
  console.log('\n📋 Alertas Legais...');
  const alertas = [
    { tipo:'contrato_expirar', mensagem:'Contrato de João Silva expira em 60 dias', prioridade:'alta' },
    { tipo:'salario_minimo', mensagem:'Actualização do salário mínimo em Janeiro 2027', prioridade:'media' },
    { tipo:'medicina_trabalho', mensagem:'Ana Costa — exame médico em atraso', prioridade:'alta' },
  ];
  for (const a of alertas) {
    await q(`
      INSERT INTO alerta (empresa_id, tipo, mensagem, prioridade, lido, data_alerta)
      VALUES ($1,$2,$3,$4,false,CURRENT_DATE)
    `, [empId, a.tipo, a.mensagem, a.prioridade]);
  }
  console.log('✅ Alertas criados');

  // ── ORGANOGRAMA ───────────────────────────────────────────────────────────
  console.log('\n📋 Organograma...');
  // Definir hierarquia — Carlos Rodrigues é Director, outros reportam a ele
  const director = funcs.find(f => f.cargo === 'Director Financeiro');
  if (director) {
    for (const f of funcs.filter(f => f.depto_nome === 'Financeiro' && f.id !== director.id)) {
      await q(`UPDATE funcionario SET superior_id=$1 WHERE id=$2`, [director.id, f.id]);
    }
  }
  console.log('✅ Hierarquia organograma definida');

  // ── TURNOS ROTATIVOS ──────────────────────────────────────────────────────
  console.log('\n📋 Turnos Rotativos...');
  const { rows:[turno] } = await q(`
    INSERT INTO turno_rotativo (empresa_id, nome, descricao, ativo)
    VALUES ($1,'Turno 3 Equipas','Rotação semanal entre manhã, tarde e noite',true) RETURNING id
  `, [empId]);
  if (turno) {
    const turnos = [
      { nome:'Manhã', hora_inicio:'06:00', hora_fim:'14:00', cor:'#10B981' },
      { nome:'Tarde', hora_inicio:'14:00', hora_fim:'22:00', cor:'#F59E0B' },
      { nome:'Noite', hora_inicio:'22:00', hora_fim:'06:00', cor:'#6366F1' },
    ];
    for (const t of turnos) {
      await q(`
        INSERT INTO tipo_turno (turno_rotativo_id, nome, hora_inicio, hora_fim, cor)
        VALUES ($1,$2,$3,$4,$5)
      `, [turno.id, t.nome, t.hora_inicio, t.hora_fim, t.cor]);
    }
  }
  console.log('✅ Turnos rotativos criados');

  // ── RELATÓRIO ÚNICO ACT ───────────────────────────────────────────────────
  console.log('\n📋 Relatório Único...');
  await q(`
    INSERT INTO relatorio_unico (empresa_id, ano, estado, data_submissao, observacoes)
    VALUES ($1,2025,'submetido','2026-03-31','Submetido dentro do prazo legal')
    ON CONFLICT DO NOTHING
  `, [empId]);
  console.log('✅ Relatório Único criado');

  // ── CALENDÁRIO ────────────────────────────────────────────────────────────
  console.log('\n📋 Calendário...');
  const eventos = [
    { titulo:'Reunião de Equipa', tipo:'reuniao', inicio:'2026-08-15 10:00', fim:'2026-08-15 11:00' },
    { titulo:'Formação Excel', tipo:'formacao', inicio:'2026-08-20 09:00', fim:'2026-08-20 17:00' },
    { titulo:'Feriado Nacional', tipo:'feriado', inicio:'2026-12-01', fim:'2026-12-01' },
  ];
  for (const e of eventos) {
    await q(`
      INSERT INTO evento_calendario (empresa_id, titulo, tipo, data_inicio, data_fim,
        criado_por, cor)
      VALUES ($1,$2,$3,$4,$5,$6,'#4F46E5')
    `, [empId, e.titulo, e.tipo, e.inicio, e.fim, adminId]);
  }
  console.log('✅ Eventos de calendário criados');

  // ── SIMULADOR SALARIAL ────────────────────────────────────────────────────
  console.log('\n📋 Simulações salariais...');
  for (let i = 0; i < 3; i++) {
    await q(`
      INSERT INTO simulacao_salarial (empresa_id, nome, salario_bruto, dependentes,
        situacao_fiscal, resultado, criado_por)
      VALUES ($1,$2,$3,$4,'casado',$5,$6)
    `, [empId, `Simulação ${i+1}`, (2000 + i*500),
        i, JSON.stringify({ liquido: (1500+i*350), irs: (200+i*80), ss: (220+i*55) }),
        adminId]);
  }
  console.log('✅ Simulações criadas');

  // ── CRM — CONTACTOS E INTERACÇÕES ────────────────────────────────────────
  console.log('\n📋 CRM — contactos e interacções...');
  const { rows: crmEmpresas } = await pool.query(
    'SELECT id, nome FROM crm_empresa WHERE empresa_id=$1 LIMIT 5', [empId]
  );
  for (const ce of crmEmpresas) {
    const { rows:[cont] } = await q(`
      INSERT INTO crm_contacto (empresa_id, crm_empresa_id, nome, cargo, email, telefone, decisor)
      VALUES ($1,$2,$3,$4,$5,'+351 210 000 001',true) RETURNING id
    `, [empId, ce.id, `Director de ${ce.nome}`, 'Director Geral', `director@${ce.nome.toLowerCase().replace(/ /g,'')}.pt`]);

    if (cont) {
      await q(`
        INSERT INTO crm_interacao (empresa_id, crm_empresa_id, crm_contacto_id, tipo,
          titulo, descricao, data_interacao, resultado, proxima_accao, data_proxima_accao)
        VALUES ($1,$2,$3,'reuniao','Reunião inicial','Apresentação da plataforma NexEdge',
          NOW(),'Interessados em proposta','Enviar proposta detalhada',
          CURRENT_DATE + INTERVAL '7 days')
      `, [empId, ce.id, cont.id]);

      await q(`
        INSERT INTO crm_tarefa (empresa_id, crm_empresa_id, titulo, tipo, prioridade,
          data_vencimento, responsavel_id, criado_por, estado)
        VALUES ($1,$2,$3,'followup','alta', CURRENT_DATE + INTERVAL '3 days',$4,$4,'pendente')
      `, [empId, ce.id, `Follow-up — ${ce.nome}`, adminId]);
    }
  }
  console.log('✅ Contactos, interacções e tarefas CRM criadas');

  // ── OPEN BANKING (placeholder) ────────────────────────────────────────────
  console.log('\n📋 Open Banking...');
  await q(`
    INSERT INTO conta_bancaria (empresa_id, banco, iban, bic, descricao, saldo_actual, moeda, activa)
    VALUES ($1,'Caixa Geral de Depósitos','PT50 0035 0000 0000 1234 5678 9','CGDIPTPL',
      'Conta Principal',45750.50,'EUR',true)
    ON CONFLICT DO NOTHING
  `, [empId]);
  await q(`
    INSERT INTO conta_bancaria (empresa_id, banco, iban, bic, descricao, saldo_actual, moeda, activa)
    VALUES ($1,'Millennium BCP','PT50 0033 0000 0001 2345 6789 0','BCOMPTPL',
      'Conta Poupança',12500.00,'EUR',true)
    ON CONFLICT DO NOTHING
  `, [empId]);

  // Movimentos bancários de exemplo
  const movimentos = [
    { descricao:'Pagamento salários Julho 2026', valor:-28500, tipo:'debito' },
    { descricao:'Recebimento fatura FT2026/0001', valor:1230, tipo:'credito' },
    { descricao:'Fornecedor Alpha Lda', valor:-1200, tipo:'debito' },
    { descricao:'Recebimento fatura FT2026/0002', valor:2460, tipo:'credito' },
    { descricao:'Renda escritório Agosto', valor:-2500, tipo:'debito' },
    { descricao:'Subscrição NexEdge cliente', valor:390, tipo:'credito' },
  ];
  for (const m of movimentos) {
    await q(`
      INSERT INTO movimento_bancario (empresa_id, data, descricao, valor, tipo, reconciliado)
      VALUES ($1,CURRENT_DATE,$2,$3,$4,false)
    `, [empId, m.descricao, m.valor, m.tipo]);
  }
  console.log('✅ Contas bancárias e movimentos criados');

  // ── RESUMO FINAL ──────────────────────────────────────────────────────────
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🎉 Seed completo — todos os módulos povoados!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Login: admin@techsol.pt / Admin@2025!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  await pool.end();
}

seed().catch(e => { console.error('\n❌ ERRO FATAL:', e.message); pool.end(); process.exit(1); });
