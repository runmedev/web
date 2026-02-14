#!/usr/bin/env bash
# test-scenario-hello-world.sh - Executes the hello-world UX scenario.
#
# This script follows docs/cujs/hello-world-local-notebook.md and keeps
# assertions machine-verifiable by using agent-browser snapshots, text reads,
# and JS evaluation against live DOM/app state.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="$SCRIPT_DIR/test-output"
FRONTEND_URL="http://localhost:5173"
BACKEND_URL="http://localhost:9977"
SCENARIO_NOTEBOOK_NAME="scenario-hello-world.runme.md"

PASS=0
FAIL=0
TOTAL=0

pass() { TOTAL=$((TOTAL + 1)); PASS=$((PASS + 1)); echo "[PASS] $1"; }
fail() { TOTAL=$((TOTAL + 1)); FAIL=$((FAIL + 1)); echo "[FAIL] $1"; }

mkdir -p "$OUTPUT_DIR"
rm -f "$OUTPUT_DIR"/scenario-hello-world-*.txt "$OUTPUT_DIR"/scenario-hello-world-*.png

if ! command -v agent-browser >/dev/null 2>&1; then
  echo "ERROR: agent-browser is required on PATH"
  exit 2
fi

if ! curl -sf "$FRONTEND_URL" >/dev/null 2>&1; then
  echo "ERROR: frontend is not running at $FRONTEND_URL"
  exit 1
fi

if ! curl -sf "$BACKEND_URL" >/dev/null 2>&1 && ! nc -z localhost 9977 2>/dev/null; then
  echo "ERROR: backend is not running at $BACKEND_URL"
  exit 1
fi

agent-browser open "$FRONTEND_URL" >/dev/null 2>&1
agent-browser wait 3500 >/dev/null 2>&1 || true
agent-browser screenshot "$OUTPUT_DIR/scenario-hello-world-01-initial.png" >/dev/null 2>&1 || true

# Seed a local notebook so the scenario stays deterministic and does not rely on
# manual file picker interactions.
seed_result=$(agent-browser eval "(async () => {
  const ln = window.app?.localNotebooks;
  if (!ln) return 'missing-local-notebooks';
  const notebook = {
    metadata: {},
    cells: [
      {
        refId: 'cell_hello_world',
        kind: 2,
        languageId: 'bash',
        value: 'echo "hello world"',
        metadata: { runner: 'local' },
        outputs: []
      }
    ]
  };
  await ln.files.put({
    id: 'local://file/${SCENARIO_NOTEBOOK_NAME}',
    uri: 'local://file/${SCENARIO_NOTEBOOK_NAME}',
    name: '${SCENARIO_NOTEBOOK_NAME}',
    doc: JSON.stringify(notebook),
    updatedAt: new Date().toISOString(),
    parent: 'local://folder/local',
    lastSynced: '',
    remoteId: '',
    lastRemoteChecksum: ''
  });
  return 'ok';
})()" 2>/dev/null || true)

if echo "$seed_result" | grep -q "ok"; then
  pass "Created local notebook fixture"
else
  fail "Failed to create local notebook fixture"
fi

snapshot=$(agent-browser snapshot -i 2>/dev/null || true)
echo "$snapshot" > "$OUTPUT_DIR/scenario-hello-world-02-after-seed.txt"

# Configure a local runner through AppConsole commands.
console_ref=$(echo "$snapshot" | grep -i "Terminal input" | grep -oE '@[a-zA-Z0-9]+' | head -1 || true)
if [ -z "$console_ref" ]; then
  fail "Did not find AppConsole terminal input"
  agent-browser close >/dev/null 2>&1 || true
  exit 1
fi

