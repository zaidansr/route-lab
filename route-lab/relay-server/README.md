# Owned Linux relay

This package turns **one dedicated Debian/Ubuntu host you own** into a single-client WireGuard relay. It forwards that client's IPv4 packets only to an explicit list of game-server `/32` addresses. It does not discover, rent, contact, or configure a cloud server for you, and it makes no claim that a relay will improve your ISP's route.

The server config and destination list come from RouteLab's profile generator. Keep the server and client configs private: they contain tunnel credentials. Transfer the server config using a secure channel to your own machine. Never paste it into a support ticket or source repository.

## Prerequisites

Use a fresh, dedicated host with a public IPv4 address, root access, and a known outbound interface (for example `eth0` or `ens3`). Existing VPNs, firewall managers, container networks and shared servers need separate integration; this script refuses naming collisions but does not audit their policies. An upstream cloud firewall/security group must allow your chosen WireGuard UDP port, normally `51820`. The script does not modify cloud firewalls.

Install prerequisites separately after reviewing your distribution's package sources:

```bash
sudo apt-get update
sudo apt-get install wireguard-tools iproute2 iptables procps systemd util-linux
```

No dependency is downloaded by this script. Check your host's WAN interface with `ip -4 route get 1.1.1.1`; this is a local route lookup and does not send a probe. The `dev` value is the interface to supply. The WireGuard name must be at most **15 characters** on Linux; use the generated `routelab-game` name consistently.

## Review, apply, and verify

Copy `route-lab-relay.sh`, the generated server config and its newline destination list to the host. These example filenames must match the actual generated files. Restrict their permissions, then review the read-only plan:

```bash
chmod 600 server.conf
bash route-lab-relay.sh --plan \
  --name routelab-game --config ./server.conf --interface eth0 \
  --destinations-file ./game-ips.txt
```

The default action is also `--plan`. It parses inputs without creating files or changing networking, and never prints keys. A destination list may contain one literal IPv4 address or `/32` per line, with blank lines and full-line `#` comments. It cannot contain subnets or default routes. At most 256 destinations are supported.

Apply exactly the reviewed inputs:

```bash
sudo bash route-lab-relay.sh --apply \
  --name routelab-game --config ./server.conf --interface eth0 \
  --destinations-file ./game-ips.txt
```

If the generator used a different port or tunnel subnet, also supply the matching `--port`, `--client-ip` and `--server-ip` arguments. Defaults are `51820`, `10.203.0.2`, and `10.203.0.1` respectively. The client/server addresses must differ and share a `/24`. The parser accepts exactly one interface and one peer; hooks such as `PostUp`/`PostDown`, DNS, extra peers, custom routes and `SaveConfig` are rejected.

The script installs `/etc/wireguard/routelab-game.conf` with restrictive permissions, records nonsecret ownership metadata in `/var/lib/route-lab-relay/routelab-game/`, enables runtime IPv4 forwarding, creates three dedicated firewall chains, and starts WireGuard. Existing interfaces/configs/chains are never overwritten. A failed new application attempts to roll back its interface, config, state, tagged rules, chains and immediate forwarding change. Review any error before retrying; do not delete a conflicting resource just because it has the same name.

After connecting the Windows profile, inspect the interface on the relay:

```bash
sudo wg show routelab-game
sudo ip -4 address show dev routelab-game
sudo iptables -S RL_routelab_game_F
sudo iptables -t nat -S RL_routelab_game_N
```

`wg show` displays public keys, endpoint, transfer counters and the latest handshake; it normally hides private/preshared keys. Do not use `showconf` in logs or screenshots, because it exposes credentials. A fresh handshake and increasing transfer counters verify connectivity; they do not prove a ping improvement. The client can send an ICMP echo probe to `10.203.0.1`, but this measures the client-to-relay path, not the complete path to the game.

## Policy and lifecycle

The WAN permits encrypted WireGuard UDP input. The tunnel permits an ICMP echo request to its server address. Forwarding/NAT permits only the configured client source address to the listed game destination addresses, plus established/related replies. Other input/forwarding through this tunnel is dropped. Existing host firewall policies and cloud policies can still prevent it from working. An administrator who changes the recorded chains/config must reconcile those changes explicitly; repeat apply validates the recorded installation and does not silently repair it.

**This version is runtime-only.** It does not enable a systemd unit, persist firewall rules, or alter `/etc/sysctl.conf`. Reboot stops its rules/interface. After reboot, explicitly remove the recorded installation and then apply again. This prevents booting a tunnel before its intended firewall policy is ready. Do not separately enable `wg-quick@routelab-game` without also designing persistent firewall ordering.

Remove only this recorded installation:

```bash
sudo bash route-lab-relay.sh --remove --name routelab-game
```

Removal stops its WireGuard interface, removes only its exact tagged jumps and three named chains, and deletes its owned config/state. It does not flush shared firewall chains, remove unrelated configs, delete source credentials, disable services, or restore an entire historical firewall snapshot. After a successful installation, removal **leaves global IPv4 forwarding unchanged** because another service might have begun depending on it. The message reports whether it was previously enabled. On a dedicated host you are decommissioning, review current needs before changing that global setting yourself.

This prototype does not offer high availability, rate limiting, multi-user isolation, automatic game IP discovery, IPv6, automatic reboot persistence or a production hardening claim. A WireGuard relay may add latency if its path is worse than the direct route. Measure comparable in-game sessions before retaining it.

## Local package checks

From this folder, run:

```bash
bash -n route-lab-relay.sh
node --test relay-package.test.mjs
```

The tests exercise Bash syntax, safe plan rendering, key suppression and rejection of malformed/injectable configurations. They never run `--apply`/`--remove` or send traffic. Actual Linux WireGuard/firewall application and public-relay performance require your own relay host and remain separate deployment checks.

Documented interfaces: [WireGuard quick start](https://www.wireguard.com/quickstart/), [wg-quick manual](https://git.zx2c4.com/wireguard-tools/about/src/man/wg-quick.8), [iptables manual](https://manpages.debian.org/bookworm/iptables/iptables.8.en.html).
