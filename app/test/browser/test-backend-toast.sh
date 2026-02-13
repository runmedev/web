#!/usr/bin/env bash
# test-backend-toast.sh - Verify toast is shown when backend runner is down
#
# Prerequisites:
#   - Frontend running on port 5173 (pnpm -C web run dev:app)
#   - Backend NOT running on port 9977
#   - agent-browser CLI installed and available on PATH
#
# Usage:
#   ./test-backend-toast.sh [port]     # default port: 5173

set -euo pipefail

PORT="${1:-5173}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

node "$SCRIPT_DIR/test-backend-toast.js" "$PORT"
