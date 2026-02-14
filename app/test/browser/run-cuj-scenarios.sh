#!/usr/bin/env bash
# run-cuj-scenarios.sh - Compatibility wrapper for the TypeScript CUJ orchestrator.
#
# The canonical orchestrator now lives in run-cuj-scenarios.ts so CUJ automation
# logic stays in TypeScript. This wrapper exists for convenience and backwards
# compatibility with existing docs/CI references.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

pnpm exec tsc \
  --target es2020 \
  --module nodenext \
  --moduleResolution nodenext \
  --esModuleInterop \
  --skipLibCheck \
  --outDir "$SCRIPT_DIR/.generated" \
  "$SCRIPT_DIR/run-cuj-scenarios.ts"

node "$SCRIPT_DIR/.generated/run-cuj-scenarios.js"
