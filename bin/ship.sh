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
# cbb-fanout runs here, where the daemon is: the repo's node_modules on this Mac lack its playwright-core.
mkdir -p "$APP/bin" "$HOME/.local/bin"
install -m 755 "$SRC/bin/cbb-fanout" "$APP/bin/cbb-fanout"
ln -sf "$APP/bin/cbb-fanout" "$HOME/.local/bin/cbb-fanout"
# VERSION is a hash of what was shipped, not the commit, so a commit that only touches docs or the
# installer leaves it unchanged and the daemon does not restart for nothing.
find "$APP/src" "$APP/package-lock.json" "$EXT" -type f -print0 2>/dev/null | sort -z | xargs -0 shasum -a 256 \
  | sed "s#$HOME##" | shasum -a 256 | cut -c1-40 > "$APP/VERSION"
