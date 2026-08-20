'use strict';

const { query, transaction } = require('../config/database');
const { criarErro } = require('../middleware/errorHandler');

// GET /api/funcionarios
async function listar(req, res) {
  const {
    pagina = 1, por_pagina = 20,
    busca, departamento_id, estado, tipo_contrato, ordenar = 'nome_completo'
  } = req.query;

  const offset = (parseInt(pagina) - 1) * parseInt(por_pagina);
  const params = [req.empresaId];
  const condicoes = ['f.empresa_id = $1'];
  let p = 2;

  if (busca) {
    condicoes.push(`(f.nome_completo ILIKE $${p} OR f.email_empresa ILIKE $${p} OR f.numero_funcionario ILIKE $${p} OR f.cargo ILIKE $${p})`);
    params.push(`%${busca}%`); p++;
  }
  if (departamento_id) { condicoes.push(`f.departamento_id = $${p}`); params.push(departamento_id); p++; }
  if (estado)          { condicoes.push(`f.estado = $${p}`);          params.push(estado); p++; }
  if (tipo_contrato)   { condicoes.push(`f.tipo_contrato = $${p}`);   params.push(tipo_contrato); p++; }

  const where = condicoes.join(' AND ');
  const colunasOrdenar = {
    nome_completo: 'f.nome_completo', cargo: 'f.cargo',
    data_admissao: 'f.data_admissao', salario_base: 'f.salario_base'
  };
  const col = colunasOrdenar[ordenar] || 'f.nome_completo';

  const { rows: total } = await query(
    `SELECT COUNT(*) FROM funcionario f WHERE ${where}`, params
  );

  params.push(parseInt(por_pagina), offset);
  const { rows } = await query(`
    SELECT DISTINCT ON (f.id) f.id, f.numero_funcionario, f.nome_completo, f.cargo, f.email_empresa,
           f.telefone, f.telemovel, f.data_admissao, f.estado, f.tipo_contrato,
           f.salario_base, f.foto_url, f.horas_semanais, f.tipo_turno,
           f.dias_ferias_saldo, f.utilizador_id,
           d.nome AS departamento, lt.nome AS local_trabalho
    FROM funcionario f
    LEFT JOIN departamento d  ON d.id = f.departamento_id
    LEFT JOIN local_trabalho lt ON lt.id = f.local_trabalho_id
    WHERE ${where}
    ORDER BY f.id, ${col} ASC
    LIMIT $${p} OFFSET $${p+1}
  `, params);

  res.json({
    funcionarios: rows,
    dados: rows,
    paginacao: {
      total: parseInt(total[0].count),
      pagina: parseInt(pagina),
      por_pagina: parseInt(por_pagina),
      total_paginas: Math.ceil(total[0].count / por_pagina)
    }
  });
}

// GET /api/funcionarios/:id
async function obter(req, res) {
  const { rows } = await query(`
    SELECT f.*,
           d.nome AS departamento_nome,
           lt.nome AS local_trabalho_nome,
           u.email AS email_utilizador, u.perfil, u.ultimo_login,
           resp.nome_completo AS responsavel_nome
    FROM funcionario f
    LEFT JOIN departamento d     ON d.id = f.departamento_id
    LEFT JOIN local_trabalho lt  ON lt.id = f.local_trabalho_id
    LEFT JOIN utilizador u       ON u.id = f.utilizador_id
    LEFT JOIN funcionario resp   ON resp.id = f.responsavel_id
    WHERE f.id = $1 AND f.empresa_id = $2
  `, [req.params.id, req.empresaId]);

  if (!rows.length) throw criarErro('Funcionário não encontrado.', 404);
  res.json(rows[0]);
}

