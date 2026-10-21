# RouteLab

**An experimental Windows WireGuard route manager and UDP networking laboratory.**

RouteLab explores routing through infrastructure you control. It combines a local UDP lab for studying path selection, failover and packet deduplication with a separate Windows manager that prepares WireGuard configurations for selected IPv4 destinations.

**Prototype status:** local and configuration tests pass. Live Windows tunnel activation, Linux relay application and game performance improvements have not been verified. RouteLab does not supply relay servers or guarantee lower ping or packet loss.

## Two separate modes

| Mode | Purpose | Requirements |
| --- | --- | --- |
| **UDP laboratory** | Demonstrates authenticated forwarding, RTT/jitter/probe-loss measurement, adaptive path selection, failover and duplicate suppression using an owned echo target. | Node.js 24 or newer. The demo runs on loopback with simulated delay/loss. |
| **Game connection manager** | Generates paired WireGuard configurations and manages Windows tunnels for explicit game-server IPv4 addresses. Includes a Linux relay deployment script and ICMP comparisons. | Windows, official WireGuard, administrator approval, a relay you control and verified destination IPs. |

The lab's custom RLP2 multipath protocol is separate from WireGuard mode. Its simulated measurements are not measurements of a live game connection.

## Quick start

Install [Node.js](https://nodejs.org/) 24 or newer. The project uses Node's standard library and does not require `npm install`.

From this repository's root, start the local lab:

```sh
node cli.mjs demo
```

Open **http://127.0.0.1:8765**. The demo generates four small echo requests per second. Try **Baseline**, **Degrade A**, **Drop A** and **Duplicate paths**. Use **Ctrl+C** in the console to stop it.

On Windows, start the separate game connection manager:

```powershell
node .\cli.mjs games
```

Open **http://127.0.0.1:8766**. Read [GAME-MODE.md](GAME-MODE.md) before installing or activating a tunnel. The Windows `.cmd` launchers provide the same entry points when Node is on PATH.

## UDP laboratory architecture

```text
Opt-in UDP application
        ↓
Local gateway
        ↓ selected entry relay(s)
  Entry A       Entry B
        ↘       ↙
       Common exit
        ↓ once after deduplication
Fixed owned UDP target
```

The gateway probes each path and scores measured RTT, jitter and recent probe loss. Hysteresis limits healthy-path switching; a failed path allows failover. Duplicate mode sends the same flow/sequence over up to two healthy paths. The common exit deduplicates before target delivery, and the gateway deduplicates replies.

RLP2 uses AES-256-GCM with authenticated metadata, random nonces, freshness limits and bounded replay windows. It is a research protocol, not an audited VPN protocol. The lab accepts opt-in IPv4 UDP payloads up to 1200 bytes and does not capture installed games. See [DESIGN.md](DESIGN.md) and [CODE-PATH.md](CODE-PATH.md).

## WireGuard connection architecture

```text
Windows traffic to allowlisted IPv4 destinations
        ↓
Managed WireGuard tunnel
        ↓
Owned Linux relay with scoped forwarding/NAT
        ↓
Allowlisted game servers
```

The manager generates matching client/server keys and private configuration files, permits exact `/32` destination routes and a private relay probe route, and rejects default routes, DNS overrides and script hooks. The Windows helper is designed to verify a recent authenticated relay handshake and attempt rollback if setup fails. These privileged live paths still require validation on an owned deployment.

Routing is by destination IP, not executable identity. All applications sending to an allowlisted IP use that route. Traffic can include IPv4 TCP and UDP; IPv6 continues to use existing routing. Match-server addresses may change and are not discovered automatically.

The [Linux relay package](relay-server/README.md) defaults to a read-only plan and requires an explicit root apply. It scopes forwarding to the configured client and destination list. It is runtime-only; reboot requires explicit removal/reapplication.

## What this project does not establish

- No proven reduction in internet/game latency or packet loss.
- No supplied, purchased or automatically provisioned relay infrastructure.
- No automatic game detection, transparent per-process capture or IPv6 tunneling.
- No real-mode multipath, automatic relay ranking or high availability.
- No production security audit or production-ready VPN claim.
- No equivalence to a commercial network optimizer's proprietary algorithms.

A relay can improve or worsen a route. Two remote paths can still share a failing access link. ICMP replies may be filtered or deprioritized, so unanswered probes do not establish game UDP loss. Judge actual gameplay with comparable in-game measurements.

## Private configuration

Generated game profiles and keys are stored in `.private/`; lab role configs are generated in `config/`. Both are ignored by Git. The Windows manager restricts private storage access to the current user, SYSTEM and Administrators and rejects managed links/junctions.

Do not publish generated tunnel configs, private/preshared keys, `.env` files, captures or local logs. The repository includes source and tests, not live credentials, vendor application binaries or WireGuard installers. See [tools/README.md](tools/README.md) for the optional pinned MSI staging procedure.

## Tests and validation

```sh
npm test
```

On Windows, also run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\windows\Test-TunnelValidation.ps1
```

The development baseline on 20 October 2026 passed **44 Node tests and 21 Windows policy checks** using Node.js 24 on Windows. These cover loopback forwarding, replay handling, route selection, private profile generation, configuration rejection, HTTP boundaries, mocked Windows management and Linux relay plan parsing. They do not substitute for live tunnel or gameplay tests. See [TESTING.md](TESTING.md).

## Source map

| Files | Role |
| --- | --- |
| `protocol.mjs`, `gateway.mjs`, `relay.mjs`, `exit.mjs` | Independent UDP lab transport and routing |
| `demo.mjs`, `index.html` | Controlled topology and lab UI |
| `game-profile.mjs` | WireGuard key pairs and narrow configuration generation |
| `game-manager.mjs`, `game-mode.mjs`, `game.html` | Private profile storage, operations and game connection UI |
| `windows/`, `Invoke-Game-Action.ps1`, `Protect-Game-Data.ps1` | Windows policy, administrator boundary and private-file access |
| `relay-server/` | Owned Linux relay plan/apply/remove package |
| `dashboard.mjs`, `cli.mjs` | Local HTTP boundary and launch commands |

## License and dependencies

Licensed under the MIT License. See [LICENSE](../LICENSE) for details. External projects retain their own licenses; see [THIRD-PARTY.md](THIRD-PARTY.md).
