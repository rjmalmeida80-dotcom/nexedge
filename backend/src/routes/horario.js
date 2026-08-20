'use strict';
const router = require('express').Router();
const { autenticar, autorizar } = require('../middleware/auth');
const { middlewareAuditoria } = require('../middleware/auditoria');
const { query } = require('../config/database');
const { criarErro } = require('../middleware/errorHandler');

const RH = ['admin_empresa','rh','diretor','supervisor','team_leader'];
router.use(autenticar, middlewareAuditoria);

// Listar escalas
router.get('/escalas', async (req, res) => {
  const { rows } = await query(`
    SELECT e.*, d.nome AS departamento,
           COUNT(t.id) AS total_turnos,
           u.nome_completo AS criado_por_nome
    FROM escala e
    LEFT JOIN departamento d ON d.id=e.departamento_id
    LEFT JOIN turno t ON t.escala_id=e.id
    LEFT JOIN utilizador u ON u.id=e.criado_por
    WHERE e.empresa_id=$1
    GROUP BY e.id, d.nome, u.nome_completo
    ORDER BY e.data_inicio DESC
  `, [req.empresaId]);
  res.json(rows);
});

// Criar escala
router.post('/escalas', autorizar(...RH), async (req, res) => {
  const { nome, departamento_id, data_inicio, data_fim } = req.body;
  if (!nome || !data_inicio || !data_fim) throw criarErro('Nome e datas são obrigatórios.', 400);
  const { rows } = await query(`
    INSERT INTO escala (empresa_id, departamento_id, nome, data_inicio, data_fim, criado_por)
    VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
  `, [req.empresaId, departamento_id||null, nome, data_inicio, data_fim, req.utilizador.id]);
  res.status(201).json(rows[0]);
});

// Listar turnos de uma escala
router.get('/escalas/:escala_id/turnos', async (req, res) => {
  const { rows } = await query(`
    SELECT t.*, f.nome_completo, f.foto_url, d.nome AS departamento
    FROM turno t
    JOIN funcionario f ON f.id=t.funcionario_id
    LEFT JOIN departamento d ON d.id=f.departamento_id
    WHERE t.escala_id=$1
    ORDER BY t.data, t.hora_entrada
  `, [req.params.escala_id]);
  res.json(rows);
});

// Adicionar turno
router.post('/escalas/:escala_id/turnos', autorizar(...RH), async (req, res) => {
  const { funcionario_id, data, hora_entrada, hora_saida, tipo, notas } = req.body;
  if (!funcionario_id || !data || !hora_entrada || !hora_saida) {
    throw criarErro('Funcionário, data e horas são obrigatórios.', 400);
  }

  // Verificar conflito de turno
  const { rows: conflito } = await query(`
    SELECT t.id FROM turno t
    JOIN escala e ON e.id=t.escala_id
    WHERE t.funcionario_id=$1 AND t.data=$2
      AND e.empresa_id=$3
      AND NOT (t.hora_saida <= $4 OR t.hora_entrada >= $5)
  `, [funcionario_id, data, req.empresaId, hora_entrada, hora_saida]);
  if (conflito.length) throw criarErro('Conflito de horário: já existe turno para este funcionário neste período.', 409);

  // Verificar descanso mínimo (11h entre turnos — CT art. 214.º)
  const { rows: anterior } = await query(`
    SELECT t.hora_saida, t.data FROM turno t
    JOIN escala e ON e.id=t.escala_id
    WHERE t.funcionario_id=$1 AND e.empresa_id=$2
      AND (t.data = $3::date - INTERVAL '1 day' OR t.data = $3::date)
    ORDER BY t.data DESC, t.hora_saida DESC LIMIT 1
  `, [funcionario_id, req.empresaId, data]);

  if (anterior.length) {
    // Calcular horas de descanso
    const saidaAnterior = new Date(`${anterior[0].data}T${anterior[0].hora_saida}`);
    const novaEntrada = new Date(`${data}T${hora_entrada}`);
    const horas = (novaEntrada - saidaAnterior) / (1000 * 60 * 60);
    if (horas < 11) {
      throw criarErro(`Violação do Código do Trabalho (art. 214.º): descanso mínimo de 11h não cumprido. Apenas ${Math.round(horas*10)/10}h de descanso.`, 400);
    }
  }

  const { rows } = await query(`
    INSERT INTO turno (escala_id, funcionario_id, data, hora_entrada, hora_saida, tipo, notas)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
  `, [req.params.escala_id, funcionario_id, data, hora_entrada, hora_saida, tipo||'fixo', notas||null]);
  res.status(201).json(rows[0]);
});

