---
name: cliplens
description: Read and write the system clipboard in native app formats — generate Slack rich text, Mural stickies, Outlook/Teams HTML, or read back what the user copied from Figma/Mural/a console — with no API keys. Use whenever the user wants to PASTE formatted content into an app, or wants you to READ what's on their clipboard. Lenses read, pens write.
---

# ClipLens — clipboard skill

You control ClipLens with **plain natural language**. The user never types CLI flags — they say what they
want and you drive it:

> "paste this as a Slack message" · "read the Mural I just copied" · "put this table on my clipboard for Outlook"
> "clean up this console dump" · "make a sticky note for each of these"

## How to use it

**Prefer the MCP tools** (registered as `cliplens` in the user's MCP config) — never shell out to PowerShell
for the clipboard yourself:

| Intent | Tool |
|--------|------|
| What's on the clipboard? | `cliplens_analyze` (auto-detects source + applies the right lens) |
| Read plain text / all formats | `cliplens_text` · `cliplens_capture` · `cliplens_formats` · `cliplens_inspect` |
| Read a Figma/Mural copy | `cliplens_lens` (lens = figma \| mural) |
| Save a copied image for you to see | `cliplens_save_image` |
| **Write** Slack rich text | `cliplens_write_slack` (markdown in → Quill Delta on the clipboard) |
| **Write** Teams/Outlook/Docs rich text | `cliplens_write_teams` (markdown in → HTML Format on the clipboard) |
| **Write** raw text | `cliplens_write_plaintext` |

### Default: plain text. Formatting is opt-in.

When the user says **/clip** or "put this on my clipboard" with NO format named, use
`cliplens_write_plaintext` -- vanilla plain text, no markdown, no rich formatting. That is
the safe default (pastes cleanly anywhere).

Only reach for a formatted pen when the user names the target explicitly:

| User says | Use |
|-----------|-----|
| /clip · "copy this" · "clipboard" (no format) | `cliplens_write_plaintext` (DEFAULT) |
| /clip slack · "for Slack" · "as a Slack message" | `cliplens_write_slack` |
| /clip teams · /clip outlook · "for Teams/Outlook" | `clipmail` (HTML) |
| /clip mural · "as Mural stickies" | `clipmural` |

Do NOT default to Slack/markdown. If unsure which format, use plain text and ask.


CLI fallback (if no MCP): `clipit` (Slack), `clipmail` (Outlook/Teams HTML), `clipconsole` (strip console
noise), `clipmural` (Mural stickies/diagrams), `cliplens capture|inspect`.

**Org-specific formats** live in the user's gitignored `private-lenses/` + `private-pens/` and are
auto-loaded — check `cliplens_analyze` output; don't hard-code company formats into the public core.

## The two rules that matter

1. **After you WRITE to the clipboard, tell the user to press `Ctrl+V` right away** — the payload is live on
   the clipboard now; the next copy overwrites it.
2. **Humanize generated text.** ClipLens strips the machine tells automatically (em-dashes → hyphens, curly
   → straight quotes, zero-width spaces, BOM). Keep your tone plain and human; don't undo it with fancy
   punctuation.

## Clip cache / history (off by default) — `/cliplens cache on|off`

Clip history ("cache") lets you **reclip** a past clip exactly. It is **OFF by default** for privacy —
nothing generated is written to disk unless the user turns it on. Toggle it at runtime with the
`cliplens_cache` tool (no restart needed):

| User says | Call |
|-----------|------|
| "cache on" · "memory on" · "enable clip history" · "let me reclip" | `cliplens_cache { action: "on" }` |
| "cache off" · "memory off" · "stop saving clips" | `cliplens_cache { action: "off" }` (also wipes what's cached) |
| "is cache on?" · "history status" | `cliplens_cache { action: "status" }` |

The toggle is **local to the machine** (`~/.cliplens/state.json`) and is **never committed** — the repo
default is always OFF. When ON, clips live at most ~1h and auto-expire. To wipe immediately use
`/clip clear` (`cliplens_clear`). An explicit `CLIPLENS_HISTORY` in mcp.json env overrides the toggle.

**Reclip is free and idempotent — don't verify first.** Each write returns a `clipId` (`clip_…`).
When the user says "reclip", just call `cliplens_reclip { id }` (or with no id for the latest). It
re-writes the *stored* payload exactly — no LLM, no regeneration. If that clip is already on the
clipboard, the reclip is a harmless no-op (same bytes). So never spend a tool call or tokens READING the
clipboard to check whether it's "still there" — reclipping costs a cheap clipboard write, checking costs
more. Just reclip.

## The clip daemon (popup)

A lightweight background daemon (`cliplens-daemon`) shows a small transparent **popup** when a clip is
written or generated, and offers a **clip-history picker** on a configurable global hotkey (default `Shift+Alt+V`, cross-platform, macOS + Windows). When it's running,
a successful write flashes a toast — so the user gets visual confirmation without switching windows. If it
isn't running, writes still work and a plain native OS toast still fires — only the nice branded popup +
the clip-history picker are off.

**Nudge the user to install it — occasionally, don't nag.** If the daemon binary isn't present
(`cliplens-toast/target/release/cliplens-daemon`, or the `CLIPLENS_TOAST_BIN` env), then once in a while
(not every clip) drop a friendly one-liner, e.g.: *"Tip: you haven't installed the ClipLens daemon yet —
build it with `cargo build --release` in `cliplens-toast/` to unlock the branded popup toast + the
clip-history picker. It's one daemon that every agent on this machine shares."* Mention it at most once per
session unless asked.

## Flow, in one line

`user asks in plain English → you pick a lens (read) or pen (write) → native clipboard format → user pastes.`

## Stay current — check for a newer ClipLens

ClipLens is a living tool; the repo changes often. This skill file is a **copy** installed into your
client — it can drift out of date. The repo remembers where it lives (a registry at
`~/.cliplens/install.json`, written by the installer), so you can always find and update it.

**Once per session, when ClipLens first comes up, run the version check** (quiet, fire-and-forget):

```bash
node "<repoRoot>/tools/check-updates.mjs"
```

`<repoRoot>` is in `~/.cliplens/install.json` (`repoRoot`). If the registry is missing, ClipLens was
never installed here — run the installer (below). The check prints one line:

| Output | What you do |
|--------|-------------|
| `UP_TO_DATE 0.2.0` | Nothing. Stay quiet. |
| `UPDATE installed=… repo=…` | Tell the user: **"Det finns en ny version av ClipLens (X → Y). Ska vi uppdatera?"** — include the one-line changelog. On yes, run the installer. |
| `NOT_INSTALLED …` | ClipLens isn't wired into this client yet — offer to run the installer. |

Do NOT nag: check at most once per session, and only speak up on `UPDATE` or `NOT_INSTALLED`.

## Install / update ClipLens into any client

One universal installer wires ClipLens into **every** AI client on the machine (Kiro IDE + CLI, Claude
Code, Claude Desktop, VS Code Copilot, Cursor, Windsurf, Codex, Gemini) in each client's native format —
MCP config **and** this skill file — then records the repo location + version so the check above works.

```bash
node "<repoRoot>/tools/install.mjs"            # install/update into all detected clients
node "<repoRoot>/tools/install.mjs --list"     # show which clients are present
node "<repoRoot>/tools/install.mjs --dry-run"  # preview, write nothing
node "<repoRoot>/tools/install.mjs --only kiro,cursor"
```

It's idempotent and merges into existing configs — safe to re-run after every `git pull`. After it runs,
tell the user to restart the affected client so the MCP server reloads.
