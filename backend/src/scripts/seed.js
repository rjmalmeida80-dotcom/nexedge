'use strict';
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const pool = new Pool({ host:'postgres', database:'plataforma_rh', user:'postgres', password:'rh_password_local' });

async function q(sql, params) {
  return pool.query(sql, params).catch(e => { console.warn('  ⚠️', e.message.substring(0,80)); return { rows:[] }; });
}

async function seed() {
  console.log('🌱 A povoar base de dados...\n');

  // EMPRESA
  const { rows:[emp] } = await pool.query(`
    SELECT id FROM empresa WHERE nif='509876543' LIMIT 1
  `);
  let empId;
  if (emp) {
    empId = emp.id;
    console.log('✅ Empresa já existe');
  } else {
    const { rows:[e] } = await pool.query(`
      INSERT INTO empresa (nome, nif, email, telefone, morada, codigo_postal, localidade, pais, setor, plano)
      VALUES ('TechSolutions Lda','509876543','admin@techsol.pt','210000000',
        'Av. da Liberdade 100','1250-096','Lisboa','PT','Tecnologia','pro') RETURNING id
    `);
    empId = e.id;
    console.log('✅ Empresa criada');
  }

  // ADMIN
  const hashPass = await bcrypt.hash('Admin@2025!', 12);
  const { rows:[admin] } = await pool.query(`
    INSERT INTO utilizador (empresa_id, nome_completo, email, password_hash, perfil, ativo)
    VALUES ($1,'Maria Santos','admin@techsol.pt',$2,'admin_empresa',true)
    ON CONFLICT (email) DO UPDATE SET password_hash=$2, empresa_id=$1 RETURNING id, nome_completo
  `, [empId, hashPass]);
  console.log('✅ Admin:', admin.nome_completo);

  // DEPARTAMENTOS
  const deptos = ['Tecnologia','Recursos Humanos','Financeiro','Comercial','Operações'];
  const deptIds = {};
  for (const nome of deptos) {
    const { rows } = await pool.query(`
      INSERT INTO departamento (empresa_id, nome) VALUES ($1,$2)
      ON CONFLICT DO NOTHING RETURNING id
    `, [empId, nome]);
    if (rows[0]) {
      deptIds[nome] = rows[0].id;
    } else {
      const { rows:r2 } = await pool.query(`SELECT id FROM departamento WHERE empresa_id=$1 AND nome=$2`, [empId, nome]);
      if (r2[0]) deptIds[nome] = r2[0].id;
    }
  }
  console.log('✅ Departamentos:', Object.keys(deptIds).length);

  // COLABORADORES
  const colaboradores = [
    { nome:'João Silva',       cargo:'Engenheiro de Software', salario:2800, depto:'Tecnologia',       email:'joao.silva@techsol.pt',     nif:'123456789' },
    { nome:'Ana Costa',        cargo:'Designer UX',            salario:2200, depto:'Tecnologia',       email:'ana.costa@techsol.pt',      nif:'234567890' },
    { nome:'Pedro Ferreira',   cargo:'Gestor de Projecto',     salario:3200, depto:'Tecnologia',       email:'pedro.ferreira@techsol.pt', nif:'345678901' },
    { nome:'Sofia Martins',    cargo:'Técnica de RH',          salario:1900, depto:'Recursos Humanos', email:'sofia.martins@techsol.pt',  nif:'456789012' },
    { nome:'Carlos Rodrigues', cargo:'Director Financeiro',    salario:4500, depto:'Financeiro',       email:'carlos.rodrigues@techsol.pt',nif:'567890123' },
    { nome:'Inês Pereira',     cargo:'Contabilista',           salario:2100, depto:'Financeiro',       email:'ines.pereira@techsol.pt',   nif:'678901234' },
    { nome:'Rui Oliveira',     cargo:'Comercial Sénior',       salario:2600, depto:'Comercial',        email:'rui.oliveira@techsol.pt',   nif:'789012345' },
    { nome:'Catarina Lopes',   cargo:'Assistente Operacional', salario:1700, depto:'Operações',        email:'catarina.lopes@techsol.pt', nif:'890123456' },
    { nome:'Miguel Santos',    cargo:'DevOps Engineer',        salario:3100, depto:'Tecnologia',       email:'miguel.santos@techsol.pt',  nif:'901234567' },
    { nome:'Beatriz Alves',    cargo:'Account Manager',        salario:2400, depto:'Comercial',        email:'beatriz.alves@techsol.pt',  nif:'012345678' },
  ];

  const funcIds = [];
  let numFunc = 1;
  for (const c of colaboradores) {
    const { rows:[f] } = await pool.query(`
      INSERT INTO funcionario (empresa_id, nome_completo, email, nif, cargo, salario_base,
        departamento_id, data_admissao, estado, numero_funcionario)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'2023-01-01','ativo',$8)
      ON CONFLICT (empresa_id, nif) DO UPDATE SET nome_completo=EXCLUDED.nome_completo
      RETURNING id, nome_completo
    `, [empId, c.nome, c.email, c.nif, c.cargo, c.salario, deptIds[c.depto]||null, numFunc++]);
    if (f) funcIds.push({ id:f.id, nome:f.nome_completo, salario:c.salario });
  }
  console.log('✅ Colaboradores:', funcIds.length);

  // SALÁRIOS
  let nSal = 0;
  for (const f of funcIds) {
    for (const mes of [4, 5, 6]) {
      const irs = Math.round(f.salario * 0.15 * 100) / 100;
      const ss  = Math.round(f.salario * 0.11 * 100) / 100;
      const sub = 172.50;
      const abonos = f.salario + sub;
      const descontos = irs + ss;
      await q(`
        INSERT INTO salario (empresa_id, funcionario_id, mes, ano, salario_base,
          subsidio_alimentacao, total_abonos, irs_retido, seg_social_func,
          total_descontos, liquido, estado, processado_em)
        VALUES ($1,$2,$3,2026,$4,$5,$6,$7,$8,$9,$10,'processado',NOW())
      `, [empId, f.id, mes, f.salario, sub, abonos, irs, ss, descontos, abonos-descontos]);
      nSal++;
    }
  }
  console.log('✅ Salários:', nSal);

  // FÉRIAS
  const estadosF = ['pendente','aprovado','aprovado','rejeitado','pendente'];
  for (let i = 0; i < Math.min(funcIds.length,5); i++) {
    await q(`
      INSERT INTO ferias (empresa_id, funcionario_id, data_inicio, data_fim, tipo, estado, dias)
      VALUES ($1,$2,$3,$4,'ferias',$5,5)
    `, [empId, funcIds[i].id, `2026-0${7+i}-01`, `2026-0${7+i}-05`, estadosF[i]]);
  }
  console.log('✅ Pedidos de férias criados');

  // CLIENTES CRM
  const clientesCRM = [
    { nome:'Inova Tech SA',     setor:'Tecnologia',  email:'geral@inovatech.pt',    cidade:'Porto',   dim:'media',  nif:'500000001' },
    { nome:'Grupo Construir',   setor:'Construção',  email:'info@grupoconstruir.pt', cidade:'Lisboa',  dim:'grande', nif:'500000002' },
    { nome:'MediSaúde Clínica', setor:'Saúde',       email:'contacto@medisaude.pt',  cidade:'Braga',   dim:'pequena',nif:'500000003' },
    { nome:'EcoFresh Lda',      setor:'Alimentação', email:'geral@ecofresh.pt',      cidade:'Setúbal', dim:'micro',  nif:'500000004' },
    { nome:'LogisFast',         setor:'Logística',   email:'ops@logisfast.pt',       cidade:'Lisboa',  dim:'media',  nif:'500000005' },
  ];
  const crmIds = [];
  for (const c of clientesCRM) {
    const { rows:[ce] } = await q(`
      INSERT INTO crm_empresa (empresa_id, nome, nif, setor, email, cidade, dimensao, criado_por)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, nome
    `, [empId, c.nome, c.nif, c.setor, c.email, c.cidade, c.dim, admin.id]);
    if (ce) crmIds.push(ce);
  }
  console.log('✅ Empresas CRM:', crmIds.length);

  // OPORTUNIDADES CRM
  const etapas = ['lead','qualificado','proposta','negociacao','fechado_ganho'];
  for (let i = 0; i < crmIds.length; i++) {
    await q(`
      INSERT INTO crm_oportunidade (empresa_id, crm_empresa_id, titulo, valor, etapa,
        probabilidade, data_fecho_prevista, responsavel_id, criado_por)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
    `, [empId, crmIds[i].id,
        `Implementação NexEdge — ${crmIds[i].nome}`,
        (i+1)*5000, etapas[i], (i+1)*20,
        `2026-${String(9+i%3).padStart(2,'0')}-30`, admin.id]);
  }
  console.log('✅ Oportunidades CRM:', crmIds.length);

  // FATURAS
  for (let i = 0; i < 3; i++) {
    const sub = 1000*(i+1);
    const iva = Math.round(sub*0.23*100)/100;
    await q(`
      INSERT INTO fatura (empresa_id, numero_completo, numero_sequencial, serie, ano,
        cliente_nome, cliente_email, descricao, subtotal, total_iva, total,
        data_emissao, data_vencimento, estado)
      VALUES ($1,$2,$3,'FT',2026,$4,$5,$6,$7,$8,$9,
        CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days',$10)
    `, [empId, `FT2026/${String(i+1).padStart(4,'0')}`, i+1,
        crmIds[i]?.nome || `Cliente ${i+1}`,
        `faturacao${i}@cliente.pt`,
        `Serviços consultoria Mês ${i+6}/2026`,
        sub, iva, sub+iva,
        i===0?'paga':'emitida']);
  }
  console.log('✅ Faturas criadas');

  // TICKETS
  const tickets = [
    { titulo:'Erro no processamento de salários', cat:'tecnico',   prio:'alta'    },
    { titulo:'Como exportar SAF-T?',              cat:'geral',     prio:'normal'  },
    { titulo:'Problema com fatura duplicada',     cat:'faturacao', prio:'urgente' },
  ];
  for (const t of tickets) {
    const num = `TK-2026-${Date.now().toString().slice(-6)}`;
    const { rows:[tk] } = await q(`
      INSERT INTO ticket (numero, empresa_id, criado_por, titulo, categoria, prioridade, estado)
      VALUES ($1,$2,$3,$4,$5,$6,'aberto') RETURNING id
    `, [num, empId, admin.id, t.titulo, t.cat, t.prio]);
    if (tk) {
      await q(`
        INSERT INTO ticket_mensagem (ticket_id, autor_id, autor_nome, autor_tipo, mensagem)
        VALUES ($1,$2,'Maria Santos','cliente',$3)
      `, [tk.id, admin.id, t.titulo]);
    }
    await new Promise(r => setTimeout(r, 10));
  }
  console.log('✅ Tickets criados');

  // SERVIÇO RECORRENTE
  await q(`
    INSERT INTO servico_recorrente (empresa_id, nome, descricao, cliente_nome, cliente_email,
      valor, valor_iva, taxa_iva, frequencia, data_inicio, proximo_faturacao, dias_vencimento, criado_por)
    VALUES ($1,'Manutenção Mensal NexEdge','Suporte e manutenção mensal',
      'Inova Tech SA','geral@inovatech.pt',
      500, 115, 23, 'mensal', '2026-01-01', '2026-09-01', 30, $2)
  `, [empId, admin.id]);
  console.log('✅ Serviço recorrente criado');

  // DOCUMENTO ASSINATURA
  const docHash = crypto.createHash('sha256').update('Contrato Inova Tech NexEdge').digest('hex');
  await q(`
    INSERT INTO documento_assinatura (empresa_id, titulo, tipo, conteudo_html, hash_documento, estado, criado_por)
    VALUES ($1,'Contrato Prestação Serviços — Inova Tech','contrato',
      '<h2>Contrato de Prestação de Serviços</h2><p>Entre TechSolutions Lda e Inova Tech SA...</p>',
      $2,'rascunho',$3)
  `, [empId, docHash, admin.id]);
  console.log('✅ Documento para assinar criado');

  // SUBSCRIÇÃO SAAS
  const { rows:[plano] } = await pool.query(`SELECT id FROM plano_saas WHERE slug='pro' LIMIT 1`);
  if (plano) {
    await q(`
      INSERT INTO subscricao (empresa_id, plano_id, estado, trial_fim, metodo_pagamento)
      VALUES ($1,$2,'activa',NULL,'stripe')
      ON CONFLICT (empresa_id) DO NOTHING
    `, [empId, plano.id]);
    console.log('✅ Subscrição SaaS criada');
  }

  console.log('\n🎉 Base de dados povoada com sucesso!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  URL:      http://localhost:5173');
  console.log('  Email:    admin@techsol.pt');
  console.log('  Password: Admin@2025!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  await pool.end();
}

seed().catch(e => { console.error('\n❌ ERRO FATAL:', e.message); pool.end(); process.exit(1); });
