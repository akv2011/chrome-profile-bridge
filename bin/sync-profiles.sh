#!/bin/bash
# Register a pw-* tool for every signed-in Chrome profile that does not have one yet. Idempotent:
# already-mapped profiles and existing names are skipped. A profile with no signed-in account is
# skipped until it has one (the watcher re-runs when Chrome updates Local State).
#
#   bin/sync-profiles.sh           add every new profile
#   bin/sync-profiles.sh --quiet   same, but print only what changed (for the launchd watcher)
set -euo pipefail
[ "$(uname -s)" = Darwin ] || { echo "sync-profiles: macOS only" >&2; exit 2; }
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"
QUIET=0; [ "${1:-}" = --quiet ] && QUIET=1
say() { [ "$QUIET" = 1 ] || echo "$@"; }

HOME_DIR="$HOME/.chrome-profile-bridge"
PROFILES="$HOME_DIR/profiles.json"
# Full-CDP mode keeps Chrome's data (and Local State) at ~/ChromeData; else the default path.
CHROME_DIR="$HOME/ChromeData"; [ -d "$CHROME_DIR" ] || CHROME_DIR="$HOME/Library/Application Support/Google/Chrome"

# Profiles that need adding, as "pw-name<TAB>dir<TAB>email" lines. Python does the JSON and naming.
lines=$(/usr/bin/python3 - "$PROFILES" "$CHROME_DIR/Local State" <<'PY'
import json, re, sys
prof_path, state_path = sys.argv[1], sys.argv[2]
try: profiles = json.load(open(prof_path))
except Exception: profiles = {}
mapped_dirs = set(profiles.values())
taken = set(profiles)
try: cache = json.load(open(state_path))["profile"]["info_cache"]
except Exception: cache = {}

def slug(email):
    local, _, domain = email.partition("@")
    base = local if domain.endswith("gmail.com") else domain.split(".")[0]
    s = re.sub(r"[^a-z0-9]", "", base.lower())
    return s or "profile"

out = []
for d, info in sorted(cache.items()):
    if d in mapped_dirs: continue
    email = (info.get("user_name") or "").strip()
    if not email: continue                                # not signed in yet; added once it is
    name = "pw-" + slug(email)
    n, i = name, 2
    while n in taken: n, i = f"{name}-{i}", i + 1          # keep names unique
    taken.add(n)
    out.append(f"{n}\t{d}\t{email}")
print("\n".join(out))
PY
)

[ -n "$lines" ] || { say "sync-profiles: nothing new"; exit 0; }

while IFS=$'\t' read -r name dir email; do
  [ -n "$name" ] || continue
  # 1) name -> dir in profiles.json (atomic via a temp file)
  /usr/bin/python3 - "$PROFILES" "$name" "$dir" <<'PY'
import json, os, sys
p, name, d = sys.argv[1], sys.argv[2], sys.argv[3]
try: data = json.load(open(p))
except Exception: data = {}
data[name] = d
tmp = p + ".tmp"
json.dump(data, open(tmp, "w"), indent=2, sort_keys=True)
os.replace(tmp, p)
PY
  # 2) the pw-* MCP tool, skipping if already present
  if ! claude mcp get "$name" 2>/dev/null | grep -q cbb-mcp; then
    claude mcp remove "$name" -s user >/dev/null 2>&1 || true
    claude mcp add "$name" -s user -- /opt/homebrew/bin/node "$HOME/.local/bin/cbb-mcp" "$name" >/dev/null
  fi
  say "sync-profiles: added $name -> \"$dir\" ($email)"
done <<< "$lines"
