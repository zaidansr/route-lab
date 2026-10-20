#Requires -Version 5.1
<#
RouteLab's deliberately narrow WireGuard management boundary.
JSON is written to stdout; no secret key or native stderr is returned.
Only explicit IPv4 host routes and services named routelab-* are permitted.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('status', 'connect', 'disconnect', 'processes', 'measure')]
    [string]$Action,
    [string]$ConfigPath,
    [string]$TunnelName,
    [string]$HostAddress,
    [ValidateRange(1, 30)][int]$Count = 10,
    [ValidateRange(100, 1000)][int]$TimeoutMs = 1000,
    [string]$ProcessName
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $PSHOME 'Modules'
$ProgressPreference = 'SilentlyContinue'

function Write-JsonResult($Value) {
    $Value | ConvertTo-Json -Depth 12 -Compress | Write-Output
}

function Test-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        $principal = New-Object Security.Principal.WindowsPrincipal($identity)
        return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } finally { $identity.Dispose() }
}

function Assert-TunnelName([string]$Name) {
    if ($Name -cnotmatch '^routelab-[a-z0-9-]{1,7}$') {
        throw 'Tunnel name must match routelab-[a-z0-9-]{1,7}.'
    }
    return $Name
}

function Get-IPv4([string]$Value) {
    if ($Value -cnotmatch '^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$') {
        throw 'An unambiguous IPv4 literal is required.'
    }
    $parsed = $null
    if (-not [Net.IPAddress]::TryParse($Value, [ref]$parsed) -or $parsed.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) {
        throw 'An IPv4 literal is required.'
    }
    $octets = $parsed.GetAddressBytes()
    if ($octets[0] -eq 0 -or $octets[0] -ge 224 -or $Value -eq '255.255.255.255') {
        throw 'An IPv4 unicast address is required.'
    }
    return $parsed.ToString()
}

function Get-HostRoute([string]$Value) {
    if ($Value -notmatch '^([^/]+)/32$') { throw 'Only explicit IPv4 /32 host routes are allowed.' }
    $address = Get-IPv4 $Matches[1]
    if ($address.StartsWith('127.')) { throw 'Loopback routes are not allowed.' }
    return "$address/32"
}

function Test-PrivateIPv4([string]$Value) {
    $octets = ([Net.IPAddress]::Parse($Value)).GetAddressBytes()
    return ($octets[0] -eq 10 -or ($octets[0] -eq 172 -and $octets[1] -ge 16 -and $octets[1] -le 31) -or ($octets[0] -eq 192 -and $octets[1] -eq 168))
}

function Assert-Key([string]$Value) {
    if ($Value -cnotmatch '^[A-Za-z0-9+/]{43}=$') { throw 'A WireGuard key must be a canonical 32-byte base64 value.' }
    $decoded = [Convert]::FromBase64String($Value)
    try {
        if ($decoded.Length -ne 32 -or [Convert]::ToBase64String($decoded) -cne $Value) {
            throw 'A WireGuard key must be a canonical 32-byte base64 value.'
        }
    } finally { [Array]::Clear($decoded, 0, $decoded.Length) }
}

