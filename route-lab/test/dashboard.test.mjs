import assert from 'node:assert/strict';
import http from 'node:http';
import { createDashboard } from '../dashboard.mjs';
import test from 'node:test';

test("Dashboard enforces Host, origin and control-token boundaries", { timeout: 20000 }, async () => {

let invoked = 0;
const server = await createDashboard({ port: 0, getStatus: () => ({ application: 'RouteLab', laboratory: true }), command: () => { invoked++; return { ok: true }; } });
try {
  const page = await fetch(server.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /RouteLab/);
  const status = await (await fetch(`${server.url}/api/status`)).json();
  assert.equal(status.application, 'RouteLab');
  const { controlToken } = await (await fetch(`${server.url}/api/session`)).json();
  const post = headers => fetch(`${server.url}/api/control`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ action: 'mode', mode: 'adaptive' }) });
  assert.equal((await post({})).status, 403);
  assert.equal((await post({ Origin: 'https://example.invalid', 'X-RouteLab-Control': controlToken })).status, 403);
  assert.equal((await post({ Origin: server.url, 'X-RouteLab-Control': 'wrong' })).status, 403);
  assert.equal((await post({ Origin: server.url, 'X-RouteLab-Control': controlToken })).status, 200);
  assert.equal(invoked, 1);
  const hostStatus = await new Promise((resolve, reject) => {
    const request = http.get(`${server.url}/api/status`, { headers: { Host: 'example.invalid' }, agent: false }, response => {
      response.resume(); response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
  });
  assert.equal(hostStatus, 403);
  console.log(JSON.stringify({ dashboard: 'passed', httpRendering: true, statusApi: true, sameOriginAndTokenControls: true, hostValidation: true, externalNetwork: false }));
} finally { await server.close(); }

});
