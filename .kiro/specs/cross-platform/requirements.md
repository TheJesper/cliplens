# Requirements -- Cross-Platform ClipLens (Windows / macOS / Linux)

## Introduction

ClipLens is currently Windows-locked. Every clipboard read/write and the
notification overlay shell out to PowerShell + `System.Windows.Forms` / WPF.
The Rust `cliplens-daemon` (toast, picker, hotkey, IPC) is already
cross-platform by design, but the Node core is not.

This spec defines what "100% cross-platform" means for ClipLens and the
requirements to reach it, prioritised: **macOS = must, Windows = must (keep
working), Linux = should (GUI where feasible)**.

### Goal

A user on macOS or Linux can install ClipLens and use every documented feature
-- Slack rich-text clips, HTML/Outlook clips, image save, console lens, the
notification toast, clip history, and the Ctrl+§ picker -- with no Windows-only
code paths silently failing.

### Current platform-locked surface (from code audit)

| File | Windows-locked mechanism | Feature affected |
|------|--------------------------|------------------|
| `src/clipboard.js` | `powershell Get-Clipboard`, `System.Windows.Forms.Clipboard` | read text / list formats / capture format |
| `src/slack-clip.js` | PowerShell + `DataObject` custom MIME | Slack rich-text write |
| `src/html-clip.js` | PowerShell + `DataObject` HTML Format | Outlook/Teams HTML write |
| `src/mcp-server.js` (`cliplens_save_image`) | PowerShell + `System.Drawing` | clipboard image save |
| `src/notify.js` (`notifyWindows`) | WPF inline C# | fallback toast |
| `src/console-lens.js` | `Get-Clipboard -Raw` | console filtering input |
| `src/outlook-lens.js` | (assumed) clipboard read via PowerShell | Outlook mail parsing |

---

## Requirements

### Requirement 1 -- Platform abstraction layer for clipboard I/O

**User story:** As a developer, I want a single clipboard abstraction so that
feature code never calls PowerShell directly and each OS has one implementation.

#### Acceptance criteria

1. WHEN feature code needs clipboard text, formats, or a specific format, THEN it SHALL call a platform-neutral module (e.g. `src/platform/clipboard.js`) rather than spawning PowerShell inline.
2. WHEN running on Windows, THEN the abstraction SHALL preserve current behaviour (PowerShell/WinForms or a native binary).
3. WHEN running on macOS, THEN the abstraction SHALL use macOS-native mechanisms (`pbpaste`/`pbcopy`, `osascript`, or the Rust helper) for the same operations.
4. WHEN running on Linux, THEN the abstraction SHALL use `wl-copy`/`wl-paste` (Wayland) or `xclip`/`xsel` (X11), detected at runtime.
5. WHEN a required OS tool is missing, THEN the abstraction SHALL fail with a clear, actionable error naming the missing tool, and SHALL NOT crash the caller.
6. WHEN the platform is detected, THEN detection SHALL use `process.platform` plus capability probing (which tool exists), not hard-coded assumptions.

### Requirement 2 -- Cross-platform rich clipboard writes (Slack / HTML)

**User story:** As a user on any OS, I want Slack rich-text and HTML clips to
paste with formatting intact.

#### Acceptance criteria

1. WHEN writing a Slack clip on Windows, THEN the Chromium custom-MIME payload SHALL be written exactly as today.
2. WHEN writing a Slack clip on macOS, THEN the equivalent rich payload SHALL be placed on the pasteboard so Slack renders formatting (research spike required to confirm the macOS pasteboard type).
3. WHEN writing an HTML clip on macOS/Linux, THEN `text/html` SHALL be placed on the clipboard alongside a plain-text fallback.
4. IF a rich write cannot be achieved on a given OS, THEN ClipLens SHALL fall back to plain text AND inform the caller which fidelity was achieved.
5. WHEN any rich write completes, THEN a plain-text representation SHALL always also be present on the clipboard.

### Requirement 3 -- Cross-platform notification overlay (GUI)

**User story:** As a user, I want the same toast notification on macOS and Linux
as on Windows.

#### Acceptance criteria