function Read-ManagedConfig([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { throw 'ConfigPath is required for connect.' }
    $item = Get-Item -LiteralPath $Path
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -gt 16384) {
        throw 'Configuration must be a regular file of at most 16 KiB.'
    }
    if ($item.Extension -cne '.conf') { throw 'Configuration must have the .conf extension.' }
    $name = Assert-TunnelName $item.BaseName
    if ($TunnelName -and $TunnelName -cne $name) { throw 'TunnelName must match the configuration filename.' }
    $sections = @{}
    $current = $null
    $markerFound = $false
    $contents = [IO.File]::ReadAllText($item.FullName)
    foreach ($raw in ($contents -split "`r?`n")) {
        $line = $raw.Trim()
        if ($line.StartsWith('# RouteLab managed profile:')) {
            if ($line -cne "# RouteLab managed profile: $name" -or $markerFound) { throw 'Configuration RouteLab marker must match its managed filename exactly.' }
            $markerFound = $true
        }
        if (-not $line -or $line.StartsWith('#')) { continue }
        if ($line -cmatch '^\[(Interface|Peer)\]$') {
            $current = $Matches[1]
            if ($sections.ContainsKey($current)) { throw 'Only one Interface and one Peer section are allowed.' }
            $sections[$current] = @{}
            continue
        }
        if (-not $current -or $line -cnotmatch '^([A-Za-z]+)\s*=\s*(.*?)\s*$') { throw 'Unrecognized configuration syntax.' }
        $key = $Matches[1]
        $value = $Matches[2]
        if ($sections[$current].ContainsKey($key)) { throw 'Duplicate configuration fields are not allowed.' }
        $allowed = if ($current -ceq 'Interface') { @('PrivateKey', 'Address', 'MTU') } else { @('PublicKey', 'PresharedKey', 'Endpoint', 'AllowedIPs', 'PersistentKeepalive') }
        if ($allowed -cnotcontains $key -or -not $value) { throw 'Unapproved or empty configuration field.' }
        $sections[$current][$key] = $value
    }
    $contents = $null
    if (-not $markerFound) { throw 'Configuration requires its matching RouteLab managed profile marker.' }
    if ($sections.Count -ne 2 -or -not $sections.ContainsKey('Interface') -or -not $sections.ContainsKey('Peer')) {
        throw 'Exactly one Interface and one Peer section are required.'
    }
    $iface = $sections['Interface']
    $peer = $sections['Peer']
    foreach ($key in @('PrivateKey', 'Address')) {
        if (-not $iface.ContainsKey($key)) { throw 'Required Interface field missing.' }
    }
    foreach ($key in @('PublicKey', 'Endpoint', 'AllowedIPs')) {
        if (-not $peer.ContainsKey($key)) { throw 'Required Peer field missing.' }
    }
    Assert-Key $iface['PrivateKey']
    Assert-Key $peer['PublicKey']
    if ($peer.ContainsKey('PresharedKey')) { Assert-Key $peer['PresharedKey'] }
    $interfaceAddress = Get-HostRoute $iface['Address']
    if ($iface.ContainsKey('MTU') -and ($iface['MTU'] -notmatch '^[0-9]{3,4}$' -or [int]$iface['MTU'] -lt 576 -or [int]$iface['MTU'] -gt 1420)) {
        throw 'MTU must be between 576 and 1420.'
    }
    if ($peer['Endpoint'] -notmatch '^([^:]+):([0-9]{1,5})$') { throw 'Endpoint must be an IPv4 literal and UDP port.' }
    $endpointAddress = Get-IPv4 $Matches[1]
    $endpointPort = [int]$Matches[2]
    if ($endpointPort -lt 1 -or $endpointPort -gt 65535 -or $endpointAddress.StartsWith('127.')) {
        throw 'Endpoint must use a non-loopback unicast IPv4 address and port 1-65535.'
    }
    $routes = @($peer['AllowedIPs'] -split ',' | ForEach-Object { Get-HostRoute $_.Trim() })
    if ($routes.Count -lt 1 -or $routes.Count -gt 256 -or @($routes | Select-Object -Unique).Count -ne $routes.Count) {
        throw 'AllowedIPs must contain 1-256 distinct IPv4 /32 host routes.'
    }
    if ($routes -contains "$endpointAddress/32" -or $routes -contains $interfaceAddress) {
        throw 'AllowedIPs must not route the relay endpoint or local tunnel address into itself.'
    }
    if ($peer.ContainsKey('PersistentKeepalive') -and ($peer['PersistentKeepalive'] -notmatch '^[0-9]{1,3}$' -or [int]$peer['PersistentKeepalive'] -gt 120)) {
        throw 'PersistentKeepalive must be between 0 and 120 seconds.'
    }
    $iface['PrivateKey'] = $null
    if ($peer.ContainsKey('PresharedKey')) { $peer['PresharedKey'] = $null }
    $probeAddress = $null
    foreach ($route in $routes) {
        $candidate = $route.Substring(0, $route.Length - 3)
        if (Test-PrivateIPv4 $candidate) { $probeAddress = $candidate; break }
    }
    return @{ name = $name; path = $item.FullName; address = $interfaceAddress; endpoint = "$endpointAddress`:$endpointPort"; allowedRoutes = $routes; probeAddress = $probeAddress }
}

