#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][ValidateSet('install','connect','disconnect')][string]$Action,
    [string]$ConfigPath,
    [ValidatePattern('^routelab-[a-z0-9-]{1,7}$')][string]$TunnelName,
    [switch]$Elevated,
    [string]$ResultPath
)
$ErrorActionPreference='Stop'
$env:PSModulePath=Join-Path $PSHOME 'Modules'
$ProgressPreference='SilentlyContinue'
function Assert-PlainManagedPath([string]$Value) {
    $boundary=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '.private'))
    $cursor=[IO.Path]::GetFullPath($Value)
    if ($cursor -ne $boundary -and -not $cursor.StartsWith($boundary+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Path is outside private storage.' }
    while ($cursor.Length -ge $boundary.Length) {
        if (Test-Path -LiteralPath $cursor) { if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Managed paths cannot contain reparse points.' } }
        if ($cursor -eq $boundary) { break }
        $cursor=[IO.Path]::GetDirectoryName($cursor)
    }
}
try {
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    $principal=New-Object Security.Principal.WindowsPrincipal($identity)
    $admin=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    $identity.Dispose()
    $ps=Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if ($Action -eq 'connect') {
        if (-not $ConfigPath -or -not $TunnelName) { throw 'Managed configuration and name are required.' }
        $full=[IO.Path]::GetFullPath($ConfigPath)
        $privateRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '.private\profiles')) + [IO.Path]::DirectorySeparatorChar
        if (-not $full.StartsWith($privateRoot,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($full) -cne ($TunnelName+'.conf') -or $full -match '["\r\n]') { throw 'Configuration must be in the managed private profile directory.' }
        Assert-PlainManagedPath $full
    }
    if ($Elevated) {
        if (-not $admin -or -not $ResultPath) { throw 'Administrator context is required.' }
        $expected=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '.private\actions')) + [IO.Path]::DirectorySeparatorChar
        $result=[IO.Path]::GetFullPath($ResultPath)
        if (-not $result.StartsWith($expected,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetExtension($result) -ne '.json') { throw 'Result path is outside the managed action directory.' }
        Assert-PlainManagedPath $result
        $argsList=@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File')
        if ($Action -eq 'install') { $argsList+=(Join-Path $PSScriptRoot 'windows\Install-WireGuard.ps1') }
        else {
            $argsList+=(Join-Path $PSScriptRoot 'windows\RouteLab-Tunnel.ps1'); $argsList+=@('-Action',$Action,'-TunnelName',$TunnelName)
            if ($Action -eq 'connect') { $argsList+=@('-ConfigPath',$ConfigPath) }
        }
        $value=(& $ps @argsList 2>$null | Out-String).Trim()
        $parsed=$value | ConvertFrom-Json
        if ($null -eq $parsed.ok) { throw 'Elevated helper returned no result.' }
        $stream=[IO.File]::Open($result,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try { $bytes=(New-Object Text.UTF8Encoding($false)).GetBytes($value); $stream.Write($bytes,0,$bytes.Length) } finally { $stream.Dispose() }
        exit 0
    }
    $actionDir=Join-Path $PSScriptRoot '.private\actions'
    Assert-PlainManagedPath $actionDir
    $null=New-Item -ItemType Directory -Path $actionDir -Force
    $protection=(& $ps -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Protect-Game-Data.ps1') -Path (Join-Path $PSScriptRoot '.private') 2>$null | Out-String).Trim() | ConvertFrom-Json
    if (-not $protection.ok) { throw 'Private storage protection failed.' }
    $result=Join-Path $actionDir (([Guid]::NewGuid().ToString('N'))+'.json')
    $params=@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"'+$PSCommandPath+'"'),'-Action',$Action,'-Elevated','-ResultPath',('"'+$result+'"'))
    if ($TunnelName) { $params+=@('-TunnelName',$TunnelName) }
    if ($ConfigPath) { $params+=@('-ConfigPath',('"'+$ConfigPath+'"')) }
    # Windows UAC remains an explicit OS security boundary; it is never bypassed.
    $child=Start-Process -FilePath $ps -ArgumentList $params -Verb RunAs -WindowStyle Hidden -Wait -PassThru
    if ($child.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $result)) { throw 'Administrator operation was not completed.' }
    Get-Content -LiteralPath $result -Raw
    Remove-Item -LiteralPath $result
} catch {
    @{ok=$false;action=$Action;error='Windows administrator approval or the managed operation did not complete. No tunnel success is assumed.'} | ConvertTo-Json -Compress
    exit 1
}
