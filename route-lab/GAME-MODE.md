# WireGuard game connection manager

This mode prepares a real WireGuard deployment and manages selected Windows destination routes. It requires Windows, official WireGuard, a dedicated Linux relay you control and verified game-server IPv4 addresses. No relay is included. Live tunnel operation and game performance remain unverified in the development baseline.

## Windows setup

Install Node.js 24 or newer and [official WireGuard for Windows](https://www.wireguard.com/install/). The repository does not redistribute WireGuard binaries. The optional dashboard installer requires the pinned MSI to be staged as described in [tools/README.md](tools/README.md).

Start the manager:

```powershell
node .\cli.mjs games
```

Open **http://127.0.0.1:8766**.

1. Enter the public IPv4 and UDP port of a relay you control, a short managed profile name such as `routelab-game`, and verified game-server IPv4 destinations.
2. Generate private deployment files. Their local folder is shown; private keys are never displayed in dashboard responses.
3. Deploy the matching server files on the relay using the instructions below.
4. Measure a game destination before connecting to record the current Windows route.
5. Click **Connect** and approve Windows administration. The helper is designed to accept the connection only after an authenticated relay handshake and attempt rollback on failure. Inspect any rollback failure before continuing.
6. Measure the same destination through the tunnel, then compare the game's own latency/jitter/loss during comparable sessions.
7. Click **Disconnect** before closing the dashboard. Closing the dashboard does not stop a Windows tunnel service.

Profiles use exact `/32` routes and a private relay probe address. Default tunnel addresses are `10.203.0.2` for the client and `10.203.0.1` for the server. Existing private-subnet or VPN conflicts are not automatically resolved. Profile names are limited to 15 characters for Linux compatibility.

Routing applies to every application using a listed IP. It is not restricted by executable identity, does not route IPv6 and does not automatically discover changing match-server addresses. The process inspector provides observed TCP destinations and local UDP ownership, not automatic identification of remote UDP match servers.

## Owned Linux relay

The generated profile directory contains:

- `client/routelab-game.conf`: the Windows client credential; keep it on the client.
- `server/routelab-game.conf`: the server credential.
- `server/game-ips.txt`: the explicit forwarding destination list.

Copy the server files and `relay-server/route-lab-relay.sh` securely to a dedicated Debian/Ubuntu host you control. Follow [relay-server/README.md](relay-server/README.md) for dependencies, cloud firewall requirements, lifecycle and rollback limitations.

Review the plan, replacing `eth0` with the actual outbound interface:

```bash
chmod 600 routelab-game.conf game-ips.txt
bash route-lab-relay.sh --plan --name routelab-game \
  --config ./routelab-game.conf --interface eth0 \
  --destinations-file ./game-ips.txt
```

Apply the reviewed inputs explicitly:

```bash
sudo bash route-lab-relay.sh --apply --name routelab-game \
  --config ./routelab-game.conf --interface eth0 \
  --destinations-file ./game-ips.txt
```

The package configures scoped forwarding/NAT and named firewall chains. It does not provision a VPS or change cloud firewall rules. It is runtime-only; reboot requires explicit remove/reapply. Live Linux application/removal has not been validated in the development baseline.

## Measurement and security limits

A recent handshake and increasing transfer counters establish tunnel activity, not a performance benefit or forwarding to every game server. The private relay probe measures client-to-relay reachability. ICMP loss is not proof of game UDP loss. A direct baseline means no selected RouteLab tunnel is active; other VPNs and routing policies can still affect it.

Private storage is `.private/`, excluded by Git. Never publish generated configurations. Windows actions use normal UAC approval and manage only RouteLab-named services. Failed status is not treated as an empty tunnel inventory, and disconnect remains available even if profile files are damaged.

This mode uses WireGuard rather than the lab's custom RLP2 protocol. It has no real-mode multipath, automatic relay selection, automatic game detection or production audit.

Documented interfaces: [Windows tunnel services](https://git.zx2c4.com/wireguard-windows/about/docs/enterprise.md), [Windows routing behavior](https://git.zx2c4.com/wireguard-windows/about/docs/netquirk.md), [WireGuard protocol](https://www.wireguard.com/protocol/).
