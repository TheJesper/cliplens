# ClipLens — Caveman pen (`clip caveman` / `clip agent` / `clip ai`)

An agent-aimed clip: write the payload in ultra-compressed **caveman** style, then put it on the
clipboard as **plaintext** (vanilla — caveman is plain text, pastes anywhere). Built for pasting
to ANOTHER AI AGENT, where every token is signal and politeness is waste.

## Why a pen can't do it alone (the key design point)

The slack/teams pens are mechanical markdown→rich-format converters. Caveman is NOT a format
conversion — it is a **linguistic rewrite** that only the agent (LLM) can do. So this is a
**skill rule**, not a code transform:

> When the user says `clip caveman` / `clip agent` / `clip ai` (or `/clip caveman`), the AGENT
> rewrites the content in caveman style, then calls `cliplens_write_plaintext` with that text.

No new MCP tool needed. The write stays `write_plaintext` (vanilla). Caveman shapes the TEXT the
agent passes in.

## Triggers

| User says | Do |
|-----------|-----|
| `clip caveman` · `/clip caveman` | caveman-rewrite → `write_plaintext` |
| `clip agent` · `clip ai` · `clip for the agent` | same — agent-aimed caveman |
| `clip` / `/clip` (no "caveman"/"agent") | normal vanilla plaintext (unchanged) |

## The style (best-of, merged)

Combine three house skills into one compact agent-handoff format:

1. **caveman** — compress the LANGUAGE: drop articles (a/an/the), filler
   (just/really/basically), pleasantries (sure/of course), hedging. Fragments OK. Short synonyms
   (big not extensive, fix not "implement a solution for"). Pattern: `[thing] [action] [reason]. [next].`
2. **datatext** — bot-attributed, FACTS only: events, IDs, versions, paths, counts, statuses. No
   voice, no greetings, no opinions. Lead with the fact.
3. **plaintext pen** — vanilla output, keyboard chars only, pastes cleanly into any agent chat.

### Non-negotiables (keep verbatim — never compress these)
Code, CLI commands, API names, function/symbol names, file paths, commit-type keywords
(feat/fix/...), exact error strings, IDs/versions. Caveman compresses PROSE around them, never the
technical tokens. (Same rule as the caveman skill.)

### Agent-handoff shape
Agent reader wants: what, where, state, next — fast. Suggested shape:

```
TASK: <one line what>
STATE: <done / failing / blocked> — <shortest decisive fact>
WHERE: <path:line or repo/branch>
FACTS:
- <id/version/count/status>
- <id/version/count/status>
NEXT: <the one action to take>
```

Drop any line that has no content. No preamble, no sign-off. First line = the point.

## Levels (inherit caveman intensity)
- `clip caveman lite` — no filler/hedging, keep articles + full sentences. For a human-ish reader.
- `clip caveman` / `full` (default) — classic caveman, drop articles, fragments.
- `clip caveman ultra` — abbreviate PROSE words only (DB/auth/config/req/res/fn/impl); never
  abbreviate code symbols, function names, API names, error strings.

## Auto-clarity (safety — from caveman skill)
Do NOT caveman-compress when it creates ambiguity: security warnings, irreversible-action
confirmations, or multi-step sequences where dropped conjunctions risk misread. Those lines stay
clear even inside a caveman clip.

## Example

User: "clip agent — tell the other agent where the build broke"

Agent rewrites, then `cliplens_write_plaintext`:
```
TASK: fix red build
STATE: failing — "cancelAnimationFrame is not defined" in vitest teardown
WHERE: src/hooks/useThing, build 16569
FACTS:
- flaky not systematic — rerun 16570 green
- introduced by a recent rAF debounce change
- test-framework attribution = red herring (misattributed teardown error)
NEXT: add rAF/cAF polyfill on globalThis in vitest.setup.js
```
Then tell the user: Ctrl+V to the agent.

## After writing
Standard ClipLens rule: tell the user to **Ctrl+V now** — the payload is live, next copy
overwrites it. Pass `agent` so /redo can recall it.