1. WHEN a notification is shown, THEN it SHALL render via the Rust `cliplens-daemon` (tao + wry) on all three platforms.
2. WHEN the daemon renders a toast on macOS, THEN transparency, rounded corners, click-through, and color emoji (Apple Color Emoji) SHALL work.
3. WHEN the daemon renders a toast on Linux, THEN it SHALL work under Wayland or X11 where the WebKitGTK webview is available; IF unavailable, THEN ClipLens SHALL fall back to a native notification (`notify-send`).
4. WHEN no GUI/daemon is available, THEN `notify()` SHALL degrade to a console line and SHALL NOT throw.
5. WHEN emoji are rendered, THEN they SHALL use the system emoji font per OS with no bundled emoji assets.

### Requirement 4 -- Cross-platform global hotkey + clip picker

**User story:** As a user, I want Ctrl+§ to open the clip picker on macOS and
Linux too.

#### Acceptance criteria

1. WHEN the daemon runs on macOS, THEN the global hotkey SHALL register (subject to Accessibility permission) and open the picker.
2. IF macOS Accessibility permission is not granted, THEN the daemon SHALL detect this and surface a one-time actionable message.
3. WHEN the hotkey fires on any OS, THEN the picker SHALL read the same `~/.cliplens/history.json` and write the chosen clip via the OS clipboard.
4. WHEN the configured key is unavailable on a layout, THEN the hotkey SHALL be configurable (env or config file) with a documented default.

### Requirement 5 -- Cross-platform image + console clipboard reads

**User story:** As a user, I want "save clipboard image" and "console lens" to
work off-Windows.

#### Acceptance criteria

1. WHEN saving a clipboard image on macOS, THEN it SHALL use `pngpaste` or an `osascript`/Rust fallback; on Linux `wl-paste`/`xclip` targeting `image/png`.
2. WHEN no image is on the clipboard, THEN the tool SHALL return a clear "no image" result on every OS (as Windows does today).
3. WHEN the console lens reads the clipboard, THEN it SHALL use the Requirement-1 abstraction, not `Get-Clipboard`.

### Requirement 6 -- Build, install, and distribution without shipping EXEs

**User story:** As a maintainer, I want the Rust helper built locally per OS so
we never ship prebuilt binaries.

#### Acceptance criteria

1. WHEN a user installs ClipLens, THEN an install/build step SHALL build `cliplens-daemon` for the current OS IF a Rust toolchain is present.
2. IF no Rust toolchain is present, THEN ClipLens SHALL still run (clip features + native-notification fallback) and SHALL clearly report that the GUI daemon is unavailable.
3. WHEN the daemon binary is located, THEN lookup SHALL be OS-correct (`cliplens-daemon` vs `cliplens-daemon.exe`) and overridable via `CLIPLENS_TOAST_BIN`/`CLIPLENS_DAEMON_BIN`.
4. WHEN autostart is requested, THEN install SHALL use the OS-native mechanism (Startup / LaunchAgent / systemd user unit) AND SHALL require explicit user confirmation before modifying system state.

### Requirement 7 -- Verification across platforms

**User story:** As a maintainer, I want confidence each OS path works.

#### Acceptance criteria

1. WHEN the platform abstraction is implemented, THEN there SHALL be a capability self-test (`cliplens doctor`) reporting which clipboard/notification/hotkey backends are available on the current OS.
2. WHEN feature code is unit-tested, THEN OS-specific backends SHALL be mocked at the command boundary so tests run on any CI OS.
3. WHEN a platform lacks a capability, THEN `cliplens doctor` SHALL name the missing tool and the install command to fix it.

---

## Non-goals

- Mobile (iOS/Android).
- Shipping prebuilt/ signed binaries (explicitly rejected -- build locally).
- Bundling emoji or font assets.
- Reading the user's system Ctrl+C clipboard into history (security boundary:
  history stores ONLY agent-generated clips).

## Open questions (resolve during design)

1. macOS Slack pasteboard type for rich text -- does the Chromium custom MIME
   translate, or is a different NSPasteboard type needed? (spike)
2. Should clipboard I/O move entirely into the Rust `cliplens-daemon`
   (single cross-platform surface via `arboard`) instead of per-OS shell tools
   in Node? This could collapse Requirements 1, 2, and 5 into the daemon.
3. Linux target scope: Wayland-first, X11 fallback, or both required?
