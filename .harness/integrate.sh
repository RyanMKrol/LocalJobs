#!/usr/bin/env bash
#
# integrate.sh — refresh the running product so the live site matches `main` after a task
# integrates. loop.sh runs this via INTEGRATE_HOOK (set in harness.env) on each CI-green task,
# from the repo root. The daemon loads job code at startup and the dashboard serves a prebuilt
# bundle, so without this a task's changes don't show up live until a manual restart.
set -uo pipefail
uid="$(id -u)"

# Dashboard serves a prebuilt bundle → rebuild before restarting it.
if ! npm --prefix dashboard run build >/dev/null 2>&1; then
  echo "[integrate] dashboard build failed — leaving services as-is" >&2
  exit 0   # non-fatal: never let a hook failure stop the loop
fi
launchctl kickstart -k "gui/$uid/com.ryankrol.localjobs" >/dev/null 2>&1 || true
launchctl kickstart -k "gui/$uid/com.ryankrol.localjobs-dashboard" >/dev/null 2>&1 || true
echo "[integrate] rebuilt dashboard + restarted daemon & dashboard"
