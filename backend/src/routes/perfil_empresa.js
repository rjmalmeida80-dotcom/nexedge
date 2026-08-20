'use strict';
const router = require('express').Router();
const { autenticar, autorizar } = require('../middleware/auth');
const { query } = require('../config/database');
const { PACKS_SECTORIAIS } = require('../config/migrate_v12');

const ADMINS = ['admin_empresa', 'diretor', 'super_admin'];

// GET /perfil-empresa/packs — listar todos os packs disponíveis
router.get('/packs', autenticar, async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM sector_pack WHERE ativo=true ORDER BY label');
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /perfil-empresa — obter perfil actual da empresa
router.get('/', autenticar, async (req, res) => {
  try {
    const { rows: [emp] } = await query(`
      SELECT e.id, e.nome, e.setor, e.sector_pack, e.dimensao,
             e.onboarding_completo, e.onboarding_passo,
             e.modulos_ativos, e.configuracoes, e.packs_config,
             sp.label AS pack_label, sp.descricao AS pack_descricao
      FROM empresa e
      LEFT JOIN sector_pack sp ON sp.id = e.sector_pack
      WHERE e.id = $1
    `, [req.empresaId]);

    if (!emp) return res.status(404).json({ error: 'Empresa não encontrada' });
    res.json(emp);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /perfil-empresa/pack — aplicar pack sectorial
router.put('/pack', autenticar, autorizar(...ADMINS), async (req, res) => {
  try {
    const { sector_pack, dimensao, modulos_extra = [] } = req.body;

    if (!sector_pack) return res.status(400).json({ error: 'Pack sectorial obrigatório' });

    // Obter módulos do pack
    const { rows: [pack] } = await query(
      'SELECT * FROM sector_pack WHERE id=$1', [sector_pack]
    );
    if (!pack) return res.status(404).json({ error: 'Pack não encontrado' });

    // Combinar módulos do pack com extras
    const modulos = [...new Set([...pack.modulos, ...modulos_extra])];

    await query(`
      UPDATE empresa SET
        sector_pack = $1,
        dimensao = $2,
        modulos_ativos = $3,
        atualizado_em = NOW()
      WHERE id = $4
    `, [sector_pack, dimensao || 'pme', JSON.stringify(modulos), req.empresaId]);

    res.json({
      ok: true,
      sector_pack,
      modulos_ativos: modulos,
      message: `Pack "${pack.label}" aplicado com sucesso`
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /perfil-empresa/modulos — activar/desactivar módulos individualmente
router.put('/modulos', autenticar, autorizar(...ADMINS), async (req, res) => {
  try {
    const { modulos_ativos } = req.body;
    if (!Array.isArray(modulos_ativos)) return res.status(400).json({ error: 'modulos_ativos deve ser array' });

    await query(`
      UPDATE empresa SET modulos_ativos=$1, atualizado_em=NOW() WHERE id=$2
    `, [JSON.stringify(modulos_ativos), req.empresaId]);

    res.json({ ok: true, modulos_ativos });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /perfil-empresa/onboarding — completar passo do wizard
router.post('/onboarding', autenticar, autorizar(...ADMINS), async (req, res) => {
  try {
    const { passo, dados } = req.body;

    // Passo 1: Sector
    if (passo === 1 && dados.sector_pack) {
      const { rows: [pack] } = await query('SELECT * FROM sector_pack WHERE id=$1', [dados.sector_pack]);
      if (pack) {
        await query(`
          UPDATE empresa SET
            sector_pack=$1, setor=$2,
            modulos_ativos=$3, onboarding_passo=1
          WHERE id=$4
        `, [dados.sector_pack, dados.sector_pack, JSON.stringify(pack.modulos), req.empresaId]);
      }
    }

    // Passo 2: Dimensão
    if (passo === 2 && dados.dimensao) {
      await query(`
        UPDATE empresa SET dimensao=$1, onboarding_passo=2 WHERE id=$2
      `, [dados.dimensao, req.empresaId]);
    }

    // Passo 3: Módulos adicionais
    if (passo === 3 && dados.modulos_ativos) {
      await query(`
        UPDATE empresa SET modulos_ativos=$1, onboarding_passo=3 WHERE id=$2
      `, [JSON.stringify(dados.modulos_ativos), req.empresaId]);
    }

    // Passo 4: Configurações básicas (nome, NIF, morada)
    if (passo === 4 && dados.nome) {
      await query(`
        UPDATE empresa SET
          nome=COALESCE($1, nome),
          nif=COALESCE($2, nif),
          morada=COALESCE($3, morada),
          telefone=COALESCE($4, telefone),
          email=COALESCE($5, email),
          onboarding_passo=4
        WHERE id=$6
      `, [dados.nome, dados.nif, dados.morada, dados.telefone, dados.email, req.empresaId]);
    }

    // Passo 5: Confirmar e completar
    if (passo === 5) {
      await query(`
        UPDATE empresa SET onboarding_completo=true, onboarding_passo=5 WHERE id=$1
      `, [req.empresaId]);
    }

    // Obter estado actual
    const { rows: [emp] } = await query(`
      SELECT sector_pack, dimensao, modulos_ativos, onboarding_completo, onboarding_passo
      FROM empresa WHERE id=$1
    `, [req.empresaId]);

    res.json({ ok: true, passo, empresa: emp });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /perfil-empresa/modulos-disponiveis — todos os módulos disponíveis
router.get('/modulos-disponiveis', autenticar, async (req, res) => {
  try {
    const TODOS_MODULOS = [
      { id: 'dashboard', label: 'Dashboard', icone: '📊', categoria: 'core', obrigatorio: true },
      { id: 'funcionarios', label: 'Funcionários & RH', icone: '👥', categoria: 'rh', obrigatorio: false },
      { id: 'ferias', label: 'Férias & Ausências', icone: '🏖️', categoria: 'rh', obrigatorio: false },
      { id: 'horarios', label: 'Horários & Escalas', icone: '🕐', categoria: 'rh', obrigatorio: false },
      { id: 'salarios', label: 'Salários & Recibos', icone: '💰', categoria: 'financeiro', obrigatorio: false },
      { id: 'faturacao', label: 'Faturação AT', icone: '📄', categoria: 'financeiro', obrigatorio: false },
      { id: 'contabilidade', label: 'Contabilidade SNC', icone: '📒', categoria: 'financeiro', obrigatorio: false },
      { id: 'openbanking', label: 'Open Banking', icone: '🏦', categoria: 'financeiro', obrigatorio: false },
      { id: 'despesas', label: 'Despesas', icone: '💳', categoria: 'financeiro', obrigatorio: false },
      { id: 'crm', label: 'CRM & Pipeline', icone: '🎯', categoria: 'comercial', obrigatorio: false },
      { id: 'compras', label: 'Compras & Stock', icone: '🛒', categoria: 'operacional', obrigatorio: false },
      { id: 'frota', label: 'Gestão de Frota', icone: '🚗', categoria: 'operacional', obrigatorio: false },
      { id: 'ativos', label: 'Activos Fixos', icone: '🏭', categoria: 'operacional', obrigatorio: false },
      { id: 'contratos', label: 'Contratos', icone: '📝', categoria: 'juridico', obrigatorio: false },
      { id: 'assinaturas', label: 'Assinaturas Digitais', icone: '✍️', categoria: 'juridico', obrigatorio: false },
      { id: 'documentos', label: 'Documentos', icone: '📁', categoria: 'juridico', obrigatorio: false },
      { id: 'formacao', label: 'Formação', icone: '📚', categoria: 'rh', obrigatorio: false },
      { id: 'medicina', label: 'Medicina do Trabalho', icone: '🏥', categoria: 'rh', obrigatorio: false },
      { id: 'presencas', label: 'Presenças & Ponto', icone: '📋', categoria: 'rh', obrigatorio: false },
      { id: 'recrutamento', label: 'Recrutamento', icone: '🔍', categoria: 'rh', obrigatorio: false },
      { id: 'relatorios', label: 'Relatórios & BI', icone: '📈', categoria: 'core', obrigatorio: false },
      { id: 'chat', label: 'Chat Interno', icone: '💬', categoria: 'comunicacao', obrigatorio: false },
      { id: 'tickets', label: 'Tickets & Suporte', icone: '🎫', categoria: 'suporte', obrigatorio: false },
      { id: 'portal_colaborador', label: 'Portal Colaborador', icone: '👤', categoria: 'rh', obrigatorio: false },
    ];

    // Obter módulos activos da empresa
    const { rows: [emp] } = await query(
      'SELECT modulos_ativos FROM empresa WHERE id=$1', [req.empresaId]
    );
    const activos = emp?.modulos_ativos || [];

    res.json(TODOS_MODULOS.map(m => ({ ...m, ativo: activos.includes(m.id) })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /perfil-empresa/campos-dinamicos/:modulo — campos dinâmicos por módulo
router.get('/campos-dinamicos/:modulo', autenticar, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT * FROM campo_dinamico
      WHERE empresa_id=$1 AND modulo=$2 AND ativo=true
      ORDER BY ordem
    `, [req.empresaId, req.params.modulo]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /perfil-empresa/campos-dinamicos — criar campo dinâmico
router.post('/campos-dinamicos', autenticar, autorizar(...ADMINS), async (req, res) => {
  try {
    const { modulo, entidade, campo, tipo, label, obrigatorio, opcoes, ordem } = req.body;
    const { rows: [novo] } = await query(`
      INSERT INTO campo_dinamico (empresa_id, modulo, entidade, campo, tipo, label, obrigatorio, opcoes, ordem)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *
    `, [req.empresaId, modulo, entidade, campo, tipo||'text', label, obrigatorio||false, JSON.stringify(opcoes||[]), ordem||0]);
    res.status(201).json(novo);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /perfil-empresa/ia-sugestao — sugestão de pack por IA
router.post('/ia-sugestao', autenticar, async (req, res) => {
  try {
    const { descricao_empresa, sector, num_funcionarios, necessidades } = req.body;

    const { rows: packs } = await query('SELECT * FROM sector_pack WHERE ativo=true');

    const prompt = `Analisa esta empresa e sugere o melhor pack de módulos para o ERP NexEdge:

Empresa: ${descricao_empresa || 'Não especificado'}
Sector: ${sector || 'Não especificado'}
Nº Funcionários: ${num_funcionarios || 'Não especificado'}
Necessidades: ${necessidades || 'Não especificado'}

Packs disponíveis:
${packs.map(p => `- ${p.id}: ${p.label} — ${p.descricao}`).join('\n')}

Responde em JSON com:
{
  "pack_recomendado": "id_do_pack",
  "justificacao": "porquê este pack",
  "modulos_extra": ["modulo1", "modulo2"],
  "configuracoes_sugeridas": {}
}

Responde APENAS com JSON válido, sem texto extra.`;

    // Usar chave API da empresa ou global
    const { rows: [emp] } = await query('SELECT anthropic_api_key FROM empresa WHERE id=$1', [req.empresaId]).catch(() => ({ rows: [{}] }));
    const apiKey = emp?.anthropic_api_key || process.env.ANTHROPIC_API_KEY;

    if (!apiKey) return res.json({ pack_recomendado: 'geral', justificacao: 'Pack geral recomendado por defeito', modulos_extra: [] });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    const text = data.content?.[0]?.text || '{}';
    try {
      const sugestao = JSON.parse(text);
      res.json(sugestao);
    } catch {
      res.json({ pack_recomendado: 'geral', justificacao: text, modulos_extra: [] });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
