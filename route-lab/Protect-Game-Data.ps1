#Requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Path)
$ErrorActionPreference='Stop'
$env:PSModulePath=Join-Path $PSHOME 'Modules'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '.private'))
if ([IO.Path]::GetFullPath($Path) -cne $root) { throw 'Only the RouteLab private directory can be protected.' }
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$owner=$identity.User
$identity.Dispose()
$entries=New-Object 'System.Collections.Generic.List[System.IO.FileSystemInfo]'
$pending=New-Object 'System.Collections.Generic.Queue[System.IO.DirectoryInfo]'
$first=Get-Item -LiteralPath $root -Force
if (-not $first.PSIsContainer) { throw 'Private storage must be a directory.' }
$pending.Enqueue($first)
while ($pending.Count) {
    $entry=$pending.Dequeue()
    if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Private storage cannot contain links or junctions.' }
    $entries.Add($entry)
    foreach ($child in $entry.GetFileSystemInfos()) {
        if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Private storage cannot contain links or junctions.' }
        if ($child -is [IO.DirectoryInfo]) { $pending.Enqueue($child) } else { $entries.Add($child) }
        if ($entries.Count+$pending.Count -gt 4096) { throw 'Private storage item limit exceeded.' }
    }
}
foreach ($entry in $entries) {
    $directory=$entry -is [IO.DirectoryInfo]
    if ($directory) { $acl=New-Object Security.AccessControl.DirectorySecurity } else { $acl=New-Object Security.AccessControl.FileSecurity }
    $acl.SetOwner($owner)
    $acl.SetAccessRuleProtection($true,$false)
    foreach ($sid in @($owner.Value,'S-1-5-18','S-1-5-32-544')) {
        $securityId=New-Object Security.Principal.SecurityIdentifier($sid)
        $inheritance=if ($directory) { [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
        $rule=New-Object Security.AccessControl.FileSystemAccessRule($securityId,[Security.AccessControl.FileSystemRights]::FullControl,$inheritance,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
        $acl.AddAccessRule($rule)
    }
    if ($directory) { [IO.Directory]::SetAccessControl($entry.FullName,$acl) } else { [IO.File]::SetAccessControl($entry.FullName,$acl) }
}
@{ok=$true;protected=$true;items=$entries.Count} | ConvertTo-Json -Compress
