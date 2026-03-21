// Local development server for SunoForge
// Run: node serve.js [lm-studio-url]
// Then open: http://localhost:8080
//
// Optional: pass your LM Studio server URL as the first argument to enable the CORS proxy.
//   node serve.js http://100.100.182.117:1234
// Then set the LM Studio address in SunoForge to: http://localhost:8080/lm-proxy
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = 8080;
const MIME = {
    '.html': 'text/html',
    '.js':   'text/javascript',
    '.json': 'application/json',
    '.css':  'text/css',
    '.webp': 'image/webp',
    '.png':  'image/png',
    '.ico':  'image/x-icon',
};

// CORS proxy target — set via CLI arg, e.g. node serve.js http://100.100.182.117:1234
const LM_TARGET = process.argv[2] ? process.argv[2].replace(/\/$/, '') : null;
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

http.createServer((req, res) => {
    // ── CORS proxy: /lm-proxy/<path> → LM_TARGET/<path> ──────────────────────
    if (req.url.startsWith('/lm-proxy')) {
        if (!LM_TARGET) {
            res.writeHead(503, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'LM Studio proxy not configured. Start server with: node serve.js http://<lm-studio-ip>:<port>' }));
            return;
        }
        if (req.method === 'OPTIONS') {
            res.writeHead(204, CORS_HEADERS);
            res.end();
            return;
        }
        const targetPath = req.url.replace(/^\/lm-proxy/, '') || '/';
        const targetUrl = new URL(LM_TARGET + targetPath);
        const lib = targetUrl.protocol === 'https:' ? https : http;
        const opts = {
            hostname: targetUrl.hostname,
            port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
            path: targetUrl.pathname + targetUrl.search,
            method: req.method,
            headers: { ...req.headers, host: targetUrl.host },
        };
        const proxyReq = lib.request(opts, (proxyRes) => {
            res.writeHead(proxyRes.statusCode, { ...proxyRes.headers, ...CORS_HEADERS });
            proxyRes.pipe(res);
        });
        proxyReq.on('error', (err) => {
            res.writeHead(502, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Proxy error: ' + err.message }));
        });
        req.pipe(proxyReq);
        return;
    }

    // ── Static file serving ───────────────────────────────────────────────────
    const filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' });
        res.end(data);
    });
}).listen(PORT, () => {
    console.log(`SunoForge running at http://localhost:${PORT}`);
    if (LM_TARGET) {
        console.log(`LM Studio proxy: http://localhost:${PORT}/lm-proxy → ${LM_TARGET}`);
        console.log(`  → In SunoForge, set LM Studio address to: http://localhost:${PORT}/lm-proxy`);
    } else {
        console.log(`LM Studio proxy: disabled (pass URL as argument to enable)`);
    }
});
