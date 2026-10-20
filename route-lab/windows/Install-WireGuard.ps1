#Requires -Version 5.1
<# Installs only the pinned, authenticated official MSI already staged in tools/.
No download, tunnel activation, firewall change, or automatic reboot is performed. #>
[CmdletBinding()]
param([string]$MsiPath = (Join-Path $PSScriptRoot '..\tools\wireguard-amd64-1.1.1.msi'))

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $PSHOME 'Modules'
$ProgressPreference = 'SilentlyContinue'
$expectedHash = '7BFED60AD61B785C914B38B61555A975488E1D3EC472DBFB2FCDF498FCA75242'
try {
    if ($env:OS -ne 'Windows_NT') { throw 'This installer requires Windows.' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        $principal = New-Object Security.Principal.WindowsPrincipal($identity)
        if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'An elevated administrator terminal is required to install WireGuard.' }
    } finally { $identity.Dispose() }
    $file = Get-Item -LiteralPath $MsiPath
    if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $file.Extension -ine '.msi') { throw 'MSI must be a regular .msi file.' }
    if ((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash -cne $expectedHash) { throw 'The staged MSI SHA256 does not match the pinned official WireGuard 1.1.1 release.' }
    $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
    if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate -or $signature.SignerCertificate.Subject -notmatch '(?:^|,\s*)(?:CN|O)=WireGuard LLC(?:,|$)') { throw 'The MSI does not have a valid WireGuard LLC Authenticode signature.' }
    # The only interpolated argument is an existing local filename, quoted for msiexec.
    if ($file.FullName -match '["\r\n]') { throw 'The MSI filename contains an unsupported character.' }
    $msiexec = Join-Path $env:WINDIR 'System32\msiexec.exe'
    $arguments = '/i "' + $file.FullName + '" /qn DO_NOT_LAUNCH=1 /norestart'
    $process = Start-Process -FilePath $msiexec -ArgumentList $arguments -Wait -PassThru -WindowStyle Hidden
    $code = $process.ExitCode
    if ($code -notin @(0, 3010)) { throw "WireGuard MSI installation failed with exit code $code." }
    [ordered]@{ ok = $true; action = 'install'; version = '1.1.1'; exitCode = $code; restartRequired = ($code -eq 3010); tunnelActivated = $false } | ConvertTo-Json -Compress
    exit 0
} catch {
    $message = $_.Exception.Message
    if ($message -notmatch '^(This installer|An elevated|MSI must|The staged MSI|The MSI|WireGuard MSI)') { $message = 'WireGuard installation failed before confirmation; inspect the staged MSI and administrator context.' }
    [ordered]@{ ok = $false; action = 'install'; error = $message } | ConvertTo-Json -Compress
    exit 1
}
