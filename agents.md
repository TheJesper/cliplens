# ClipLens -- Agent Knowledge Base

All context, proven routes, and learnings from 2026-06-16 to 2026-08-24.

**Migration status: COMPLETE.** This is the standalone folder. Old `clipboard-canvas-adapter/` is deprecated.

## Project

| Key | Value |
|-----|-------|
| Path | `<path-to>/cliplens` |
| Skill | `~/.kiro/skills/cliplens.md` |
| MCP config | `~/.kiro/settings/mcp.json` -> "cliplens" |
| License | MIT |
| Platform | Windows (PowerShell clipboard bridge) |

## CLI Aliases (globally linked via npm)

| Alias | Script | What |
|-------|--------|------|
| `clipit` | `src/slack-clip.js` | Markdown -> Slack Quill Delta clipboard |
| `clipmail` | `src/html-clip.js` | Markdown -> HTML clipboard (Outlook/Teams) |
| `clipemail-read` | `src/outlook-lens.js` | Parse Outlook multi-mail clipboard -> structured summary |
| `clipconsole` | `src/console-lens.js` | Filter console noise -> tmp/console-filtered.txt |
| `canvas-clip` | `src/cli.js` | Original CLI (capture/inspect/diff) |

## MCP Tools (registered in mcp.json)

| Tool | Purpose |
|------|---------|
| `cliplens_analyze` | Auto-detect clipboard source + apply lens |
| `cliplens_text` | Get plain text from clipboard |
| `cliplens_capture` | Full snapshot (all formats) |
| `cliplens_formats` | List available formats |
| `cliplens_inspect` | Decode specific format |
| `cliplens_save_image` | Save clipboard image -> tmp/clip-image.png |
| `cliplens_write_slack` | Markdown -> Slack rich text clipboard |
| `cliplens_write_plaintext` | Raw text -> clipboard |
| `cliplens_lens` | Apply specific lens (figma/mural) |
| `cliplens_outlook` | Parse Outlook Web multi-mail clipboard |
| `cliplens_notify` | Desktop notification card (semantic kind, agent badge, visual-first) |

## Key Files

| File | Purpose |
|------|---------|
| `src/slack-clip.js` | Slack adapter (Quill Delta encoder + humanize) |
| `src/html-clip.js` | HTML adapter (Outlook/Teams/Docs) |
| `src/outlook-lens.js` | Outlook multi-mail parser (subjects, JIRA keys, categories) |
| `src/console-lens.js` | Console noise filter |
| `src/notify.js` | WPF notification overlay (transparent emoji + MP3 sound) |
| `src/mcp-server.js` | MCP server (all cliplens_* tools) |
| `src/clipboard.js` | Windows clipboard I/O (PowerShell bridge) |
| `src/lenses/figma.js` | Figma clipboard parser |
| `SPEC-multiclip.md` | Spec for clip history ring buffer (not yet built) |

## Architecture

```
User action (copy/paste)
    |
ClipLens MCP (read) or CLI alias (write)
    |
Adapter per target app:
  - Slack: Quill Delta in Chromium Custom MIME binary
  - Outlook/Teams: HTML Format clipboard
  - Mural: mly:// base64 JSON in HTML clipboard
    |
humanize() strips AI artifacts (dashes, curly quotes, BOM)
    |
PowerShell writes to Windows clipboard
    |
User pastes (Ctrl+V)
```

## Proven Routes

### Slack Rich Text
- Binary: Chromium Web Custom MIME Data Format
- Encoding: `encodeCustomMime()` with UTF-16LE pairs
- Entries: `public.utf8-plain-text` + `slack/texty` (Quill Delta JSON)
- Supports: bold, italic, code, code-block, links, emoji, lists
- parseInline handles: `**bold**`, `*italic*`, `_italic_`, `` `code` ``, `[link](url)`, `:emoji:`
- `--file` flag always (avoids shell escaping issues with apostrophes)

