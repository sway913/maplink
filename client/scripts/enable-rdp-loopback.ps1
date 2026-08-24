param(
    [string]$ResultPath = 'D:\work\frp-manager\dist\rdp-enable-result.json'
)

$ErrorActionPreference = 'Stop'

Set-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server' -Name fDenyTSConnections -Value 0
Set-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp' -Name UserAuthentication -Value 1
Start-Service -Name TermService

$terminalServer = Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server'
$rdpTcp = Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp'
$service = Get-Service -Name TermService

[pscustomobject]@{
    rdpAllowed = ($terminalServer.fDenyTSConnections -eq 0)
    nlaEnabled = ($rdpTcp.UserAuthentication -eq 1)
    serviceStatus = $service.Status.ToString()
    serviceStartType = $service.StartType.ToString()
    completedAt = (Get-Date).ToString('o')
} | ConvertTo-Json | Set-Content -LiteralPath $ResultPath -Encoding utf8
