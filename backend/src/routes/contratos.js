'use strict';
const router  = require('express').Router();
const { autenticar, autorizar } = require('../middleware/auth');
const { middlewareAuditoria }   = require('../middleware/auditoria');
const { query } = require('../config/database');
const { criarErro } = require('../middleware/errorHandler');

const ADMIN = ['admin_empresa','admin_plataforma','rh'];
router.use(autenticar, middlewareAuditoria);

// ── CCT ────────────────────────────────────────────────────────────────────

router.get('/cct', async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM cct WHERE empresa_id=$1 AND ativo=true ORDER BY nome',
    [req.empresaId]
  );
  res.json(rows);
});

router.post('/cct', autorizar(...ADMIN), async (req, res) => {
  const { nome, codigo, entidade, data_publicacao, data_vigencia, url_boletim } = req.body;
  if (!nome) throw criarErro('Nome é obrigatório.', 400);
  const { rows } = await query(`
    INSERT INTO cct (empresa_id, nome, codigo, entidade, data_publicacao, data_vigencia, url_boletim)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
  `, [req.empresaId, nome, codigo||null, entidade||null, data_publicacao||null, data_vigencia||null, url_boletim||null]);
  res.status(201).json(rows[0]);
});

// ── CATEGORIAS PROFISSIONAIS ───────────────────────────────────────────────

router.get('/categorias', async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM categoria_profissional WHERE empresa_id=$1 AND ativo=true ORDER BY nivel, nome',
    [req.empresaId]
  );
  res.json(rows);
});

router.post('/categorias', autorizar(...ADMIN), async (req, res) => {
  const { nome, codigo, nivel, salario_minimo, descricao, cct_id } = req.body;
  if (!nome) throw criarErro('Nome é obrigatório.', 400);
  const { rows } = await query(`
    INSERT INTO categoria_profissional (empresa_id, cct_id, nome, codigo, nivel, salario_minimo, descricao)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
  `, [req.empresaId, cct_id||null, nome, codigo||null, nivel||null, salario_minimo||0, descricao||null]);
  res.status(201).json(rows[0]);
});

// ── BANDAS SALARIAIS ──────────────────────────────────────────────────────

router.get('/bandas', async (req, res) => {
  const { rows } = await query(`
    SELECT b.*, n.nome AS nivel_nome, n.nivel AS nivel_num
    FROM banda_salarial b
    LEFT JOIN nivel_hierarquico n ON n.id = b.nivel_hierarquico_id
    WHERE b.empresa_id=$1 AND b.ativo=true
    ORDER BY n.nivel ASC NULLS LAST, b.nome
  `, [req.empresaId]);
  res.json(rows);
});

router.post('/bandas', autorizar(...ADMIN), async (req, res) => {
  const { nome, nivel_hierarquico_id, salario_minimo, salario_medio, salario_maximo } = req.body;
  if (!nome || !salario_minimo || !salario_maximo) throw criarErro('Nome, mínimo e máximo são obrigatórios.', 400);
  const { rows } = await query(`
    INSERT INTO banda_salarial (empresa_id, nivel_hierarquico_id, nome, salario_minimo, salario_medio, salario_maximo)
    VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
  `, [req.empresaId, nivel_hierarquico_id||null, nome, salario_minimo, salario_medio||null, salario_maximo]);
  res.status(201).json(rows[0]);
});

router.put('/bandas/:id', autorizar(...ADMIN), async (req, res) => {
  const { nome, nivel_hierarquico_id, salario_minimo, salario_medio, salario_maximo } = req.body;
  const { rows } = await query(`
    UPDATE banda_salarial SET nome=$1, nivel_hierarquico_id=$2, salario_minimo=$3,
      salario_medio=$4, salario_maximo=$5
    WHERE id=$6 AND empresa_id=$7 RETURNING *
  `, [nome, nivel_hierarquico_id||null, salario_minimo, salario_medio||null, salario_maximo, req.params.id, req.empresaId]);
  if (!rows.length) throw criarErro('Banda não encontrada.', 404);
  res.json(rows[0]);
});

// ── MODELOS DE CONTRATO ───────────────────────────────────────────────────

