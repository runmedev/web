#!/usr/bin/env bash
# run-cuj-scenarios.sh - Runs all implemented Critical User Journey scenarios.
#
# The CUJ definitions live in docs/cujs/*.md and this script maps each scenario
# to the corresponding executable browser test script.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Keep this list aligned with docs/cujs/*.md.
SCENARIO_SCRIPTS=(
  "$SCRIPT_DIR/test-scenario-hello-world.sh"
)

for scenario_script in "${SCENARIO_SCRIPTS[@]}"; do
  echo "[CUJ] Running $(basename "$scenario_script")"
  "$scenario_script"
  echo "[CUJ] Completed $(basename "$scenario_script")"
  echo
done
