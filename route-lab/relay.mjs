import dgram from 'node:dgram';
import { decodePacket, PACKET_TYPES } from './protocol.mjs';
import { endpoint, peerKey, samePeer, boundedInteger, bindSocket, send, closeSocket } from './net-utils.mjs';

export async function createRelay(options) {
  const bind = endpoint(options.bind ?? { host: '127.0.0.1', port: 0 }, true);
  const upstream = endpoint(options.upstream);
  if (!Buffer.isBuffer(options.key) || options.key.length !== 32) throw new Error('Relay requires a 32-byte key');
  const key = Buffer.from(options.key);
  const ttl = boundedInteger(options.sessionTtlMs, 60000, 100, 3600000, 'sessionTtlMs');
  const maxSessions = boundedInteger(options.maxSessions, 128, 1, 65536, 'maxSessions');
  const sessions = new Map(), timers = new Set();
  const counters = { received: 0, forwardedUpstream: 0, forwardedDownstream: 0, droppedInvalid: 0, droppedSimulated: 0, droppedCapacity: 0, droppedQueue: 0, socketErrors: 0 };
  let closed = false, simulation;
  function setSimulation(value = {}) {
    const delayMs = value.delayMs ?? 0, lossRate = value.lossRate ?? 0;
    if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 5000 || !Number.isFinite(lossRate) || lossRate < 0 || lossRate > 1) throw new Error('Invalid relay simulation');
    simulation = { delayMs, lossRate };
  }
  setSimulation(options.simulation);
  const socket = dgram.createSocket('udp4');
  socket.on('error', () => { counters.socketErrors++; });
  function forward(wire, destination, direction) {
    if (closed) return;
    if (Math.random() < simulation.lossRate) { counters.droppedSimulated++; return; }
    if (timers.size >= 4096) { counters.droppedQueue++; return; }
    const deliver = () => { if (!closed) { send(socket, wire, destination, () => { counters.socketErrors++; }); counters[direction]++; } };
    if (!simulation.delayMs) deliver();
    else { const timer = setTimeout(() => { timers.delete(timer); deliver(); }, simulation.delayMs); timers.add(timer); }
  }
  socket.on('message', (wire, from) => {
    if (closed) return;
    counters.received++;
    let packet;
    try { packet = decodePacket(wire, key); } catch { counters.droppedInvalid++; return; }
    const now = Date.now();
    if (samePeer(from, upstream)) {
      if (![PACKET_TYPES.PROBE_ACK, PACKET_TYPES.RETURN, PACKET_TYPES.ERROR].includes(packet.type)) { counters.droppedInvalid++; return; }
      const session = sessions.get(packet.sessionId);
      if (!session || now - session.lastSeen > ttl) { counters.droppedInvalid++; return; }
      forward(wire, session.peer, 'forwardedDownstream');
      return;
    }
    if (![PACKET_TYPES.PROBE, PACKET_TYPES.DATA].includes(packet.type) || (packet.type === PACKET_TYPES.PROBE ? packet.flowId !== 0 : packet.flowId === 0)) { counters.droppedInvalid++; return; }
    let session = sessions.get(packet.sessionId);
    if (session && now - session.lastSeen > ttl) { sessions.delete(packet.sessionId); session = undefined; }
    if (session && peerKey(session.peer) !== peerKey(from)) { counters.droppedInvalid++; return; }
    if (!session) {
      if (sessions.size >= maxSessions) { counters.droppedCapacity++; return; }
      session = { peer: { address: from.address, port: from.port }, lastSeen: now };
      sessions.set(packet.sessionId, session);
    }
    session.lastSeen = now;
    forward(wire, upstream, 'forwardedUpstream');
  });
  try { await bindSocket(socket, bind); } catch (error) { await closeSocket(socket); key.fill(0); throw error; }
  if (samePeer(socket.address(), upstream)) { await closeSocket(socket); key.fill(0); throw new Error('Relay upstream cannot point to itself'); }
  const cleanup = setInterval(() => { const now = Date.now(); for (const [id, session] of sessions) if (now - session.lastSeen > ttl) sessions.delete(id); }, Math.min(ttl, 1000));
  cleanup.unref();
  return {
    address: () => socket.address(),
    setSimulation,
    snapshot: () => ({ address: closed ? null : socket.address(), upstream, simulation: { ...simulation }, activeSessions: sessions.size, delayedPackets: timers.size, counters: { ...counters } }),
    async close() { if (closed) return; closed = true; clearInterval(cleanup); for (const timer of timers) clearTimeout(timer); timers.clear(); sessions.clear(); await closeSocket(socket); key.fill(0); },
  };
}
