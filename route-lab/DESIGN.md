# UDP laboratory design

This document describes the independent, dependency-free Node.js ESM UDP laboratory. The separate Windows WireGuard manager is documented in GAME-MODE.md. No ExitLag code, protocol, assets, licensing or infrastructure is used. The laboratory handles opt-in UDP traffic only; it does not intercept processes, load a driver, or change system routes.

## Topology

Opt-in UDP application → local gateway → selected entry relay(s) → common exit → fixed authorized UDP target. Replies return through recent paths; the gateway deduplicates replies. The common exit deduplicates DATA before forwarding to the target, so duplicate mode must not cause duplicate target delivery.

## Shared module APIs

`protocol.mjs` exports:

- `PACKET_TYPES = { PROBE: 1, PROBE_ACK: 2, DATA: 3, RETURN: 4, ERROR: 5 }`
- `MAX_PAYLOAD = 1200`
- `newSessionId()` returns 16 random bytes encoded as 32 lowercase hexadecimal characters.
- `encodePacket({ type, sessionId, flowId, seq, payload }, key)` returns a Buffer. key is a 32-byte Buffer; flowId/seq are uint32; payload is a Buffer <= MAX_PAYLOAD. Use AES-256-GCM, random 12-byte nonce per encoding, authenticated version/type/session/flow/sequence header, strict sizes and validation.
- `decodePacket(buffer, key)` returns that packet object or throws on malformed/unauthenticated data. Never execute or deserialize target code.
- `ReplayWindow` with `accept(uint32)` returning true for a new sequence within a bounded sliding window, false for duplicates or too-old sequences.

The implemented wire format is RLP2: a 66-byte authenticated header (magic, version, type, session, flow, sequence, timestamp, 16-byte reply generation, 12-byte nonce), ciphertext and a 16-byte GCM tag. RETURN decoding also exposes the authenticated `generation` and `issuedAt`. Other types require a zero generation. A new exit flow generation resets the gateway's reply replay window once; up to 16 observed generations are retained per flow, and retired generations cannot reset it again. Previously unseen generation changes must have a later issuedAt than the most recent accepted reply, so a delayed old generation cannot replace the new one; this assumes the exit clock does not roll backward. DATA replay state is not persistent across an exit restart, so rotate deployment keys after a restart. This is a research protocol, not a production security design.

`relay.mjs` exports async `createRelay({ bind: {host,port}, upstream: {host,port}, key, simulation: {delayMs,lossRate}, sessionTtlMs=60000, maxSessions=128 })`. Returned object: `address()`, `snapshot()`, `setSimulation({delayMs,lossRate})`, async `close()`. Authenticate every datagram before handling it. upstream is fixed configuration, never supplied by a packet. Map authenticated session IDs to their gateway endpoint, bounded/expired. Forward upstream responses only from the configured upstream endpoint. Delay/loss applies both directions, including probes. Limit payloads, delayed queues, sessions and timer resources; close cancels everything. Simulation is lab-only.

`exit.mjs` exports async `createExit({ bind: {host,port}, target: {host,port}, key, flowTtlMs=60000, maxFlows=256 })`. Returned object: `address()`, `snapshot()`, async `close()`. target is fixed configured destination. PROBE → PROBE_ACK echo. DATA → one target UDP socket per session/flow, replay/dedup before target forwarding. Track at most four recently active ingress endpoints per flow; reply RETURN with independently increasing uint32 sequence via recent endpoints. No arbitrary destination selected from packets. Replies from the target must come from the configured endpoint. Expire and close flow sockets. Reject malformed packets, invalid types/flows, oversized payloads and unauthenticated input. Avoid uncaught network errors.

`gateway.mjs` exports async `createGateway({ bind: {host,port}, relays: [{id,name,host,port}], key, mode='adaptive', probeIntervalMs=250, probeTimeoutMs=800, flowTtlMs=60000, maxFlows=256, routeHoldMs=1000, switchThresholdMs=5 })`. Returned object: `address()`, `snapshot()`, `setMode('adaptive'|'duplicate')`, async `close()`. Bind the application port to loopback by default. One encrypted outbound socket per relay, same random gateway session ID. Probe through each relay to the common exit, measure monotonic RTT/jitter and recent probe loss, expose health. Maintain bounded application-flow mapping and reply replay windows. Adaptive mode chooses healthy path with score based on RTT, jitter and probe loss; hysteresis avoids flapping but health failure permits immediate failover. Duplicate mode sends each DATA through up to two healthy routes with the SAME flow/sequence, and deduplicates RETURN. Do not retransmit arbitrary UDP automatically. Do not claim probe loss is application packet loss. Reject app datagrams >1200 and clean all sockets/timers on close.

Gateway snapshot includes `mode`, `selectedPath` (id/null), `paths` with `{id,name,rttMs,jitterMs,lossRate,score,healthy,sentProbes,receivedProbes}`, `activeFlows`, and counters. Extra fields allowed. Relay/exit snapshots include counters and relevant active session/flow counts, but never the key.

Core service factories bind port 0 for tests. Their address() exposes actual address/port. These are modules, not self-starting CLI scripts.

CLI/demo orchestration and the local dashboard compose these modules. Tests import the module APIs above. No npm dependencies or downloads are needed for the laboratory. Use Node.js 24 or newer. All tests and demo traffic use loopback and owned echo targets only.