// Horário semanal de um funcionário
router.get('/funcionario/:func_id/semana', async (req, res) => {
  const { semana } = req.query; // formato: 2025-W03
  const { rows } = await query(`
    SELECT t.*, e.nome AS escala_nome
    FROM turno t
    JOIN escala e ON e.id=t.escala_id
    WHERE t.funcionario_id=$1 AND e.empresa_id=$2
      AND EXTRACT(WEEK FROM t.data) = $3 AND EXTRACT(YEAR FROM t.data) = $4
    ORDER BY t.data, t.hora_entrada
  `, [req.params.func_id, req.empresaId,
      semana ? parseInt(semana.split('-W')[1]) : null,
      semana ? parseInt(semana.split('-W')[0]) : null]);
  res.json(rows);
});

// GET /horarios/registo-ponto — listar registos do mês
router.get('/registo-ponto', async (req, res) => {
  const { mes, ano, funcionario_id } = req.query;
  let where = 'f.empresa_id=$1';
  const params = [req.empresaId];
  let p = 2;
  if (mes && ano) {
    where += ` AND EXTRACT(MONTH FROM rp.data)=$${p++} AND EXTRACT(YEAR FROM rp.data)=$${p++}`;
    params.push(mes, ano);
  }
  if (funcionario_id) { where += ` AND rp.funcionario_id=$${p++}`; params.push(funcionario_id); }
  else if (req.utilizador?.perfil === 'funcionario') {
    where += ` AND rp.funcionario_id=(SELECT id FROM funcionario WHERE utilizador_id=$${p++} LIMIT 1)`;
    params.push(req.utilizador.id);
  }
  const { rows } = await query(`
    SELECT rp.*, f.nome_completo, f.numero_funcionario
    FROM registo_ponto rp
    JOIN funcionario f ON f.id = rp.funcionario_id
    WHERE ${where}
    ORDER BY rp.data DESC, f.nome_completo
  `, params);
  res.json(rows);
});

// POST /horarios/registo-ponto — criar registo
router.post('/registo-ponto', async (req, res) => {
  const { funcionario_id, data, mes, ano, hora_entrada, hora_saida, horas_trabalhadas, horas_extra, notas } = req.body;
  // Accept either specific date or mes/ano (use last day of month if mes/ano)
  const dataFinal = data || (mes && ano ? `${ano}-${String(mes).padStart(2,'0')}-01` : null);
  if (!funcionario_id || !dataFinal) throw criarErro('Funcionário e data são obrigatórios.', 400);

  const { rows: [func] } = await query('SELECT id FROM funcionario WHERE id=$1 AND empresa_id=$2', [funcionario_id, req.empresaId]);
  if (!func) throw criarErro('Funcionário não encontrado.', 404);

  const horasTrab = parseFloat(horas_trabalhadas) || 0;
  const horasEx = parseFloat(horas_extra) || 0;

  const { rows } = await query(`
    INSERT INTO registo_ponto (funcionario_id, data, horas_trabalhadas, horas_extra)
    VALUES ($1,$2,$3,$4)
    RETURNING *
  `, [funcionario_id, dataFinal, horasTrab, horasEx]);
  res.status(201).json(rows[0]);
});

