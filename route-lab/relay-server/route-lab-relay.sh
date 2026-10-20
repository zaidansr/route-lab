#!/usr/bin/env bash
# RouteLab: an explicitly scoped, single-client relay for a dedicated owned host.
# No eval/source, package installation, SSH, remote provisioning, or default routes.
set -Eeuo pipefail
umask 077

die() { printf 'RouteLab: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'USAGE'
Usage (read-only plan is the default):
  route-lab-relay.sh [--plan|--apply] --name routelab-game --config server.conf \
    --interface eth0 --destinations-file game-ips.txt \
    [--port 51820] [--client-ip 10.203.0.2] [--server-ip 10.203.0.1]
  route-lab-relay.sh --remove --name routelab-game

--apply and --remove require root. Debian/Ubuntu with wireguard-tools, iproute2,
iptables, procps and systemd already installed is required. No packages are installed.
Only explicitly listed IPv4 /32 destinations are forwarded. The relay permits
encrypted UDP input and a tunnel ICMP echo probe to the relay address.
No changes persist across reboot. Remove the recorded installation before reapplying
after reboot. Configuration keys are never printed. --remove preserves IP forwarding.
USAGE
}

mode=plan name='' config='' wan='' destinations_file=''
port=51820 client_ip=10.203.0.2 server_ip=10.203.0.1
action_seen=0
while (($#)); do
  case "$1" in
    --plan|--apply|--remove)
      ((action_seen == 0)) || die 'Choose one action.'
      mode=${1#--}; action_seen=1; shift ;;
    --name|--config|--interface|--destinations-file|--port|--client-ip|--server-ip)
      (($# >= 2)) || die "Missing value for $1."
      case "$1" in
        --name) name=$2 ;; --config) config=$2 ;; --interface) wan=$2 ;;
        --destinations-file) destinations_file=$2 ;; --port) port=$2 ;;
        --client-ip) client_ip=$2 ;; --server-ip) server_ip=$2 ;;
      esac
      shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) die 'Unknown option. Use --help.' ;;
  esac
