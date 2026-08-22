const http = require('http');
const fs = require('fs');
const path = require('path');

const DIST   = path.join(__dirname, 'dist');
const API_HOST = 'localhost';
const API_PORT = 3001;
const PORT = 5173;

const MIME = {
  '.html':'text/html','.js':'application/javascript',
  '.css':'text/css','.json':'application/json',
  '.png':'image/png','.svg':'image/svg+xml',
  '.ico':'image/x-icon','.webp':'image/webp',
  '.woff2':'font/woff2','.webmanifest':'application/manifest+json',
};

const ESPECIAIS = {
  '/itsm-app':           path.join(__dirname, 'itsm.html'),
  '/itsm-app/':          path.join(__dirname, 'itsm.html'),
  '/portal-suporte':     path.join(__dirname, 'portal-itsm.html'),
  '/portal-suporte/':    path.join(__dirname, 'portal-itsm.html'),
  '/saas-admin':         path.join(__dirname, 'saas-dashboard.html'),
  '/saas-admin/':        path.join(__dirname, 'saas-dashboard.html'),
  '/portal-cliente':     path.join(__dirname, 'portal-cliente.html'),
  '/portal-cliente/':    path.join(__dirname, 'portal-cliente.html'),
  '/chatbot-widget.js':  path.join(__dirname, 'chatbot-widget.js'),
  '/relatorios-bi':      path.join(__dirname, 'relatorios-bi.html'),
  '/relatorios-bi/':     path.join(__dirname, 'relatorios-bi.html'),
  '/projectos':          path.join(__dirname, 'projectos.html'),
  '/logistica': path.join(__dirname, 'logistica.html'),
  '/wms': path.join(__dirname, 'wms.html'),
  '/torre-controlo': path.join(__dirname, 'torre-controlo.html'),
  '/wms/': path.join(__dirname, 'wms.html'),
  '/medialoop-admin': path.join(__dirname, 'medialoop-admin.html'),
  '/senhas-admin': path.join(__dirname, 'senhas-admin.html'),
  '/quiosque': path.join(__dirname, 'quiosque.html'),
  '/ecra-senhas': path.join(__dirname, 'ecra-senhas.html'),
  '/logistica/': path.join(__dirname, 'logistica.html'),
  '/projectos/':         path.join(__dirname, 'projectos.html'),
};

http.createServer((req, res) => {
  const p = req.url.split('?')[0];

  if (p.startsWith('/api') || p.startsWith('/uploads')) {
    const opts = {
      hostname: API_HOST, port: API_PORT, path: req.url,
      method: req.method, headers: { ...req.headers, host: API_HOST+':'+API_PORT },
    };
    const proxy = http.request(opts, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    proxy.on('error', () => { res.writeHead(502); res.end('API unavailable'); });
    req.pipe(proxy);
    return;
  }

  if (ESPECIAIS[p]) {
    const f = ESPECIAIS[p];
    if (fs.existsSync(f)) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'text/html' });
      fs.createReadStream(f).pipe(res);
    } else {
      res.writeHead(404); res.end('Ficheiro nao encontrado: ' + path.basename(f));
    }
    return;
  }

  let file = path.join(DIST, p);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(DIST, 'index.html');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'text/plain' });
  fs.createReadStream(file).pipe(res);

}).listen(PORT, () => {
  console.log('NexEdge dev: http://localhost:' + PORT);
  console.log('  /itsm-app        → ITSM interno');
  console.log('  /portal-suporte  → Portal self-service');
  console.log('  /portal-cliente  → Portal do cliente');
  console.log('  /saas-admin      → SuperAdmin SaaS');
  console.log('  /chatbot-widget.js');
});
