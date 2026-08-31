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
| **Write** raw text | `cliplens_write_plaintext` |

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

## The clip daemon (popup)

A lightweight background daemon (`cliplens-daemon`) shows a small transparent **popup** when a clip is
written or generated, and offers a **clip-history picker** on a configurable global hotkey (default `Ctrl+Shift+V`, or the `§` key on Nordic layouts). When it's running,
a successful write flashes a toast — so the user gets visual confirmation without switching windows. If it
isn't running, writes still work silently.

## Flow, in one line

`user asks in plain English → you pick a lens (read) or pen (write) → native clipboard format → user pastes.`
