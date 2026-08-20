'use strict';
/**
 * NexEdge v9 — Seed de Produção
 * Seguro para correr múltiplas vezes — usa ON CONFLICT DO NOTHING / DO UPDATE
 * Não apaga dados existentes
 */
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  host: process.env.DB_HOST || 'postgres',
  database: process.env.DB_NAME || 'plataforma_rh',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'rh_password_local',
});

async function q(sql, params=[]) {
  return pool.query(sql, params);
}

async function main() {
  console.log('NexEdge v9 — Seed de Producao');
  console.log('================================\n');

  // ── 1. Super Admins ────────────────────────────────────────────────────────
  console.log('1. Super Admins...');
  const superAdmins = [
    { email: 'ricardo@nexedge.pt',   nome: 'Ricardo Almeida',    pw: 'NexEdge2026!SuperAdmin' },
    { email: 'francisco@nexedge.pt', nome: 'Francisco Ferreira', pw: 'NexEdge2026!SuperAdmin' },
  ];
  for (const sa of superAdmins) {
    const hash = await bcrypt.hash(sa.pw, 12);
    await q(`
      INSERT INTO utilizador (email, nome_completo, password_hash, perfil, ativo, email_verificado)
      VALUES ($1,$2,$3,'super_admin',true,true)
      ON CONFLICT (email) DO UPDATE
        SET password_hash=$3, perfil='super_admin', ativo=true
    `, [sa.email, sa.nome, hash]);
    console.log(`   OK: ${sa.email}`);
  }

  // ── 2. Empresa de demonstração principal ───────────────────────────────────
  console.log('\n2. Empresa demo...');
  let empId;
  const { rows: empExist } = await q(`SELECT id FROM empresa WHERE nif='509876543' LIMIT 1`);
  if (empExist.length) {
    empId = empExist[0].id;
    console.log(`   OK: já existe (${empId})`);
  } else {
    const { rows: [emp] } = await q(`
      INSERT INTO empresa (nome,nif,email,telefone,morada,codigo_postal,localidade,pais,ativo)
      VALUES ('TechSolutions Lda','509876543','geral@techsolutions.pt',
              '+351 210 000 001','Rua da Tecnologia 123','1000-001','Lisboa','PT',true)
      RETURNING id
    `);
    empId = emp.id;
    console.log(`   OK: criada (${empId})`);
  }

  // ── 3. Utilizadores demo ───────────────────────────────────────────────────
  console.log('\n3. Utilizadores demo...');
  const users = [
    { email:'admin@techsol.pt',  nome:'Antonio Silva',   perfil:'admin_empresa', pw:'Admin@2025!'  },
    { email:'rh@techsol.pt',     nome:'Maria Santos',    perfil:'rh',            pw:'RH@2025!'     },
    { email:'dir@techsol.pt',    nome:'Carlos Ferreira', perfil:'diretor',       pw:'Dir@2025!'    },
  ];
  for (const u of users) {
    const hash = await bcrypt.hash(u.pw, 12);
    await q(`
      INSERT INTO utilizador (empresa_id,email,nome_completo,password_hash,perfil,ativo,email_verificado)
      VALUES ($1,$2,$3,$4,$5,true,true)
      ON CONFLICT (email) DO UPDATE
        SET password_hash=$4, perfil=$5, ativo=true, empresa_id=$1
    `, [empId, u.email, u.nome, hash, u.perfil]);
    console.log(`   OK: ${u.email} (${u.perfil})`);
  }

  // ── 4. Departamentos ───────────────────────────────────────────────────────
  console.log('\n4. Departamentos...');
  const depts = ['Administracao','Tecnologia','Comercial','Financeiro','Recursos Humanos','Operacoes'];
  const deptIds = {};
  for (const d of depts) {
    const { rows: ex } = await q(`SELECT id FROM departamento WHERE empresa_id=$1 AND nome=$2`, [empId, d]);
    if (ex.length) {
      deptIds[d] = ex[0].id;
    } else {
      const { rows: [dep] } = await q(
        `INSERT INTO departamento (empresa_id,nome,ativo) VALUES ($1,$2,true) RETURNING id`,
        [empId, d]
      );
      deptIds[d] = dep.id;
      console.log(`   OK: ${d}`);
    }
  }
  console.log(`   ${Object.keys(deptIds).length} departamentos OK`);

  // ── 5. Funcionários demo ───────────────────────────────────────────────────
  console.log('\n5. Funcionarios demo...');
  const { rows: [au] } = await q(`SELECT id FROM utilizador WHERE email='admin@techsol.pt'`);
  const { rows: [ru] } = await q(`SELECT id FROM utilizador WHERE email='rh@techsol.pt'`);

  const funcs = [
    { nome:'Antonio Silva',   cargo:'Administrador',        nif:'123456789', niss:'11234567890', sal:3500, dept:'Administracao',     uid:au?.id },
    { nome:'Maria Santos',    cargo:'Tecnica de RH',        nif:'234567890', niss:'22345678901', sal:2200, dept:'Recursos Humanos',  uid:ru?.id },
    { nome:'Joao Rodrigues',  cargo:'Desenvolvedor Senior', nif:'345678901', niss:'33456789012', sal:2800, dept:'Tecnologia',        uid:null   },
    { nome:'Ana Pereira',     cargo:'Gestora Comercial',    nif:'456789012', niss:'44567890123', sal:2400, dept:'Comercial',         uid:null   },
    { nome:'Pedro Costa',     cargo:'Analista Financeiro',  nif:'567890123', niss:'55678901234', sal:2600, dept:'Financeiro',        uid:null   },
    { nome:'Sofia Martins',   cargo:'Assistente Operacoes', nif:'678901234', niss:'66789012345', sal:1800, dept:'Operacoes',         uid:null   },
  ];
  let criados = 0;
  for (let i=0; i<funcs.length; i++) {
    const f = funcs[i];
    const { rows: ex } = await q(`SELECT id FROM funcionario WHERE nif=$1`, [f.nif]);
    if (!ex.length) {
      await q(`
        INSERT INTO funcionario (
          empresa_id, utilizador_id, departamento_id, numero_funcionario,
          nome_completo, cargo, nif, niss, email_empresa,
          salario_base, subsidio_alimentacao, tipo_contrato,
          data_admissao, estado, dias_ferias_ano, dias_ferias_saldo
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,6.00,'sem_termo',
          '2024-01-01','ativo',22,22)
      `, [empId, f.uid, deptIds[f.dept]||null,
          `FUNC-${String(i+1).padStart(4,'0')}`,
          f.nome, f.cargo, f.nif, f.niss,
          f.nome.toLowerCase().replace(/ /g,'.')+'@techsol.pt',
          f.sal]);
      criados++;
    }
  }
  console.log(`   ${criados} criados, ${funcs.length-criados} ja existiam`);

  // ── 6. Séries de faturação ─────────────────────────────────────────────────
  console.log('\n6. Series de faturacao...');
  const ano = new Date().getFullYear();
  for (const tipo of ['FT','NC','VD','FR']) {
    const { rows: ex } = await q(
      `SELECT id FROM serie_faturacao WHERE empresa_id=$1 AND tipo_doc=$2`,
      [empId, tipo]
    );
    if (!ex.length) {
      await q(`
        INSERT INTO serie_faturacao (empresa_id,tipo_doc,serie,ultimo_numero,codigo_validacao,ativa)
        VALUES ($1,$2,$3,0,'DEMO2026',true)
      `, [empId, tipo, `${ano}A`]);
      console.log(`   OK: ${tipo} ${ano}A criada`);
    } else {
      console.log(`   OK: ${tipo} ja existe`);
    }
  }

  // ── 7. Clientes demo ───────────────────────────────────────────────────────
  console.log('\n7. Clientes demo...');
  const clientes = [
    { nome:'Grupo Exemplo SA',    nif:'509123456', email:'financeiro@grupoexemplo.pt'  },
    { nome:'Startup Digital Lda', nif:'509234567', email:'admin@startupdigital.pt'     },
    { nome:'Consultores PT Lda',  nif:'509345678', email:'geral@consultorespt.pt'      },
  ];
  let cli_criados = 0;
  for (const c of clientes) {
    const { rows: ex } = await q(
      `SELECT id FROM cliente WHERE empresa_id=$1 AND nif=$2`, [empId, c.nif]
    );
    if (!ex.length) {
      await q(
        `INSERT INTO cliente (empresa_id,nome,nif,email,ativo) VALUES ($1,$2,$3,$4,true)`,
        [empId, c.nome, c.nif, c.email]
      );
      cli_criados++;
    }
  }
  console.log(`   ${cli_criados} criados, ${clientes.length-cli_criados} ja existiam`);

  // ── 8. Conta bancária ──────────────────────────────────────────────────────
  console.log('\n8. Conta bancaria...');
  const { rows: cbEx } = await q(
    `SELECT id FROM conta_bancaria WHERE empresa_id=$1 AND iban='PT50000100001234567890154'`, [empId]
  );
  if (!cbEx.length) {
    await q(`
      INSERT INTO conta_bancaria (empresa_id,iban,banco,descricao,ativa,saldo_inicial)
      VALUES ($1,'PT50000100001234567890154','Caixa Geral de Depositos','Conta Principal',true,15000.00)
    `, [empId]).catch(()=>{});
    console.log('   OK: criada');
  } else {
    console.log('   OK: ja existe');
  }

  // ── 9. Feriados nacionais 2026 ─────────────────────────────────────────────
  console.log('\n9. Feriados nacionais 2026...');
  const feriados = [
    ['2026-01-01','Ano Novo'],            ['2026-04-03','Sexta-Feira Santa'],
    ['2026-04-05','Pascoa'],              ['2026-04-25','Dia da Liberdade'],
    ['2026-05-01','Dia do Trabalhador'],  ['2026-06-10','Dia de Portugal'],
    ['2026-08-15','Assuncao'],            ['2026-10-05','Implantacao da Republica'],
    ['2026-11-01','Todos os Santos'],     ['2026-12-01','Restauracao da Independencia'],
    ['2026-12-08','Imaculada Conceicao'],['2026-12-25','Natal'],
  ];
  let fer_criados = 0;
  for (const [data, nome] of feriados) {
    const { rows: ex } = await q(
      `SELECT id FROM feriado WHERE empresa_id=$1 AND data=$2`, [empId, data]
    );
    if (!ex.length) {
      await q(
        `INSERT INTO feriado (empresa_id,data,nome,tipo,recorrente) VALUES ($1,$2,$3,'nacional',true)`,
        [empId, data, nome]
      ).catch(()=>{});
      fer_criados++;
    }
  }
  console.log(`   ${fer_criados} criados, ${feriados.length-fer_criados} ja existiam`);

  // ── 10. Tabelas extras v9 ──────────────────────────────────────────────────
  console.log('\n10. Tabelas extras v9...');
  await q(`CREATE TABLE IF NOT EXISTS interesse_contacto (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nome VARCHAR(200), email VARCHAR(200), empresa VARCHAR(200),
    telefone VARCHAR(50), plano VARCHAR(50), mensagem TEXT,
    criado_em TIMESTAMP DEFAULT NOW(), contactado BOOLEAN DEFAULT false
  )`);
  await q(`CREATE TABLE IF NOT EXISTS avaliacoes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id UUID NOT NULL REFERENCES empresa(id),
    funcionario_id UUID NOT NULL REFERENCES funcionario(id),
    avaliador_id UUID REFERENCES utilizador(id),
    periodo VARCHAR(50), ano INTEGER, nota_global NUMERIC(4,1),
    classificacao VARCHAR(50), pontos_fortes TEXT, areas_melhoria TEXT,
    comentarios TEXT, recomendacao VARCHAR(30), competencias JSONB DEFAULT '[]',
    estado VARCHAR(20) DEFAULT 'rascunho', data_avaliacao DATE,
    criado_em TIMESTAMP DEFAULT NOW(), atualizado_em TIMESTAMP DEFAULT NOW()
  )`);
  console.log('   OK: interesse_contacto e avaliacoes');

  // ── RESUMO ─────────────────────────────────────────────────────────────────
  const { rows: [stats] } = await q(`
    SELECT
      (SELECT COUNT(*) FROM utilizador WHERE perfil='super_admin') AS super_admins,
      (SELECT COUNT(*) FROM empresa WHERE ativo=true) AS empresas,
      (SELECT COUNT(*) FROM utilizador WHERE empresa_id IS NOT NULL) AS users_empresa,
      (SELECT COUNT(*) FROM funcionario) AS funcionarios,
      (SELECT COUNT(*) FROM serie_faturacao) AS series,
      (SELECT COUNT(*) FROM cliente) AS clientes,
      (SELECT COUNT(*) FROM feriado) AS feriados
  `);

  console.log('\n================================');
  console.log('SEED CONCLUIDO COM SUCESSO');
  console.log('================================');
  console.log(`Super Admins:  ${stats.super_admins}`);
  console.log(`Empresas:      ${stats.empresas}`);
  console.log(`Utilizadores:  ${stats.users_empresa}`);
  console.log(`Funcionarios:  ${stats.funcionarios}`);
  console.log(`Series fat.:   ${stats.series}`);
  console.log(`Clientes:      ${stats.clientes}`);
  console.log(`Feriados:      ${stats.feriados}`);
  console.log('\nCredenciais:');
  console.log('  Super Admin: ricardo@nexedge.pt / NexEdge2026!SuperAdmin');
  console.log('  Admin demo:  admin@techsol.pt / Admin@2025!');
  console.log('  RH demo:     rh@techsol.pt / RH@2025!');

  await pool.end();
}

main().catch(e => {
  console.error('\nERRO:', e.message);
  pool.end();
  process.exit(1);
});
