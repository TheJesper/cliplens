# SPEC — ClipLens Notify: an agent-native notification surface

Status: APPROVED — decisions locked (see §10). Implementing P1-P5.
Author: main agent, 2026-08-27.
Scope: `cliplens-daemon` (Rust) + `cliplens_notify` MCP tool + global `notify` skill.

---

## 1. Vision

Agents run long tasks in the background: builds, reviews, deploys, polls. Today
the only way an agent tells the user "I'm done / I need you / it broke" is a line
of chat text the user must be looking at. That fails the moment the user tabs away.

**ClipLens Notify turns the desktop itself into the agent's output channel.**
A small, beautiful, glanceable card appears on the screen the user is actually
looking at, says one clear thing, and disappears. No focus steal, no click, no
sound unless asked.

Design north star: **a notification the user is glad to see, never annoyed by.**
Apple-toast calm, not Windows-balloon noise.

### Guiding principles

1. **Visual-first, sound opt-in.** The office is shared and quiet. The visual
   must carry 100% of the meaning. Sound is a bonus the user turns on per-call
   or per-session, never a default.
2. **Agent-native semantics, not raw styling.** Agents should say *what kind* of
   event this is (`success`, `blocked`, `progress`, `question`) and the daemon
   owns how that looks. One word of intent beats five style params.
3. **Glanceable in <500ms.** Emoji + one bold line + optional dim second line.
   If it needs reading, it's a chat message, not a toast.
4. **Never steals focus, never blocks.** Click-through, no taskbar entry, no
   alt-tab. Fire-and-forget from the caller's side.
5. **Right screen, right corner.** Appears on the monitor under the cursor
   (the screen the user is looking at). Multiple toasts stack, never overlap.
6. **Degrade gracefully.** Daemon down -> one-shot toast. No binary -> silent
   no-op (never crash the clip/agent op).

---

## 2. What exists today (grounding)

| Piece | State |
|-------|-------|
| `cliplens-daemon` (Rust, tao+wry) | Built. `--watch` (IPC + hotkey + picker), `--notify`, `--ping`, one-shot default |
| Toast card | HTML/CSS in `ui.rs`: emoji (wiggle anim), title, optional subtitle, dark rounded card, pop-in |
| IPC | `interprocess` local socket. `Message::{Notify,ShowPicker,Ping}`, one JSON/line |
| Positioning | Monitor under cursor (just fixed), work-area aware, `bottom`/`center`/`top-right`, stack offset |
| Sound | `play_sound()` — named -> `sounds/<name>.wav` beside binary, or file path, or `off`. No sounds shipped => silent by default |
| Node `notify.js` | `notify({message,agent})` legacy; `sendNotify({emoji,title,subtitle,sound,position,duration})` just added, talks to daemon `--notify` |
| MCP | No notify tool yet. Only `cliplens_write_slack` fires `notify()` internally |
| Skill | No notify skill. `~/.kiro/skills/*.md` flat files with frontmatter (name/description/triggers) |

Constraint: the card renders **plain text** in title/subtitle (HTML-escaped). No
markdown, no rich text inside the toast — keep it that way (glanceable).

---

## 3. The innovative bit — semantic presets (the "kind" field)

Instead of asking agents to pick emoji + color + duration every time, agents
declare **intent**. The daemon maps intent -> a coherent visual identity.

| kind | emoji | accent | default duration | default sound (opt-in) | when |
|------|-------|--------|------------------|------------------------|------|
| `success` | white_check_mark | green #30D158 | 2600ms | success | task done, build green, +2 given |
| `error` | x / rotating_light | red #FF453A | 4500ms (sticky-ish) | error | build broke, test failed |
| `warning` | warning | amber #FF9F0A | 3800ms | info | flaky, degraded, needs attention soon |
| `info` | information_source | blue #0A84FF | 2600ms | info | neutral status, FYI |
| `question` | speech_balloon | purple #BF5AF2 | 6000ms | info | agent is blocked, needs a human decision |
| `progress` | hourglass | blue #0A84FF | persistent* | none | long op running; updatable in place |
| `clip` | clipboard | graphite | 2200ms | none | a cliplens clip is ready (back-compat) |
| `celebrate` | tada / party_popper | rainbow gradient | 4200ms | celebrate | something big shipped: PR merged, release published, milestone done |

