#Requires -Version 5.1
. "$PSScriptRoot\_common.ps1"

function Write-Usage {
    Write-Host "사용법: .\script\setup.ps1 [--no-build]"
    Write-Host "  (없음)      의존성 확인 + 프로덕션 빌드까지 수행"
    Write-Host "  --no-build  프로덕션 빌드 대신 타입체크만 수행 (dev 실행 전 단계용)"
}

# PowerShell은 `--` 단독 토큰만 인자 종료로 소비하므로 `--no-build`는 그대로 넘어온다.
# run.ps1과 같은 방식으로 세 형태를 모두 인정한다.
$Mode = if ($args.Count -ge 1) { [string]$args[0] } else { "" }
$NoBuild = $false
switch ($Mode) {
    "" { }
    { $_ -in "--no-build", "-no-build", "no-build" } { $NoBuild = $true }
    { $_ -in "-h", "--help", "help" } { Write-Usage; exit 0 }
    default { Write-Usage; Write-Fail "알 수 없는 인자: $Mode" }
}

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

& node -e "require('sharp')" 2>$null
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

# -- 5. 빌드 (--no-build면 타입체크만) --
if ($NoBuild) {
    # dev 모드에서는 electron-vite dev가 main/preload를 직접 빌드하고 renderer는 dev 서버가
    # 서빙한다. 여기서 프로덕션 빌드를 하면 main/preload가 곧바로 dev 산출물에 덮여
    # out/이 dev+프로덕션 혼합 상태가 되고, 시간만 버린다.
    # 다만 electron-vite dev는 타입체크를 하지 않으므로 타입 안전망은 남겨 둔다.
    Write-Info "타입체크 중 (빌드는 dev 서버가 담당)..."
    & npm run typecheck
    if ($LASTEXITCODE -ne 0) { Write-Fail "타입체크 실패" }
    Write-Ok "타입체크 통과"
} else {
    # 산출물 3종 중 하나라도 없으면 out/이 불완전하므로 무조건 다시 빌드한다.
    $buildArtifacts = @("out\main\index.js", "out\preload\index.js", "out\renderer\index.html")
    # src/ 외에 빌드 결과를 바꾸는 루트 설정 파일들.
    $buildConfigs = @(
        "package.json", "electron.vite.config.ts",
        "tsconfig.json", "tsconfig.node.json", "tsconfig.web.json",
        "tailwind.config.js", "postcss.config.js"
    )

    $needBuild = $false
    $missing = @($buildArtifacts | Where-Object { -not (Test-Path $_) })
    if ($missing.Count -gt 0) {
        $needBuild = $true
    } else {
        # 가장 오래된 산출물을 기준으로 삼아야 일부만 갱신된 out/을 최신으로 오판하지 않는다.
        $oldestOut = ($buildArtifacts | ForEach-Object { (Get-Item $_).LastWriteTime } | Sort-Object)[0]
        $buildInputs = @(Get-ChildItem -Path "src" -Recurse -File) +
                       @($buildConfigs | Where-Object { Test-Path $_ } | ForEach-Object { Get-Item $_ })
        $newerInput = $buildInputs | Where-Object { $_.LastWriteTime -gt $oldestOut } | Select-Object -First 1
        if ($newerInput) { $needBuild = $true }
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
}

# 호출한 스크립트가 $LASTEXITCODE로 성공 여부를 판정할 수 있도록 명시적으로 종료한다.
# (생략하면 직전 네이티브 명령의 종료 코드가 그대로 남아 오탐이 난다.)
exit 0
