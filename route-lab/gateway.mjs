import dgram from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { encodePacket, decodePacket, newSessionId, PACKET_TYPES, MAX_PAYLOAD, ReplayWindow } from './protocol.mjs';
import { endpoint, peerKey, samePeer, boundedInteger, bindSocket, send, closeSocket } from './net-utils.mjs';

export async function createGateway(options = {}) {
  const bind = endpoint(options.bind ?? { host: '127.0.0.1', port: 0 }, true);
  if (!bind.host.startsWith('127.')) throw new Error('Plaintext application gateway must bind to IPv4 loopback');
  if (!Buffer.isBuffer(options.key) || options.key.length !== 32) throw new Error('Gateway requires a 32-byte key');
  if (!Array.isArray(options.relays) || options.relays.length < 1 || options.relays.length > 16) throw new Error('Configure 1 to 16 relay paths');
  let mode = options.mode ?? 'adaptive';
  if (!['adaptive', 'duplicate'].includes(mode)) throw new Error('Mode must be adaptive or duplicate');
  const interval = boundedInteger(options.probeIntervalMs, 250, 20, 10000, 'probeIntervalMs');
  const timeout = boundedInteger(options.probeTimeoutMs, 800, 50, 30000, 'probeTimeoutMs');
  const ttl = boundedInteger(options.flowTtlMs, 60000, 100, 3600000, 'flowTtlMs');
  const maxFlows = boundedInteger(options.maxFlows, 256, 1, 65536, 'maxFlows');
  const hold = boundedInteger(options.routeHoldMs, 1000, 0, 60000, 'routeHoldMs');
  const threshold = boundedInteger(options.switchThresholdMs, 5, 0, 10000, 'switchThresholdMs');
  const ids = new Set(), endpoints = new Set();
  const paths = options.relays.map(item => {
    const remote = endpoint(item);
    if (typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,32}$/.test(item.id) || ids.has(item.id) || endpoints.has(peerKey(remote))) throw new Error('Relay IDs and endpoints must be unique');
    if (item.name !== undefined && (typeof item.name !== 'string' || item.name.length > 80)) throw new Error('Invalid relay name');
    ids.add(item.id); endpoints.add(peerKey(remote));
    return { ...remote, id: item.id, name: item.name ?? item.id, socket: dgram.createSocket('udp4'), pending: new Map(), samples: [], rttMs: null, jitterMs: 0, lastRtt: null, lastAck: null, lastProbe: -Infinity, seq: 0, sentProbes: 0, receivedProbes: 0 };
  });
  const key = Buffer.from(options.key), sessionId = newSessionId();
  const local = dgram.createSocket('udp4'), flows = new Map(), flowIds = new Map();
  let closed = false, nextFlowId = 0, selected = null, switchedAt = -Infinity, timer;
  const counters = { appReceived: 0, dataSent: 0, appReturned: 0, duplicateReturns: 0, droppedInvalid: 0, droppedOversize: 0, droppedNoRoute: 0, droppedCapacity: 0, socketErrors: 0, routeChanges: 0, generationChanges: 0 };
  local.on('error', () => { counters.socketErrors++; });
  function sample(path, ok) { path.samples.push(ok); if (path.samples.length > 32) path.samples.shift(); }
  const loss = path => path.samples.length ? path.samples.filter(value => !value).length / path.samples.length : 0;
  const healthy = (path, now) => path.lastAck !== null && now - path.lastAck < Math.max(timeout * 2, interval * 3);
  const score = path => path.rttMs === null ? Infinity : path.rttMs + 2 * path.jitterMs + loss(path) * timeout;
  function choose(now) {
    const available = paths.filter(path => healthy(path, now)).sort((a, b) => score(a) - score(b));
    const candidate = available[0] ?? null;
    const current = paths.find(path => path.id === selected);
    if (!current || !healthy(current, now) || (candidate && candidate.id !== selected && now - switchedAt >= hold && score(candidate) + threshold < score(current))) {
      const id = candidate?.id ?? null;
      if (id !== selected) { selected = id; switchedAt = now; counters.routeChanges++; }
    }
    return available;
  }
  function retire(flow) { flows.delete(flow.peerId); flowIds.delete(flow.id); }
  function probe(path, now) {
    if (path.pending.size >= 256 || path.seq >= 0xffffffff) return;
    const seq = ++path.seq, payload = randomBytes(8);
    path.pending.set(seq, { at: now, payload }); path.lastProbe = now; path.sentProbes++;
    const wire = encodePacket({ type: PACKET_TYPES.PROBE, sessionId, flowId: 0, seq, payload }, key);
    send(path.socket, wire, path, () => { counters.socketErrors++; });
  }
  for (const path of paths) {
    path.socket.on('error', () => { counters.socketErrors++; });
    path.socket.on('message', (wire, from) => {
      if (closed) return;
      if (!samePeer(from, path)) { counters.droppedInvalid++; return; }
      let packet;
      try { packet = decodePacket(wire, key); } catch { counters.droppedInvalid++; return; }
      if (packet.sessionId !== sessionId) { counters.droppedInvalid++; return; }
      const now = performance.now();
      if (packet.type === PACKET_TYPES.PROBE_ACK && packet.flowId === 0) {
        const pending = path.pending.get(packet.seq);
        if (!pending || !packet.payload.equals(pending.payload)) { counters.droppedInvalid++; return; }
        path.pending.delete(packet.seq);
        const rtt = now - pending.at;
        if (rtt > timeout) { sample(path, false); return; }
        path.receivedProbes++; sample(path, true); path.lastAck = now;
        path.jitterMs = path.lastRtt === null ? 0 : path.jitterMs * 0.75 + Math.abs(rtt - path.lastRtt) * 0.25;
        path.lastRtt = rtt; path.rttMs = path.rttMs === null ? rtt : path.rttMs * 0.75 + rtt * 0.25;
        choose(now); return;
      }
      if (packet.type !== PACKET_TYPES.RETURN || packet.flowId === 0) { counters.droppedInvalid++; return; }
      const flow = flowIds.get(packet.flowId);
      if (!flow || now - flow.lastSeen > ttl) { if (flow) retire(flow); counters.droppedInvalid++; return; }
      if (packet.generation !== flow.generation) {
        if (flow.seenGenerations.has(packet.generation) || (flow.generation !== null && packet.issuedAt <= flow.latestReplyIssuedAt)) { counters.duplicateReturns++; return; }
        if (flow.seenGenerations.size >= 16) { retire(flow); counters.droppedCapacity++; return; }
        if (flow.generation !== null) counters.generationChanges++;
        flow.generation = packet.generation; flow.seenGenerations.add(packet.generation); flow.replies = new ReplayWindow();
      }
      if (!flow.replies.accept(packet.seq)) { counters.duplicateReturns++; return; }
      flow.latestReplyIssuedAt = Math.max(flow.latestReplyIssuedAt, packet.issuedAt);
      flow.lastSeen = now; counters.appReturned++;
      send(local, packet.payload, flow.peer, () => { counters.socketErrors++; });
    });
  }
  local.on('message', (payload, from) => {
    if (closed) return;
    counters.appReceived++;
    if (!from.address.startsWith('127.')) { counters.droppedInvalid++; return; }
    if (payload.length > MAX_PAYLOAD) { counters.droppedOversize++; return; }
    const now = performance.now(), available = choose(now);
    if (!available.length) { counters.droppedNoRoute++; return; }
    const peerId = peerKey(from);
    let flow = flows.get(peerId);
    if (flow && (now - flow.lastSeen > ttl || flow.seq >= 0xffffffff)) { retire(flow); flow = undefined; }
    if (!flow) {
      if (flows.size >= maxFlows || nextFlowId >= 0xffffffff) { counters.droppedCapacity++; return; }
      flow = { id: ++nextFlowId, peerId, peer: { address: from.address, port: from.port }, seq: 0, lastSeen: now, generation: null, latestReplyIssuedAt: -Infinity, seenGenerations: new Set(), replies: new ReplayWindow() };
      flows.set(peerId, flow); flowIds.set(flow.id, flow);
    }
    flow.lastSeen = now;
    const wire = encodePacket({ type: PACKET_TYPES.DATA, sessionId, flowId: flow.id, seq: ++flow.seq, payload }, key);
    const routes = mode === 'duplicate' ? available.slice(0, 2) : [paths.find(path => path.id === selected)];
    for (const path of routes) { send(path.socket, wire, path, () => { counters.socketErrors++; }); counters.dataSent++; }
  });
  try {
    await bindSocket(local, bind);
    for (const path of paths) await bindSocket(path.socket, { host: '0.0.0.0', port: 0 });
    const tick = () => {
      if (closed) return;
      const now = performance.now();
      for (const path of paths) {
        for (const [seq, pending] of path.pending) if (now - pending.at >= timeout) { path.pending.delete(seq); sample(path, false); }
        if (now - path.lastProbe >= interval) probe(path, now);
      }
      for (const flow of flows.values()) if (now - flow.lastSeen > ttl) retire(flow);
      choose(now);
    };
    tick(); timer = setInterval(tick, Math.min(interval, 50)); timer.unref();
  } catch (error) {
    closed = true; await Promise.all([closeSocket(local), ...paths.map(path => closeSocket(path.socket))]); key.fill(0); throw error;
  }
  return {
    address: () => local.address(),
    snapshot() {
      const now = performance.now();
      choose(now);
      return { address: closed ? null : local.address(), mode, selectedPath: selected, activeFlows: flows.size, counters: { ...counters }, paths: paths.map(path => ({ id: path.id, name: path.name, rttMs: path.rttMs, jitterMs: path.jitterMs, lossRate: loss(path), score: Number.isFinite(score(path)) ? score(path) : null, healthy: healthy(path, now), sentProbes: path.sentProbes, receivedProbes: path.receivedProbes, pendingProbes: path.pending.size })) };
    },
    setMode(value) { if (!['adaptive', 'duplicate'].includes(value)) throw new Error('Mode must be adaptive or duplicate'); mode = value; },
    async close() {
      if (closed) return; closed = true; clearInterval(timer);
      flows.clear(); flowIds.clear(); for (const path of paths) path.pending.clear();
      await Promise.all([closeSocket(local), ...paths.map(path => closeSocket(path.socket))]); key.fill(0);
    },
  };
}
