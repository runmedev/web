#!/usr/bin/env bash
# test-smoke.sh - Smoke test that catches blank screen / startup crashes
#
# This test verifies the app boots without JavaScript errors and renders
# core UI elements. It was created after commit c4b4d48 where a missing
# method on AppState caused a runtime TypeError and a blank screen that
# was not caught by the build (vite build skips type checking).
#
# Prerequisites:
#   - Frontend running (e.g. `just frontend` or `pnpm -C web run dev:app`)
#   - agent-browser CLI installed and available on PATH
#
# Usage:
#   ./test-smoke.sh [port]     # default port: 5173
#
# Exit codes:
#   0 = app boots and renders correctly, no JS errors
#   1 = smoke test failed (blank screen, JS errors, or missing UI)

set -euo pipefail

PORT="${1:-5173}"
FRONTEND_URL="http://localhost:$PORT"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); echo -e "${GREEN}[PASS]${NC} $1"; }
fail() { FAIL=$((FAIL + 1)); echo -e "${RED}[FAIL]${NC} $1"; }
log()  { echo -e "${YELLOW}[SMOKE]${NC} $1"; }

# --- Pre-flight ---
if ! command -v agent-browser &>/dev/null; then
    echo "ERROR: agent-browser not on PATH"
    exit 2
fi

if ! curl -sf "$FRONTEND_URL" >/dev/null 2>&1; then
    echo "ERROR: Frontend not running at $FRONTEND_URL"
    exit 2
fi

# --- Open app ---
log "Opening $FRONTEND_URL"
agent-browser open "$FRONTEND_URL" >/dev/null 2>&1
agent-browser wait 4000 >/dev/null 2>&1

# --- Check for JS errors (catches TypeError, ReferenceError, etc.) ---
log "Checking for JavaScript errors..."
js_errors=$(agent-browser errors 2>/dev/null || true)

if [ -n "$js_errors" ]; then
    fail "JavaScript errors detected on startup:"
    echo "$js_errors"
else
    pass "No JavaScript errors on startup"
fi

# --- Check that core UI elements rendered (not a blank screen) ---
log "Checking core UI elements..."
snapshot=$(agent-browser snapshot -i 2>/dev/null || true)

# The Explorer panel toggle button should always be present
if echo "$snapshot" | grep -qi "Explorer"; then
    pass "Explorer panel rendered"
else
    fail "Explorer panel NOT found (possible blank screen)"
fi

# The App Console input should be present
if echo "$snapshot" | grep -qi "Terminal input\|console"; then
    pass "App Console rendered"
else
    fail "App Console NOT found (possible blank screen)"
fi

# At minimum, there should be interactive elements (buttons, inputs)
element_count=$(echo "$snapshot" | grep -c "ref=" || true)
if [ "$element_count" -ge 3 ]; then
    pass "Found $element_count interactive elements"
else
    fail "Only $element_count interactive elements (expected at least 3)"
fi

# --- Check console for uncaught errors ---
log "Checking browser console for errors..."
console_output=$(agent-browser console 2>/dev/null || true)
uncaught_errors=$(echo "$console_output" | grep -i "Uncaught\|TypeError\|ReferenceError\|is not a function\|is not defined\|Cannot read prop" || true)

if [ -n "$uncaught_errors" ]; then
    fail "Uncaught errors in console:"
    echo "$uncaught_errors"
else
    pass "No uncaught errors in browser console"
fi

# --- Cleanup ---
agent-browser close >/dev/null 2>&1 || true

echo ""
echo "============================================"
echo "  Smoke Test Results"
echo "============================================"
echo -e "  ${GREEN}Passed: $PASS${NC}"
echo -e "  ${RED}Failed: $FAIL${NC}"
echo "============================================"

if [ "$FAIL" -gt 0 ]; then
    echo -e "${RED}SMOKE TEST FAILED${NC}"
    exit 1
else
    echo -e "${GREEN}SMOKE TEST PASSED${NC}"
    exit 0
fi