// POST /api/funcionarios
async function criar(req, res) {
  const d = req.body;
  if (!d.nome_completo || !d.cargo || !d.data_admissao) {
    throw criarErro('Nome, cargo e data de admissão são obrigatórios.', 400);
  }

  // Gerar número de funcionário automático
  const { rows: ultimo } = await query(
    `SELECT numero_funcionario FROM funcionario
     WHERE empresa_id=$1 AND numero_funcionario ~ '^[0-9]+$'
     ORDER BY numero_funcionario::int DESC LIMIT 1`,
    [req.empresaId]
  );
  const proximoNum = ultimo.length ? String(parseInt(ultimo[0].numero_funcionario) + 1).padStart(4, '0') : '0001';

  const resultado = await transaction(async (client) => {
    const diasFerias = d.dias_ferias_ano || 22;
    const { rows } = await client.query(`
      INSERT INTO funcionario (
        empresa_id, departamento_id, local_trabalho_id, responsavel_id,
        area_negocio_id, centro_custo_id, nivel_hierarquico_id, responsavel_direto_id,
        numero_funcionario, nome_completo, data_nascimento, genero, nif, niss,
        num_cc, nacionalidade, email_pessoal, email_empresa, telefone, telemovel,
        morada, codigo_postal, localidade, cargo, tipo_contrato,
        data_admissao, data_fim_contrato, estado,
        salario_base, subsidio_alimentacao, iban, banco,
        horas_semanais, dias_ferias_ano, dias_ferias_saldo,
        estado_civil, num_dependentes, deficiencia, deficiencia_dependente,
        irs_jovem, irs_jovem_ano, tipo_subsidio_alimentacao,
        regime_trabalho, dias_presenca_semana, turno, horario_entrada, horario_saida,
        isencao_horario, subsidio_turno, subsidio_risco, subsidio_chefia, diuturnidades,
        comissoes_fixas, abono_falhas, dias_teletrabalho_mes, kms_viatura_propria,
        ajudas_custo_nacionais_dias, ajudas_custo_inter_dias,
        seguro_saude_empresa, seguro_saude_funcionario, seguro_saude_seguradora, seguro_saude_apolice,
        seguro_saude_agregado, seguro_saude_num_agregado, seguro_saude_desconto_agregado,
        vale_educacao, vale_infancia, telemovel_empresa, formacao_horas_ano,
        estagio_iefp, estagio_nivel, estagio_orientador_id, estagio_comparticipacao,
        ett, ett_empresa, ett_data_fim,
        foto_url, notas
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
        $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
        $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,
        $31,$32,$33,$34,$35,$36,$37,$38,$39,$40,
        $41,$42,$43,$44,$45,$46,$47,$48,$49,$50,
        $51,$52,$53,$54,$55,$56,$57,$58,$59,$60,
        $61,$62,$63,$64,$65,$66,$67,$68,$69,$70,
        $71,$72,$73,$74,$75,$76,$77,$78
      ) RETURNING *
    `, [
      req.empresaId,                                    // $1
      d.departamento_id || null,                        // $2
      d.local_trabalho_id || null,                      // $3
      d.responsavel_id || null,                         // $4
      d.area_negocio_id || null,                        // $5
      d.centro_custo_id || null,                        // $6
      d.nivel_hierarquico_id || null,                   // $7
      d.responsavel_direto_id || null,                  // $8
      proximoNum,                                        // $9
      d.nome_completo,                                  // $10
      d.data_nascimento || null,                        // $11
      d.genero || null,                                 // $12
      d.nif || null,                                    // $13
      d.niss || null,                                   // $14
      d.num_cc || null,                                 // $15
      d.nacionalidade || 'PT',                          // $16
      d.email_pessoal || null,                          // $17
      d.email_empresa || null,                          // $18
      d.telefone || null,                               // $19
      d.telemovel || null,                              // $20
      d.morada || null,                                 // $21
      d.codigo_postal || null,                          // $22
      d.localidade || null,                             // $23
      d.cargo,                                          // $24
      d.tipo_contrato || 'sem_termo',                   // $25
      d.data_admissao,                                  // $26
      d.data_fim_contrato || null,                      // $27
      d.estado || 'ativo',                              // $28
      parseFloat(d.salario_base) || 870,                // $29
      parseFloat(d.subsidio_alimentacao) || 0,          // $30
      d.iban || null,                                   // $31
      d.banco || null,                                  // $32
      parseInt(d.horas_semanais) || 40,                 // $33
      diasFerias,                                        // $34
      diasFerias,                                        // $35 saldo
      d.estado_civil || 'nao_casado',                   // $36
      parseInt(d.num_dependentes) || 0,                 // $37
      d.deficiencia === true || d.deficiencia === 'true', // $38
      d.deficiencia_dependente === true || d.deficiencia_dependente === 'true', // $39
      d.irs_jovem === true || d.irs_jovem === 'true',   // $40
      parseInt(d.irs_jovem_ano) || 1,                   // $41
      d.tipo_subsidio_alimentacao || 'dinheiro',        // $42
      d.regime_trabalho || 'presencial',                // $43
      parseInt(d.dias_presenca_semana) || 5,            // $44
      d.turno || 'fixo',                                // $45
      d.horario_entrada || '09:00',                     // $46
      d.horario_saida || '18:00',                       // $47
      parseFloat(d.isencao_horario) || 0,               // $48
      parseFloat(d.subsidio_turno) || 0,                // $49
      parseFloat(d.subsidio_risco) || 0,                // $50
      parseFloat(d.subsidio_chefia) || 0,               // $51
      parseFloat(d.diuturnidades) || 0,                 // $52
      parseFloat(d.comissoes_fixas) || 0,               // $53
      parseFloat(d.abono_falhas) || 0,                  // $54
      parseInt(d.dias_teletrabalho_mes) || 0,           // $55
      parseFloat(d.kms_viatura_propria) || 0,           // $56
      parseFloat(d.ajudas_custo_nacionais_dias) || 0,   // $57
      parseFloat(d.ajudas_custo_inter_dias) || 0,       // $58
      parseFloat(d.seguro_saude_empresa) || 0,          // $59
      parseFloat(d.seguro_saude_funcionario) || 0,      // $60
      d.seguro_saude_seguradora || null,                // $61
      d.seguro_saude_apolice || null,                   // $62
      d.seguro_saude_agregado === true || d.seguro_saude_agregado === 'true', // $63
      parseInt(d.seguro_saude_num_agregado) || 0,       // $64
      parseFloat(d.seguro_saude_desconto_agregado) || 0,// $65
      parseFloat(d.vale_educacao) || 0,                 // $66
      parseFloat(d.vale_infancia) || 0,                 // $67
      parseFloat(d.telemovel_empresa) || 0,             // $68
      parseInt(d.formacao_horas_ano) || 40,             // $69
      d.estagio_iefp === true || d.estagio_iefp === 'true', // $70
      d.estagio_nivel || null,                          // $71
      d.estagio_orientador_id || null,                  // $72
      parseFloat(d.estagio_comparticipacao) || 0,       // $73
      d.ett === true || d.ett === 'true',               // $74
      d.ett_empresa || null,                            // $75
      d.ett_data_fim || null,                           // $76
      d.foto_url || null,                               // $77
      d.notas || null,                                  // $78
    ]);
    return rows[0];
  });

  await req.auditar({ acao: 'FUNCIONARIO_CRIADO', tabela: 'funcionario', registoId: resultado.id, dadosDepois: { nome: resultado.nome_completo } });

  // Criar utilizador automaticamente se tiver email de empresa
  let passwordTemporaria = null;
  if (resultado.email_empresa) {
    try {
      const bcrypt = require('bcryptjs');
      // Gerar password: primeiras 4 letras do nome + 4 digitos aleatórios + !
      const primeiroNome = resultado.nome_completo.split(' ')[0].toLowerCase().slice(0, 4);
      const digitos = Math.floor(1000 + Math.random() * 9000);
      passwordTemporaria = `${primeiroNome}${digitos}!`;
      const hash = await bcrypt.hash(passwordTemporaria, 12);

      const { rows: existente } = await query(
        'SELECT id FROM utilizador WHERE email=$1',
        [resultado.email_empresa.toLowerCase()]
      );

      if (existente.length === 0) {
        const { rows: [novoUser] } = await query(`
          INSERT INTO utilizador (empresa_id, nome_completo, email, password_hash, perfil, mudar_password)
          VALUES ($1,$2,$3,$4,'funcionario',true) RETURNING id
        `, [req.empresaId, resultado.nome_completo, resultado.email_empresa.toLowerCase(), hash]);

        await query('UPDATE funcionario SET utilizador_id=$1 WHERE id=$2', [novoUser.id, resultado.id]);
        resultado.utilizador_id = novoUser.id;
      } else {
        // Ligar utilizador existente
        await query('UPDATE funcionario SET utilizador_id=$1 WHERE id=$2', [existente[0].id, resultado.id]);
        resultado.utilizador_id = existente[0].id;
        passwordTemporaria = null; // já tem conta
      }
    } catch(e) {
      console.error('Erro ao criar utilizador automático:', e.message);
    }
  }

  res.status(201).json({ ...resultado, password_temporaria: passwordTemporaria });
}

