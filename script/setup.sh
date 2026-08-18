#!/usr/bin/env bash
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

usage() {
  echo "사용법: ./script/setup.sh [--no-build]"
  echo "  (없음)      의존성 확인 + 프로덕션 빌드까지 수행"
  echo "  --no-build  프로덕션 빌드 대신 타입체크만 수행 (dev 실행 전 단계용)"
}

NO_BUILD=0
case "${1:-}" in
  '') ;;
  --no-build) NO_BUILD=1 ;;
  -h|--help|help) usage; exit 0 ;;
  *) usage; fail "알 수 없는 인자: $1" ;;
esac

# ── 1. Node.js 확인 ────────────────────────────────────
REQUIRED_NODE_MAJOR=22

if command -v node &>/dev/null; then
  NODE_VER="$(node -v)"
  NODE_MAJOR="${NODE_VER%%.*}"
  NODE_MAJOR="${NODE_MAJOR#v}"
  if (( NODE_MAJOR >= REQUIRED_NODE_MAJOR )); then
    ok "Node.js $NODE_VER"
  else
    fail "Node.js >= $REQUIRED_NODE_MAJOR 필요 (현재: $NODE_VER). nvm install --lts 로 업그레이드하세요."
  fi
else
  fail "Node.js가 설치되어 있지 않습니다. nvm install --lts 로 설치하세요."
fi

# ── 2. npm 확인 ─────────────────────────────────────────
if command -v npm &>/dev/null; then
  ok "npm $(npm -v)"
else
  fail "npm이 설치되어 있지 않습니다."
fi

# ── 3. npm install (이미 설치된 경우 스킵) ─────────────
if [ -d "node_modules" ] && [ -f "node_modules/.package-lock.json" ]; then
  # package.json이 node_modules보다 새로운지 확인
  if [ "package.json" -nt "node_modules/.package-lock.json" ]; then
    info "package.json이 변경되었습니다. 의존성 업데이트 중..."
    npm install || fail "npm install 실패"
    ok "의존성 업데이트 완료"
  else
    warn "node_modules 이미 최신 — npm install 스킵"
  fi
else
  info "의존성 설치 중..."
  npm install || fail "npm install 실패"
  ok "의존성 설치 완료"
fi

# ── 4. Electron 바이너리 (43+ 는 postinstall 이 없음) ─
if [ ! -f "node_modules/electron/path.txt" ]; then
  info "Electron 바이너리 없음. 다운로드 중..."
  node node_modules/electron/install.js || fail "Electron 바이너리 설치 실패"
  ok "Electron 바이너리 설치 완료"
fi

# ── 5. 네이티브 모듈 확인 (better-sqlite3, sharp) ──────
NATIVE_OK=true

if [ ! -f "node_modules/better-sqlite3/build/Release/better_sqlite3.node" ]; then
  NATIVE_OK=false
fi

if ! node -e "require('sharp')" &>/dev/null; then
  NATIVE_OK=false
fi

if [ "$NATIVE_OK" = true ]; then
  warn "네이티브 모듈 빌드 확인 — 이미 정상"
else
  info "네이티브 모듈 재빌드 중 (electron-builder install-app-deps)..."
  npx electron-builder install-app-deps \
    || fail "네이티브 모듈 빌드 실패. 빌드 툴체인(python3, make, C++ 컴파일러)이 설치되어 있는지 확인하세요."
  ok "네이티브 모듈 빌드 완료"
fi

# ── 6. 빌드 (--no-build면 타입체크만) ──────────────────
if [ "$NO_BUILD" -eq 1 ]; then
  # dev 모드에서는 electron-vite dev가 main/preload를 직접 빌드하고 renderer는 dev 서버가
  # 서빙한다. 여기서 프로덕션 빌드를 하면 main/preload가 곧바로 dev 산출물에 덮여
  # out/이 dev+프로덕션 혼합 상태가 되고, 시간만 버린다.
  # 다만 electron-vite dev는 타입체크를 하지 않으므로 타입 안전망은 남겨 둔다.
  info "타입체크 중 (빌드는 dev 서버가 담당)..."
  npm run typecheck || fail "타입체크 실패"
  ok "타입체크 통과"
else
  # 산출물 3종 중 하나라도 없으면 out/이 불완전하므로 무조건 다시 빌드한다.
  BUILD_ARTIFACTS=("out/main/index.js" "out/preload/index.js" "out/renderer/index.html")
  # src/ 외에 빌드 결과를 바꾸는 루트 설정 파일들.
  BUILD_CONFIGS=(
    "package.json" "electron.vite.config.ts"
    "tsconfig.json" "tsconfig.node.json" "tsconfig.web.json"
    "tailwind.config.js" "postcss.config.js"
  )

  NEED_BUILD=false
  for artifact in "${BUILD_ARTIFACTS[@]}"; do
    if [ ! -f "$artifact" ]; then
      NEED_BUILD=true
      break
    fi
  done

  if [ "$NEED_BUILD" = false ]; then
    # 가장 오래된 산출물을 기준으로 삼아야 일부만 갱신된 out/을 최신으로 오판하지 않는다.
    OLDEST_OUT="$(ls -t "${BUILD_ARTIFACTS[@]}" | tail -1)"

    if [ -n "$(find src -type f -newer "$OLDEST_OUT" 2>/dev/null | head -1)" ]; then
      NEED_BUILD=true
    fi

    if [ "$NEED_BUILD" = false ]; then
      for config in "${BUILD_CONFIGS[@]}"; do
        if [ -f "$config" ] && [ "$config" -nt "$OLDEST_OUT" ]; then
          NEED_BUILD=true
          break
        fi
      done
    fi
  fi

  if [ "$NEED_BUILD" = true ]; then
    info "프로젝트 빌드 중..."
    npm run build || fail "빌드 실패"
    ok "빌드 완료"
  else
    warn "빌드 결과물 이미 최신 — 빌드 스킵"
  fi

  echo ""
  echo -e "${GREEN}✓ 세팅 완료!${NC} ./script/run.sh 로 앱을 실행하세요."
fi
