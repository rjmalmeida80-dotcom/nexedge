'use strict';
const router = require('express').Router();
const { autenticar, autorizar } = require('../middleware/auth');
const { query } = require('../config/database');
const ExcelJS = require('exceljs');

const RH = ['admin_empresa', 'rh', 'diretor'];
router.use(autenticar, autorizar(...RH));

// ── Diagnóstico — testar se colunas existem ──────────────────────────────────
router.get('/diagnostico', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'funcionario'
        AND column_name IN ('cpp_codigo','nivel_qualificacao','nivel_escolaridade','codigo_irct','remuneracao_base_inicial','motivo_saida_codigo')
      ORDER BY column_name
    `);
    const { rows: medRows } = await query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'medicina_trabalho'
        AND column_name IN ('tecnico_sst_num_act','medico_cedula','nif_entidade_externa')
    `);
    res.json({
      colunas_funcionario: rows.map(r => r.column_name),
      colunas_medicina: medRows.map(r => r.column_name),
      ok: rows.length >= 5 && medRows.length >= 3
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});



// ── Helpers ──────────────────────────────────────────────────────────────────
function fmtData(d) { return d ? new Date(d).toLocaleDateString('pt-PT') : ''; }
function fmtNum(n)  { return n ? parseFloat(n).toFixed(2) : '0.00'; }

function estiloHeader(ws, linha, numCols, titulo, corFundo = 'FF1E3A5F') {
  ws.mergeCells(`A${linha}:${String.fromCharCode(64 + numCols)}${linha}`);
  const c = ws.getCell(`A${linha}`);
  c.value = titulo;
  c.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
  c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: corFundo } };
  c.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(linha).height = 28;
}

function estiloColunas(ws, linha, colunas) {
  const row = ws.getRow(linha);
  row.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2B5EA7' } };
  row.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  row.height = 34;
  colunas.forEach((col, i) => { row.getCell(i + 1).value = col.header; });
}

function listraLinhas(ws, rowRef, idx, temCampoFalta) {
  if (temCampoFalta) {
    rowRef.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
  } else if (idx % 2 === 0) {
    rowRef.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F8FF' } };
  }
}

// ── Validação ────────────────────────────────────────────────────────────────
router.get('/validar/:ano', async (req, res) => {
  const { ano } = req.params;
  const eid = req.empresaId;

  const { rows: funcs } = await query(`
    SELECT id, nome_completo, cargo, numero_funcionario,
      cpp_codigo, nivel_qualificacao, nivel_escolaridade,
      data_admissao, data_fim_contrato, estado
    FROM funcionario
    WHERE empresa_id = $1
      AND (estado = 'ativo'
        OR (data_fim_contrato >= $2::date AND data_fim_contrato < $3::date))
    ORDER BY nome_completo
  `, [eid, `${ano}-01-01`, `${parseInt(ano)+1}-01-01`]);

  const campos_faltantes = funcs
    .filter(f => !f.cpp_codigo || !f.nivel_qualificacao || !f.nivel_escolaridade)
    .map(f => ({
      id: f.id, nome: f.nome_completo, numero: f.numero_funcionario,
      falta_cpp: !f.cpp_codigo,
      falta_nivel_qualificacao: !f.nivel_qualificacao,
      falta_escolaridade: !f.nivel_escolaridade,
    }));

  const { rows: forms } = await query(`
    SELECT id, nome, codigo_cnf FROM formacao
    WHERE empresa_id = $1
      AND (data_inicio >= $2 OR data_fim >= $2)
      AND (data_inicio < $3 OR data_inicio IS NULL)
  `, [eid, `${ano}-01-01`, `${parseInt(ano)+1}-01-01`]);

  const formacoes_sem_cnf = forms.filter(f => !f.codigo_cnf).map(f => ({ id: f.id, nome: f.nome }));

  res.json({
    total_colaboradores: funcs.length,
    campos_faltantes,
    formacoes_sem_cnf,
    pronto: campos_faltantes.length === 0 && formacoes_sem_cnf.length === 0,
  });
});

