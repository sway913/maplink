param(
    [string]$DistDir = (Join-Path $PSScriptRoot '..\..\dist'),
    [string]$ExpectedVersion = '0.71.0'
)

$ErrorActionPreference = 'Stop'
$portableZip = Join-Path $DistDir 'MapLink-Complete-v0.1.0-win64.zip'
$installer = Join-Path $DistDir 'MapLink-Complete-Setup-v0.1.0-win64.exe'

if (-not (Test-Path -LiteralPath $portableZip -PathType Leaf)) {
    throw "缺少便携完整包：$portableZip"
}
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
    throw "缺少完整安装包：$installer"
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
    if ($actualVersion -ne $ExpectedVersion) {
        throw "frpc 版本错误：期望 $ExpectedVersion，实际 $actualVersion"
    }
} finally {
    if (Test-Path -LiteralPath $extractDir) {
        Remove-Item -LiteralPath $extractDir -Recurse -Force
    }
}

Write-Output "完整包验证通过：frpc $ExpectedVersion，便携包和安装包均存在。"
