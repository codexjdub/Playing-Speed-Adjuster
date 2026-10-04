// Minimal static server for the test page: npm run serve, then open
// http://127.0.0.1:8765/test/test-page.html
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.PORT) || 8765;
// HOST=:: also answers on localhost over IPv6, which the Firefox extension test uses as a second origin.
const hostname = process.env.HOST || '127.0.0.1';
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};
// Only the site's own files. The rest of the repo (.git, local notes, node_modules) stays private.
const isServed = (file) =>
  (file === 'index.html' || /^(dist|docs|test)[/\\]/.test(file)) && !file.split(/[/\\]/).some((part) => part.startsWith('.'));

createServer(async (req, res) => {
  let path = '';
  try {
    path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
  } catch (err) {
    res.writeHead(400, { 'content-type': 'text/plain' }).end('Bad request');
    return;
  }
  // The type comes from the file actually served, so "/" is sent as HTML rather than as a download.
  const file = path || 'index.html';
  try {
    if (!isServed(file)) throw new Error('not served');
    const body = await readFile(join(root, file));
    res.writeHead(200, {
      'content-type': types[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
      // CORS lets a page on another site fetch dist/psa.min.js while testing.
      ...(/^dist[/\\]/.test(file) ? { 'access-control-allow-origin': '*' } : {}),
    });
    res.end(body);
  } catch (err) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
}).listen(port, hostname, () => console.log(`Serving on http://127.0.0.1:${port}/test/test-page.html`));
