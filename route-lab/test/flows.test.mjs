import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createGateway } from '../gateway.mjs';
import { createRelay } from '../relay.mjs';
import { createExit } from '../exit.mjs';
import { encodePacket, decodePacket, newSessionId, PACKET_TYPES } from '../protocol.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const bind = socket => new Promise((resolve, reject) => { socket.once('error', reject); socket.bind(0, '127.0.0.1', resolve); });
const close = socket => new Promise(resolve => { try { socket.close(resolve); } catch { resolve(); } });
async function until(check, description, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return; await sleep(20); }
  throw new Error(`Timed out: ${description}`);
}
async function echoExchange(client, gateway, message) {
  const incoming = once(client, 'message', { signal: AbortSignal.timeout(2000) });
  client.send(Buffer.from(message), gateway.address().port, '127.0.0.1');
  const [payload] = await incoming;
  assert.equal(payload.toString(), message);
}

test('Gateway isolates application flows and enforces payload and flow capacity limits', { timeout: 10000 }, async () => {
  const key = randomBytes(32), resources = [];
  const target = dgram.createSocket('udp4');
  const observedPeers = new Set();
  target.on('message', (bytes, peer) => { observedPeers.add(peer.port); target.send(bytes, peer.port, peer.address); });
  await bind(target); resources.push({ close: () => close(target) });
  try {
    const exit = await createExit({ target: { host: '127.0.0.1', port: target.address().port }, key }); resources.push(exit);
    const relay = await createRelay({ upstream: { host: '127.0.0.1', port: exit.address().port }, key }); resources.push(relay);
    const gateway = await createGateway({ key, relays: [{ id: 'a', host: '127.0.0.1', port: relay.address().port }], maxFlows: 2 }); resources.push(gateway);
    await until(() => gateway.snapshot().paths[0].healthy, 'initial path measurement');
    const clients = [];
    for (let n = 0; n < 3; n++) { const client = dgram.createSocket('udp4'); await bind(client); clients.push(client); resources.push({ close: () => close(client) }); }
    await Promise.all([echoExchange(clients[0], gateway, 'client-one'), echoExchange(clients[1], gateway, 'client-two')]);
    assert.equal(observedPeers.size, 2, 'Each app flow must use its own target-facing socket');
    assert.equal(gateway.snapshot().activeFlows, 2);
    clients[0].send(Buffer.alloc(1201), gateway.address().port, '127.0.0.1');
    clients[2].send(Buffer.from('over-capacity'), gateway.address().port, '127.0.0.1');
    await until(() => gateway.snapshot().counters.droppedOversize === 1 && gateway.snapshot().counters.droppedCapacity === 1, 'input limits');
    assert.equal(exit.snapshot().counters.targetSent, 2);
    assert.equal(observedPeers.size, 2);
  } finally { for (const item of resources.reverse()) await item.close(); }
});

test('Exit flow expiration preserves DATA replay state and RETURN sequence continuity', { timeout: 6000 }, async () => {
  const key = randomBytes(32), sessionId = newSessionId();
  const target = dgram.createSocket('udp4'), client = dgram.createSocket('udp4');
  let targetCount = 0;
  target.on('message', (bytes, peer) => { targetCount++; target.send(bytes, peer.port, peer.address); });
  await bind(target); await bind(client);
  const exit = await createExit({ target: { host: '127.0.0.1', port: target.address().port }, key, flowTtlMs: 100 });
  const returns = [];
  client.on('message', wire => { returns.push(decodePacket(wire, key)); });
  const packet = seq => encodePacket({ type: PACKET_TYPES.DATA, sessionId, flowId: 1, seq, payload: Buffer.from('owned target') }, key);
  try {
    const first = packet(1); client.send(first, exit.address().port, '127.0.0.1');
    await until(() => returns.length === 1, 'first return');
    await until(() => exit.snapshot().activeFlows === 0, 'flow expiry');
    client.send(first, exit.address().port, '127.0.0.1');
    await sleep(80);
    assert.equal(targetCount, 1, 'Replayed expired flow cannot redeliver');
    client.send(packet(2), exit.address().port, '127.0.0.1');
    await until(() => returns.length === 2, 'new sequence after expiry');
    assert.equal(targetCount, 2);
    assert.ok(returns[1].seq > returns[0].seq, 'Reply deduplication sequence must continue across expiry');
  } finally { await exit.close(); await close(client); await close(target); }
});

