'use strict';

/**
 * Monitor Legal — NexEdge
 * Monitoriza alterações na legislação laboral e fiscal portuguesa
 * Corre semanalmente via cron job
 */

const { query, pool } = require('../config/database');

// ── Sites a monitorizar ─────────────────────────────────────────────────────
const FONTES = [
  // FISCALIDADE
  {
    id: 'at_irs_tabelas',
    nome: 'Tabelas de Retenção IRS 2025',
    url: 'https://www.portaldasfinancas.gov.pt/at/html/index.html',
    categoria: 'fiscal',
    descricao: 'Tabelas de retenção na fonte do IRS — Autoridade Tributária',
    palavras_chave: ['retenção', 'tabela', 'IRS', 'despacho', '2025', '2026'],
    impacto: 'critico',
  },
  {
    id: 'at_irs_jovem',
    nome: 'IRS Jovem — Regime Fiscal',
    url: 'https://www.portaldasfinancas.gov.pt/at/html/index.html',
    categoria: 'fiscal',
    descricao: 'Regime IRS Jovem — taxas e elegibilidade',
    palavras_chave: ['IRS Jovem', 'isenção', 'jovem', 'anos'],
    impacto: 'alto',
  },
  // SEGURANÇA SOCIAL
  {
    id: 'ss_taxas',
    nome: 'Taxas Contributivas SS',
    url: 'https://www.seg-social.pt/trabalhadores-por-conta-de-outrem',
    categoria: 'seguranca_social',
    descricao: 'Taxas contributivas para trabalhadores por conta de outrem',
    palavras_chave: ['taxa', 'contributiva', '11%', '23,75%', 'quota'],
    impacto: 'critico',
  },
  {
    id: 'ss_bases',
    nome: 'Bases de Incidência SS',
    url: 'https://www.seg-social.pt/bases-de-incidencia-contributiva',
    categoria: 'seguranca_social',
    descricao: 'O que está sujeito a contribuições para a Segurança Social',
    palavras_chave: ['base', 'incidência', 'subsídio', 'alimentação', 'férias'],
    impacto: 'alto',
  },
  {
    id: 'ss_smn',
    nome: 'Salário Mínimo Nacional',
    url: 'https://www.seg-social.pt/salario-minimo-nacional',
    categoria: 'seguranca_social',
    descricao: 'Valor actual do Salário Mínimo Nacional',
    palavras_chave: ['salário mínimo', 'SMN', 'RMMG', '870', '2025', '2026'],
    impacto: 'critico',
  },
  // LEGISLAÇÃO LABORAL
  {
    id: 'dre_ct',
    nome: 'Diário da República — Código do Trabalho',
    url: 'https://dre.pt/dre/legislacao-consolidada/lei/2009-34546475',
    categoria: 'laboral',
    descricao: 'Código do Trabalho — alterações publicadas no DRE',
    palavras_chave: ['férias', 'horário', 'despedimento', 'contrato', 'horas'],
    impacto: 'critico',
  },
  {
    id: 'dre_recente',
    nome: 'Diário da República — Legislação Recente',
    url: 'https://dre.pt/home',
    categoria: 'laboral',
    descricao: 'Novas publicações no Diário da República relevantes para RH',
    palavras_chave: ['trabalho', 'emprego', 'salário', 'férias', 'baixa', 'parentalidade'],
    impacto: 'alto',
  },
  // CONDIÇÕES DE TRABALHO
  {
    id: 'act_portaria',
    nome: 'ACT — Autoridade para as Condições do Trabalho',
    url: 'https://www.act.gov.pt',
    categoria: 'condicoes_trabalho',
    descricao: 'Regulamentação de condições de trabalho e portarias',
    palavras_chave: ['horas extra', 'descanso', 'acidente', 'portaria', 'regulamento'],
    impacto: 'alto',
  },
  // SUBSÍDIOS E COMPLEMENTOS
  {
    id: 'at_sub_alimentacao',
    nome: 'Subsídio de Alimentação — Limites Isenção',
    url: 'https://www.portaldasfinancas.gov.pt/at/html/index.html',
    categoria: 'fiscal',
    descricao: 'Limites de isenção fiscal do subsídio de alimentação',
    palavras_chave: ['subsídio alimentação', 'isenção', '6,15', '10,46', 'refeição'],
    impacto: 'alto',
  },
  {
    id: 'at_ajudas_custo',
    nome: 'Ajudas de Custo — Limites Isenção',
    url: 'https://www.portaldasfinancas.gov.pt/at/html/index.html',
    categoria: 'fiscal',
    descricao: 'Limites de isenção fiscal das ajudas de custo nacionais e internacionais',
    palavras_chave: ['ajudas de custo', 'deslocação', 'isenção', 'km'],
    impacto: 'medio',
  },
  // MEDICINA DO TRABALHO
  {
    id: 'dgs_medicina_trabalho',
    nome: 'DGS — Medicina do Trabalho',
    url: 'https://www.dgs.pt/saude-ocupacional.aspx',
    categoria: 'saude_trabalho',
    descricao: 'Requisitos de medicina do trabalho e exames obrigatórios',
    palavras_chave: ['exame', 'aptidão', 'periódico', 'admissão', 'médico trabalho'],
    impacto: 'medio',
  },
  // IGUALDADE E PARENTALIDADE
  {
    id: 'cite_parentalidade',
    nome: 'CITE — Parentalidade e Igualdade',
    url: 'https://www.cite.gov.pt',
    categoria: 'parentalidade',
    descricao: 'Licenças parentais, igualdade de género e conciliação',
    palavras_chave: ['licença parental', 'maternidade', 'paternidade', 'amamentação', 'igualdade'],
    impacto: 'alto',
  },
  // FCT/FGCT
  {
    id: 'fct_taxas',
    nome: 'FCT/FGCT — Fundo de Compensação do Trabalho',
    url: 'https://www.fct.pt',
    categoria: 'seguranca_social',
    descricao: 'Taxas do Fundo de Compensação do Trabalho',
    palavras_chave: ['FCT', 'FGCT', '0,925', '0,075', 'compensação'],
    impacto: 'alto',
  },
  // DECO / CONSUMIDORES
  {
    id: 'deco_trabalho',
    nome: 'DECO — Direitos Laborais',
    url: 'https://www.deco.proteste.pt/trabalho',
    categoria: 'laboral',
    descricao: 'Informação prática sobre direitos laborais dos trabalhadores',
    palavras_chave: ['despedimento', 'indemnização', 'subsídio', 'direitos', 'férias'],
    impacto: 'baixo',
  },
  // PORTARIA SUBSISTÊNCIA
  {
    id: 'mf_portaria_subsistencia',
    nome: 'Portaria — Subsídio de Refeição Setor Público',
    url: 'https://dre.pt/home',
    categoria: 'fiscal',
    descricao: 'Portaria anual que define o subsídio de refeição no setor público (referência para setor privado)',
    palavras_chave: ['portaria', 'subsídio refeição', 'funcionário público', 'refeição'],
    impacto: 'medio',
  },
];

