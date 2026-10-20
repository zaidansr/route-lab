import { mkdir, readdir, readFile, writeFile, lstat, chmod } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateDeployment, validateManagedConfig, validateName, redactProfile, isDocumentationAddress } from './game-profile.mjs';

const execute = promisify(execFile), source = path.dirname(fileURLToPath(import.meta.url));
const powershell = process.env.WINDIR ? path.join(process.env.WINDIR, 'System32/WindowsPowerShell/v1.0/powershell.exe') : 'powershell.exe';
async function protect(dir) {
  if (process.platform !== 'win32') return chmod(dir, 0o700);
  await execute(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(source, 'Protect-Game-Data.ps1'), '-Path', dir], { windowsHide: true, timeout: 30000 });
}
export async function runWindowsHelper(action, parameters = {}, { elevated = false } = {}) {
  if (process.platform !== 'win32') throw new Error('Real tunnel control requires Windows');
  const script = path.join(source, elevated ? 'Invoke-Game-Action.ps1' : 'windows/RouteLab-Tunnel.ps1');
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', action];
  for (const [key, value] of Object.entries(parameters)) {
    if (!['ConfigPath', 'TunnelName', 'HostAddress', 'Count', 'TimeoutMs', 'ProcessName'].includes(key)) throw new Error('Unsupported helper parameter');
    args.push(`-${key}`, String(value));
  }
  let result;
  try { result = await execute(powershell, args, { windowsHide: true, timeout: elevated ? 180000 : 45000, maxBuffer: 2 * 1024 * 1024 }); }
  catch (error) { result = { stdout: error.stdout ?? '' }; }
  try {
    const data = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
    if (!data || typeof data !== 'object' || typeof data.ok !== 'boolean') throw new Error();
    return data;
  } catch { throw new Error('Windows helper did not return a valid result; inspect local administrator approval and installation'); }
}

