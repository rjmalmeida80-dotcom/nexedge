'use strict';
const router = require('express').Router();
const { autenticar, autorizar } = require('../middleware/auth');
const { query } = require('../config/database');

const ADMIN = ['admin_empresa', 'rh', 'diretor', 'team_leader'];
router.use(autenticar, autorizar(...ADMIN));

// Hora nocturna: 20h-7h (CT art. 266º)
const HORA_NOCT_INICIO = 20;
const HORA_NOCT_FIM = 7;
const MAJORACAO_NOCT = 25; // 25%

// ── Calcular horas nocturnas de um turno ──────────────────────────────────────
function calcularHorasNocturnas(horaInicio, horaFim) {
  const [hI, mI] = horaInicio.split(':').map(Number);
  const [hF, mF] = horaFim.split(':').map(Number);
  const inicioMin = hI * 60 + mI;
  let fimMin = hF * 60 + mF;
  if (fimMin <= inicioMin) fimMin += 24 * 60; // turno passa meia-noite

  const noctInicioMin = HORA_NOCT_INICIO * 60; // 1200
  const noctFimMin = (HORA_NOCT_FIM + 24) * 60; // 1860 (7h do dia seguinte)

  let horasNoct = 0;

  // Segmento nocturno: 20h-24h
  const seg1Inicio = Math.max(inicioMin, noctInicioMin);
  const seg1Fim = Math.min(fimMin, 24 * 60);
  if (seg1Fim > seg1Inicio) horasNoct += (seg1Fim - seg1Inicio) / 60;

  // Segmento nocturno: 0h-7h
  const seg2Inicio = Math.max(inicioMin, 0);
  const seg2Fim = Math.min(fimMin, HORA_NOCT_FIM * 60);
  if (seg2Fim > seg2Inicio && fimMin > 24 * 60) {
    horasNoct += (Math.min(fimMin - 24*60, HORA_NOCT_FIM * 60)) / 60;
  }

  return Math.round(horasNoct * 100) / 100;
}

// ══════════════════════════════════════════════════════════════════════════════
// PADRÕES DE TURNO
// ══════════════════════════════════════════════════════════════════════════════
router.get('/padroes', async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM turno_padrao WHERE empresa_id=$1 AND ativo=true ORDER BY hora_inicio',
    [req.empresaId]
  );
  res.json(rows);
});

router.post('/padroes', async (req, res) => {
  const { nome, codigo, hora_inicio, hora_fim, cor } = req.body;
  if (!nome || !hora_inicio || !hora_fim) return res.status(400).json({ error: 'Nome, hora início e fim obrigatórios' });

  const duracao = (() => {
    const [hI, mI] = hora_inicio.split(':').map(Number);
    const [hF, mF] = hora_fim.split(':').map(Number);
    let d = (hF * 60 + mF) - (hI * 60 + mI);
    if (d < 0) d += 24 * 60;
    return Math.round(d / 60 * 100) / 100;
  })();

  const horasNoct = calcularHorasNocturnas(hora_inicio, hora_fim);
  const nocturno = horasNoct > 0;

  const { rows:[p] } = await query(`
    INSERT INTO turno_padrao (empresa_id, nome, codigo, hora_inicio, hora_fim, duracao_horas, nocturno, cor)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
  `, [req.empresaId, nome, codigo||nome.substring(0,3).toUpperCase(), hora_inicio, hora_fim, duracao, nocturno, cor||'#3B82F6']);
  res.status(201).json({ ...p, horas_nocturnas: horasNoct });
});

