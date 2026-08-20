'use strict';
const router = require('express').Router();
const { autenticar, autorizar } = require('../middleware/auth');
const { query } = require('../config/database');
// ssh2 não disponível — SSH simulado
const multer = require('multer');
const path = require('path');
const fs = require('fs');

router.use(autenticar, autorizar('super_admin'));

// VPS pré-configurada
const VPS = {
  host: '185.32.189.233',
  hostname: 'server.nexedge.pt',
  port: 22,
  username: 'nextedge',
};

// Upload temporário
const upload = multer({ dest: '/tmp/deploy_uploads/' });
if (!fs.existsSync('/tmp/deploy_uploads/')) fs.mkdirSync('/tmp/deploy_uploads/', { recursive: true });

// ── Executar comando SSH ──────────────────────────────────────────────────────
function executarSSH(password, comando) {
  return new Promise((resolve, reject) => {
    return res.status(503).json({ error: 'SSH não disponível neste ambiente. Use o terminal da VPS directamente.' });
    let output = '';
    let erro = '';

    conn.on('ready', () => {
      conn.exec(comando, (err, stream) => {
        if (err) { conn.end(); return reject(err); }
        stream.on('data', d => output += d.toString());
        stream.stderr.on('data', d => erro += d.toString());
        stream.on('close', (code) => {
          conn.end();
          resolve({ output: output || erro, code, sucesso: code === 0 });
        });
      });
    });

    conn.on('error', err => reject(err));

    conn.connect({
      host: VPS.host,
      port: VPS.port,
      username: VPS.username,
      password,
      readyTimeout: 15000,
    });
  });
}

// ── Upload de ficheiro via SFTP ───────────────────────────────────────────────
function uploadSFTP(password, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    return res.status(503).json({ error: 'SSH não disponível neste ambiente. Use o terminal da VPS directamente.' });

    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) { conn.end(); return reject(err); }
        sftp.fastPut(localPath, remotePath, (err) => {
          conn.end();
          if (err) return reject(err);
          resolve({ sucesso: true, remotePath });
        });
      });
    });

    conn.on('error', err => reject(err));
    conn.connect({ host: VPS.host, port: VPS.port, username: VPS.username, password, readyTimeout: 15000 });
  });
}

// ── Registar log ──────────────────────────────────────────────────────────────
async function log(adminId, tipo, comando, output, sucesso) {
  await query(`INSERT INTO infra_log (super_admin_id, tipo, comando, output, sucesso) VALUES ($1,$2,$3,$4,$5)`,
    [adminId, tipo, comando, output?.substring(0,2000)||'', sucesso]).catch(()=>{});
}

// ── Info da VPS ───────────────────────────────────────────────────────────────
router.get('/vps-info', async (req, res) => {
  res.json({ ...VPS, configurada: true });
});

