$ErrorActionPreference = 'Stop'

$clientDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$projectDir = [System.IO.Path]::GetFullPath((Join-Path $clientDir '..'))
$tauriDir = Join-Path $clientDir 'src-tauri'
$distDir = Join-Path $projectDir 'dist'
$stagingDir = Join-Path $distDir 'maplink-complete-package-staging'
$portableZip = Join-Path $distDir 'MapLink-Complete-v0.1.0-win64.zip'
$installerOutput = Join-Path $distDir 'MapLink-Complete-Setup-v0.1.0-win64.exe'
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
Copy-Item -LiteralPath (Join-Path $clientDir 'COMPLETE-PACKAGE.txt') -Destination (Join-Path $resolvedStaging '使用说明.txt')

if (Test-Path -LiteralPath $portableZip) {
    Remove-Item -LiteralPath $portableZip -Force
}
Compress-Archive -Path (Join-Path $resolvedStaging '*') -DestinationPath $portableZip -CompressionLevel Optimal
Copy-Item -LiteralPath $installer.FullName -Destination $installerOutput -Force

Get-FileHash -Algorithm SHA256 -LiteralPath $portableZip, $installerOutput