router.delete('/padroes/:id', async (req, res) => {
  await query('UPDATE turno_padrao SET ativo=false WHERE id=$1 AND empresa_id=$2', [req.params.id, req.empresaId]);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// CICLOS DE ROTAÇÃO
// ══════════════════════════════════════════════════════════════════════════════
router.get('/ciclos', async (req, res) => {
  const { rows: ciclos } = await query(
    'SELECT * FROM turno_ciclo WHERE empresa_id=$1 AND ativo=true ORDER BY nome',
    [req.empresaId]
  );
  for (const c of ciclos) {
    const { rows: semanas } = await query(`
      SELECT tcs.*,
        p1.nome AS segunda_nome, p1.cor AS segunda_cor, p1.hora_inicio AS segunda_hi, p1.hora_fim AS segunda_hf,
        p2.nome AS terca_nome,   p2.cor AS terca_cor,   p2.hora_inicio AS terca_hi,   p2.hora_fim AS terca_hf,
        p3.nome AS quarta_nome,  p3.cor AS quarta_cor,  p3.hora_inicio AS quarta_hi,  p3.hora_fim AS quarta_hf,
        p4.nome AS quinta_nome,  p4.cor AS quinta_cor,  p4.hora_inicio AS quinta_hi,  p4.hora_fim AS quinta_hf,
        p5.nome AS sexta_nome,   p5.cor AS sexta_cor,   p5.hora_inicio AS sexta_hi,   p5.hora_fim AS sexta_hf,
        p6.nome AS sabado_nome,  p6.cor AS sabado_cor,
        p7.nome AS domingo_nome, p7.cor AS domingo_cor
      FROM turno_ciclo_semana tcs
      LEFT JOIN turno_padrao p1 ON p1.id=tcs.segunda
      LEFT JOIN turno_padrao p2 ON p2.id=tcs.terca
      LEFT JOIN turno_padrao p3 ON p3.id=tcs.quarta
      LEFT JOIN turno_padrao p4 ON p4.id=tcs.quinta
      LEFT JOIN turno_padrao p5 ON p5.id=tcs.sexta
      LEFT JOIN turno_padrao p6 ON p6.id=tcs.sabado
      LEFT JOIN turno_padrao p7 ON p7.id=tcs.domingo
      WHERE tcs.ciclo_id=$1 ORDER BY tcs.semana_num
    `, [c.id]);
    c.semanas = semanas;

    const { rows: funcionarios } = await query(`
      SELECT fc.*, f.nome_completo, f.cargo
      FROM funcionario_ciclo fc
      JOIN funcionario f ON f.id=fc.funcionario_id
      WHERE fc.ciclo_id=$1 AND fc.ativo=true
    `, [c.id]);
    c.funcionarios = funcionarios;
  }
  res.json(ciclos);
});

router.post('/ciclos', async (req, res) => {
  const { nome, descricao, num_semanas } = req.body;
  if (!nome) return res.status(400).json({ error: 'Nome obrigatório' });
  const { rows:[c] } = await query(`
    INSERT INTO turno_ciclo (empresa_id, nome, descricao, num_semanas)
    VALUES ($1,$2,$3,$4) RETURNING *
  `, [req.empresaId, nome, descricao||null, num_semanas||3]);
  res.status(201).json(c);
});

// Configurar semanas do ciclo
router.put('/ciclos/:id/semanas', async (req, res) => {
  const { semanas } = req.body; // Array de { semana_num, segunda, terca, ... }
  for (const s of semanas) {
    await query(`
      INSERT INTO turno_ciclo_semana (ciclo_id, semana_num, segunda, terca, quarta, quinta, sexta, sabado, domingo)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (ciclo_id, semana_num) DO UPDATE SET
        segunda=$3, terca=$4, quarta=$5, quinta=$6, sexta=$7, sabado=$8, domingo=$9
    `, [req.params.id, s.semana_num, s.segunda||null, s.terca||null, s.quarta||null, s.quinta||null, s.sexta||null, s.sabado||null, s.domingo||null]);
  }
  res.json({ ok: true });
});

// Atribuir colaborador a ciclo
router.post('/ciclos/:id/funcionarios', async (req, res) => {
  const { funcionario_id, data_inicio, semana_inicio } = req.body;
  await query(`
    UPDATE funcionario_ciclo SET ativo=false WHERE funcionario_id=$1 AND empresa_id=$2
  `, [funcionario_id, req.empresaId]);
  const { rows:[fc] } = await query(`
    INSERT INTO funcionario_ciclo (funcionario_id, empresa_id, ciclo_id, data_inicio, semana_inicio)
    VALUES ($1,$2,$3,$4,$5) RETURNING *
  `, [funcionario_id, req.empresaId, req.params.id, data_inicio, semana_inicio||1]);
  res.status(201).json(fc);
});

// ══════════════════════════════════════════════════════════════════════════════
// GERAR ESCALA MENSAL AUTOMÁTICA
// ══════════════════════════════════════════════════════════════════════════════
router.get('/escala/:ano/:mes', async (req, res) => {
  const { ano, mes } = req.params;
  const { funcionario_id } = req.query;

  let where = 'fc.empresa_id=$1 AND fc.ativo=true';
  const params = [req.empresaId];
  if (funcionario_id) { where += ' AND fc.funcionario_id=$2'; params.push(funcionario_id); }

  const { rows: atribuicoes } = await query(`
    SELECT fc.*, f.nome_completo, f.cargo,
      tc.nome AS ciclo_nome, tc.num_semanas
    FROM funcionario_ciclo fc
    JOIN funcionario f ON f.id=fc.funcionario_id
    JOIN turno_ciclo tc ON tc.id=fc.ciclo_id
    WHERE ${where}
  `, params);

  const escala = [];
  const numDias = new Date(ano, mes, 0).getDate();
  const DIAS_SEMANA = ['domingo','segunda','terca','quarta','quinta','sexta','sabado'];

  for (const fc of atribuicoes) {
    const { rows: semanas } = await query(`
      SELECT tcs.*,
        p1.nome AS segunda_nome, p1.cor AS segunda_cor, p1.hora_inicio AS segunda_hi, p1.hora_fim AS segunda_hf, p1.nocturno AS segunda_noct,
        p2.nome AS terca_nome,   p2.cor AS terca_cor,   p2.hora_inicio AS terca_hi,   p2.hora_fim AS terca_hf,   p2.nocturno AS terca_noct,
        p3.nome AS quarta_nome,  p3.cor AS quarta_cor,  p3.hora_inicio AS quarta_hi,  p3.hora_fim AS quarta_hf,  p3.nocturno AS quarta_noct,
        p4.nome AS quinta_nome,  p4.cor AS quinta_cor,  p4.hora_inicio AS quinta_hi,  p4.hora_fim AS quinta_hf,  p4.nocturno AS quinta_noct,
        p5.nome AS sexta_nome,   p5.cor AS sexta_cor,   p5.hora_inicio AS sexta_hi,   p5.hora_fim AS sexta_hf,   p5.nocturno AS sexta_noct,
        p6.nome AS sabado_nome,  p6.cor AS sabado_cor,  p6.hora_inicio AS sabado_hi,  p6.hora_fim AS sabado_hf,
        p7.nome AS domingo_nome, p7.cor AS domingo_cor, p7.hora_inicio AS domingo_hi, p7.hora_fim AS domingo_hf
      FROM turno_ciclo_semana tcs
      LEFT JOIN turno_padrao p1 ON p1.id=tcs.segunda
      LEFT JOIN turno_padrao p2 ON p2.id=tcs.terca
      LEFT JOIN turno_padrao p3 ON p3.id=tcs.quarta
      LEFT JOIN turno_padrao p4 ON p4.id=tcs.quinta
      LEFT JOIN turno_padrao p5 ON p5.id=tcs.sexta
      LEFT JOIN turno_padrao p6 ON p6.id=tcs.sabado
      LEFT JOIN turno_padrao p7 ON p7.id=tcs.domingo
      WHERE tcs.ciclo_id=$1 ORDER BY tcs.semana_num
    `, [fc.ciclo_id]);

    const dias = [];
    for (let d = 1; d <= numDias; d++) {
      const data = new Date(ano, mes - 1, d);
      const diaSemana = DIAS_SEMANA[data.getDay()];

      // Calcular semana do ciclo
      const dataInicio = new Date(fc.data_inicio);
      const diffDias = Math.floor((data - dataInicio) / (1000 * 60 * 60 * 24));
      const diffSemanas = Math.floor(diffDias / 7);
      const semanaIdx = ((fc.semana_inicio - 1 + diffSemanas) % fc.num_semanas + fc.num_semanas) % fc.num_semanas;
      const semana = semanas[semanaIdx];

      if (!semana) { dias.push({ dia: d, dia_semana: diaSemana, turno: null }); continue; }

      const turnoNome = semana[diaSemana + '_nome'];
      const turnoCor = semana[diaSemana + '_cor'];
      const turnoHI = semana[diaSemana + '_hi'];
      const turnoHF = semana[diaSemana + '_hf'];
      const turnoNoct = semana[diaSemana + '_noct'];

      const horasNoct = turnoHI && turnoHF ? calcularHorasNocturnas(turnoHI, turnoHF) : 0;

      dias.push({
        dia: d,
        dia_semana: diaSemana,
        data: data.toISOString().split('T')[0],
        semana_ciclo: semanaIdx + 1,
        turno: turnoNome ? {
          nome: turnoNome,
          cor: turnoCor,
          hora_inicio: turnoHI,
          hora_fim: turnoHF,
          nocturno: turnoNoct,
          horas_nocturnas: horasNoct,
        } : null,
      });
    }

    escala.push({
      funcionario_id: fc.funcionario_id,
      nome_completo: fc.nome_completo,
      cargo: fc.cargo,
      ciclo: fc.ciclo_nome,
      dias,
      total_horas_noct: dias.reduce((s,d) => s + (d.turno?.horas_nocturnas||0), 0),
    });
  }

  res.json({ ano, mes, escala });
});

// ══════════════════════════════════════════════════════════════════════════════
// SUPLEMENTOS NOCTURNOS
// ══════════════════════════════════════════════════════════════════════════════

// Calcular e registar suplementos do mês
router.post('/suplementos/calcular/:ano/:mes', async (req, res) => {
  const { ano, mes } = req.params;

  // Buscar todas as escalas do mês
  const numDias = new Date(ano, mes, 0).getDate();
  const { rows: atribuicoes } = await query(`
    SELECT fc.*, f.nome_completo, f.salario_base AS vencimento_base,
      tc.num_semanas
    FROM funcionario_ciclo fc
    JOIN funcionario f ON f.id=fc.funcionario_id
    JOIN turno_ciclo tc ON tc.id=fc.ciclo_id
    WHERE fc.empresa_id=$1 AND fc.ativo=true
  `, [req.empresaId]);

  const DIAS_SEMANA = ['domingo','segunda','terca','quarta','quinta','sexta','sabado'];
  let totalSupl = 0;
  let registos = 0;

  for (const fc of atribuicoes) {
    const { rows: semanas } = await query(
      'SELECT tcs.*, p1.hora_inicio AS segunda_hi, p1.hora_fim AS segunda_hf, p1.nocturno AS segunda_n, p2.hora_inicio AS terca_hi, p2.hora_fim AS terca_hf, p2.nocturno AS terca_n, p3.hora_inicio AS quarta_hi, p3.hora_fim AS quarta_hf, p3.nocturno AS quarta_n, p4.hora_inicio AS quinta_hi, p4.hora_fim AS quinta_hf, p4.nocturno AS quinta_n, p5.hora_inicio AS sexta_hi, p5.hora_fim AS sexta_hf, p5.nocturno AS sexta_n, p6.hora_inicio AS sabado_hi, p6.hora_fim AS sabado_hf, p7.hora_inicio AS domingo_hi, p7.hora_fim AS domingo_hf FROM turno_ciclo_semana tcs LEFT JOIN turno_padrao p1 ON p1.id=tcs.segunda LEFT JOIN turno_padrao p2 ON p2.id=tcs.terca LEFT JOIN turno_padrao p3 ON p3.id=tcs.quarta LEFT JOIN turno_padrao p4 ON p4.id=tcs.quinta LEFT JOIN turno_padrao p5 ON p5.id=tcs.sexta LEFT JOIN turno_padrao p6 ON p6.id=tcs.sabado LEFT JOIN turno_padrao p7 ON p7.id=tcs.domingo WHERE tcs.ciclo_id=$1 ORDER BY tcs.semana_num',
      [fc.ciclo_id]
    );

    const vencBase = parseFloat(fc.vencimento_base || 0);
    const valorHoraBase = vencBase > 0 ? vencBase / 30 / 8 : 0;

    for (let d = 1; d <= numDias; d++) {
      const data = new Date(ano, mes - 1, d);
      const diaSemana = DIAS_SEMANA[data.getDay()];
      const dataStr = data.toISOString().split('T')[0];

      const diffDias = Math.floor((data - new Date(fc.data_inicio)) / (1000 * 60 * 60 * 24));
      const diffSemanas = Math.floor(diffDias / 7);
      const semanaIdx = ((fc.semana_inicio - 1 + diffSemanas) % fc.num_semanas + fc.num_semanas) % fc.num_semanas;
      const semana = semanas[semanaIdx];
      if (!semana) continue;

      const hi = semana[diaSemana + '_hi'];
      const hf = semana[diaSemana + '_hf'];
      if (!hi || !hf) continue;

      const horasNoct = calcularHorasNocturnas(hi, hf);
      if (horasNoct <= 0) continue;

      const valorSupl = Math.round(valorHoraBase * horasNoct * MAJORACAO_NOCT / 100 * 100) / 100;

      await query(`
        INSERT INTO suplemento_nocturno (funcionario_id, empresa_id, data, hora_inicio, hora_fim, horas_nocturnas, valor_hora_base, majoracao_pct, valor_suplemento, mes_salario, ano_salario)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (funcionario_id, data) DO UPDATE SET horas_nocturnas=$6, valor_suplemento=$9
      `, [fc.funcionario_id, req.empresaId, dataStr, hi, hf, horasNoct, valorHoraBase, MAJORACAO_NOCT, valorSupl, parseInt(mes), parseInt(ano)]);

      totalSupl += valorSupl;
      registos++;
    }
  }

  res.json({ ano, mes, registos, total_suplementos: Math.round(totalSupl*100)/100 });
});

// Listar suplementos do mês
router.get('/suplementos/:ano/:mes', async (req, res) => {
  const { ano, mes } = req.params;
  const { rows } = await query(`
    SELECT sn.*, f.nome_completo, f.cargo
    FROM suplemento_nocturno sn
    JOIN funcionario f ON f.id=sn.funcionario_id
    WHERE sn.empresa_id=$1 AND sn.ano_salario=$2 AND sn.mes_salario=$3
    ORDER BY f.nome_completo, sn.data
  `, [req.empresaId, ano, mes]);

  // Agrupar por funcionário
  const agrupado = {};
  for (const s of rows) {
    if (!agrupado[s.funcionario_id]) {
      agrupado[s.funcionario_id] = {
        funcionario_id: s.funcionario_id,
        nome_completo: s.nome_completo,
        cargo: s.cargo,
        dias: [],
        total_horas_nocturnas: 0,
        total_suplemento: 0,
      };
    }
    agrupado[s.funcionario_id].dias.push(s);
    agrupado[s.funcionario_id].total_horas_nocturnas += parseFloat(s.horas_nocturnas||0);
    agrupado[s.funcionario_id].total_suplemento += parseFloat(s.valor_suplemento||0);
  }

  res.json({
    ano, mes,
    funcionarios: Object.values(agrupado),
    total_geral: Object.values(agrupado).reduce((s,f)=>s+f.total_suplemento,0),
  });
});

// Resumo por funcionário (para integrar no salário)
router.get('/suplementos/resumo-salario/:funcionario_id/:ano/:mes', async (req, res) => {
  const { funcionario_id, ano, mes } = req.params;
  const { rows:[resumo] } = await query(`
    SELECT
      COUNT(*) AS dias_nocturnos,
      COALESCE(SUM(horas_nocturnas),0) AS total_horas,
      COALESCE(SUM(valor_suplemento),0) AS total_suplemento,
      AVG(majoracao_pct) AS majoracao_media
    FROM suplemento_nocturno
    WHERE funcionario_id=$1 AND empresa_id=$2 AND ano_salario=$3 AND mes_salario=$4
  `, [funcionario_id, req.empresaId, ano, mes]);
  res.json(resumo);
});

module.exports = router;
