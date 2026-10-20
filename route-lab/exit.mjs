import dgram from 'node:dgram';
import { encodePacket, decodePacket, newSessionId, PACKET_TYPES, MAX_PAYLOAD, ReplayWindow, MAX_PACKET_AGE_MS, MAX_CLOCK_SKEW_MS } from './protocol.mjs';
import { endpoint, peerKey, boundedInteger, bindSocket, send, closeSocket } from './net-utils.mjs';

export async function createExit(options) {
  const bind = endpoint(options.bind ?? { host: '127.0.0.1', port: 0 }, true), target = endpoint(options.target);
  if (!Buffer.isBuffer(options.key) || options.key.length !== 32) throw new Error('Exit requires a 32-byte key');
  const key = Buffer.from(options.key);
  const ttl = boundedInteger(options.flowTtlMs, 60000, 100, 3600000, 'flowTtlMs');
  const maxFlows = boundedInteger(options.maxFlows, 256, 1, 65536, 'maxFlows');
  const retention = MAX_PACKET_AGE_MS + MAX_CLOCK_SKEW_MS + 1000;
  const flows = new Map(), tombstones = new Map();
  const counters = { received: 0, probes: 0, targetSent: 0, targetReceived: 0, repliesSent: 0, duplicateData: 0, droppedInvalid: 0, droppedOversize: 0, droppedCapacity: 0, socketErrors: 0 };
  let closed = false;
  const socket = dgram.createSocket('udp4');
  socket.on('error', () => { counters.socketErrors++; });
  const retire = async (id, flow) => {
    if (flows.get(id) !== flow) return;
    flows.delete(id);
    tombstones.set(id, { window: flow.window, replySeq: flow.replySeq, generation: flow.generation, expires: Date.now() + retention });
    flow.closed = true;
    await closeSocket(flow.socket);
  };
  function newFlow(packet) {
    const id = `${packet.sessionId}/${packet.flowId}`;
    if (flows.size >= maxFlows || (!tombstones.has(id) && flows.size + tombstones.size >= maxFlows * 4)) return null;
    const old = tombstones.get(id);
    tombstones.delete(id);
    const targetSocket = dgram.createSocket('udp4');
    const flow = { sessionId: packet.sessionId, flowId: packet.flowId, generation: old?.generation ?? newSessionId(), socket: targetSocket, window: old?.window ?? new ReplayWindow(), paths: new Map(), lastSeen: Date.now(), replySeq: old?.replySeq ?? 0, pending: 0, closed: false };
    flows.set(id, flow);
    targetSocket.on('error', () => { counters.socketErrors++; });
    flow.ready = new Promise((resolve, reject) => {
      const failed = error => { targetSocket.removeListener('connect', ready); reject(error); };
      const ready = () => { targetSocket.removeListener('error', failed); resolve(); };
      targetSocket.once('error', failed); targetSocket.once('connect', ready);
      targetSocket.connect(target.port, target.host);
    });
    flow.ready.catch(() => {});
    targetSocket.on('message', payload => {
      if (closed || flow.closed) return;
      if (payload.length > MAX_PAYLOAD) { counters.droppedOversize++; return; }
      if (flow.replySeq >= 0xffffffff) { void retire(id, flow); return; }
      flow.lastSeen = Date.now(); counters.targetReceived++;
      const wire = encodePacket({ type: PACKET_TYPES.RETURN, sessionId: flow.sessionId, flowId: flow.flowId, seq: ++flow.replySeq, payload, generation: flow.generation }, key);
      const now = Date.now();
      for (const [pathId, ingress] of flow.paths) {
        if (now - ingress.lastSeen > Math.max(10000, Math.min(ttl, 60000))) { flow.paths.delete(pathId); continue; }
        send(socket, wire, ingress.peer, () => { counters.socketErrors++; }); counters.repliesSent++;
      }
    });
    return flow;
  }
  async function handle(wire, from) {
    if (closed) return;
    counters.received++;
    let packet;
    try { packet = decodePacket(wire, key); } catch { counters.droppedInvalid++; return; }
    if (packet.type === PACKET_TYPES.PROBE && packet.flowId === 0) {
      counters.probes++;
      const reply = encodePacket({ ...packet, type: PACKET_TYPES.PROBE_ACK }, key);
      send(socket, reply, from, () => { counters.socketErrors++; }); return;
    }
    if (packet.type !== PACKET_TYPES.DATA || packet.flowId === 0) { counters.droppedInvalid++; return; }
    const id = `${packet.sessionId}/${packet.flowId}`;
    let flow = flows.get(id);
    if (flow && Date.now() - flow.lastSeen > ttl) { void retire(id, flow); flow = undefined; }
    if (closed) return;
    flow ??= newFlow(packet);
    if (!flow) { counters.droppedCapacity++; return; }
    const pathId = peerKey(from);
    if (!flow.paths.has(pathId) && flow.paths.size >= 4) {
      const oldest = [...flow.paths].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0][0];
      flow.paths.delete(oldest);
    }
    flow.paths.set(pathId, { peer: { address: from.address, port: from.port }, lastSeen: Date.now() });
    flow.lastSeen = Date.now();
    if (!flow.window.accept(packet.seq)) { counters.duplicateData++; return; }
    if (flow.pending >= 64) { counters.droppedCapacity++; return; }
    flow.pending++;
    try {
      await flow.ready;
      if (!closed && !flow.closed) {
        flow.socket.send(packet.payload, error => { if (error) counters.socketErrors++; });
        counters.targetSent++;
      }
    } catch { counters.socketErrors++; }
    finally { flow.pending--; }
  }
  socket.on('message', (wire, from) => { void handle(wire, from).catch(() => { counters.socketErrors++; }); });
  try { await bindSocket(socket, bind); } catch (error) { await closeSocket(socket); key.fill(0); throw error; }
  if (socket.address().port === target.port && [socket.address().address, '0.0.0.0'].includes(target.host)) { await closeSocket(socket); key.fill(0); throw new Error('Exit target cannot point to itself'); }
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [id, item] of tombstones) if (now > item.expires) tombstones.delete(id);
    for (const [id, flow] of flows) if (now - flow.lastSeen > ttl) void retire(id, flow);
  }, Math.min(ttl, 1000));
  cleanup.unref();
  return {
    address: () => socket.address(),
    snapshot: () => ({ address: closed ? null : socket.address(), target, activeFlows: flows.size, replayTombstones: tombstones.size, counters: { ...counters } }),
    async close() {
      if (closed) return; closed = true; clearInterval(cleanup);
      const closing = [...flows.values()].map(flow => { flow.closed = true; return closeSocket(flow.socket); });
      flows.clear(); tombstones.clear();
      await Promise.all([...closing, closeSocket(socket)]); key.fill(0);
    },
  };
}
