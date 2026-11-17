# deploy-watch.ps1 — deploy watch APK to Xiaomi Watch 5
# Usage:
#   .\deploy-watch.ps1 -Device "192.0.2.11:42883"
param(
    [string]$Device = "",
    [string]$Apk = "$PSScriptRoot\watch-app\app\build\outputs\apk\release\app-release.apk"
)

$ErrorActionPreference = "Stop"
$pkg = "com.dsh.watchchat"
$activity = "$pkg/.MainActivity"

function Fail($msg) { Write-Host "[x] $msg" -ForegroundColor Red; exit 1 }

if (-not (Test-Path $Apk)) { Fail "APK missing: $Apk" }
$apkInfo = Get-Item $Apk
Write-Host "APK: $Apk ($([math]::Round($apkInfo.Length/1KB)) KB, $($apkInfo.LastWriteTime))"

if (-not $Device) {
    Write-Host "-> searching watch via mDNS..."
    for ($i = 0; $i -lt 5; $i++) {
        $line = (& adb mdns services 2>&1) | Where-Object { $_ -match "_adb-tls-connect" } | Select-Object -First 1
        if ($line -and $line -match "([0-9a-fA-F\.]+:\d+)") { $Device = $Matches[1]; break }
        Start-Sleep -Seconds 1
    }
    if (-not $Device -and (Test-Path "$PSScriptRoot\.last-watch")) {
        $Device = (Get-Content "$PSScriptRoot\.last-watch" -Raw).Trim()
    }
    if (-not $Device) { Fail "watch not found; pass -Device <ip:port>" }
}

Write-Host "-> connecting $Device"
$out = & adb connect $Device 2>&1
Write-Host "   $out" -ForegroundColor DarkGray
if ($out -match "cannot|failed|unable") { Fail "connect failed (stale address?)" }

$state = (& adb -s $Device get-state 2>&1).Trim()
if ($state -ne "device") { Fail "device state: $state" }
$Device | Set-Content "$PSScriptRoot\.last-watch"

Write-Host "-> installing APK"
$install = (& adb -s $Device install -r $Apk 2>&1) | Out-String
Write-Host "   $install" -ForegroundColor DarkGray
if ($install -notmatch "Success") { Fail "install failed" }

Write-Host "-> launching app"
$start = (& adb -s $Device shell am start -W -n $activity 2>&1) | Out-String
Write-Host "   $($start.Trim())" -ForegroundColor DarkGray

Write-Host "-> screenshot"
& adb -s $Device shell screencap -p /sdcard/watch.png | Out-Null
$shots = Join-Path $PSScriptRoot "watch-shots"
New-Item -ItemType Directory -Force -Path $shots | Out-Null
$local = Join-Path $shots "screen.png"
& adb -s $Device pull /sdcard/watch.png $local | Out-Null
& adb -s $Device shell rm /sdcard/watch.png | Out-Null
if (Test-Path $local) {
    $len = (Get-Item $local).Length
    Write-Host "   screenshot: $local ($len bytes)" -ForegroundColor DarkGray
}
Write-Host "[ok] deployed" -ForegroundColor Green