// GET /horarios/banco-horas — saldo de horas extra por funcionário
router.get('/banco-horas', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT 
        f.id, f.nome_completo, f.cargo, f.numero_funcionario,
        COALESCE(SUM(rp.horas_extra), 0) AS horas_extra_total,
        COALESCE(SUM(CASE WHEN rp.horas_extra < 0 THEN ABS(rp.horas_extra) ELSE 0 END), 0) AS horas_debito,
        COALESCE(SUM(CASE WHEN rp.horas_extra > 0 THEN rp.horas_extra ELSE 0 END), 0) AS horas_credito,
        d.nome AS departamento
      FROM funcionario f
      LEFT JOIN registo_ponto rp ON rp.funcionario_id = f.id
      LEFT JOIN departamento d ON d.id = f.departamento_id
      WHERE f.empresa_id = $1 AND f.estado = 'ativo'
      GROUP BY f.id, f.nome_completo, f.cargo, f.numero_funcionario, d.nome
      ORDER BY horas_extra_total DESC
    `, [req.empresaId]);
    res.json(rows);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


// ── Validação ACT completa de um turno ───────────────────────────────────────
// Verifica todos os limites do Código do Trabalho antes de criar/actualizar
async function validarACT(funcionario_id, empresaId, data, hora_entrada, hora_saida, turno_id_excluir = null) {
  const violacoes = [];

  // Calcular horas do turno
  const entrada = new Date(`${data}T${hora_entrada}`);
  const saida   = new Date(`${data}T${hora_saida}`);
  let horasTurno = (saida - entrada) / (1000 * 60 * 60);
  if (horasTurno < 0) horasTurno += 24; // turno nocturno que passa meia-noite

  // 1. Máximo 8h/dia (CT art. 203.º)
  if (horasTurno > 8) {
    violacoes.push({ artigo: '203.º', descricao: `Turno tem ${horasTurno.toFixed(1)}h — máximo legal é 8h/dia` });
  }

  // 2. Intervalo obrigatório entre 4-6h de trabalho contínuo (CT art. 213.º)
  if (horasTurno >= 6 && horasTurno <= 10) {
    violacoes.push({ artigo: '213.º', descricao: `Turno de ${horasTurno.toFixed(1)}h requer intervalo de pelo menos 1h para refeição (registar no turno)`, aviso: true });
  }

  // 3. Descanso mínimo 11h entre turnos (CT art. 214.º)
  const exclStr = turno_id_excluir ? `AND t.id != '${turno_id_excluir}'` : '';
  const { rows: anterior } = await query(`
    SELECT t.data, t.hora_saida FROM turno t
    JOIN escala e ON e.id = t.escala_id
    WHERE t.funcionario_id = $1 AND e.empresa_id = $2
      AND t.data BETWEEN $3::date - INTERVAL '2 days' AND $3::date
      ${exclStr}
    ORDER BY t.data DESC, t.hora_saida DESC LIMIT 1
  `, [funcionario_id, empresaId, data]);

  if (anterior.length) {
    const saidaAnt = new Date(`${anterior[0].data}T${anterior[0].hora_saida}`);
    const descanso = (entrada - saidaAnt) / (1000 * 60 * 60);
    if (descanso < 11 && descanso > 0) {
      violacoes.push({ artigo: '214.º', descricao: `Apenas ${descanso.toFixed(1)}h de descanso — mínimo legal é 11h entre turnos` });
    }
  }

  // 4. Máximo 40h/semana (CT art. 203.º)
  const { rows: semana } = await query(`
    SELECT COALESCE(SUM(
      EXTRACT(EPOCH FROM (t.hora_saida::time - t.hora_entrada::time)) / 3600
    ), 0) AS horas_semana
    FROM turno t
    JOIN escala e ON e.id = t.escala_id
    WHERE t.funcionario_id = $1 AND e.empresa_id = $2
      AND DATE_TRUNC('week', t.data) = DATE_TRUNC('week', $3::date)
      ${exclStr}
  `, [funcionario_id, empresaId, data]);

  const horasSemana = parseFloat(semana[0]?.horas_semana || 0) + horasTurno;
  if (horasSemana > 40) {
    violacoes.push({ artigo: '203.º', descricao: `Total semanal seria ${horasSemana.toFixed(1)}h — máximo legal é 40h/semana` });
  }

  // 5. Horas extra anuais (CT art. 228.º) — máximo 150h/ano
  const anoAtual = new Date(data).getFullYear();
  const { rows: horasAnoRows } = await query(`
    SELECT COALESCE(SUM(rp.horas_extra), 0) AS horas_extra_ano
    FROM registo_ponto rp
    JOIN funcionario f ON f.id = rp.funcionario_id
    WHERE rp.funcionario_id = $1 AND f.empresa_id = $2
      AND EXTRACT(YEAR FROM rp.data) = $3
  `, [funcionario_id, empresaId, anoAtual]);

  const horasExtraAno = parseFloat(horasAnoRows[0]?.horas_extra_ano || 0);
  if (horasExtraAno >= 130) {
    violacoes.push({
      artigo: '228.º',
      descricao: `Colaborador tem ${horasExtraAno.toFixed(0)}h extra este ano — limite legal é 150h/ano`,
      aviso: horasExtraAno < 150
    });
  }

  // 6. Descanso semanal obrigatório (CT art. 232.º) — 1 dia por semana
  const { rows: diasSemana } = await query(`
    SELECT COUNT(DISTINCT t.data) AS dias
    FROM turno t
    JOIN escala e ON e.id = t.escala_id
    WHERE t.funcionario_id = $1 AND e.empresa_id = $2
      AND DATE_TRUNC('week', t.data) = DATE_TRUNC('week', $3::date)
      ${exclStr}
  `, [funcionario_id, empresaId, data]);

  if (parseInt(diasSemana[0]?.dias || 0) >= 6) {
    violacoes.push({ artigo: '232.º', descricao: 'Colaborador já tem 6 dias de trabalho esta semana — obrigatório 1 dia de descanso semanal', aviso: true });
  }

  // 7. Suplemento nocturno 20h-7h (CT art. 266.º) — apenas aviso
  const entradaH = parseInt(hora_entrada.split(':')[0]);
  const saidaH   = parseInt(hora_saida.split(':')[0]);
  if (entradaH >= 20 || entradaH < 7 || saidaH <= 7) {
    violacoes.push({ artigo: '266.º', descricao: 'Turno inclui trabalho nocturno (20h-7h) — suplemento de +25% obrigatório', aviso: true, info: true });
  }

  return violacoes;
}

// ── Endpoint: validar turno antes de criar ────────────────────────────────────
router.post('/validar-turno', autorizar(...RH), async (req, res) => {
  const { funcionario_id, data, hora_entrada, hora_saida, turno_id } = req.body;
  if (!funcionario_id || !data || !hora_entrada || !hora_saida) {
    return res.status(400).json({ error: 'Campos obrigatórios em falta' });
  }
  try {
    const violacoes = await validarACT(funcionario_id, req.empresaId, data, hora_entrada, hora_saida, turno_id);
    res.json({
      valido: !violacoes.some(v => !v.aviso),
      violacoes,
      avisos: violacoes.filter(v => v.aviso || v.info),
      erros: violacoes.filter(v => !v.aviso && !v.info),
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Endpoint: análise ACT de uma escala completa ──────────────────────────────
router.get('/escalas/:escala_id/analise-act', autorizar(...RH), async (req, res) => {
  const { rows: turnos } = await query(`
    SELECT t.*, f.nome_completo, f.numero_funcionario
    FROM turno t
    JOIN funcionario f ON f.id = t.funcionario_id
    JOIN escala e ON e.id = t.escala_id
    WHERE t.escala_id = $1 AND e.empresa_id = $2
    ORDER BY t.funcionario_id, t.data, t.hora_entrada
  `, [req.params.escala_id, req.empresaId]);

  // Agrupar por funcionário e analisar
  const porFunc = {};
  for (const t of turnos) {
    if (!porFunc[t.funcionario_id]) {
      porFunc[t.funcionario_id] = { nome: t.nome_completo, numero: t.numero_funcionario, turnos: [], violacoes: [] };
    }
    porFunc[t.funcionario_id].turnos.push(t);
  }

  // Para cada funcionário, calcular totais e verificar limites
  for (const fid of Object.keys(porFunc)) {
    const f = porFunc[fid];
    let totalHoras = 0;
    const horasPorSemana = {};
    const horasPorDia = {};

    for (const t of f.turnos) {
      const entrada = new Date(`${t.data}T${t.hora_entrada}`);
      const saida   = new Date(`${t.data}T${t.hora_saida}`);
      let horas = (saida - entrada) / (1000 * 60 * 60);
      if (horas < 0) horas += 24;

      totalHoras += horas;
      const semana = `${new Date(t.data).getFullYear()}-W${Math.ceil((new Date(t.data) - new Date(new Date(t.data).getFullYear(),0,1))/(7*86400000))}`;
      horasPorSemana[semana] = (horasPorSemana[semana] || 0) + horas;
      horasPorDia[t.data] = (horasPorDia[t.data] || 0) + horas;
    }

    // Verificar limites
    for (const [dia, horas] of Object.entries(horasPorDia)) {
      if (horas > 8) f.violacoes.push({ data: dia, artigo: '203.º', descricao: `${horas.toFixed(1)}h no dia ${dia} — máximo 8h` });
    }
    for (const [semana, horas] of Object.entries(horasPorSemana)) {
      if (horas > 40) f.violacoes.push({ semana, artigo: '203.º', descricao: `${horas.toFixed(1)}h na semana ${semana} — máximo 40h` });
    }

    f.total_horas = totalHoras.toFixed(1);
    f.media_semanal = f.turnos.length > 0 ? (totalHoras / Object.keys(horasPorSemana).length).toFixed(1) : '0';
  }

  res.json({
    total_funcionarios: Object.keys(porFunc).length,
    total_turnos: turnos.length,
    funcionarios: Object.values(porFunc),
    tem_violacoes: Object.values(porFunc).some(f => f.violacoes.length > 0),
  });
});

// ── Endpoint: sugestão de cobertura para turno em falta ──────────────────────
router.post('/sugerir-cobertura', autorizar(...RH), async (req, res) => {
  const { data, hora_entrada, hora_saida, departamento_id } = req.body;

  // Colaboradores disponíveis (sem turno nesse dia, com descanso suficiente)
  const { rows: disponiveis } = await query(`
    SELECT f.id, f.nome_completo, f.cargo, f.numero_funcionario,
      COALESCE(SUM(rp.horas_extra), 0) AS horas_extra_ano
    FROM funcionario f
    LEFT JOIN registo_ponto rp ON rp.funcionario_id = f.id
      AND EXTRACT(YEAR FROM rp.data) = EXTRACT(YEAR FROM $1::date)
    WHERE f.empresa_id = $2 AND f.estado = 'ativo'
      ${departamento_id ? 'AND f.departamento_id = $3' : ''}
      AND f.id NOT IN (
        SELECT DISTINCT t.funcionario_id FROM turno t
        JOIN escala e ON e.id = t.escala_id
        WHERE e.empresa_id = $2 AND t.data = $1::date
      )
    GROUP BY f.id, f.nome_completo, f.cargo, f.numero_funcionario
    HAVING COALESCE(SUM(rp.horas_extra), 0) < 150
    ORDER BY COALESCE(SUM(rp.horas_extra), 0) ASC
    LIMIT 5
  `, departamento_id ? [data, req.empresaId, departamento_id] : [data, req.empresaId]);

  res.json({ sugestoes: disponiveis });
});



// ── Gerar escala automática a partir dos horários definidos nas fichas ────────
router.post('/escalas/:escala_id/gerar-automatico', autorizar(...RH), async (req, res) => {
  const { escala_id } = req.params;
  const eid = req.empresaId;

  // 1. Buscar escala
  const { rows: [escala] } = await query(
    'SELECT * FROM escala WHERE id=$1 AND empresa_id=$2',
    [escala_id, eid]
  );
  if (!escala) return res.status(404).json({ error: 'Escala não encontrada' });

  // 2. Converter datas da escala para Date local (evitar problemas de timezone)
  const toDate = (v) => {
    const s = (v instanceof Date ? v.toISOString() : String(v)).substring(0, 10);
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  const inicio = toDate(escala.data_inicio);
  const fim    = toDate(escala.data_fim);

  // 3. Buscar colaboradores com horário definido
  const { rows: colabs } = await query(`
    SELECT f.id, f.nome_completo, f.tipo_turno,
           f.horario_entrada, f.horario_saida,
           f.regime_horario, f.trabalha_feriados,
           f.dias_trabalho_semana
    FROM funcionario f
    WHERE f.empresa_id=$1 AND f.estado='ativo'
    ORDER BY f.nome_completo
  `, [eid]);

  if (!colabs.length) {
    return res.status(400).json({ error: 'Nenhum colaborador activo encontrado.' });
  }

  // 4. Buscar feriados do período
  const { rows: feriados } = await query(`
    SELECT TO_CHAR(data, 'YYYY-MM-DD') AS data
    FROM feriado
    WHERE empresa_id=$1
      AND data >= $2::date AND data <= $3::date
  `, [eid, inicio.toISOString().split('T')[0], fim.toISOString().split('T')[0]]);
  const feriadosSet = new Set(feriados.map(f => f.data));

  // 5. Para cada colaborador, gerar turnos
  let criados = 0;
  let ignorados = 0;

  for (const colab of colabs) {
    const tipo     = colab.tipo_turno || 'fixo';
    const regime   = colab.regime_horario || 'seg_sex';
    const entrada  = (colab.horario_entrada || '09:00:00').substring(0, 5);
    const saida    = (colab.horario_saida   || '18:00:00').substring(0, 5);
    const trabalhaFeriados = colab.trabalha_feriados === true;
    const diasPersonalizados = typeof colab.dias_trabalho_semana === 'string'
      ? colab.dias_trabalho_semana.split(',').map(Number)
      : [1,2,3,4,5];

    // Para cada dia do período
    for (let d = new Date(inicio.getTime()); d <= fim; d.setDate(d.getDate() + 1)) {
      const dow = d.getDay(); // 0=Dom, 1=Seg, 2=Ter, 3=Qua, 4=Qui, 5=Sex, 6=Sab
      const dataStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      const eFeriado = feriadosSet.has(dataStr);

      // Decidir se trabalha hoje com base no regime
      let trabalha = false;
      switch (regime) {
        case 'seg_sex':      trabalha = dow >= 1 && dow <= 5; break;
        case 'seg_sab':      trabalha = dow >= 1 && dow <= 6; break;
        case 'dom_qui':      trabalha = dow === 0 || (dow >= 1 && dow <= 4); break;
        case 'ter_sab':      trabalha = dow >= 2 && dow <= 6; break;
        case '24_7':         trabalha = dow >= 1 && dow <= 5; break;
        case 'turno_rotativo': trabalha = dow >= 1 && dow <= 5; break;
        case 'personalizado':  trabalha = diasPersonalizados.includes(dow); break;
        default:             trabalha = dow >= 1 && dow <= 5;
      }
      if (eFeriado && !trabalhaFeriados) trabalha = false;

      if (!trabalha) continue;

      // Verificar se já existe turno neste dia para este colaborador nesta escala
      const { rows: jaExiste } = await query(
        'SELECT id FROM turno WHERE escala_id=$1 AND funcionario_id=$2 AND data=$3',
        [escala_id, colab.id, dataStr]
      );
      if (jaExiste.length > 0) { ignorados++; continue; }

      // Inserir turno
      try {
        await query(`
          INSERT INTO turno (escala_id, funcionario_id, data, hora_entrada, hora_saida, tipo)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [escala_id, colab.id, dataStr, entrada, saida, tipo]);
        criados++;
      } catch(e) {
        ignorados++;
      }
    }
  }

  res.json({
    criados,
    ignorados,
    mensagem: `${criados} turno(s) criado(s). ${ignorados} ignorado(s) (já existiam).`,
  });
});


