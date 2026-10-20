import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export async function createDashboard({ port = 8765, getStatus, command, pageFile = './index.html' }) {
  const page = await readFile(new URL(pageFile, import.meta.url));
  const token = randomBytes(32).toString('hex');
  let origin;
  const json = (res, status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(value));
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    try {
      if (req.headers.host !== new URL(origin).host) return json(res, 403, { error: 'Invalid Host' });
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(page);
      }
      if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, await getStatus());
      if (req.method === 'GET' && url.pathname === '/api/session') return json(res, 200, { controlToken: token });
      if (req.method !== 'POST' || url.pathname !== '/api/control') return json(res, 404, { error: 'Not found' });
      if (req.headers.origin !== origin || req.headers['content-type']?.split(';')[0] !== 'application/json') return json(res, 403, { error: 'Same-origin JSON request required' });
      const supplied = Buffer.from(String(req.headers['x-routelab-control'] ?? ''));
      const expected = Buffer.from(token);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return json(res, 403, { error: 'Invalid control token' });
      let body = '';
      for await (const chunk of req) {
        body += chunk.toString('utf8');
        if (body.length > 2048) { json(res, 413, { error: 'Request too large' }); req.destroy(); return; }
      }
      const result = await command(JSON.parse(body));
      json(res, 200, result ?? { ok: true });
    } catch (error) {
      if (!res.headersSent) json(res, 400, { error: error.message });
      else res.end();
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    url: origin,
    async close() { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); },
  };
}