// ── Valores actuais a vigiar ────────────────────────────────────────────────
const VALORES_ACTUAIS = {
  smn: 870,                    // Salário Mínimo Nacional 2025
  ss_funcionario: 11.0,        // % SS funcionário
  ss_empresa: 23.75,           // % SS empresa
  fct: 0.925,                  // % FCT
  fgct: 0.075,                 // % FGCT
  sub_alimentacao_dinheiro: 6.15,  // €/dia isento (dinheiro)
  sub_alimentacao_cartao: 10.46,   // €/dia isento (cartão/vale)
  irs_jovem_1_ano: 100,        // % isenção IRS Jovem 1º ano
  irs_jovem_2_ano: 75,         // % isenção IRS Jovem 2º ano
  irs_jovem_3_ano: 50,         // % isenção IRS Jovem 3º ano
  irs_jovem_4_10_ano: 25,      // % isenção IRS Jovem 4º-10º ano
};

// ── Criar tabela de monitorização se não existir ───────────────────────────
async function criarTabelaMonitor() {
  await query(`
    CREATE TABLE IF NOT EXISTS monitor_legal (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      fonte_id VARCHAR(100) NOT NULL,
      nome VARCHAR(200) NOT NULL,
      url TEXT NOT NULL,
      categoria VARCHAR(50),
      impacto VARCHAR(20),
      descricao TEXT,
      hash_anterior TEXT,
      hash_atual TEXT,
      alteracao_detectada BOOLEAN DEFAULT false,
      descricao_alteracao TEXT,
      revisado BOOLEAN DEFAULT false,
      revisado_por UUID REFERENCES utilizador(id),
      revisado_em TIMESTAMPTZ,
      criado_em TIMESTAMPTZ DEFAULT NOW(),
      atualizado_em TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS alerta_legal (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      monitor_id UUID REFERENCES monitor_legal(id),
      fonte_id VARCHAR(100),
      titulo VARCHAR(300),
      descricao TEXT,
      impacto VARCHAR(20),
      url_fonte TEXT,
      lido BOOLEAN DEFAULT false,
      empresa_id UUID REFERENCES empresa(id),
      criado_em TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

// ── Buscar página com retry ────────────────────────────────────────────────
async function fetchComTimeout(url, timeout = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'NexEdge-LegalMonitor/1.0 (monitor@nexedge.pt)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'pt-PT,pt;q=0.9',
      },
    });
    clearTimeout(timer);
    return await resp.text();
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

// ── Hash simples do conteúdo relevante ────────────────────────────────────
function hashConteudo(texto, palavrasChave) {
  // Extrai só parágrafos com palavras-chave relevantes
  const linhas = texto.toLowerCase().split('\n');
  const relevantes = linhas.filter(l =>
    palavrasChave.some(p => l.includes(p.toLowerCase()))
  ).join('|');

  // Hash simples (djb2)
  let hash = 5381;
  for (let i = 0; i < relevantes.length; i++) {
    hash = ((hash << 5) + hash) + relevantes.charCodeAt(i);
    hash = hash & hash; // 32bit
  }
  return Math.abs(hash).toString(16);
}

// ── Monitorizar uma fonte ──────────────────────────────────────────────────
async function monitorarFonte(fonte) {
  try {
    console.log(`  📡 A verificar: ${fonte.nome}...`);
    const html = await fetchComTimeout(fonte.url);
    const hashAtual = hashConteudo(html, fonte.palavras_chave);

    // Buscar registo anterior
    const { rows: [anterior] } = await query(
      'SELECT * FROM monitor_legal WHERE fonte_id=$1 ORDER BY criado_em DESC LIMIT 1',
      [fonte.id]
    );

    const alteracaoDetectada = anterior && anterior.hash_atual !== hashAtual;

    // Guardar/actualizar registo
    await query(`
      INSERT INTO monitor_legal (fonte_id, nome, url, categoria, impacto, descricao, hash_atual, hash_anterior, alteracao_detectada, atualizado_em)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
      ON CONFLICT DO NOTHING
    `, [fonte.id, fonte.nome, fonte.url, fonte.categoria, fonte.impacto, fonte.descricao,
        hashAtual, anterior?.hash_atual || null, alteracaoDetectada]);

    if (alteracaoDetectada) {
      console.log(`  ⚠️  ALTERAÇÃO DETECTADA: ${fonte.nome}`);

      // Criar alerta para todas as empresas activas
      const { rows: empresas } = await query('SELECT id FROM empresa WHERE ativo=true');
      for (const emp of empresas) {
        await query(`
          INSERT INTO alerta_legal (fonte_id, titulo, descricao, impacto, url_fonte, empresa_id)
          VALUES ($1,$2,$3,$4,$5,$6)
        `, [
          fonte.id,
          `⚖️ Possível alteração: ${fonte.nome}`,
          `Foi detectada uma alteração no conteúdo de "${fonte.nome}". Verifique se existem mudanças relevantes para a sua empresa em: ${fonte.url}`,
          fonte.impacto,
          fonte.url,
          emp.id,
        ]);
      }
      return { alterado: true, fonte: fonte.nome };
    }

    return { alterado: false, fonte: fonte.nome };
  } catch (e) {
    console.warn(`  ❌ Erro ao verificar ${fonte.nome}: ${e.message}`);
    return { alterado: false, erro: e.message, fonte: fonte.nome };
  }
}

// ── Job principal ──────────────────────────────────────────────────────────
async function correrMonitor() {
  console.log('\n🔍 NexEdge Monitor Legal — A iniciar verificação...');
  console.log(`   ${new Date().toLocaleString('pt-PT')}`);
  console.log(`   ${FONTES.length} fontes a verificar\n`);

  try {
    await criarTabelaMonitor();
  } catch (e) {
    console.warn('Aviso ao criar tabelas monitor:', e.message);
  }

  const resultados = [];
  for (const fonte of FONTES) {
    const r = await monitorarFonte(fonte);
    resultados.push(r);
    // Pausa entre pedidos para não sobrecarregar os servidores
    await new Promise(res => setTimeout(res, 2000));
  }

  const alterados = resultados.filter(r => r.alterado);
  const erros = resultados.filter(r => r.erro);

  console.log(`\n📊 Resumo da verificação:`);
  console.log(`   ✅ Verificadas: ${resultados.length - erros.length}`);
  console.log(`   ⚠️  Alterações detectadas: ${alterados.length}`);
  console.log(`   ❌ Erros: ${erros.length}`);

  if (alterados.length > 0) {
    console.log('\n⚠️  FONTES COM ALTERAÇÕES:');
    alterados.forEach(a => console.log(`   - ${a.fonte}`));
  }

  return { total: FONTES.length, alterados: alterados.length, erros: erros.length };
}

module.exports = { correrMonitor, FONTES, VALORES_ACTUAIS };
