#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

# ── Colors ──────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[SKIP]${NC}  $*"; }
fail()  { echo -e "${RED}[FAIL]${NC}  $*"; exit 1; }

usage() {
  echo "사용법: ./script/test.sh [run|watch|coverage]"
  echo "  run      한 번 실행 (기본값, vitest run)"
  echo "  watch    파일 변경 감지 모드 (vitest)"
  echo "  coverage 커버리지 포함 실행 (vitest run --coverage)"
}

MODE="${1:-run}"

# ── 의존성 확인 ─────────────────────────────────────────
if [ ! -d "node_modules" ]; then
  fail "의존성이 설치되지 않았습니다. 먼저 ./script/setup.sh 를 실행하세요."
fi

# ── 테스트 실행 ─────────────────────────────────────────
case "$MODE" in
  run)
    info "테스트 실행 중 (vitest run)..."
    npm test
    ok "테스트 완료"
    ;;
  watch)
    info "테스트 watch 모드 (vitest) — 종료하려면 Ctrl+C..."
    npm run test:watch
    ;;
  coverage)
    info "테스트 + 커버리지 실행 중 (vitest run --coverage)..."
    npm run test:coverage
    ok "테스트 완료"
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage
    fail "알 수 없는 모드: $MODE"
    ;;
esac
