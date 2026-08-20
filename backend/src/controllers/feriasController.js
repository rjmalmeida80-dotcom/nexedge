'use strict';

const { query, transaction } = require('../config/database');
const { criarErro } = require('../middleware/errorHandler');

/**
 * Calcula número de dias úteis entre duas datas (excluindo feriados)
 */
async function calcularDiasUteis(dataInicio, dataFim, empresaId) {
  const { rows } = await query(`
    SELECT COUNT(*) AS dias_uteis
    FROM generate_series($1::date, $2::date, '1 day'::interval) AS d(dia)
    WHERE EXTRACT(DOW FROM d.dia) NOT IN (0,6)
      AND d.dia::date NOT IN (
        SELECT data FROM feriado
        WHERE ano = EXTRACT(YEAR FROM $1::date)
      )
  `, [dataInicio, dataFim]);
  return parseInt(rows[0].dias_uteis);
}

// GET /api/ferias
async function listar(req, res) {
  const { estado, funcionario_id, ano } = req.query;
  const params = [req.empresaId];
  const conds  = [`f.empresa_id = $1`];
  let p = 2;

  // Funcionário vê apenas as suas próprias
  if (req.utilizador.perfil === 'funcionario' && req.utilizador.funcionario_id) {
    conds.push(`pf.funcionario_id = $${p}`);
    params.push(req.utilizador.funcionario_id); p++;
  } else if (funcionario_id) {
    conds.push(`pf.funcionario_id = $${p}`); params.push(funcionario_id); p++;
  }

  if (estado) { conds.push(`pf.estado = $${p}`); params.push(estado); p++; }
  if (ano)    { conds.push(`EXTRACT(YEAR FROM pf.data_inicio) = $${p}`); params.push(parseInt(ano)); p++; }

  const { rows } = await query(`
    SELECT pf.*, f.nome_completo, f.numero_funcionario, f.cargo,
           d.nome AS departamento,
           u.nome_completo AS aprovado_por_nome
    FROM pedido_ferias pf
    JOIN funcionario f    ON f.id = pf.funcionario_id
    LEFT JOIN departamento d ON d.id = f.departamento_id
    LEFT JOIN utilizador u   ON u.id = pf.aprovado_por
    WHERE ${conds.join(' AND ')}
    ORDER BY pf.criado_em DESC
  `, params);

  res.json(rows);
}

// POST /api/ferias
async function criar(req, res) {
  const { funcionario_id, data_inicio, data_fim, motivo } = req.body;

  const funcId = funcionario_id || req.utilizador.funcionario_id;
  if (!funcId) throw criarErro('Funcionário não identificado.', 400);
  if (!data_inicio || !data_fim) throw criarErro('Datas de início e fim são obrigatórias.', 400);
  if (data_inicio > data_fim) throw criarErro('A data de início não pode ser posterior à data de fim.', 400);

  // Verificar saldo de férias
  const { rows: func } = await query(
    'SELECT dias_ferias_saldo, nome_completo FROM funcionario WHERE id=$1 AND empresa_id=$2',
    [funcId, req.empresaId]
  );
  if (!func.length) throw criarErro('Funcionário não encontrado.', 404);

  const numDias = await calcularDiasUteis(data_inicio, data_fim, req.empresaId);
  if (numDias <= 0) throw criarErro('O período selecionado não contém dias úteis.', 400);
  if (func[0].dias_ferias_saldo < numDias) {
    throw criarErro(`Saldo insuficiente. Disponível: ${func[0].dias_ferias_saldo} dias, pedido: ${numDias} dias.`, 400);
  }

  // Verificar sobreposição com férias já aprovadas
  const { rows: sobreposicao } = await query(`
    SELECT id FROM pedido_ferias
    WHERE funcionario_id=$1 AND estado IN ('pendente','aprovado')
      AND NOT (data_fim < $2 OR data_inicio > $3)
  `, [funcId, data_inicio, data_fim]);
  if (sobreposicao.length) {
    throw criarErro('Já existe um pedido de férias para este período.', 409);
  }

  const { rows } = await query(`
    INSERT INTO pedido_ferias (funcionario_id, data_inicio, data_fim, num_dias, motivo)
    VALUES ($1,$2,$3,$4,$5)
    RETURNING *
  `, [funcId, data_inicio, data_fim, numDias, motivo || null]);

  // Notificar responsável
  await notificarResponsavel(funcId, func[0].nome_completo, numDias, data_inicio, data_fim, req.empresaId);

  await req.auditar({ acao: 'FERIAS_PEDIDO', tabela: 'pedido_ferias', registoId: rows[0].id });
  res.status(201).json({ ...rows[0], num_dias: numDias });
}

