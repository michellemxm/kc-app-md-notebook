#!/usr/bin/env bash
# md-notebook backend launcher.
#
# The KiroCrew gateway spawns app backends with a minimal PATH that may not
# include the user's node install (Homebrew/nvm). This wrapper locates node
# in the common places and execs the real server. PORT is passed via env.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

find_node() {
  command -v node 2>/dev/null && return
  for c in /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.local/bin/node"; do
    [ -x "$c" ] && echo "$c" && return
  done
  # nvm-managed node: newest installed version
  if [ -d "$HOME/.nvm/versions/node" ]; then
    local latest
    latest=$(ls -1 "$HOME/.nvm/versions/node" | sort -V | tail -1)
    [ -x "$HOME/.nvm/versions/node/$latest/bin/node" ] && echo "$HOME/.nvm/versions/node/$latest/bin/node" && return
  fi
  return 1
}

NODE="$(find_node)" || { echo "md-notebook: no node binary found" >&2; exit 1; }
exec "$NODE" "$DIR/server.mjs"