test('Plaintext application gateway rejects non-loopback binding', async () => {
  await assert.rejects(createGateway({ bind: { host: '0.0.0.0', port: 0 }, key: randomBytes(32), relays: [{ id: 'a', host: '127.0.0.1', port: 9 }] }), /loopback/);
});

test('Reply generations recover from state reset and reject retired or delayed unseen generations', { timeout: 8000 }, async () => {
  const key = randomBytes(32), resources = [];
  const peer = dgram.createSocket('udp4'), client = dgram.createSocket('udp4');
  await bind(peer); await bind(client);
  resources.push({ close: () => close(peer) }, { close: () => close(client) });
  let generation = newSessionId(), replySeq = 0, retiredReply, unseenOldReply, gatewayEndpoint;
  peer.on('message', (wire, from) => {
    const packet = decodePacket(wire, key);
    gatewayEndpoint = from;
    if (packet.type === PACKET_TYPES.PROBE) peer.send(encodePacket({ ...packet, type: PACKET_TYPES.PROBE_ACK }, key), from.port, from.address);
    if (packet.type === PACKET_TYPES.DATA) {
      unseenOldReply ??= encodePacket({ ...packet, type: PACKET_TYPES.RETURN, seq: 1, generation: newSessionId() }, key);
      const response = encodePacket({ ...packet, type: PACKET_TYPES.RETURN, seq: ++replySeq, generation }, key);
      retiredReply = response;
      peer.send(response, from.port, from.address);
    }
  });
  try {
    const gateway = await createGateway({ key, relays: [{ id: 'a', host: '127.0.0.1', port: peer.address().port }], probeIntervalMs: 40 }); resources.push(gateway);
    await until(() => gateway.snapshot().paths[0].healthy, 'route');
    await echoExchange(client, gateway, 'before-one');
    await echoExchange(client, gateway, 'before-two');
    const oldReply = retiredReply;
    await sleep(5);
    generation = newSessionId(); replySeq = 0;
    await echoExchange(client, gateway, 'after-state-reset');
    assert.equal(gateway.snapshot().counters.generationChanges, 1);
    peer.send(oldReply, gatewayEndpoint.port, gatewayEndpoint.address);
    peer.send(unseenOldReply, gatewayEndpoint.port, gatewayEndpoint.address);
    await until(() => gateway.snapshot().counters.duplicateReturns >= 2, 'retired and unseen old generation rejection');
    assert.equal(gateway.snapshot().counters.appReturned, 3);
    await echoExchange(client, gateway, 'current-generation-still-works');
    assert.equal(gateway.snapshot().counters.generationChanges, 1);
  } finally { for (const item of resources.reverse()) await item.close(); }
});

test('An actual exit restart resumes delivery to an existing gateway application flow', { timeout: 8000 }, async () => {
  const key = randomBytes(32), resources = [];
  const target = dgram.createSocket('udp4'), client = dgram.createSocket('udp4');
  target.on('message', (bytes, from) => target.send(bytes, from.port, from.address));
  await bind(target); await bind(client);
  resources.push({ close: () => close(target) }, { close: () => close(client) });
  const targetEndpoint = { host: '127.0.0.1', port: target.address().port };
  try {
    let exit = await createExit({ target: targetEndpoint, key }); resources.push(exit);
    const exitPort = exit.address().port;
    const relay = await createRelay({ upstream: { host: '127.0.0.1', port: exitPort }, key }); resources.push(relay);
    const gateway = await createGateway({ key, relays: [{ id: 'a', host: '127.0.0.1', port: relay.address().port }], probeIntervalMs: 40 }); resources.push(gateway);
    await until(() => gateway.snapshot().paths[0].healthy, 'initial route');
    await echoExchange(client, gateway, 'before-restart-one');
    await echoExchange(client, gateway, 'before-restart-two');
    await exit.close();
    // Reuse the lab key deliberately to exercise generation recovery. A deployment
    // must rotate its key after restart for cross-restart DATA replay protection.
    exit = await createExit({ bind: { host: '127.0.0.1', port: exitPort }, target: targetEndpoint, key }); resources.push(exit);
    await sleep(3);
    await echoExchange(client, gateway, 'after-actual-restart');
    assert.equal(gateway.snapshot().activeFlows, 1);
    assert.equal(gateway.snapshot().counters.appReturned, 3);
    assert.equal(gateway.snapshot().counters.generationChanges, 1);
  } finally { for (const item of resources.reverse()) await item.close(); }
});