// PATCH /api/ferias/:id/aprovar
async function aprovar(req, res) {
  const { comentario } = req.body;

  const { rows: pedido } = await query(
    `SELECT pf.*, f.empresa_id FROM pedido_ferias pf
     JOIN funcionario f ON f.id = pf.funcionario_id
     WHERE pf.id=$1`,
    [req.params.id]
  );
  if (!pedido.length) throw criarErro('Pedido não encontrado.', 404);
  if (pedido[0].empresa_id !== req.empresaId) throw criarErro('Acesso negado.', 403);
  if (pedido[0].estado !== 'pendente') throw criarErro('Este pedido já foi processado.', 409);

  // Verificar sobreposição com colegas do mesmo departamento
  const { rows: sobreposicoes } = await query(`
    SELECT pf2.id, f2.nome_completo, pf2.data_inicio, pf2.data_fim
    FROM pedido_ferias pf2
    JOIN funcionario f2 ON f2.id = pf2.funcionario_id
    WHERE f2.empresa_id = $1
      AND pf2.estado = 'aprovado'
      AND pf2.funcionario_id != $2
      AND f2.departamento_id = (SELECT departamento_id FROM funcionario WHERE id = $2)
      AND pf2.data_inicio <= $4 AND pf2.data_fim >= $3
  `, [req.empresaId, pedido[0].funcionario_id, pedido[0].data_inicio, pedido[0].data_fim]);

  // Avisar de sobreposições mas não bloquear (RH decide)
  const avisoSobreposicao = sobreposicoes.length > 0
    ? `Atenção: ${sobreposicoes.map(s => s.nome_completo).join(', ')} também têm férias aprovadas neste período.`
    : null;

  await transaction(async (client) => {
    await client.query(`
      UPDATE pedido_ferias SET estado='aprovado', aprovado_por=$1,
        data_aprovacao=NOW(), comentario=$2
      WHERE id=$3
    `, [req.utilizador.id, comentario || null, req.params.id]);

    // Deduzir saldo de férias
    await client.query(`
      UPDATE funcionario SET
        dias_ferias_saldo = dias_ferias_saldo - $1,
        dias_ferias_gozados = dias_ferias_gozados + $1
      WHERE id=$2
    `, [pedido[0].num_dias, pedido[0].funcionario_id]);
  });

  await req.auditar({ acao: 'FERIAS_APROVADAS', tabela: 'pedido_ferias', registoId: req.params.id });
  // Notificar colaborador
  const p = pedido[0];
  notificarColaborador(p.funcionario_id, true,
    Math.ceil((new Date(p.data_fim)-new Date(p.data_inicio))/(1000*60*60*24))+1,
    p.data_inicio, p.data_fim, req.empresaId).catch(()=>{});

  res.json({ mensagem: 'Férias aprovadas com sucesso.' });
}

// PATCH /api/ferias/:id/rejeitar
async function rejeitar(req, res) {
  const { comentario } = req.body;
  if (!comentario) throw criarErro('É obrigatório indicar o motivo da rejeição.', 400);

  const { rows } = await query(`
    UPDATE pedido_ferias SET estado='rejeitado', aprovado_por=$1,
      data_aprovacao=NOW(), comentario=$2
    WHERE id=$3 AND estado='pendente'
    RETURNING id
  `, [req.utilizador.id, comentario, req.params.id]);

  if (!rows.length) throw criarErro('Pedido não encontrado ou já processado.', 404);
  await req.auditar({ acao: 'FERIAS_REJEITADAS', tabela: 'pedido_ferias', registoId: req.params.id });
  // Notificar colaborador
  const { rows: pRejRows } = await query('SELECT * FROM pedido_ferias WHERE id=$1', [req.params.id]);
  if (pRejRows.length) {
    const pRej = pRejRows[0];
    notificarColaborador(pRej.funcionario_id, false,
      Math.ceil((new Date(pRej.data_fim)-new Date(pRej.data_inicio))/(1000*60*60*24))+1,
      pRej.data_inicio, pRej.data_fim, req.empresaId).catch(()=>{});
  }
  res.json({ mensagem: 'Pedido de férias rejeitado.' });
}

