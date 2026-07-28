#!/usr/bin/env bash
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

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
    npm run lint:fix || fail "ESLint 오류 (자동 수정 불가한 문제가 남아 있습니다)"
    info "Prettier 포맷 적용 중 (prettier --write)..."
    npm run format || fail "Prettier 포맷 실패"
    ok "린팅 + 포맷팅 완료"
    ;;
  check)
    info "ESLint 검사 중 (eslint --cache)..."
    npm run lint || fail "ESLint 검사 실패"
    info "Prettier 포맷 검사 중 (prettier --check)..."
    npm run format:check || fail "Prettier 포맷 검사 실패 (./script/lint.sh fix 로 수정하세요)"
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
