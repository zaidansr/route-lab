import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { encodePacket, decodePacket, newSessionId, PACKET_TYPES, MAX_PAYLOAD, ReplayWindow } from '../protocol.mjs';

test('Packet framing rejects invalid fields, wrong keys and authenticated-header tampering', () => {
  const key = randomBytes(32);
  const packet = { type: PACKET_TYPES.DATA, sessionId: newSessionId(), flowId: 3, seq: 4, payload: randomBytes(MAX_PAYLOAD) };
  const wire = encodePacket(packet, key);
  assert.deepEqual(decodePacket(wire, key), packet);
  assert.notDeepEqual(encodePacket(packet, key), wire, 'Each encoding needs its own nonce');
  assert.throws(() => decodePacket(wire, randomBytes(32)));
  for (const offset of [5, 10, 22, 26, 30, 38, 60, wire.length - 1]) {
    const modified = Buffer.from(wire); modified[offset] ^= 1;
    assert.throws(() => decodePacket(modified, key), `Tampering at byte ${offset}`);
  }
  for (const size of [0, 4, 65, wire.length + 1]) assert.throws(() => decodePacket(Buffer.alloc(size), key));
  for (const replacement of [{ type: 99 }, { seq: -1 }, { seq: 2 ** 32 }, { flowId: 1.5 }, { sessionId: 'bad' }, { payload: Buffer.alloc(MAX_PAYLOAD + 1) }]) {
    assert.throws(() => encodePacket({ ...packet, ...replacement }, key));
  }
  assert.throws(() => encodePacket(packet, Buffer.alloc(31)));
});

test('Authenticated timestamps reject stale and excessively future packets', () => {
  const key = randomBytes(32), realNow = Date.now;
  const packet = { type: PACKET_TYPES.PROBE, sessionId: newSessionId(), flowId: 0, seq: 1, payload: Buffer.alloc(0) };
  let old, future;
  try {
    Date.now = () => realNow() - 31000; old = encodePacket(packet, key);
    Date.now = () => realNow() + 6000; future = encodePacket(packet, key);
  } finally { Date.now = realNow; }
  assert.throws(() => decodePacket(old, key), /freshness/);
  assert.throws(() => decodePacket(future, key), /freshness/);
});

test('Replay windows accept bounded reordering and reject repeats, old and invalid sequences', () => {
  const window = new ReplayWindow(8);
  for (const seq of [10, 9, 7, 12, 11]) assert.equal(window.accept(seq), true);
  for (const seq of [10, 9, 7, 12, 11, 3, -1, 2 ** 32, 0.5]) assert.equal(window.accept(seq), false);
  assert.equal(window.accept(100), true);
  assert.equal(window.accept(99), true);
  assert.equal(window.accept(12), false);
  assert.throws(() => new ReplayWindow(1));
});
