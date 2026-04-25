$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$releaseRoot = Join-Path $root 'release'
$stageDir = Join-Path $releaseRoot 'history-ai-grader-win-x64'
$zipPath = Join-Path $releaseRoot 'history-ai-grader-win-x64.zip'

& (Join-Path $PSScriptRoot 'stage-release.ps1')
if ($LASTEXITCODE -ne 0) {
  throw "Staging failed with exit code $LASTEXITCODE."
}

if (Test-Path -LiteralPath $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}

Compress-Archive -Path (Join-Path $stageDir '*') -DestinationPath $zipPath -Force
Write-Host "Created $zipPath"
