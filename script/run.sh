#!/usr/bin/env bash
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

usage() {
  echo "사용법: ./script/run.sh [--devtools]"
  echo "  (없음)      dev 모드로 실행"
  echo "  --devtools  개발자 도구를 켠 채 실행 (F12 / Ctrl+Shift+C / Shift+우클릭 Inspect)"
}

DEVTOOLS=0
case "${1:-}" in
  '') ;;
  --devtools) DEVTOOLS=1 ;;
  -h|--help|help) usage; exit 0 ;;
  *) usage; fail "알 수 없는 인자: $1" ;;
esac

# ── 1. setup 먼저 실행 ─────────────────────────────────
echo "========================================="
echo "  FTP Browser — 환경 확인"
echo "========================================="
# 아래 dev 실행이 곧바로 다시 빌드하므로 프로덕션 빌드는 --no-build로 생략한다.
bash "$SCRIPT_DIR/setup.sh" --no-build
echo ""

# ── 2. 앱 실행 (dev 모드 — HMR 지원) ──────────────────
# ELECTRON_RUN_AS_NODE 환경변수가 설정되면 Electron이 일반 Node.js로 동작하여
# require('electron')이 내장 모듈 대신 npm 패키지로 해석됨 (VSCode 터미널 등에서 발생)
unset ELECTRON_RUN_AS_NODE

echo "========================================="
if [ "$DEVTOOLS" -eq 1 ]; then
  echo "  FTP Browser — 앱 실행 (dev, --devtools)"
else
  echo "  FTP Browser — 앱 실행 (dev)"
fi
echo "========================================="

# `--`가 두 번 필요하다: 첫 번째는 npm이 소비해 인자를 스크립트로 넘기고, 두 번째는
# electron-vite가 자기 CLI 옵션과 Electron 인자를 가르는 구분자로 쓴다(ELECTRON_CLI_ARGS).
if [ "$DEVTOOLS" -eq 1 ]; then
  npm run dev -- -- --devtools
else
  npm run dev
fi
