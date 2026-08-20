'use strict';
const http = require('http');

const BASE = 'http://localhost:3001/api';
let token = null;
let resultados = { passou: 0, falhou: 0, erros: [] };

// ── HTTP helper ───────────────────────────────────────────────────────────────
function req(method, path, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'localhost', port: 3001,
      path: `/api${path}`, method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const r = http.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, data: d }); }
      });
    });
    r.on('error', e => resolve({ status: 0, data: e.message }));
    if (data) r.write(data);
    r.end();
  });
}

// ── Teste individual ──────────────────────────────────────────────────────────
async function teste(nome, fn) {
  try {
    const ok = await fn();
    if (ok) {
      console.log(`  ✅ ${nome}`);
      resultados.passou++;
    } else {
      console.log(`  ❌ ${nome}`);
      resultados.falhou++;
      resultados.erros.push(nome);
    }
  } catch(e) {
    console.log(`  ❌ ${nome} — ${e.message}`);
    resultados.falhou++;
    resultados.erros.push(`${nome}: ${e.message}`);
  }
}

async function correr() {
  console.log('\n🧪 NexEdge — Testes Automáticos\n');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // ── AUTH ──────────────────────────────────────────────────────────────────
  console.log('📋 AUTH');
  await teste('Login com credenciais correctas', async () => {
    const r = await req('POST', '/auth/login', { email: 'admin@techsol.pt', password: 'Admin@2025!' });
    if (r.status === 200 && r.data.access_token) { token = r.data.access_token; return true; }
    return false;
  });
  await teste('Login com credenciais erradas retorna 401', async () => {
    const r = await req('POST', '/auth/login', { email: 'admin@techsol.pt', password: 'errada' });
    return r.status === 401;
  });
  await teste('GET /auth/me retorna utilizador', async () => {
    const r = await req('GET', '/auth/me');
    return r.status === 200 && r.data.email === 'admin@techsol.pt';
  });

  // ── COLABORADORES ─────────────────────────────────────────────────────────
  console.log('\n📋 COLABORADORES');
  await teste('Listar colaboradores', async () => {
    const r = await req('GET', '/funcionarios');
    return r.status === 200 && (r.data.funcionarios?.length > 0 || r.data.dados?.length > 0 || r.data.length > 0);
  });
  await teste('Dashboard', async () => {
    const r = await req('GET', '/dashboard/resumo');
    return r.status === 200;
  });

  // ── FÉRIAS ────────────────────────────────────────────────────────────────
  console.log('\n📋 FÉRIAS');
  await teste('Listar pedidos de férias', async () => {
    const r = await req('GET', '/ferias');
    return r.status === 200;
  });

  // ── SALÁRIOS ──────────────────────────────────────────────────────────────
  console.log('\n📋 SALÁRIOS');
  await teste('Listar recibos', async () => {
    const r = await req('GET', '/salarios');
    return r.status === 200;
  });

  // ── FATURAÇÃO ─────────────────────────────────────────────────────────────
  console.log('\n📋 FATURAÇÃO');
  await teste('Listar faturas', async () => {
    const r = await req('GET', '/faturacao');
    return r.status === 200;
  });
  await teste('Listar clientes', async () => {
    const r = await req('GET', '/clientes');
    return r.status === 200;
  });

  // ── CRM ───────────────────────────────────────────────────────────────────
  console.log('\n📋 CRM');
  await teste('Dashboard CRM', async () => {
    const r = await req('GET', '/crm/dashboard');
    return r.status === 200 && r.data.stats;
  });
  await teste('Listar empresas CRM', async () => {
    const r = await req('GET', '/crm/empresas');
    return r.status === 200 && Array.isArray(r.data);
  });
  await teste('Listar oportunidades', async () => {
    const r = await req('GET', '/crm/oportunidades');
    return r.status === 200 && Array.isArray(r.data);
  });
  await teste('Listar tarefas CRM', async () => {
    const r = await req('GET', '/crm/tarefas');
    return r.status === 200 && Array.isArray(r.data);
  });
  await teste('Criar empresa CRM', async () => {
    const r = await req('POST', '/crm/empresas', { nome: 'Empresa Teste Auto', setor: 'Tecnologia' });
    return r.status === 201 && r.data.id;
  });

  // ── TICKETS ───────────────────────────────────────────────────────────────
  console.log('\n📋 TICKETS');
  await teste('Listar tickets', async () => {
    const r = await req('GET', '/tickets');
    return r.status === 200 && Array.isArray(r.data);
  });
  let ticketId;
  await teste('Criar ticket', async () => {
    const r = await req('POST', '/tickets', {
      titulo: 'Ticket de Teste Automático',
      descricao: 'Criado por testes automáticos',
      categoria: 'geral', prioridade: 'normal'
    });
    if (r.status === 201) { ticketId = r.data.id; return true; }
    return false;
  });
  await teste('Ver detalhe do ticket', async () => {
    if (!ticketId) return false;
    const r = await req('GET', `/tickets/${ticketId}`);
    return r.status === 200 && r.data.id === ticketId;
  });

  // ── ASSINATURAS ───────────────────────────────────────────────────────────
  console.log('\n📋 ASSINATURAS DIGITAIS');
  await teste('Listar documentos', async () => {
    const r = await req('GET', '/assinaturas');
    return r.status === 200 && Array.isArray(r.data);
  });
  let docId;
  await teste('Criar documento', async () => {
    const r = await req('POST', '/assinaturas', {
      titulo: 'Contrato Teste Automático',
      tipo: 'contrato',
      conteudo_html: '<p>Conteúdo de teste</p>'
    });
    if (r.status === 201) { docId = r.data.id; return true; }
    return false;
  });
  await teste('Adicionar signatário', async () => {
    if (!docId) return false;
    const r = await req('POST', `/assinaturas/${docId}/signatarios`, {
      nome: 'Signatário Teste', email: 'teste@nexedge.pt', cargo: 'Director'
    });
    return r.status === 201;
  });

  // ── FATURAÇÃO RECORRENTE ──────────────────────────────────────────────────
  console.log('\n📋 FATURAÇÃO RECORRENTE');
  await teste('Listar serviços recorrentes', async () => {
    const r = await req('GET', '/recorrente');
    return r.status === 200 && Array.isArray(r.data);
  });

  // ── SAAS ──────────────────────────────────────────────────────────────────
  console.log('\n📋 SAAS');
  await teste('Ver planos disponíveis', async () => {
    const r = await req('GET', '/saas/planos');
    return r.status === 200 && r.data.length >= 3;
  });
  await teste('Ver subscrição actual', async () => {
    const r = await req('GET', '/saas/subscricao');
    return r.status === 200;
  });
  await teste('Listar add-ons', async () => {
    const r = await req('GET', '/addons');
    return r.status === 200 && Array.isArray(r.data);
  });

  // ── COMPLIANCE ────────────────────────────────────────────────────────────
  console.log('\n📋 COMPLIANCE');
  await teste('Alertas legais', async () => {
    const r = await req('GET', '/alertas');
    return r.status === 200;
  });
  await teste('SAF-T — tipos disponíveis', async () => {
    const r = await req('GET', '/saft/tipos');
    return r.status === 200 || r.status === 404;
  });

  // ── AT ────────────────────────────────────────────────────────────────────
  console.log('\n📋 INTEGRAÇÃO AT');
  await teste('Validar NIF válido (509876543)', async () => {
    const r = await req('GET', '/at/validar-nif/509876543');
    return r.status === 200 && r.data.valido === true;
  });
  await teste('Validar NIF inválido (000000000)', async () => {
    const r = await req('GET', '/at/validar-nif/000000000');
    return r.status === 200 && r.data.valido === false;
  });

  // ── MY NEXEDGE ────────────────────────────────────────────────────────────
  console.log('\n📋 MY NEXEDGE');
  await teste('Notificações', async () => {
    const r = await req('GET', '/tickets/notificacoes/minhas');
    return r.status === 200 && Array.isArray(r.data);
  });
  await teste('Faturas SaaS', async () => {
    const r = await req('GET', '/saas/facturas');
    return r.status === 200 && Array.isArray(r.data);
  });

  // ── RESULTADO FINAL ───────────────────────────────────────────────────────
  const total = resultados.passou + resultados.falhou;
  const pct = Math.round((resultados.passou / total) * 100);

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`\n📊 RESULTADO: ${resultados.passou}/${total} testes passaram (${pct}%)\n`);

  if (resultados.erros.length > 0) {
    console.log('❌ Falhas:');
    resultados.erros.forEach(e => console.log(`   • ${e}`));
  } else {
    console.log('🎉 Todos os testes passaram!');
  }
  console.log('');
}

correr().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
