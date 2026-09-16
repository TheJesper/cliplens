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

**Unsure if ClipLens is connected / running the latest code?** Call `cliplens_ping` — it returns the
version, cache state and daemon status without touching the clipboard. Use it to verify; NEVER build a
throwaway clip just to "test" that ClipLens works.

**Read receipts.** Every READ (`cliplens_analyze` / `_text` / `_lens`) fires a desktop popup with a
distinct magnifier icon, the reading agent and a short preview — so the user sees ClipLens is done and
the clipboard is free for their next copy. Writes get the pen/format icon instead, so read vs write are
visually distinct.

| Intent | Tool |
|--------|------|
| What's on the clipboard? | `cliplens_analyze` (auto-detects source + applies the right lens) |
| Read plain text / all formats | `cliplens_text` · `cliplens_capture` · `cliplens_formats` · `cliplens_inspect` |
| Read a Figma/Mural copy | `cliplens_lens` (lens = figma \| mural) |
| Save a copied image for you to see | `cliplens_save_image` |
| **Write** Slack rich text | `cliplens_write_slack` (markdown in → Quill Delta on the clipboard) |
| **Write** Teams/Outlook/Docs rich text | `cliplens_write_teams` (markdown in → HTML Format on the clipboard) |
| **Write** raw text | `cliplens_write_plaintext` |

### Default: plain text (VANILLA). Formatting is opt-in.

**The default write is ALWAYS `cliplens_write_plaintext`.** When the user says /clip, "clip",
"lägg clip", "put this on my clipboard", "copy this" with NO format explicitly named — use
plaintext. Vanilla text, no markdown, no rich formatting. It pastes cleanly ANYWHERE
(chat-to-chat, terminal, editor, and yes, Slack too).

Reach for a formatted pen ONLY when the user explicitly names the target app:

| User says | Use |
|-----------|-----|
| /clip · "clip" · "lägg clip" · "copy this" · "clipboard" (no app named) | `cliplens_write_plaintext` (DEFAULT) |
| "for Slack" · "as a Slack message" · /clip slack | `cliplens_write_slack` |
| "for Teams/Outlook" · /clip teams | `cliplens_write_teams` |
| "as Mural stickies" · /clip mural | `clipmural` |

**Common mistake to avoid:** naming a destination like "for devkit" or "to paste to my
colleague" is NOT naming a format — that is still plaintext. Only the words "Slack",
"Teams", "Outlook", "Mural" (or /clip <fmt>) switch away from plaintext. Mentioning that
the paste will END UP in Slack does not mean the clip should be Slack-formatted; when in
doubt, plaintext + ask. **Never default to Slack/markdown.**


CLI fallback (if no MCP): `clipit` (Slack), `clipmail` (Outlook/Teams HTML), `clipconsole` (strip console
noise), `clipmural` (Mural stickies/diagrams), `cliplens capture|inspect`.

### Reading a Figma copy — what you can and can't get

When the user copies from Figma, the clipboard `HTML Format` holds TWO base64 blobs:

- `data-metadata="<!--(figmeta)...-->"` — small JSON: `fileKey`, `pasteID`, `editorType`,
  `selectedNodeData` (node IDs). Easy to decode (base64 → JSON).
- `data-buffer="<!--(figma)...-->"` — the large binary scene graph in Figma's **Kiwi** serialization
  (can be ~1 MB). This is where the RICH data lives: font size, colors, x/y, spacing, icon/component names.

What the figma lens reads TODAY: only the flat **plain-text** fallback — layer names + text content. That
is enough for "what does this screen say / list the labels", but it does NOT include styles.

To get font size, colors, icon names etc. you must **decode the Kiwi `data-buffer`** — there is no shortcut,
those values are not in the plain text. Known caveats when building that:
- `captureFormat('HTML Format')` can hit **ENOBUFS** on big Figma copies (the ~1 MB payload exceeds the
  default exec buffer) — raise `maxBuffer` before relying on the HTML path.
- Plain-text reads suffer **mojibake** (åäö → `�`) because Figma's string format comes back cp1252-decoded;
  the same cp1252→UTF-8 fix used for HTML Format is needed on `captureText` too.
- There is NO Figma **pen** (write): Figma's clipboard format is proprietary/versioned; the right way to
  write to Figma is its Plugin/REST API, not the clipboard. Lens (read) only.

**Org-specific formats** live in the user's gitignored `private-lenses/` + `private-pens/` and are
auto-loaded — check `cliplens_analyze` output; don't hard-code company formats into the public core.

## The two rules that matter

1. **After you WRITE to the clipboard, tell the user to press `Ctrl+V` right away** — the payload is live on
   the clipboard now; the next copy overwrites it.
2. **Humanize generated text.** ClipLens strips the machine tells automatically (em-dashes → hyphens, curly
   → straight quotes, zero-width spaces, BOM). Keep your tone plain and human; don't undo it with fancy
   punctuation.

### Formatting is STANDARD MARKDOWN — not Slack mrkdwn

The pens (`write_slack`, `write_teams`) convert **standard markdown**, not the target app's own
markup. This trips agents up most with **links**: write `[label](url)`, NOT Slack's `<url|label>`.
`<url|label>` used to paste as literal `<...>` text; the Slack pen now auto-converts it, but always
prefer `[label](url)` so the same source works for Teams/plaintext too. Same for bold/italic — use
`**bold**` / `*italic*`, never Slack's `*bold*` / `_italic_` convention.

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

### Local config (`cliplens_config`)

`~/.cliplens/state.json` is the local, never-committed config hub. Use `cliplens_config`:

| User says | Call |
|-----------|------|
| "show my cliplens settings" | `cliplens_config { action: "show" }` |
| "save clip images in <folder>" | `cliplens_config { action: "set", key: "imageDir", value: "<folder>" }` |
| "ask me where to save images" | `cliplens_config { action: "set", key: "askImageDir", value: "on" }` |
| "stop reminding me about cache" | `cliplens_config { action: "set", key: "remindCache", value: "off" }` |
| "clip sound off" / "make it silent" | `cliplens_config { action: "set", key: "clipSound", value: "off" }` |
| "clip sound on" / "use the success sound" | `cliplens_config { action: "set", key: "clipSound", value: "success" }` |

Clip **images** save to the OS temp dir by default (cross-platform), NEVER into the repo. If
`askImageDir` is on and no folder is set, `cliplens_analyze` / `cliplens_save_image` return
`askForDir: true` — ask the user for a folder, then store it with `cliplens_config`.

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