// Modelos padrão portugueses
const MODELOS_PADRAO = {
  sem_termo: `CONTRATO DE TRABALHO POR TEMPO INDETERMINADO

Entre:
{{EMPRESA_NOME}}, com sede em {{EMPRESA_MORADA}}, NIF {{EMPRESA_NIF}}, doravante designada por ENTIDADE EMPREGADORA;

E:
{{FUNCIONARIO_NOME}}, portador(a) do Cartão de Cidadão n.º {{FUNCIONARIO_CC}}, NIF {{FUNCIONARIO_NIF}}, residente em {{FUNCIONARIO_MORADA}}, doravante designado(a) por TRABALHADOR(A);

É celebrado o presente Contrato de Trabalho por Tempo Indeterminado, que se rege pelas cláusulas seguintes:

CLÁUSULA 1.ª — OBJECTO
O(A) Trabalhador(a) obriga-se a prestar à Entidade Empregadora, sob a autoridade e direcção desta, a sua actividade profissional na categoria de {{CARGO}}, no departamento de {{DEPARTAMENTO}}.

CLÁUSULA 2.ª — LOCAL DE TRABALHO
O trabalho será prestado em {{LOCAL_TRABALHO}}, podendo a Entidade Empregadora determinar, nos termos legais, a prestação de trabalho noutros locais.

CLÁUSULA 3.ª — DURAÇÃO DO TRABALHO
O período normal de trabalho é de {{HORAS_SEMANAIS}} horas semanais, distribuídas de segunda a sexta-feira, das {{HORARIO_ENTRADA}} às {{HORARIO_SAIDA}}, com intervalo para refeição.

CLÁUSULA 4.ª — REMUNERAÇÃO
O(A) Trabalhador(a) aufere uma remuneração base mensal de {{SALARIO_BASE}} €, acrescida de subsídio de alimentação no valor de {{SUBSIDIO_ALIMENTACAO}} € por dia de trabalho efectivo.

CLÁUSULA 5.ª — SUBSÍDIOS
O(A) Trabalhador(a) tem direito a subsídio de férias e subsídio de Natal, correspondentes cada um à retribuição mensal, nos termos do Código do Trabalho.

CLÁUSULA 6.ª — FÉRIAS
O(A) Trabalhador(a) tem direito a {{DIAS_FERIAS}} dias úteis de férias por ano, nos termos do artigo 238.º do Código do Trabalho.

CLÁUSULA 7.ª — INÍCIO
O presente contrato produz efeitos a partir de {{DATA_ADMISSAO}}.

CLÁUSULA 8.ª — LEGISLAÇÃO APLICÁVEL
O presente contrato rege-se pelo Código do Trabalho e legislação complementar em vigor.

Feito em {{LOCAL}}, em {{DATA_HOJE}}, em dois exemplares, ficando um na posse de cada uma das partes.

_________________________________          _________________________________
      A ENTIDADE EMPREGADORA                        O(A) TRABALHADOR(A)
         {{EMPRESA_NOME}}                           {{FUNCIONARIO_NOME}}`,

  termo_certo: `CONTRATO DE TRABALHO A TERMO CERTO

Entre:
{{EMPRESA_NOME}}, com sede em {{EMPRESA_MORADA}}, NIF {{EMPRESA_NIF}}, doravante designada por ENTIDADE EMPREGADORA;

E:
{{FUNCIONARIO_NOME}}, portador(a) do Cartão de Cidadão n.º {{FUNCIONARIO_CC}}, NIF {{FUNCIONARIO_NIF}}, residente em {{FUNCIONARIO_MORADA}}, doravante designado(a) por TRABALHADOR(A);

É celebrado o presente Contrato de Trabalho a Termo Certo, que se rege pelas cláusulas seguintes:

CLÁUSULA 1.ª — OBJECTO E JUSTIFICAÇÃO
O(A) Trabalhador(a) obriga-se a prestar à Entidade Empregadora, sob a autoridade e direcção desta, a sua actividade profissional na categoria de {{CARGO}}.

CLÁUSULA 2.ª — DURAÇÃO
O presente contrato tem início em {{DATA_ADMISSAO}} e término em {{DATA_FIM_CONTRATO}}, sendo celebrado pelo prazo de {{DURACAO_MESES}} meses, podendo ser renovado nos termos legais.

CLÁUSULA 3.ª — LOCAL DE TRABALHO
O trabalho será prestado em {{LOCAL_TRABALHO}}.

CLÁUSULA 4.ª — DURAÇÃO DO TRABALHO
O período normal de trabalho é de {{HORAS_SEMANAIS}} horas semanais.

CLÁUSULA 5.ª — REMUNERAÇÃO
O(A) Trabalhador(a) aufere uma remuneração base mensal de {{SALARIO_BASE}} €, acrescida de subsídio de alimentação no valor de {{SUBSIDIO_ALIMENTACAO}} € por dia de trabalho efectivo.

CLÁUSULA 6.ª — RENOVAÇÃO
O presente contrato caduca na data do seu termo, salvo renovação expressa nos termos do artigo 149.º do Código do Trabalho.

Feito em {{LOCAL}}, em {{DATA_HOJE}}, em dois exemplares.

_________________________________          _________________________________
      A ENTIDADE EMPREGADORA                        O(A) TRABALHADOR(A)
         {{EMPRESA_NOME}}                           {{FUNCIONARIO_NOME}}`,

  estagio_iefp: `PROTOCOLO DE ESTÁGIO PROFISSIONAL IEFP

Entre:
{{EMPRESA_NOME}}, NIF {{EMPRESA_NIF}}, doravante designada por ENTIDADE PROMOTORA;

E:
{{FUNCIONARIO_NOME}}, NIF {{FUNCIONARIO_NIF}}, doravante designado(a) por ESTAGIÁRIO(A);

Com a participação do Instituto do Emprego e Formação Profissional (IEFP), I.P.

É celebrado o presente Protocolo de Estágio Profissional, nos termos do Portaria n.º 60-A/2015, de 2 de Março:

CLÁUSULA 1.ª — OBJECTO
O(A) Estagiário(a) realiza um estágio profissional de nível {{ESTAGIO_NIVEL}} na área de {{CARGO}}, sob orientação de {{ORIENTADOR}}.

CLÁUSULA 2.ª — DURAÇÃO
O estágio tem início em {{DATA_ADMISSAO}} e término previsto em {{DATA_FIM_CONTRATO}}, com duração de 9 meses.

CLÁUSULA 3.ª — BOLSA DE ESTÁGIO
O(A) Estagiário(a) aufere uma bolsa mensal de {{SALARIO_BASE}} €, sendo {{ESTAGIO_COMPARTICIPACAO}}% comparticipada pelo IEFP.

CLÁUSULA 4.ª — ORIENTAÇÃO
O(A) Estagiário(a) será acompanhado(a) por {{ORIENTADOR}}, designado(a) orientador(a) de estágio.

Feito em {{LOCAL}}, em {{DATA_HOJE}}.

_________________________________          _________________________________
      A ENTIDADE PROMOTORA                          O(A) ESTAGIÁRIO(A)
         {{EMPRESA_NOME}}                           {{FUNCIONARIO_NOME}}`
};

