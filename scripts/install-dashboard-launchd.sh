#!/bin/bash
# Install (or reinstall) the dashboard as a launchd user agent so the web UI is
# always available at http://localhost:4788 (start at login, restart on crash).
# Requires the dashboard to be built first:  cd dashboard && npm run build
set -euo pipefail

LABEL="com.ryankrol.localjobs-dashboard"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST="$PLIST_DIR/$LABEL.plist"
LOG_DIR="$PROJECT_DIR/data"

if [ ! -d "$PROJECT_DIR/dashboard/.next" ]; then
  echo "Dashboard not built yet. Run:  cd dashboard && npm run build" >&2
  exit 1
fi

mkdir -p "$PLIST_DIR" "$LOG_DIR"
chmod +x "$PROJECT_DIR/scripts/start-daemon.sh"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$PROJECT_DIR/scripts/start-daemon.sh</string>
    <string>--prefix</string>
    <string>$PROJECT_DIR/dashboard</string>
    <string>run</string>
    <string>start</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>

  <key>WorkingDirectory</key>
  <string>$PROJECT_DIR/dashboard</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/dashboard.out.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/dashboard.err.log</string>
</dict>
</plist>
EOF

echo "Wrote $PLIST"
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "Loaded $LABEL — dashboard at http://localhost:4788"
