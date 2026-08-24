param(
    [string]$DistDir = (Join-Path $PSScriptRoot '..\..\dist'),
    [string]$AppVersion,
    [string]$ExpectedFRPCVersion = '0.71.0'
)

$ErrorActionPreference = 'Stop'
$clientDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $AppVersion) {
    $tauriConfig = Get-Content -LiteralPath (Join-Path $clientDir 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
    $AppVersion = [string]$tauriConfig.version
}
$AppVersion = $AppVersion.Trim().TrimStart('v')
$releaseVersion = "v$AppVersion"
$portableZip = Join-Path $DistDir "MapLink-Complete-$releaseVersion-win64.zip"
$installer = Join-Path $DistDir "MapLink-Complete-Setup-$releaseVersion-win64.exe"
$checksumFile = Join-Path $DistDir "MapLink-$releaseVersion-windows-x64-SHA256SUMS.txt"

if (-not (Test-Path -LiteralPath $portableZip -PathType Leaf)) {
    throw "缺少便携完整包：$portableZip"
}
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
    throw "缺少完整安装包：$installer"
}
if (-not (Test-Path -LiteralPath $checksumFile -PathType Leaf)) {
    throw "缺少 SHA-256 校验文件：$checksumFile"
}

$checksumLines = Get-Content -LiteralPath $checksumFile | Where-Object { $_.Trim() }
if ($checksumLines.Count -ne 2) {
    throw "SHA-256 校验文件应包含两个发布包，实际为 $($checksumLines.Count) 个"
}
foreach ($line in $checksumLines) {
    if ($line -notmatch '^([0-9a-f]{64})  (.+)$') {
        throw "SHA-256 校验行格式无效：$line"
    }
    $assetPath = Join-Path $DistDir $Matches[2]
    if (-not (Test-Path -LiteralPath $assetPath -PathType Leaf)) {
        throw "SHA-256 校验目标不存在：$assetPath"
    }
    $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $assetPath).Hash.ToLowerInvariant()
    if ($actualHash -ne $Matches[1]) {
        throw "SHA-256 校验失败：$assetPath"
    }
}

$extractDir = Join-Path ([System.IO.Path]::GetTempPath()) ("frp-desktop-package-smoke-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $extractDir | Out-Null
try {
    Expand-Archive -LiteralPath $portableZip -DestinationPath $extractDir
    $desktop = Join-Path $extractDir 'MapLink-Client.exe'
    $frpc = Join-Path $extractDir 'frpc.exe'
    if (-not (Test-Path -LiteralPath $desktop -PathType Leaf)) {
        throw '便携完整包内缺少 MapLink-Client.exe'
    }
    if (-not (Test-Path -LiteralPath $frpc -PathType Leaf)) {
        throw '便携完整包内缺少 frpc.exe'
    }
    $actualVersion = (& $frpc --version | Out-String).Trim()
    if ($actualVersion -ne $ExpectedFRPCVersion) {
        throw "frpc 版本错误：期望 $ExpectedFRPCVersion，实际 $actualVersion"
    }
} finally {
    if (Test-Path -LiteralPath $extractDir) {
        Remove-Item -LiteralPath $extractDir -Recurse -Force
    }
}

Write-Output "完整包验证通过：MapLink $AppVersion、frpc $ExpectedFRPCVersion、安装包、便携包和 SHA-256 均有效。"
