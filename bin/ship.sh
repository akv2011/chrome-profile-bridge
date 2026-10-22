#!/bin/bash
# Copy the committed code into the installed copy (~/.claude-browser-bridge). The repo's
# post-commit hook runs this, so every commit reaches the running bridge with no manual step: the
# daemon sees the new VERSION and restarts itself once no chat is connected. The Chrome holder is
# never restarted here (that would close the browser); it runs new code the next time Chrome starts.
set -euo pipefail
SRC=$(cd "$(dirname "$0")/.." && pwd)
APP="$HOME/.claude-browser-bridge/app"
EXT="$HOME/.claude-browser-bridge/extension"
mkdir -p -m 700 "$APP" "$EXT"
rsync -a --delete --exclude '*.test.ts' --exclude testing "$SRC/src/" "$APP/src/"
rsync -a --delete --exclude '*.test.ts' "$SRC/extension/" "$EXT/"
if ! cmp -s "$SRC/package-lock.json" "$APP/package-lock.json"; then
  cp "$SRC/package.json" "$SRC/package-lock.json" "$APP/"
  (cd "$APP" && PATH=/opt/homebrew/bin:$PATH npm ci --omit=dev --no-audit --no-fund --loglevel=error)
fi
git -C "$SRC" rev-parse HEAD > "$APP/VERSION"
