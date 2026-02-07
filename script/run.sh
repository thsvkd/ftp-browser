#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

# ── 1. setup 먼저 실행 ─────────────────────────────────
echo "========================================="
echo "  FTP Browser — 환경 확인"
echo "========================================="
bash "$SCRIPT_DIR/setup.sh"
echo ""

# ── 2. 앱 실행 (dev 모드 — HMR 지원) ──────────────────
echo "========================================="
echo "  FTP Browser — 앱 실행 (dev)"
echo "========================================="
npm run dev
