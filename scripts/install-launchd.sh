#!/bin/bash
# Install (or reinstall) the orchestrator as a launchd user agent so it starts
# at login and is automatically restarted if it ever crashes.
set -euo pipefail

LABEL="com.ryankrol.localjobs"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN_DIR="$(dirname "$(command -v node)")"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST="$PLIST_DIR/$LABEL.plist"
LOG_DIR="$PROJECT_DIR/data"

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
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_BIN_DIR</key>
    <string>$NODE_BIN_DIR</string>
    <key>PATH</key>
    <string>$NODE_BIN_DIR:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>

  <key>WorkingDirectory</key>
  <string>$PROJECT_DIR</string>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>$LOG_DIR/daemon.out.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/daemon.err.log</string>
</dict>
</plist>
EOF

echo "Wrote $PLIST"

# Reload cleanly.
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "Loaded $LABEL. Tail logs with: tail -f $LOG_DIR/daemon.out.log"
echo "Check status: launchctl list | grep $LABEL"
