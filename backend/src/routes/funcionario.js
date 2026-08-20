'use strict';
const ADMIN = ['admin_empresa','admin_plataforma','rh','diretor'];
const router = require('express').Router();
const { query } = require('../config/database');
const { criarErro } = require('../middleware/errorHandler');
const multer = require('multer');
const ExcelJS = require('exceljs');
const uploadExcel = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const ctrl   = require('../controllers/funcionarioController');
const { autenticar, autorizar } = require('../middleware/auth');
const { middlewareAuditoria }   = require('../middleware/auditoria');

const RH_PLUS = ['admin_empresa','admin_plataforma','rh','diretor'];

router.use(autenticar, middlewareAuditoria);
router.get('/',           ctrl.listar);

// GET template-importacao
router.get('/template-importacao', async (req, res) => {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Funcionarios');
  ws.columns = [{header:'Nome Completo',key:'a',width:25},{header:'Cargo',key:'b',width:20},{header:'Email Empresa',key:'c',width:28},{header:'NIF',key:'d',width:12},{header:'NISS',key:'e',width:14},{header:'Departamento',key:'f',width:22},{header:'Salario Base',key:'g',width:14},{header:'Data Admissao',key:'h',width:16},{header:'Tipo Contrato',key:'i',width:18},{header:'Estado Civil',key:'j',width:22},{header:'Num Dependentes',key:'k',width:16}];
  ws.getRow(1).eachCell(cell => { cell.font={bold:true,color:{argb:'FFFFFFFF'}}; cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF185FA5'}}; });
  ws.addRow(['Ana Silva','Gestora RH','ana.silva@empresa.pt','123456789','12345678901','Recursos Humanos','1800','2024-01-15','sem_termo','casado_unico_titular','2']);
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition','attachment; filename="template.xlsx"');
  await wb.xlsx.write(res);
  res.end();
});
// GET /funcionarios/me — dados do funcionário logado
router.get('/me', async (req, res) => {
  const { rows: [f] } = await query(
    'SELECT * FROM funcionario WHERE utilizador_id=$1 AND empresa_id=$2',
    [req.utilizador.id, req.empresaId]
  );
  if (!f) return res.status(404).json({ error: 'Funcionário não encontrado para este utilizador.' });
  res.json(f);
});


// GET /funcionarios/exportar — exportar lista para Excel
router.get('/exportar', autorizar(...RH_PLUS), async (req, res) => {
  const ExcelJS = require('exceljs');
  const { rows } = await require('../config/database').query(
    `SELECT f.nome_completo, f.cargo, f.email_empresa, f.nif, f.niss,
            d.nome AS departamento, f.salario_base, f.data_admissao,
            f.tipo_contrato, f.estado
     FROM funcionario f
     LEFT JOIN departamento d ON d.id = f.departamento_id
     WHERE f.empresa_id=$1 AND f.estado = 'ativo'
     ORDER BY f.nome_completo`,
    [req.empresaId]
  );
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Funcionários');
  ws.columns = [
    {header:'Nome',key:'nome_completo',width:25},
    {header:'Cargo',key:'cargo',width:20},
    {header:'Email',key:'email_empresa',width:28},
    {header:'NIF',key:'nif',width:12},
    {header:'NISS',key:'niss',width:14},
    {header:'Departamento',key:'departamento',width:22},
    {header:'Salário Base',key:'salario_base',width:14},
    {header:'Data Admissão',key:'data_admissao',width:16},
    {header:'Tipo Contrato',key:'tipo_contrato',width:18},
    {header:'Estado',key:'estado',width:12},
  ];
  ws.getRow(1).eachCell(cell => {
    cell.font = {bold:true, color:{argb:'FFFFFFFF'}};
    cell.fill = {type:'pattern', pattern:'solid', fgColor:{argb:'FF185FA5'}};
  });
  rows.forEach(r => ws.addRow(r));
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition','attachment; filename="funcionarios.xlsx"');
  await wb.xlsx.write(res);
  res.end();
});

router.get('/:id',        ctrl.obter);
router.get('/:id/historico', autorizar(...RH_PLUS), ctrl.historico);
router.post('/',          autorizar(...RH_PLUS), ctrl.criar);
router.put('/:id',        autorizar(...RH_PLUS), ctrl.atualizar);

// PATCH rápido para campos do Relatório Único (CPP, qualificação, escolaridade)
router.patch('/:id/ru', autorizar(...RH_PLUS), async (req, res) => {
  const { cpp_codigo, cpp_descricao, nivel_qualificacao, nivel_escolaridade, codigo_irct } = req.body;
  const { rows } = await query(`
    UPDATE funcionario SET
      cpp_codigo = COALESCE($1, cpp_codigo),
      cpp_descricao = COALESCE($2, cpp_descricao),
      nivel_qualificacao = COALESCE($3, nivel_qualificacao),
      nivel_escolaridade = COALESCE($4, nivel_escolaridade),
      codigo_irct = COALESCE($5, codigo_irct),
      atualizado_em = NOW()
    WHERE id=$6 AND empresa_id=$7
    RETURNING id, nome_completo, cpp_codigo, cpp_descricao, nivel_qualificacao, nivel_escolaridade, codigo_irct
  `, [cpp_codigo||null, cpp_descricao||null, nivel_qualificacao||null, nivel_escolaridade||null, codigo_irct||null, req.params.id, req.empresaId]);
  if (!rows.length) return res.status(404).json({ error: 'Não encontrado' });
  res.json(rows[0]);
});

router.delete('/:id',     autorizar('admin_empresa','admin_plataforma'), ctrl.desativar);
router.delete('/:id/apagar', autorizar('admin_empresa','admin_plataforma'), ctrl.apagar);

// POST /funcionarios/:id/criar-acesso — criar utilizador ligado ao funcionário
router.post('/:id/criar-acesso', autorizar('admin_empresa','super_admin','rh','diretor'), async (req, res) => {
  try {
    const { perfil, password } = req.body;
    if (!perfil) throw criarErro('Perfil é obrigatório.', 400);

    const { rows: [f] } = await query(
      'SELECT * FROM funcionario WHERE id=$1 AND empresa_id=$2',
      [req.params.id, req.empresaId]
    );
    if (!f) throw criarErro('Funcionário não encontrado.', 404);
    const email = f.email_empresa || f.email_pessoal || `${f.id}@nexedge.internal`;

    if (f.utilizador_id) {
      await query('UPDATE utilizador SET perfil=$1 WHERE id=$2', [perfil, f.utilizador_id]);
      return res.json({ mensagem: 'Perfil de acesso actualizado.', utilizador_id: f.utilizador_id });
    }

    const { rows: existing } = await query('SELECT id FROM utilizador WHERE email=$1', [email.toLowerCase()]);
    if (existing.length > 0) {
      await query('UPDATE funcionario SET utilizador_id=$1 WHERE id=$2', [existing[0].id, f.id]);
      await query('UPDATE utilizador SET perfil=$1 WHERE id=$2', [perfil, existing[0].id]);
      return res.json({ mensagem: 'Utilizador existente ligado.', utilizador_id: existing[0].id });
    }

    const bcrypt = require('bcryptjs');
    const pwd = password || Math.random().toString(36).slice(-8) + 'A1!';
    const hash = await bcrypt.hash(pwd, 12);

    const perfisValidos = ['funcionario','rh','supervisor','team_leader','diretor','admin_empresa','super_admin'];
    const perfilFinal = perfisValidos.includes(perfil) ? perfil : 'funcionario';
    const { rows: [u] } = await query(`
      INSERT INTO utilizador (empresa_id, nome_completo, email, password_hash, perfil, mudar_password)
      VALUES ($1,$2,$3,$4,$5,true) RETURNING id, email
    `, [req.empresaId, f.nome_completo, email.toLowerCase(), hash, perfilFinal]);

    await query('UPDATE funcionario SET utilizador_id=$1 WHERE id=$2', [u.id, f.id]);
    await req.auditar({ acao: 'ACESSO_CRIADO', tabela: 'utilizador', registoId: u.id });
    res.status(201).json({ mensagem: 'Acesso criado.', utilizador_id: u.id, email: u.email, password_temporaria: pwd });
  } catch(e) {
    console.error('criar-acesso error:', e.message);
    res.status(e.statusCode || 500).json({ error: e.message || 'Erro ao criar acesso.' });
  }
});

// DELETE /funcionarios/:id/acesso — remover acesso
router.delete('/:id/acesso', autorizar('admin_empresa','admin_plataforma','rh','diretor'), async (req, res) => {
  try {
    const { rows: [f] } = await query('SELECT utilizador_id FROM funcionario WHERE id=$1 AND empresa_id=$2', [req.params.id, req.empresaId]);
    if (!f) return res.status(404).json({ error: 'Funcionário não encontrado.' });
    if (!f.utilizador_id) return res.status(404).json({ error: 'Este funcionário não tem acesso à plataforma.' });
    await query('UPDATE funcionario SET utilizador_id=NULL WHERE id=$1', [req.params.id]);
    await query('UPDATE utilizador SET ativo=false WHERE id=$1', [f.utilizador_id]);
    res.json({ mensagem: 'Acesso removido com sucesso.' });
  } catch(e) {
    console.error('remover-acesso error:', e.message);
    res.status(500).json({ error: e.message || 'Erro ao remover acesso.' });
  }
});

// POST /funcionarios/importar — importar via Excel/CSV
router.post('/importar', autorizar(...ADMIN), uploadExcel.single('ficheiro'), async (req, res) => {
  if (!req.file) throw criarErro('Ficheiro obrigatório.', 400);
  
  try {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer);
    const ws = wb.worksheets[0];
    if (!ws) throw criarErro('Sem folha de cálculo encontrada.', 400);
    
    // Get headers from first row
    const headers = [];
    ws.getRow(1).eachCell((cell, col) => { headers[col-1] = String(cell.value || ''); });
    
    // Convert rows to objects
    const rows = [];
    ws.eachRow((row, rowNum) => {
      if (rowNum === 1) return; // skip header
      const obj = {};
      row.eachCell((cell, col) => {
        const header = headers[col-1];
        if (header) obj[header] = cell.value !== null && cell.value !== undefined ? String(cell.value) : '';
      });
      if (Object.values(obj).some(v => v)) rows.push(obj);
    });
    
    if (!rows.length) throw criarErro('Ficheiro vazio ou sem dados.', 400);
    
    const results = { criados: 0, erros: [], ignorados: 0 };
    
    // Get departamentos for lookup
    const { rows: deptos } = await query(
      'SELECT id, nome FROM departamento WHERE empresa_id=$1',
      [req.empresaId]
    );
    const deptoMap = {};
    deptos.forEach(d => deptoMap[d.nome.toLowerCase()] = d.id);
    
    for (const row of rows) {
      try {
        // Map column names (flexible - accepts PT or EN headers)
        const nome = row['Nome Completo'] || row['Nome'] || row['name'] || row['full_name'] || '';
        const cargo = row['Cargo'] || row['Função'] || row['position'] || '';
        const email = row['Email'] || row['Email Empresa'] || row['email'] || '';
        const nif = String(row['NIF'] || row['nif'] || '').replace(/\D/g, '');
        const niss = String(row['NISS'] || row['niss'] || '').replace(/\D/g, '');
        const salario = parseFloat(String(row['Salário Base'] || row['Salario'] || row['salary'] || '0').replace(',', '.')) || 0;
        const admissao = row['Data Admissão'] || row['Data Admissao'] || row['admission_date'] || new Date().toISOString().split('T')[0];
        const departamento = String(row['Departamento'] || row['department'] || '').toLowerCase();
        const tipo_contrato = row['Tipo Contrato'] || row['contract_type'] || 'sem_termo';
        const estado_civil = row['Estado Civil'] || row['marital_status'] || 'nao_casado';
        const dependentes = parseInt(row['Nº Dependentes'] || row['dependentes'] || '0') || 0;
        
        if (!nome) { results.ignorados++; continue; }
        
        // Check if already exists
        if (email) {
          const { rows: exists } = await query(
            'SELECT id FROM funcionario WHERE email_empresa=$1 AND empresa_id=$2',
            [email.toLowerCase(), req.empresaId]
          );
          if (exists.length) { results.ignorados++; continue; }
        }
        
        // Get depto ID
        const departamento_id = deptoMap[departamento] || null;
        
        // Generate numero_funcionario
        const { rows: [{ count }] } = await query(
          'SELECT COUNT(*) FROM funcionario WHERE empresa_id=$1', [req.empresaId]
        );
        const num = String(parseInt(count) + results.criados + 1).padStart(4, '0');
        
        // Parse date (fallback to today if missing/invalid)
        let dataAdmissao = new Date().toISOString().split('T')[0];
        if (admissao) {
          const d = new Date(admissao);
          if (!isNaN(d)) dataAdmissao = d.toISOString().split('T')[0];
        }
        
        await query(`
          INSERT INTO funcionario (
            empresa_id, departamento_id, numero_funcionario, nome_completo, cargo,
            email_empresa, nif, niss, salario_base, subsidio_alimentacao,
            tipo_subsidio_alimentacao, estado_civil, num_dependentes,
            data_admissao, tipo_contrato, estado,
            horas_semanais, dias_ferias_ano, dias_ferias_saldo, num_cc, nacionalidade
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,6.15,'dinheiro',$10,$11,$12,$13,'ativo',40,22,22,'00000000','PT')
        `, [
          req.empresaId, departamento_id, num, nome, cargo,
          email.toLowerCase() || null, nif || null, niss || null,
          salario || 870,
          estado_civil, dependentes,
          dataAdmissao, tipo_contrato || 'sem_termo'
        ]);
        
        results.criados++;
      } catch(e) {
        results.erros.push({ linha: rows.indexOf(row) + 2, erro: e.message });
      }
    }
    
    res.json({
      mensagem: `Importação concluída: ${results.criados} criados, ${results.ignorados} ignorados, ${results.erros.length} erros`,
      ...results
    });
  } catch(e) {
    throw criarErro('Erro ao processar ficheiro: ' + e.message, 400);
  }
});



module.exports = router;
