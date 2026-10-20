#!/usr/bin/env node
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import { startDemo } from './demo.mjs';
import { createGateway } from './gateway.mjs';
import { createRelay } from './relay.mjs';
import { createExit } from './exit.mjs';
import { startGameMode } from './game-mode.mjs';

function parse(args) {
  const result = { command: args[0] ?? 'help' };
  const allowed = new Set(['config', 'dir', 'dashboard-port', 'app-port', 'port', 'mode', 'duration-ms', 'no-dashboard']);
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    if (!flag.startsWith('--') || !allowed.has(flag.slice(2))) throw new Error(`Unknown option ${flag}`);
    const name = flag.slice(2);
    if (name === 'no-dashboard') result[name] = true;
    else { if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Value required for ${flag}`); result[name] = args[++i]; }
  }
  return result;
}
function port(value, fallback) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error('Port must be an integer between 0 and 65535');
  return n;
}
function keyFrom(config) {
  const hex = process.env.ROUTELAB_KEY ?? config.keyHex;
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('A 32-byte key is required as keyHex or ROUTELAB_KEY (64 hex characters)');
  return Buffer.from(hex, 'hex');
}
async function configFrom(filename) {
  if (!filename) throw new Error('Supply --config FILE');
  const text = await readFile(filename, 'utf8');
  if (text.length > 65536) throw new Error('Configuration exceeds 64 KiB');
  const config = JSON.parse(text);
  if (!config || Array.isArray(config) || typeof config !== 'object') throw new Error('Configuration must be a JSON object');
  return config;
}
async function waitForShutdown(service, durationMs) {
  let resolve;
  const stopped = new Promise(r => { resolve = r; });
  let finishing = false;
  const stop = async () => {
    if (finishing) return;
    finishing = true;
    clearTimeout(timer);
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    try { await service.close(); } finally { resolve(); }
  };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const timer = durationMs ? setTimeout(stop, durationMs) : undefined;
  await stopped;
}
async function init(dir) {
  const output = path.resolve(dir ?? 'config');
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output);
  const keyHex = randomBytes(32).toString('hex');
  const configs = {
    'gateway.json': { bind: { host: '127.0.0.1', port: 38000 }, relays: [{ id: 'a', name: 'Path A', host: '127.0.0.1', port: 39001 }, { id: 'b', name: 'Path B', host: '127.0.0.1', port: 39002 }], mode: 'adaptive', keyHex },
    'relay-a.json': { bind: { host: '127.0.0.1', port: 39001 }, upstream: { host: '127.0.0.1', port: 39003 }, simulation: { delayMs: 0, lossRate: 0 }, keyHex },
    'relay-b.json': { bind: { host: '127.0.0.1', port: 39002 }, upstream: { host: '127.0.0.1', port: 39003 }, simulation: { delayMs: 0, lossRate: 0 }, keyHex },
    'exit.json': { bind: { host: '127.0.0.1', port: 39003 }, target: { host: '127.0.0.1', port: 39004 }, keyHex },
  };
  for (const [name, config] of Object.entries(configs)) {
    await writeFile(path.join(output, name), JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(`Created ${path.join(output, name)}`);
  }
  await writeFile(path.join(output, '.gitignore'), '*\n!.gitignore\n', { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  console.log('These files contain a shared secret. Keep them private; use only destinations and hosts you control.');
}

async function main() {
  const options = parse(process.argv.slice(2));
  if (options.command === 'help' || options.command === '--help') {
    console.log(`RouteLab 0.2.0 — independent opt-in UDP research prototype\n\nCommands:\n  node cli.mjs demo [--dashboard-port 8765] [--app-port 38000] [--mode adaptive|duplicate]\n  node cli.mjs init [--dir config]\n  node cli.mjs gateway --config config/gateway.json\n  node cli.mjs relay --config config/relay-a.json\n  node cli.mjs exit --config config/exit.json\n  node cli.mjs echo [--port 39004]\n\nDemo uses only loopback, simulated path conditions and a generated key.\nIt does not intercept games, load drivers, change routes, or use ExitLag.\nPress Ctrl+C to stop services. See README.md for remote relay deployment.`);
    console.log('Real connection mode: node cli.mjs games [--dashboard-port 8766]. See GAME-MODE.md.');
    return;
  }
  if (options.command === 'init') return init(options.dir);
  const durationMs = options['duration-ms'] === undefined ? undefined : Number(options['duration-ms']);
  if (durationMs !== undefined && (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > 86_400_000)) throw new Error('duration-ms must be between 1 and 86400000');
  if (options.command === 'demo') {
    const demo = await startDemo({ dashboardPort: port(options['dashboard-port'], 8765), appPort: port(options['app-port'], 38000), mode: options.mode ?? 'adaptive', dashboard: !options['no-dashboard'] });
    console.log(`RouteLab is running.\nDashboard: ${demo.url ?? 'disabled'}\nOpt-in UDP endpoint: ${demo.snapshot().endpoints.app}\nControlled loopback echo traffic is active. Press Ctrl+C to stop.`);
    await waitForShutdown(demo, durationMs);
    return;
  }
  if (options.command === 'games') {
    const gameMode = await startGameMode({ dashboardPort: port(options['dashboard-port'], 8766) });
    console.log(`RouteLab game connection: ${gameMode.url}\nReal WireGuard client controls; an owned relay and explicit game-server IPs are required.\nUse Disconnect before closing the dashboard when a tunnel is active. Press Ctrl+C to close the dashboard.`);
    await waitForShutdown(gameMode, durationMs);
    return;
  }
  if (options.command === 'echo') {
    const socket = dgram.createSocket('udp4');
    socket.on('error', error => console.error(`Echo socket: ${error.message}`));
    socket.on('message', (msg, from) => socket.send(msg, from.port, from.address, () => {}));
    await new Promise((resolve, reject) => { socket.once('error', reject); socket.bind(port(options.port, 39004), '127.0.0.1', resolve); });
    console.log(`Owned test echo target: 127.0.0.1:${socket.address().port}`);
    await waitForShutdown({ close: () => new Promise(resolve => socket.close(resolve)) }, durationMs);
    return;
  }
  const config = await configFrom(options.config);
  const key = keyFrom(config);
  let service;
  if (options.command === 'gateway') service = await createGateway({ ...config, key });
  else if (options.command === 'relay') service = await createRelay({ ...config, key });
  else if (options.command === 'exit') service = await createExit({ ...config, key });
  else throw new Error(`Unknown command ${options.command}`);
  console.log(`RouteLab ${options.command} listening on ${service.address().address}:${service.address().port}. Press Ctrl+C to stop.`);
  await waitForShutdown(service, durationMs);
}

main().catch(error => { console.error(`RouteLab: ${error.message}`); process.exitCode = 1; });