export async function createGameManager({ dataDir = path.join(source, '.private'), helperRunner = runWindowsHelper, secureDirectory = protect } = {}) {
  const root = path.resolve(dataDir);
  await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await lstat(root)).isSymbolicLink()) throw new Error('Private data directory cannot be a link');
  await secureDirectory(root);
  const profileRoot = path.join(root, 'profiles'); await mkdir(profileRoot, { recursive: true, mode: 0o700 });
  if ((await lstat(profileRoot)).isSymbolicLink()) throw new Error('Profile directory cannot be a link');
  let operating = null, lastAction = null, system = { ok: false, installed: false, tunnels: [], warning: 'Status not checked' }, processes = null;
  const measurements = [];
  async function load(name) {
    validateName(name); const dir = path.join(profileRoot, name);
    if ((await lstat(dir)).isSymbolicLink()) throw new Error('Managed profile cannot be a link');
    for (const child of ['client', 'server', 'profile.json']) if ((await lstat(path.join(dir, child))).isSymbolicLink()) throw new Error('Managed profile paths cannot be links');
    const profile = JSON.parse(await readFile(path.join(dir, 'profile.json'), 'utf8'));
    const configPath = path.join(dir, 'client', `${name}.conf`);
    const facts = validateManagedConfig(await readFile(configPath, 'utf8'), { expectedName: name });
    if (facts.relayEndpoint !== profile.relayEndpoint || facts.clientPublicKey !== profile.clientPublicKey || facts.serverPublicKey !== profile.serverPublicKey || JSON.stringify(facts.gameAddresses) !== JSON.stringify(profile.gameAddresses) || facts.clientAddress !== profile.clientAddress || facts.serverAddress !== profile.serverAddress) throw new Error('Profile metadata does not match its managed configuration');
    return { profile: redactProfile(profile), facts, configPath, dir };
  }
  async function profiles() {
    const values = [];
    for (const entry of await readdir(profileRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^routelab-[a-z0-9-]{1,7}$/.test(entry.name)) continue;
      try { const item = await load(entry.name); values.push({ ...item.profile, folder: item.dir, documentationOnly: isDocumentationAddress(item.profile.relayEndpoint.split(':')[0]) || item.profile.gameAddresses.some(isDocumentationAddress) }); }
      catch { values.push({ name: entry.name, invalid: true }); }
    }
    return values;
  }
  async function refresh() {
    let observed;
    try { observed = await helperRunner('status'); } catch { observed = { ok: false }; }
    if (!observed?.ok) { system = { ...system, statusConfirmed: false, warning: 'Windows tunnel status could not be confirmed' }; throw new Error('Windows tunnel status could not be confirmed'); }
    system = { ...observed, statusConfirmed: true }; return system;
  }
  async function snapshot() {
    return { application: 'RouteLab Game Connection', version: '0.2.0', laboratory: false, operating, system, profiles: await profiles(), processes, measurements: [...measurements], lastAction, scope: 'Real WireGuard destination-IP routing. All applications sending to listed IPv4 addresses use the tunnel. No process injection, automatic UDP server discovery or real-mode multipath.', prerequisites: 'An owned relay with the generated server config and allowed game destinations must be deployed before connecting.' };
  }
  async function command(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Command object required');
    const action = input.action;
    if (!['refresh', 'create', 'install', 'connect', 'disconnect', 'processes', 'measure'].includes(action)) throw new Error('Unknown game connection action');
    if (operating) throw new Error('Another operation is in progress');
    operating = action;
    let outcome;
    try {
      let result;
      if (action === 'refresh') result = await refresh();
      if (action === 'create') {
        if ((await readdir(profileRoot)).length >= 128) throw new Error('Managed profile capacity reached');
        const generated = generateDeployment(input.deployment);
        const name = generated.profile.name, dir = path.join(profileRoot, name);
        await mkdir(dir, { mode: 0o700 });
        await mkdir(path.join(dir, 'client'), { mode: 0o700 }); await mkdir(path.join(dir, 'server'), { mode: 0o700 });
        for (const [filename, content] of [[`client/${name}.conf`, generated.clientConfig], [`server/${name}.conf`, generated.serverConfig], ['server/game-ips.txt', generated.destinations], ['profile.json', JSON.stringify(generated.profile, null, 2) + '\n']]) await writeFile(path.join(dir, filename), content, { flag: 'wx', mode: 0o600 });
        result = { ok: true, name, folder: dir, profile: redactProfile(generated.profile), nextStep: 'Deploy server files to your owned Linux relay using relay-server/README.md. Then connect this profile.' };
      }
      if (action === 'install') { result = await helperRunner('install', {}, { elevated: true }); if (result.ok) await refresh(); }
      if (action === 'disconnect') {
        const name = validateName(input.name);
        result = await helperRunner('disconnect', { TunnelName: name }, { elevated: true });
        try { await refresh(); } catch { /* Keep the operation result and explicit unknown status. */ }
      }
      if (['connect', 'measure'].includes(action)) {
        const item = await load(input.name);
        if (action === 'connect') {
          if (isDocumentationAddress(item.profile.relayEndpoint.split(':')[0]) || item.profile.gameAddresses.some(isDocumentationAddress)) throw new Error('Documentation addresses cannot be used for a live connection');
          await refresh();
          if (system.tunnels?.some(tunnel => tunnel.service === 'Running')) throw new Error('Disconnect the existing RouteLab tunnel before connecting another profile');
          result = await helperRunner('connect', { ConfigPath: item.configPath, TunnelName: item.profile.name }, { elevated: true });
          outcome = result;
          try { await refresh(); } catch { system = { ...system, warning: 'Refresh failed after connection attempt; inspect Windows tunnel status' }; }
          if (result.tunnel) system = { ...system, tunnels: [...(system.tunnels ?? []).filter(tunnel => tunnel.name !== item.profile.name), result.tunnel] };
        }
        if (action === 'measure') {
          const host = input.host;
          if (![...item.profile.gameAddresses, item.profile.serverAddress].includes(host)) throw new Error('Measure only a destination in this profile');
          if (isDocumentationAddress(host)) throw new Error('Documentation destinations cannot be measured');
          await refresh();
          const connected = system.tunnels?.some(tunnel => tunnel.name === item.profile.name && tunnel.service === 'Running');
          if (system.tunnels?.some(tunnel => tunnel.name !== item.profile.name && tunnel.service === 'Running')) throw new Error('Disconnect other RouteLab tunnels before recording this profile baseline');
          if (host === item.profile.serverAddress && !connected) throw new Error('Connect before probing the relay tunnel address');
          result = await helperRunner('measure', { HostAddress: host, Count: 10, TimeoutMs: 700 });
          if (result.ok) { measurements.push({ ...result, name: item.profile.name, route: connected ? 'tunnel' : 'direct', at: new Date().toISOString() }); if (measurements.length > 40) measurements.shift(); }
        }
      }
      if (action === 'processes') {
        if (input.filter !== undefined && (typeof input.filter !== 'string' || input.filter.length > 80 || /[\r\n\0]/.test(input.filter))) throw new Error('Invalid process filter');
        result = await helperRunner('processes', input.filter ? { ProcessName: input.filter } : {}); processes = result;
      }
      if (!result?.ok) throw new Error(result?.error ?? 'Operation did not complete');
      lastAction = { action, ok: true, at: new Date().toISOString(), message: result.nextStep ?? 'Completed' };
      return result;
    } catch (error) { lastAction = { action, ok: false, at: new Date().toISOString(), message: error.message, ...(outcome ? { rollback: outcome.rollback === true, rollbackSucceeded: outcome.rollbackSucceeded === true, handshakeVerified: outcome.handshakeVerified === true } : {}) }; throw error; }
    finally { operating = null; }
  }
  return { snapshot, command, refresh, profileRoot };
}