// PUT /api/funcionarios/:id
async function atualizar(req, res) {
  const { rows: antes } = await query(
    'SELECT * FROM funcionario WHERE id=$1 AND empresa_id=$2',
    [req.params.id, req.empresaId]
  );
  if (!antes.length) throw criarErro('Funcionário não encontrado.', 404);

  const d = req.body;
  // Merge com dados existentes para suportar PUT parcial
  const atual = antes[0];
  const merged = { ...atual, ...d };
  const { rows } = await query(`
    UPDATE funcionario SET
      departamento_id=$1, local_trabalho_id=$2, responsavel_id=$3,
      nome_completo=$4, data_nascimento=$5, genero=$6, nif=$7, niss=$8,
      num_cc=$9, nacionalidade=$10, email_pessoal=$11, email_empresa=$12,
      telefone=$13, telemovel=$14, morada=$15, codigo_postal=$16, localidade=$17,
      cargo=$18, categoria=$19, nivel=$20, tipo_contrato=$21,
      data_admissao=$22, data_fim_contrato=$23, estado=$24,
      salario_base=$25, subsidio_alimentacao=$26, iban=$27, banco=$28,
      tipo_turno=$29, horas_semanais=$30, dias_ferias_ano=$31,
      foto_url=$32, notas=$33,
      cpp_codigo=$34, cpp_descricao=$35, nivel_qualificacao=$36,
      nivel_escolaridade=$37, codigo_irct=$38, motivo_saida_codigo=$39,
      remuneracao_base_inicial=$40,
      regime_horario=$41, trabalha_feriados=$42, trabalha_fim_semana=$43,
      dias_trabalho_semana=$44,
      horario_entrada=$45, horario_saida=$46,
      atualizado_em=NOW()
    WHERE id=$47 AND empresa_id=$48
    RETURNING *
  `, [
    merged.departamento_id || null, merged.local_trabalho_id || null, merged.responsavel_id || null,
    merged.nome_completo, merged.data_nascimento || null, merged.genero || null,
    merged.nif || null, merged.niss || null, merged.num_cc || null, merged.nacionalidade || 'PT',
    merged.email_pessoal || null, merged.email_empresa || null,
    merged.telefone || null, merged.telemovel || null,
    merged.morada || null, merged.codigo_postal || null, merged.localidade || null,
    merged.cargo, merged.categoria || null, merged.nivel || null, merged.tipo_contrato || 'sem_termo',
    merged.data_admissao, merged.data_fim_contrato || null, merged.estado || 'ativo',
    merged.salario_base || 0, merged.subsidio_alimentacao || 0, merged.iban || null, merged.banco || null,
    merged.tipo_turno || 'fixo', merged.horas_semanais || 40, merged.dias_ferias_ano || 22,
    merged.foto_url || null, merged.notas || null,
    merged.cpp_codigo || null, merged.cpp_descricao || null, merged.nivel_qualificacao || null,
    merged.nivel_escolaridade || null, merged.codigo_irct || null, merged.motivo_saida_codigo || null,
    merged.remuneracao_base_inicial || null,
    merged.regime_horario || 'seg_sex',
    merged.trabalha_feriados === true || merged.trabalha_feriados === 'true',
    merged.trabalha_fim_semana === true || merged.trabalha_fim_semana === 'true',
    merged.dias_trabalho_semana || '1,2,3,4,5',
    merged.horario_entrada || '09:00',
    merged.horario_saida || '18:00',
    req.params.id, req.empresaId,
  ]);

  await req.auditar({ acao: 'FUNCIONARIO_ATUALIZADO', tabela: 'funcionario', registoId: req.params.id, dadosAntes: antes[0], dadosDepois: rows[0] });
  res.json(rows[0]);
}

