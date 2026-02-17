#!/usr/bin/env bash
# test-notebook-ui.sh - Agent-browser integration test for jl-notebook UI
#
# Prerequisites:
#   - Backend running on port 9977:
#     cd runme && go run ./ agent --config=${HOME}/.runme-agent/config.dev.yaml serve
#   - Frontend running on port 5173 (pnpm -C app run dev)
#   - agent-browser CLI installed and available on PATH
#
# Usage:
#   ./test-notebook-ui.sh
#
# The script uses agent-browser to automate UI interactions and takes
# screenshots at each step. Results are saved to test-output/.
#
# TODO(testing): Convert this shell script into a TypeScript scenario driver
# under app/test/browser and execute it via run-cuj-scenarios.ts so it follows
# repo scripting guidance. While converting, align its assertions with CUJ docs
# in docs-dev/cujs to avoid overlap/divergence with test-scenario-hello-world.ts.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="$SCRIPT_DIR/test-output"
FRONTEND_URL="http://localhost:5173"
BACKEND_PORT=9977
FRONTEND_PORT=5173

# Counters
PASS=0
FAIL=0
TOTAL=0
SCREENSHOTS=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

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

# screenshot is diagnostic only - does not affect pass/fail counts
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

# ============================================================
# Pre-flight checks
# ============================================================

log "=== Pre-flight Checks ==="

