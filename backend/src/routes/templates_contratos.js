'use strict';
const router = require('express').Router();
const { autenticar, autorizar } = require('../middleware/auth');
const { query } = require('../config/database');

const ADMINS = ['admin_empresa','rh','diretor'];

// Templates predefinidos do sistema
const TEMPLATES_SISTEMA = [
  {
    id: 'tpl-sem-termo',
    nome: 'Contrato Sem Termo',
    tipo_contrato: 'sem_termo',
    variaveis: ['nome_completo','nif','morada','cargo','salario_base','data_inicio','horas_semanais'],
    conteudo: `CONTRATO DE TRABALHO SEM TERMO

Entre:
{{empresa_nome}}, com sede em {{empresa_morada}}, NIPC {{empresa_nif}}, 
doravante designada por ENTIDADE PATRONAL,

e

{{nome_completo}}, titular do NIF {{nif}}, residente em {{morada}},
doravante designado por TRABALHADOR,

é celebrado o presente Contrato de Trabalho Sem Termo, nos termos seguintes:

1. O TRABALHADOR é admitido para exercer as funções de {{cargo}}.

2. O contrato tem início em {{data_inicio}}.

3. A remuneração mensal ilíquida é de {{salario_base}}€.

4. O período normal de trabalho é de {{horas_semanais}} horas semanais.

5. O presente contrato rege-se pelo Código do Trabalho e demais legislação aplicável.

Local e data: ________________, {{data_assinatura}}

Entidade Patronal: _________________________

Trabalhador: _________________________`
  },
  {
    id: 'tpl-termo-certo',
    nome: 'Contrato a Termo Certo',
    tipo_contrato: 'termo_certo',
    variaveis: ['nome_completo','nif','morada','cargo','salario_base','data_inicio','data_fim','motivo'],
    conteudo: `CONTRATO DE TRABALHO A TERMO CERTO

Entre:
{{empresa_nome}}, com sede em {{empresa_morada}}, NIPC {{empresa_nif}},
doravante designada por ENTIDADE PATRONAL,

e

{{nome_completo}}, titular do NIF {{nif}}, residente em {{morada}},
doravante designado por TRABALHADOR,

é celebrado o presente Contrato de Trabalho a Termo Certo:

1. O TRABALHADOR é admitido para exercer as funções de {{cargo}}.

2. O contrato tem início em {{data_inicio}} e termo em {{data_fim}}.

3. Motivo justificativo: {{motivo}}.

4. A remuneração mensal ilíquida é de {{salario_base}}€.

5. O presente contrato rege-se pelo Código do Trabalho — artigo 140.º e ss.

Local e data: ________________, {{data_assinatura}}

Entidade Patronal: _________________________

Trabalhador: _________________________`
  },
  {
    id: 'tpl-estagio',
    nome: 'Contrato de Estágio',
    tipo_contrato: 'estagio',
    variaveis: ['nome_completo','nif','morada','cargo','salario_base','data_inicio','data_fim','orientador'],
    conteudo: `CONTRATO DE ESTÁGIO PROFISSIONAL

Entre:
{{empresa_nome}}, com sede em {{empresa_morada}}, NIPC {{empresa_nif}},
doravante designada por ENTIDADE ACOLHEDORA,

e

{{nome_completo}}, titular do NIF {{nif}}, residente em {{morada}},
doravante designado por ESTAGIÁRIO,

é celebrado o presente Contrato de Estágio Profissional:

1. O ESTAGIÁRIO realizará estágio na área de {{cargo}}.

2. O estágio decorre de {{data_inicio}} a {{data_fim}}.

3. O orientador de estágio é {{orientador}}.

4. A bolsa de estágio mensal é de {{salario_base}}€.

5. O presente contrato rege-se pelo IEFP e legislação aplicável.

Local e data: ________________, {{data_assinatura}}

Entidade Acolhedora: _________________________

Estagiário: _________________________`
  },
];

