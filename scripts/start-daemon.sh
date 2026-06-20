#!/bin/bash
# Wrapper launchd uses to start the orchestrator. Keeps all path logic in one
# place so the plist stays simple. The install script injects NODE_BIN_DIR.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

# Ensure the nvm-managed node/npm are on PATH (launchd has a minimal PATH).
if [ -n "${NODE_BIN_DIR:-}" ]; then
  export PATH="$NODE_BIN_DIR:$PATH"
fi

exec npm run daemon
