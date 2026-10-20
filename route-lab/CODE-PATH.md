# Representative RouteLab forwarding trace

This traces the independent prototype's source. It does not claim to trace ExitLag internals.

1. `createGateway` installs the local UDP `message` callback in `gateway.mjs:90`. It enforces local sender/payload bounds, calls `choose` (`gateway.mjs:37`), and allocates an application flow with a unique ID.
2. The callback calls `encodePacket` (`protocol.mjs:13`) for DATA at `gateway.mjs:106`. Adaptive mode sends it to the selected healthy relay; duplicate mode sends the same authenticated flow/sequence over up to two paths.
3. The entry's UDP callback (`relay.mjs:31`) calls `decodePacket` (`protocol.mjs:29`), verifies the session-to-source association and calls `forward` (`relay.mjs:23`) to its fixed configured upstream. Optional delay/loss is a laboratory simulation here.
4. The common exit's `handle` (`exit.mjs:54`) authenticates the packet and gets or creates its flow with `newFlow` (`exit.mjs:24`). `ReplayWindow.accept` is checked at `exit.mjs:78` before the asynchronous target-send path, so the second path's copy cannot redeliver to the target.
5. Each exit flow has a UDP socket connected to the fixed target (`exit.mjs:37`). Its `message` callback (`exit.mjs:40`) wraps a target response as RETURN with a sequence and authenticated generation, then sends it through recently used entry peers.
6. The gateway's per-path callback (`gateway.mjs:57`) verifies the peer/session, enforces generation ordering (`gateway.mjs:78`) and checks the reply replay window (`gateway.mjs:84`). It then sends one plaintext response to the original local application endpoint.

Probe entry is `probe` (`gateway.mjs:48`). PROBE travels through the same entry/exit path, and PROBE_ACK echoes an unpredictable challenge. The gateway measures RTT using the monotonic clock, smooths RTT/jitter and records recent probe outcomes. `choose` compares `RTT + 2*jitter + probeLoss*probeTimeout`, applies a minimum hold time and score margin for healthy-route switches, and permits immediate selection of another path after health expires. This is an independently designed policy.

Evidence: `test/flows.test.mjs` checks application isolation, expiry and restart recovery; `test/transport.test.mjs` checks target deduplication and replay; `test/demo.test.mjs` checks path selection, failure and duplicate mode. The retained successful run is `test-results.tap`.