\* `progress` is special: it stays until updated or completed (see §5.3).

### `celebrate` — the fun one

For genuine wins (release published, epic closed, big review merged), plain
`success` feels flat. `celebrate` is the delightful variant:

- Emoji: party_popper, bouncing (not the calm wiggle) — a springy pop + settle.
- Accent: an animated multi-color gradient rail instead of a solid tint.
- A short **confetti burst**: ~14 small CSS particles fall/fade once on appear
  (pure CSS keyframes, no JS timer, no deps). Tasteful, ~900ms, then gone.
- Slightly longer duration (4200ms) so the moment lands.
- Default sound `celebrate` (still opt-in — visual carries it alone).

Use sparingly: celebrate real milestones, not every green build. Agents get
guidance in the skill ("`success` for routine done, `celebrate` for shipped").

Agents may still override `emoji`, `accent`, `duration` explicitly. `kind`
sets the defaults; explicit params win. This is the creative core: **one word
carries a whole design decision**, but power users keep full control.

### Accent usage in the card

Today the card is uniformly dark. Add a **thin accent rail** (4px) on the left
edge tinted by `kind`, plus the emoji glow uses the accent color. Subtle, not
loud — the card stays dark/calm, the accent just gives instant category read.

---

## 4. MCP surface — `cliplens_notify`

Single tool, semantic-first, everything optional except `title`.

```jsonc
{
  "name": "cliplens_notify",
  "description": "Show a desktop notification card on the user's active screen. VISUAL-FIRST: the card alone conveys the message; sound is OFF unless the user opted in. Use to tell the user something when they may not be watching chat: task done, build broke, you're blocked and need a decision, or a long op finished. Prefer the `kind` field (success|error|warning|info|question|progress|clip) over manual styling — it sets emoji, color, and duration. Keep title short (<40 chars) and subtitle to one glanceable line. Fire-and-forget: returns immediately.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "title":    { "type": "string", "description": "Main line. Short, glanceable. <40 chars ideal." },
      "subtitle": { "type": "string", "description": "Optional second line, dim. One line, shown verbatim." },
      "agent":    { "type": "string", "description": "Sending agent name (e.g. 'pp', 'main', 'review'). ALWAYS set it — shown as a small badge so the user sees who is talking. Defaults to the MCP client name if omitted." },
      "kind":     { "type": "string", "enum": ["success","error","warning","info","question","progress","clip","celebrate"],
                    "description": "Semantic intent. Sets emoji/color/duration defaults. Default: info." },
      "emoji":    { "type": "string", "description": "Override the kind's emoji. Single glyph." },
      "sound":    { "type": "string", "description": "Opt-in sound: 'success'|'error'|'info', a .wav/.mp3 path, or 'off'. Default 'off' (visual-only)." },
      "position": { "type": "string", "enum": ["bottom","center","top-right","top-left","bottom-left","bottom-right"], "description": "Screen anchor. Default bottom." },
      "size":     { "type": "string", "enum": ["small","normal","large"], "description": "Card size preset. small = compact (clip default), normal = standard toast, large = roomy for longer text. Default depends on kind (clip=small, others=normal)." },
      "width":    { "type": "number", "description": "Explicit card width in px. Overrides `size` width. Clamped 260-720." },
      "height":   { "type": "number", "description": "Explicit card height in px. Overrides `size` height. Clamped 72-320." },
      "scale":    { "type": "number", "description": "Uniform scale multiplier for the whole card (emoji + text + padding). 0.8-1.6. Default 1.0. Handy on hi-DPI or for a bigger celebrate moment." },
      "offset":   { "type": "string", "description": "Nudge from the anchor as 'x,y' px (e.g. '0,-40' = 40px up). Lets agents fine-tune placement without abandoning the anchor." },
      "duration": { "type": "number", "description": "Milliseconds on screen. Overrides the kind default." },
      "id":       { "type": "string", "description": "Stable id for progress/update: re-notifying with same id updates the existing card in place instead of stacking." }
    },
    "required": ["title"]
  }
}
```

