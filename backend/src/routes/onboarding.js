'use strict';
const router = require('express').Router();
const { autenticar, autorizar } = require('../middleware/auth');
const { query } = require('../config/database');
const { criarErro } = require('../middleware/errorHandler');

const ADMIN = ['admin_empresa', 'admin_plataforma', 'rh', 'diretor'];
router.use(autenticar);

// GET /onboarding/templates
router.get('/templates', async (req, res) => {
  const { tipo } = req.query;
  let { rows } = await query(`
    SELECT t.*, COUNT(tt.id) AS total_tarefas
    FROM onboarding_template t
    LEFT JOIN onboarding_template_tarefa tt ON tt.template_id = t.id
    WHERE t.empresa_id=$1 AND t.ativo=true ${tipo ? 'AND t.tipo=$2' : ''}
    GROUP BY t.id ORDER BY t.tipo, t.nome
  `, tipo ? [req.empresaId, tipo] : [req.empresaId]);

  // Auto-create default templates if none exist
  if (!rows.length) {
    const tarefasOn = [
      ['Preparar posto de trabalho','Garantir PC, monitor, cadeira e material de escritório','rh','equipamentos',-3,true,1],
      ['Configurar email e acessos','Criar email, acessos aos sistemas, VPN e badges','ti','acessos',-1,true,2],
      ['Preparar crachá e cartão de acesso','Emitir identificação e cartão de entrada','rh','equipamentos',-1,true,3],
      ['Receber documentos de admissão','Contrato, declaração IRS, ficha de dados pessoais','rh','documentos',0,true,4],
      ['Tour às instalações','Apresentar instalações, saídas de emergência e regras','rh','apresentacao',0,true,5],
      ['Apresentação à equipa','Apresentar ao gestor e colegas do departamento','gestor','apresentacao',0,true,6],
      ['Formação de segurança e RGPD','Regras internas, segurança no trabalho e proteção de dados','rh','formacao',3,true,7],
      ['Reunião com gestor directo','Definir objectivos do período experimental','gestor','formacao',5,true,8],
      ['Check-in ao fim da 1ª semana','Verificar dúvidas e dificuldades do novo colaborador','rh','apresentacao',7,false,9],
      ['Avaliação dos 30 dias','Primeira avaliação formal do período experimental','gestor','formacao',30,true,10],
    ];
    const tarefasOff = [
      ['Entrevista de saída','Perceber motivos da saída e recolher feedback','rh','apresentacao',0,false,1],
      ['Revogar acessos aos sistemas','Desactivar email, sistemas internos, VPN e plataformas','ti','acessos',0,true,2],
      ['Devolução do PC e periféricos','Verificar estado e registar devolução','ti','equipamentos',0,true,3],
      ['Devolução de telemóvel','Verificar estado e registar devolução','rh','equipamentos',0,false,4],
      ['Devolução de chaves e cartões','Recolher chaves e cartões de acesso ao edifício','rh','equipamentos',0,true,5],
      ['Liquidação final do salário','Calcular proporcionais, férias não gozadas e subsídios','rh','documentos',0,true,6],
      ['Emitir certificado de trabalho','Preparar declaração de funções e período de trabalho','rh','documentos',0,true,7],
      ['Comunicar cessação à Segurança Social','Registar data de cessação no portal SS','rh','documentos',0,true,8],
      ['Arquivar processo do colaborador','Guardar documentação (mínimo 5 anos por lei)','rh','documentos',5,true,9],
      ['Confirmar devolução de todos os activos','Verificar checklist completo de equipamentos','rh','equipamentos',0,true,10],
    ];

    for (const [tipoT, nome, descT, tarefas] of [
      ['onboarding','Onboarding Padrão','Integração de novos colaboradores',tarefasOn],
      ['offboarding','Offboarding Padrão','Processo de saída de colaboradores',tarefasOff],
    ]) {
      if (tipo && tipo !== tipoT) continue;
      const { rows:[t] } = await query(
        'INSERT INTO onboarding_template (empresa_id,tipo,nome,descricao) VALUES ($1,$2,$3,$4) RETURNING id',
        [req.empresaId, tipoT, nome, descT]
      );
      for (const [titulo,desc,resp,cat,prazo,obrig,ordem] of tarefas) {
        await query(
          'INSERT INTO onboarding_template_tarefa (template_id,titulo,descricao,responsavel,categoria,prazo_dias,obrigatorio,ordem) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [t.id, titulo, desc, resp, cat, prazo, obrig, ordem]
        );
      }
    }

    // Re-fetch after creation
    const result = await query(`
      SELECT t.*, COUNT(tt.id) AS total_tarefas
      FROM onboarding_template t
      LEFT JOIN onboarding_template_tarefa tt ON tt.template_id = t.id
      WHERE t.empresa_id=$1 AND t.ativo=true ${tipo ? 'AND t.tipo=$2' : ''}
      GROUP BY t.id ORDER BY t.tipo, t.nome
    `, tipo ? [req.empresaId, tipo] : [req.empresaId]);
    rows = result.rows;
  }

  res.json(rows);
});

