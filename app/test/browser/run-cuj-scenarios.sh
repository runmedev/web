#!/usr/bin/env bash
# run-cuj-scenarios.sh - Runs all implemented Critical User Journey scenarios.
#
# The CUJ definitions live in docs/cujs/*.md and this script maps each scenario
# to the corresponding executable browser test script.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Keep this list aligned with docs/cujs/*.md.
SCENARIO_DRIVERS=(
  "$SCRIPT_DIR/test-scenario-hello-world.ts"
)

for scenario_driver in "${SCENARIO_DRIVERS[@]}"; do
  echo "[CUJ] Running $(basename "$scenario_driver")"
  pnpm exec tsc --target es2020 --module nodenext --moduleResolution nodenext --esModuleInterop --skipLibCheck --outDir "$SCRIPT_DIR/.generated" "$scenario_driver"
  node "$SCRIPT_DIR/.generated/$(basename "${scenario_driver%.ts}").js"
  echo "[CUJ] Completed $(basename "$scenario_driver")"
  echo
done
