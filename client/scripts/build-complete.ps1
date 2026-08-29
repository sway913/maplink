param(
    [string]$Version
)

$ErrorActionPreference = 'Stop'

$clientDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$projectDir = [System.IO.Path]::GetFullPath((Join-Path $clientDir '..'))
$tauriDir = Join-Path $clientDir 'src-tauri'
$distDir = Join-Path $projectDir 'dist'
$stagingDir = Join-Path $distDir 'maplink-complete-package-staging'
$tauriConfig = Get-Content -LiteralPath (Join-Path $tauriDir 'tauri.conf.json') -Raw | ConvertFrom-Json
$configuredVersion = [string]$tauriConfig.version
if ($configuredVersion -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') {
    throw "tauri.conf.json 中的版本号无效：$configuredVersion"
}
if ($Version) {
    $requestedVersion = $Version.Trim().TrimStart('v')
    if ($requestedVersion -ne $configuredVersion) {
        throw "发布版本与应用版本不一致：发布 $requestedVersion，应用 $configuredVersion"
    }
}
$releaseVersion = "v$configuredVersion"
$portableZip = Join-Path $distDir "MapLink-Complete-$releaseVersion-win64.zip"
$installerOutput = Join-Path $distDir "MapLink-Complete-Setup-$releaseVersion-win64.exe"
$checksumOutput = Join-Path $distDir "MapLink-$releaseVersion-windows-x64-SHA256SUMS.txt"
$maxPackageBytes = 200MB
$frpc = Join-Path $tauriDir 'resources\frpc.exe'

if (-not (Test-Path -LiteralPath $frpc -PathType Leaf)) {
    throw "缺少内置 frpc：$frpc"
}
$frpcVersion = (& $frpc --version | Out-String).Trim()
if ($frpcVersion -ne '0.71.0') {
    throw "内置 frpc 版本错误：期望 0.71.0，实际 $frpcVersion"
}

Push-Location $clientDir
try {
    & (Join-Path $clientDir 'node_modules\.bin\tauri.cmd') build --bundles nsis
    if ($LASTEXITCODE -ne 0) {
        throw "Tauri 打包失败，退出码：$LASTEXITCODE"
    }
} finally {
    Pop-Location
}

$desktopBinary = Join-Path $tauriDir 'target\release\maplink-client.exe'
$installer = Get-ChildItem -LiteralPath (Join-Path $tauriDir 'target\release\bundle\nsis') -Filter '*-setup.exe' |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
if (-not (Test-Path -LiteralPath $desktopBinary -PathType Leaf)) {
    throw "客户端编译产物不存在：$desktopBinary"
}
if ($null -eq $installer) {
    throw 'Tauri 未生成 NSIS 安装包'
}

New-Item -ItemType Directory -Path $distDir -Force | Out-Null
$resolvedDist = [System.IO.Path]::GetFullPath($distDir).TrimEnd('\') + '\'
$resolvedStaging = [System.IO.Path]::GetFullPath($stagingDir)
if (-not $resolvedStaging.StartsWith($resolvedDist, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw '暂存目录不在 dist 目录内，拒绝继续'
}
if (Test-Path -LiteralPath $resolvedStaging) {
    Remove-Item -LiteralPath $resolvedStaging -Recurse -Force
}
New-Item -ItemType Directory -Path $resolvedStaging | Out-Null

Copy-Item -LiteralPath $desktopBinary -Destination (Join-Path $resolvedStaging 'MapLink-Client.exe')
Copy-Item -LiteralPath $frpc -Destination (Join-Path $resolvedStaging 'frpc.exe')
Copy-Item -LiteralPath (Join-Path $tauriDir 'resources\FRP-LICENSE') -Destination (Join-Path $resolvedStaging 'FRP-LICENSE.txt')
$packageGuide = Get-Content -LiteralPath (Join-Path $clientDir 'COMPLETE-PACKAGE.txt') -Raw
$packageGuide = $packageGuide.Replace('{{VERSION}}', $configuredVersion)
[System.IO.File]::WriteAllText(
    (Join-Path $resolvedStaging '使用说明.txt'),
    $packageGuide,
    [System.Text.UTF8Encoding]::new($false)
)

if (Test-Path -LiteralPath $portableZip) {
    Remove-Item -LiteralPath $portableZip -Force
}
Compress-Archive -Path (Join-Path $resolvedStaging '*') -DestinationPath $portableZip -CompressionLevel Optimal
Copy-Item -LiteralPath $installer.FullName -Destination $installerOutput -Force

foreach ($packagePath in @($portableZip, $installerOutput)) {
    $package = Get-Item -LiteralPath $packagePath
    if ($package.Length -ge $maxPackageBytes) {
        throw "发布包必须小于 200 MB：$($package.Name) 当前为 $([math]::Round($package.Length / 1MB, 2)) MB"
    }
}

$hashes = Get-FileHash -Algorithm SHA256 -LiteralPath $portableZip, $installerOutput | Sort-Object Path
$hashLines = $hashes | ForEach-Object { '{0}  {1}' -f $_.Hash.ToLowerInvariant(), (Split-Path $_.Path -Leaf) }
[System.IO.File]::WriteAllLines($checksumOutput, $hashLines, [System.Text.UTF8Encoding]::new($false))

$hashes
Get-Item -LiteralPath $checksumOutput
