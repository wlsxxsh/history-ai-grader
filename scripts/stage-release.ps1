$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$releaseRoot = Join-Path $root 'release'
$stageDir = Join-Path $releaseRoot 'history-ai-grader-win-x64'
$frontendDistDir = Join-Path $root 'frontend\dist'
$serverDir = Join-Path $root 'server'
$serverNodeModulesDir = Join-Path $serverDir 'node_modules'
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source

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
New-Item -ItemType Directory -Force -Path $serverStageDir | Out-Null
New-Item -ItemType Directory -Force -Path $frontendStageDir | Out-Null
New-Item -ItemType Directory -Force -Path $dataStageDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $dataStageDir 'uploads') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $dataStageDir 'generated') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $stageDir 'logs') | Out-Null

Copy-Item -LiteralPath (Join-Path $serverDir 'src') -Destination $serverStageDir -Recurse -Force
Copy-Item -LiteralPath $serverNodeModulesDir -Destination $serverStageDir -Recurse -Force
Copy-Item -LiteralPath $frontendDistDir -Destination $frontendStageDir -Recurse -Force

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

Copy-Item -LiteralPath $nodeExe -Destination (Join-Path $stageDir 'node.exe') -Force

$appState = @'
{
  "settings": {
    "generalProvider": "doubao",
    "generalApiKey": "",
    "generalModel": "doubao-seed-2-0-pro-260215",
    "answerSheetProvider": "siliconflow",
    "answerSheetApiKey": "",
    "answerSheetModel": "PaddlePaddle/PaddleOCR-VL",
    "subjectiveGradingProvider": "siliconflow",
    "subjectiveGradingApiKey": "",
    "subjectiveGradingModel": "Pro/deepseek-ai/DeepSeek-R1",
    "apiBaseUrl": "https://ark.cn-beijing.volces.com/api/v3",
    "answerSheetBatchConcurrency": 2,
    "normalApiKey": "",
    "strongApiKey": "",
    "normalModel": "doubao-seed-2-0-lite-260215",
    "strongModel": "doubao-seed-2-0-pro-260215",
    "rolePreset": "objective",
    "customRolePrompt": "",
    "subjectiveOrdinaryRulePrompt": "",
    "subjectiveEssayRulePrompt": "",
    "classrooms": []
  },
  "tasks": [],
  "questions": [],
  "uploads": [],
  "answerSheets": [],
  "studentSummaries": []
}
'@

Set-Content -LiteralPath (Join-Path $dataStageDir 'app-state.json') -Value $appState -Encoding UTF8

$startBat = @'
@echo off
setlocal
set "ROOT=%~dp0"
set "SERVER_DIR=%ROOT%server"
if not exist "%ROOT%node.exe" (
  echo Missing bundled node.exe.
  pause
  exit /b 1
)
start "" http://127.0.0.1:3857
pushd "%SERVER_DIR%"
"%ROOT%node.exe" src\index.js
set "EXITCODE=%ERRORLEVEL%"
popd
if not "%EXITCODE%"=="0" (
  echo.
  echo Application exited with code %EXITCODE%.
  pause
)
endlocal
'@
Set-Content -LiteralPath (Join-Path $stageDir 'start.bat') -Value $startBat -Encoding ASCII

$startPs1 = @'
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverDir = Join-Path $root 'server'
$nodeExe = Join-Path $root 'node.exe'
Start-Process 'http://127.0.0.1:3857' | Out-Null
Push-Location $serverDir
try {
  & $nodeExe 'src/index.js'
} finally {
  Pop-Location
}
'@
Set-Content -LiteralPath (Join-Path $stageDir 'start.ps1') -Value $startPs1 -Encoding UTF8

$releaseReadme = @'
History AI Grader Portable Release

Quick Start
1. Extract the ZIP to a writable folder.
2. Double-click start.bat.
3. Open http://127.0.0.1:3857 if the browser does not open automatically.

Notes
- This release is intended for Windows x64.
- Runtime data is stored under data/ and logs are stored under logs/.
- API keys are configured inside the app and are not bundled with the release.
'@
Set-Content -LiteralPath (Join-Path $stageDir 'README.txt') -Value $releaseReadme -Encoding UTF8