// GET /onboarding/templates/:id/tarefas
router.get('/templates/:id/tarefas', async (req, res) => {
  const { rows } = await query(`
    SELECT * FROM onboarding_template_tarefa
    WHERE template_id=$1 ORDER BY ordem, prazo_dias
  `, [req.params.id]);
  res.json(rows);
});

// GET /onboarding/processos
router.get('/processos', async (req, res) => {
  const { tipo, estado } = req.query;
  let where = 'p.empresa_id=$1';
  const params = [req.empresaId];
  let i = 2;
  if (tipo) { where += ` AND p.tipo=$${i++}`; params.push(tipo); }
  if (estado) { where += ` AND p.estado=$${i++}`; params.push(estado); }

  const { rows } = await query(`
    SELECT p.*,
      f.nome_completo, f.cargo, f.foto_url,
      d.nome AS departamento,
      COUNT(t.id) AS total_tarefas,
      COUNT(CASE WHEN t.concluida THEN 1 END) AS tarefas_concluidas
    FROM onboarding_processo p
    JOIN funcionario f ON f.id = p.funcionario_id
    LEFT JOIN departamento d ON d.id = f.departamento_id
    LEFT JOIN onboarding_tarefa t ON t.processo_id = p.id
    WHERE ${where}
    GROUP BY p.id, f.nome_completo, f.cargo, f.foto_url, d.nome
    ORDER BY p.criado_em DESC
  `, params);
  res.json(rows);
});

// GET /onboarding/processos/:id
router.get('/processos/:id', async (req, res) => {
  const { rows: [proc] } = await query(`
    SELECT p.*, f.nome_completo, f.cargo, f.foto_url, f.data_admissao, d.nome AS departamento
    FROM onboarding_processo p
    JOIN funcionario f ON f.id = p.funcionario_id
    LEFT JOIN departamento d ON d.id = f.departamento_id
    WHERE p.id=$1 AND p.empresa_id=$2
  `, [req.params.id, req.empresaId]);
  if (!proc) throw criarErro('Processo não encontrado.', 404);

  const { rows: tarefas } = await query(`
    SELECT t.*, e.nome AS equipamento_nome, e.tipo AS equipamento_tipo
    FROM onboarding_tarefa t
    LEFT JOIN equipamento e ON e.id = t.equipamento_id
    WHERE t.processo_id=$1 ORDER BY t.ordem, t.prazo_data
  `, [req.params.id]);

  res.json({ ...proc, tarefas });
});