function Get-WireGuardInstallation {
    $base = Join-Path $env:ProgramFiles 'WireGuard'
    $wireguard = Join-Path $base 'wireguard.exe'
    $wg = Join-Path $base 'wg.exe'
    $installed = (Test-Path -LiteralPath $wireguard -PathType Leaf) -and (Test-Path -LiteralPath $wg -PathType Leaf)
    if (-not $installed) { return @{ installed = $false; verified = $false; wireguard = $wireguard; wg = $wg } }
    foreach ($path in @($wireguard, $wg)) {
        $item = Get-Item -LiteralPath $path
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'WireGuard executable must not be a reparse point.' }
        $signature = Get-AuthenticodeSignature -LiteralPath $path
        if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate -or $signature.SignerCertificate.Subject -notmatch '(?:^|,\s*)(?:CN|O)=WireGuard LLC(?:,|$)') {
            throw 'WireGuard executable has no valid WireGuard LLC Authenticode signature.'
        }
    }
    return @{ installed = $true; verified = $true; wireguard = $wireguard; wg = $wg }
}

function Invoke-CheckedNative([string]$Executable, [string[]]$Arguments) {
    $oldPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = @(& $Executable @Arguments 2>$null)
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $oldPreference }
    if ($code -ne 0) { throw "WireGuard command failed with exit code $code. Administrator rights may be required." }
    $text = ($output -join "`n")
    if ($text.Length -gt 65536) { throw 'Unexpectedly large WireGuard status response.' }
    return $text
}

function Get-ManagedService([string]$Name) {
    return Get-Service -Name ('WireGuardTunnel$' + $Name) -ErrorAction SilentlyContinue
}

function Get-TunnelStatus([string]$Name, $Installation) {
    $service = Get-ManagedService $Name
    $result = [ordered]@{ name = $Name; service = if ($service) { $service.Status.ToString() } else { 'NotInstalled' }; publicKey = $null; peers = @(); statusAvailable = $false; warning = $null }
    if (-not $Installation.installed -or -not $service -or $service.Status -ne 'Running') { return $result }
    try {
        $result.publicKey = (Invoke-CheckedNative $Installation.wg @('show', $Name, 'public-key')).Trim()
        $peerMap = @{}
        foreach ($line in ((Invoke-CheckedNative $Installation.wg @('show', $Name, 'peers')) -split "`n")) {
            $key = $line.Trim()
            if ($key) { $peerMap[$key] = [ordered]@{ publicKey = $key; endpoint = $null; latestHandshake = $null; latestHandshakeAgeSeconds = $null; receivedBytes = 0; sentBytes = 0; allowedRoutes = @() } }
        }
        $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
        foreach ($field in @('endpoints', 'latest-handshakes', 'transfer', 'allowed-ips')) {
            foreach ($line in ((Invoke-CheckedNative $Installation.wg @('show', $Name, $field)) -split "`n")) {
                if (-not $line.Trim()) { continue }
                $parts = $line.Trim() -split '\s+'
                if ($parts.Count -lt 2 -or -not $peerMap.ContainsKey($parts[0])) { continue }
                $peer = $peerMap[$parts[0]]
                switch ($field) {
                    'endpoints' { $peer.endpoint = $parts[1] }
                    'latest-handshakes' {
                        $unix = [long]$parts[1]
                        if ($unix -gt 0) { $peer.latestHandshake = [DateTimeOffset]::FromUnixTimeSeconds($unix).UtcDateTime.ToString('o'); $peer.latestHandshakeAgeSeconds = [Math]::Max(0, $now - $unix) }
                    }
                    'transfer' { if ($parts.Count -ge 3) { $peer.receivedBytes = [long]$parts[1]; $peer.sentBytes = [long]$parts[2] } }
                    'allowed-ips' { $peer.allowedRoutes = @($parts[1..($parts.Count - 1)] -join ' ' -split '[,\s]+' | Where-Object { $_ }) }
                }
            }
        }
        $result.peers = @($peerMap.Values)
        $result.statusAvailable = $true
    } catch {
        $result.warning = 'Handshake and transfer status unavailable; try an elevated terminal.'
    }
    return $result
}

