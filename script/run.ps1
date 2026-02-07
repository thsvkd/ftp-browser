#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# UTF-8 출력 보장
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
Set-Location $ProjectDir

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
Write-Host "  FTP Browser - 앱 실행 (dev)"
Write-Host "========================================="
& npm run dev
