import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { createRelay } from '../relay.mjs';
import { createExit } from '../exit.mjs';
import { encodePacket, decodePacket, PACKET_TYPES, newSessionId, ReplayWindow } from '../protocol.mjs';
import test from 'node:test';

test("Authenticated transport deduplicates multipath and expired-flow replay", { timeout: 20000 }, async () => {

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const bind = socket => new Promise(resolve => socket.bind(0, '127.0.0.1', resolve));
const close = socket => new Promise(resolve => { try { socket.close(resolve); } catch { resolve(); } });
const key = randomBytes(32), sessionId = newSessionId();
const packet = { type: PACKET_TYPES.DATA, sessionId, flowId: 1, seq: 1, payload: Buffer.from('independent transport test') };
const wire = encodePacket(packet, key);
assert.deepEqual(decodePacket(wire, key), packet);
assert.throws(() => decodePacket(wire, randomBytes(32)));
const altered = Buffer.from(wire); altered[altered.length - 1] ^= 1;
assert.throws(() => decodePacket(altered, key));
assert.notDeepEqual(encodePacket(packet, key), wire);
const replay = new ReplayWindow(8);
assert.equal(replay.accept(10), true); assert.equal(replay.accept(8), true); assert.equal(replay.accept(8), false); assert.equal(replay.accept(1), false);
const echo = dgram.createSocket('udp4'), client = dgram.createSocket('udp4');
echo.on('error', () => {}); client.on('error', () => {});
let delivered = 0, replies = 0;
echo.on('message', (bytes, from) => { delivered++; echo.send(bytes, from.port, from.address); });
client.on('message', bytes => { const decoded = decodePacket(bytes, key); assert.equal(decoded.type, PACKET_TYPES.RETURN); assert.deepEqual(decoded.payload, packet.payload); replies++; });
await bind(echo); await bind(client);
const exit = await createExit({ bind: { host: '127.0.0.1', port: 0 }, target: { host: '127.0.0.1', port: echo.address().port }, key, flowTtlMs: 150 });
const entries = [];
try {
  for (let i = 0; i < 2; i++) entries.push(await createRelay({ bind: { host: '127.0.0.1', port: 0 }, upstream: { host: '127.0.0.1', port: exit.address().port }, key }));
  for (const entry of entries) client.send(wire, entry.address().port, '127.0.0.1');
  await sleep(200);
  assert.equal(delivered, 1); assert.ok(replies >= 1);
  await sleep(200);
  for (const entry of entries) client.send(wire, entry.address().port, '127.0.0.1');
  await sleep(200);
  assert.equal(delivered, 1, 'Expired-flow replay must not reach target again');
  client.send(altered, entries[0].address().port, '127.0.0.1');
  await sleep(50);
  assert.ok(entries[0].snapshot().counters.droppedInvalid >= 1);
  console.log(JSON.stringify({ transport: 'passed', authentication: true, tamperRejection: true, replayWindow: true, commonExitDeduplication: true, expiredFlowReplayRejection: true, targetDeliveries: delivered, externalNetwork: false }));
} finally {
  await Promise.all(entries.map(entry => entry.close())); await exit.close(); await close(client); await close(echo);
}

});
