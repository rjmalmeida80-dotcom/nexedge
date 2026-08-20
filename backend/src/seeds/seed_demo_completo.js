'use strict';
/**
 * NexEdge v9 — Seed Demo Completo
 * Detecta automaticamente a empresa principal
 * Seguro para correr múltiplas vezes
 */
const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST || 'postgres',
  database: process.env.DB_NAME || 'plataforma_rh',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'rh_password_local',
});
async function q(sql, p=[]) {
  return pool.query(sql, p).catch(e => {
    console.log('  AVISO:', e.message.split('\n')[0]);
    return { rows: [] };
  });
}

async function main() {
  console.log('NexEdge v9 — Seed Demo Completo');
  console.log('================================\n');

  // ── DETECTAR EMPRESA AUTOMATICAMENTE ──────────────────────────────────────
  // Usa EMPRESA_ID do .env se definido, senão detecta automaticamente
  let EMP = process.env.EMPRESA_ID || null;

  if (!EMP) {
    // Tentar encontrar empresa com admin@techsol.pt
    const { rows: byAdmin } = await q(`
      SELECT empresa_id FROM utilizador 
      WHERE email='admin@techsol.pt' AND empresa_id IS NOT NULL LIMIT 1
    `);
    if (byAdmin.length) {
      EMP = byAdmin[0].empresa_id;
      console.log(`Empresa detectada via admin@techsol.pt: ${EMP}`);
    }
  }

  if (!EMP) {
    // Pegar primeira empresa activa (excluindo empresas de super admin)
    const { rows: byEmp } = await q(`
      SELECT id, nome FROM empresa 
      WHERE ativo=true 
      ORDER BY criado_em 
      LIMIT 1
    `);
    if (byEmp.length) {
      EMP = byEmp[0].id;
      console.log(`Empresa detectada (primeira activa): ${byEmp[0].nome} — ${EMP}`);
    }
  }

  if (!EMP) {
    console.log('ERRO: Nao foi encontrada nenhuma empresa.');
    console.log('Corre primeiro: node src/seeds/seed_producao.js');
    await pool.end();
    process.exit(1);
  }

  // Confirmar empresa
  const { rows:[empInfo] } = await q(`SELECT nome, nif FROM empresa WHERE id=$1`, [EMP]);
  console.log(`Empresa: ${empInfo?.nome} (NIF: ${empInfo?.nif})`);

  // Obter funcionários
  const { rows: funcs } = await q(`
    SELECT id, nome_completo FROM funcionario 
    WHERE empresa_id=$1 ORDER BY nome_completo
  `, [EMP]);
  console.log(`Funcionarios: ${funcs.length}\n`);

  if (funcs.length === 0) {
    console.log('AVISO: Sem funcionarios. O seed_producao.js cria 6 funcionarios demo.');
    console.log('Corre: node src/seeds/seed_producao.js');
  }

  // ── 1. HORÁRIOS ────────────────────────────────────────────────────────────
  console.log('1. Horarios...');
  const horarios = [
    { nome:'Horario Normal 9h-18h',  tipo:'fixo',     seg:true, ter:true, qua:true, qui:true, sex:true, sab:false, dom:false, horas:40 },
    { nome:'Horario Flexivel 8h-17h',tipo:'flexivel', seg:true, ter:true, qua:true, qui:true, sex:true, sab:false, dom:false, horas:40 },
    { nome:'Turno Manha 6h-14h',     tipo:'manha',    seg:true, ter:true, qua:true, qui:true, sex:true, sab:true,  dom:false, horas:40 },
    { nome:'Turno Tarde 14h-22h',    tipo:'tarde',    seg:true, ter:true, qua:true, qui:true, sex:true, sab:true,  dom:false, horas:40 },
    { nome:'Turno Noite 22h-6h',     tipo:'noite',    seg:true, ter:true, qua:true, qui:true, sex:true, sab:false, dom:false, horas:40 },
    { nome:'Horario Rotativo',       tipo:'rotativo', seg:true, ter:true, qua:true, qui:true, sex:true, sab:false, dom:false, horas:40 },
  ];
  for (const h of horarios) {
    const { rows: ex } = await q(`SELECT id FROM horario WHERE empresa_id=$1 AND nome=$2`, [EMP, h.nome]);
    if (ex.length) continue;
    await q(`INSERT INTO horario (empresa_id,nome,tipo,segunda,terca,quarta,quinta,sexta,sabado,domingo,horas_semana,ativo) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true)`,
      [EMP, h.nome, h.tipo, h.seg, h.ter, h.qua, h.qui, h.sex, h.sab, h.dom, h.horas]);
  }
  const { rows:[hCnt] } = await q(`SELECT COUNT(*) FROM horario WHERE empresa_id=$1`, [EMP]);
  // Atribuir horário aos funcionários sem horário
  await q(`UPDATE funcionario SET horario_id=(SELECT id FROM horario WHERE empresa_id=$1 AND tipo='fixo' LIMIT 1) WHERE empresa_id=$1 AND horario_id IS NULL`, [EMP]);
  console.log(`   ${hCnt.count} horarios OK`);

  // ── 2. CONTRATOS ───────────────────────────────────────────────────────────
  console.log('\n2. Contratos...');
  let ct = 0;
  for (const f of funcs) {
    const { rows: ex } = await q(`SELECT id FROM contrato_trabalho WHERE funcionario_id=$1 LIMIT 1`, [f.id]);
    if (ex.length) continue;
    await q(`INSERT INTO contrato_trabalho (empresa_id,funcionario_id,tipo_contrato,data_inicio,assinado) VALUES ($1,$2,'sem_termo','2024-01-01',true)`, [EMP, f.id]);
    ct++;
  }
  const { rows:[ctCnt] } = await q(`SELECT COUNT(*) FROM contrato_trabalho WHERE empresa_id=$1`, [EMP]);
  console.log(`   ${ct} criados — total: ${ctCnt.count}`);

  // ── 3. FERIADOS 2026 ───────────────────────────────────────────────────────
  console.log('\n3. Feriados...');
  const { rows:[ferEx] } = await q(`SELECT COUNT(*) FROM feriado WHERE empresa_id=$1`, [EMP]);
  if (parseInt(ferEx.count) < 5) {
    for (const [data,nome] of [
      ['2026-01-01','Ano Novo'],['2026-04-03','Sexta-Feira Santa'],
      ['2026-04-05','Pascoa'],['2026-04-25','Dia da Liberdade'],
      ['2026-05-01','Dia do Trabalhador'],['2026-06-10','Dia de Portugal'],
      ['2026-06-13','Santo Antonio de Lisboa'],['2026-08-15','Assuncao'],
      ['2026-10-05','Implantacao da Republica'],['2026-11-01','Todos os Santos'],
      ['2026-12-01','Restauracao da Independencia'],['2026-12-08','Imaculada Conceicao'],
      ['2026-12-25','Natal'],
    ]) {
      await q(`INSERT INTO feriado (empresa_id,nome,data,tipo,ano,recorrente) VALUES ($1,$2,$3,'nacional',2026,true)`, [EMP,nome,data]);
    }
  }
  const { rows:[ferCnt] } = await q(`SELECT COUNT(*) FROM feriado WHERE empresa_id=$1`, [EMP]);
  console.log(`   ${ferCnt.count} feriados OK`);

  // ── 4. FORMAÇÕES ───────────────────────────────────────────────────────────
  console.log('\n4. Formacoes...');
  const { rows:[fmEx] } = await q(`SELECT COUNT(*) FROM formacao WHERE empresa_id=$1`, [EMP]);
  if (parseInt(fmEx.count) < 3) {
    const fms = [
      ['Excel Avancado para Gestores','Formador Interno','presencial',16,'2026-03-10','2026-03-11'],
      ['Gestao de Projetos PMP','PMI Portugal','presencial',40,'2026-04-15','2026-04-19'],
      ['Seguranca Informatica RGPD','Plataforma Online','elearning',8,'2026-05-01','2026-05-31'],
      ['Lideranca e Gestao de Equipas','Business School PT','presencial',24,'2026-09-08','2026-09-10'],
      ['Primeiros Socorros no Trabalho','Cruz Vermelha Portuguesa','presencial',4,'2026-10-15','2026-10-15'],
    ];
    for (const [nome,ent,tipo,horas,di,df] of fms) {
      const { rows: ex } = await q(`SELECT id FROM formacao WHERE empresa_id=$1 AND nome=$2`, [EMP, nome]);
      if (ex.length) continue;
      const { rows:[fm] } = await q(`INSERT INTO formacao (empresa_id,nome,entidade,tipo,horas,data_inicio,data_fim) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [EMP,nome,ent,tipo,horas,di,df]);
      if (fm && funcs.length) {
        for (const f of funcs.slice(0,3)) {
          await q(`INSERT INTO formacao_participante (formacao_id,funcionario_id,concluido) VALUES ($1,$2,false) ON CONFLICT DO NOTHING`, [fm.id, f.id]);
        }
      }
    }
  }
  const { rows:[fmCnt] } = await q(`SELECT COUNT(*) FROM formacao WHERE empresa_id=$1`, [EMP]);
  console.log(`   ${fmCnt.count} formacoes OK`);

  // ── 5. FALTAS ──────────────────────────────────────────────────────────────
  console.log('\n5. Faltas...');
  if (funcs.length) {
    const fids = funcs.map(f=>f.id);
    const { rows:[fltEx] } = await q(`SELECT COUNT(*) FROM falta WHERE funcionario_id=ANY($1)`, [fids]);
    if (parseInt(fltEx.count) < 5) {
      for (const f of funcs.slice(0,6)) {
        await q(`INSERT INTO falta (funcionario_id,data,tipo,justificada,descricao,estado) VALUES ($1,'2026-03-15','baixa_medica',true,'Atestado medico','aprovado')`, [f.id]);
        await q(`INSERT INTO falta (funcionario_id,data,tipo,justificada,descricao,estado) VALUES ($1,'2026-05-20','injustificada',false,'Falta sem aviso','pendente')`, [f.id]);
        await q(`INSERT INTO falta (funcionario_id,data,tipo,justificada,descricao,estado) VALUES ($1,'2026-06-15','justificada',true,'Consulta medica','aprovado')`, [f.id]);
      }
    }
    const { rows:[fltCnt] } = await q(`SELECT COUNT(*) FROM falta WHERE funcionario_id=ANY($1)`, [fids]);
    console.log(`   ${fltCnt.count} faltas OK`);
  }

  // ── 6. FORNECEDORES ────────────────────────────────────────────────────────
  console.log('\n6. Fornecedores...');
  const { rows:[fornEx] } = await q(`SELECT COUNT(*) FROM fornecedor WHERE empresa_id=$1`, [EMP]);
  if (parseInt(fornEx.count) < 3) {
    for (const [nome,nif,email,tel,cat,dias] of [
      ['Staples Portugal Lda','501234567','b2b@staples.pt','+351 210 000 500','material_escritorio',30],
      ['EDP Comercial SA','502345678','empresas@edp.pt','+351 210 000 600','utilities',15],
      ['NOS Comunicacoes SA','503456789','empresas@nos.pt','+351 210 000 700','telecomunicacoes',30],
      ['Fidelidade Seguros SA','504567890','empresas@fidelidade.pt','+351 210 000 800','seguros',0],
      ['Limpezas Cristal Lda','505678901','geral@cristal.pt','+351 910 000 100','servicos_limpeza',30],
    ]) {
      await q(`INSERT INTO fornecedor (empresa_id,nome,nif,email,telefone,categoria,condicoes_pagamento,ativo) VALUES ($1,$2,$3,$4,$5,$6,$7,true) ON CONFLICT DO NOTHING`, [EMP,nome,nif,email,tel,cat,dias]);
    }
  }
  const { rows:[fornCnt] } = await q(`SELECT COUNT(*) FROM fornecedor WHERE empresa_id=$1`, [EMP]);
  console.log(`   ${fornCnt.count} fornecedores OK`);

  // ── 7. MOVIMENTOS BANCÁRIOS ────────────────────────────────────────────────
  console.log('\n7. Movimentos bancarios...');
  const { rows:[cb] } = await q(`SELECT id FROM conta_bancaria WHERE empresa_id=$1 LIMIT 1`, [EMP]);
  if (cb) {
    const { rows:[movEx] } = await q(`SELECT COUNT(*) FROM movimento_bancario WHERE conta_id=$1`, [cb.id]);
    if (parseInt(movEx.count) < 5) {
      for (const [data,tipo,valor,desc] of [
        ['2026-07-01','credito',3500.00,'Pagamento Cliente Grupo Exemplo FAT 2026A/5'],
        ['2026-07-03','debito', 1850.00,'Seguranca Social Junho 2026'],
        ['2026-07-05','credito',2200.00,'Recebimento Startup Digital FAT 2026A/6'],
        ['2026-07-08','debito', 750.00, 'Renda Escritorio Julho 2026'],
        ['2026-07-10','debito', 320.40, 'NOS Comunicacoes Julho'],
        ['2026-07-12','credito',4100.00,'Pagamento Consultores PT FAT 2026A/7'],
        ['2026-07-15','debito', 2800.00,'Salarios Julho — Transferencias'],
        ['2026-07-18','debito', 185.60, 'EDP Energia Julho 2026'],
        ['2026-07-20','credito',1500.00,'Adiantamento Projeto Beta'],
        ['2026-07-22','debito', 450.00, 'Formacao PMP — Inscricao'],
      ]) {
        await q(`INSERT INTO movimento_bancario (empresa_id,conta_id,data,tipo,valor,descricao,reconciliado) VALUES ($1,$2,$3,$4,$5,$6,false)`, [EMP,cb.id,data,tipo,valor,desc]);
      }
    }
    const { rows:[movCnt] } = await q(`SELECT COUNT(*) FROM movimento_bancario WHERE conta_id=$1`, [cb.id]);
    console.log(`   ${movCnt.count} movimentos OK`);
  } else {
    console.log('   Sem conta bancaria — a criar...');
    await q(`INSERT INTO conta_bancaria (empresa_id,iban,banco,descricao,ativa,saldo_inicial) VALUES ($1,'PT50000100001234567890154','Caixa Geral de Depositos','Conta Principal',true,15000.00)`, [EMP]).catch(()=>{});
    console.log('   Conta criada — corre o seed novamente para adicionar movimentos');
  }

  // ── 8. EQUIPAMENTOS ────────────────────────────────────────────────────────
  console.log('\n8. Equipamentos...');
  const { rows:[eqEx] } = await q(`SELECT COUNT(*) FROM equipamento WHERE empresa_id=$1`, [EMP]);
  if (parseInt(eqEx.count) < 4 && funcs.length >= 3) {
    for (const [tipo,nome,marca,modelo,serie,fi] of [
      ['laptop',   'MacBook Pro 14"',   'Apple',  'MBP M3 2024','MBP2024001',0],
      ['telemovel','iPhone 15 Pro',     'Apple',  'A3101',      'IPH2024001',1],
      ['laptop',   'XPS 15 9530',       'Dell',   'XPS 15',     'DELL024001',2],
      ['monitor',  'Monitor 27 4K',     'LG',     '27UK850',    'LG2024001', 0],
      ['tablet',   'iPad Pro 11"',      'Apple',  'M4 2024',    'IPAD024001',3],
      ['laptop',   'ThinkPad X1 Carbon','Lenovo', 'Gen 11',     'LEN2024001',4],
    ]) {
      const fid = funcs[fi]?.id;
      if (!fid) continue;
      await q(`INSERT INTO equipamento (empresa_id,funcionario_id,tipo,nome,marca,modelo,numero_serie,estado,data_aquisicao,data_atribuicao) VALUES ($1,$2,$3,$4,$5,$6,$7,'activo','2024-01-15','2024-01-15') ON CONFLICT DO NOTHING`,
        [EMP,fid,tipo,nome,marca,modelo,serie]);
    }
  }
  const { rows:[eqCnt] } = await q(`SELECT COUNT(*) FROM equipamento WHERE empresa_id=$1`, [EMP]);
  console.log(`   ${eqCnt.count} equipamentos OK`);

  // ── 9. MEDICINA DO TRABALHO ────────────────────────────────────────────────
  console.log('\n9. Medicina do trabalho...');
  const { rows:[medEx] } = await q(`SELECT COUNT(*) FROM medicina_trabalho WHERE empresa_id=$1`, [EMP]);
  if (parseInt(medEx.count) < 4 && funcs.length) {
    for (const f of funcs.slice(0,6)) {
      await q(`INSERT INTO medicina_trabalho (empresa_id,funcionario_id,tipo,data_exame,data_validade,resultado,medico,clinica) VALUES ($1,$2,'admissao','2024-01-10','2026-01-10','apto','Dr. Miguel Costa','Clinica Saude Lisboa')`, [EMP,f.id]);
      await q(`INSERT INTO medicina_trabalho (empresa_id,funcionario_id,tipo,data_exame,data_validade,resultado,medico,clinica) VALUES ($1,$2,'periodico','2026-01-15','2027-01-15','apto','Dr. Miguel Costa','Clinica Saude Lisboa')`, [EMP,f.id]);
    }
  }
  const { rows:[medCnt] } = await q(`SELECT COUNT(*) FROM medicina_trabalho WHERE empresa_id=$1`, [EMP]);
  console.log(`   ${medCnt.count} exames OK`);

  // ── 10. AVALIAÇÕES ─────────────────────────────────────────────────────────
  console.log('\n10. Avaliacoes...');
  const { rows:[avalEx] } = await q(`SELECT COUNT(*) FROM avaliacoes WHERE empresa_id=$1`, [EMP]);
  if (parseInt(avalEx.count) < 3 && funcs.length) {
    // Detectar admin automaticamente
    const { rows:[adminU] } = await q(`SELECT id FROM utilizador WHERE empresa_id=$1 AND perfil='admin_empresa' LIMIT 1`, [EMP]);
    const dados = [[8.5,'Muito Bom'],[7.2,'Bom'],[9.0,'Excelente'],[6.8,'Satisfatorio'],[8.1,'Muito Bom']];
    for (let i=0; i<Math.min(5,funcs.length); i++) {
      await q(`INSERT INTO avaliacoes (empresa_id,funcionario_id,avaliador_id,periodo,ano,nota_global,classificacao,pontos_fortes,areas_melhoria,recomendacao,estado,data_avaliacao) VALUES ($1,$2,$3,'H1 2026',2026,$4,$5,$6,$7,'manter','concluida','2026-07-01')`,
        [EMP,funcs[i].id,adminU?.id,dados[i][0],dados[i][1],'Trabalho em equipa, qualidade, pontualidade','Gestao do tempo, comunicacao escrita']);
    }
  }
  const { rows:[avalCnt] } = await q(`SELECT COUNT(*) FROM avaliacoes WHERE empresa_id=$1`, [EMP]);
  console.log(`   ${avalCnt.count} avaliacoes OK`);

  // ── 11. TEMPLATES CONTRATOS ────────────────────────────────────────────────
  console.log('\n11. Templates contratos...');
  const { rows:[tplEx] } = await q(`SELECT COUNT(*) FROM template_contrato WHERE empresa_id=$1`, [EMP]);
  if (parseInt(tplEx.count) < 3) {
    const { rows:[adminU] } = await q(`SELECT id FROM utilizador WHERE empresa_id=$1 AND perfil='admin_empresa' LIMIT 1`, [EMP]);
    for (const [nome,tipo,body] of [
      ['Contrato Sem Termo','sem_termo','CONTRATO DE TRABALHO SEM TERMO\n\nEntre {{empresa_nome}} e {{funcionario_nome}}.\nCargo: {{cargo}} | Admissao: {{data_admissao}} | Salario: {{salario_base}}€/mes\n\nRegido pelo Codigo do Trabalho Portugues.'],
      ['Contrato A Termo Certo','a_termo','CONTRATO A TERMO CERTO\n\nEntre {{empresa_nome}} e {{funcionario_nome}}.\nCargo: {{cargo}} | Inicio: {{data_admissao}} | Fim: {{data_fim_contrato}}\nSalario: {{salario_base}}€/mes'],
      ['Acordo de Confidencialidade','nda','ACORDO DE CONFIDENCIALIDADE\n\nEntre {{empresa_nome}} e {{funcionario_nome}}.\nO Colaborador compromete-se a manter confidencialidade por 3 anos.'],
      ['Aditamento — Teletrabalho','aditamento','ADITAMENTO — TELETRABALHO\n\nEntre {{empresa_nome}} e {{funcionario_nome}}.\nRatio: {{dias_teletrabalho}} dias/semana.'],
    ]) {
      await q(`INSERT INTO template_contrato (empresa_id,nome,tipo_contrato,conteudo,ativo,criado_por) VALUES ($1,$2,$3,$4,true,$5) ON CONFLICT DO NOTHING`,
        [EMP,nome,tipo,body,adminU?.id]);
    }
  }
  const { rows:[tplCnt] } = await q(`SELECT COUNT(*) FROM template_contrato WHERE empresa_id=$1`, [EMP]);
  console.log(`   ${tplCnt.count} templates OK`);

  // ── 12. DOCUMENTOS ─────────────────────────────────────────────────────────
  console.log('\n12. Documentos...');
  const { rows:[docEx] } = await q(`SELECT COUNT(*) FROM documento WHERE empresa_id=$1`, [EMP]);
  if (parseInt(docEx.count) < 3) {
    const { rows:[adminU] } = await q(`SELECT id FROM utilizador WHERE empresa_id=$1 AND perfil='admin_empresa' LIMIT 1`, [EMP]);
    for (const [nome,tipo,cat,tipo_doc] of [
      ['Manual de Acolhimento 2026','pdf','manual','manual_interno'],
      ['Politica de Teletrabalho','pdf','politica','regulamento'],
      ['Codigo de Conduta','pdf','politica','regulamento'],
      ['Plano de Emergencia e Evacuacao','pdf','sst','sst'],
    ]) {
      await q(`INSERT INTO documento (empresa_id,nome,tipo,categoria,url,tipo_documento,confidencial,criado_por) VALUES ($1,$2,$3,$4,'https://docs.nexedge.pt/demo',$5,false,$6)`,
        [EMP,nome,tipo,cat,tipo_doc,adminU?.id]);
    }
  }
  const { rows:[docCnt] } = await q(`SELECT COUNT(*) FROM documento WHERE empresa_id=$1`, [EMP]);
  console.log(`   ${docCnt.count} documentos OK`);

  // ── 13. TICKETS ────────────────────────────────────────────────────────────
  console.log('\n13. Tickets...');
  const { rows:[tkEx] } = await q(`SELECT COUNT(*) FROM ticket WHERE empresa_id=$1`, [EMP]);
  if (parseInt(tkEx.count) < 5) {
    const { rows:[adminU] } = await q(`SELECT id FROM utilizador WHERE empresa_id=$1 AND perfil='admin_empresa' LIMIT 1`, [EMP]);
    for (const [titulo,cat,pri,est,desc] of [
      ['Nao consigo aceder ao meu recibo','suporte','normal','resolvido','O recibo esta em Salarios > Processamento.'],
      ['Erro ao criar fatura','bug','alta','em_progresso','A analisar. Estimativa: 24h.'],
      ['Adicionar campo projeto na fatura','feature','baixa','aberto','Em analise para proximo sprint.'],
      ['Exportar lista colaboradores','suporte','normal','resolvido','Ir a Salarios > Exportacoes > CSV.'],
      ['Integracao com PHC','feature','media','aberto','Em roadmap Q4 2026.'],
      ['Reset password colaborador','suporte','urgente','resolvido','Password resetada com sucesso.'],
    ]) {
      const { rows:[tk] } = await q(`INSERT INTO ticket (empresa_id,criado_por,titulo,descricao,categoria,prioridade,estado) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [EMP,adminU?.id,titulo,desc,cat,pri,est]);
      if (tk) await q(`INSERT INTO ticket_mensagem (ticket_id,utilizador_id,mensagem) VALUES ($1,$2,$3)`, [tk.id,adminU?.id,desc]);
    }
  }
  const { rows:[tkCnt] } = await q(`SELECT COUNT(*) FROM ticket WHERE empresa_id=$1`, [EMP]);
  console.log(`   ${tkCnt.count} tickets OK`);

  // ── 14. ACTIVOS FIXOS ──────────────────────────────────────────────────────
  console.log('\n14. Ativos fixos...');
  const { rows:[ativEx] } = await q(`SELECT COUNT(*) FROM ativo_fixo WHERE empresa_id=$1`, [EMP]);
  if (parseInt(ativEx.count) < 4) {
    for (const [cod,desc,cat,val,data,vida,local] of [
      ['AF-001','Servidor Dell PowerEdge R740','equipamento_ti',8500,'2023-06-01',5,'Sala Servidores'],
      ['AF-002','Impressora HP LaserJet Pro','equipamento_escritorio',1200,'2023-09-15',5,'Open Space'],
      ['AF-003','Ar Condicionado LG Inverter','equipamento_instalacoes',2800,'2022-07-20',10,'Escritorio'],
      ['AF-004','Mobiliario Escritorio Completo','mobiliario',4500,'2022-01-01',10,'Escritorio'],
      ['AF-005','Switch HP Aruba 24 portas','equipamento_ti',1800,'2024-02-10',5,'Sala Servidores'],
    ]) {
      await q(`INSERT INTO ativo_fixo (empresa_id,codigo,descricao,categoria,valor_aquisicao,data_aquisicao,vida_util_anos,estado,localizacao) VALUES ($1,$2,$3,$4,$5,$6,$7,'activo',$8) ON CONFLICT DO NOTHING`,
        [EMP,cod,desc,cat,val,data,vida,local]);
    }
  }
  const { rows:[ativCnt] } = await q(`SELECT COUNT(*) FROM ativo_fixo WHERE empresa_id=$1`, [EMP]);
  console.log(`   ${ativCnt.count} ativos OK`);

  // ── 15. VIATURAS ───────────────────────────────────────────────────────────
  console.log('\n15. Viaturas...');
  const { rows:[viatEx] } = await q(`SELECT COUNT(*) FROM viatura WHERE empresa_id=$1`, [EMP]);
  if (parseInt(viatEx.count) < 3) {
    for (const [mat,marca,modelo,ano,tipo,comb,km,fi] of [
      ['AA-00-BB','Renault','Kangoo Express',2023,'comercial','diesel', 45000,0],
      ['BB-11-CC','Volkswagen','Caddy Cargo', 2022,'comercial','diesel', 62000,1],
      ['CC-22-DD','Peugeot','e-Partner',     2024,'comercial','electrico',12000,2],
      ['DD-33-EE','Toyota','Yaris Cross',    2023,'ligeiro',  'hibrido', 28000,3],
    ]) {
      const cond = funcs[fi]?.id || null;
      await q(`INSERT INTO viatura (empresa_id,matricula,marca,modelo,ano,tipo,combustivel,km_actuais,estado,condutor_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'activa',$9) ON CONFLICT DO NOTHING`,
        [EMP,mat,marca,modelo,ano,tipo,comb,km,cond]);
    }
  }
  const { rows:[viatCnt] } = await q(`SELECT COUNT(*) FROM viatura WHERE empresa_id=$1`, [EMP]);
  console.log(`   ${viatCnt.count} viaturas OK`);

  // ── 16. CHAT ───────────────────────────────────────────────────────────────
  console.log('\n16. Chat...');
  const { rows:[chatEx] } = await q(`SELECT COUNT(*) FROM chat_mensagem`);
  if (parseInt(chatEx.count) < 5) {
    const { rows: users } = await q(`SELECT id FROM utilizador WHERE empresa_id=$1 LIMIT 4`, [EMP]);
    if (users.length >= 2) {
      const { rows:[conv] } = await q(`INSERT INTO chat_conversa (empresa_id,nome,tipo,criado_por) VALUES ($1,'Equipa Geral','grupo',$2) RETURNING id`, [EMP,users[0].id]);
      if (conv) {
        for (const u of users) await q(`INSERT INTO chat_participante (conversa_id,utilizador_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [conv.id,u.id]);
        for (const [ui,msg] of [
          [0,'Bom dia equipa! Como estao todos?'],
          [1,'Bom dia! Tudo bem, obrigada.'],
          [0,'Reuniao amanha as 10h na sala A.'],
          [2,'Confirmado, ate amanha!'],
          [1,'Nao se esqueçam do relatorio Q3 para sexta.'],
          [3,'Entrego quinta-feira.'],
          [0,'Perfeito, obrigado a todos!'],
        ]) {
          await q(`INSERT INTO chat_mensagem (conversa_id,utilizador_id,conteudo) VALUES ($1,$2,$3)`, [conv.id,users[ui%users.length].id,msg]);
        }
      }
    }
  }
  const { rows:[chatCnt] } = await q(`SELECT COUNT(*) FROM chat_mensagem`);
  console.log(`   ${chatCnt.count} mensagens OK`);

  // ── RESUMO FINAL ───────────────────────────────────────────────────────────
  const { rows:[fin] } = await q(`SELECT
    (SELECT COUNT(*) FROM funcionario WHERE empresa_id=$1) func,
    (SELECT COUNT(*) FROM departamento WHERE empresa_id=$1) dept,
    (SELECT COUNT(*) FROM horario WHERE empresa_id=$1) hor,
    (SELECT COUNT(*) FROM contrato_trabalho WHERE empresa_id=$1) ct,
    (SELECT COUNT(*) FROM feriado WHERE empresa_id=$1) feriados,
    (SELECT COUNT(*) FROM falta fa JOIN funcionario f ON f.id=fa.funcionario_id WHERE f.empresa_id=$1) faltas,
    (SELECT COUNT(*) FROM fatura WHERE empresa_id=$1) fat,
    (SELECT COUNT(*) FROM cliente WHERE empresa_id=$1) cli,
    (SELECT COUNT(*) FROM crm_empresa WHERE empresa_id=$1) crm,
    (SELECT COUNT(*) FROM crm_oportunidade WHERE empresa_id=$1) oport,
    (SELECT COUNT(*) FROM conta_bancaria WHERE empresa_id=$1) contas,
    (SELECT COUNT(*) FROM movimento_bancario WHERE empresa_id=$1) mov,
    (SELECT COUNT(*) FROM ativo_fixo WHERE empresa_id=$1) ativos,
    (SELECT COUNT(*) FROM ticket WHERE empresa_id=$1) tickets,
    (SELECT COUNT(*) FROM formacao WHERE empresa_id=$1) form,
    (SELECT COUNT(*) FROM equipamento WHERE empresa_id=$1) equip,
    (SELECT COUNT(*) FROM viatura WHERE empresa_id=$1) viat,
    (SELECT COUNT(*) FROM fornecedor WHERE empresa_id=$1) forn,
    (SELECT COUNT(*) FROM template_contrato WHERE empresa_id=$1) tpl,
    (SELECT COUNT(*) FROM documento WHERE empresa_id=$1) docs,
    (SELECT COUNT(*) FROM chat_mensagem) chat,
    (SELECT COUNT(*) FROM medicina_trabalho WHERE empresa_id=$1) med,
    (SELECT COUNT(*) FROM avaliacoes WHERE empresa_id=$1) aval
  `, [EMP]);

  console.log('\n════════════════════════════════════════');
  console.log('BD DEMO — RESUMO FINAL');
  console.log('════════════════════════════════════════');
  const labels = {func:'Funcionarios',dept:'Departamentos',hor:'Horarios',ct:'Contratos',
    feriados:'Feriados',faltas:'Faltas',fat:'Faturas',cli:'Clientes',
    crm:'CRM empresas',oport:'CRM oportunidades',contas:'Contas bancarias',
    mov:'Movimentos bancarios',ativos:'Ativos fixos',tickets:'Tickets',
    form:'Formacoes',equip:'Equipamentos',viat:'Viaturas',forn:'Fornecedores',
    tpl:'Templates contratos',docs:'Documentos',chat:'Mensagens chat',
    med:'Exames medicina',aval:'Avaliacoes'};
  Object.entries(labels).forEach(([k,l]) => console.log(`  ${l.padEnd(22)}: ${fin[k]}`));
  console.log('\nBD pronta para demonstracao!');
  await pool.end();
}

main().catch(e => { console.error('ERRO:', e.message); pool.end(); process.exit(1); });
