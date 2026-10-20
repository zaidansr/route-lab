#Requires -Version 5.1
# Local-only parser and configuration-policy regression checks. No services or routes are changed.
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$helper = Join-Path $PSScriptRoot 'RouteLab-Tunnel.ps1'
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($helper, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Helper has PowerShell syntax errors.' }
$functions = @('Assert-TunnelName', 'Get-IPv4', 'Get-HostRoute', 'Test-PrivateIPv4', 'Assert-Key', 'Read-ManagedConfig')
foreach ($definition in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
    if ($functions -contains $definition.Name) { . ([ScriptBlock]::Create($definition.Extent.Text)) }
}
$TunnelName = $null
$directory = Join-Path ([IO.Path]::GetTempPath()) ('routelab-validation-' + [Guid]::NewGuid().ToString('N'))
$null = [IO.Directory]::CreateDirectory($directory)
$path = Join-Path $directory 'routelab-test.conf'
$privateKey = [Convert]::ToBase64String((New-Object byte[] 32))
$publicKey = [Convert]::ToBase64String((New-Object byte[] 32))
$baseline = @"
# RouteLab managed profile: routelab-test
[Interface]
PrivateKey = $privateKey
Address = 10.77.0.2/32
MTU = 1380
[Peer]
PublicKey = $publicKey
Endpoint = 203.0.113.44:51820
AllowedIPs = 10.77.0.1/32, 198.51.100.25/32
PersistentKeepalive = 25
"@
$passed = New-Object 'System.Collections.Generic.List[string]'
function Check-Config([string]$Label, [string]$Content, [bool]$ShouldPass) {
    [IO.File]::WriteAllText($path, $Content, (New-Object Text.UTF8Encoding($false)))
    $accepted = $false
    try { $null = Read-ManagedConfig $path; $accepted = $true } catch { }
    if ($accepted -ne $ShouldPass) { throw "Configuration validation regression: $Label" }
    $passed.Add($Label)
}
try {
    Check-Config 'explicit host routes accepted' $baseline $true
    Check-Config 'default route rejected' ($baseline.Replace('198.51.100.25/32', '0.0.0.0/0')) $false
    Check-Config 'broad route rejected' ($baseline.Replace('198.51.100.25/32', '198.51.100.0/24')) $false
    Check-Config 'loopback route rejected' ($baseline.Replace('198.51.100.25/32', '127.0.0.1/32')) $false
    Check-Config 'endpoint recursive route rejected' ($baseline.Replace('198.51.100.25/32', '203.0.113.44/32')) $false
    Check-Config 'local tunnel recursive route rejected' ($baseline.Replace('198.51.100.25/32', '10.77.0.2/32')) $false
    Check-Config 'DNS field rejected' ($baseline.Replace('MTU = 1380', "MTU = 1380`nDNS = 1.1.1.1")) $false
    Check-Config 'script hook rejected' ($baseline.Replace('MTU = 1380', "MTU = 1380`nPostUp = harmless-test")) $false
    Check-Config 'second peer rejected' ($baseline + "`n[Peer]`nPublicKey = $publicKey") $false
    Check-Config 'duplicate field rejected' ($baseline.Replace('MTU = 1380', "MTU = 1380`nMTU = 1300")) $false
    Check-Config 'missing marker rejected' ($baseline.Replace('# RouteLab managed profile: routelab-test', '# unrelated')) $false
    Check-Config 'mismatched marker rejected' ($baseline.Replace('# RouteLab managed profile: routelab-test', '# RouteLab managed profile: routelab-other')) $false
    Check-Config 'noncanonical IPv4 rejected' ($baseline.Replace('198.51.100.25/32', '198.051.100.25/32')) $false
    Check-Config 'oversized MTU rejected' ($baseline.Replace('MTU = 1380', 'MTU = 1500')) $false
    Check-Config 'hostname endpoint rejected' ($baseline.Replace('203.0.113.44:51820', 'relay.example:51820')) $false
    Check-Config 'zero port rejected' ($baseline.Replace('203.0.113.44:51820', '203.0.113.44:0')) $false
    Check-Config 'invalid key rejected' ($baseline.Replace("PrivateKey = $privateKey", 'PrivateKey = INVALID')) $false
    $rejected = $false
    try { $null = Assert-TunnelName 'another-tunnel' } catch { $rejected = $true }
    if (-not $rejected) { throw 'Unmanaged tunnel name was accepted.' }
    $passed.Add('unmanaged tunnel name rejected')
    $rejected = $false
    try { $null = Assert-TunnelName 'routelab-toolong8' } catch { $rejected = $true }
    if (-not $rejected) { throw 'Overlength tunnel name was accepted.' }
    $passed.Add('overlength tunnel name rejected')
    foreach ($address in @('10.77.0.1', '172.16.0.1', '172.31.255.254', '192.168.8.1')) {
        if (-not (Test-PrivateIPv4 $address)) { throw 'A valid RFC1918 probe was rejected.' }
    }
    $passed.Add('RFC1918 relay probe ranges accepted')
    foreach ($address in @('172.15.0.1', '172.32.0.1', '198.51.100.1', '127.0.0.1')) {
        if (Test-PrivateIPv4 $address) { throw 'An address outside RFC1918 was accepted as relay private probe.' }
    }
    $passed.Add('non-RFC1918 addresses rejected as private relay probes')
    [ordered]@{ ok = $true; passed = $passed.Count; checks = @($passed.ToArray()); serviceChanges = $false; networkTraffic = $false } | ConvertTo-Json -Depth 3 -Compress
} finally {
    if ([IO.File]::Exists($path)) { [IO.File]::Delete($path) }
    [IO.Directory]::Delete($directory)
}