Return: `{ ok: true, delivered: "daemon" | "oneshot" | "noop" }` so the agent
knows whether it actually surfaced. Never throws.

### Why one tool, not many

Rejected `cliplens_notify_success` / `_error` etc. — tool sprawl confuses agents
(we already learned this: `write_slack` vs `write_plaintext` naming fight, see
AGENTS.md decisions log). One tool + `kind` enum keeps discovery clean and lets
the model reason about intent.

---

## 5. Daemon protocol changes

### 5.1 NotifyRequest additions (`ipc.rs`)

```rust
pub struct NotifyRequest {
    pub emoji: String,
    pub title: String,
    pub subtitle: String,     // shown VERBATIM (fix current --agent "fran X" behavior)
    pub sound: String,        // "off" default
    pub duration: u64,
    pub position: String,
    pub kind: String,         // NEW: semantic preset key, default "info"
    pub accent: String,       // NEW: override hex; empty => derive from kind
    pub id: String,           // NEW: stable id for in-place update; empty => new card
    pub agent: String,        // NEW: sending agent, always shown as a small badge
    pub size: String,         // NEW: "small"|"normal"|"large"; empty => derive from kind
    pub width: f64,           // NEW: explicit px width, 0 => from size (clamped 260-720)
    pub height: f64,          // NEW: explicit px height, 0 => from size (clamped 72-320)
    pub scale: f64,           // NEW: uniform card scale 0.8-1.6, 0/absent => 1.0
    pub offset: String,       // NEW: "x,y" px nudge from the anchor; empty => "0,0"
}
```

Back-compat: `--agent X` still works but its meaning changes to "the sender
badge" (verbatim name), not the old "fran X-agent" subtitle munging. MCP and
`sendNotify` set `--agent` + `--subtitle` independently.

### Sender badge (always visible)

Every card shows a small, dim **agent badge** in the top-right corner of the
card (e.g. `pp`, `main`, `review`). Rationale: with many agents notifying, the
user must instantly know *who* is talking. Styled like the picker's format
badge — uppercase, tiny, low-contrast pill — so it informs without competing
with the title. If `agent` is empty, fall back to the MCP client id; if that's
unknown, hide the badge rather than show a placeholder.

### 5.2 kind -> visuals resolution

A pure function `resolve_kind(kind, emoji_override, accent_override, duration_override)`
in a new `preset.rs`, returning `(emoji, accent_hex, duration_ms, default_sound)`.
Table from §3 (including `celebrate`). Unit-testable in isolation
(pragmatic-testing: pure logic, no I/O).

### 5.3 Progress / update-in-place (the standout feature)

`id` lets an agent show a live status that mutates rather than spamming N toasts:

```
notify id=build kind=progress title="Building to-common..."      -> card appears
notify id=build kind=progress title="Building to-common..." subtitle="3/5 packages"  -> same card updates
notify id=build kind=success  title="Build green" subtitle="4.1.10"   -> card morphs to success, then auto-dismisses
```

Daemon keeps `active: Vec<ActiveToast>` (already does). Add `id` to `ActiveToast`.
On Notify: if `id` non-empty and a live toast has it, `load_html()` new content +
reset timer + (if now non-progress) restore normal expiry. Else spawn new.

This is genuinely useful for our world: build polls, testbot monitors, deploy
waits — one calm card that ticks along instead of a stack of noise.

### 5.4 Card visual upgrades (`ui.rs`)

- Left accent rail 4px, color = accent. For `celebrate`, an animated multi-color
  gradient rail.
- Emoji glow tinted by accent (`drop-shadow` uses accent at low alpha).
- **Sender badge**: small dim uppercase pill, top-right of the card, from `agent`.
- `progress` kind: swap the wiggle for a slow pulsing hourglass + a thin
  indeterminate shimmer bar along the bottom edge (CSS only, no JS timer).