// ── Excel único com todos os anexos ─────────────────────────────────────────
router.get('/excel/:ano', async (req, res) => {
  const { ano } = req.params;
  const eid = req.empresaId;
  const dataI = `${ano}-01-01`;
  const dataF = `${parseInt(ano)+1}-01-01`;

  // Buscar dados empresa
  const { rows: [emp] } = await query(`SELECT nome, nif FROM empresa WHERE id=$1`, [eid]);

  // ── DADOS ────────────────────────────────────────────────────────────────
  // Anexo A — todos os colaboradores do ano
  const { rows: colabs } = await query(`
    SELECT
      f.numero_funcionario, f.nome_completo, f.nif, f.data_nascimento, f.genero,
      f.nacionalidade, f.nivel_escolaridade, f.nivel_qualificacao,
      f.cargo, f.cpp_codigo, f.cpp_descricao,
      f.tipo_contrato, f.data_admissao, f.data_fim_contrato,
      f.salario_base, f.horas_semanais, f.codigo_irct,
      f.motivo_saida_codigo, f.remuneracao_base_inicial,
      f.estado, f.codigo_estabelecimento,
      d.nome AS departamento,
      -- Horas extra do ano
      COALESCE((
        SELECT SUM(horas_extra_valor) FROM recibo_vencimento rv
        WHERE rv.funcionario_id = f.id AND rv.ano = $2
      ), 0) AS horas_extra_ano,
      -- Faltas do ano
      COALESCE((
        SELECT COUNT(*) FROM falta ft
        WHERE ft.funcionario_id = f.id
          AND ft.data >= $3::date AND ft.data < $4::date
          AND ft.tipo = 'injustificada'
      ), 0) AS faltas_injustificadas,
      COALESCE((
        SELECT COUNT(*) FROM falta ft
        WHERE ft.funcionario_id = f.id
          AND ft.data >= $3::date AND ft.data < $4::date
          AND ft.tipo != 'injustificada'
      ), 0) AS faltas_justificadas
    FROM funcionario f
    LEFT JOIN departamento d ON d.id = f.departamento_id
    WHERE f.empresa_id = $1
      AND (f.estado = 'ativo'
        OR (f.data_fim_contrato >= $3::date AND f.data_fim_contrato < $4::date))
    ORDER BY f.nome_completo
  `, [eid, ano, dataI, dataF]);

  // Anexo B — movimentos
  const { rows: admissoes } = await query(`
    SELECT f.numero_funcionario, f.nome_completo, f.nif, f.cargo,
           f.tipo_contrato, f.data_admissao AS data_movimento,
           f.salario_base, f.cpp_codigo, d.nome AS departamento,
           'Admissão' AS tipo_movimento, NULL AS motivo_saida
    FROM funcionario f
    LEFT JOIN departamento d ON d.id = f.departamento_id
    WHERE f.empresa_id = $1 AND f.data_admissao >= $2::date AND f.data_admissao < $3::date
    ORDER BY f.data_admissao
  `, [eid, dataI, dataF]);

  const { rows: saidas } = await query(`
    SELECT f.numero_funcionario, f.nome_completo, f.nif, f.cargo,
           f.tipo_contrato, f.data_fim_contrato AS data_movimento,
           f.salario_base, f.cpp_codigo, d.nome AS departamento,
           'Cessação' AS tipo_movimento, f.motivo_saida_codigo AS motivo_saida
    FROM funcionario f
    LEFT JOIN departamento d ON d.id = f.departamento_id
    WHERE f.empresa_id = $1 AND f.data_fim_contrato >= $2::date AND f.data_fim_contrato < $3::date
    ORDER BY f.data_fim_contrato
  `, [eid, dataI, dataF]);

  const movimentos = [...admissoes, ...saidas].sort((a,b) => new Date(a.data_movimento)-new Date(b.data_movimento));

  // Anexo C — formação por colaborador
  const { rows: formacao } = await query(`
    SELECT
      f.nome_completo AS colaborador, f.numero_funcionario,
      fo.nome AS formacao, fo.codigo_cnf, fo.modalidade, fo.tipo,
      fo.horas, fo.data_inicio, fo.data_fim,
      fo.entidade, fo.nif_entidade_formadora, fo.custo,
      fp.concluido, fp.nota
    FROM formacao_participante fp
    JOIN funcionario f ON f.id = fp.funcionario_id
    JOIN formacao fo ON fo.id = fp.formacao_id
    WHERE fo.empresa_id = $1
      AND (fo.data_inicio >= $2 OR fo.data_fim >= $2)
      AND (fo.data_inicio < $3 OR fo.data_inicio IS NULL)
    ORDER BY f.nome_completo, fo.data_inicio
  `, [eid, dataI, dataF]);

  // Anexo D — medicina por colaborador
  const { rows: medicina } = await query(`
    SELECT
      f.nome_completo AS colaborador, f.numero_funcionario,
      m.tipo, m.data_exame AS data, m.resultado, m.restricoes AS descricao,
      m.medico, m.medico_cedula, m.tecnico_sst_num_act,
      m.nif_entidade_externa
    FROM medicina_trabalho m
    JOIN funcionario f ON f.id = m.funcionario_id
    WHERE m.empresa_id = $1
      AND m.data_exame >= $2::date AND m.data_exame < $3::date
    ORDER BY f.nome_completo, m.data_exame
  `, [eid, dataI, dataF]);

  // Anexo F — prestadores
  const { rows: prestadores } = await query(`
    SELECT p.nome, p.nif, p.tipo, p.cargo, p.data_inicio, p.data_fim,
           p.valor_mensal, p.horas_mes, d.nome AS departamento
    FROM prestador_servico p
    LEFT JOIN departamento d ON d.id = p.departamento_id
    WHERE p.empresa_id = $1 AND p.ativo = true
    ORDER BY p.nome
  `, [eid]);

  // ── EXCEL ────────────────────────────────────────────────────────────────
  const wb = new ExcelJS.Workbook();
  wb.creator = 'NexEdge';
  wb.created = new Date();
  wb.properties.date1904 = false;

  // ── FOLHA DE ROSTO ────────────────────────────────────────────────────────
  const wsRosto = wb.addWorksheet('Rosto');
  wsRosto.getColumn(1).width = 30;
  wsRosto.getColumn(2).width = 40;

  const rostoTitulo = wsRosto.getRow(1);
  wsRosto.mergeCells('A1:B1');
  wsRosto.getCell('A1').value = `RELATÓRIO ÚNICO ${ano}`;
  wsRosto.getCell('A1').font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
  wsRosto.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  wsRosto.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
  wsRosto.getRow(1).height = 40;

  const dadosRosto = [
    ['Empresa', emp?.nome || ''],
    ['NIF', emp?.nif || ''],
    ['Ano de Referência', ano],
    ['Total Colaboradores', colabs.length],
    ['Admissões no Ano', admissoes.length],
    ['Cessações no Ano', saidas.length],
    ['Formações Realizadas', formacao.length],
    ['Gerado em', new Date().toLocaleString('pt-PT')],
    ['Gerado por', 'NexEdge v4.0'],
    ['', ''],
    ['ATENÇÃO', 'Verificar e completar campos assinalados a amarelo antes de submeter em relatoriounico.pt'],
  ];
  dadosRosto.forEach(([chave, valor], i) => {
    const r = wsRosto.getRow(i + 2);
    r.getCell(1).value = chave;
    r.getCell(1).font = { bold: true };
    r.getCell(2).value = valor;
    if (chave === 'ATENÇÃO') {
      r.getCell(1).font = { bold: true, color: { argb: 'FFC0392B' } };
      r.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
    }
  });

  // ── ANEXO A — QUADRO DE PESSOAL ──────────────────────────────────────────
  const wsA = wb.addWorksheet('Anexo A - Quadro Pessoal');
  const colsA = [
    { header: 'Nº Func.', key: 'numero_funcionario', width: 9 },
    { header: 'Nome Completo', key: 'nome_completo', width: 30 },
    { header: 'NIF', key: 'nif', width: 11 },
    { header: 'Data Nasc.', key: 'data_nascimento', width: 12 },
    { header: 'Género', key: 'genero', width: 8 },
    { header: 'Nacion.', key: 'nacionalidade', width: 9 },
    { header: 'Escolaridade', key: 'nivel_escolaridade', width: 18 },
    { header: 'Nível Qualif.', key: 'nivel_qualificacao', width: 14 },
    { header: 'Cargo', key: 'cargo', width: 24 },
    { header: 'Cód. CPP', key: 'cpp_codigo', width: 10 },
    { header: 'Tipo Contrato', key: 'tipo_contrato', width: 14 },
    { header: 'Data Admissão', key: 'data_admissao', width: 13 },
    { header: 'Data Saída', key: 'data_fim_contrato', width: 11 },
    { header: 'Mot. Saída', key: 'motivo_saida_codigo', width: 10 },
    { header: 'Rem. Base €', key: 'salario_base', width: 11 },
    { header: 'Rem. Inicial €', key: 'remuneracao_base_inicial', width: 13 },
    { header: 'H/Semana', key: 'horas_semanais', width: 10 },
    { header: 'H. Extra/Ano', key: 'horas_extra_ano', width: 11 },
    { header: 'Faltas Injust.', key: 'faltas_injustificadas', width: 13 },
    { header: 'Faltas Just.', key: 'faltas_justificadas', width: 12 },
    { header: 'IRCT', key: 'codigo_irct', width: 10 },
    { header: 'Departamento', key: 'departamento', width: 20 },
    { header: 'Estabelecimento', key: 'codigo_estabelecimento', width: 15 },
    { header: 'Estado', key: 'estado', width: 10 },
  ];
  wsA.columns = colsA;
  estiloHeader(wsA, 1, colsA.length, `ANEXO A — QUADRO DE PESSOAL (${ano}) — ${emp?.nome}`);
  estiloColunas(wsA, 2, colsA);

  colabs.forEach((r, idx) => {
    const temFalta = !r.cpp_codigo || !r.nivel_qualificacao || !r.nivel_escolaridade;
    const row = wsA.addRow({
      ...r,
      data_nascimento: fmtData(r.data_nascimento),
      data_admissao: fmtData(r.data_admissao),
      data_fim_contrato: fmtData(r.data_fim_contrato),
      salario_base: fmtNum(r.salario_base),
      remuneracao_base_inicial: fmtNum(r.remuneracao_base_inicial),
    });
    listraLinhas(wsA, row, idx, temFalta);
    // Células em falta a vermelho
    if (!r.cpp_codigo) row.getCell('cpp_codigo').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
    if (!r.nivel_qualificacao) row.getCell('nivel_qualificacao').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
    if (!r.nivel_escolaridade) row.getCell('nivel_escolaridade').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
  });
  // Linha totais
  const totalA = wsA.addRow({ numero_funcionario: 'TOTAL', nome_completo: colabs.length });
  totalA.font = { bold: true };
  totalA.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBEAFE' } };

  // ── ANEXO B — MOVIMENTOS ─────────────────────────────────────────────────
  const wsB = wb.addWorksheet('Anexo B - Movimentos');
  const colsB = [
    { header: 'Tipo', key: 'tipo_movimento', width: 12 },
    { header: 'Data', key: 'data_movimento', width: 12 },
    { header: 'Nº Func.', key: 'numero_funcionario', width: 9 },
    { header: 'Nome Completo', key: 'nome_completo', width: 30 },
    { header: 'NIF', key: 'nif', width: 11 },
    { header: 'Cargo', key: 'cargo', width: 24 },
    { header: 'Cód. CPP', key: 'cpp_codigo', width: 10 },
    { header: 'Tipo Contrato', key: 'tipo_contrato', width: 14 },
    { header: 'Rem. Base €', key: 'salario_base', width: 11 },
    { header: 'Departamento', key: 'departamento', width: 20 },
    { header: 'Motivo Saída', key: 'motivo_saida', width: 14 },
  ];
  wsB.columns = colsB;
  estiloHeader(wsB, 1, colsB.length, `ANEXO B — MOVIMENTOS DE PESSOAL (${ano})`);
  estiloColunas(wsB, 2, colsB);

  movimentos.forEach((r, idx) => {
    const row = wsB.addRow({
      ...r,
      data_movimento: fmtData(r.data_movimento),
      salario_base: fmtNum(r.salario_base),
    });
    const isAdm = r.tipo_movimento === 'Admissão';
    row.getCell('tipo_movimento').fill = {
      type: 'pattern', pattern: 'solid',
      fgColor: { argb: isAdm ? 'FFD1FAE5' : 'FFFEE2E2' },
    };
    if (idx % 2 === 0) row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFF' } };
  });
  if (!movimentos.length) wsB.addRow({ tipo_movimento: 'Sem movimentos neste ano' });

  // ── ANEXO C — FORMAÇÃO POR COLABORADOR ───────────────────────────────────
  const wsC = wb.addWorksheet('Anexo C - Formação');
  const colsC = [
    { header: 'Nº Func.', key: 'numero_funcionario', width: 9 },
    { header: 'Colaborador', key: 'colaborador', width: 28 },
    { header: 'Acção de Formação', key: 'formacao', width: 30 },
    { header: 'Cód. CNF', key: 'codigo_cnf', width: 10 },
    { header: 'Modalidade', key: 'modalidade', width: 18 },
    { header: 'Tipo', key: 'tipo', width: 12 },
    { header: 'Horas', key: 'horas', width: 8 },
    { header: 'Data Início', key: 'data_inicio', width: 12 },
    { header: 'Data Fim', key: 'data_fim', width: 11 },
    { header: 'Entidade Formadora', key: 'entidade', width: 24 },
    { header: 'NIF Entidade', key: 'nif_entidade_formadora', width: 13 },
    { header: 'Concluído', key: 'concluido', width: 10 },
    { header: 'Nota', key: 'nota', width: 8 },
  ];
  wsC.columns = colsC;
  estiloHeader(wsC, 1, colsC.length, `ANEXO C — FORMAÇÃO PROFISSIONAL (${ano})`);
  estiloColunas(wsC, 2, colsC);

  formacao.forEach((r, idx) => {
    const row = wsC.addRow({
      ...r,
      data_inicio: fmtData(r.data_inicio),
      data_fim: fmtData(r.data_fim),
      concluido: r.concluido ? 'Sim' : 'Não',
    });
    if (!r.codigo_cnf) row.getCell('codigo_cnf').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
    if (idx % 2 === 0) row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F9F0' } };
  });
  if (!formacao.length) wsC.addRow({ colaborador: 'Sem formações registadas neste ano' });

  // ── ANEXO D — SAÚDE E SEGURANÇA ──────────────────────────────────────────
  const wsD = wb.addWorksheet('Anexo D - Saúde e SST');
  const colsD = [
    { header: 'Nº Func.', key: 'numero_funcionario', width: 9 },
    { header: 'Colaborador', key: 'colaborador', width: 28 },
    { header: 'Tipo Exame', key: 'tipo', width: 20 },
    { header: 'Data', key: 'data', width: 12 },
    { header: 'Resultado', key: 'resultado', width: 14 },
    { header: 'Médico', key: 'medico', width: 22 },
    { header: 'Cédula Médico', key: 'medico_cedula', width: 14 },
    { header: 'Técnico SST (ACT)', key: 'tecnico_sst_num_act', width: 16 },
    { header: 'NIF Entidade', key: 'nif_entidade_externa', width: 13 },
    { header: 'Descrição', key: 'descricao', width: 30 },
  ];
  wsD.columns = colsD;
  estiloHeader(wsD, 1, colsD.length, `ANEXO D — SAÚDE E SEGURANÇA NO TRABALHO (${ano})`, 'FF8B0000');
  estiloColunas(wsD, 2, colsD);

  medicina.forEach((r, idx) => {
    const row = wsD.addRow({ ...r, data: fmtData(r.data) });
    if (idx % 2 === 0) row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF5F5' } };
  });
  if (!medicina.length) wsD.addRow({ colaborador: 'Sem registos de medicina do trabalho neste ano' });

  // ── ANEXO E — GREVES ─────────────────────────────────────────────────────
  const wsE = wb.addWorksheet('Anexo E - Greves');
  estiloHeader(wsE, 1, 4, `ANEXO E — GREVES E PARALISAÇÕES (${ano})`, 'FF92400E');
  wsE.columns = [
    { header: 'Data Início', width: 14 },
    { header: 'Data Fim', width: 12 },
    { header: 'Nº Trabalhadores', width: 18 },
    { header: 'Observações', width: 40 },
  ];
  const hrE = wsE.getRow(2);
  hrE.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  hrE.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFB45309' } };
  ['Data Início','Data Fim','Nº Trabalhadores','Observações'].forEach((h,i) => { hrE.getCell(i+1).value = h; });
  wsE.addRow(['', '', '', 'Sem greves registadas — preencher se aplicável']);

  // ── ANEXO F — PRESTADORES ────────────────────────────────────────────────
  const wsF = wb.addWorksheet('Anexo F - Prestadores');
  const colsF = [
    { header: 'Nome', key: 'nome', width: 28 },
    { header: 'NIF', key: 'nif', width: 11 },
    { header: 'Tipo', key: 'tipo', width: 14 },
    { header: 'Cargo/Função', key: 'cargo', width: 22 },
    { header: 'Data Início', key: 'data_inicio', width: 12 },
    { header: 'Data Fim', key: 'data_fim', width: 11 },
    { header: 'Valor Mensal €', key: 'valor_mensal', width: 14 },
    { header: 'Horas/Mês', key: 'horas_mes', width: 11 },
    { header: 'Departamento', key: 'departamento', width: 20 },
  ];
  wsF.columns = colsF;
  estiloHeader(wsF, 1, colsF.length, `ANEXO F — PRESTADORES DE SERVIÇOS (${ano})`, 'FF4C1D95');
  estiloColunas(wsF, 2, colsF);

  prestadores.forEach((r, idx) => {
    const row = wsF.addRow({
      ...r,
      data_inicio: fmtData(r.data_inicio),
      data_fim: fmtData(r.data_fim),
      valor_mensal: fmtNum(r.valor_mensal),
    });
    if (idx % 2 === 0) row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F3FF' } };
  });
  if (!prestadores.length) wsF.addRow({ nome: 'Sem prestadores registados — preencher se aplicável' });

  // ── Enviar ────────────────────────────────────────────────────────────────
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="RelatorioUnico_${ano}_${emp?.nif || 'empresa'}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

// ── Estado e progresso ───────────────────────────────────────────────────────
router.get('/estado/:ano', async (req, res) => {
  const { rows } = await query(
    `SELECT * FROM relatorio_unico WHERE empresa_id=$1 AND ano=$2`,
    [req.empresaId, req.params.ano]
  );
  res.json(rows[0] || null);
});

router.post('/estado/:ano', async (req, res) => {
  const { notas } = req.body;
  const { rows } = await query(`
    INSERT INTO relatorio_unico (empresa_id, ano, gerado_em, gerado_por, notas)
    VALUES ($1,$2,NOW(),$3,$4)
    ON CONFLICT (empresa_id, ano)
    DO UPDATE SET gerado_em=NOW(), gerado_por=$3, notas=$4
    RETURNING *
  `, [req.empresaId, req.params.ano, req.utilizador.id, notas || null]);
  res.json(rows[0]);
});

router.patch('/estado/:ano/anexo', async (req, res) => {
  const { anexo, valor } = req.body;
  const col = `anexo_${anexo}_ok`;
  await query(`
    INSERT INTO relatorio_unico (empresa_id, ano, ${col})
    VALUES ($1,$2,$3)
    ON CONFLICT (empresa_id, ano) DO UPDATE SET ${col}=$3
  `, [req.empresaId, req.params.ano, valor]);
  res.json({ ok: true });
});

module.exports = router;
