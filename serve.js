// Local development server for SunoForge
// Run: node serve.js
// Then open: http://localhost:8080
const http = require('http');
const fs = require('fs');
const path = require('path');

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

http.createServer((req, res) => {
    const filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' });
        res.end(data);
    });
}).listen(PORT, () => console.log(`SunoForge running at http://localhost:${PORT}`));
