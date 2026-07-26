#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# UTF-8 출력 보장
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
Set-Location $ProjectDir

# -- Colors --
function Write-Info  ($msg) { Write-Host "[INFO]  $msg" -ForegroundColor Cyan }
function Write-Ok    ($msg) { Write-Host "[OK]    $msg" -ForegroundColor Green }
function Write-Skip  ($msg) { Write-Host "[SKIP]  $msg" -ForegroundColor Yellow }
function Write-Fail  ($msg) { Write-Host "[FAIL]  $msg" -ForegroundColor Red; exit 1 }

function Write-Usage {
    Write-Host "사용법: .\script\lint.ps1 [fix|check]"
    Write-Host "  fix    ESLint 자동 수정 + Prettier 포맷 적용 (기본값)"
    Write-Host "  check  ESLint 검사 + Prettier 포맷 검사 (수정 없음, CI용)"
}

$Mode = if ($args.Count -ge 1) { $args[0] } else { "fix" }

# -- 의존성 확인 --
if (-not (Test-Path "node_modules")) {
    Write-Fail "의존성이 설치되지 않았습니다. 먼저 .\script\setup.ps1 을 실행하세요."
}

# -- 린팅 + 포맷팅 --
switch ($Mode) {
    "fix" {
        Write-Info "ESLint 자동 수정 중 (eslint --cache --fix)..."
        & npm run lint:fix
        if ($LASTEXITCODE -ne 0) { Write-Fail "ESLint 오류 (자동 수정 불가한 문제가 남아 있습니다)" }
        Write-Info "Prettier 포맷 적용 중 (prettier --write)..."
        & npm run format
        if ($LASTEXITCODE -ne 0) { Write-Fail "Prettier 포맷 실패" }
        Write-Ok "린팅 + 포맷팅 완료"
    }
    "check" {
        Write-Info "ESLint 검사 중 (eslint --cache)..."
        & npm run lint
        if ($LASTEXITCODE -ne 0) { Write-Fail "ESLint 검사 실패" }
        Write-Info "Prettier 포맷 검사 중 (prettier --check)..."
        & npm run format:check
        if ($LASTEXITCODE -ne 0) { Write-Fail "Prettier 포맷 검사 실패 (.\script\lint.ps1 fix 로 수정하세요)" }
        Write-Ok "린팅 + 포맷 검사 통과"
    }
    { $_ -in "-h", "--help", "help" } {
        Write-Usage
    }
    default {
        Write-Usage
        Write-Fail "알 수 없는 모드: $Mode"
    }
}
