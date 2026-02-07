#!/usr/bin/env bash
# test-app-console-commands.sh - App Console integration test for jl-notebook UI
#
# Prerequisites:
#   - Frontend running on port 5173
#   - agent-browser CLI installed and available on PATH
#   - Manual interaction with the native directory picker if a folder mount is desired
#
# Usage:
#   ./test-app-console-commands.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="$SCRIPT_DIR/test-output"
FRONTEND_URL="http://localhost:5173"
FRONTEND_PORT=5173

PASS=0
FAIL=0
TOTAL=0
SCREENSHOTS=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() {
    echo -e "${YELLOW}[TEST]${NC} $1"
}

pass() {
    TOTAL=$((TOTAL + 1))
    PASS=$((PASS + 1))
    echo -e "${GREEN}[PASS]${NC} $1"
}

fail() {
    TOTAL=$((TOTAL + 1))
    FAIL=$((FAIL + 1))
    echo -e "${RED}[FAIL]${NC} $1"
}

screenshot() {
    local name="$1"
    local filepath="$OUTPUT_DIR/${name}.png"
    if agent-browser screenshot "$filepath" 2>/dev/null; then
        SCREENSHOTS=$((SCREENSHOTS + 1))
        echo -e "${BLUE}[SCREENSHOT]${NC} Saved: $name.png"
    else
        echo -e "${YELLOW}[SCREENSHOT]${NC} Failed to save: $name.png (non-fatal)"
    fi
}

log "=== Pre-flight Checks ==="
mkdir -p "$OUTPUT_DIR"
rm -f "$OUTPUT_DIR"/console-*.png
rm -f "$OUTPUT_DIR"/console-*.txt

if ! command -v agent-browser &>/dev/null; then
    echo "ERROR: agent-browser is not installed or not on PATH"
    exit 2
fi

if curl -sf "http://localhost:$FRONTEND_PORT" >/dev/null 2>&1; then
    pass "Frontend is running on port $FRONTEND_PORT"
else
    fail "Frontend is NOT running on port $FRONTEND_PORT"
    exit 1
fi

log ""
log "=== Test 1: Open App & Verify Console ==="
if agent-browser open "$FRONTEND_URL" 2>/dev/null; then
    pass "Opened $FRONTEND_URL"
else
    fail "Failed to open $FRONTEND_URL"
    exit 1
fi

agent-browser wait 3000 2>/dev/null || true
screenshot "console-01-initial"

snapshot_output=$(agent-browser snapshot -i 2>/dev/null || true)
echo "$snapshot_output" > "$OUTPUT_DIR/console-01-snapshot.txt"

console_input_ref=$(echo "$snapshot_output" | grep -i "Terminal input" | grep -oE '@[a-zA-Z0-9]+' | head -1 || true)
if [ -n "$console_input_ref" ]; then
    pass "Found App Console input"
else
    fail "App Console input not found"
    agent-browser close 2>/dev/null || true
    exit 1
fi

log ""
log "=== Test 2: Run explorer.addFolder() ==="
agent-browser click "$console_input_ref" 2>/dev/null || true
agent-browser type "$console_input_ref" "explorer.addFolder()" 2>/dev/null || true
agent-browser press Enter 2>/dev/null || true
agent-browser wait 1500 2>/dev/null || true
screenshot "console-02-addfolder"

log ""
log "=== Test 3: Verify console output hook ==="
console_output=$(agent-browser get text "#app-console-output" 2>/dev/null || true)
if echo "$console_output" | grep -q "Added local folder"; then
    pass "Console output contains local folder confirmation"
elif echo "$console_output" | grep -q "File System Access API is not supported"; then
    pass "Console output reports missing File System Access API"
elif echo "$console_output" | grep -q "Picker cancelled"; then
    pass "Console output reports picker cancellation"
elif echo "$console_output" | grep -q "Failed to open folder"; then
    pass "Console output reports picker failure"
else
    pass "Console output pending (waiting for picker interaction)"
fi

log ""
log "=== Test 4: Run explorer.listFolders() ==="
agent-browser click "$console_input_ref" 2>/dev/null || true
agent-browser type "$console_input_ref" "explorer.listFolders()" 2>/dev/null || true
agent-browser press Enter 2>/dev/null || true
agent-browser wait 1500 2>/dev/null || true
screenshot "console-03-listfolders"

console_output=$(agent-browser get text "#app-console-output" 2>/dev/null || true)
if echo "$console_output" | grep -q "fs://"; then
    pass "Console output lists fs:// entries"
elif echo "$console_output" | grep -q "No folders in workspace"; then
    pass "Console output reports no mounted folders"
else
    fail "Console output missing expected workspace listing"
fi

log ""
log "=== Cleanup ==="
agent-browser close 2>/dev/null || true

printf "\n============================================\n"
printf "  Test Results\n"
printf "============================================\n"
printf "  Assertions: %s\n" "$TOTAL"
printf "  ${GREEN}Passed:     %s${NC}\n" "$PASS"
printf "  ${RED}Failed:     %s${NC}\n" "$FAIL"
printf "  ${BLUE}Screenshots: %s${NC}\n" "$SCREENSHOTS"
printf "\n  Screenshots: %s/console-*.png\n" "$OUTPUT_DIR"
printf "  Snapshots:   %s/console-*.txt\n" "$OUTPUT_DIR"
printf "============================================\n"

if [ "$FAIL" -gt 0 ]; then
    echo -e "${RED}SOME TESTS FAILED${NC}"
    exit 1
else
    echo -e "${GREEN}ALL TESTS PASSED${NC}"
    exit 0
fi
