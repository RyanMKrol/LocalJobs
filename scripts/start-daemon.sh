#!/bin/bash
# Generic wrapper launchd uses to start a Node-based agent (the orchestrator
# daemon, or — via extra args — the dashboard). All path logic lives here so
# the generated plists stay simple and NEVER bake in a frozen nvm node path:
# node/npm are resolved fresh on every launch, so an `nvm install`/`nvm
# uninstall` takes effect immediately, without re-running an install script.
#
# Usage:
#   start-daemon.sh              # -> npm run daemon            (the orchestrator)
#   start-daemon.sh ARGS...      # -> npm ARGS...                (e.g. the dashboard)
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

# Resolve a directory containing a usable `node` binary, freshly, every time
# this script runs (launchd starts it with a minimal PATH).
resolve_node_bin_dir() {
  # 1) An explicit override always wins (e.g. set manually for debugging).
  if [ -n "${NODE_BIN_DIR:-}" ] && [ -x "${NODE_BIN_DIR}/node" ]; then
    echo "$NODE_BIN_DIR"
    return 0
  fi

  # 2) nvm — use the version pinned in .nvmrc (nvm falls back to its own
  #    default alias if .nvmrc is missing/unreadable). Resolved live on every
  #    launch, so installing a new Node major or removing an old one takes
  #    effect on the next daemon (re)start with no reinstall needed.
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1091
    \. "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
    if command -v nvm >/dev/null 2>&1; then
      (nvm use >/dev/null 2>&1 || nvm use default >/dev/null 2>&1) || true
      if command -v node >/dev/null 2>&1; then
        dirname "$(command -v node)"
        return 0
      fi
    fi
  fi

  # 3) Common non-nvm install locations.
  for candidate in /opt/homebrew/bin /usr/local/bin; do
    if [ -x "$candidate/node" ]; then
      echo "$candidate"
      return 0
    fi
  done

  # 4) Whatever node is already on PATH.
  if command -v node >/dev/null 2>&1; then
    dirname "$(command -v node)"
    return 0
  fi

  return 1
}

if resolved_bin_dir="$(resolve_node_bin_dir)"; then
  export PATH="$resolved_bin_dir:$PATH"
fi

if [ "$#" -eq 0 ]; then
  exec npm run daemon
else
  exec npm "$@"
fi
