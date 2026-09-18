# ClipLens one-command installer for Windows.
#
#   .\install.ps1            # install deps, link the global CLI, wire every AI client
#   .\install.ps1 --dry-run  # show what the client-wiring would change, write nothing
#
# Idempotent: safe to re-run after every `git pull`.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

Write-Host "ClipLens installer (Windows)"

# 1. Node check
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js not found. Install Node 18+ first: https://nodejs.org"
  exit 1
}
Write-Host "  * node $(node -v)"

# 2. Deps + global CLI link
npm install --silent
npm link --silent
Write-Host "  * linked global CLI (cliplens, clipit, clipmail, clipconsole, clipmural, reclip, clipimage, clip-clear)"

# 3. Wire every detected AI client (Claude, Gemini, Codex, Cursor, ...).
node tools/install.mjs @args

Write-Host ""
Write-Host "Done. Restart your AI client(s) so they pick up the ClipLens MCP server."