// DELETE /api/funcionarios/:id  (desativa, não elimina)
async function desativar(req, res) {
  const { rows } = await query(
    `UPDATE funcionario SET estado='inativo', atualizado_em=NOW()
     WHERE id=$1 AND empresa_id=$2 RETURNING id, nome_completo`,
    [req.params.id, req.empresaId]
  );
  if (!rows.length) throw criarErro('Funcionário não encontrado.', 404);
  await req.auditar({ acao: 'FUNCIONARIO_DESATIVADO', tabela: 'funcionario', registoId: req.params.id });
  res.json({ mensagem: `Funcionário ${rows[0].nome_completo} desativado.` });
}

// DELETE /api/funcionarios/:id/apagar — apagar definitivamente
async function apagar(req, res) {
  // Verificar se tem recibos processados
  const { rows: recibos } = await query(
    'SELECT COUNT(*) AS total FROM recibo_vencimento WHERE funcionario_id=$1',
    [req.params.id]
  );
  
  const { rows: func } = await query(
    'SELECT nome_completo FROM funcionario WHERE id=$1 AND empresa_id=$2',
    [req.params.id, req.empresaId]
  );
  if (!func.length) throw criarErro('Funcionário não encontrado.', 404);

  // Se tiver recibos, não apagar — apenas desativar
  if (parseInt(recibos[0].total) > 0) {
    throw criarErro(
      `Não é possível apagar ${func[0].nome_completo} porque tem ${recibos[0].total} recibo(s) processado(s). Use "Desativar" em vez de apagar.`,
      409
    );
  }

  await req.auditar({ acao: 'FUNCIONARIO_ELIMINADO', tabela: 'funcionario', registoId: req.params.id, dados_antes: func[0] });
  await query('DELETE FROM funcionario WHERE id=$1 AND empresa_id=$2', [req.params.id, req.empresaId]);
  res.json({ mensagem: `Funcionário ${func[0].nome_completo} eliminado permanentemente.` });
}

// GET /api/funcionarios/:id/historico
async function historico(req, res) {
  const { rows } = await query(`
    SELECT l.acao, l.dados_antes, l.dados_depois, l.criado_em,
           u.nome_completo AS feito_por
    FROM log_auditoria l
    LEFT JOIN utilizador u ON u.id = l.utilizador_id
    WHERE l.tabela = 'funcionario' AND l.registo_id = $1
    ORDER BY l.criado_em DESC
    LIMIT 50
  `, [req.params.id]);
  res.json(rows);
}

module.exports = { listar, obter, criar, atualizar, desativar, apagar, historico };
