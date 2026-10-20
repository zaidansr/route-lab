import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { isIPv4 } from 'node:net';

const NAME = /^routelab-[a-z0-9-]{1,7}$/;
const privateIp = ip => { const [a, b] = ip.split('.').map(Number); return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168); };
export function isPublicAddress(ip) {
  if (!isIPv4(ip)) return false;
  const [a, b] = ip.split('.').map(Number);
  return !(privateIp(ip) || a === 0 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || (a === 192 && b === 0 && ip.split('.')[2] === '0'));
}
export const isDocumentationAddress = ip => /^(192\.0\.2|198\.51\.100|203\.0\.113)\./.test(ip);
function ipv4Host(value, allowPrivate = false) {
  if (typeof value !== 'string') throw new Error('An IPv4 address is required');
  const ip = value.endsWith('/32') ? value.slice(0, -3) : value;
  if (!isIPv4(ip) || !(allowPrivate ? privateIp(ip) : isPublicAddress(ip))) throw new Error(allowPrivate ? 'Tunnel address must be a private IPv4 address' : 'Destination must be a public unicast IPv4 address');
  return ip;
}
export function validateName(name) { if (typeof name !== 'string' || !NAME.test(name)) throw new Error('Profile name must be routelab- followed by 1–7 lowercase letters, digits or hyphens'); return name; }
function integer(value, fallback, min, max) { const n = value ?? fallback; if (!Number.isInteger(n) || n < min || n > max) throw new Error('Configuration integer outside supported range'); return n; }
function endpoint(value) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+\.\d+:\d{1,5}$/.test(value)) throw new Error('Relay endpoint must be public IPv4:port');
  const [host, textPort] = value.split(':'); ipv4Host(host);
  const port = integer(Number(textPort), 51820, 1, 65535);
  return { host, port, value: `${host}:${port}` };
}
export function validateDeployment(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Deployment must be an object');
  const known = new Set(['name', 'relayEndpoint', 'gameAddresses', 'clientAddress', 'serverAddress', 'mtu', 'keepalive']);
  if (Object.keys(input).some(key => !known.has(key))) throw new Error('Unknown deployment field');
  const name = validateName(input.name ?? 'routelab-game'), relay = endpoint(input.relayEndpoint);
  if (!Array.isArray(input.gameAddresses) || !input.gameAddresses.length || input.gameAddresses.length > 64) throw new Error('Supply 1–64 game server IPv4 addresses');
  const gameAddresses = [...new Set(input.gameAddresses.map(ip => ipv4Host(ip)))];
  if (gameAddresses.includes(relay.host)) throw new Error('Relay endpoint cannot be routed into its own tunnel');
  const clientAddress = ipv4Host(input.clientAddress ?? '10.203.0.2', true), serverAddress = ipv4Host(input.serverAddress ?? '10.203.0.1', true);
  if (clientAddress === serverAddress || clientAddress.split('.').slice(0, 3).join('.') !== serverAddress.split('.').slice(0, 3).join('.') || [clientAddress, serverAddress].some(ip => ['0', '255'].includes(ip.split('.')[3]))) throw new Error('Distinct tunnel host addresses must share a private /24');
  return { name, relayEndpoint: relay.value, gameAddresses, clientAddress, serverAddress, mtu: integer(input.mtu, 1380, 1280, 1420), keepalive: integer(input.keepalive, 25, 0, 120) };
}
function checkKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value) || Buffer.from(value, 'base64').length !== 32 || Buffer.from(value, 'base64').toString('base64') !== value || Buffer.from(value, 'base64').every(byte => byte === 0)) throw new Error('Invalid WireGuard key');
  return value;
}
function publicFromPrivate(value) {
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), Buffer.from(checkKey(value), 'base64')]), type: 'pkcs8', format: 'der' });
  return Buffer.from(createPublicKey(key).export({ format: 'jwk' }).x, 'base64url').toString('base64');
}
function pair() {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  return { private: Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url').toString('base64'), public: Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64') };
}
export function generateDeployment(input, { keys } = {}) {
  const normalized = validateDeployment(input);
  if (!keys) { const client = pair(), server = pair(); keys = { clientPrivate: client.private, clientPublic: client.public, serverPrivate: server.private, serverPublic: server.public, presharedKey: randomBytes(32).toString('base64') }; }
  for (const field of ['clientPrivate', 'clientPublic', 'serverPrivate', 'serverPublic', 'presharedKey']) checkKey(keys[field]);
  if (publicFromPrivate(keys.clientPrivate) !== keys.clientPublic || publicFromPrivate(keys.serverPrivate) !== keys.serverPublic || keys.clientPublic === keys.serverPublic) throw new Error('WireGuard public/private key pair mismatch');
  const { name, relayEndpoint, gameAddresses, clientAddress, serverAddress, mtu, keepalive } = normalized;
  const port = endpoint(relayEndpoint).port;
  const clientConfig = `# RouteLab managed profile: ${name}\n[Interface]\nPrivateKey = ${keys.clientPrivate}\nAddress = ${clientAddress}/32\nMTU = ${mtu}\n\n[Peer]\nPublicKey = ${keys.serverPublic}\nPresharedKey = ${keys.presharedKey}\nEndpoint = ${relayEndpoint}\nAllowedIPs = ${[...gameAddresses, serverAddress].map(ip => `${ip}/32`).join(', ')}\nPersistentKeepalive = ${keepalive}\n`;
  const serverConfig = `# RouteLab managed relay: ${name}\n[Interface]\nPrivateKey = ${keys.serverPrivate}\nAddress = ${serverAddress}/24\nListenPort = ${port}\nMTU = ${mtu}\n\n[Peer]\nPublicKey = ${keys.clientPublic}\nPresharedKey = ${keys.presharedKey}\nAllowedIPs = ${clientAddress}/32\n`;
  return { clientConfig, serverConfig, profile: { version: 1, ...normalized, clientPublicKey: keys.clientPublic, serverPublicKey: keys.serverPublic, createdAt: new Date().toISOString() }, destinations: gameAddresses.map(ip => `${ip}/32`).join('\n') + '\n' };
}
export function validateManagedConfig(text, { expectedName } = {}) {
  if (typeof text !== 'string' || text.length > 16384 || text.includes('\0')) throw new Error('Invalid managed configuration');
  const parsed = { Interface: {}, Peer: {} }, sections = new Set();
  let current, marker;
  const allowed = { Interface: new Set(['PrivateKey', 'Address', 'MTU']), Peer: new Set(['PublicKey', 'PresharedKey', 'Endpoint', 'AllowedIPs', 'PersistentKeepalive']) };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line) continue;
    if (line.startsWith('#')) { if (line.startsWith('# RouteLab managed profile: ')) { if (marker) throw new Error('Duplicate managed marker'); marker = validateName(line.slice(28)); } continue; }
    if (line.startsWith('[')) { if (!['[Interface]', '[Peer]'].includes(line)) throw new Error('Unsupported configuration section'); current = line.slice(1, -1); if (sections.has(current)) throw new Error('Duplicate configuration section'); sections.add(current); continue; }
    const match = /^([A-Za-z]+)\s*=\s*(.+)$/.exec(line);
    if (!current || !match || !allowed[current].has(match[1]) || Object.hasOwn(parsed[current], match[1])) throw new Error('Unknown or duplicate configuration option');
    parsed[current][match[1]] = match[2].trim();
  }
  if (!marker || (expectedName !== undefined && marker !== validateName(expectedName))) throw new Error('Managed profile identity mismatch');
  for (const key of ['PrivateKey', 'Address', 'MTU']) if (!parsed.Interface[key]) throw new Error('Missing interface setting');
  for (const key of ['PublicKey', 'Endpoint', 'AllowedIPs', 'PersistentKeepalive']) if (!parsed.Peer[key]) throw new Error('Missing peer setting');
  checkKey(parsed.Interface.PrivateKey); checkKey(parsed.Peer.PublicKey); if (parsed.Peer.PresharedKey) checkKey(parsed.Peer.PresharedKey);
  if (!parsed.Interface.Address.endsWith('/32')) throw new Error('Client tunnel address must be /32');
  const clientAddress = ipv4Host(parsed.Interface.Address, true), relay = endpoint(parsed.Peer.Endpoint);
  integer(Number(parsed.Interface.MTU), undefined, 1280, 1420); integer(Number(parsed.Peer.PersistentKeepalive), undefined, 0, 120);
  const routes = parsed.Peer.AllowedIPs.split(',').map(item => item.trim());
  if (routes.length < 2 || routes.length > 65 || new Set(routes).size !== routes.length || routes.some(route => !route.endsWith('/32') || !isIPv4(route.slice(0, -3)))) throw new Error('Only unique host /32 routes are supported');
  const privateRoutes = routes.filter(route => privateIp(route.slice(0, -3)));
  if (privateRoutes.length !== 1) throw new Error('Exactly one private relay probe route is required');
  const serverAddress = privateRoutes[0].slice(0, -3);
  const normalized = validateDeployment({ name: marker, relayEndpoint: relay.value, gameAddresses: routes.filter(route => !privateRoutes.includes(route)), clientAddress, serverAddress, mtu: Number(parsed.Interface.MTU), keepalive: Number(parsed.Peer.PersistentKeepalive) });
  return { ...normalized, clientPublicKey: publicFromPrivate(parsed.Interface.PrivateKey), serverPublicKey: parsed.Peer.PublicKey };
}
export function redactProfile(profile) {
  const clean = {};
  for (const key of ['version', 'name', 'relayEndpoint', 'clientAddress', 'serverAddress', 'mtu', 'keepalive', 'clientPublicKey', 'serverPublicKey', 'createdAt']) if (typeof profile?.[key] === 'string' || typeof profile?.[key] === 'number') clean[key] = profile[key];
  if (Array.isArray(profile?.gameAddresses)) clean.gameAddresses = profile.gameAddresses.filter(value => typeof value === 'string').slice(0, 64);
  return clean;
}
