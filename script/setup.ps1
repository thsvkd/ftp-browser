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

# -- 1. Node.js 확인 --
$RequiredNodeMajor = 20

$nodePath = Get-Command node -ErrorAction SilentlyContinue
if ($nodePath) {
    $nodeVer = & node -v
    $nodeMajor = [int]($nodeVer -replace '^v(\d+)\..*', '$1')
    if ($nodeMajor -ge $RequiredNodeMajor) {
        Write-Ok "Node.js $nodeVer"
    } else {
        Write-Fail "Node.js >= $RequiredNodeMajor 필요 (현재: $nodeVer). https://nodejs.org 에서 업그레이드하세요."
    }
} else {
    Write-Fail "Node.js가 설치되어 있지 않습니다. https://nodejs.org 에서 설치하세요."
}

# -- 2. npm 확인 --
$npmPath = Get-Command npm -ErrorAction SilentlyContinue
if ($npmPath) {
    $npmVer = & npm -v
    Write-Ok "npm $npmVer"
} else {
    Write-Fail "npm이 설치되어 있지 않습니다."
}

# -- 3. npm install (이미 설치된 경우 스킵) --
if ((Test-Path "node_modules") -and (Test-Path "node_modules\.package-lock.json")) {
    $pkgTime = (Get-Item "package.json").LastWriteTime
    $lockTime = (Get-Item "node_modules\.package-lock.json").LastWriteTime
    if ($pkgTime -gt $lockTime) {
        Write-Info "package.json이 변경되었습니다. 의존성 업데이트 중..."
        & npm install
        if ($LASTEXITCODE -ne 0) { Write-Fail "npm install 실패" }
        Write-Ok "의존성 업데이트 완료"
    } else {
        Write-Skip "node_modules 이미 최신 - npm install 스킵"
    }
} else {
    Write-Info "의존성 설치 중..."
    & npm install
    if ($LASTEXITCODE -ne 0) { Write-Fail "npm install 실패" }
    Write-Ok "의존성 설치 완료"
}

# -- 4. 네이티브 모듈 확인 (better-sqlite3, sharp) --
$nativeOk = $true

if (-not (Test-Path "node_modules\better-sqlite3\build\Release\better_sqlite3.node")) {
    $nativeOk = $false
}

$sharpCheck = & node -e "try { require('sharp'); process.exit(0) } catch { process.exit(1) }" 2>$null
if ($LASTEXITCODE -ne 0) {
    $nativeOk = $false
}

if ($nativeOk) {
    Write-Skip "네이티브 모듈 빌드 확인 - 이미 정상"
} else {
    Write-Info "네이티브 모듈 재빌드 중 (electron-builder install-app-deps)..."
    & npx electron-builder install-app-deps
    if ($LASTEXITCODE -ne 0) { Write-Fail "네이티브 모듈 빌드 실패. Visual Studio Build Tools가 설치되어 있는지 확인하세요." }
    Write-Ok "네이티브 모듈 빌드 완료"
}

# -- 5. 빌드 (out/ 디렉토리가 최신인지 확인) --
$needBuild = $false

if (-not (Test-Path "out\main") -or -not (Test-Path "out\renderer") -or -not (Test-Path "out\preload")) {
    $needBuild = $true
}

if (-not $needBuild -and (Test-Path "out\main\index.js")) {
    $outTime = (Get-Item "out\main\index.js").LastWriteTime
    $newerSrc = Get-ChildItem -Path "src" -Recurse -File | Where-Object { $_.LastWriteTime -gt $outTime } | Select-Object -First 1
    if ($newerSrc) {
        $needBuild = $true
    }
}

if ($needBuild) {
    Write-Info "프로젝트 빌드 중..."
    & npm run build
    if ($LASTEXITCODE -ne 0) { Write-Fail "빌드 실패" }
    Write-Ok "빌드 완료"
} else {
    Write-Skip "빌드 결과물 이미 최신 - 빌드 스킵"
}

Write-Host ""
Write-Host "v 세팅 완료! .\script\run.ps1 로 앱을 실행하세요." -ForegroundColor Green