// POST /onboarding/processos — iniciar processo
router.post('/processos', autorizar(...ADMIN), async (req, res) => {
  const { funcionario_id, tipo, template_id, motivo_saida, notas } = req.body;
  if (!funcionario_id || !tipo) throw criarErro('Funcionário e tipo são obrigatórios.', 400);

  // Get funcionario admission date
  const { rows: [func] } = await query('SELECT data_admissao FROM funcionario WHERE id=$1', [funcionario_id]);
  const dataInicio = func?.data_admissao || new Date().toISOString().split('T')[0];

  const { rows: [proc] } = await query(`
    INSERT INTO onboarding_processo (empresa_id, funcionario_id, tipo, estado, data_inicio, motivo_saida, notas, criado_por)
    VALUES ($1,$2,$3,'em_curso',$4,$5,$6,$7) RETURNING *
  `, [req.empresaId, funcionario_id, tipo, dataInicio, motivo_saida||null, notas||null, req.utilizador.id]);

  // Copy tasks from template if provided
  if (template_id) {
    const { rows: tarefasTemplate } = await query(
      'SELECT * FROM onboarding_template_tarefa WHERE template_id=$1 ORDER BY ordem',
      [template_id]
    );
    for (const t of tarefasTemplate) {
      const prazoData = new Date(dataInicio);
      prazoData.setDate(prazoData.getDate() + (t.prazo_dias || 0));
      await query(`
        INSERT INTO onboarding_tarefa (processo_id, titulo, descricao, responsavel, categoria, prazo_data, obrigatorio, ordem)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      `, [proc.id, t.titulo, t.descricao, t.responsavel, t.categoria,
          prazoData.toISOString().split('T')[0], t.obrigatorio, t.ordem]);
    }
  }

  res.status(201).json(proc);
});

// PUT /onboarding/tarefas/:id/concluir
router.put('/tarefas/:id/concluir', async (req, res) => {
  const { rows } = await query(`
    UPDATE onboarding_tarefa SET concluida=true, concluida_em=NOW(), concluida_por=$1
    WHERE id=$2 RETURNING *
  `, [req.utilizador.id, req.params.id]);
  if (!rows.length) throw criarErro('Tarefa não encontrada.', 404);

  // Check if all mandatory tasks done — update processo state
  const { rows: [tarefa] } = await query('SELECT processo_id FROM onboarding_tarefa WHERE id=$1', [req.params.id]);
  const { rows: pendentes } = await query(
    'SELECT COUNT(*) FROM onboarding_tarefa WHERE processo_id=$1 AND obrigatorio=true AND concluida=false',
    [tarefa.processo_id]
  );
  if (pendentes[0].count === '0') {
    await query(
      "UPDATE onboarding_processo SET estado='concluido', data_conclusao=NOW() WHERE id=$1",
      [tarefa.processo_id]
    );
  }

  res.json(rows[0]);
});

// PUT /onboarding/tarefas/:id/reabrir
router.put('/tarefas/:id/reabrir', autorizar(...ADMIN), async (req, res) => {
  const { rows } = await query(`
    UPDATE onboarding_tarefa SET concluida=false, concluida_em=NULL, concluida_por=NULL
    WHERE id=$1 RETURNING *
  `, [req.params.id]);
  res.json(rows[0]);
});

// POST /onboarding/tarefas — adicionar tarefa manual ao processo
router.post('/tarefas', autorizar(...ADMIN), async (req, res) => {
  const { processo_id, titulo, descricao, responsavel, categoria, prazo_data, obrigatorio } = req.body;
  if (!processo_id || !titulo) throw criarErro('Processo e título são obrigatórios.', 400);
  const { rows } = await query(`
    INSERT INTO onboarding_tarefa (processo_id, titulo, descricao, responsavel, categoria, prazo_data, obrigatorio)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
  `, [processo_id, titulo, descricao||null, responsavel||'rh', categoria||'geral', prazo_data||null, obrigatorio !== false]);
  res.status(201).json(rows[0]);
});

// GET /onboarding/funcionario/:id — processos de um funcionário
router.get('/funcionario/:id', async (req, res) => {
  const { rows } = await query(`
    SELECT p.*,
      COUNT(t.id) AS total_tarefas,
      COUNT(CASE WHEN t.concluida THEN 1 END) AS tarefas_concluidas
    FROM onboarding_processo p
    LEFT JOIN onboarding_tarefa t ON t.processo_id = p.id
    WHERE p.funcionario_id=$1 AND p.empresa_id=$2
    GROUP BY p.id ORDER BY p.criado_em DESC
  `, [req.params.id, req.empresaId]);
  res.json(rows);
});

module.exports = router;
