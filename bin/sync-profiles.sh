#!/bin/bash
# Register a pw-* tool for the named Chrome profiles. Opt-in, because a shared Chrome holds other
# people's accounts too. Idempotent: already-mapped profiles and existing names are skipped.
#
#   bin/sync-profiles.sh                       list signed-in profiles with no tool yet, change nothing
#   bin/sync-profiles.sh "Profile 5" [...]     register those profile dirs
set -euo pipefail
[ "$(uname -s)" = Darwin ] || { echo "sync-profiles: macOS only" >&2; exit 2; }
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"

HOME_DIR="$HOME/.chrome-profile-bridge"
PROFILES="$HOME_DIR/profiles.json"
# Full-CDP mode keeps Chrome's data (and Local State) at ~/ChromeData; else the default path.
CHROME_DIR="$HOME/ChromeData"; [ -d "$CHROME_DIR" ] || CHROME_DIR="$HOME/Library/Application Support/Google/Chrome"

# Candidates (or only the named ones), as "pw-name<TAB>dir<TAB>email" lines. Python does the JSON and
# naming, and warns about a named dir that is unknown, not signed in or already mapped.
lines=$(/usr/bin/python3 - "$PROFILES" "$CHROME_DIR/Local State" "$@" <<'PY'
import json, re, sys
prof_path, state_path, wanted = sys.argv[1], sys.argv[2], set(sys.argv[3:])
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
    if d in mapped_dirs or (wanted and d not in wanted): continue
    email = (info.get("user_name") or "").strip()
    if not email: continue                                # not signed in yet; added once it is
    name = "pw-" + slug(email)
    n, i = name, 2
    while n in taken: n, i = f"{name}-{i}", i + 1          # keep names unique
    taken.add(n)
    out.append(f"{n}\t{d}\t{email}")
for d in sorted(wanted - {line.split("\t")[1] for line in out}):
    print(f"sync-profiles: skipped \"{d}\": unknown, not signed in, or already mapped", file=sys.stderr)
print("\n".join(out))
PY
)

[ -n "$lines" ] || { echo "sync-profiles: nothing to add"; exit 0; }
if [ $# = 0 ]; then
  echo "Signed-in profiles with no pw-* tool (dir, email, name it would get):"
  while IFS=$'\t' read -r name dir email; do printf '  %s\t%s\t%s\n' "$dir" "$email" "$name"; done <<< "$lines"
  echo "Register one: $0 \"<dir>\" [...]"
  exit 0
fi

# The lines come in on fd 3, so nothing in the loop that reads stdin can eat the rest.
while IFS=$'\t' read -r name dir email <&3; do
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
  echo "sync-profiles: added $name -> \"$dir\" ($email)"
done 3<<< "$lines"
