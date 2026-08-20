'use strict';
const router = require('express').Router();
const { autenticar, autorizar } = require('../middleware/auth');
const { query } = require('../config/database');
const multer = require('multer');
const upload = multer({ dest: '/tmp/extractos/', limits: { fileSize: 10*1024*1024 } });
const fs = require('fs');

const ADMINS = ['admin_empresa','diretor'];

// ── Parse OFX ────────────────────────────────────────────────────────────────
function parseOFX(content) {
  const movimentos = [];
  const transRegex = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi;
  let m;
  while ((m = transRegex.exec(content)) !== null) {
    const bloco = m[1];
    const get = (tag) => { const r = new RegExp(`<${tag}>([^<]+)`,'i').exec(bloco); return r?r[1].trim():''; };
    const valor = parseFloat(get('TRNAMT')||'0');
    const data = get('DTPOSTED');
    const desc = get('MEMO')||get('NAME')||'';
    const fitid = get('FITID');
    if (data && valor !== 0) {
      movimentos.push({
        data_movimento: `${data.substring(0,4)}-${data.substring(4,6)}-${data.substring(6,8)}`,
        descricao: desc,
        valor: Math.abs(valor),
        tipo: valor > 0 ? 'credito' : 'debito',
        referencia_externa: fitid,
      });
    }
  }
  return movimentos;
}

// ── Parse CSV bancário (formato genérico) ─────────────────────────────────────
function parseCSVBancario(content) {
  const linhas = content.split('\n').filter(l => l.trim());
  if (linhas.length < 2) return [];
  const movimentos = [];

  // Detectar separador
  const sep = linhas[0].includes(';') ? ';' : ',';
  const headers = linhas[0].split(sep).map(h => h.trim().toLowerCase().replace(/"/g,''));

  // Encontrar colunas
  const iData = headers.findIndex(h => h.includes('data') || h.includes('date'));
  const iDesc = headers.findIndex(h => h.includes('descri') || h.includes('memo') || h.includes('movement'));
  const iValor = headers.findIndex(h => h.includes('valor') || h.includes('amount') || h.includes('montante'));
  const iDebito = headers.findIndex(h => h.includes('debito') || h.includes('debit'));
  const iCredito = headers.findIndex(h => h.includes('credito') || h.includes('credit'));

  for (let i = 1; i < linhas.length; i++) {
    const cols = linhas[i].split(sep).map(c => c.trim().replace(/"/g,''));
    if (cols.length < 2) continue;

    let valor = 0, tipo = 'debito';

    if (iDebito >= 0 && iCredito >= 0) {
      const deb = parseFloat((cols[iDebito]||'0').replace(',','.').replace(/\s/g,'')) || 0;
      const cred = parseFloat((cols[iCredito]||'0').replace(',','.').replace(/\s/g,'')) || 0;
      if (cred > 0) { valor = cred; tipo = 'credito'; }
      else if (deb > 0) { valor = deb; tipo = 'debito'; }
      else continue;
    } else if (iValor >= 0) {
      const v = parseFloat((cols[iValor]||'0').replace(',','.').replace(/\s/g,'')) || 0;
      valor = Math.abs(v);
      tipo = v >= 0 ? 'credito' : 'debito';
    }

    if (!valor) continue;

    // Converter data
    let dataStr = iData >= 0 ? cols[iData] : '';
    if (dataStr.includes('/')) {
      const partes = dataStr.split('/');
      if (partes[0].length === 4) dataStr = `${partes[0]}-${partes[1]}-${partes[2]}`;
      else dataStr = `${partes[2]}-${partes[1]}-${partes[0]}`;
    }

    movimentos.push({
      data_movimento: dataStr || new Date().toISOString().split('T')[0],
      descricao: iDesc >= 0 ? cols[iDesc] : 'Movimento importado',
      valor,
      tipo,
      referencia_externa: `CSV-${i}`,
    });
  }
  return movimentos;
}

// ── Upload e importar extracto ────────────────────────────────────────────────
router.post('/importar', autenticar, autorizar(...ADMINS), upload.single('ficheiro'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Ficheiro obrigatório' });

    const { conta_id } = req.body;
    if (!conta_id) return res.status(400).json({ error: 'Conta bancária obrigatória' });

    // Verificar conta pertence à empresa
    const { rows:[conta] } = await query(
      'SELECT * FROM conta_bancaria WHERE id=$1 AND empresa_id=$2',
      [conta_id, req.empresaId]
    );
    if (!conta) return res.status(404).json({ error: 'Conta não encontrada' });

    const content = fs.readFileSync(req.file.path, 'utf8');
    const ext = req.file.originalname.toLowerCase();
    let movimentos = [];

    if (ext.endsWith('.ofx') || ext.endsWith('.qfx') || content.includes('<OFX>') || content.includes('<STMTTRN>')) {
      movimentos = parseOFX(content);
    } else {
      movimentos = parseCSVBancario(content);
    }

    fs.unlinkSync(req.file.path);

    if (!movimentos.length) return res.status(400).json({ error: 'Nenhum movimento encontrado no ficheiro' });

    // Inserir movimentos (ignorar duplicados pela referência)
    let importados = 0, duplicados = 0;
    for (const mv of movimentos) {
      try {
        await query(`
          INSERT INTO movimento_bancario
            (conta_id, empresa_id, data_movimento, descricao, valor, tipo, referencia_externa, importado_via, ficheiro_origem)
          VALUES ($1,$2,$3,$4,$5,$6,$7,'upload',$8)
          ON CONFLICT DO NOTHING
        `, [conta_id, req.empresaId, mv.data_movimento, mv.descricao,
            mv.valor, mv.tipo, mv.referencia_externa||null, req.file.originalname]);
        importados++;
      } catch { duplicados++; }
    }

    res.json({
      sucesso: true,
      total_ficheiro: movimentos.length,
      importados,
      duplicados,
      conta: conta.nome || conta.iban,
    });
  } catch(e) {
    if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ error: e.message });
  }
});

// ── Listar contas para upload ─────────────────────────────────────────────────
router.get('/contas', autenticar, async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT id, COALESCE(descricao, banco, iban) AS nome, iban, banco, saldo_actual FROM conta_bancaria WHERE empresa_id=$1 ORDER BY banco',
      [req.empresaId]
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Preview do ficheiro antes de importar ─────────────────────────────────────
router.post('/preview', autenticar, autorizar(...ADMINS), upload.single('ficheiro'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Ficheiro obrigatório' });
    const content = fs.readFileSync(req.file.path, 'utf8');
    const ext = req.file.originalname.toLowerCase();
    let movimentos = ext.endsWith('.ofx') || content.includes('<STMTTRN>') ? parseOFX(content) : parseCSVBancario(content);
    fs.unlinkSync(req.file.path);
    res.json({
      total: movimentos.length,
      preview: movimentos.slice(0,5),
      creditos: movimentos.filter(m=>m.tipo==='credito').length,
      debitos: movimentos.filter(m=>m.tipo==='debito').length,
      valor_total_creditos: movimentos.filter(m=>m.tipo==='credito').reduce((s,m)=>s+m.valor,0).toFixed(2),
      valor_total_debitos: movimentos.filter(m=>m.tipo==='debito').reduce((s,m)=>s+m.valor,0).toFixed(2),
    });
  } catch(e) {
    if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
