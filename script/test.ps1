#Requires -Version 5.1
. "$PSScriptRoot\_common.ps1"

function Write-Usage {
    Write-Host "사용법: .\script\test.ps1 [run|watch|coverage]"
    Write-Host "  run      한 번 실행 (기본값, vitest run)"
    Write-Host "  watch    파일 변경 감지 모드 (vitest)"
    Write-Host "  coverage 커버리지 포함 실행 (vitest run --coverage)"
}

$Mode = if ($args.Count -ge 1) { [string]$args[0] } else { "run" }

# -- 의존성 확인 --
if (-not (Test-Path "node_modules")) {
    Write-Fail "의존성이 설치되지 않았습니다. 먼저 .\script\setup.ps1 을 실행하세요."
}

# -- 테스트 실행 --
switch ($Mode) {
    "run" {
        Write-Info "테스트 실행 중 (vitest run)..."
        & npm test
        if ($LASTEXITCODE -ne 0) { Write-Fail "테스트 실패" }
        Write-Ok "테스트 완료"
    }
    "watch" {
        Write-Info "테스트 watch 모드 (vitest) - 종료하려면 Ctrl+C..."
        & npm run test:watch
        exit $LASTEXITCODE
    }
    "coverage" {
        Write-Info "테스트 + 커버리지 실행 중 (vitest run --coverage)..."
        & npm run test:coverage
        if ($LASTEXITCODE -ne 0) { Write-Fail "테스트 실패" }
        Write-Ok "테스트 완료"
    }
    { $_ -in "-h", "--help", "help" } {
        Write-Usage
        exit 0
    }
    default {
        Write-Usage
        Write-Fail "알 수 없는 모드: $Mode"
    }
}

exit 0
