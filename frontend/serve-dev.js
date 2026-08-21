const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const DIST = path.join(__dirname, 'dist');
const API_HOST = 'localhost';
const API_PORT = 3001;
const PORT = 5173;

const mime = {
  '.html':'text/html', '.js':'application/javascript',
  '.css':'text/css', '.json':'application/json',
  '.png':'image/png', '.svg':'image/svg+xml',
  '.ico':'image/x-icon', '.webp':'image/webp',
  '.woff2':'font/woff2', '.webmanifest':'application/manifest+json',
};

http.createServer((req, res) => {
  const parsed = url.parse(req.url);
  const p = parsed.pathname;

  // Proxy /api e /uploads para o backend
  if (p.startsWith('/api') || p.startsWith('/uploads')) {
    const options = {
      hostname: API_HOST, port: API_PORT, path: req.url,
      method: req.method, headers: { ...req.headers, host: `${API_HOST}:${API_PORT}` },
    };
    const proxy = http.request(options, apiRes => {
      res.writeHead(apiRes.statusCode, apiRes.headers);
      apiRes.pipe(res);
    });
    proxy.on('error', () => { res.writeHead(502); res.end('API unavailable'); });
    req.pipe(proxy);
    return;
  }

  // ITSM — servir a página HTML standalone
  if (p === '/itsm' || p === '/itsm/') {
    const itsmPath = path.join(__dirname, 'itsm.html');
    if (fs.existsSync(itsmPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      fs.createReadStream(itsmPath).pipe(res);
    } else {
      res.writeHead(404); res.end('itsm.html not found');
    }
    return;
  }

  // Servir ficheiros estáticos do dist original
  let filePath = path.join(DIST, p);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(DIST, 'index.html');
  }

  const ext = path.extname(filePath);
  res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
  fs.createReadStream(filePath).pipe(res);

}).listen(PORT, () => {
  console.log(`✓ NexEdge dev server: http://localhost:${PORT}`);
  console.log(`  → /api → localhost:${API_PORT}`);
  console.log(`  → /itsm → itsm.html standalone`);
});