- `celebrate` kind: springy pop on the emoji + a one-shot CSS confetti burst
  (~14 particles, ~900ms) that fades out and never loops.
- Keep everything CSS/HTML; no new deps.

### 5.5 Layout control (size / position / scale / offset)

Agents can tune placement and size per call. The **small clip card keeps its
current look** — nothing changes unless a caller opts in.

**Size presets** (window px, before `scale`):

| size | width x height | use |
|------|----------------|-----|
| `small` | 360 x 84 | compact — the clip default |
| `normal` | 440 x 96 | standard toast (current default for non-clip) |
| `large` | 560 x 132 | roomy for longer subtitle / celebrate moment |

Resolution order for the final window box:
1. Start from `size` preset. If `size` empty -> derive from `kind`
   (`clip` -> small, `celebrate` -> large, else normal).
2. If `width`/`height` given, they override the preset dimension (each clamped:
   width 260-720, height 72-320).
3. Apply `scale` (0.8-1.6, default 1.0) uniformly to the window box **and** the
   card's font/padding via a CSS `--scale` var, so text grows with the card
   instead of just stretching whitespace.

**Position** gains four corner anchors (`top-left`, `top-right`, `bottom-left`,
`bottom-right`) plus existing `bottom`/`center`. `position_window` already
computes the monitor work-area rect; extend the match to all six anchors with a
consistent 24px screen margin.

**Offset** `"x,y"` nudges from the anchor (parsed to two f64; malformed -> 0,0),
applied after anchor placement, before stacking offset. Lets an agent fine-tune
("bottom, but 40px higher to clear a HUD") without abandoning the anchor logic.

**Defaults unchanged for existing callers**: `notify({message})` -> `kind:clip`
-> small, bottom, scale 1.0 — identical to today. All new fields are additive
and optional.

Implementation note: `ui.rs` card CSS switches hard-coded px to `calc()` off a
`--scale` custom property so one multiplier drives emoji size, title/subtitle
size, gaps, and padding coherently.

---

## 6. Node integration (`notify.js`)

- `sendNotify()` (added) gains `kind`, `accent`, `id` passthrough.
- Existing `notify({message})` stays as a thin wrapper -> `sendNotify({kind:'clip', title:message})`.
- MCP `cliplens_write_slack` keeps notifying, now as `kind:'clip'`.

## 7. Skill — `~/.kiro/skills/notify.md` (global)

Frontmatter triggers: `/notify`, "notify me", "tell me when done", "ping me",
"let me know", "desktop notification", "toast".

Content teaches agents:
- **Visual-first rule**: never rely on sound; the card must stand alone.
- **Always set `agent`**: so the user sees who is notifying (badge).
- **Pick a `kind`** — table of when to use each.
- **`success` vs `celebrate`**: routine done -> `success`; something shipped
  (release published, PR merged, epic closed, milestone) -> `celebrate`. Use
  `celebrate` sparingly so it stays special.
- **When to notify**: end of long op, blocked-needs-decision, error the user
  should see now. NOT for every micro-step (mirrors work-report "log outcomes").
- **Progress pattern**: reuse `id` for live status.
- **Keep it short**: title <40 chars, one subtitle line.
- **Sound is opt-in**: only pass `sound` if the user said they want audio.

## 8. Non-goals

- No markdown/rich text inside the toast (glanceability).
- No notification center / history of past toasts (the clip picker is separate).
- No actionable buttons (click-through by design; questions are answered in chat).
- No cross-network / remote notify (local desktop only).

## 9. Phasing

| Phase | Deliverable | Verify |
|-------|-------------|--------|
| P1 | `ipc.rs` fields + `preset.rs` + `resolve_kind` unit tests | `cargo test` |
| P2 | `ui.rs` accent rail + kind emoji/glow + sender badge + `--scale` CSS; layout resolution (size/width/height/scale/offset/6 anchors) in `main.rs` | visual: send each kind + size/position variants |
| P3 | `cliplens_notify` MCP tool (with `agent`) + `sendNotify` kind/id/agent; autoApprove | call tool, see card + badge |
| P4 | Progress/update-in-place (`id`) + `celebrate` confetti | send progress then success same id; send celebrate |
| P5 | Global `notify.md` skill | skill loads, triggers match |

