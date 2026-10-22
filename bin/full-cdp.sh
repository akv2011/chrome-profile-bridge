#!/bin/bash
# Switch this Mac to full-CDP mode (or back with --undo). Restarts Chrome once.
#
# Chrome 136+ refuses the debugging pipe on its default data dir, and on anything that resolves to
# it, so the data moves to ~/ChromeData (a rename on the same disk, instant) and the default path
# becomes a symlink to it: a Dock or Finder launch still opens the same profiles and logins. The
# holder then owns Chrome over the pipe, and the daemon drives every profile with no extension.
# Open tabs come back: restore-on-startup is set while Chrome is closed.
set -uo pipefail
[ "$(uname -s)" = Darwin ] || { echo "full-cdp: run it on the Mac" >&2; exit 2; }
SRC=$(cd "$(dirname "$0")/.." && pwd)
DEFAULT="$HOME/Library/Application Support/Google/Chrome"
DATA="$HOME/ChromeData"
HOME_DIR="$HOME/.claude-browser-bridge"
LABEL=local.claude-browser-bridge
U=$(id -u)

quit_chrome() {
  osascript -e 'tell application "Google Chrome" to quit' 2>/dev/null
  for _ in $(seq 1 40); do pgrep -x "Google Chrome" >/dev/null || return 0; sleep 0.5; done
  return 1
}

undo() {
  launchctl bootout "gui/$U/$LABEL.chrome" 2>/dev/null
  launchctl bootout "gui/$U/$LABEL" 2>/dev/null
  pkill -f "user-data-dir=$DATA" 2>/dev/null
  for _ in $(seq 1 20); do pgrep -f "user-data-dir=$DATA" >/dev/null || break; sleep 0.5; done
  if [ -L "$DEFAULT" ] && [ -d "$DATA" ] && [ ! -L "$DATA" ]; then rm -f "$DEFAULT" && mv "$DATA" "$DEFAULT"; fi
  "$SRC/bin/install.sh" >/dev/null
  open -a "Google Chrome"
  echo "full-cdp: back to extension mode, data at the default path, Chrome reopened"
}

if [ "${1:-}" = --undo ]; then
  quit_chrome || true
  undo
  exit 0
fi

if [ -L "$DEFAULT" ] && [ -d "$DATA" ]; then
  echo "full-cdp: already in full-CDP mode; reinstalling the jobs"
  exec "$SRC/bin/install.sh"
fi
[ -e "$DATA" ] && { echo "full-cdp: $DATA exists and is not ours; not touching anything" >&2; exit 1; }

quit_chrome || { echo "full-cdp: Chrome did not quit; nothing changed" >&2; exit 1; }
for prefs in "$DEFAULT"/*/Preferences; do
  /usr/bin/python3 -c 'import json,sys;p=sys.argv[1];d=json.load(open(p));d.setdefault("session",{})["restore_on_startup"]=1;json.dump(d,open(p,"w"))' "$prefs" 2>/dev/null
done
mv "$DEFAULT" "$DATA" || { open -a "Google Chrome"; echo "full-cdp: move failed; nothing changed" >&2; exit 1; }
ln -s "$DATA" "$DEFAULT"

mv -f "$HOME_DIR/daemon.log" "$HOME_DIR/daemon.log.1" 2>/dev/null   # the success check reads only this run
"$SRC/bin/install.sh" || { echo "full-cdp: install failed; undoing" >&2; undo; exit 1; }
for _ in $(seq 1 60); do
  grep -aq "connected to Chrome through the holder" "$HOME_DIR/daemon.log" 2>/dev/null && break
  sleep 1
done
if ! grep -aq "connected to Chrome through the holder" "$HOME_DIR/daemon.log"; then
  echo "full-cdp: the daemon never reached Chrome; undoing" >&2
  tail -5 "$HOME_DIR/holder.log" >&2
  undo
  exit 1
fi
echo "full-cdp: on. Chrome is held over the trusted pipe; every pw-* profile works with no extension."
