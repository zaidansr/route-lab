import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const folder = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(folder, 'route-lab-relay.sh').replaceAll('\\', '/');
const candidates = [process.env.ROUTELAB_BASH, 'bash', process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git/bin/bash.exe')].filter(Boolean);
const bash = candidates.find(candidate => /GNU bash/.test(spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 10000 }).stdout ?? ''));
const environment = { ...process.env, LC_ALL: 'C', PATH: path.isAbsolute(bash ?? '') ? `${path.dirname(bash)}${path.delimiter}${process.env.PATH ?? ''}` : process.env.PATH };
const privateKey = randomBytes(32).toString('base64');
const peerKey = randomBytes(32).toString('base64');
const sharedKey = randomBytes(32).toString('base64');
const config = `# RouteLab managed relay: routelab-game\n[Interface]\nAddress = 10.203.0.1/24\nListenPort = 51820\nPrivateKey = ${privateKey}\n\n[Peer]\nPublicKey = ${peerKey}\nPresharedKey = ${sharedKey}\nAllowedIPs = 10.203.0.2/32\n`;

function runPlan({ content = config, destinations = '# games\n192.0.2.50/32\n198.51.100.40\n192.0.2.50/32\n', extra = [], action = '--plan' } = {}) {
  const temp = mkdtempSync(path.join(tmpdir(), 'routelab-relay-test-'));
  try {
    const input = path.join(temp, 'server.conf');
    const list = path.join(temp, 'destinations.txt');
    writeFileSync(input, content, { mode: 0o600 });
    writeFileSync(list, destinations, { mode: 0o600 });
    const args = [script, ...(action ? [action] : []), '--name', 'routelab-game', '--config', input.replaceAll('\\', '/'), '--interface', 'eth0', '--destinations-file', list.replaceAll('\\', '/'), ...extra];
    const result = spawnSync(bash, args, { encoding: 'utf8', timeout: 10000, env: environment });
    assert.equal(result.error, undefined, result.error?.message);
    for (const key of [privateKey, peerKey, sharedKey]) assert.ok(!`${result.stdout}${result.stderr}`.includes(key), 'Plan must not print credentials.');
    assert.ok(!existsSync(path.join(temp, 'INJECTED')), 'No injected command may run.');
    return result;
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

test('relay deployment Bash syntax is valid', { skip: !bash && 'GNU Bash not available; set ROUTELAB_BASH' }, () => {
  const result = spawnSync(bash, ['-n', script], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
});

test('default and explicit plans render scoped destinations and suppress keys', { skip: !bash }, () => {
  for (const action of ['', '--plan']) {
    const result = runPlan({ action });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Plan only: no host state changed/);
    assert.match(result.stdout, /192\.0\.2\.50\/32/);
    assert.match(result.stdout, /198\.51\.100\.40\/32/);
    assert.equal(result.stdout.match(/192\.0\.2\.50\/32/g).length, 1, 'Duplicate destinations are collapsed.');
  }
});

const rejected = [
  ['PostUp commands', { content: config.replace('[Peer]', 'PostUp = touch INJECTED\n[Peer]') }],
  ['PostDown commands', { content: config.replace('[Peer]', 'PostDown = touch INJECTED\n[Peer]') }],
  ['duplicate peer', { content: `${config}\n[Peer]\nPublicKey = ${peerKey}\nAllowedIPs = 10.203.0.3/32\n` }],
  ['default route in peer', { content: config.replace('10.203.0.2/32', '0.0.0.0/0') }],
  ['default route destination', { destinations: '0.0.0.0/0\n' }],
  ['subnet destination', { destinations: '192.0.2.0/24\n' }],
  ['loopback destination', { destinations: '127.0.0.1\n' }],
  ['multicast destination', { destinations: '224.0.0.1\n' }],
  ['noncanonical IPv4', { destinations: '192.00.2.50\n' }],
  ['inline destination injection', { destinations: '192.0.2.50; touch INJECTED\n' }],
  ['WAN command injection', { extra: ['--interface', 'eth0; touch INJECTED'] }],
  ['name path traversal', { extra: ['--name', '../routelab-game'] }],
  ['Linux overlength name', { extra: ['--name', 'routelab-name-too-long'] }],
  ['port out of range', { extra: ['--port', '65536'] }],
  ['missing required config key', { content: config.replace(`PrivateKey = ${privateKey}\n`, '') }],
  ['duplicate key', { content: config.replace('[Peer]', `PrivateKey = ${privateKey}\n[Peer]`) }],
  ['SaveConfig directive', { content: config.replace('[Peer]', 'SaveConfig = true\n[Peer]') }],
  ['unmatched tunnel address', { extra: ['--server-ip', '10.203.0.3'] }],
  ['empty destination list', { destinations: '# nothing\n' }],
];
for (const [label, inputs] of rejected) {
  test(`relay plan rejects ${label}`, { skip: !bash }, () => {
    const result = runPlan(inputs);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /RouteLab:/);
  });
}