## 10. Open questions for reviewer — RESOLVED

All locked with the leaning answer:

1. **Screen policy**: monitor under cursor (as now). `CLIPLENS_MONITOR` env
   override deferred to a later phase.
2. **`question` kind**: 6s, not persistent.
3. **Accent**: thin 4px rail (calm), not full-card tint.
4. **Sound presets**: ship 3 tiny WAVs (`success`/`error`/`celebrate`) in
   `cliplens-toast/sounds/` so opt-in sound works out of the box. `info`/`warning`
   reuse `success`. Still opt-in.
5. **`progress` auto-timeout**: 90s hard cap so a forgotten card self-dismisses.
6. **`celebrate` confetti**: subtle ~14 particles, one burst. `celebrate` is
   always explicit, never an implicit default.
7. **Sender badge source**: `agent` param -> `CLIPLENS_AGENT` env -> hidden.
8. **Size clamps**: width 260-720, height 72-320, scale 0.8-1.6.


---

## 11. SPEC ADDITION — Pinned / docked notes (P6)

Status: PROPOSED (not yet approved). Author: aicore assistant, 2026-08-31.
Requested by a user: "man kan PIN:a notes .. då tar den del av hojden, inte bara
overlay .. precis som chatten kan pinnas."

### 11.1 The idea

Today every notify is an **overlay**: floats on top, click-through, auto-dismiss,
no taskbar entry. Add a second mode — **pinned/docked** — where the card stops
being a transient toast and becomes a persistent panel that **reserves screen
height** (or width), so maximized windows resize *around* it instead of being
covered. Same mental model as docking a chat panel.

This is not just "keep the toast on screen longer". A persistent overlay still
sits *on top of* other windows. A **docked** panel takes real estate away from
the desktop work-area, so nothing important ends up hidden behind it.

### 11.2 Overlay vs pinned — the two modes

| Aspect | Overlay (today, default) | Pinned / docked (new) |
|--------|--------------------------|------------------------|
| Lifetime | auto-dismiss (kind duration) | persistent until unpinned |
| Screen space | drawn on top, steals nothing | **reserves** a strip of the work-area |
| Other windows | can be covered | resize around the reserved strip |
| Focus | click-through | interactable (pin/unpin, close) |
| Placement | 6 corner/edge anchors | docked to one edge: top/bottom/left/right |
| Taskbar | none | none (still a tool surface, not an app) |
| Mechanism | move a borderless window | OS **AppBar** reservation |

Everything in §1-§10 stays the default. Pinning is opt-in and additive.

### 11.3 Mechanism — real work-area reservation (the hard part)

Floating a window is trivial (already done). *Reserving* work-area so maximized
apps shrink is an OS-level operation:

- **Windows**: `SHAppBarMessage` (shell32) — register the window as an AppBar.
  - `ABM_NEW` on pin (register).
  - `ABM_QUERYPOS` + `ABM_SETPOS` to claim an edge rect (top/bottom/left/right).
  - Re-assert on `ABN_POSCHANGED` (another appbar/taskbar moved).
  - `ABM_REMOVE` on unpin / daemon exit — **must** run or the desktop keeps a
    dead reserved strip. Register a cleanup on all exit paths + panic hook.
  - This is the same API the Windows taskbar and docked side-panels use, so it
    is the correct, non-hacky path. Needs `windows`/`winapi` crate FFI; tao's
    raw HWND is reachable via `raw_window_handle`.
- **Non-Windows**: out of scope for P6 (dev machines are Windows). On mac/Linux,
  `pinned` gracefully degrades to a persistent overlay (no reservation) so the
  call never fails — matches the "degrade gracefully" principle (§1.6).

Degrade rule: if AppBar registration fails for any reason, fall back to a
persistent, always-on-top overlay and report `delivered: "oneshot"` semantics
(pinned-but-not-reserved). Never crash, never leave a dead strip.

### 11.4 Card changes when pinned