function Get-ProcessConnections {
    if ($ProcessName -and ($ProcessName.Length -gt 80 -or $ProcessName -match '[\r\n]')) { throw 'ProcessName filter is invalid.' }
    $warnings = New-Object 'System.Collections.Generic.List[string]'
    $processes = @(Get-Process | Where-Object { -not $ProcessName -or $_.ProcessName.IndexOf($ProcessName, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | Sort-Object ProcessName, Id | Select-Object -First 1024)
    $tcp = @(); $udp = @()
    try { $tcp = @(Get-NetTCPConnection -State Established -ErrorAction Stop | Select-Object -First 8192) } catch { $warnings.Add('TCP ownership data unavailable.') }
    try { $udp = @(Get-NetUDPEndpoint -ErrorAction Stop | Select-Object -First 8192) } catch { $warnings.Add('UDP ownership data unavailable.') }
    $entries = foreach ($process in $processes) {
        $processId = $process.Id
        [ordered]@{
            id = $processId
            name = $process.ProcessName
            tcp = @($tcp | Where-Object { $_.OwningProcess -eq $processId } | ForEach-Object { [ordered]@{ remoteAddress = $_.RemoteAddress; remotePort = $_.RemotePort; localPort = $_.LocalPort } })
            udpLocalPorts = @($udp | Where-Object { $_.OwningProcess -eq $processId } | Select-Object -ExpandProperty LocalPort -Unique)
        }
    }
    return [ordered]@{ ok = $true; action = 'processes'; processes = @($entries); warnings = @($warnings.ToArray()); caveat = 'TCP remote endpoints are observable. UDP ownership tables expose local ports, not the game server destination; UDP local ports are not remote port evidence.' }
}

function Measure-Icmp {
    if (-not $HostAddress) { throw 'HostAddress is required for measure.' }
    $address = Get-IPv4 $HostAddress
    $ping = New-Object Net.NetworkInformation.Ping
    $values = New-Object 'System.Collections.Generic.List[double]'
    try {
        for ($i = 0; $i -lt $Count; $i++) {
            try {
                $reply = $ping.Send($address, $TimeoutMs)
                if ($reply.Status -eq [Net.NetworkInformation.IPStatus]::Success) { $values.Add([double]$reply.RoundtripTime) }
            } catch { }
            if ($i -lt $Count - 1) { Start-Sleep -Milliseconds 100 }
        }
    } finally { $ping.Dispose() }
    $sorted = @($values.ToArray() | Sort-Object)
    $median = $null; $p95 = $null
    if ($sorted.Count) {
        $middle = [int][Math]::Floor($sorted.Count / 2)
        $median = if ($sorted.Count % 2) { $sorted[$middle] } else { ($sorted[$middle - 1] + $sorted[$middle]) / 2 }
        $p95 = $sorted[[int][Math]::Ceiling(0.95 * $sorted.Count) - 1]
    }
    return [ordered]@{ ok = $true; action = 'measure'; host = $address; sent = $Count; received = $sorted.Count; lossRate = ($Count - $sorted.Count) / [double]$Count; medianMs = $median; p95Ms = $p95; samplesMs = @($values.ToArray()); caveat = 'ICMP replies may be filtered or deprioritized. These measurements do not establish game UDP packet loss or gameplay latency.' }
}

try {
    if ($env:OS -ne 'Windows_NT') { throw 'This helper requires Windows.' }
    $admin = Test-Administrator
    if ($Action -eq 'processes') { Write-JsonResult (Get-ProcessConnections); exit 0 }
    if ($Action -eq 'measure') { Write-JsonResult (Measure-Icmp); exit 0 }
    if ($TunnelName) { $TunnelName = Assert-TunnelName $TunnelName }
    $installation = Get-WireGuardInstallation
    if ($Action -eq 'status') {
        $names = @()
        if ($TunnelName) { $names = @($TunnelName) }
        elseif ($ConfigPath) { $names = @((Read-ManagedConfig $ConfigPath).name) }
        else {
            $names = @(Get-Service -Name 'WireGuardTunnel$routelab-*' -ErrorAction SilentlyContinue | ForEach-Object { $_.Name.Substring('WireGuardTunnel$'.Length) } | Where-Object { $_ -cmatch '^routelab-[a-z0-9-]{1,7}$' })
        }
        $tunnels = @($names | ForEach-Object { Get-TunnelStatus $_ $installation })
        Write-JsonResult ([ordered]@{ ok = $true; action = 'status'; installed = $installation.installed; verified = $installation.verified; admin = $admin; tunnels = $tunnels })
        exit 0
    }
    if (-not $admin) { throw 'An elevated administrator terminal is required to connect or disconnect.' }
    if (-not $installation.installed) { throw 'Official WireGuard for Windows is not installed.' }
    if ($Action -eq 'connect') {
        $config = Read-ManagedConfig $ConfigPath
        if (-not $config.probeAddress) { throw 'Configuration requires an owned relay private IPv4 /32 route for the handshake health check.' }
        if (Get-ManagedService $config.name) { throw 'This managed tunnel service already exists. Disconnect it before applying a configuration.' }
        $verifiedHandshake = $false
        $connectFailed = $false
        $tunnel = $null
        $probe = New-Object Net.NetworkInformation.Ping
        try {
            $null = Invoke-CheckedNative $installation.wireguard @('/installtunnelservice', $config.path)
            $elapsed = [Diagnostics.Stopwatch]::StartNew()
            do {
                # An outbound packet initiates the authenticated WireGuard exchange.
                # ICMP need not receive a reply: only a fresh wg handshake is success.
                try { $null = $probe.Send($config.probeAddress, 500) } catch { }
                $tunnel = Get-TunnelStatus $config.name $installation
                if ($tunnel.statusAvailable) {
                    foreach ($peer in $tunnel.peers) {
                        if ($null -ne $peer.latestHandshakeAgeSeconds -and $peer.latestHandshakeAgeSeconds -lt 30) {
                            $verifiedHandshake = $true
                            break
                        }
                    }
                }
                if ($verifiedHandshake) { break }
                Start-Sleep -Milliseconds 300
            } while ($elapsed.ElapsedMilliseconds -lt 15000)
        } catch { $connectFailed = $true }
        finally { $probe.Dispose() }
        if ($verifiedHandshake) {
            Write-JsonResult ([ordered]@{ ok = $true; action = 'connect'; name = $config.name; endpoint = $config.endpoint; allowedRoutes = $config.allowedRoutes; handshakeVerified = $true; tunnel = $tunnel })
            exit 0
        }
        # The name did not exist before this attempt. Roll back only that new service.
        $rollbackSucceeded = $false
        try {
            if (Get-ManagedService $config.name) { $null = Invoke-CheckedNative $installation.wireguard @('/uninstalltunnelservice', $config.name) }
            $rollbackSucceeded = -not [bool](Get-ManagedService $config.name)
        } catch { }
        if (-not $rollbackSucceeded) {
            try {
                Stop-Service -Name ('WireGuardTunnel$' + $config.name) -Force -ErrorAction Stop
                $null = Invoke-CheckedNative $installation.wireguard @('/uninstalltunnelservice', $config.name)
                $rollbackSucceeded = -not [bool](Get-ManagedService $config.name)
            } catch { }
        }
        $failureReason = if ($connectFailed) { 'Tunnel installation or verification failed.' } else { 'No recent authenticated relay handshake within 15 seconds.' }
        if ($rollbackSucceeded) { $failureReason += ' The newly created service was removed.' }
        else { $failureReason += ' Automatic removal failed; stop the named RouteLab tunnel in an administrator terminal before playing.' }
        Write-JsonResult ([ordered]@{ ok = $false; action = 'connect'; name = $config.name; error = $failureReason; handshakeVerified = $false; rollback = $true; rollbackSucceeded = $rollbackSucceeded; tunnel = (Get-TunnelStatus $config.name $installation) })
        exit 1
    }
    if (-not $TunnelName) { throw 'TunnelName is required for disconnect.' }
    if (Get-ManagedService $TunnelName) { $null = Invoke-CheckedNative $installation.wireguard @('/uninstalltunnelservice', $TunnelName) }
    Write-JsonResult ([ordered]@{ ok = $true; action = 'disconnect'; name = $TunnelName; tunnel = (Get-TunnelStatus $TunnelName $installation) })
    exit 0
} catch {
    # Messages originate in this script and deliberately omit config values and native stderr.
    $message = $_.Exception.Message
    if ($message -notmatch '^(Tunnel name|An |A |Configuration |ConfigPath |TunnelName |Unrecognized |Only |Exactly |Required |Duplicate |Unapproved |MTU |Endpoint |AllowedIPs |Loopback |PersistentKeepalive |WireGuard |Official |This |ProcessName |HostAddress |Unexpectedly )') {
        $message = 'The requested operation failed. No private key or native command output is included.'
    }
    Write-JsonResult ([ordered]@{ ok = $false; action = $Action; error = $message })
    exit 1
}