# Create/clean output directory
mkdir -p "$OUTPUT_DIR"
rm -f "$OUTPUT_DIR"/*.png
rm -f "$OUTPUT_DIR"/*.txt

# Check agent-browser is installed
if ! command -v agent-browser &>/dev/null; then
    echo "ERROR: agent-browser is not installed or not on PATH"
    exit 2
fi

# Check backend is running
if curl -sf "http://localhost:$BACKEND_PORT" >/dev/null 2>&1 || \
   curl -sf "http://localhost:$BACKEND_PORT/health" >/dev/null 2>&1 || \
   nc -z localhost "$BACKEND_PORT" 2>/dev/null; then
    pass "Backend is running on port $BACKEND_PORT"
else
    fail "Backend is NOT running on port $BACKEND_PORT"
    echo "Start it with: cd runme && go run ./ agent --config=\${HOME}/.runme-agent/config.dev.yaml serve"
    exit 1
fi

# Check frontend is running
if curl -sf "http://localhost:$FRONTEND_PORT" >/dev/null 2>&1; then
    pass "Frontend is running on port $FRONTEND_PORT"
else
    fail "Frontend is NOT running on port $FRONTEND_PORT"
    echo "Start it with: cd web && pnpm run dev:app"
    exit 1
fi

# Check backend auth mode (informational)
auth_response=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "http://localhost:$BACKEND_PORT/runme.contents.v1.ContentsService/List" \
    -H "Content-Type: application/json" \
    -d '{"path":""}' 2>/dev/null || echo "000")
if [ "$auth_response" = "401" ]; then
    log "Backend auth is enabled (401). Use authenticated CUJ flow for execution checks."
elif [ "$auth_response" = "200" ]; then
    pass "Backend accepted unauthenticated request"
else
    log "Backend returned HTTP $auth_response (may still work - ContentsService might not be enabled)"
fi

# ============================================================
# Test 1: Open the app and verify initial UI
# ============================================================

log ""
log "=== Test 1: Open App & Verify Initial UI ==="

if agent-browser open "$FRONTEND_URL" 2>/dev/null; then
    pass "Opened $FRONTEND_URL"
else
    fail "Failed to open $FRONTEND_URL"
    exit 1
fi

# Wait for app to render
agent-browser wait 3000 2>/dev/null || true
screenshot "01-initial-load"

# ============================================================
# Test 2: Verify Explorer renders (no picker button)
# ============================================================

log ""
log "=== Test 2: Verify Explorer ==="

snapshot_output=$(agent-browser snapshot -i 2>/dev/null || true)
echo "$snapshot_output" > "$OUTPUT_DIR/02-snapshot.txt"

# Check that the Explorer panel is visible (look for tree/explorer elements)
if echo "$snapshot_output" | grep -qi -e "explorer" -e "notebooks" -e "folder" -e "workspace"; then
    pass "Explorer panel is visible"
else
    fail "Explorer panel not found in snapshot"
fi

# Verify no directory picker button (showDirectoryPicker is for FilesystemStore)
if echo "$snapshot_output" | grep -qi "pick.*folder\|choose.*directory\|open.*folder\|showDirectoryPicker"; then
    fail "Directory picker button found (should not be present in ContentsService mode)"
else
    pass "No directory picker button (correct for ContentsService mode)"
fi

screenshot "02-explorer-view"

# ============================================================
# Test 3: Console area detection
# ============================================================

log ""
log "=== Test 3: Console Area ==="

# Known limitation: The App Console uses xterm.js which renders to a <canvas>
# element. agent-browser's DOM snapshot cannot read canvas content, so we
# cannot type commands or verify console output programmatically. We can only
# verify the console container element exists in the DOM.
# For full console testing, use manual interaction or screenshot-based
# visual verification.

if echo "$snapshot_output" | grep -qi "console\|terminal\|xterm"; then
    pass "Console container element detected in DOM"
else
    log "Console container not found in snapshot (may be collapsed or in a tab)"
fi

log "NOTE: xterm.js renders to <canvas> - cannot interact with console via DOM automation"

screenshot "03-console-area"

# ============================================================
# Test 4: Verify notebook files in explorer
# ============================================================

log ""
log "=== Test 4: Verify Notebook Files in Explorer ==="

# Take a fresh snapshot
snapshot_output=$(agent-browser snapshot -i 2>/dev/null || true)
echo "$snapshot_output" > "$OUTPUT_DIR/04-snapshot.txt"

# Check for test notebook files (they may appear as tree items)
found_notebooks=0
for notebook in "basic-test" "cell-types-test" "ui-test" "large-payload-test" "hello-world" "cell-types"; do
    if echo "$snapshot_output" | grep -qi "$notebook"; then
        pass "Found notebook: $notebook"
        found_notebooks=$((found_notebooks + 1))
    else
        log "Notebook $notebook not visible yet (may need folder expansion)"
    fi
done

screenshot "04-notebook-files"

# ============================================================
# Test 5: Try to expand folders and find notebooks
# ============================================================

log ""
log "=== Test 5: Expand Folders ==="

# Look for expandable tree items (typically have arrow/chevron refs)
expand_refs=$(echo "$snapshot_output" | grep -i -E "expand|chevron|arrow|toggle|treeitem|folder" || true)
echo "$expand_refs" > "$OUTPUT_DIR/05-expand-refs.txt"

if [ -n "$expand_refs" ]; then
    # Try clicking the first expandable item
    first_ref=$(echo "$expand_refs" | head -1 | grep -oE '@[a-zA-Z0-9]+' | head -1 || true)
    if [ -n "$first_ref" ]; then
        log "Clicking expand ref: $first_ref"
        agent-browser click "$first_ref" 2>/dev/null || true
        agent-browser wait 1000 2>/dev/null || true
        pass "Clicked folder expander"
    fi
fi

screenshot "05-expanded-folders"

# Re-snapshot after expansion
snapshot_output=$(agent-browser snapshot -i 2>/dev/null || true)
echo "$snapshot_output" > "$OUTPUT_DIR/05-expanded-snapshot.txt"

# ============================================================
# Test 6: Open a notebook
# ============================================================

log ""
log "=== Test 6: Open a Notebook ==="

# Prefer hello-world.json since its content ("Hello World Notebook", "Hello from
# the test notebook") gives us specific strings to assert on in Test 7.
notebook_ref=""
for pattern in "hello-world" "basic-test" "\.json" "\.md"; do
    notebook_ref=$(echo "$snapshot_output" | grep -i "$pattern" | grep -oE '@[a-zA-Z0-9]+' | head -1 || true)
    if [ -n "$notebook_ref" ]; then
        break
    fi
done

if [ -n "$notebook_ref" ]; then
    log "Clicking notebook ref: $notebook_ref"
    agent-browser click "$notebook_ref" 2>/dev/null || true
    agent-browser wait 2000 2>/dev/null || true
    pass "Clicked notebook to open"
else
    fail "No notebook ref found to click"
fi

screenshot "06-notebook-opened"

# ============================================================
# Test 7: Verify notebook renders with specific content
# ============================================================

log ""
log "=== Test 7: Verify Notebook Rendering ==="

snapshot_output=$(agent-browser snapshot -i 2>/dev/null || true)
echo "$snapshot_output" > "$OUTPUT_DIR/07-snapshot.txt"

# Assert on specific known notebook content strings rather than generic
# UI terms like "cell" or "code" which could match toolbar/chrome elements.
# These strings come from the fixture notebooks themselves:
#   hello-world.json: "Hello World Notebook", "Hello from the test notebook"
#   basic-test.runme.md: "RUNME_TEST_OK", "Basic Test Notebook"
#   cell-types.json: "Cell Types Test"
rendered=false
for content_string in \
    "Hello World Notebook" \
    "Hello from the test notebook" \
    "RUNME_TEST_OK" \
    "Basic Test Notebook" \
    "Cell Types Test" \
    "Echo Test" \
    "Second Section"; do
    if echo "$snapshot_output" | grep -q "$content_string"; then
        pass "Notebook content rendered: '$content_string'"
        rendered=true
        break
    fi
done

if [ "$rendered" = false ]; then
    fail "No known notebook content found in rendered output"
    log "Expected one of: 'Hello World Notebook', 'RUNME_TEST_OK', 'Basic Test Notebook', etc."
fi

screenshot "07-notebook-rendered"

# ============================================================
# Cleanup and Summary
# ============================================================

log ""
log "=== Cleanup ==="
agent-browser close 2>/dev/null || true
log "Browser closed"

echo ""
echo "============================================"
echo "  Test Results"
echo "============================================"
echo -e "  Assertions: $TOTAL"
echo -e "  ${GREEN}Passed:     $PASS${NC}"
echo -e "  ${RED}Failed:     $FAIL${NC}"
echo -e "  ${BLUE}Screenshots: $SCREENSHOTS${NC}"
echo ""
echo "  Screenshots: $OUTPUT_DIR/*.png"
echo "  Snapshots:   $OUTPUT_DIR/*.txt"
echo "============================================"

if [ "$FAIL" -gt 0 ]; then
    echo -e "${RED}SOME TESTS FAILED${NC}"
    exit 1
else
    echo -e "${GREEN}ALL TESTS PASSED${NC}"
    exit 0
fi
