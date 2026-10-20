import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { startDemo } from '../demo.mjs';
import test from 'node:test';

test("Complete demo selects a route, fails over and deduplicates multipath", { timeout: 20000 }, async () => {

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 9000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (check()) return; await sleep(75); }
  throw new Error(`Timed out waiting for ${label}`);
}
const demo = await startDemo({ dashboardPort: 0, appPort: 0 });
const record = { observedUtc: new Date().toISOString(), scope: 'Loopback-only laboratory. No ExitLag or external endpoints.', results: {} };
try {
  await until(() => demo.snapshot().gateway.paths.every(p => p.healthy), 'both initial paths');
  await until(() => demo.snapshot().gateway.selectedPath === 'a' && demo.snapshot().demo.received >= 3, 'baseline path A and echo delivery');
  record.results.baseline = demo.snapshot();
  const page = await fetch(demo.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /RouteLab/);
  const { controlToken } = await (await fetch(`${demo.url}/api/session`)).json();
  async function control(body) {
    const response = await fetch(`${demo.url}/api/control`, { method: 'POST', headers: { Origin: demo.url, 'Content-Type': 'application/json', 'X-RouteLab-Control': controlToken }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.text());
  }
  const initialReplies = demo.snapshot().demo.received;
  await control({ action: 'preset', name: 'dropA' });
  await until(() => demo.snapshot().gateway.selectedPath === 'b' && !demo.snapshot().gateway.paths.find(p => p.id === 'a').healthy, 'path B failover');
  await until(() => demo.snapshot().demo.received > initialReplies + 3, 'continued delivery after failure');
  record.results.failover = demo.snapshot();
  await control({ action: 'preset', name: 'baseline' });
  await control({ action: 'mode', mode: 'duplicate' });
  await until(() => demo.snapshot().gateway.paths.every(p => p.healthy), 'restored duplicate paths');
  const before = demo.snapshot().demo.received;
  await until(() => demo.snapshot().demo.received >= before + 6, 'duplicate-mode deliveries');
  const state = await (await fetch(`${demo.url}/api/status`)).json();
  assert.equal(state.gateway.mode, 'duplicate');
  assert.equal(state.application, 'RouteLab');
  assert.ok(state.demo.targetPackets <= state.demo.sent, 'Target must not receive duplicate application packets');
  assert.doesNotMatch(JSON.stringify(state), /"(?:key|keyHex)"\s*:/);
  record.results.duplicate = state;
  record.passed = true;
  console.log(JSON.stringify({ passed: true, baselinePath: record.results.baseline.gateway.selectedPath, failurePath: record.results.failover.gateway.selectedPath, baselineRttMs: record.results.baseline.demo.rttMs, failoverRttMs: record.results.failover.demo.rttMs, duplicateAppSent: state.demo.sent, duplicateAppReceived: state.demo.received, targetPackets: state.demo.targetPackets, dashboard: 'passed', externalNetwork: false }));
} catch (error) {
  record.passed = false; record.error = error.message;
  throw error;
} finally {
  await demo.close();
  await writeFile(new URL('../demo-validation.json', import.meta.url), JSON.stringify(record, null, 2) + '\n');
}

});