// ── Listar templates ──────────────────────────────────────────────────────────
router.get('/', autenticar, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT * FROM template_contrato
      WHERE (empresa_id=$1 OR empresa_id IS NULL) AND ativo=true
      ORDER BY criado_em DESC
    `, [req.empresaId]);

    res.json([...TEMPLATES_SISTEMA, ...rows]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Criar template ────────────────────────────────────────────────────────────
router.post('/', autenticar, autorizar(...ADMINS), async (req, res) => {
  try {
    const { nome, tipo_contrato, conteudo, variaveis } = req.body;
    if (!nome || !conteudo) return res.status(400).json({ error: 'Nome e conteúdo obrigatórios' });

    const { rows:[t] } = await query(`
      INSERT INTO template_contrato (empresa_id, nome, tipo_contrato, conteudo, variaveis, criado_por)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
    `, [req.empresaId, nome, tipo_contrato||'outro', conteudo, JSON.stringify(variaveis||[]), req.utilizador.id]);

    res.status(201).json(t);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Gerar contrato a partir de template + dados do funcionário ────────────────
router.post('/:id/gerar', autenticar, autorizar(...ADMINS), async (req, res) => {
  try {
    const { funcionario_id, variaveis_extra = {} } = req.body;
    const { id } = req.params;

    // Buscar template (sistema ou BD)
    let template = TEMPLATES_SISTEMA.find(t => t.id === id);
    if (!template) {
      const { rows:[t] } = await query(
        'SELECT * FROM template_contrato WHERE id=$1 AND (empresa_id=$2 OR empresa_id IS NULL)',
        [id, req.empresaId]
      );
      template = t;
    }
    if (!template) return res.status(404).json({ error: 'Template não encontrado' });

    // Buscar dados do funcionário e empresa
    const { rows:[func] } = await query(`
      SELECT f.*, e.nome AS empresa_nome, e.nif AS empresa_nif, e.morada AS empresa_morada
      FROM funcionario f JOIN empresa e ON e.id=f.empresa_id
      WHERE f.id=$1 AND f.empresa_id=$2
    `, [funcionario_id, req.empresaId]);
    if (!func) return res.status(404).json({ error: 'Funcionário não encontrado' });

    // Substituir variáveis
    const variaveis = {
      empresa_nome: func.empresa_nome || '',
      empresa_nif: func.empresa_nif || '',
      empresa_morada: func.empresa_morada || '',
      nome_completo: func.nome_completo || '',
      nif: func.nif || '',
      morada: func.morada || '',
      cargo: func.cargo || '',
      salario_base: parseFloat(func.salario_base||0).toFixed(2),
      data_inicio: func.data_admissao ? new Date(func.data_admissao).toLocaleDateString('pt-PT') : '',
      horas_semanais: func.horas_semanais || 40,
      data_assinatura: new Date().toLocaleDateString('pt-PT'),
      ...variaveis_extra,
    };

    let conteudo = template.conteudo;
    Object.entries(variaveis).forEach(([k, v]) => {
      conteudo = conteudo.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v);
    });

    res.json({
      template_id: id,
      template_nome: template.nome,
      funcionario: func.nome_completo,
      conteudo,
      variaveis_usadas: variaveis,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Actualizar template ───────────────────────────────────────────────────────
router.put('/:id', autenticar, autorizar(...ADMINS), async (req, res) => {
  try {
    const { nome, conteudo, variaveis, ativo } = req.body;
    const { rows:[t] } = await query(`
      UPDATE template_contrato SET nome=COALESCE($1,nome), conteudo=COALESCE($2,conteudo),
        variaveis=COALESCE($3,variaveis), ativo=COALESCE($4,ativo), actualizado_em=NOW()
      WHERE id=$5 AND empresa_id=$6 RETURNING *
    `, [nome||null, conteudo||null, variaveis?JSON.stringify(variaveis):null, ativo??null, req.params.id, req.empresaId]);
    if (!t) return res.status(404).json({ error: 'Não encontrado' });
    res.json(t);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
