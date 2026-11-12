import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handler } from './src/app.js';

const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function serveStatic(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  const relative = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  try {
    const file = await readFile(join(PUBLIC_DIR, relative));
    res.writeHead(200, { 'Content-Type': TYPES[extname(relative)] || 'application/octet-stream' });
    res.end(file);
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  const isDynamic = pathname.startsWith('/api') || pathname.startsWith('/web/');
  if (!isDynamic && req.method === 'GET' && (await serveStatic(req, res))) return;
  return handler(req, res);
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, () => console.log(`Clinic booking running at http://localhost:${port}`));