### Slack Tables (workaround -- Slack has NO native table support)
- Option 1: ASCII table inside code block (``` fencing)
- Option 2: Block Kit section fields (max 2 columns per section)
- Option 3: Monospaced alignment with fixed-width chars
- Best for paste: ASCII table in code block -- preserved by Quill Delta as code_block type
- Example:
  ```
  | Header 1   | Header 2   | Header 3  |
  |------------|------------|-----------|
  | body row 1 | column 2   | column 3  |
  ```
  Render as ``` block so Slack shows monospace.

### Mural Native Stickies
- Format: `mly://{base64}` inside HTML Format clipboard
- Batch: multiple widgets in one paste via widgets[] array
- REAL SCHEMA CAPTURED: see `SPEC-mural-format.md`. The CF_HTML fragment is
  `<murally hiddenContent="mly://{base64}"></murally>` (NOT `<html v="1">`).
  Base64 = JSON `{canvasLink,muralId,zone,widgets[]}`. Widget types:
  `murally.widget.PhotoWidget` (images are Mural-hosted assets, not inline),
  `murally.widget.arrow` (connectors), `murally.widget.InkingWidget` (pen).
- Local images: deliver via the image pen (real clipboard image), let Mural
  ingest as a new asset on paste — a synthesized PhotoWidget can't point at a
  local file.

### Console Lens
- Reduces 99%+ noise from DevTools console copies
- Pure JS regex filtering, no AI needed
- Output: `tmp/console-filtered.txt`

### Image Reading
- `cliplens_save_image` -> saves PNG to tmp/clip-image.png
- Agent uses `read_file` -> multimodal vision
- Can then upload to Jira, describe, compare with specs

### HTML (Outlook/Teams)
- Standard HTML Format clipboard with header offsets
- `clipmail` CLI alias

### Outlook Mail Parsing
- `clipemail-read` CLI or `cliplens_outlook` MCP tool
- Reads `Web Custom Format0` containing `application/owa-item-drag-data` JSON
- Extracts: subjects[], sizes[], rowKeys[], latestItemIds[]
- Categorizes: jira-update, meeting, github-pr, confluence, admin, newsletter
- Flags: [Action needed], [FYA], Reminder, Mandatory, Urgent, Deadline
- Extracts JIRA keys via regex /[A-Z][A-Z0-9]+-\d+/
- Output: `tmp/email-summary.txt`
- No mail body reading -- metadata only, saves tokens

## Notification System (notify.js)

- WPF overlay with true transparency (AllowsTransparency)
- Native Win11 color emoji at 80pt (Segoe UI Emoji)
- Fade in 200ms, hold 1.5s, fade out 500ms (WPF DoubleAnimation)
- Custom sound via MediaPlayer (MP3/WAV)
- Fire-and-forget (detached PowerShell process, unref'd)
- Config via env vars:
  - `CLIPLENS_EMOJI` -- emoji character (default: clipboard)
  - `CLIPLENS_ICON` -- path to .png/.ico (overrides emoji)
  - `CLIPLENS_SOUND` -- path to .mp3/.wav, or "off" to disable
- Default sound: looks in `src/sounds/` subfolder
- Triggers on: cliplens_write_slack success, clipit CLI success

## Writing Guidelines (in skill)

- Swedish collaborative tone, never blame
- "indications" not "evidence", "issue" not "failure"
- No em-dashes, curly quotes, or AI filler phrases
- humanize() auto-strips: em-dashes -> hyphens, curly quotes -> straight, BOM, zero-width spaces

## Decisions Log

| Decision | Chose | Rejected | Why |
|----------|-------|----------|-----|
| bold | Real bold (Quill Delta) | small-caps unicode | Small-caps was experiment, confusing |
| Tone | Skill guidelines | Regex replacement | "page fault" -> "page source" breaks things |
| Tool naming | cliplens_write_slack / _plaintext | Generic cliplens_write | Agents kept using wrong one |
| Input method | --file always | CLI args | Shell escaping breaks apostrophes |
| Image analysis | save to file + read_file | OCR/Tesseract | Multimodal vision does everything better |
| Console lens | Pure JS filtering | AI analysis | Saves tokens, 99% reduction without AI |
| Temp files | tmp/ subfolder | Project root | Never trash root |
| Notification | WPF | WinForms | WinForms has no true transparency, black emoji |
| Notification sound | Custom MP3 | SystemSounds::Asterisk | System sound is ugly |

## Tool Naming Ideas (future refactor)

| Command | What it does |
|---------|-------------|
| `clipit` | Create clip from conversation (write to clipboard) |
| `clip` | Read current clip (what's in clipboard now) |
| `clip lens` | Analyze clip with lens (detect format, parse structure) |
| `clip analyse` | Research new formats, develop new lenses |

## Upcoming Features

1. **Multiclip ring buffer** (SPEC-multiclip.md) -- background watcher saves last 10 clips, agent can recall by timestamp
2. **Notify sound selection** -- find a good soft stereo click sound
3. **macOS port** -- replace PowerShell with pbcopy/xclip, osascript for notifications
4. **Terminal detection** -- PowerShell `;` vs bash `&&`
5. **Product-specific console patterns** -- sub-adapters per product for console lens

## Platform Dependencies (Windows only)

- PowerShell + System.Windows.Forms for clipboard read/write
- System.Drawing for image save
- WPF (PresentationFramework) for notification overlay
- MediaPlayer for MP3 playback
- Everything else (Buffer ops, encoding) is cross-platform Node.js

## For Mac/Linux Port

- Replace PowerShell with pbcopy/xclip (or wl-copy for Wayland)
- The Chromium MIME encoding logic is portable
- Console-lens is already platform-agnostic
- Notification: osascript (macOS) or notify-send (Linux)

## MCP Config Example

```json
"cliplens": {
  "command": "node",
  "args": ["C:\\Users\\USER\\code\\my\\cliplens\\src\\mcp-server.js"],
  "env": {},
  "autoApprove": ["cliplens_text", "cliplens_formats", "cliplens_capture", "cliplens_analyze"]
}
```

## Important Rules

- `cliplens_analyze` is the default entry point -- always try it first
- Never shell out to PowerShell for clipboard -- use MCP tools
- For Slack: ALWAYS use `cliplens_write_slack` (not plaintext)
- "again" / "clip" / "make clip" = ALWAYS re-run clipboard write, never assume it's still there
- After write, tell user Ctrl+V immediately
- Console lens: read `tmp/console-filtered.txt`, never raw clipboard
- Notification failure must never break the clip operation
