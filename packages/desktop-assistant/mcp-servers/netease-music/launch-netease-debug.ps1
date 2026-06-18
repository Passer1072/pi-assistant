<#
.SYNOPSIS
  Launch NetEase Cloud Music (网易云音乐) with the Chromium remote-debugging port
  enabled, so the netease-music MCP server can attach and control it.

.DESCRIPTION
  The MCP control method needs the client's built-in DevTools Protocol endpoint,
  which only opens when cloudmusic.exe is started with --remote-debugging-port.
  This script makes sure exactly that happens. It does NOT modify any file in the
  install directory, so it never triggers NCM's startup-integrity protection.

.PARAMETER ExePath
  Full path to cloudmusic.exe. Default: D:\CloudMusic\CloudMusic\cloudmusic.exe

.PARAMETER Port
  Debug port. Default: 9222 (must match NCM_DEBUG_PORT given to the MCP server).

.PARAMETER Force
  If NCM is already running WITHOUT the debug port, restart it with the flag.

.EXAMPLE
  ./launch-netease-debug.ps1
  ./launch-netease-debug.ps1 -ExePath "C:\Path\cloudmusic.exe" -Port 9222 -Force
#>
param(
  [string]$ExePath = "D:\CloudMusic\CloudMusic\cloudmusic.exe",
  [int]$Port = 9222,
  [switch]$Force
)

function Test-DebugPort([int]$p) {
  $null -ne (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)
}

if (Test-DebugPort $Port) {
  Write-Host "OK: NetEase Cloud Music debug port $Port is already listening." -ForegroundColor Green
  exit 0
}

$running = Get-Process cloudmusic -ErrorAction SilentlyContinue
if ($running) {
  if (-not $Force) {
    Write-Warning "NetEase Cloud Music is running WITHOUT the debug port."
    Write-Warning "Re-run with -Force to restart it with --remote-debugging-port=$Port, or close it first."
    exit 1
  }
  Write-Host "Stopping existing NetEase Cloud Music to relaunch with the debug port..." -ForegroundColor Yellow
  Stop-Process -Name cloudmusic -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 1500
}

if (-not (Test-Path -LiteralPath $ExePath)) {
  Write-Error "cloudmusic.exe not found at: $ExePath"
  exit 2
}

Write-Host "Launching: $ExePath --remote-debugging-port=$Port" -ForegroundColor Cyan
Start-Process -FilePath $ExePath -ArgumentList "--remote-debugging-port=$Port"

for ($i = 0; $i -lt 25; $i++) {
  Start-Sleep -Milliseconds 1000
  if (Test-DebugPort $Port) {
    Write-Host "OK: debug port $Port is now listening. MCP server can attach." -ForegroundColor Green
    exit 0
  }
}

Write-Error "Timed out waiting for debug port $Port. The client may have ignored the flag."
exit 3
