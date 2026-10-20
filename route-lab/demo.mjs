import dgram from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createGateway } from './gateway.mjs';
import { createRelay } from './relay.mjs';
import { createExit } from './exit.mjs';
import { createDashboard } from './dashboard.mjs';

const bind = socket => new Promise((resolve, reject) => {
  socket.once('error', reject);
  socket.bind(0, '127.0.0.1', () => { socket.removeListener('error', reject); resolve(); });
});
const closeSocket = socket => new Promise(resolve => { try { socket.close(resolve); } catch { resolve(); } });

export async function startDemo({ dashboardPort = 8765, appPort = 38000, mode = 'adaptive', dashboard = true } = {}) {
  const resources = [];
  let trafficTimer;
  let stopping = false;
  const key = randomBytes(32);
  const echo = dgram.createSocket('udp4');
  echo.on('error', () => {});
  let targetPackets = 0;
  echo.on('message', (msg, rinfo) => { targetPackets++; echo.send(msg, rinfo.port, rinfo.address, () => {}); });
  await bind(echo);
  resources.push({ close: () => closeSocket(echo) });
  try {
    const exit = await createExit({ bind: { host: '127.0.0.1', port: 0 }, target: { host: '127.0.0.1', port: echo.address().port }, key });
    resources.push(exit);
    const relayA = await createRelay({ bind: { host: '127.0.0.1', port: 0 }, upstream: { host: '127.0.0.1', port: exit.address().port }, key, simulation: { delayMs: 20, lossRate: 0 } });
    resources.push(relayA);
    const relayB = await createRelay({ bind: { host: '127.0.0.1', port: 0 }, upstream: { host: '127.0.0.1', port: exit.address().port }, key, simulation: { delayMs: 80, lossRate: 0 } });
    resources.push(relayB);
    const gateway = await createGateway({ bind: { host: '127.0.0.1', port: appPort }, relays: [
      { id: 'a', name: 'Path A', host: '127.0.0.1', port: relayA.address().port },
      { id: 'b', name: 'Path B', host: '127.0.0.1', port: relayB.address().port },
    ], key, mode });
    resources.push(gateway);
    const client = dgram.createSocket('udp4');
    client.on('error', () => {});
    await bind(client);
    resources.push({ close: () => closeSocket(client) });
    const pending = new Map();
    let sequence = 0;
    let paused = false;
    const app = { sent: 0, received: 0, timedOut: 0, rttMs: null, lastRttMs: null, bytesReceived: 0 };
    const samples = [];
    client.on('message', msg => {
      try {
        const data = JSON.parse(msg.toString());
        const start = pending.get(data.sequence);
        if (start === undefined) return;
        pending.delete(data.sequence);
        const rtt = performance.now() - start;
        app.received++; app.bytesReceived += msg.length; app.lastRttMs = rtt;
        app.rttMs = app.rttMs === null ? rtt : app.rttMs * 0.8 + rtt * 0.2;
        samples.push({ at: Date.now(), rttMs: Math.round(rtt * 10) / 10 });
        if (samples.length > 90) samples.shift();
      } catch { /* Only the generated lab payloads contribute to demo metrics. */ }
    });
    trafficTimer = setInterval(() => {
      const now = performance.now();
      for (const [id, start] of pending) if (now - start > 2000) { pending.delete(id); app.timedOut++; }
      if (paused || pending.size >= 64 || !gateway.snapshot().paths.some(path => path.healthy)) return;
      const id = ++sequence;
      const payload = Buffer.from(JSON.stringify({ sequence: id, source: 'RouteLab controlled echo traffic' }));
      pending.set(id, now); app.sent++;
      client.send(payload, gateway.address().port, '127.0.0.1', error => { if (error && pending.delete(id)) app.timedOut++; });
    }, 250);
    const status = () => ({
      application: 'RouteLab', version: '0.2.0', laboratory: true,
      topology: 'gateway → entry relay(s) → common exit → owned loopback echo target',
      gateway: gateway.snapshot(),
      relays: [{ id: 'a', ...relayA.snapshot() }, { id: 'b', ...relayB.snapshot() }],
      exit: exit.snapshot(),
      demo: { ...app, paused, pending: pending.size, targetPackets, samples },
      endpoints: { app: `127.0.0.1:${gateway.address().port}`, dashboard: web?.url ?? null },
      scope: 'Opt-in UDP only. No game interception, driver loading, system-route changes or ExitLag integration.',
    });
    const presets = {
      baseline: [{ delayMs: 20, lossRate: 0 }, { delayMs: 80, lossRate: 0 }],
      degradeA: [{ delayMs: 180, lossRate: 0.25 }, { delayMs: 40, lossRate: 0 }],
      dropA: [{ delayMs: 20, lossRate: 1 }, { delayMs: 40, lossRate: 0 }],
    };
    const control = async input => {
      if (input.action === 'mode') gateway.setMode(input.mode);
      else if (input.action === 'preset' && presets[input.name]) {
        relayA.setSimulation(presets[input.name][0]); relayB.setSimulation(presets[input.name][1]);
      } else if (input.action === 'traffic' && typeof input.paused === 'boolean') paused = input.paused;
      else throw new Error('Unknown control action');
      return { ok: true };
    };
    let web;
    if (dashboard) {
      web = await createDashboard({ port: dashboardPort, getStatus: status, command: control });
      resources.push(web);
    }
    return {
      gateway, exit, relays: [relayA, relayB], url: web?.url ?? null,
      snapshot: status, control,
      async close() {
        if (stopping) return;
        stopping = true; clearInterval(trafficTimer);
        for (const item of resources.reverse()) await item.close();
        pending.clear();
      },
    };
  } catch (error) {
    clearInterval(trafficTimer);
    for (const item of resources.reverse()) { try { await item.close(); } catch {} }
    throw error;
  }
}
