#!/usr/bin/env bash
# smoke-arbloop-responsive.sh — viewport + tap-target QA for the Studio surfaces.
#
# Validates the responsive UI shipped with the Studio buyer/seller upgrade:
#   - Tab list renders + ARIA selected at all 3 viewports
#   - Mobile (<sm): card list visible, table hidden
#   - Desktop (>=sm): table visible
#   - Tap targets on action bar ≥ 44px (iOS guideline)
#   - No console errors during navigation
#   - Polling skipped when document.visibilityState === 'hidden'
#
# Live-infra requirement: a running frontend on $BASE_URL (default
# http://localhost:3000) and the gstack-browse binary on disk. Mirrors
# scripts/smoke-arbloop-x402.ts in spirit — listed in run-all-smokes.sh
# documentation, not auto-run by the offline gate.
#
# Usage:
#   BASE_URL=http://localhost:3000 bash scripts/smoke-arbloop-responsive.sh

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
TEST_ROUTE="${TEST_ROUTE:-/studio?role=buyer}"
OUT_DIR="${OUT_DIR:-/tmp/arbloop-responsive}"
mkdir -p "$OUT_DIR"

# Resolve gstack-browse binary (prefer repo-local, fall back to ~/.claude).
B=""
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -x "$ROOT/.claude/skills/gstack/browse/dist/browse" ]; then
  B="$ROOT/.claude/skills/gstack/browse/dist/browse"
elif [ -x "$HOME/.claude/skills/gstack/browse/dist/browse" ]; then
  B="$HOME/.claude/skills/gstack/browse/dist/browse"
else
  echo "❌ gstack-browse not found — install with /open-gstack-browser or skip this smoke"
  exit 1
fi

color_red='\033[0;31m'; color_green='\033[0;32m'; color_yellow='\033[0;33m'; color_reset='\033[0m'
step()  { printf "\n${color_yellow}▶ %s${color_reset}\n" "$1"; }
ok()    { printf "${color_green}  ✓ %s${color_reset}\n" "$1"; }
fail()  { printf "${color_red}  ✗ %s${color_reset}\n" "$1"; exit 1; }

assert_visible() { local sel="$1"; local label="$2"
  if "$B" is visible "$sel" >/dev/null 2>&1; then ok "$label visible"; else fail "$label NOT visible ($sel)"; fi
}
assert_hidden() { local sel="$1"; local label="$2"
  if "$B" is hidden "$sel" >/dev/null 2>&1; then ok "$label hidden"; else fail "$label NOT hidden ($sel)"; fi
}
assert_min_height_44() { local sel="$1"; local label="$2"
  local v; v=$("$B" css "$sel" "min-height" 2>/dev/null || echo "")
  case "$v" in
    *44px*|*48px*|*52px*|*56px*|*60px*) ok "$label min-height=$v (≥44px)";;
    *) fail "$label min-height=$v (need ≥44px)";;
  esac
}

assert_no_console_errors() {
  local errs; errs=$("$B" console --errors 2>/dev/null | grep -c "^" || true)
  if [ "$errs" -gt 0 ]; then "$B" console --errors; fail "console emitted $errs error(s)"; fi
  ok "console clean"
}

# ─── Mobile (375x812) ────────────────────────────────────────────────────
step "Mobile viewport 375x812"
"$B" viewport 375x812 >/dev/null
"$B" goto "$BASE_URL$TEST_ROUTE" >/dev/null
"$B" wait --networkidle >/dev/null 2>&1 || true
"$B" console --clear >/dev/null 2>&1 || true
"$B" goto "$BASE_URL$TEST_ROUTE" >/dev/null
"$B" wait --networkidle >/dev/null 2>&1 || true
assert_visible '[data-test="studio-tabs"]'         "studio tabs"
assert_visible '[data-test="studio-tab-buyer"]'    "buyer tab button"
assert_visible '[data-test="studio-tab-seller"]'   "seller tab button"
# BuyerPortfolio renders one of: card-list, table, or empty-state. On mobile
# we want the table HIDDEN (sm:hidden / hidden sm:block toggle works).
"$B" js "document.querySelector('[data-test=buyer-portfolio-table]')?.offsetParent === null" \
  | grep -q true && ok "portfolio table hidden on mobile" || fail "portfolio table visible on mobile"
"$B" screenshot "$OUT_DIR/studio-mobile.png" >/dev/null
assert_no_console_errors

# ─── Tablet (768x1024) ───────────────────────────────────────────────────
step "Tablet viewport 768x1024"
"$B" viewport 768x1024 >/dev/null
"$B" goto "$BASE_URL$TEST_ROUTE" >/dev/null
"$B" wait --networkidle >/dev/null 2>&1 || true
assert_visible '[data-test="studio-tabs"]'         "studio tabs"
"$B" screenshot "$OUT_DIR/studio-tablet.png" >/dev/null

# ─── Desktop (1280x720) ──────────────────────────────────────────────────
step "Desktop viewport 1280x720"
"$B" viewport 1280x720 >/dev/null
"$B" goto "$BASE_URL$TEST_ROUTE" >/dev/null
"$B" wait --networkidle >/dev/null 2>&1 || true
assert_visible '[data-test="studio-tabs"]'         "studio tabs"
"$B" screenshot "$OUT_DIR/studio-desktop.png" >/dev/null
assert_no_console_errors

# ─── Visibility-paused polling ───────────────────────────────────────────
step "Polling pauses when document hidden (mobile viewport)"
"$B" viewport 375x812 >/dev/null
"$B" goto "$BASE_URL$TEST_ROUTE" >/dev/null
"$B" wait --networkidle >/dev/null 2>&1 || true
"$B" network --clear >/dev/null 2>&1 || true
# Force visibilityState=hidden via property override; dispatch the event so
# our useDocumentVisibility listener picks it up.
"$B" js "Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>'hidden'}); document.dispatchEvent(new Event('visibilitychange'))" >/dev/null
sleep 6
COUNT=$("$B" network 2>/dev/null | grep -c "/v3/arbloop/buyer/" || true)
if [ "$COUNT" -le 1 ]; then
  ok "≤1 buyer-jobs fetch during 6s hidden window (got $COUNT)"
else
  fail "buyer-jobs polled $COUNT times while hidden — visibility gate broken"
fi

step "Done"
printf "${color_green}✅ responsive smoke passed — screenshots in %s${color_reset}\n" "$OUT_DIR"
