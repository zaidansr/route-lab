import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGameManager } from '../game-manager.mjs';
import { startGameMode } from '../game-mode.mjs';

const input = { name: 'routelab-game', relayEndpoint: '45.79.10.10:51820', gameAddresses: ['45.79.10.20'] };
async function fixture(overrides = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'routelab-test-'));
  const calls = [], runtime = { installed: true, tunnels: [] };
  const helperRunner = async (action, params, options) => {
    calls.push({ action, params, options });
    if (action === 'status') return { ok: true, ...runtime };
    if (action === 'connect') return { ok: true, handshakeVerified: true, tunnel: { name: params.TunnelName, service: 'Running', peers: [] } };
    return { ok: true, action };
  };
  return { dir, calls, runtime, options: { dataDir: dir, secureDirectory: async () => {}, helperRunner, ...overrides }, async cleanup() { const safe = path.resolve(dir); if (path.dirname(safe) !== path.resolve(os.tmpdir()) || !path.basename(safe).startsWith('routelab-test-')) throw new Error('Unsafe test cleanup path'); await rm(safe, { recursive: true, force: true }); } };
}
test('Game manager writes private paired configuration and returns only public profile details', async () => {
  const f = await fixture();
  try {
    const manager = await createGameManager(f.options);
    const result = await manager.command({ action: 'create', deployment: input });
    const config = await readFile(path.join(result.folder, 'client/routelab-game.conf'), 'utf8');
    assert.match(config, /PrivateKey = /);
    const secret = config.match(/PrivateKey = (.+)/)[1];
    const state = await manager.snapshot();
    assert.equal(state.profiles.length, 1);
    assert.equal(JSON.stringify(state).includes(secret), false);
    assert.doesNotMatch(JSON.stringify(result), /PrivateKey|PresharedKey/);
    await assert.rejects(manager.command({ action: 'create', deployment: input }), /exist/i);
    await assert.rejects(manager.command({ action: 'connect', name: '../escape' }), /Profile name/);
    await assert.rejects(manager.command({ action: 'measure', name: input.name, host: '127.0.0.1' }), /only a destination/);
    const connected = await manager.command({ action: 'connect', name: input.name });
    assert.equal(connected.handshakeVerified, true);
    assert.ok(f.calls.some(call => call.action === 'connect' && call.options.elevated === true));
    await unlink(path.join(result.folder, 'client/routelab-game.conf'));
    await manager.command({ action: 'disconnect', name: input.name });
    assert.ok(f.calls.some(call => call.action === 'disconnect' && call.params.TunnelName === input.name), 'Disconnect must work when its profile is damaged');
  } finally { await f.cleanup(); }
});
test('Failed Windows status cannot be mistaken for no tunnel or a direct baseline', async () => {
  let healthy = true;
  const f = await fixture({ helperRunner: async () => healthy ? { ok: true, installed: true, tunnels: [{ name: input.name, service: 'Running' }] } : { ok: false, error: 'Access denied' } });
  try {
    const manager = await createGameManager(f.options);
    await manager.command({ action: 'create', deployment: input });
    await manager.refresh(); healthy = false;
    await assert.rejects(manager.command({ action: 'measure', name: input.name, host: input.gameAddresses[0] }), /could not be confirmed/);
    await assert.rejects(manager.command({ action: 'connect', name: input.name }), /could not be confirmed/);
    const state = await manager.snapshot();
    assert.equal(state.system.tunnels[0].service, 'Running');
    assert.equal(state.system.statusConfirmed, false);
    assert.equal(state.measurements.length, 0);
  } finally { await f.cleanup(); }
});
test('Game manager preserves unsuccessful rollback state and refuses documentation endpoints', async () => {
  const f = await fixture({ helperRunner: async action => action === 'connect' ? { ok: false, error: 'Rollback could not be confirmed', rollback: true, rollbackSucceeded: false, tunnel: { name: input.name, service: 'Running', peers: [] } } : { ok: true, installed: true, tunnels: [] } });
  try {
    const manager = await createGameManager(f.options);
    await manager.command({ action: 'create', deployment: input });
    await assert.rejects(manager.command({ action: 'connect', name: input.name }), /Rollback/);
    const state = await manager.snapshot();
    assert.equal(state.lastAction.rollbackSucceeded, false);
    assert.equal(state.system.tunnels[0].service, 'Running');
    await manager.command({ action: 'create', deployment: { ...input, name: 'routelab-doc', relayEndpoint: '203.0.113.10:51820' } });
    await assert.rejects(manager.command({ action: 'connect', name: 'routelab-doc' }), /Documentation/);
  } finally { await f.cleanup(); }
});
test('Real-mode dashboard serves asynchronous status and never includes configuration secrets', { timeout: 10000 }, async () => {
  const f = await fixture(); let mode;
  try {
    mode = await startGameMode({ dashboardPort: 0, ...f.options });
    const html = await (await fetch(mode.url)).text(); assert.match(html, /Real network connection/);
    const { controlToken } = await (await fetch(mode.url + '/api/session')).json();
    const create = await fetch(mode.url + '/api/control', { method: 'POST', headers: { Origin: mode.url, 'Content-Type': 'application/json', 'X-RouteLab-Control': controlToken }, body: JSON.stringify({ action: 'create', deployment: input }) });
    assert.equal(create.status, 200);
    const state = await (await fetch(mode.url + '/api/status')).json();
    assert.equal(state.application, 'RouteLab Game Connection');
    assert.equal(state.profiles.length, 1);
    assert.equal(state.system.installed, true);
    assert.doesNotMatch(JSON.stringify(state), /PrivateKey|PresharedKey/);
    const invalid = await fetch(mode.url + '/api/control', { method: 'POST', headers: { Origin: mode.url, 'Content-Type': 'application/json', 'X-RouteLab-Control': controlToken }, body: JSON.stringify({ action: 'arbitrary-shell', command: 'echo no' }) });
    assert.equal(invalid.status, 400);
  } finally { if (mode) await mode.close(); await f.cleanup(); }
});
