# Contributing to ClipLens

Thanks for being here. 🙌

You **can** fork this and run — it's MIT, that's the whole point. But honestly? I'd much rather build it
**with** you. This is a small, focused tool with a clear idea, and it gets better fastest when people bring
real adapters and real platforms to it.

## The easiest ways to help

- **You're on macOS or Linux?** The clipboard I/O shim (`src/clipboard.js`, `src/notify.js`) is the only
  Windows-specific part — everything else is pure Node. A porting PR would be gold. I'll happily review it.
- **You wrote a lens or a pen** for an app I don't have? Send it. If it's generic (no company internals),
  it belongs in `src/lenses/` or `src/pens/`. If it's org-specific, keep it in your own gitignored
  `private-lenses/` / `private-pens/` — see the README.
- **You found the clipboard format for another app?** Even just a `SPEC-*.md` documenting the wire format
  is a real contribution — the reverse-engineering is the hard part.
- **Bugs, rough edges, docs, naming** — all fair game. Open an issue and let's talk.

## How

1. Open an issue first for anything non-trivial, so we don't both build the same thing.
2. Fork, branch, PR. Small and focused beats big and sprawling.
3. Keep it dependency-light (right now: just `@modelcontextprotocol/sdk` + `ws`).
4. No company-specific / proprietary formats in the public repo — that's what `private-*` folders are for.

## Adapter shape

A **lens** exports pure functions that turn a clipboard payload into structured data (read-only). A **pen**
exports functions that turn structured input into a native clipboard format (write). See
[`examples/`](examples/) for copy-paste starting points.

No CLA, no ceremony. Be kind, keep it generic, and I'll review your PR with a smile.

— Jesper
