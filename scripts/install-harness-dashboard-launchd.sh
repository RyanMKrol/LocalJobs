#!/bin/bash
# Install (or reinstall) the HARNESS backlog dashboard as a launchd user agent, so the
# build-harness backlog UI is always available (start at login, restart on crash).
#
# This runs the plugin-owned, self-contained .harness/dashboard/server.js UNMODIFIED — it is
# project deployment glue (a launchd plist), NOT a fork of the harness. The port is read from
# .harness/config/harness.env (HARNESS_DASHBOARD_PORT) so that file stays the single source of
# truth; server.js itself reads the port from the environment, which this plist provides.
set -euo pipefail

LABEL="com.ryankrol.localjobs-harness-dashboard"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER="$PROJECT_DIR/.harness/dashboard/server.js"
NODE_BIN_DIR="$(dirname "$(command -v node)")"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST="$PLIST_DIR/$LABEL.plist"
LOG_DIR="$PROJECT_DIR/data"

[ -f "$SERVER" ] || { echo "Missing $SERVER — is .harness/dashboard installed?" >&2; exit 1; }

# Single source of truth for the port: the harness.env `${HARNESS_DASHBOARD_PORT:=NNNN}` line.
PORT="$(sed -n 's/.*HARNESS_DASHBOARD_PORT:=\([0-9][0-9]*\).*/\1/p' "$PROJECT_DIR/.harness/config/harness.env" | head -1)"
PORT="${PORT:-4791}"

mkdir -p "$PLIST_DIR" "$LOG_DIR"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN_DIR/node</string>
    <string>$SERVER</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$NODE_BIN_DIR:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HARNESS_DASHBOARD_PORT</key>
    <string>$PORT</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>$PROJECT_DIR</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/harness-dashboard.out.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/harness-dashboard.err.log</string>
</dict>
</plist>
EOF

echo "Wrote $PLIST"
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "Loaded $LABEL — harness backlog dashboard at http://127.0.0.1:$PORT"
