#!/bin/bash
# Install or update chrome-profile-bridge on this Mac. Safe to run again: it updates in place.
#
#   ~/.chrome-profile-bridge/app        the daemon (launchd job local.chrome-profile-bridge), and in
#                                       full-CDP mode the Chrome holder (local.chrome-profile-bridge.chrome)
#   ~/.chrome-profile-bridge/extension  the unpacked extension (extension mode only)
#   ~/.chrome-profile-bridge/profiles.json   profile name -> Chrome profile dir
#   ~/.local/bin/cbb-mcp                the MCP launcher
#
# Two modes, picked from disk:
#   full-CDP  ~/ChromeData is Chrome's data dir (bin/full-cdp.sh moved it there). A tiny holder owns
#             Chrome over the trusted debugging pipe; the daemon drives every profile with no extension.
#   extension otherwise: each profile loads the unpacked extension once.
# Updates need no clicks: the post-commit hook runs bin/ship.sh, and the daemon restarts itself on
# the new code once idle. The holder is never restarted for an update, so your browser stays open.
set -euo pipefail
[ "$(uname -s)" = Darwin ] || { echo "install: macOS only (Chrome and launchd)" >&2; exit 2; }

SRC=$(cd "$(dirname "$0")/.." && pwd)
HOME_DIR="$HOME/.chrome-profile-bridge"
LABEL=local.chrome-profile-bridge
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE=/opt/homebrew/bin/node   # the Homebrew symlink, never a Cellar path (it changes on upgrade)

rm -f "$HOME_DIR/app/package-lock.json"   # makes ship.sh run npm ci once on install
"$SRC/bin/ship.sh"
# Every later commit ships itself to the running install.
printf '#!/bin/sh\nexec "$(git rev-parse --show-toplevel)/bin/ship.sh"\n' > "$(git -C "$SRC" rev-parse --git-common-dir)/hooks/post-commit"
chmod 755 "$(git -C "$SRC" rev-parse --git-common-dir)/hooks/post-commit"

mkdir -p -m 700 "$HOME_DIR" "$HOME/.local/bin"
[ -f "$HOME_DIR/profiles.json" ] || cp "$SRC/profiles.json.example" "$HOME_DIR/profiles.json"
install -m 755 "$SRC/bin/cbb-mcp" "$HOME/.local/bin/cbb-mcp"
# Clients started before the switch keep running `playwright-mcp --extension --profile-dir-name X`,
# which hangs waiting on Microsoft's extension. With a global @playwright/mcp, the shim takes its bin
# path and routes that call here; anything else passes through. `npm i -g @playwright/mcp` undoes it.
NPM_PREFIX=$(npm prefix -g 2>/dev/null || true)
if [ -n "$NPM_PREFIX" ] && [ -f "$NPM_PREFIX/lib/node_modules/@playwright/mcp/cli.js" ]; then
  rm -f "$NPM_PREFIX/bin/playwright-mcp" && install -m 755 "$SRC/bin/playwright-mcp-shim" "$NPM_PREFIX/bin/playwright-mcp"
fi

CHROME_DATA="$HOME/ChromeData"
CHROME_DEFAULT="$HOME/Library/Application Support/Google/Chrome"
FULL=0
[ -d "$CHROME_DATA" ] && [ ! -L "$CHROME_DATA" ] && [ -L "$CHROME_DEFAULT" ] && FULL=1

plist() { # label, script, extra env (already-formatted <key>/<string> pairs), log basename
  cat > "$HOME/Library/LaunchAgents/$1.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$1</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$HOME_DIR/app/src/$2</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>CBB_HOME</key><string>$HOME_DIR</string>
    <key>CBB_EXTENSION_DIR</key><string>$HOME_DIR/extension</string>$3
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>3</integer>
  <key>StandardErrorPath</key><string>$HOME_DIR/$4.log</string>
  <key>StandardOutPath</key><string>$HOME_DIR/$4.log</string>
</dict></plist>
EOF
}
U=$(id -u)
if [ "$FULL" = 1 ]; then
  rsync -a --delete --exclude '*.test.ts' "$SRC/extension/" "$HOME_DIR/extension/" 2>/dev/null || true
  PIPE_ENV="
    <key>CBB_CHROME_UDD</key><string>$CHROME_DATA</string>
    <key>CBB_CHROME_DIR</key><string>$CHROME_DATA</string>
    <key>CBB_CHROME_SOCKET</key><string>$HOME_DIR/chrome.sock</string>"
  plist "$LABEL.chrome" holder.ts "$PIPE_ENV" holder
  plist "$LABEL" daemon.ts "$PIPE_ENV" daemon
  # Never restart a running holder: that closes Chrome. Start it only if it is not loaded.
  launchctl print "gui/$U/$LABEL.chrome" >/dev/null 2>&1 || launchctl bootstrap "gui/$U" "$HOME/Library/LaunchAgents/$LABEL.chrome.plist"
  # A quit Chrome stays closed until a client needs it. Chrome's own Dock icon would start it without
  # the pipe, so the Dock gets this launcher instead: it starts Chrome through the holder.
  install -m 755 "$SRC/bin/cbb-chrome" "$HOME/.local/bin/cbb-chrome"
  # A plain app bundle around cbb-chrome, with Chrome's icon. An osacompile applet showed the generic
  # script icon (its Assets.car wins over a copied .icns) and started slower.
  APP="$HOME/Applications/Chrome Bridge.app"
  if [ ! -x "$APP/Contents/MacOS/Chrome Bridge" ]; then
    rm -rf "$APP"
    mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
    printf '#!/bin/sh\nexec "$HOME/.local/bin/cbb-chrome"\n' > "$APP/Contents/MacOS/Chrome Bridge"
    chmod 755 "$APP/Contents/MacOS/Chrome Bridge"
    cp "/Applications/Google Chrome.app/Contents/Resources/app.icns" "$APP/Contents/Resources/app.icns"
    cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>Chrome Bridge</string>
  <key>CFBundleIdentifier</key><string>local.chrome-profile-bridge.launcher</string>
  <key>CFBundleName</key><string>Chrome Bridge</string>
  <key>CFBundleIconFile</key><string>app</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
</dict></plist>
PLIST
    codesign --force -s - "$APP"
    echo "install: Dock launcher at $APP (drag it to the Dock in place of Chrome)"
  fi
else
  mkdir -p -m 700 "$HOME_DIR/extension"
  rsync -a --delete --exclude '*.test.ts' "$SRC/extension/" "$HOME_DIR/extension/"
  launchctl bootout "gui/$U/$LABEL.chrome" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/$LABEL.chrome.plist"
  plist "$LABEL" daemon.ts "" daemon
fi
launchctl bootout "gui/$U/$LABEL" 2>/dev/null || true
for _ in $(seq 1 30); do launchctl print "gui/$U/$LABEL" >/dev/null 2>&1 || break; sleep 0.3; done
for _ in $(seq 1 12); do launchctl bootstrap "gui/$U" "$PLIST" 2>/dev/null && break; sleep 0.5; done

for _ in $(seq 1 20); do curl -sf http://127.0.0.1:18765/status >/dev/null && break; sleep 0.25; done
curl -sf http://127.0.0.1:18765/status >/dev/null || { echo "install: the daemon did not start; see $HOME_DIR/daemon.log" >&2; exit 1; }
if [ "$FULL" = 1 ]; then
  echo "install: full-CDP mode, holder + daemon up on 127.0.0.1:18765, no extension needed"
else
  echo "install: extension mode, daemon up on 127.0.0.1:18765; load $HOME_DIR/extension in each profile (chrome://extensions, Developer mode, Load unpacked)"
fi