// ── Estado do sistema local ───────────────────────────────────────────────────
router.get('/status', async (req, res) => {
  try {
    const uptime = process.uptime();
    const h = Math.floor(uptime/3600), m = Math.floor((uptime%3600)/60);
    const mem = process.memoryUsage();
    const { rows:[bdStats] } = await query(`SELECT
      pg_size_pretty(pg_database_size(current_database())) AS tamanho_bd,
      (SELECT COUNT(*) FROM empresa WHERE ativo=true) AS empresas_activas,
      (SELECT COUNT(*) FROM utilizador WHERE ativo=true) AS utilizadores_activos,
      (SELECT COUNT(*) FROM funcionario WHERE estado='ativo') AS colaboradores_activos`);
    res.json({
      servidor: { uptime:`${h}h ${m}m`, node_version:process.version,
        memoria_usada:`${Math.round(mem.heapUsed/1024/1024)}MB`,
        memoria_total:`${Math.round(mem.heapTotal/1024/1024)}MB`,
        ambiente:process.env.NODE_ENV, porta:process.env.PORT||3001 },
      bd: bdStats, vps: VPS, timestamp: new Date().toISOString(),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ── Comandos de sistema local (BD) ────────────────────────────────────────────
router.post('/comando', async (req, res) => {
  try {
    const { tipo } = req.body;

    const COMANDOS = {
      'contar_registos': async () => {
        const { rows:[r] } = await query(`SELECT
          (SELECT COUNT(*) FROM empresa WHERE ativo=true) AS empresas,
          (SELECT COUNT(*) FROM utilizador WHERE ativo=true) AS utilizadores,
          (SELECT COUNT(*) FROM funcionario WHERE estado='ativo') AS colaboradores,
          (SELECT COUNT(*) FROM fatura) AS faturas,
          (SELECT COUNT(*) FROM log_auditoria) AS logs_auditoria`);
        return JSON.stringify(r, null, 2);
      },
      'stats_bd': async () => {
        const { rows } = await query(`
          SELECT tablename,
            pg_size_pretty(pg_total_relation_size(quote_ident(schemaname)||'.'||quote_ident(tablename))) AS tamanho
          FROM pg_tables WHERE schemaname='public'
          ORDER BY pg_total_relation_size(quote_ident(schemaname)||'.'||quote_ident(tablename)) DESC
          LIMIT 15`);
        return rows.map(r => `${r.tablename}: ${r.tamanho}`).join('\n');
      },
      'limpar_cache': async () => {
        const { rowCount } = await query("DELETE FROM log_auditoria WHERE criado_em < NOW() - INTERVAL '90 days'");
        return `${rowCount} registos de auditoria removidos (>90 dias)`;
      },
      'verificar_emails_pendentes': async () => {
        const { rows } = await query(`SELECT empresa_id, COUNT(*) as total FROM notificacao WHERE lida=false GROUP BY empresa_id ORDER BY total DESC LIMIT 10`);
        return rows.length ? rows.map(r => `Empresa ${r.empresa_id}: ${r.total}`).join('\n') : 'Nenhuma pendente';
      },
    };

    if (!COMANDOS[tipo]) return res.status(400).json({ error: `Comando '${tipo}' não reconhecido` });

    const output = await COMANDOS[tipo]();
    await log(req.utilizador.id, 'comando', tipo, output, true);
    res.json({ output, sucesso: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Executar comando SSH na VPS ───────────────────────────────────────────────
router.post('/ssh/executar', async (req, res) => {
  try {
    const { password, comando } = req.body;
    if (!password) return res.status(400).json({ error: 'Password SSH obrigatória' });
    if (!comando) return res.status(400).json({ error: 'Comando obrigatório' });

    // Bloquear comandos perigosos
    const BLOQUEADOS = ['rm -rf /', 'mkfs', 'dd if=/dev/zero', ':(){:|:&};:'];
    if (BLOQUEADOS.some(b => comando.includes(b))) {
      return res.status(403).json({ error: 'Comando bloqueado por segurança' });
    }

    const resultado = await executarSSH(password, comando);
    await log(req.utilizador.id, 'ssh', comando, resultado.output, resultado.sucesso);

    res.json(resultado);
  } catch(e) {
    await log(req.utilizador.id, 'ssh', req.body.comando, e.message, false);
    res.status(500).json({ error: `Erro SSH: ${e.message}` });
  }
});

// ── Comandos pré-definidos ────────────────────────────────────────────────────
router.post('/ssh/comando-rapido', async (req, res) => {
  try {
    const { password, tipo } = req.body;
    if (!password) return res.status(400).json({ error: 'Password SSH obrigatória' });

    const COMANDOS = {
      'status_servidor': 'uptime && free -h && df -h / && echo "---" && pm2 status 2>/dev/null || echo "PM2 não instalado"',
      'logs_backend': 'pm2 logs nexedge-prod --lines 50 --nostream 2>/dev/null || journalctl -u nexedge -n 50 --no-pager 2>/dev/null || echo "Sem logs disponíveis"',
      'restart_backend': 'pm2 restart nexedge-prod 2>/dev/null && echo "✅ Backend reiniciado" || echo "❌ Erro ao reiniciar"',
      'restart_nginx': 'sudo systemctl reload nginx && echo "✅ Nginx recarregado" || echo "❌ Erro nginx"',
      'status_nginx': 'sudo systemctl status nginx --no-pager',
      'espaco_disco': 'df -h && du -sh /var/www/nexedge-prod/ 2>/dev/null || du -sh /var/www/ 2>/dev/null',
      'memoria_cpu': 'free -h && echo "---CPU---" && top -bn1 | head -15',
      'certificado_ssl': 'sudo certbot certificates 2>/dev/null || echo "Certbot não instalado"',
      'pm2_status': 'pm2 status && pm2 describe nexedge-prod 2>/dev/null',
      'pm2_monit': 'pm2 describe nexedge-prod 2>/dev/null',
      'backup_manual': 'pg_dump -U nexedge nexedge_producao > /tmp/backup_$(date +%Y%m%d_%H%M).sql && echo "✅ Backup criado em /tmp/" 2>/dev/null || echo "Configurar credenciais BD"',
      'testar_bd': 'psql -U nexedge -d nexedge_producao -c "SELECT COUNT(*) as empresas FROM empresa;" 2>/dev/null || echo "Configurar acesso BD"',
      'versao_node': 'node --version && npm --version && pm2 --version 2>/dev/null',
      'ip_portas': 'netstat -tlnp 2>/dev/null || ss -tlnp',
      'ultimos_logins': 'last -n 10',
    };

    const cmd = COMANDOS[tipo];
    if (!cmd) return res.status(400).json({ error: `Comando '${tipo}' não encontrado` });

    const resultado = await executarSSH(password, cmd);
    await log(req.utilizador.id, 'comando_rapido', tipo, resultado.output, resultado.sucesso);

    res.json({ ...resultado, comando: cmd });
  } catch(e) {
    await log(req.utilizador.id, 'comando_rapido', req.body.tipo, e.message, false);
    res.status(500).json({ error: `Erro SSH: ${e.message}` });
  }
});

// ── Upload de ficheiro para deploy ────────────────────────────────────────────
router.post('/deploy/upload', upload.single('ficheiro'), async (req, res) => {
  try {
    const { password, destino } = req.body;
    if (!password) return res.status(400).json({ error: 'Password SSH obrigatória' });
    if (!req.file) return res.status(400).json({ error: 'Ficheiro obrigatório' });

    const localPath = req.file.path;
    const nomeFicheiro = req.file.originalname;

    // Destinos permitidos
    const DESTINOS = {
      'backend': '/tmp/nexedge_deploy/',
      'frontend': '/tmp/nexedge_deploy/',
      'migracao': '/tmp/nexedge_deploy/',
      'custom': '/tmp/nexedge_deploy/',
    };

    const pastaRemota = DESTINOS[destino] || '/tmp/nexedge_deploy/';

    // Criar pasta remota
    await executarSSH(password, `mkdir -p ${pastaRemota}`);

    // Upload do ficheiro
    const remotePath = `${pastaRemota}${nomeFicheiro}`;
    await uploadSFTP(password, localPath, remotePath);

    // Limpar ficheiro local
    fs.unlinkSync(localPath);

    await log(req.utilizador.id, 'upload', `${nomeFicheiro} → ${remotePath}`, 'Upload concluído', true);

    res.json({
      sucesso: true,
      ficheiro: nomeFicheiro,
      remotePath,
      message: `Ficheiro enviado para ${remotePath}`,
    });
  } catch(e) {
    if (req.file?.path) fs.unlinkSync(req.file.path).catch(()=>{});
    await log(req.utilizador.id, 'upload', req.file?.originalname||'?', e.message, false);
    res.status(500).json({ error: `Erro upload: ${e.message}` });
  }
});

// ── Deploy completo (upload + executar) ───────────────────────────────────────
router.post('/deploy/executar', async (req, res) => {
  try {
    const { password, tipo } = req.body;
    if (!password) return res.status(400).json({ error: 'Password SSH obrigatória' });

    const PASTA = '/var/www/nexedge-prod';
    const DEPLOY = '/tmp/nexedge_deploy';

    const DEPLOYS = {
      // ── Só frontend ────────────────────────────────────────────────────────
      'frontend': `
echo "🚀 Deploy Frontend..."
echo "📁 Ficheiros em ${DEPLOY}:"
ls -lh ${DEPLOY}/ 2>/dev/null || echo "Pasta vazia"
echo ""
echo "🗑️  A limpar frontend antigo (preserva uploads)..."
find ${PASTA}/public/ -not -path '*/uploads*' -not -path '${PASTA}/public/' -delete 2>/dev/null
echo "📦 A extrair novo frontend..."
cd ${DEPLOY} && unzip -o nexedge_frontend.zip -d ${PASTA}/public/ 2>/dev/null \
  && echo "✅ Frontend extraído com sucesso" \
  || echo "❌ ERRO: nexedge_frontend.zip não encontrado em ${DEPLOY}"
echo "🔄 A recarregar Nginx..."
sudo systemctl reload nginx 2>/dev/null && echo "✅ Nginx recarregado" || systemctl reload nginx 2>/dev/null && echo "✅ OK"
echo ""
echo "🎉 Deploy Frontend concluído!"
echo "🌐 Verificar em: https://app.nexedge.pt"
`.trim(),

      // ── Só backend (rotas/services) ────────────────────────────────────────
      'backend_rota': `
echo "🚀 Deploy Backend (ficheiros de rota)..."
echo "📁 Ficheiros em ${DEPLOY}:"
ls -lh ${DEPLOY}/*.js 2>/dev/null || echo "Sem ficheiros .js"
echo ""
echo "📦 A copiar ficheiros de rota..."
for f in ${DEPLOY}/src/routes/*.js; do
  [ -f "$f" ] && cp "$f" ${PASTA}/backend/src/routes/ && echo "✅ $(basename $f)"
done
for f in ${DEPLOY}/src/services/*.js; do
  [ -f "$f" ] && cp "$f" ${PASTA}/backend/src/services/ && echo "✅ $(basename $f)"
done
for f in ${DEPLOY}/src/controllers/*.js; do
  [ -f "$f" ] && cp "$f" ${PASTA}/backend/src/controllers/ && echo "✅ $(basename $f)"
done
echo ""
echo "🔄 A reiniciar backend..."
pm2 restart nexedge-prod 2>/dev/null && echo "✅ Backend reiniciado" || echo "⚠️ PM2 não encontrado"
pm2 logs nexedge-prod --lines 5 --nostream 2>/dev/null
echo ""
echo "🎉 Deploy Backend concluído!"
`.trim(),

      // ── Backend completo (servidor novo) ───────────────────────────────────
      'backend_completo': `
echo "🚀 Deploy Backend Completo..."
echo "📁 Ficheiros em ${DEPLOY}:"
ls -lh ${DEPLOY}/ 2>/dev/null
echo ""
echo "📦 A extrair servidor..."
cd ${DEPLOY} && unzip -o nexedge_servidor.zip -d ${DEPLOY}/servidor_novo/ 2>/dev/null \
  && echo "✅ Extraído" || echo "❌ nexedge_servidor.zip não encontrado"
echo ""
echo "📂 A copiar para produção..."
cp -r ${DEPLOY}/servidor_novo/src/* ${PASTA}/backend/src/ 2>/dev/null && echo "✅ Código copiado"
echo ""
echo "📦 A instalar dependências..."
cd ${PASTA}/backend && npm install --production 2>/dev/null && echo "✅ npm install OK"
echo ""
echo "🔄 A reiniciar backend..."
pm2 restart nexedge-prod 2>/dev/null && echo "✅ Backend reiniciado" || echo "⚠️ PM2 não encontrado"
sleep 3
pm2 logs nexedge-prod --lines 10 --nostream 2>/dev/null
echo ""
echo "🎉 Deploy Backend Completo concluído!"
`.trim(),

      // ── Migrações BD ──────────────────────────────────────────────────────
      'migracao': `
echo "🚀 A correr migrações..."
echo "📁 Ficheiros de migração em ${DEPLOY}:"
ls -lh ${DEPLOY}/migrate_*.js 2>/dev/null || echo "Sem migrações encontradas"
ls -lh ${DEPLOY}/*.js 2>/dev/null | grep -v seed | grep -v testes
echo ""
TOTAL=0; SUCESSO=0; ERRO=0
for f in ${DEPLOY}/migrate_*.js; do
  [ -f "$f" ] || continue
  TOTAL=$((TOTAL+1))
  echo "▶ A correr $(basename $f)..."
  if cd ${PASTA}/backend && node "$f" 2>&1; then
    echo "✅ $(basename $f) — OK"
    SUCESSO=$((SUCESSO+1))
  else
    echo "❌ $(basename $f) — ERRO"
    ERRO=$((ERRO+1))
  fi
  echo ""
done
echo "━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Total: $TOTAL | ✅ $SUCESSO | ❌ $ERRO"
`.trim(),

      // ── Deploy completo (frontend + backend + migrações) ──────────────────
      'completo': `
echo "🚀 DEPLOY COMPLETO NEXEDGE"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📁 Ficheiros disponíveis em ${DEPLOY}:"
ls -lh ${DEPLOY}/ 2>/dev/null
echo ""

echo "1️⃣  MIGRAÇÕES BD..."
for f in ${DEPLOY}/migrate_*.js; do
  [ -f "$f" ] && cd ${PASTA}/backend && node "$f" 2>&1 && echo "✅ $(basename $f)" || echo "⚠️ $(basename $f)"
done
echo ""

echo "2️⃣  FRONTEND..."
find ${PASTA}/public/ -not -path '*/uploads*' -not -path '${PASTA}/public/' -delete 2>/dev/null
cd ${DEPLOY} && unzip -o nexedge_frontend.zip -d ${PASTA}/public/ 2>/dev/null \
  && echo "✅ Frontend OK" || echo "⚠️ nexedge_frontend.zip não encontrado"
echo ""

echo "3️⃣  BACKEND (código)..."
[ -f "${DEPLOY}/nexedge_servidor.zip" ] \
  && cd ${DEPLOY} && unzip -o nexedge_servidor.zip -d ${DEPLOY}/srv/ 2>/dev/null \
  && cp -r ${DEPLOY}/srv/src/* ${PASTA}/backend/src/ 2>/dev/null \
  && cd ${PASTA}/backend && npm install --production 2>/dev/null \
  && echo "✅ Backend código OK" || echo "⚠️ nexedge_servidor.zip não encontrado — a copiar ficheiros individuais..."
for f in ${DEPLOY}/*.js; do
  bn=$(basename $f)
  case $bn in
    migrate_*|seed*|testes*) continue ;;
  esac
done
echo ""

echo "4️⃣  REINICIAR SERVIÇOS..."
pm2 restart nexedge-prod 2>/dev/null && echo "✅ PM2 reiniciado" || echo "⚠️ PM2"
sudo systemctl reload nginx 2>/dev/null && echo "✅ Nginx recarregado" || echo "⚠️ Nginx"
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🎉 DEPLOY COMPLETO CONCLUÍDO!"
echo "🌐 https://app.nexedge.pt"
sleep 3
pm2 logs nexedge-prod --lines 5 --nostream 2>/dev/null
`.trim(),

      // ── Só reiniciar serviços ──────────────────────────────────────────────
      'reiniciar': `
echo "🔄 A reiniciar serviços..."
pm2 restart nexedge-prod 2>/dev/null && echo "✅ Backend reiniciado" || echo "⚠️ PM2"
sudo systemctl reload nginx 2>/dev/null && echo "✅ Nginx recarregado" || echo "⚠️ Nginx"
sleep 2
pm2 status 2>/dev/null
echo ""
echo "✅ Serviços reiniciados!"
`.trim(),

      // ── Limpar ficheiros temporários ───────────────────────────────────────
      'limpar_deploy': `
echo "🗑️  A limpar pasta de deploy..."
ls -lh ${DEPLOY}/ 2>/dev/null
rm -rf ${DEPLOY}/* 2>/dev/null && echo "✅ Pasta limpa"
mkdir -p ${DEPLOY}
echo "📁 Pasta ${DEPLOY} pronta para novos ficheiros"
`.trim(),
    };

    const cmd = DEPLOYS[tipo];
    if (!cmd) return res.status(400).json({ error: `Tipo de deploy '${tipo}' não encontrado` });

    const resultado = await executarSSH(password, cmd);
    await log(req.utilizador.id, 'deploy', tipo, resultado.output, resultado.sucesso);

    res.json({ ...resultado, tipo });
  } catch(e) {
    await log(req.utilizador.id, 'deploy', req.body.tipo, e.message, false);
    res.status(500).json({ error: `Erro deploy: ${e.message}` });
  }
});

// ── KPIs globais ──────────────────────────────────────────────────────────────
router.get('/kpis', async (req, res) => {
  try {
    const { rows:[kpis] } = await query(`SELECT
      (SELECT COUNT(*) FROM empresa WHERE ativo=true) AS empresas_activas,
      (SELECT COUNT(*) FROM empresa WHERE ativo=false) AS empresas_suspensas,
      (SELECT COUNT(*) FROM empresa WHERE plano='starter' AND ativo=true) AS plano_starter,
      (SELECT COUNT(*) FROM empresa WHERE plano='growth' AND ativo=true) AS plano_growth,
      (SELECT COUNT(*) FROM empresa WHERE plano='pro' AND ativo=true) AS plano_pro,
      (SELECT COUNT(*) FROM empresa WHERE plano='enterprise' AND ativo=true) AS plano_enterprise,
      (SELECT COUNT(*) FROM utilizador WHERE ativo=true) AS total_utilizadores,
      (SELECT COUNT(*) FROM funcionario WHERE estado='ativo') AS total_colaboradores,
      (SELECT COUNT(*) FROM fatura WHERE EXTRACT(YEAR FROM data_emissao)=EXTRACT(YEAR FROM NOW())) AS faturas_ano,
      (SELECT COALESCE(SUM(total),0) FROM fatura WHERE EXTRACT(YEAR FROM data_emissao)=EXTRACT(YEAR FROM NOW())) AS volume_faturacao,
      0 AS em_trial`);
    const { rows: crescimento } = await query(`SELECT DATE_TRUNC('month', criado_em) AS mes, COUNT(*) AS novas
      FROM empresa WHERE criado_em >= NOW() - INTERVAL '6 months' GROUP BY mes ORDER BY mes`);
    res.json({ kpis, crescimento });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Empresas ──────────────────────────────────────────────────────────────────
router.get('/empresas', async (req, res) => {
  try {
    const { rows } = await query(`SELECT e.*,
      COUNT(DISTINCT u.id) AS total_utilizadores,
      COUNT(DISTINCT f.id) FILTER (WHERE f.estado='ativo') AS total_colaboradores,
      COALESCE(SUM(fa.total) FILTER (WHERE EXTRACT(YEAR FROM fa.data_emissao)=EXTRACT(YEAR FROM NOW())),0) AS faturacao_ano
      FROM empresa e
      LEFT JOIN utilizador u ON u.empresa_id = e.id
      LEFT JOIN funcionario f ON f.empresa_id = e.id
      LEFT JOIN fatura fa ON fa.empresa_id = e.id
      GROUP BY e.id ORDER BY e.criado_em DESC`);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.patch('/empresas/:id/toggle', async (req, res) => {
  try {
    const { rows:[emp] } = await query('UPDATE empresa SET ativo=NOT ativo WHERE id=$1 RETURNING id,nome,ativo', [req.params.id]);
    await log(req.utilizador.id, 'empresa', `toggle:${emp.nome}`, emp.ativo?'activada':'suspensa', true);
    res.json(emp);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.patch('/empresas/:id/plano', async (req, res) => {
  try {
    const { plano } = req.body;
    const { rows:[emp] } = await query('UPDATE empresa SET plano=$1 WHERE id=$2 RETURNING id,nome,plano', [plano, req.params.id]);
    await log(req.utilizador.id, 'empresa', `plano:${emp.nome}→${plano}`, 'OK', true);
    res.json(emp);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.patch('/empresas/:id/extender-trial', async (req, res) => {
  try {
    const { dias=14 } = req.body;
    const { rows:[emp] } = await query(`UPDATE empresa SET trial_fim=GREATEST(COALESCE(trial_fim,NOW()),NOW())+INTERVAL '${parseInt(dias)} days' WHERE id=$1 RETURNING id,nome,trial_fim`, [req.params.id]);
    res.json(emp);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Logs ──────────────────────────────────────────────────────────────────────
router.get('/historico', async (req, res) => {
  try {
    const { rows } = await query(`SELECT il.*, u.nome_completo AS admin_nome FROM infra_log il
      LEFT JOIN utilizador u ON u.id = il.super_admin_id ORDER BY il.criado_em DESC LIMIT 100`);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/logs', async (req, res) => {
  try {
    const { tipo='auditoria', limite=50 } = req.query;
    if (tipo === 'auditoria') {
      const { rows } = await query(`SELECT la.*, u.nome_completo, u.email FROM log_auditoria la
        LEFT JOIN utilizador u ON u.id = la.utilizador_id ORDER BY la.criado_em DESC LIMIT $1`, [parseInt(limite)]);
      return res.json(rows);
    }
    if (tipo === 'infra') {
      const { rows } = await query(`SELECT il.*, u.nome_completo AS admin_nome FROM infra_log il
        LEFT JOIN utilizador u ON u.id = il.super_admin_id ORDER BY il.criado_em DESC LIMIT $1`, [parseInt(limite)]);
      return res.json(rows);
    }
    res.json([]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
