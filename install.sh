#!/usr/bin/env bash
# ClipLens one-command installer for macOS & Linux.
#
#   ./install.sh            # install deps, link the global CLI, wire every AI client
#   ./install.sh --dry-run  # show what the client-wiring would change, write nothing
#
# Idempotent: safe to re-run after every `git pull`.
set -euo pipefail
cd "$(dirname "$0")"

echo "ClipLens installer ($(uname -s))"

# 1. Node check
if ! command -v node >/dev/null 2>&1; then
  echo "  ✗ Node.js not found. Install Node 18+ first: https://nodejs.org" >&2
  exit 1
fi
echo "  • node $(node -v)"

# 2. Deps + global CLI link
npm install --silent
npm link --silent || npm link   # global aliases: cliplens, clipit, clipmail, reclip, ...
echo "  • linked global CLI (cliplens, clipit, clipmail, clipconsole, clipmural, reclip, clipimage, clip-clear)"

# 3. Linux: make sure a clipboard tool exists (macOS ships pbcopy/pbpaste).
if [ "$(uname -s)" = "Linux" ]; then
  if ! command -v wl-copy >/dev/null 2>&1 \
     && ! command -v xclip >/dev/null 2>&1 \
     && ! command -v xsel  >/dev/null 2>&1; then
    echo "  ! No clipboard tool found. Install one so read/write works:"
    echo "      Wayland:  sudo apt install wl-clipboard"
    echo "      X11:      sudo apt install xclip   (or xsel)"
  fi
fi

# 4. Wire every detected AI client (Claude, Gemini, Codex, Cursor, ...).
node tools/install.mjs "$@"

echo
echo "Done. Restart your AI client(s) so they pick up the ClipLens MCP server."