done
[[ $name =~ ^routelab-[a-z0-9][a-z0-9-]{0,29}$ && ${#name} -le 15 ]] ||
  die 'Name must start routelab-, contain lowercase letters/digits/hyphens and fit the Linux 15-character interface limit.'
state_root=/var/lib/route-lab-relay
state=$state_root/$name
destination=/etc/wireguard/$name.conf
tag=route-lab:$name
chain_base=RL_${name//-/_}
chain_i=${chain_base}_I chain_f=${chain_base}_F chain_n=${chain_base}_N
destinations=()

trim() { local x=$1; x=${x#"${x%%[![:space:]]*}"}; x=${x%"${x##*[![:space:]]}"}; REPLY=$x; }
ipv4() {
  local value=$1 octet; local -a parts
  [[ $value =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || return 1
  IFS=. read -r -a parts <<< "$value"
  for octet in "${parts[@]}"; do
    [[ $octet == 0 || $octet != 0* ]] || return 1
    ((10#$octet <= 255)) || return 1
  done
  ((10#${parts[0]} > 0 && 10#${parts[0]} < 224 && 10#${parts[0]} != 127))
}
validate_settings() {
  [[ $wan =~ ^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,14}$ && $wan != "$name" ]] || die 'Invalid WAN interface.'
  [[ $port =~ ^[1-9][0-9]{0,4}$ ]] && ((port <= 65535)) || die 'Invalid UDP port.'
  ipv4 "$client_ip" && ipv4 "$server_ip" || die 'Client/server must be unicast IPv4 literals.'
  [[ $client_ip != "$server_ip" && ${client_ip%.*} == "${server_ip%.*}" ]] || die 'Client and server must differ and share a /24.'
  [[ ${client_ip##*.} != 0 && ${client_ip##*.} != 255 && ${server_ip##*.} != 0 && ${server_ip##*.} != 255 ]] || die 'Do not use subnet/broadcast addresses.'
}
read_destinations() {
  local file=$1 line ip
  [[ -f $file && ! -L $file ]] || die 'Destinations must be a regular non-symlink file.'
  destinations=()
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line%$'\r'}; trim "$line"; line=$REPLY
    [[ -z $line || $line == \#* ]] && continue
    ip=${line%/32}
    ipv4 "$ip" || die 'A destination is not a unicast IPv4 address or /32.'
    [[ $line == "$ip" || $line == "$ip/32" ]] || die 'Only /32 destination routes are allowed.'
    [[ $ip != "$server_ip" && $ip != "$client_ip" ]] || die 'Game destination overlaps the tunnel endpoint.'
    local seen=0 old
    for old in "${destinations[@]}"; do [[ $old == "$ip/32" ]] && seen=1; done
    ((seen)) || destinations+=("$ip/32")
    ((${#destinations[@]} <= 256)) || die 'At most 256 destination /32 routes are allowed.'
  done < "$file"
  ((${#destinations[@]})) || die 'Destination list is empty.'
}

private_key='' public_key='' preshared_key=''
read_config() {
  local file=$1 line section='' key value id
  local -A found=()
  [[ -f $file && ! -L $file ]] || die 'Configuration must be a regular non-symlink file.'
  (($(wc -c < "$file") <= 8192)) || die 'Configuration is too large.'
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line%$'\r'}; trim "$line"; line=$REPLY
    [[ -z $line || $line == \#* || $line == \;* ]] && continue
    if [[ $line == '[Interface]' || $line == '[Peer]' ]]; then
      [[ -z ${found["section:$line"]:-} ]] || die 'Duplicate configuration section.'
      found["section:$line"]=1; section=$line; continue
    fi
    [[ $line == *=* && -n $section ]] || die 'Invalid configuration structure.'
    trim "${line%%=*}"; key=$REPLY; trim "${line#*=}"; value=$REPLY
    id=$section:$key
    [[ -z ${found[$id]:-} ]] || die 'Duplicate configuration key.'
    found[$id]=1
    case "$id" in
      '[Interface]:Address') [[ $value == "$server_ip/24" ]] || die 'Server Address must match --server-ip with /24.' ;;
      '[Interface]:ListenPort') [[ $value == "$port" ]] || die 'ListenPort does not match --port.' ;;
      '[Interface]:PrivateKey') [[ $value =~ ^[A-Za-z0-9+/]{43}=$ ]] || die 'Invalid private key encoding.'; private_key=$value ;;
      '[Peer]:PublicKey') [[ $value =~ ^[A-Za-z0-9+/]{43}=$ ]] || die 'Invalid peer public key encoding.'; public_key=$value ;;
      '[Peer]:PresharedKey') [[ $value =~ ^[A-Za-z0-9+/]{43}=$ ]] || die 'Invalid preshared key encoding.'; preshared_key=$value ;;
      '[Peer]:AllowedIPs') [[ $value == "$client_ip/32" ]] || die 'Peer AllowedIPs must be exactly the client /32.' ;;
      *) die 'Unsupported configuration directive. Hooks, DNS, routes and extra peers are forbidden.' ;;
    esac
  done < "$file"
  for id in '[Interface]:Address' '[Interface]:ListenPort' '[Interface]:PrivateKey' '[Peer]:PublicKey' '[Peer]:AllowedIPs'; do
    [[ -n ${found[$id]:-} ]] || die 'Required configuration key is missing.'
  done
}
render_config() {
  printf '# RouteLab managed relay: %s\n[Interface]\nAddress = %s/24\nListenPort = %s\nPrivateKey = %s\n\n[Peer]\nPublicKey = %s\n' "$name" "$server_ip" "$port" "$private_key" "$public_key"
  [[ -z $preshared_key ]] || printf 'PresharedKey = %s\n' "$preshared_key"
  printf 'AllowedIPs = %s/32\n' "$client_ip"
}

read_manifest() {
  local key value; local -A fields=()
  [[ -d $state && ! -L $state && -f $state/manifest && ! -L $state/manifest ]] || die 'No owned RouteLab state was found.'
  while IFS='=' read -r key value || [[ -n $key ]]; do
    [[ -z ${fields[$key]:-} ]] || die 'Duplicate state field.'
    case "$key" in
      format) [[ $value == 1 ]] || die 'Unknown state format.' ;;
      name) [[ $value == "$name" ]] || die 'State name mismatch.' ;;
      wan) wan=$value ;; port) port=$value ;; client_ip) client_ip=$value ;; server_ip) server_ip=$value ;;
      forwarding_before) [[ $value == 0 || $value == 1 ]] || die 'Invalid forwarding state.'; forwarding_before=$value ;;
      *) die 'Invalid state manifest.' ;;
    esac
    fields[$key]=1
  done < "$state/manifest"
  for key in format name wan port client_ip server_ip forwarding_before; do [[ ${fields[$key]:-} == 1 ]] || die 'Incomplete state manifest.'; done
  validate_settings
  read_destinations "$state/destinations"
  [[ -f $destination && ! -L $destination ]] || die 'Owned server config is missing; manual recovery required.'
  IFS= read -r value < "$destination"
  [[ $value == "# RouteLab managed relay: $name" ]] || die 'Server configuration ownership marker does not match.'
}

ipt() { iptables -w 5 "$@"; }
chain_exists() { ipt -t "$1" -S "$2" >/dev/null 2>&1; }
add_rules() {
  local dest
  ipt -N "$chain_i"; created_i=1
  ipt -N "$chain_f"; created_f=1
  ipt -t nat -N "$chain_n"; created_n=1
  ipt -A "$chain_i" -s "$client_ip/32" -d "$server_ip/32" -p icmp --icmp-type echo-request -j ACCEPT
  ipt -A "$chain_i" -j DROP
  for dest in "${destinations[@]}"; do
    ipt -A "$chain_f" -i "$name" -o "$wan" -s "$client_ip/32" -d "$dest" -j ACCEPT
    ipt -A "$chain_f" -i "$wan" -o "$name" -s "$dest" -d "$client_ip/32" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    ipt -t nat -A "$chain_n" -d "$dest" -j MASQUERADE
  done
  ipt -A "$chain_f" -j DROP
  ipt -I INPUT 1 -i "$name" -m comment --comment "$tag" -j "$chain_i"; jump_i=1
  ipt -I FORWARD 1 -i "$name" -m comment --comment "$tag" -j "$chain_f"; jump_f_in=1
  ipt -I FORWARD 1 -o "$name" -m comment --comment "$tag" -j "$chain_f"; jump_f_out=1
  ipt -t nat -I POSTROUTING 1 -s "$client_ip/32" -o "$wan" -m comment --comment "$tag" -j "$chain_n"; jump_n=1
  ipt -I INPUT 1 -i "$wan" -p udp --dport "$port" -m comment --comment "$tag" -j ACCEPT; jump_udp=1
}
remove_jumps() {
  ipt -C INPUT -i "$wan" -p udp --dport "$port" -m comment --comment "$tag" -j ACCEPT 2>/dev/null &&
    ipt -D INPUT -i "$wan" -p udp --dport "$port" -m comment --comment "$tag" -j ACCEPT || true
  ipt -C INPUT -i "$name" -m comment --comment "$tag" -j "$chain_i" 2>/dev/null &&
    ipt -D INPUT -i "$name" -m comment --comment "$tag" -j "$chain_i" || true
  ipt -C FORWARD -i "$name" -m comment --comment "$tag" -j "$chain_f" 2>/dev/null &&
    ipt -D FORWARD -i "$name" -m comment --comment "$tag" -j "$chain_f" || true
  ipt -C FORWARD -o "$name" -m comment --comment "$tag" -j "$chain_f" 2>/dev/null &&
    ipt -D FORWARD -o "$name" -m comment --comment "$tag" -j "$chain_f" || true
  ipt -t nat -C POSTROUTING -s "$client_ip/32" -o "$wan" -m comment --comment "$tag" -j "$chain_n" 2>/dev/null &&
    ipt -t nat -D POSTROUTING -s "$client_ip/32" -o "$wan" -m comment --comment "$tag" -j "$chain_n" || true
}
remove_chains() {
  # Only this installation's three short, dedicated chains are flushed.
  if chain_exists filter "$chain_i"; then ipt -F "$chain_i"; ipt -X "$chain_i"; fi
  if chain_exists filter "$chain_f"; then ipt -F "$chain_f"; ipt -X "$chain_f"; fi
  if chain_exists nat "$chain_n"; then ipt -t nat -F "$chain_n"; ipt -t nat -X "$chain_n"; fi
}
verify_chains() {
  local dest
  chain_exists filter "$chain_i" && chain_exists filter "$chain_f" && chain_exists nat "$chain_n" || return 1
  [[ $(ipt -S "$chain_i" | wc -l) -eq 3 && $(ipt -S "$chain_f" | wc -l) -eq $((${#destinations[@]} * 2 + 2)) && $(ipt -t nat -S "$chain_n" | wc -l) -eq $((${#destinations[@]} + 1)) ]] || return 1
  ipt -C "$chain_i" -s "$client_ip/32" -d "$server_ip/32" -p icmp --icmp-type echo-request -j ACCEPT || return 1
  ipt -C "$chain_i" -j DROP && ipt -C "$chain_f" -j DROP || return 1
  for dest in "${destinations[@]}"; do
    ipt -C "$chain_f" -i "$name" -o "$wan" -s "$client_ip/32" -d "$dest" -j ACCEPT || return 1
    ipt -C "$chain_f" -i "$wan" -o "$name" -s "$dest" -d "$client_ip/32" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT || return 1
    ipt -t nat -C "$chain_n" -d "$dest" -j MASQUERADE || return 1
  done
}
require_root_tools() {
  ((EUID == 0)) || die 'Apply/remove requires root; use sudo after reviewing --plan.'
  local command
  for command in wg wg-quick ip iptables sysctl systemctl flock install wc grep stat; do
    command -v "$command" >/dev/null || die "Missing prerequisite: $command. Install prerequisites separately."
  done
  [[ -r /etc/os-release ]] || die 'This package supports dedicated Debian/Ubuntu hosts only.'
  # Never source os-release; only accept a literal distributor ID line.
  grep -Eq '^ID=(debian|ubuntu|"debian"|"ubuntu")$' /etc/os-release || die 'This package supports dedicated Debian/Ubuntu hosts only.'
  [[ ! -L $state_root && ! -L /etc/wireguard ]] || die 'Managed base directories must not be symlinks.'
  local directory permissions
  for directory in "$state_root" "$state" /etc/wireguard; do
    if [[ -e $directory ]]; then
      [[ -d $directory && ! -L $directory && $(stat -c %u -- "$directory") == 0 ]] || die 'Existing managed directory must be a root-owned real directory.'
      permissions=$(stat -c %a -- "$directory")
      (( (8#$permissions & 022) == 0 )) || die 'Managed directories must not be group/world writable.'
    fi
  done
  # Serialize RouteLab mutations. This lock contains no configuration or secrets.
  exec 9> /run/lock/route-lab-relay.lock
  flock -n 9 || die 'Another RouteLab apply/remove is in progress.'
}

if [[ $mode == remove ]]; then
  require_root_tools
  if [[ ! -e $state ]]; then printf 'No recorded RouteLab installation named %s; nothing changed.\n' "$name"; exit 0; fi
  read_manifest
  read_config "$destination"
  if ip link show dev "$name" >/dev/null 2>&1; then
    wg show "$name" >/dev/null 2>&1 || die 'Named interface is not WireGuard; refusing removal.'
    wg-quick down "$destination" >/dev/null 2>&1 || die 'Could not stop the owned interface. State preserved.'
  fi
  remove_jumps
  remove_chains
  rm -- "$destination" "$state/manifest" "$state/destinations"
  rmdir -- "$state"
  printf 'Removed only %s and its named firewall chains/configuration.\n' "$name"
  printf 'IPv4 forwarding is unchanged (was %s before installation). Other host services may depend on it.\n' "$forwarding_before"
  exit 0
fi

[[ -n $config && -n $destinations_file ]] || die '--config and --destinations-file are required.'
validate_settings
read_destinations "$destinations_file"
read_config "$config"
printf 'RouteLab %s: %s\n' "$mode" "$name"
printf '  Tunnel: %s/24; one client: %s/32; UDP port: %s; WAN: %s\n' "$server_ip" "$client_ip" "$port" "$wan"
printf '  Forward/NAT only %s -> these destinations:\n' "$client_ip"
printf '    %s\n' "${destinations[@]}"
printf '  Config destination: %s; state: %s\n' "$destination" "$state"
printf '  No default route, package install, remote connection or persistent firewall changes.\n'
[[ $mode == apply ]] || { printf 'Plan only: no host state changed.\n'; exit 0; }
require_root_tools
ip link show dev "$wan" >/dev/null 2>&1 || die 'WAN interface does not exist.'

# Repeat apply must be byte-for-byte identical and still live. Never silently repair
# or replace a deployment that may have been modified by another administrator.
if [[ -e $state ]]; then
  input_wan=$wan input_port=$port input_client=$client_ip input_server=$server_ip
  expected_config=$(render_config)
  expected_destinations=$(printf '%s\n' "${destinations[@]}")
  read_manifest
  [[ $wan == "$input_wan" && $port == "$input_port" && $client_ip == "$input_client" && $server_ip == "$input_server" ]] || die 'Existing settings differ. Remove the recorded installation explicitly before replacing it.'
  [[ $(cat "$destination") == "$expected_config" && $(printf '%s\n' "${destinations[@]}") == "$expected_destinations" ]] || die 'Existing configuration differs. Remove explicitly before replacing it.'
  wg show "$name" >/dev/null 2>&1 || die 'Recorded interface is not running. Remove explicitly, then apply again (for example after reboot).'
  verify_chains || die 'Owned firewall state differs. Remove explicitly, then apply again.'
  ipt -C INPUT -i "$name" -m comment --comment "$tag" -j "$chain_i" &&
  ipt -C FORWARD -i "$name" -m comment --comment "$tag" -j "$chain_f" &&
  ipt -C FORWARD -o "$name" -m comment --comment "$tag" -j "$chain_f" &&
  ipt -t nat -C POSTROUTING -s "$client_ip/32" -o "$wan" -m comment --comment "$tag" -j "$chain_n" &&
  ipt -C INPUT -i "$wan" -p udp --dport "$port" -m comment --comment "$tag" -j ACCEPT || die 'Owned firewall jumps are incomplete. Remove explicitly, then apply again.'
  printf 'Already applied; no changes made.\n'; exit 0
fi
[[ ! -e $destination && ! -L $destination ]] || die 'A configuration already exists; it will not be overwritten.'
ip link show dev "$name" >/dev/null 2>&1 && die 'An interface with that name already exists.'
chain_exists filter "$chain_i" && die 'An input chain with that name already exists.'
chain_exists filter "$chain_f" && die 'A forward chain with that name already exists.'
chain_exists nat "$chain_n" && die 'A NAT chain with that name already exists.'
ipt -C INPUT -i "$wan" -p udp --dport "$port" -m comment --comment "$tag" -j ACCEPT 2>/dev/null && die 'A matching tagged UDP firewall rule already exists.'
[[ -z $(ip -4 route show exact "${server_ip%.*}.0/24") ]] || die 'The tunnel /24 already has a route; choose a nonoverlapping tunnel subnet.'

created_i=0 created_f=0 created_n=0 jump_i=0 jump_f_in=0 jump_f_out=0 jump_n=0 jump_udp=0
started=0 wrote_config=0 wrote_state=0 changed_forwarding=0 committed=0
forwarding_before=$(sysctl -n net.ipv4.ip_forward)
[[ $forwarding_before == 0 || $forwarding_before == 1 ]] || die 'Unexpected IPv4 forwarding state.'
rollback() {
  local result=$?
  trap - EXIT INT TERM
  if ((committed == 0)); then
    set +e
    printf 'Apply did not complete; rolling back RouteLab resources.\n' >&2
    ((started)) && wg-quick down "$destination" >/dev/null 2>&1
    remove_jumps
    ((created_i)) && { ipt -F "$chain_i"; ipt -X "$chain_i"; }
    ((created_f)) && { ipt -F "$chain_f"; ipt -X "$chain_f"; }
    ((created_n)) && { ipt -t nat -F "$chain_n"; ipt -t nat -X "$chain_n"; }
    # Only revert our immediate failed transaction. Successful uninstall leaves
    # forwarding alone because a later unrelated service could depend on it.
    ((changed_forwarding)) && sysctl -q -w net.ipv4.ip_forward="$forwarding_before"
    ((wrote_config)) && rm -f -- "$destination"
    if ((wrote_state)); then rm -f -- "$state/manifest" "$state/destinations"; rmdir -- "$state"; fi
  fi
  exit "$result"
}
trap rollback EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
[[ -d $state_root ]] || install -d -m 700 -- "$state_root"
mkdir -m 700 -- "$state"; wrote_state=1
[[ -d /etc/wireguard ]] || install -d -m 700 -- /etc/wireguard
# noclobber prevents a last-moment configuration replacement.
(set -o noclobber; render_config > "$destination"); wrote_config=1
printf '%s\n' "${destinations[@]}" > "$state/destinations"
printf 'format=1\nname=%s\nwan=%s\nport=%s\nclient_ip=%s\nserver_ip=%s\nforwarding_before=%s\n' "$name" "$wan" "$port" "$client_ip" "$server_ip" "$forwarding_before" > "$state/manifest"
add_rules
if [[ $forwarding_before == 0 ]]; then sysctl -q -w net.ipv4.ip_forward=1; changed_forwarding=1; fi
# Set started before invoking wg-quick so a partially created interface is removed.
started=1
wg-quick up "$destination" >/dev/null 2>&1 || die 'WireGuard startup failed (keys are not logged).'
wg show "$name" >/dev/null 2>&1 || die 'WireGuard interface did not become ready.'
committed=1
printf 'Applied. WireGuard UDP %s is ready; no successful handshake is claimed.\n' "$port"
printf 'Runtime-only setup: reboot requires explicit --remove then --apply.\n'
printf 'Cloud security groups, if present, must permit this UDP port.\n'
