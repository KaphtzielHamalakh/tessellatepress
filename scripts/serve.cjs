const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.wasm': 'application/wasm' };
function createServer() {
  return http.createServer((request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
      if (!file.startsWith(root + path.sep) && file !== root) { response.writeHead(403).end(); return; }
      const stat = fs.statSync(file);
      if (stat.isDirectory() && !url.pathname.endsWith('/')) { response.writeHead(301, { Location: url.pathname + '/' }).end(); return; }
      const target = stat.isDirectory() ? path.join(file, 'index.html') : file;
      response.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      fs.createReadStream(target).pipe(response);
    } catch { response.writeHead(404).end('Not found'); }
  });
}
module.exports = { createServer };
if (require.main === module) createServer().listen(4173, '127.0.0.1', () => console.log('http://localhost:4173/freecomicreader/'));
