#!/bin/bash
# Point your pw-* (Playwright/Claude Code) MCP entries at the bridge, for every profile whose
# extension is connected now, or only the names you pass. Safe to run again.
#
#   bin/use-bridge.sh               every connected profile
#   bin/use-bridge.sh pw-example    just these
set -euo pipefail
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"

if [ $# -gt 0 ]; then
  names=("$@")
else
  names=()
  while IFS= read -r name; do names+=("$name"); done < <(curl -sf http://127.0.0.1:18765/status | /usr/bin/python3 -c '
import json, sys
for name, p in json.load(sys.stdin)["profiles"].items():
    if p.get("extension") and name.startswith("pw-"):
        print(name)')
fi
[ ${#names[@]} -gt 0 ] || { echo "use-bridge: no profile has the extension connected yet"; exit 0; }

for name in "${names[@]}"; do
  if claude mcp get "$name" 2>/dev/null | grep -q cbb-mcp; then
    echo "$name: already on the bridge"
  else
    claude mcp remove "$name" -s user >/dev/null 2>&1 || true
    claude mcp add "$name" -s user -- /opt/homebrew/bin/node "$HOME/.local/bin/cbb-mcp" "$name" >/dev/null
    echo "$name: switched to the bridge"
  fi
done
