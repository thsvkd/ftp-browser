#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# UTF-8 출력 보장
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
Set-Location $ProjectDir

function Write-Fail ($msg) { Write-Host "[FAIL]  $msg" -ForegroundColor Red; exit 1 }

function Write-Usage {
    Write-Host "사용법: .\script\run.ps1 [--devtools]"
    Write-Host "  (없음)      dev 모드로 실행"
    Write-Host "  --devtools  개발자 도구를 켠 채 실행 (F12 / Ctrl+Shift+C / Shift+우클릭 Inspect)"
}

# PowerShell 7에서 `& .\run.ps1 --devtools`는 `--`를 인자 종료 토큰으로 소비해
# 'devtools'만 넘긴다. -File 호출과 pwsh 직접 호출을 모두 받도록 두 형태를 인정한다.
$Mode = if ($args.Count -ge 1) { [string]$args[0] } else { "" }
$DevTools = $false
switch ($Mode) {
    "" { }
    { $_ -in "--devtools", "-devtools", "devtools" } { $DevTools = $true }
    { $_ -in "-h", "--help", "help" } { Write-Usage; exit 0 }
    default { Write-Usage; Write-Fail "알 수 없는 인자: $Mode" }
}

# -- 1. setup 먼저 실행 --
Write-Host "========================================="
Write-Host "  FTP Browser - 환경 확인"
Write-Host "========================================="
& powershell -NoProfile -ExecutionPolicy Bypass -File "$ScriptDir\setup.ps1"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host ""

# -- 2. 앱 실행 (dev 모드 - HMR 지원) --
# ELECTRON_RUN_AS_NODE 환경변수가 설정되면 Electron이 일반 Node.js로 동작하여
# require('electron')이 내장 모듈 대신 npm 패키지로 해석됨 (VSCode 터미널 등에서 발생)
$env:ELECTRON_RUN_AS_NODE = $null

Write-Host "========================================="
if ($DevTools) {
    Write-Host "  FTP Browser - 앱 실행 (dev, --devtools)"
} else {
    Write-Host "  FTP Browser - 앱 실행 (dev)"
}
Write-Host "========================================="

# `--`가 두 번 필요하다: 첫 번째는 npm이 소비해 인자를 스크립트로 넘기고, 두 번째는
# electron-vite가 자기 CLI 옵션과 Electron 인자를 가르는 구분자로 쓴다(ELECTRON_CLI_ARGS).
if ($DevTools) {
    & npm run dev -- -- --devtools
} else {
    & npm run dev
}
