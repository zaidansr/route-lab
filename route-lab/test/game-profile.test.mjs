import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { validateDeployment, generateDeployment, validateManagedConfig, redactProfile } from '../game-profile.mjs';

// Documentation-only IPv4 ranges: these tests never contact a remote endpoint.
const valid = {
  name: 'routelab-game', relayEndpoint: '203.0.113.10:51820',
  gameAddresses: ['198.51.100.20', '192.0.2.21/32'],
  clientAddress: '10.203.0.2', serverAddress: '10.203.0.1', mtu: 1380, keepalive: 25,
};
function fixture(overrides = {}) { return { ...valid, gameAddresses: [...valid.gameAddresses], ...overrides }; }
function ini(text) {
  const sections = {};
  let current;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[')) { current = line.slice(1, -1); sections[current] = {}; continue; }
    const separator = line.indexOf('=');
    assert.ok(separator > 0 && current, 'Generated config must be valid INI');
    sections[current][line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return sections;
}
function derivePublic(rawPrivate) {
  const bytes = Buffer.from(rawPrivate, 'base64');
  assert.equal(bytes.length, 32);
  // RFC 8410 X25519 PKCS#8 container, independent of the generator under test.
  const der = Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), bytes]);
  const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  return Buffer.from(createPublicKey(key).export({ format: 'jwk' }).x, 'base64url').toString('base64');
}
function keys() {
  const pair = () => {
    const { privateKey, publicKey } = generateKeyPairSync('x25519');
    return {
      private: Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url').toString('base64'),
      public: Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64'),
    };
  };
  const client = pair(), server = pair();
  return { clientPrivate: client.private, clientPublic: client.public, serverPrivate: server.private,
    serverPublic: server.public, presharedKey: randomBytes(32).toString('base64') };
}

test('Game deployment produces mutually valid X25519 peer keys and narrowly scoped game routes', () => {
  assert.doesNotThrow(() => validateDeployment(fixture()));
  const generated = generateDeployment(fixture());
  const client = ini(generated.clientConfig), server = ini(generated.serverConfig);
  assert.equal(derivePublic(client.Interface.PrivateKey), server.Peer.PublicKey);
  assert.equal(derivePublic(server.Interface.PrivateKey), client.Peer.PublicKey);
  assert.equal(client.Peer.PresharedKey, server.Peer.PresharedKey);
  assert.equal(Buffer.from(client.Peer.PresharedKey, 'base64').length, 32);
  assert.equal(client.Peer.Endpoint, valid.relayEndpoint);
  assert.equal(Number(server.Interface.ListenPort), 51820);
  assert.equal(Number(client.Interface.MTU), 1380);
  assert.equal(Number(client.Peer.PersistentKeepalive), 25);
  assert.deepEqual(new Set(client.Peer.AllowedIPs.split(',').map(x => x.trim())),
    new Set(['10.203.0.1/32', '198.51.100.20/32', '192.0.2.21/32']));
  assert.equal(server.Peer.AllowedIPs, '10.203.0.2/32');
  assert.doesNotMatch(generated.clientConfig, /(?:PreUp|PostUp|PreDown|PostDown|DNS)\s*=/i);
  assert.doesNotThrow(() => validateManagedConfig(generated.clientConfig, { expectedName: valid.name }));
  assert.equal(generated.profile.version, 1);
  assert.equal(generated.profile.name, valid.name);
  assert.equal(generated.profile.clientPublicKey, server.Peer.PublicKey);
  assert.equal(generated.profile.serverPublicKey, client.Peer.PublicKey);
  for (const secret of [client.Interface.PrivateKey, server.Interface.PrivateKey, client.Peer.PresharedKey]) {
    assert.ok(!JSON.stringify(generated.profile).includes(secret), 'Public profile must exclude tunnel secrets');
    assert.ok(!generated.destinations.includes(secret), 'Destination output must exclude tunnel secrets');
  }
  for (const address of ['198.51.100.20', '192.0.2.21']) assert.ok(generated.destinations.includes(address));
});

test('Independent deployments generate new keys; explicit keypairs are checked and preserved', () => {
  const first = generateDeployment(fixture()), second = generateDeployment(fixture());
  assert.notEqual(ini(first.clientConfig).Interface.PrivateKey, ini(second.clientConfig).Interface.PrivateKey);
  assert.notEqual(ini(first.serverConfig).Interface.PrivateKey, ini(second.serverConfig).Interface.PrivateKey);
  const supplied = keys(), generated = generateDeployment(fixture(), { keys: supplied });
  assert.equal(ini(generated.clientConfig).Interface.PrivateKey, supplied.clientPrivate);
  assert.equal(ini(generated.serverConfig).Interface.PrivateKey, supplied.serverPrivate);
  assert.equal(ini(generated.clientConfig).Peer.PresharedKey, supplied.presharedKey);
  for (const replacement of [
    { clientPrivate: 'not-a-key' }, { presharedKey: Buffer.alloc(31).toString('base64') },
    { clientPublic: keys().clientPublic }, { serverPublic: keys().serverPublic },
  ]) assert.throws(() => generateDeployment(fixture(), { keys: { ...supplied, ...replacement } }));
});

