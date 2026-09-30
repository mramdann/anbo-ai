[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][ValidatePattern('^[a-p]{32}$')][string[]]$ExtensionId,
    [Parameter(Mandatory)][string]$SidecarPath,
    [Parameter(Mandatory)][string]$DescriptorPath,
    [Parameter(Mandatory)][string]$InstallDirectory,
    [ValidateSet('Chrome', 'Edge', 'Both')][string]$Browser = 'Both',
    [ValidatePattern('^com\.anbo\.browser_bridge(?:\.[a-f0-9]{16})?$')][string]$HostName = 'com.anbo.browser_bridge'
)

$ErrorActionPreference = 'Stop'
function Write-BridgeText([string]$Path, [string]$Content) {
    if ([IO.File]::Exists($Path) -and [IO.File]::ReadAllText($Path) -ceq $Content) { return }
    $temporary = Join-Path ([IO.Path]::GetDirectoryName($Path)) ([Guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllText($temporary, $Content, [Text.UTF8Encoding]::new($false))
        if ([IO.File]::Exists($Path)) { [IO.File]::Replace($temporary, $Path, [NullString]::Value) }
        else { [IO.File]::Move($temporary, $Path) }
    } finally {
        if ([IO.File]::Exists($temporary)) { Remove-Item -LiteralPath $temporary }
    }
}

$source = (Resolve-Path -LiteralPath $SidecarPath).ProviderPath
$descriptor = (Resolve-Path -LiteralPath $DescriptorPath).ProviderPath
$destination = [IO.Path]::GetFullPath($InstallDirectory)
for ($ancestor = $destination; $ancestor; $ancestor = [IO.Path]::GetDirectoryName($ancestor)) {
    if ((Test-Path -LiteralPath $ancestor) -and ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Bridge installation cannot use a reparse point: $ancestor"
    }
}
if (-not [IO.File]::Exists($source) -or -not [IO.File]::Exists($descriptor)) {
    throw 'SidecarPath and DescriptorPath must be existing files.'
}
$configPath = Join-Path $destination 'anbo-browser-native-host.json'
if (Test-Path -LiteralPath $configPath) {
    $existing = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if ($existing.descriptorPath -ne $descriptor) {
        throw 'This installation points at another Anbo instance. Use a separate installation directory.'
    }
}
$hostPath = Join-Path $destination 'anbo-browser.exe'
$manifestPath = Join-Path $destination "$HostName.json"
foreach ($path in @($configPath, $hostPath, $manifestPath)) {
    if ((Test-Path -LiteralPath $path) -and ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Bridge installation cannot overwrite a reparse point: $path"
    }
}
$origins = @($ExtensionId | ForEach-Object { "chrome-extension://$_/" })
$roots = @()
if ($Browser -in @('Chrome', 'Both')) { $roots += "Software\Google\Chrome\NativeMessagingHosts\$HostName" }
if ($Browser -in @('Edge', 'Both')) { $roots += "Software\Microsoft\Edge\NativeMessagingHosts\$HostName" }
$views = @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)
foreach ($root in $roots) {
    foreach ($view in $views) {
        $hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
        $key = $hive.OpenSubKey($root)
        try {
            if ($key) {
                $registered = $key.GetValue('')
                if ($registered -and $registered -ne $manifestPath) {
                    throw "A different bridge is already registered at $root ($view). Refusing to replace it."
                }
            }
        } finally {
            if ($key) { $key.Dispose() }
            $hive.Dispose()
        }
    }
}
if ($PSCmdlet.ShouldProcess($destination, "Register the browser bridge for $Browser using only descriptor $descriptor")) {
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    if ($source -ne $hostPath) {
        $needsCopy = -not (Test-Path -LiteralPath $hostPath)
        if (-not $needsCopy) { $needsCopy = (Get-FileHash -LiteralPath $source).Hash -ne (Get-FileHash -LiteralPath $hostPath).Hash }
        if ($needsCopy) {
            $temporary = Join-Path $destination ([Guid]::NewGuid().ToString('N') + '.tmp')
            try {
                [IO.File]::Copy($source, $temporary)
                if ([IO.File]::Exists($hostPath)) { [IO.File]::Replace($temporary, $hostPath, [NullString]::Value) }
                else { [IO.File]::Move($temporary, $hostPath) }
            }
            catch { throw "Cannot update the bridge. Disconnect all Anbo extension profiles, then retry setup. $($_.Exception.Message)" }
            finally { if ([IO.File]::Exists($temporary)) { Remove-Item -LiteralPath $temporary } }
        }
    }
    $config = @{ descriptorPath = $descriptor; allowedOrigins = $origins } | ConvertTo-Json
    Write-BridgeText $configPath $config
    $manifest = @{
        name = $HostName
        description = 'Anbo development browser bridge'
        path = $hostPath
        type = 'stdio'
        allowed_origins = $origins
    } | ConvertTo-Json
    Write-BridgeText $manifestPath $manifest
    foreach ($root in $roots) {
        foreach ($view in $views) {
            $hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
            $key = $hive.CreateSubKey($root)
            try { $key.SetValue('', $manifestPath, [Microsoft.Win32.RegistryValueKind]::String) }
            finally { $key.Dispose(); $hive.Dispose() }
        }
    }
    Write-Output "Registered $Browser bridge. No browser was launched and no profile data was copied."
}
