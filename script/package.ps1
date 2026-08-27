#Requires -Version 5.1
. "$PSScriptRoot\_common.ps1"

function Write-Usage {
    Write-Host "사용법: .\script\package.ps1"
    Write-Host "  Windows x64 NSIS 설치기와 portable exe를 dist/ 에 만든다."
}

$Mode = if ($args.Count -ge 1) { [string]$args[0] } else { "" }
switch ($Mode) {
    "" { }
    { $_ -in "-h", "--help", "help" } { Write-Usage; exit 0 }
    default { Write-Usage; Write-Fail "알 수 없는 인자: $Mode" }
}

if (-not (Test-Path "node_modules")) {
    Write-Fail "의존성이 설치되지 않았습니다. 먼저 .\script\setup.ps1 을 실행하세요."
}

Write-Info "Windows x64 패키징 중 (NSIS + portable)..."
& npm run build:win -- --x64 --publish never
if ($LASTEXITCODE -ne 0) { Write-Fail "패키징 실패" }
Write-Ok "패키징 완료. 산출물은 dist\ 를 확인하세요."

exit 0
