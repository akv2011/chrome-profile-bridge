#!/bin/bash
# Install or update chrome-profile-bridge on this Mac. Safe to run again.
#
#   ~/.chrome-profile-bridge/app        the daemon (launchd job local.chrome-profile-bridge)
#   ~/.chrome-profile-bridge/extension  the unpacked extension each Chrome profile loads once
#   ~/.chrome-profile-bridge/profiles.json   profile name -> Chrome profile directory
#   ~/.local/bin/cbb-mcp                the MCP launcher
set -euo pipefail
[ "$(uname -s)" = Darwin ] || { echo "install: macOS only (Chrome and launchd)" >&2; exit 2; }
command -v jq >/dev/null || { echo "install: needs jq" >&2; exit 2; }

SRC=$(cd "$(dirname "$0")/.." && pwd)
HOME_DIR="$HOME/.chrome-profile-bridge"
LABEL=local.chrome-profile-bridge
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE=/opt/homebrew/bin/node   # the Homebrew symlink, never a Cellar path (it changes on upgrade)

mkdir -p -m 700 "$HOME_DIR/app" "$HOME_DIR/extension" "$HOME/.local/bin"
rsync -a --delete --exclude '*.test.ts' --exclude testing "$SRC/src/" "$HOME_DIR/app/src/"
cp "$SRC/package.json" "$HOME_DIR/app/"
(cd "$HOME_DIR/app" && npm install --omit=dev --no-audit --no-fund --loglevel=error)
rsync -a --delete --exclude '*.test.ts' "$SRC/extension/" "$HOME_DIR/extension/"
[ -f "$HOME_DIR/profiles.json" ] || cp "$SRC/profiles.json.example" "$HOME_DIR/profiles.json"
install -m 755 "$SRC/bin/cbb-mcp" "$HOME/.local/bin/cbb-mcp"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$HOME_DIR/app/src/daemon.ts</string></array>
  <key>EnvironmentVariables</key><dict><key>CBB_HOME</key><string>$HOME_DIR</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>$HOME_DIR/daemon.log</string>
  <key>StandardOutPath</key><string>$HOME_DIR/daemon.log</string>
</dict></plist>
EOF
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
for _ in $(seq 1 20); do curl -sf http://127.0.0.1:18765/status >/dev/null && break; sleep 0.25; done
curl -sf http://127.0.0.1:18765/status >/dev/null \
  && echo "install: daemon up on 127.0.0.1:18765; load the extension from $HOME_DIR/extension in each profile (chrome://extensions, Developer mode, Load unpacked)" \
  || { echo "install: daemon did not start; see $HOME_DIR/daemon.log" >&2; exit 1; }
