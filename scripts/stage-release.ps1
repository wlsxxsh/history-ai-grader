$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$releaseRoot = Join-Path $root 'release'
$stageDir = Join-Path $releaseRoot 'history-ai-grader-win-x64'
$frontendDistDir = Join-Path $root 'frontend\dist'
$samplesDir = Join-Path $root 'Samples'
$serverDir = Join-Path $root 'server'
$serverNodeModulesDir = Join-Path $serverDir 'node_modules'
$releaseReadmeSource = Join-Path $PSScriptRoot 'release-readme.txt'
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$launcherName = -join @(
  [char]0x70B9
  [char]0x51FB
  [char]0x8FD9
  [char]0x91CC
  [char]0x6253
  [char]0x5F00
  [char]0x8F6F
  [char]0x4EF6
  '.bat'
)

if (-not (Test-Path -LiteralPath $serverNodeModulesDir)) {
  throw 'Missing server/node_modules. Please install dependencies first.'
}

& npm.cmd --prefix frontend run build
if ($LASTEXITCODE -ne 0) {
  throw "Frontend build failed with exit code $LASTEXITCODE."
}

if (-not (Test-Path -LiteralPath $frontendDistDir)) {
  throw 'Frontend build output was not created.'
}

if (Test-Path -LiteralPath $stageDir) {
  cmd /c rd /s /q "$stageDir"
}

New-Item -ItemType Directory -Force -Path $stageDir | Out-Null
$serverStageDir = Join-Path $stageDir 'server'
$frontendStageDir = Join-Path $stageDir 'frontend'
$dataStageDir = Join-Path $stageDir 'data'
$samplesStageDir = Join-Path $stageDir 'Samples'
New-Item -ItemType Directory -Force -Path $serverStageDir | Out-Null
New-Item -ItemType Directory -Force -Path $frontendStageDir | Out-Null
New-Item -ItemType Directory -Force -Path $dataStageDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $dataStageDir 'uploads') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $dataStageDir 'generated') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $stageDir 'logs') | Out-Null

Copy-Item -LiteralPath (Join-Path $serverDir 'src') -Destination $serverStageDir -Recurse -Force
Copy-Item -LiteralPath $serverNodeModulesDir -Destination $serverStageDir -Recurse -Force
Copy-Item -LiteralPath $frontendDistDir -Destination $frontendStageDir -Recurse -Force
if (Test-Path -LiteralPath $samplesDir) {
  Copy-Item -LiteralPath $samplesDir -Destination $samplesStageDir -Recurse -Force
}

foreach ($file in @('package.json', 'package-lock.json', 'nodemon.json')) {
  $source = Join-Path $serverDir $file
  if (Test-Path -LiteralPath $source) {
    Copy-Item -LiteralPath $source -Destination (Join-Path $stageDir "server\$file") -Force
  }
}

foreach ($file in @('LICENSE', '.env.example')) {
  $source = Join-Path $root $file
  if (Test-Path -LiteralPath $source) {
    Copy-Item -LiteralPath $source -Destination (Join-Path $stageDir $file) -Force
  }
}

Get-ChildItem -LiteralPath $root -File | Where-Object { $_.Extension -ieq '.md' } | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $stageDir $_.Name) -Force
}

Copy-Item -LiteralPath $nodeExe -Destination (Join-Path $stageDir 'node.exe') -Force

$launchPs1 = @'
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverDir = Join-Path $root 'server'
$nodeExe = Join-Path $root 'node.exe'
$appUrl = 'http://127.0.0.1:3857'
$healthUrl = "$appUrl/api/health"
$logDir = Join-Path $root 'logs'
$stdoutLog = Join-Path $logDir 'server.stdout.log'
$stderrLog = Join-Path $logDir 'server.stderr.log'

function Wait-ForEnter {
  param(
    [string]$Prompt = 'Press Enter to exit'
  )

  if ([Environment]::UserInteractive) {
    Read-Host $Prompt | Out-Null
  }
}

function Test-Health {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 2
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

if (-not (Test-Path -LiteralPath $nodeExe)) {
  Write-Host 'Missing bundled node.exe.'
  Write-Host 'Please make sure the ZIP has been fully extracted.'
  Wait-ForEnter
  exit 1
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

if (Test-Health) {
  if ($env:NO_BROWSER -ne '1') {
    Start-Process $appUrl | Out-Null
  }
  exit 0
}

$process = Start-Process -FilePath $nodeExe `
  -ArgumentList 'src/index.js' `
  -WorkingDirectory $serverDir `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdoutLog `
  -RedirectStandardError $stderrLog `
  -PassThru

$ready = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Seconds 1
  if (Test-Health) {
    $ready = $true
    break
  }

  if ($process.HasExited) {
    break
  }
}

if ($ready) {
  if ($env:NO_BROWSER -ne '1') {
    Start-Process $appUrl | Out-Null
  }
  exit 0
}

if (-not $process.HasExited) {
  try {
    $process | Stop-Process -Force
  } catch {
  }
}

Write-Host 'The app could not start successfully.'
Write-Host 'Please check logs\server.stdout.log and logs\server.stderr.log.'
Wait-ForEnter
exit 1
'@
Set-Content -LiteralPath (Join-Path $stageDir '_launch.ps1') -Value $launchPs1 -Encoding UTF8

$launcherBat = @'
@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0_launch.ps1"
endlocal
'@
Set-Content -LiteralPath (Join-Path $stageDir $launcherName) -Value $launcherBat -Encoding ASCII

$startBat = @'
@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0_launch.ps1"
endlocal
'@
Set-Content -LiteralPath (Join-Path $stageDir 'start.bat') -Value $startBat -Encoding ASCII

$startPs1 = @'
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $root '_launch.ps1')
'@
Set-Content -LiteralPath (Join-Path $stageDir 'start.ps1') -Value $startPs1 -Encoding UTF8

if (Test-Path -LiteralPath $releaseReadmeSource) {
  Copy-Item -LiteralPath $releaseReadmeSource -Destination (Join-Path $stageDir 'README.txt') -Force
} else {
  $fallbackReadme = @'
Portable Release

1. Extract the ZIP to a writable folder.
2. Run start.bat.
3. Open http://127.0.0.1:3857 if the browser does not open automatically.
'@
  Set-Content -LiteralPath (Join-Path $stageDir 'README.txt') -Value $fallbackReadme -Encoding UTF8
}
