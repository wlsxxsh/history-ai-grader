$ErrorActionPreference = 'Stop'

function New-EncodedCommand {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ScriptText
  )

  return [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($ScriptText))
}

function Test-Endpoint {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Url
  )

  try {
    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
    return $response.StatusCode -ge 200
  } catch {
    return $false
  }
}

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverDir = Join-Path $root 'server'
$frontendDir = Join-Path $root 'frontend'
$logDir = Join-Path $root 'logs'
$ensureNativeScript = Join-Path $root 'scripts\ensure-native-bindings.js'

foreach ($path in @($root, $serverDir, $frontendDir)) {
  if (-not (Test-Path -LiteralPath $path)) {
    throw "Path not found: $path"
  }
}

if (-not (Test-Path -LiteralPath $logDir)) {
  New-Item -ItemType Directory -Path $logDir | Out-Null
}

$npmCommand = (Get-Command npm.cmd -ErrorAction Stop).Source
$backendLog = Join-Path $logDir 'backend.log'
$frontendLog = Join-Path $logDir 'frontend.log'

$frontendReady = Test-Endpoint -Url 'http://127.0.0.1:5173'
$backendReady = Test-Endpoint -Url 'http://127.0.0.1:3857/api/health'

if ($frontendReady -and $backendReady) {
  Start-Process 'http://127.0.0.1:5173'
  Write-Host 'Frontend and backend are already running.' -ForegroundColor Green
  exit 0
}

if (-not (Test-Path -LiteralPath $ensureNativeScript)) {
  throw "Native binding helper not found: $ensureNativeScript"
}

Write-Host 'Checking native bindings for current Windows architecture...' -ForegroundColor Cyan
& (Get-Command node.exe -ErrorAction Stop).Source $ensureNativeScript --all

if (-not (Test-Path -LiteralPath $backendLog)) {
  New-Item -ItemType File -Path $backendLog | Out-Null
}

if (-not (Test-Path -LiteralPath $frontendLog)) {
  New-Item -ItemType File -Path $frontendLog | Out-Null
}

try {
  Add-Content -Path $backendLog -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Starting backend..."
} catch {
}

try {
  Add-Content -Path $frontendLog -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Starting frontend..."
} catch {
}

$backendScript = @"
Set-Location -LiteralPath '$($serverDir -replace "'", "''")'
& '$($npmCommand -replace "'", "''")' run dev *>> '$($backendLog -replace "'", "''")'
"@

$frontendScript = @"
Set-Location -LiteralPath '$($frontendDir -replace "'", "''")'
& '$($npmCommand -replace "'", "''")' run dev -- --host 127.0.0.1 *>> '$($frontendLog -replace "'", "''")'
"@

if (-not $backendReady) {
  Start-Process -FilePath 'powershell.exe' -WorkingDirectory $serverDir -ArgumentList @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', (New-EncodedCommand -ScriptText $backendScript)
  ) | Out-Null
}

if (-not $frontendReady) {
  Start-Process -FilePath 'powershell.exe' -WorkingDirectory $frontendDir -ArgumentList @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', (New-EncodedCommand -ScriptText $frontendScript)
  ) | Out-Null
}

Write-Host 'Starting History AI Grader...' -ForegroundColor Cyan
Write-Host "Root: $root"
Write-Host 'Waiting for frontend and backend...' -ForegroundColor Yellow

for ($i = 0; $i -lt 45; $i++) {
  if (-not $frontendReady) {
    $frontendReady = Test-Endpoint -Url 'http://127.0.0.1:5173'
  }

  if (-not $backendReady) {
    $backendReady = Test-Endpoint -Url 'http://127.0.0.1:3857/api/health'
  }

  if ($frontendReady -and $backendReady) {
    break
  }

  Start-Sleep -Seconds 1
}

Write-Host ''
Write-Host "Backend log: $backendLog"
Write-Host "Frontend log: $frontendLog"

if ($frontendReady) {
  Start-Process 'http://127.0.0.1:5173'
  Write-Host 'Frontend ready: http://127.0.0.1:5173' -ForegroundColor Green
} else {
  Write-Host 'Frontend did not become ready in time. Please check frontend.log.' -ForegroundColor Red
}

if ($backendReady) {
  Write-Host 'Backend ready: http://127.0.0.1:3857/api/health' -ForegroundColor Green
} else {
  Write-Host 'Backend did not become ready in time. Please check backend.log.' -ForegroundColor Red
}

if (-not ($frontendReady -or $backendReady)) {
  throw 'Neither frontend nor backend started successfully.'
}
