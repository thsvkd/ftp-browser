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
  echo "사용법: ./script/lint.sh [fix|check]"
  echo "  fix    ESLint 자동 수정 + Prettier 포맷 적용 (기본값)"
  echo "  check  ESLint 검사 + Prettier 포맷 검사 (수정 없음, CI용)"
}

MODE="${1:-fix}"

# ── 의존성 확인 ─────────────────────────────────────────
if [ ! -d "node_modules" ]; then
  fail "의존성이 설치되지 않았습니다. 먼저 ./script/setup.sh 를 실행하세요."
fi

# ── 린팅 + 포맷팅 ───────────────────────────────────────
case "$MODE" in
  fix)
    info "ESLint 자동 수정 중 (eslint --cache --fix)..."
    npm run lint:fix
    info "Prettier 포맷 적용 중 (prettier --write)..."
    npm run format
    ok "린팅 + 포맷팅 완료"
    ;;
  check)
    info "ESLint 검사 중 (eslint --cache)..."
    npm run lint
    info "Prettier 포맷 검사 중 (prettier --check)..."
    npm run format:check
    ok "린팅 + 포맷 검사 통과"
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage
    fail "알 수 없는 모드: $MODE"
    ;;
esac
