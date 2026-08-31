# Spec: Multiclip Support

## Problem

User copies something, asks agent to process it, but then copies something else before the agent reads the clipboard. The original clip is lost.

Current flow (broken):
```
1. User copies image      -> clipboard = image
2. User asks agent "analyze my clip"
3. User copies text       -> clipboard = text (image lost!)
4. Agent reads clipboard  -> gets text, not image
```

## Solution: Clip History Ring

ClipLens maintains a local ring buffer of recent clipboard snapshots. When the agent requests the clip, it can reference a specific point in time rather than "whatever is on the clipboard right now".

Desired flow:
```
1. User copies image      -> ring[0] = image (timestamp: 14:30:01)
2. User asks agent "analyze my clip" (message timestamp: 14:30:05)
3. User copies text       -> ring[1] = text (timestamp: 14:30:08)
4. Agent calls cliplens   -> gets ring[0] (most recent BEFORE 14:30:05)
```

## Architecture

### Clip Watcher (background process)

A lightweight process that monitors the clipboard for changes and snapshots each new clip.

```
cliplens-watch              # starts watcher (background)
cliplens-watch --stop       # stops watcher
cliplens-watch --status     # shows ring state
```

**Storage:** `tmp/clip-ring/` directory with numbered JSON files:
```
tmp/clip-ring/
  ring-meta.json            # { head: 3, size: 10, entries: [...] }
  0.json                    # { timestamp, formats[], textPreview }
  0.bin                     # binary data (images, custom MIME)
  1.json
  1.bin
  ...
```

### Ring Buffer Config

| Setting | Default | Env var |
|---------|---------|---------|
| Max entries | 10 | CLIPLENS_RING_SIZE |
| Max size per entry | 10MB | CLIPLENS_RING_MAX_ENTRY |
| Poll interval | 500ms | CLIPLENS_RING_POLL_MS |
| Storage path | `<script>/tmp/clip-ring/` | CLIPLENS_RING_PATH |

### MCP Tools (new)

| Tool | Description |
|------|-------------|
| `cliplens_history` | List recent clips (timestamp, format, preview) |
| `cliplens_recall` | Get a specific clip by index or timestamp |
| `cliplens_pin` | Pin current clip so it survives ring rotation |

### API: cliplens_recall

```json
{
  "before": "2026-08-21T14:30:05Z",
  "index": null,
  "format": "auto"
}
```

- `before` -- return most recent clip BEFORE this timestamp
- `index` -- explicit ring index (0 = most recent)
- `format` -- which format to return (auto/text/html/image/raw)

If `before` is provided, the tool scans the ring backwards and returns the first entry with `timestamp < before`.

### Watcher Detection

The watcher polls clipboard every 500ms using a hash of available formats + text content. On change:

1. Snapshot all formats (text + binary)
2. Write to next ring slot
3. Update ring-meta.json
4. Overwrite oldest entry when ring is full

### Integration with Existing Tools

- `cliplens_text` / `cliplens_analyze` -- unchanged default behavior (reads CURRENT clipboard)
- Add optional `{ before: timestamp }` param to existing tools as sugar
- `cliplens_save_image` -- can accept `{ before }` to save an older image from ring

## Edge Cases

| Case | Behavior |
|------|----------|
| Watcher not running | Fall back to current clipboard (existing behavior) |
| Ring empty | Fall back to current clipboard |
| Image too large | Store metadata only, re-read from clipboard if still there |
| Rapid copies (< poll interval) | Some clips may be missed; acceptable |
| Agent timestamp unknown | Use "most recent" (index 0) |

## Implementation Order

1. `src/clip-watcher.js` -- background poller + ring writer
2. `src/clip-ring.js` -- ring buffer read/write logic (shared module)
3. MCP tools: `cliplens_history`, `cliplens_recall`, `cliplens_pin`
4. `bin: cliplens-watch` alias in package.json
5. Optional param `before` on existing tools

## Non-Goals (v1)

- No cross-device sync
- No encryption of ring data
- No indefinite history (ring overwrites oldest)
- No Windows clipboard listener API (too complex; polling is fine for v1)
- No macOS support yet (watcher uses same clipboard.js which is Windows-only)

## Future (v2)

- Windows clipboard listener (SetClipboardViewer) for instant detection
- macOS pbpaste watcher
- Semantic dedup (don't store if content is identical to previous)
- Agent auto-injects `before` timestamp from user message time
