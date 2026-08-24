import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const root = resolve('out');
const port = Number(process.env.FRP_WEB_SMOKE_PORT || 17400);
const csp = "default-src 'self'; script-src 'self' 'unsafe-inline'; script-src-attr 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
]);

createServer(async (request, response) => {
  response.setHeader('Content-Security-Policy', csp);
  if (request.url === '/api/auth/session') {
    response.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end('{"error":"未登录"}');
    return;
  }
  try {
    const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
    const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    const file = resolve(root, relative);
    if (file !== root && !file.startsWith(`${root}${sep}`)) throw new Error('invalid path');
    const contents = await readFile(file);
    response.writeHead(200, { 'Content-Type': contentTypes.get(extname(file)) || 'application/octet-stream' });
    response.end(contents);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('not found');
  }
}).listen(port, '127.0.0.1', () => {
  process.stdout.write(`FRP web CSP smoke server: http://127.0.0.1:${port}\n`);
});
