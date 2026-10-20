import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const PACKET_TYPES = Object.freeze({ PROBE: 1, PROBE_ACK: 2, DATA: 3, RETURN: 4, ERROR: 5 });
export const MAX_PAYLOAD = 1200;
export const MAX_PACKET_AGE_MS = 30_000;
export const MAX_CLOCK_SKEW_MS = 5_000;
const HEADER = 66, TAG = 16, MAGIC = Buffer.from('RLP2'), ZERO_GENERATION = '0'.repeat(32);
const types = new Set(Object.values(PACKET_TYPES));
const uint32 = n => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;
function checkKey(key) { if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Key must be a 32-byte Buffer'); }
export function newSessionId() { return randomBytes(16).toString('hex'); }

export function encodePacket({ type, sessionId, flowId, seq, payload, generation = ZERO_GENERATION }, key) {
  checkKey(key);
  if (!types.has(type) || !/^[0-9a-f]{32}$/.test(sessionId) || !/^[0-9a-f]{32}$/.test(generation) || (type !== PACKET_TYPES.RETURN && generation !== ZERO_GENERATION) || !uint32(flowId) || !uint32(seq) || !Buffer.isBuffer(payload) || payload.length > MAX_PAYLOAD) throw new Error('Invalid packet fields');
  const header = Buffer.alloc(HEADER);
  MAGIC.copy(header); header[4] = 2; header[5] = type;
  Buffer.from(sessionId, 'hex').copy(header, 6);
  header.writeUInt32BE(flowId, 22); header.writeUInt32BE(seq, 26);
  header.writeBigUInt64BE(BigInt(Date.now()), 30);
  Buffer.from(generation, 'hex').copy(header, 38);
  randomBytes(12).copy(header, 54);
  const cipher = createCipheriv('aes-256-gcm', key, header.subarray(54, 66));
  cipher.setAAD(header);
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  return Buffer.concat([header, encrypted, cipher.getAuthTag()]);
}

export function decodePacket(wire, key) {
  checkKey(key);
  if (!Buffer.isBuffer(wire) || wire.length < HEADER + TAG || wire.length > HEADER + TAG + MAX_PAYLOAD || !wire.subarray(0, 4).equals(MAGIC) || wire[4] !== 2 || !types.has(wire[5])) throw new Error('Invalid packet framing');
  const header = wire.subarray(0, HEADER);
  let payload;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(54, 66));
    decipher.setAAD(header); decipher.setAuthTag(wire.subarray(wire.length - TAG));
    payload = Buffer.concat([decipher.update(wire.subarray(HEADER, wire.length - TAG)), decipher.final()]);
  } catch { throw new Error('Packet authentication failed'); }
  const issued = header.readBigUInt64BE(30);
  if (issued > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid packet timestamp');
  const age = Date.now() - Number(issued);
  if (age > MAX_PACKET_AGE_MS || age < -MAX_CLOCK_SKEW_MS) throw new Error('Packet outside freshness window');
  const packet = { type: wire[5], sessionId: header.subarray(6, 22).toString('hex'), flowId: header.readUInt32BE(22), seq: header.readUInt32BE(26), payload };
  const generation = header.subarray(38, 54).toString('hex');
  if (packet.type === PACKET_TYPES.RETURN) { packet.generation = generation; packet.issuedAt = Number(issued); }
  else if (generation !== ZERO_GENERATION) throw new Error('Invalid packet generation');
  return packet;
}

export class ReplayWindow {
  constructor(size = 2048) {
    if (!Number.isInteger(size) || size < 8 || size > 8192) throw new Error('Invalid replay window size');
    this.size = size; this.highest = -1; this.bits = 0n; this.mask = (1n << BigInt(size)) - 1n;
  }
  accept(sequence) {
    if (!uint32(sequence)) return false;
    if (this.highest < 0) { this.highest = sequence; this.bits = 1n; return true; }
    if (sequence > this.highest) {
      const shift = sequence - this.highest;
      this.bits = shift >= this.size ? 1n : ((this.bits << BigInt(shift)) | 1n) & this.mask;
      this.highest = sequence; return true;
    }
    const distance = this.highest - sequence;
    if (distance >= this.size) return false;
    const bit = 1n << BigInt(distance);
    if (this.bits & bit) return false;
    this.bits |= bit; return true;
  }
}
