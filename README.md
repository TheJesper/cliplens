# ClipLens 🔍

**The clipboard is the API.**

ClipLens reads and writes the system clipboard in the *native formats real apps use* — so an AI agent or a
CLI can generate a Slack message with real bold/links, a Mural sticky note, an Outlook-ready HTML email, or
read back a Figma/Mural selection — with **no API keys, no OAuth, no marketplace approval**. Just:

> **generate → clipboard → paste.**

Most integrations die on auth, rate limits, and approval queues. The clipboard doesn't. Every app already
speaks it. ClipLens turns that into a universal adapter layer.

---

## The idea: Lenses & Pens

| | Direction | What it does |
|---|---|---|
| 🔍 **Lens** | READ | Decodes a clipboard payload (Mural `mly://`, Figma, Slack Quill Delta, console dumps) into clean, structured, token-friendly data. |
| ✍️ **Pen** | WRITE | Encodes structured input into a real app's clipboard format (Slack rich text, Outlook HTML, Mural widgets, images). |

You paste. The app thinks a human did it.

```
copy / paste
   │
ClipLens  ──►  Lens (read)  ──►  structured data for your agent
          ◄──  Pen  (write) ◄──  your agent's content
   │
native clipboard format  ──►  Ctrl+V into Slack / Mural / Outlook / …
```

## Proven adapters

| App | Lens (read) | Pen (write) | Format |
|-----|:-----------:|:-----------:|--------|
| **Slack** | | ✅ bold/italic/lists/links/code | Quill Delta in a Chromium custom-MIME blob |
| **Mural** | ✅ | ✅ native stickies, diagrams | `mly://` base64 JSON in HTML clipboard |
| **Figma** | ✅ | | selection metadata |
| **Outlook / Teams / Docs** | | ✅ | HTML-Format clipboard |
| **DevTools console** | ✅ 99%+ noise reduction | | plain text |

## Install

```bash
git clone https://github.com/TheJesper/cliplens
cd cliplens
npm install
npm link          # global CLI aliases
```

## CLI

| Command | What |
|---------|------|
| `cliplens capture / inspect / diff` | Capture & explore raw clipboard formats |
| `clipit` | Markdown → Slack rich text on the clipboard |
| `clipmail` | Markdown → HTML (Outlook / Teams / Docs) |
| `clipconsole` | Read a pasted DevTools console dump, strip the noise (keep CORS / HTTP / `net::ERR_`) |
| `clipmural` | Write native Mural stickies / diagrams |
| `reclip` | Replay clipboard history |

## MCP server (agents)

ClipLens ships an MCP server so agents (Claude Code, Kiro, …) can read/write the clipboard as tools.

```json
{
  "mcpServers": {
    "cliplens": { "command": "node", "args": ["<path-to>/cliplens/src/mcp-server.js"] }
  }
}
```

Tools: `cliplens_analyze` · `_text` · `_capture` · `_formats` · `_inspect` · `_save_image` · `_write_slack`
· `_write_plaintext` · `_lens`. Generated text runs through `humanize()` (strips em-dashes, curly quotes,
zero-width spaces, BOM — the tells that a machine wrote it).

## Private adapters (keep company stuff out of the public repo)

ClipLens ships **only generic, public** lenses & pens. Anything org-specific — an internal tool's format, a
proprietary board, a company log filter — goes in **gitignored** folders so it can never leak upstream:

```
private-lenses/   ← your read adapters   (gitignored)
private-pens/     ← your write adapters  (gitignored)
```

Drop a `.js` file exporting the lens/pen shape (see [`examples/`](examples/)); it's auto-discovered by
`src/private.js`. Nothing in those folders is ever committed. Fork the *core* freely; keep your *adapters* private.

## Platform

**Windows-first.** Clipboard I/O currently uses PowerShell + `System.Windows.Forms`. The encoding/decoding
logic is pure, cross-platform Node — only the small read/write shim needs porting.

> Developed on [Kiro](https://kiro.dev); works with Claude Code and any MCP agent.
> **Not yet validated on macOS or Linux** — if you're there, a clipboard shim PR would be hugely welcome. 🙏

## Roadmap — *being worked on as we speak*

- 🖥️ **Tray app** (`cliplens-toast/`, Rust) — native toast notifications + clipboard history overlay
- 🍎🐧 macOS / Linux clipboard shims
- More lenses & pens (Notion, Miro, Confluence…)

## Contributing

You *can* fork — but I'd genuinely rather build this **with** you. Open an issue or a PR and I'll happily
review it. See [CONTRIBUTING.md](CONTRIBUTING.md). This is open source (MIT) and meant to stay that way.

## License

[MIT](LICENSE) © Jesper Wilfing
