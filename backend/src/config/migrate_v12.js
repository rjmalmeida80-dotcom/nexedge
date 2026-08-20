'use strict';
const { query } = require('../config/database');

const PACKS_SECTORIAIS = {
  consultoria: {
    label: 'Consultoria & Serviços',
    modulos: ['funcionarios','ferias','horarios','salarios','faturacao','crm','despesas','contratos','documentos','relatorios','dashboard','chat','assinaturas','openbanking','contabilidade'],
    descricao: 'Gestão de projectos, consultores, timesheets e faturação por horas'
  },
  retalho: {
    label: 'Retalho & Comércio',
    modulos: ['funcionarios','ferias','horarios','salarios','faturacao','compras','despesas','relatorios','dashboard','contabilidade','openbanking'],
    descricao: 'POS, stock, compras, fornecedores e margens'
  },
  restauracao: {
    label: 'Restauração & Hotelaria',
    modulos: ['funcionarios','ferias','horarios','salarios','faturacao','compras','despesas','relatorios','dashboard','contabilidade','presencas'],
    descricao: 'Gestão de pessoal em turnos, faturação e compras de fornecedores'
  },
  construcao: {
    label: 'Construção & Obras',
    modulos: ['funcionarios','ferias','horarios','salarios','faturacao','compras','despesas','frota','relatorios','dashboard','contabilidade','contratos','assinaturas'],
    descricao: 'Obras, materiais, equipas, subempreiteiros e autos de medição'
  },
  informatica: {
    label: 'Informática & IT',
    modulos: ['funcionarios','ferias','horarios','salarios','faturacao','crm','despesas','contratos','documentos','relatorios','dashboard','chat','assinaturas','openbanking','contabilidade','tickets','recrutamento'],
    descricao: 'ITSM, contratos de suporte, SLA e gestão de projectos IT'
  },
  saude: {
    label: 'Saúde & Clínicas',
    modulos: ['funcionarios','ferias','horarios','salarios','faturacao','despesas','medicina','relatorios','dashboard','contabilidade','documentos'],
    descricao: 'Pacientes, consultas, exames e conformidade SNS'
  },
  logistica: {
    label: 'Logística & Transportes',
    modulos: ['funcionarios','ferias','horarios','salarios','faturacao','compras','frota','despesas','relatorios','dashboard','contabilidade','openbanking'],
    descricao: 'Rotas, entregas, frota e gestão de motoristas'
  },
  industria: {
    label: 'Indústria & Manufactura',
    modulos: ['funcionarios','ferias','horarios','salarios','faturacao','compras','despesas','frota','relatorios','dashboard','contabilidade','ativos','medicina'],
    descricao: 'Produção, qualidade, manutenção e gestão de activos'
  },
  imobiliario: {
    label: 'Imobiliário',
    modulos: ['funcionarios','ferias','salarios','faturacao','crm','contratos','despesas','relatorios','dashboard','contabilidade','assinaturas','documentos'],
    descricao: 'Gestão de imóveis, contratos de arrendamento e vendas'
  },
  educacao: {
    label: 'Educação & Formação',
    modulos: ['funcionarios','ferias','horarios','salarios','faturacao','formacao','despesas','relatorios','dashboard','contabilidade','documentos','portal_colaborador'],
    descricao: 'Gestão de formadores, cursos e certificações'
  },
  geral: {
    label: 'Empresa Geral / PME',
    modulos: ['funcionarios','ferias','horarios','salarios','faturacao','crm','compras','despesas','relatorios','dashboard','contabilidade','openbanking','documentos','contratos'],
    descricao: 'Pack completo para PMEs sem sector específico'
  }
};

async function migrar() {
  console.log('🔄 migrate_v12: ERP Adaptativo — Perfil Empresarial...');
  try {
    // Adicionar campos de perfil à tabela empresa
    await query(`
      ALTER TABLE empresa
        ADD COLUMN IF NOT EXISTS sector_pack VARCHAR(50) DEFAULT 'geral',
        ADD COLUMN IF NOT EXISTS dimensao VARCHAR(20) DEFAULT 'pme',
        ADD COLUMN IF NOT EXISTS onboarding_completo BOOLEAN DEFAULT false,
        ADD COLUMN IF NOT EXISTS onboarding_passo INTEGER DEFAULT 0,
        ADD COLUMN IF NOT EXISTS packs_config JSONB DEFAULT '{}'::jsonb
    `);

    // Criar tabela de packs sectoriais
    await query(`
      CREATE TABLE IF NOT EXISTS sector_pack (
        id VARCHAR(50) PRIMARY KEY,
        label VARCHAR(100) NOT NULL,
        descricao TEXT,
        modulos JSONB NOT NULL DEFAULT '[]'::jsonb,
        campos_extra JSONB DEFAULT '{}'::jsonb,
        workflows JSONB DEFAULT '[]'::jsonb,
        ativo BOOLEAN DEFAULT true,
        criado_em TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Inserir/actualizar packs
    for (const [id, pack] of Object.entries(PACKS_SECTORIAIS)) {
      await query(`
        INSERT INTO sector_pack (id, label, descricao, modulos)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (id) DO UPDATE SET
          label = EXCLUDED.label,
          descricao = EXCLUDED.descricao,
          modulos = EXCLUDED.modulos
      `, [id, pack.label, pack.descricao, JSON.stringify(pack.modulos)]);
    }

    // Criar tabela de campos dinâmicos por sector
    await query(`
      CREATE TABLE IF NOT EXISTS campo_dinamico (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        empresa_id UUID REFERENCES empresa(id) ON DELETE CASCADE,
        modulo VARCHAR(50) NOT NULL,
        entidade VARCHAR(50) NOT NULL,
        campo VARCHAR(100) NOT NULL,
        tipo VARCHAR(20) NOT NULL DEFAULT 'text',
        label VARCHAR(100) NOT NULL,
        obrigatorio BOOLEAN DEFAULT false,
        opcoes JSONB DEFAULT '[]'::jsonb,
        ordem INTEGER DEFAULT 0,
        ativo BOOLEAN DEFAULT true,
        criado_em TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    console.log('✅ migrate_v12: concluído.');
  } catch(e) {
    console.error('❌ migrate_v12 erro:', e.message);
    throw e;
  }
}

module.exports = { migrar, PACKS_SECTORIAIS };
