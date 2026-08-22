'use strict';
/**
 * NexEdge — Relatório Único Automático
 * Geração automática do Relatório Único (GEP/CITE) obrigatório em Portugal
 * Supera: todas as soluções existentes no mercado PT
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { autenticar } = require('../middleware/auth');

router.use(autenticar);

// ── GERAR RELATÓRIO ÚNICO ──

router.get('/gerar/:ano', async (req, res) => {
  try {
    const ano = parseInt(req.params.ano);
    const empresa = await query(`SELECT * FROM empresa WHERE id=$1`, [req.empresaId]);
    const emp = empresa.rows[0];

    // Quadro 1 — Identificação da empresa
    const q1 = {
      nif: emp.nif,
      nome: emp.nome,
      cae: emp.cae || '62010',
      natureza_juridica: emp.natureza_juridica || 'LDA',
      ano_constituicao: emp.ano_constituicao || 2020,
      capital_social: emp.capital_social || 0,
      morada: emp.morada,
      codigo_postal: emp.codigo_postal,
      localidade: emp.localidade,
    };

    // Quadro 2 — Pessoal ao serviço
    const pessoal = await query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE genero='M') as homens,
        COUNT(*) FILTER (WHERE genero='F') as mulheres,
        COUNT(*) FILTER (WHERE tipo_contrato='sem_termo') as efectivos,
        COUNT(*) FILTER (WHERE tipo_contrato='a_termo') as a_termo,
        COUNT(*) FILTER (WHERE tipo_contrato='temporario') as temporarios,
        COUNT(*) FILTER (WHERE habilitacoes='licenciatura' OR habilitacoes='mestrado' OR habilitacoes='doutoramento') as nivel_superior,
        ROUND(AVG(EXTRACT(YEAR FROM AGE(data_nascimento)))) as idade_media,
        ROUND(AVG(EXTRACT(YEAR FROM AGE(data_admissao)))) as antiguidade_media
      FROM funcionario
      WHERE empresa_id=$1 AND estado='ativo'
        AND EXTRACT(YEAR FROM data_admissao) <= $2
    `, [req.empresaId, ano]);

    // Quadro 3 — Remunerações
    const remuneracoes = await query(`
      SELECT
        SUM(salario_base) as massa_salarial_base,
        AVG(salario_base) as remuneracao_media,
        MIN(salario_base) as remuneracao_minima,
        MAX(salario_base) as remuneracao_maxima,
        SUM(salario_base) FILTER (WHERE genero='M') as massa_salarial_h,
        SUM(salario_base) FILTER (WHERE genero='F') as massa_salarial_m,
        AVG(salario_base) FILTER (WHERE genero='M') as remuneracao_media_h,
        AVG(salario_base) FILTER (WHERE genero='F') as remuneracao_media_m
      FROM funcionario
      WHERE empresa_id=$1 AND estado='ativo'
    `, [req.empresaId]);

    // Quadro 4 — Horas de trabalho
    const horas = await query(`
      SELECT
        SUM(duracao_min)/60.0 as total_horas,
        COUNT(DISTINCT funcionario_id) as funcionarios_com_horas
      FROM time_entry
      WHERE empresa_id=$1 AND EXTRACT(YEAR FROM data)=$2
    `, [req.empresaId, ano]).catch(()=>({rows:[{total_horas:0}]}));

    // Quadro 5 — Formação profissional
    const formacao = await query(`
      SELECT
        COUNT(DISTINCT ff.funcionario_id) as participantes,
        SUM(f.duracao_horas) as horas_formacao,
        SUM(f.custo) as custo_formacao
      FROM formacao_inscricao ff
      JOIN formacao f ON f.id=ff.formacao_id
      WHERE f.empresa_id=$1 AND EXTRACT(YEAR FROM f.data_inicio)=$2
        AND ff.estado='concluido'
    `, [req.empresaId, ano]).catch(()=>({rows:[{participantes:0,horas_formacao:0,custo_formacao:0}]}));

    // Quadro 6 — Acidentologia
    const acidentes = await query(`
      SELECT COUNT(*) as total_acidentes,
        SUM(dias_perdidos) as dias_perdidos
      FROM acidente_trabalho
      WHERE empresa_id=$1 AND EXTRACT(YEAR FROM data_acidente)=$2
    `, [req.empresaId, ano]).catch(()=>({rows:[{total_acidentes:0,dias_perdidos:0}]}));

    const relatorio = {
      empresa: q1,
      ano,
      gerado_em: new Date().toISOString(),
      quadro_1_identificacao: q1,
      quadro_2_pessoal: pessoal.rows[0],
      quadro_3_remuneracoes: {
        ...remuneracoes.rows[0],
        gap_salarial_genero: remuneracoes.rows[0].remuneracao_media_h && remuneracoes.rows[0].remuneracao_media_m
          ? ((remuneracoes.rows[0].remuneracao_media_h - remuneracoes.rows[0].remuneracao_media_m) / remuneracoes.rows[0].remuneracao_media_h * 100).toFixed(1)
          : null,
      },
      quadro_4_horas: horas.rows[0],
      quadro_5_formacao: formacao.rows[0],
      quadro_6_acidentes: acidentes.rows[0],
      estado: 'rascunho',
    };

    // Guardar
    await query(`
      INSERT INTO relatorio_unico (empresa_id, ano, dados, estado)
      VALUES ($1,$2,$3,'rascunho')
      ON CONFLICT (empresa_id, ano) DO UPDATE SET dados=$3, estado='rascunho', actualizado_em=NOW()
    `, [req.empresaId, ano, JSON.stringify(relatorio)]).catch(()=>{});

    res.json(relatorio);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/historico', async (req, res) => {
  try {
    const r = await query(`SELECT id, ano, estado, criado_em, actualizado_em FROM relatorio_unico WHERE empresa_id=$1 ORDER BY ano DESC`, [req.empresaId]).catch(()=>({rows:[]}));
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/:ano/submeter', async (req, res) => {
  try {
    await query(`UPDATE relatorio_unico SET estado='submetido', submetido_em=NOW() WHERE empresa_id=$1 AND ano=$2`, [req.empresaId, req.params.ano]).catch(()=>{});
    res.json({ ok: true, mensagem: `Relatório Único ${req.params.ano} marcado como submetido` });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
