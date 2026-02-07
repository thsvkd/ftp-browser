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

# ── 1. Node.js 확인 ────────────────────────────────────
REQUIRED_NODE_MAJOR=20

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
    npm install
    ok "의존성 업데이트 완료"
  else
    warn "node_modules 이미 최신 — npm install 스킵"
  fi
else
  info "의존성 설치 중..."
  npm install
  ok "의존성 설치 완료"
fi

# ── 4. 네이티브 모듈 확인 (better-sqlite3, sharp) ──────
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
  npx electron-builder install-app-deps
  ok "네이티브 모듈 빌드 완료"
fi

# ── 5. 빌드 (out/ 디렉토리가 최신인지 확인) ────────────
NEED_BUILD=false

if [ ! -d "out/main" ] || [ ! -d "out/renderer" ] || [ ! -d "out/preload" ]; then
  NEED_BUILD=true
fi

# src/ 내 파일이 out/ 보다 새로운지 확인
if [ "$NEED_BUILD" = false ]; then
  NEWEST_SRC="$(find src/ -type f -newer out/main/index.js 2>/dev/null | head -1)"
  if [ -n "$NEWEST_SRC" ]; then
    NEED_BUILD=true
  fi
fi

if [ "$NEED_BUILD" = true ]; then
  info "프로젝트 빌드 중..."
  npm run build
  ok "빌드 완료"
else
  warn "빌드 결과물 이미 최신 — 빌드 스킵"
fi

echo ""
echo -e "${GREEN}✓ 세팅 완료!${NC} ./script/run.sh 로 앱을 실행하세요."
