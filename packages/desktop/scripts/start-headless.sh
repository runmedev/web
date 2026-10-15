#!/usr/bin/env bash
# Use Electron's bundled Node to supervise Xvfb and forward shutdown to the app.
set -euo pipefail
app_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
export ELECTRON_RUN_AS_NODE=1
exec "$app_dir/runme-desktop" "$app_dir/start-headless.cjs" "$@"