router.get('/modelos', async (req, res) => {
  const { rows } = await query(
    'SELECT id, nome, tipo_contrato, ativo, criado_em FROM modelo_contrato WHERE empresa_id=$1 AND ativo=true ORDER BY nome',
    [req.empresaId]
  );
  res.json(rows);
});

router.post('/modelos', autorizar(...ADMIN), async (req, res) => {
  const { nome, tipo_contrato, conteudo } = req.body;
  if (!nome || !tipo_contrato || !conteudo) throw criarErro('Nome, tipo e conteúdo são obrigatórios.', 400);
  const { rows } = await query(`
    INSERT INTO modelo_contrato (empresa_id, nome, tipo_contrato, conteudo)
    VALUES ($1,$2,$3,$4) RETURNING *
  `, [req.empresaId, nome, tipo_contrato, conteudo]);
  res.status(201).json(rows[0]);
});

// Obter modelo padrão
router.get('/modelos/padrao/:tipo', (req, res) => {
  const modelo = MODELOS_PADRAO[req.params.tipo];
  if (!modelo) return res.status(404).json({ error: 'Modelo não encontrado.' });
  res.json({ conteudo: modelo });
});

// ── CONTRATOS GERADOS ─────────────────────────────────────────────────────


// ── Criar contrato ────────────────────────────────────────────────────────────
router.post('/', autorizar(...ADMIN), async (req, res) => {
  try {
    const { funcionario_id, tipo, data_inicio, data_fim, salario_base, horas_semanais, notas } = req.body;
    if (!funcionario_id || !tipo || !data_inicio) {
      return res.status(400).json({ error: 'funcionario_id, tipo e data_inicio são obrigatórios' });
    }
    const { query } = require('../config/database');
    const { rows } = await query(`
      INSERT INTO contrato_trabalho (empresa_id, funcionario_id, tipo_contrato, data_inicio, data_fim, notas)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
    `, [req.empresaId, funcionario_id, tipo||'sem_termo', data_inicio, data_fim||null, notas||null]);
    res.status(201).json(rows[0]);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/', async (req, res) => {
  const { funcionario_id } = req.query;
  let sql = `
    SELECT c.*, f.nome_completo, f.cargo, f.numero_funcionario
    FROM contrato_trabalho c
    JOIN funcionario f ON f.id = c.funcionario_id
    WHERE c.empresa_id = $1
  `;
  const params = [req.empresaId];
  if (funcionario_id) { sql += ' AND c.funcionario_id=$2'; params.push(funcionario_id); }
  sql += ' ORDER BY c.criado_em DESC';
  const { rows } = await query(sql, params);
  res.json(rows);
});

// Gerar contrato para funcionário
router.post('/gerar', autorizar(...ADMIN), async (req, res) => {
  const { funcionario_id, tipo_contrato, modelo_id, notas } = req.body;
  if (!funcionario_id || !tipo_contrato) throw criarErro('Funcionário e tipo de contrato são obrigatórios.', 400);

  // Obter dados do funcionário e empresa
  const { rows: [f] } = await query(`
    SELECT f.*, e.nome AS empresa_nome, e.nif AS empresa_nif, e.morada AS empresa_morada,
           d.nome AS departamento_nome, lt.nome AS local_nome,
           resp.nome_completo AS orientador_nome
    FROM funcionario f
    JOIN empresa e ON e.id = f.empresa_id
    LEFT JOIN departamento d ON d.id = f.departamento_id
    LEFT JOIN local_trabalho lt ON lt.id = f.local_trabalho_id
    LEFT JOIN funcionario resp ON resp.id = f.estagio_orientador_id
    WHERE f.id = $1 AND f.empresa_id = $2
  `, [funcionario_id, req.empresaId]);
  if (!f) throw criarErro('Funcionário não encontrado.', 404);

  // Obter modelo
  let template = MODELOS_PADRAO[tipo_contrato] || MODELOS_PADRAO['sem_termo'];
  if (modelo_id) {
    const { rows: [m] } = await query('SELECT conteudo FROM modelo_contrato WHERE id=$1', [modelo_id]);
    if (m) template = m.conteudo;
  }

  // Substituir variáveis
  const hoje = new Date().toLocaleDateString('pt-PT');
  const durMeses = f.data_fim_contrato
    ? Math.round((new Date(f.data_fim_contrato) - new Date(f.data_admissao)) / (1000*60*60*24*30))
    : null;

  const conteudo = template
    .replace(/{{EMPRESA_NOME}}/g,        f.empresa_nome || '')
    .replace(/{{EMPRESA_NIF}}/g,         f.empresa_nif || '')
    .replace(/{{EMPRESA_MORADA}}/g,      f.empresa_morada || '')
    .replace(/{{FUNCIONARIO_NOME}}/g,    f.nome_completo || '')
    .replace(/{{FUNCIONARIO_NIF}}/g,     f.nif || '')
    .replace(/{{FUNCIONARIO_CC}}/g,      f.num_cc || '')
    .replace(/{{FUNCIONARIO_MORADA}}/g,  f.morada || '')
    .replace(/{{CARGO}}/g,               f.cargo || '')
    .replace(/{{DEPARTAMENTO}}/g,        f.departamento_nome || '')
    .replace(/{{LOCAL_TRABALHO}}/g,      f.local_nome || f.empresa_morada || '')
    .replace(/{{HORAS_SEMANAIS}}/g,      f.horas_semanais || 40)
    .replace(/{{HORARIO_ENTRADA}}/g,     f.horario_entrada || '09:00')
    .replace(/{{HORARIO_SAIDA}}/g,       f.horario_saida || '18:00')
    .replace(/{{SALARIO_BASE}}/g,        parseFloat(f.salario_base||0).toFixed(2).replace('.',','))
    .replace(/{{SUBSIDIO_ALIMENTACAO}}/g,parseFloat(f.subsidio_alimentacao||0).toFixed(2).replace('.',','))
    .replace(/{{DIAS_FERIAS}}/g,         f.dias_ferias_ano || 22)
    .replace(/{{DATA_ADMISSAO}}/g,       f.data_admissao ? new Date(f.data_admissao).toLocaleDateString('pt-PT') : '')
    .replace(/{{DATA_FIM_CONTRATO}}/g,   f.data_fim_contrato ? new Date(f.data_fim_contrato).toLocaleDateString('pt-PT') : '')
    .replace(/{{DURACAO_MESES}}/g,       durMeses || '')
    .replace(/{{ESTAGIO_NIVEL}}/g,       f.estagio_nivel || '')
    .replace(/{{ESTAGIO_COMPARTICIPACAO}}/g, f.estagio_comparticipacao || '')
    .replace(/{{ORIENTADOR}}/g,          f.orientador_nome || '')
    .replace(/{{LOCAL}}/g,               f.empresa_morada || '')
    .replace(/{{DATA_HOJE}}/g,           hoje);

  const { rows: [contrato] } = await query(`
    INSERT INTO contrato_trabalho (empresa_id, funcionario_id, modelo_id, tipo_contrato, data_inicio, data_fim, conteudo_final, notas)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
  `, [req.empresaId, funcionario_id, modelo_id||null, tipo_contrato, f.data_admissao, f.data_fim_contrato||null, conteudo, notas||null]);

  await req.auditar({ acao: 'CONTRATO_GERADO', tabela: 'contrato_trabalho', registoId: contrato.id });
  res.status(201).json({ ...contrato, conteudo_final: conteudo });
});

// Marcar como assinado
router.patch('/:id/assinar', autorizar(...ADMIN), async (req, res) => {
  const { data_assinatura } = req.body;
  const { rows } = await query(`
    UPDATE contrato_trabalho SET assinado=true, data_assinatura=$1
    WHERE id=$2 AND empresa_id=$3 RETURNING *
  `, [data_assinatura || new Date(), req.params.id, req.empresaId]);
  if (!rows.length) throw criarErro('Contrato não encontrado.', 404);
  res.json(rows[0]);
});

// Visualizar contrato em HTML
router.get('/:id/visualizar', async (req, res) => {
  const { rows: [c] } = await query(`
    SELECT c.*, f.nome_completo, e.nome AS empresa_nome
    FROM contrato_trabalho c
    JOIN funcionario f ON f.id = c.funcionario_id
    JOIN empresa e ON e.id = c.empresa_id
    WHERE c.id=$1 AND c.empresa_id=$2
  `, [req.params.id, req.empresaId]);
  if (!c) return res.status(404).json({ error: 'Contrato não encontrado.' });

  const html = `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8">
<title>Contrato — ${c.nome_completo}</title>
<style>
  body { font-family: 'Times New Roman', serif; font-size: 12pt; margin: 40px; color: #111; line-height: 1.6; }
  .header { text-align: center; margin-bottom: 30px; border-bottom: 2px solid #185FA5; padding-bottom: 15px; }
  .header h1 { color: #185FA5; font-size: 14pt; text-transform: uppercase; letter-spacing: 1px; }
  .header p { color: #555; font-size: 10pt; }
  .badge { display: inline-block; background: ${c.assinado ? '#D1FAE5' : '#FEF3C7'}; color: ${c.assinado ? '#065F46' : '#92400E'}; padding: 3px 10px; border-radius: 4px; font-size: 9pt; font-weight: bold; }
  pre { white-space: pre-wrap; font-family: 'Times New Roman', serif; font-size: 12pt; line-height: 1.8; }
  .footer { margin-top: 40px; border-top: 1px solid #ddd; padding-top: 10px; font-size: 9pt; color: #888; text-align: center; }
  @media print { @page { margin: 20mm; } }
</style>
</head>
<body>
<div class="header">
  <h1>${c.empresa_nome}</h1>
  <p>Gerado por NexEdge em ${new Date(c.criado_em).toLocaleDateString('pt-PT')}</p>
  <p><span class="badge">${c.assinado ? '✓ ASSINADO' : '⏳ PENDENTE DE ASSINATURA'}</span></p>
</div>
<pre>${c.conteudo_final}</pre>
<div class="footer">Documento gerado electronicamente pela plataforma NexEdge · Portugal</div>
<script>setTimeout(()=>window.print(),400)</script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// DELETE contratos/:id
router.delete('/:id', autorizar(...ADMIN), async (req, res) => {
  await query('DELETE FROM contrato_trabalho WHERE id=$1 AND empresa_id=$2', [req.params.id, req.empresaId]);
  res.json({ mensagem: 'Contrato eliminado.' });
});

// DELETE modelos/:id
router.delete('/modelos/:id', autorizar(...ADMIN), async (req, res) => {
  await query('UPDATE modelo_contrato SET ativo=false WHERE id=$1 AND empresa_id=$2', [req.params.id, req.empresaId]);
  res.json({ mensagem: 'Modelo desactivado.' });
});

// DELETE bandas/:id
router.delete('/bandas/:id', autorizar(...ADMIN), async (req, res) => {
  await query('UPDATE banda_salarial SET ativo=false WHERE id=$1 AND empresa_id=$2', [req.params.id, req.empresaId]);
  res.json({ mensagem: 'Banda salarial desactivada.' });
});

// DELETE categorias/:id
router.delete('/categorias/:id', autorizar(...ADMIN), async (req, res) => {
  await query('UPDATE categoria_profissional SET ativo=false WHERE id=$1 AND empresa_id=$2', [req.params.id, req.empresaId]);
  res.json({ mensagem: 'Categoria desactivada.' });
});

module.exports = router;
