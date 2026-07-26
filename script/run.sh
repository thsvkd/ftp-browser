#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

RED='\033[0;31m'
NC='\033[0m'
fail() { echo -e "${RED}[FAIL]${NC}  $*"; exit 1; }

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
bash "$SCRIPT_DIR/setup.sh"
echo ""

# ── 2. 앱 실행 (dev 모드 — HMR 지원) ──────────────────
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