async function notificarResponsavel(funcId, nomeFuncionario, numDias, dataInicio, dataFim, empresaId) {
  try {
    const { enviarNovoPedidoFerias } = require('../services/emailService');
    const { notificacoes } = require('../services/pushService');

    // Buscar responsáveis e admins da empresa
    const { rows: responsaveis } = await query(`
      SELECT DISTINCT u.id, u.email, u.nome_completo
      FROM utilizador u
      WHERE u.empresa_id=$1
        AND u.perfil IN ('admin_empresa','rh','diretor')
        AND u.ativo=true
    `, [empresaId]);

    const fmtData = d => new Date(d).toLocaleDateString('pt-PT');

    for (const r of responsaveis) {
      // Notificação interna
      await query(`
        INSERT INTO notificacao (utilizador_id, empresa_id, titulo, mensagem, tipo, url_accao)
        VALUES ($1,$2,$3,$4,'ferias','/ferias')
      `, [r.id, empresaId,
          `🏖️ Pedido de férias — ${nomeFuncionario}`,
          `${nomeFuncionario} pediu ${numDias} dias (${fmtData(dataInicio)} a ${fmtData(dataFim)}). Aguarda aprovação.`
      ]).catch(()=>{});

      // Push notification
      await notificacoes.feriasAprovadas({ utilizadorId: r.id, empresaId, nome: nomeFuncionario }).catch(()=>{});

      // Email
      await enviarNovoPedidoFerias({
        email: r.email,
        nomeGestor: r.nome_completo,
        nomeColaborador: nomeFuncionario,
        dataInicio: fmtData(dataInicio),
        dataFim: fmtData(dataFim),
        tipo: 'férias',
      }).catch(()=>{});
    }
  } catch (e) { console.error('notificarResponsavel:', e.message); }
}


async function notificarColaborador(funcId, aprovado, numDias, dataInicio, dataFim, empresaId) {
  try {
    const { enviarRespostaFerias } = require('../services/emailService');
    const { notificacoes } = require('../services/pushService');

    const { rows:[func] } = await query(`
      SELECT f.nome_completo, u.id AS util_id, u.email
      FROM funcionario f
      LEFT JOIN utilizador u ON u.funcionario_id = f.id
      WHERE f.id=$1
    `, [funcId]);

    if (!func) return;

    const fmtData = d => new Date(d).toLocaleDateString('pt-PT');
    const titulo = aprovado
      ? `✅ Férias aprovadas (${fmtData(dataInicio)} a ${fmtData(dataFim)})`
      : `❌ Férias rejeitadas (${fmtData(dataInicio)} a ${fmtData(dataFim)})`;

    // Notificação interna
    if (func.util_id) {
      await query(`
        INSERT INTO notificacao (utilizador_id, empresa_id, titulo, mensagem, tipo, url_accao)
        VALUES ($1,$2,$3,$4,'ferias','/ferias')
      `, [func.util_id, empresaId, titulo,
          aprovado ? `As tuas férias de ${numDias} dias foram aprovadas!` : `O teu pedido de férias foi rejeitado.`
      ]).catch(()=>{});
    }

    // Email
    if (func.email) {
      await enviarRespostaFerias({
        email: func.email,
        nome: func.nome_completo,
        estado: aprovado ? 'aprovado' : 'rejeitado',
        dataInicio: fmtData(dataInicio),
        dataFim: fmtData(dataFim),
        tipo: 'férias',
        motivo: '',
      }).catch(()=>{});
    }
  } catch(e) { console.error('notificarColaborador:', e.message); }
}

module.exports = { listar, criar, aprovar, rejeitar };