router.put('/escalas/:id', autorizar(...RH), async (req, res) => {
  const { nome, departamento_id, data_inicio, data_fim, estado } = req.body;
  const { rows } = await query(`
    UPDATE escala SET nome=$1, departamento_id=$2, data_inicio=$3, data_fim=$4, estado=$5
    WHERE id=$6 AND empresa_id=$7 RETURNING *
  `, [nome, departamento_id||null, data_inicio, data_fim, estado||'rascunho', req.params.id, req.empresaId]);
  if (!rows.length) return res.status(404).json({ error: 'Escala não encontrada' });
  res.json(rows[0]);
});

// ── Apagar escala (só rascunhos) ──────────────────────────────────────────────
router.delete('/escalas/:id', autorizar(...RH), async (req, res) => {
  const { rows: [escala] } = await query(
    'SELECT estado FROM escala WHERE id=$1 AND empresa_id=$2',
    [req.params.id, req.empresaId]
  );
  if (!escala) return res.status(404).json({ error: 'Escala não encontrada' });
  if (escala.estado !== 'rascunho') return res.status(400).json({ error: 'Só é possível apagar escalas em rascunho' });
  await query('DELETE FROM escala WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ── Apagar turno individual ───────────────────────────────────────────────────
router.delete('/escalas/:escala_id/turnos/:turno_id', autorizar(...RH), async (req, res) => {
  await query(`
    DELETE FROM turno WHERE id=$1
    AND escala_id IN (SELECT id FROM escala WHERE empresa_id=$2)
  `, [req.params.turno_id, req.empresaId]);
  res.json({ ok: true });
});

// ── Publicar escala ───────────────────────────────────────────────────────────
router.patch('/escalas/:id/publicar', autorizar(...RH), async (req, res) => {
  // Verificar se tem violações ACT antes de publicar
  const { rows: turnos } = await query(`
    SELECT t.*, f.nome_completo FROM turno t
    JOIN funcionario f ON f.id = t.funcionario_id
    JOIN escala e ON e.id = t.escala_id
    WHERE t.escala_id=$1 AND e.empresa_id=$2
  `, [req.params.id, req.empresaId]);

  if (!turnos.length) return res.status(400).json({ error: 'Escala sem turnos — adiciona turnos antes de publicar' });

  const { rows } = await query(`
    UPDATE escala SET estado='publicado' WHERE id=$1 AND empresa_id=$2 RETURNING *
  `, [req.params.id, req.empresaId]);
  res.json(rows[0]);
});



// ── Limpar todos os turnos de uma escala ─────────────────────────────────────
router.delete('/escalas/:id/turnos', autorizar(...RH), async (req, res) => {
  const { rows: [escala] } = await query(
    'SELECT estado FROM escala WHERE id=$1 AND empresa_id=$2',
    [req.params.id, req.empresaId]
  );
  if (!escala) return res.status(404).json({ error: 'Escala não encontrada' });
  const { rowCount } = await query('DELETE FROM turno WHERE escala_id=$1', [req.params.id]);
  res.json({ ok: true, apagados: rowCount });
});

module.exports = router;