- A small **pin toggle** (thumbtack) appears top-right, next to the sender badge.
  Click toggles pinned <-> overlay. Pinned state = filled pin, overlay = outline.
- A **close (x)** appears only when pinned (overlay dismisses itself; pinned must
  be dismissable by hand).
- No auto-dismiss timer while pinned. `duration` is ignored in pinned mode.
- Docked to a full edge, the card stretches along that edge (full width for
  top/bottom, full height for left/right) rather than the compact toast box.
  Thickness governed by `reserve` (px) — default from `size` (small 84 / normal
  96 / large 132), clamped 48-400.
- `progress` + pinned is the killer combo: a live build/deploy/testbot strip
  docked at the bottom that ticks along and never covers your editor.

### 11.5 MCP surface additions

Add to `cliplens_notify` inputSchema (all optional, additive):

```jsonc
{
  "pinned":  { "type": "boolean", "description": "Dock the card as a persistent panel that reserves screen space (work-area shrinks around it), instead of a floating auto-dismiss overlay. Default false." },
  "dock":    { "type": "string", "enum": ["top","bottom","left","right"], "description": "Which screen edge to dock to when pinned. Default 'bottom'. Ignored when pinned=false." },
  "reserve": { "type": "number", "description": "Thickness in px of the reserved strip when pinned (height for top/bottom, width for left/right). Clamped 48-400. Default derives from size." }
}
```

`id` (already spec'd) pairs naturally: pin once, then update-in-place by id.
Unpin/close is user-driven from the card; an agent can also send
`pinned:false` with the same `id` to programmatically undock.

Return gains a mode marker: `{ ok, delivered, pinned: true|false }`.

### 11.6 Daemon protocol additions (`ipc.rs`)

```rust
pub struct NotifyRequest {
    // ... existing fields ...
    pub pinned: bool,     // NEW: dock as reserved panel; default false
    pub dock: String,     // NEW: "top"|"bottom"|"left"|"right"; empty => "bottom"
    pub reserve: f64,     // NEW: strip thickness px; 0 => derive from size (clamp 48-400)
}
```

`ActiveToast` gains `pinned: bool` + an `appbar: Option<AppBarHandle>` so unpin/
exit can `ABM_REMOVE` the right registration. Pinned cards are excluded from the
auto-dismiss sweep and from the overlay stacking offset (a docked panel is not
part of the toast stack).

### 11.7 Phasing (extends §9)

| Phase | Deliverable | Verify |
|-------|-------------|--------|
| P6a | `pinned`/`dock`/`reserve` fields end-to-end (ipc + node + MCP), pinned = persistent always-on-top overlay (no reservation yet) | send pinned=true, card stays until closed |
| P6b | Windows AppBar reservation (`ABM_NEW/QUERYPOS/SETPOS/REMOVE`), edge docking, cleanup on all exit paths | maximize an app -> it resizes around the docked strip; unpin -> space returns |
| P6c | Pin toggle + close button UI, pinned progress strip | click pin/unpin; dock a progress card at bottom |

### 11.8 Open questions for reviewer (P6)

1. **Multi-monitor dock**: dock on the monitor under cursor at pin time, or a
   fixed primary? Leaning: monitor under cursor (consistent with §10.1), locked
   at pin time (don't chase the cursor once docked).
2. **Reserve vs overlap on failure**: on AppBar failure, persistent overlay (as
   proposed) or refuse + report? Leaning: overlay fallback (graceful > strict).
3. **Max reserve**: 400px cap enough, or allow larger for a real side-panel use?
   Leaning: 400 for P6, revisit if a genuine panel use appears.
4. **Auto-unpin safety**: if daemon dies without ABM_REMOVE, the strip lingers
   until next daemon start. Add a startup sweep that clears stale cliplens
   appbars? Leaning: yes — self-heal on `--watch` start.
5. **Interaction with 6 anchors**: pinned ignores anchors (uses `dock` edge). Is
   that clear enough, or should `dock` reuse the `position` field? Leaning: keep
   separate — `position` = overlay anchor, `dock` = pinned edge, different axes.