test('Deployment validation rejects broad routes, local/private destinations and relay routing loops', () => {
  for (const gameAddress of [
    '0.0.0.0', '0.0.0.0/0', '198.51.100.0/24', '::1', 'example.com', '10.0.0.1',
    '172.16.1.2', '192.168.1.1', '127.0.0.1', '169.254.1.1', '100.64.0.1',
    '224.0.0.1', '240.0.0.1', '255.255.255.255', '203.0.113.10',
    '198.51.100.20\nPostUp = bad',
  ]) assert.throws(() => validateDeployment(fixture({ gameAddresses: [gameAddress] })), gameAddress);
  assert.throws(() => validateDeployment(fixture({ gameAddresses: [] })));
  assert.throws(() => validateDeployment(fixture({ gameAddresses: Array.from({ length: 65 }, (_, i) => `198.51.100.${i + 1}`) })));
});

test('Deployment validation bounds interface names, endpoints, tunnel addresses and numeric settings', () => {
  for (const name of ['game', '../routelab-game', 'routelab-abcdefgh', 'routelab-x\nPostUp=bad']) {
    assert.throws(() => validateDeployment(fixture({ name })), name);
  }
  for (const relayEndpoint of ['relay.example.com:51820', '203.0.113.10:0', '203.0.113.10:65536',
    '127.0.0.1:51820', '224.0.0.1:51820', '203.0.113.10:51820\nPostUp=bad']) {
    assert.throws(() => validateDeployment(fixture({ relayEndpoint })), relayEndpoint);
  }
  for (const replacement of [
    { clientAddress: '198.51.100.20' }, { serverAddress: '127.0.0.1' },
    { clientAddress: '10.203.0.1' }, { clientAddress: '10.203.1.2' },
    { mtu: 0 }, { mtu: 65536 }, { mtu: 1380.5 }, { keepalive: -1 }, { keepalive: 65536 },
  ]) assert.throws(() => validateDeployment(fixture(replacement)), JSON.stringify(replacement));
});

test('Managed client config rejects command hooks, DNS changes, unknown or duplicate settings and broad routes', () => {
  const { clientConfig } = generateDeployment(fixture());
  for (const mutation of [
    text => text.replace('[Interface]', '[Interface]\nPreUp = unsafe'),
    text => text.replace('[Interface]', '[Interface]\nPostUp = unsafe'),
    text => text.replace('[Interface]', '[Interface]\nPreDown = unsafe'),
    text => text.replace('[Interface]', '[Interface]\nPostDown = unsafe'),
    text => text.replace('[Interface]', '[Interface]\nDNS = 1.1.1.1'),
    text => text.replace('[Interface]', '[Interface]\nUnknownSetting = unsafe'),
    text => text.replace('[Peer]', '[Peer]\nAllowedIPs = 0.0.0.0/0'),
    text => text.replace(/AllowedIPs\s*=\s*[^\r\n]+/, 'AllowedIPs = 0.0.0.0/0'),
    text => text.replace(/AllowedIPs\s*=\s*[^\r\n]+/, 'AllowedIPs = 198.51.100.0/24'),
    text => text.replace(/Endpoint\s*=\s*[^\r\n]+/, 'Endpoint = relay.example.com:51820'),
    text => text.replace(/PrivateKey\s*=\s*[^\r\n]+/, 'PrivateKey = invalid'),
    text => `${text}\n[Peer]\nPublicKey = invalid\n`,
    text => text.replace('[Interface]', '[SomethingElse]'),
  ]) assert.throws(() => validateManagedConfig(mutation(clientConfig), { expectedName: valid.name }));
  assert.throws(() => validateManagedConfig(clientConfig, { expectedName: 'routelab-other' }));
  assert.throws(() => validateManagedConfig(clientConfig.replace(/^# RouteLab managed profile:.*\r?\n/m, ''), { expectedName: valid.name }));
  assert.doesNotThrow(() => validateManagedConfig(`# A local comment\r\n${clientConfig}`, { expectedName: valid.name }));
});

test('Profile redaction preserves public connection details while removing private keys and PSK values', () => {
  const generated = generateDeployment(fixture());
  const redacted = redactProfile({ ...generated.profile, clientPrivate: 'private-canary',
    serverPrivateKey: 'server-private-canary', presharedKey: 'psk-canary',
    nested: { privateKey: 'nested-private-canary' } });
  const serialized = JSON.stringify(redacted);
  for (const secret of ['private-canary', 'server-private-canary', 'psk-canary', 'nested-private-canary']) {
    assert.ok(!serialized.includes(secret), 'Redaction must not serialize private material');
  }
  assert.equal(redacted.name, valid.name);
  assert.equal(redacted.relayEndpoint, valid.relayEndpoint);
  assert.equal(redacted.clientPublicKey, generated.profile.clientPublicKey);
});