agent-browser click "$console_ref" >/dev/null 2>&1 || true
agent-browser type "$console_ref" "aisreRunners.update('local','http://localhost:9977')" >/dev/null 2>&1 || true
agent-browser press Enter >/dev/null 2>&1 || true
agent-browser wait 500 >/dev/null 2>&1 || true
agent-browser type "$console_ref" "aisreRunners.setDefault('local')" >/dev/null 2>&1 || true
agent-browser press Enter >/dev/null 2>&1 || true
agent-browser wait 500 >/dev/null 2>&1 || true
agent-browser type "$console_ref" "aisreRunners.getDefault()" >/dev/null 2>&1 || true
agent-browser press Enter >/dev/null 2>&1 || true
agent-browser wait 1000 >/dev/null 2>&1 || true

console_output=$(agent-browser get text "#app-console-output" 2>/dev/null || true)
echo "$console_output" > "$OUTPUT_DIR/scenario-hello-world-03-console-output.txt"
if echo "$console_output" | grep -q "Default runner: local"; then
  pass "Configured local runner and set default"
else
  fail "Default runner output did not report local"
fi

# Expand explorer, then open the seeded notebook file.
snapshot=$(agent-browser snapshot -i 2>/dev/null || true)
echo "$snapshot" > "$OUTPUT_DIR/scenario-hello-world-04-before-open.txt"
notebook_ref=$(echo "$snapshot" | grep -F "$SCENARIO_NOTEBOOK_NAME" | grep -oE '@[a-zA-Z0-9]+' | head -1 || true)
if [ -z "$notebook_ref" ]; then
  # Tree nodes can be collapsed, so try opening local notebooks first.
  local_ref=$(echo "$snapshot" | grep -i "Local Notebooks" | grep -oE '@[a-zA-Z0-9]+' | head -1 || true)
  if [ -n "$local_ref" ]; then
    agent-browser click "$local_ref" >/dev/null 2>&1 || true
    agent-browser wait 700 >/dev/null 2>&1 || true
    snapshot=$(agent-browser snapshot -i 2>/dev/null || true)
    echo "$snapshot" > "$OUTPUT_DIR/scenario-hello-world-04b-after-expand.txt"
    notebook_ref=$(echo "$snapshot" | grep -F "$SCENARIO_NOTEBOOK_NAME" | grep -oE '@[a-zA-Z0-9]+' | head -1 || true)
  fi
fi

if [ -n "$notebook_ref" ]; then
  agent-browser click "$notebook_ref" >/dev/null 2>&1 || true
  agent-browser wait 1500 >/dev/null 2>&1 || true
  pass "Opened scenario notebook"
else
  fail "Could not find scenario notebook in explorer"
fi

# Run first notebook cell by clicking the first Run button.
snapshot=$(agent-browser snapshot -i 2>/dev/null || true)
echo "$snapshot" > "$OUTPUT_DIR/scenario-hello-world-05-opened-notebook.txt"
run_ref=$(echo "$snapshot" | grep -i "Run cell" | grep -oE '@[a-zA-Z0-9]+' | head -1 || true)
if [ -z "$run_ref" ]; then
  run_ref=$(echo "$snapshot" | grep -i "Run" | grep -oE '@[a-zA-Z0-9]+' | head -1 || true)
fi

if [ -n "$run_ref" ]; then
  agent-browser click "$run_ref" >/dev/null 2>&1 || true
  agent-browser wait 3500 >/dev/null 2>&1 || true
  pass "Triggered cell execution"
else
  fail "Could not find a Run control for the first cell"
fi

agent-browser screenshot "$OUTPUT_DIR/scenario-hello-world-06-after-run.png" >/dev/null 2>&1 || true
snapshot=$(agent-browser snapshot -i 2>/dev/null || true)
echo "$snapshot" > "$OUTPUT_DIR/scenario-hello-world-06-after-run.txt"

if echo "$snapshot" | grep -iq "hello world"; then
  pass "Observed hello world output in UI snapshot"
else
  fail "Did not observe hello world in UI snapshot"
fi

agent-browser close >/dev/null 2>&1 || true

echo "Assertions: $TOTAL, Passed: $PASS, Failed: $FAIL"
[ "$FAIL" -eq 0 ]
