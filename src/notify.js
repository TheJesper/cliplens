/**
 * notify.js -- Non-blocking clipboard notification overlay.
 *
 * Windows: WPF overlay with true transparency, color emoji, fade animation.
 * Other: console fallback.
 *
 * Environment:
 *   CLIPLENS_EMOJI  -- emoji character to show (default: clipboard U+1F4CB)
 *   CLIPLENS_ICON   -- path to .ico/.png (rendered as WPF Image instead of emoji)
 *   CLIPLENS_SOUND  -- path to .mp3/.wav, or "off" to disable
 */
import { spawn, spawnSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir, homedir } from 'os';
import { fileURLToPath } from 'url';
import { psq } from './ps.js';
import { writeTmp, rmTmp } from './tmp.js';

const IS_WIN = process.platform === 'win32';
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Find a sound file in the sounds/ subfolder next to this script.
 * Returns first .mp3 or .wav found, or null.
 */
function findDefaultSound() {
  const soundsDir = join(__dirname, 'sounds');
  if (!existsSync(soundsDir)) return null;
  try {
    const files = readdirSync(soundsDir);
    const match = files.find(f => /\.(mp3|wav)$/i.test(f));
    return match ? join(soundsDir, match) : null;
  } catch {
    return null;
  }
}

/**
 * Show a brief notification that a clip is ready.
 * Fire-and-forget -- never throws, never blocks.
 *
 * @param {object} [opts]
 * @param {string} [opts.icon]    - Path to icon file (.ico/.png). Falls back to CLIPLENS_ICON env.
 * @param {boolean} [opts.sound]  - Play notification sound. Default true.
 * @param {string} [opts.message] - Toast title / tooltip text. Default 'Clip ready'.
 * @param {string} [opts.agent]   - Sending agent name, shown as the toast subtitle. Default 'cliplens'.
 */
export function notify({ icon, sound = 'success', message = 'Clip ready', agent = 'cliplens' } = {}) {
  try {
    // Preferred path: the cross-platform cliplens-toast binary (tao + wry).
    // Built locally (not bundled) -- if absent we fall back to the OS-native path.
    const bin = findToastBinary();
    if (bin) {
      // Route legacy notify through the semantic path as a "clip" card.
      // Pass sound through so the CLI pens (clipit/clipmail) are audible too;
      // a named sound ('success') or 'off' both work. `true` maps to 'success'.
      const snd = sound === true ? 'success' : (sound === false ? 'off' : sound);
      sendNotify({ kind: 'clip', title: message, agent, sound: snd });
      return;
    }
    if (IS_WIN) {
      notifyNativeToast('ClipLens', message);
    } else {
      // No binary and not Windows -- last resort console line.
      console.log(`clip done: ${message}`);
    }
  } catch {
    // Notification failure must never break the clip operation.
  }
}

/**
 * Locate the cliplens-daemon binary if it has been built locally.
 * Search order: CLIPLENS_TOAST_BIN env, the new cliplens-daemon output, then
 * the legacy cliplens-toast name for backward compatibility.
 * Returns an absolute path or null.
 */
function findToastBinary() {
  const daemonExe = IS_WIN ? 'cliplens-daemon.exe' : 'cliplens-daemon';
  const legacyExe = IS_WIN ? 'cliplens-toast.exe' : 'cliplens-toast';
  const candidates = [
    process.env.CLIPLENS_TOAST_BIN,
    join(__dirname, '..', 'cliplens-toast', 'target', 'release', daemonExe),
    join(__dirname, '..', 'cliplens-toast', 'target', 'debug', daemonExe),
    join(__dirname, '..', 'cliplens-toast', 'target', 'release', legacyExe),
    join(__dirname, '..', 'cliplens-toast', 'target', 'debug', legacyExe),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p;
    } catch {
      // ignore
    }
  }
  return null;
}

/**
 * Send a fully-specified notification (emoji + title + subtitle + sound).
 * Fire-and-forget. Prefers a running daemon (--notify), which falls back to a
 * one-shot toast on its own if no daemon is up.
 *
 * Visual-first: sound is OFF unless explicitly requested. On a shared/quiet
 * office machine the visual toast is enough; pass sound to opt in.
 *
 * Visual-first: sound is OFF unless explicitly requested. On a shared/quiet
 * office machine the visual toast is enough; pass sound to opt in.
 *
 * @param {object} opts
 * @param {string} [opts.title]    - Main line.
 * @param {string} [opts.subtitle] - Secondary line (shown verbatim).
 * @param {string} [opts.agent]    - Sender badge (verbatim). Falls back to CLIPLENS_AGENT env.
 * @param {string} [opts.kind]     - success|error|warning|info|question|progress|clip|celebrate.
 * @param {string} [opts.emoji]    - Override the kind's emoji.
 * @param {string} [opts.accent]   - Override accent hex (e.g. "#30D158").
 * @param {string} [opts.sound]    - "success"|"error"|"celebrate"|"off"|file path. Default "off".
 * @param {string} [opts.position] - bottom|center|top-left|top-right|bottom-left|bottom-right.
 * @param {string} [opts.size]     - small|normal|large.
 * @param {number} [opts.width]    - Explicit px width (clamped 260-720).
 * @param {number} [opts.height]   - Explicit px height (clamped 72-320).
 * @param {number} [opts.scale]    - Uniform scale 0.8-1.6.
 * @param {string} [opts.offset]   - "x,y" px nudge from the anchor.
 * @param {number} [opts.duration] - Milliseconds on screen (overrides kind default).
 * @param {string} [opts.id]       - Stable id: re-notify with same id updates the card in place.
 * @param {boolean} [opts.sticky]  - No auto-close; closes on click or click outside (or CLIPLENS_STICKY=1).
 * @param {string} [opts.keys]     - Shortcut hint shown as discreet keycaps bottom-right (e.g. "Ctrl+V").
 * @returns {"daemon"|"oneshot"|"noop"} how the notification was delivered.
 */
export function sendNotify({
  title = 'Clip ready',
  subtitle = '',
  agent,
  kind,
  emoji,
  accent,
  format = '',
  sound = 'off',
  position,
  size,
  width,
  height,
  scale,
  offset,
  duration,
  id,
  sticky,
  keys,
} = {}) {
  // A parent process that already shows the popup (the MCP server runs the pen scripts as
  // children) sets CLIPLENS_NO_TOAST=1 so one clip never produces two popups.
  if (process.env.CLIPLENS_NO_TOAST === '1') return 'noop';
  try {
    const bin = findToastBinary();
    if (!bin) {
      // No daemon built -> reliable native Windows toast (still works everywhere on Win10/11).
      if (IS_WIN) { notifyNativeToast(title || 'ClipLens', subtitle || (agent ? `via ${agent}` : 'Ctrl+V')); return 'oneshot'; }
      console.log(`notify: ${title}${subtitle ? ' — ' + subtitle : ''}`);
      return 'noop';
    }
    const args = ['--notify', '--title', String(title)];
    const push = (flag, val) => {
      if (val !== undefined && val !== null && String(val) !== '') {
        args.push(flag, String(val));
      }
    };
    push('--subtitle', subtitle);
    push('--agent', agent || process.env.CLIPLENS_AGENT);
    push('--kind', kind);
    push('--type', format);
    push('--emoji', emoji || process.env.CLIPLENS_EMOJI);
    push('--accent', accent);
    args.push('--sound', String(sound ?? 'off'));
    push('--position', position || process.env.CLIPLENS_POSITION);
    push('--size', size);
    if (Number(width) > 0) push('--width', Number(width));
    if (Number(height) > 0) push('--height', Number(height));
    if (Number(scale) > 0) push('--scale', Number(scale));
    push('--offset', offset);
    if (Number(duration) > 0) push('--duration', Number(duration));
    push('--id', id);
    // Sticky = no auto-close; closes on click or click outside. Per call, or CLIPLENS_STICKY=1.
    if (sticky === true || process.env.CLIPLENS_STICKY === '1') args.push('--sticky');
    push('--keys', keys);

    const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
    child.unref();
    // --notify tries the running daemon first and falls back to a one-shot
    // toast itself, so from here it is always "delivered" via the binary.
    return 'daemon';
  } catch {
    // Notification failure must never break the caller.
    return 'noop';
  }
}

/**
 * Reliable Windows notification via the native Windows.UI.Notifications toast (Win10/11).
 * Zero dependencies, nothing to build — this is the dependable fallback when the daemon isn't running.
 * Fire-and-forget; never throws to the caller.
 */
function notifyNativeToast(title = 'ClipLens', message = 'Clip ready') {
  try {
    const esc = psq; // all five quote characters, not just ASCII '
    const ps = `$ErrorActionPreference='SilentlyContinue'
$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$x = $t.GetElementsByTagName('text')
$null = $x.Item(0).AppendChild($t.CreateTextNode('${esc(title)}'))
$null = $x.Item(1).AppendChild($t.CreateTextNode('${esc(message)}'))
$toast = [Windows.UI.Notifications.ToastNotification]::new($t)
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)`;
    // UTF-8 BOM so PowerShell reads emoji/Unicode correctly.
    const psFile = writeTmp('﻿' + ps, '.ps1'); // random name, owner-only
    const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', psFile], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
    setTimeout(() => rmTmp(psFile), 8000).unref?.();
  } catch {
    // notifications must never break the caller
  }
}

function notifyWindows({ icon, sound, message }) {
  const iconPath = icon || process.env.CLIPLENS_ICON || null;
  const soundEnv = process.env.CLIPLENS_SOUND || null;
  const soundDisabled = !sound || soundEnv === 'off';

  // Resolve sound file
  let soundFile = null;
  if (!soundDisabled) {
    if (soundEnv && soundEnv !== 'off' && existsSync(soundEnv)) {
      soundFile = soundEnv;
    } else {
      soundFile = findDefaultSound();
    }
  }

  const emoji = process.env.CLIPLENS_EMOJI || '\u{1F4CB}';
  const position = process.env.CLIPLENS_POSITION || 'bottom'; // 'bottom' | 'center'

  // Build the inner content: either custom icon Image or emoji TextBlock, plus a label.
  let iconXaml;
  if (iconPath && existsSync(iconPath)) {
    const escaped = iconPath.replace(/\\/g, '\\\\').replace(/'/g, "''");
    iconXaml = `<Image Source="${escaped}" Stretch="Uniform" Width="34" Height="34" VerticalAlignment="Center" />`;
  } else {
    const cp = emoji.codePointAt(0);
    const xmlEntity = `&#x${cp.toString(16)};`;
    iconXaml = `<TextBlock Text="${xmlEntity}" FontFamily="Segoe UI Emoji" FontSize="30" VerticalAlignment="Center" />`;
  }

  // Escape message text for XAML
  const label = String(message)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // Mac-style dark rounded "toast" card: blurred dark background, emoji + label side by side.
  const contentXaml = `
    <Border CornerRadius="16" Padding="18,12,20,12" HorizontalAlignment="Center" VerticalAlignment="Center">
      <Border.Background>
        <SolidColorBrush Color="#1C1C1E" Opacity="0.92" />
      </Border.Background>
      <Border.Effect>
        <DropShadowEffect BlurRadius="28" ShadowDepth="0" Opacity="0.45" Color="#000000" />
      </Border.Effect>
      <StackPanel Orientation="Horizontal">
        ${iconXaml}
        <TextBlock Text="${label}" Foreground="#F2F2F7" FontFamily="Segoe UI" FontSize="16"
                   FontWeight="SemiBold" VerticalAlignment="Center" Margin="12,0,0,0" />
      </StackPanel>
    </Border>
  `;

  // Sound snippet (MediaPlayer supports MP3 + WAV)
  let soundSnippet = '';
  if (soundFile) {
    const escaped = soundFile.replace(/\\/g, '\\\\').replace(/'/g, "''");
    soundSnippet = `
        var player = new System.Windows.Media.MediaPlayer();
        player.Open(new Uri(@"${escaped}"));
        player.Play();
    `;
  }

  // Self-contained PowerShell script with inline C# WPF code
  const ps = `
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

$cs = @"
using System;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Markup;
using System.Windows.Threading;
using System.Windows.Interop;

public class ClipNotify {
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hwnd, int index);
    [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr hwnd, int index, int newStyle);
    const int GWL_EXSTYLE = -20;
    const int WS_EX_TRANSPARENT = 0x20;
    const int WS_EX_LAYERED = 0x80000;
    const int WS_EX_TOOLWINDOW = 0x80;

    [STAThread]
    public static void Run() {
        var app = new Application();
        app.ShutdownMode = ShutdownMode.OnMainWindowClose;

        var win = new Window();
        win.WindowStyle = WindowStyle.None;
        win.AllowsTransparency = true;
        win.Background = Brushes.Transparent;
        win.Topmost = true;
        win.ShowInTaskbar = false;
        win.SizeToContent = SizeToContent.WidthAndHeight;
        win.Opacity = 0;

        // Position: center of primary screen, or lower-third ("bottom", macOS-like)
        double sw = SystemParameters.PrimaryScreenWidth;
        double sh = SystemParameters.PrimaryScreenHeight;
        string pos = "${position}";

        string xaml = @"${contentXaml.replace(/"/g, '""').replace(/\r?\n/g, ' ').trim()}";
        var content = (UIElement)XamlReader.Parse(
            "<Grid xmlns='http://schemas.microsoft.com/winfx/2006/xaml/presentation'>" + xaml + "</Grid>"
        );
        win.Content = content;

        ${soundSnippet}

        win.SourceInitialized += (s, e) => {
            // Make the window click-through (input-transparent) + tool window (no alt-tab)
            var hwnd = new WindowInteropHelper(win).Handle;
            int ex = GetWindowLong(hwnd, GWL_EXSTYLE);
            SetWindowLong(hwnd, GWL_EXSTYLE, ex | WS_EX_TRANSPARENT | WS_EX_LAYERED | WS_EX_TOOLWINDOW);
        };

        win.Loaded += (s, e) => {
            // Now that size is known, position it
            double w = win.ActualWidth;
            double h = win.ActualHeight;
            win.Left = (sw - w) / 2;
            if (pos == "center") {
                win.Top = (sh - h) / 2;
            } else {
                win.Top = sh * 0.80 - h / 2; // lower third
            }

            // Fade in 200ms
            var fadeIn = new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(200));
            fadeIn.Completed += (s2, e2) => {
                // Hold 1.5s then fade out 500ms
                var timer = new DispatcherTimer();
                timer.Interval = TimeSpan.FromMilliseconds(1500);
                timer.Tick += (s3, e3) => {
                    timer.Stop();
                    var fadeOut = new DoubleAnimation(1, 0, TimeSpan.FromMilliseconds(500));
                    fadeOut.Completed += (s4, e4) => {
                        win.Close();
                    };
                    win.BeginAnimation(Window.OpacityProperty, fadeOut);
                };
                timer.Start();
            };
            win.BeginAnimation(Window.OpacityProperty, fadeIn);
        };

        app.MainWindow = win;
        win.Show();
        app.Run();
    }
}
"@

Add-Type -TypeDefinition $cs -ReferencedAssemblies PresentationFramework,PresentationCore,WindowsBase,System.Xaml,System
[ClipNotify]::Run()
`;

  // Fire and forget -- detached, no stdio.
  // NOTE: no windowsHide -- it suppresses the WPF overlay window too.
  // Write the script to a temp file and run via -File (more robust than -Command for large scripts).
  const psFile = join(tmpdir(), `cliplens-notify-${Date.now()}.ps1`);
  writeFileSync(psFile, ps, 'utf-8');
  const child = spawn('powershell', ['-ExecutionPolicy', 'Bypass', '-STA', '-File', psFile], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  // Best-effort cleanup of the temp script after it has had time to load.
  setTimeout(() => { try { unlinkSync(psFile); } catch {} }, 8000).unref?.();
}

export default notify;

// ---------------------------------------------------------------------------
// Reminders: a card with a checkbox + snooze (5 min / 30 min / tomorrow), shown at a chosen
// time. The daemon owns the schedule (~/.cliplens/reminders.json). A reminder never vanishes
// silently: only the checkbox completes it; clicking elsewhere snoozes it 30 min.
// ---------------------------------------------------------------------------

/** "14:30" (next occurrence, local), an ISO date-time, or epoch ms -> epoch ms. Throws on junk. */
export function parseWhen(at, now = Date.now()) {
  if (typeof at === 'number' && Number.isFinite(at) && at > 0) return Math.round(at);
  const s = String(at ?? '').trim();
  const hm = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (hm) {
    const h = Number(hm[1]);
    const m = Number(hm[2]);
    if (h > 23 || m > 59) throw new Error('invalid time: ' + s);
    const d = new Date(now);
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  const t = Date.parse(s);
  if (!Number.isFinite(t) || Math.abs(t) > 8.64e15) throw new Error('invalid time: ' + (s || '(empty)') + ' (use HH:MM, an ISO date-time or epoch ms)');
  return t;
}

const REMIND_POSITIONS = ['top-left', 'top', 'top-right', 'center', 'bottom-left', 'bottom', 'bottom-right'];

export function remindersPath() {
  return join(homedir(), '.cliplens', 'reminders.json');
}

/** All reminders on disk (open and recently done). */
export function listReminders() {
  try {
    const j = JSON.parse(readFileSync(remindersPath(), 'utf8'));
    // Drop malformed/tampered entries so one bad row cannot break the listing.
    return Array.isArray(j.items)
      ? j.items.filter((i) => i && typeof i.id === 'string' && Number.isFinite(i.due_ms) && Math.abs(i.due_ms) < 8.64e15)
      : [];
  } catch {
    return [];
  }
}

function runDaemon(args) {
  const bin = findToastBinary();
  if (!bin) return { ok: false, message: 'cliplens-daemon is not built (cargo build --release in cliplens-toast)' };
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 8000, windowsHide: true });
  if (r.error) return { ok: false, message: String(r.error.message || r.error) };
  return { ok: r.status === 0, message: ((r.stdout || '') + (r.stderr || '')).trim() };
}

/**
 * Schedule a reminder.
 * @param {object} o
 * @param {string} o.title
 * @param {string} [o.subtitle]
 * @param {string} [o.agent]
 * @param {string} [o.id]          - same open id = reschedule.
 * @param {number} [o.inSeconds]   - relative; 0/absent with no `at` = right now.
 * @param {string|number} [o.at]   - "HH:MM" | ISO | epoch ms (wins over inSeconds).
 * @param {string} [o.position]    - top-left|top|top-right|center|bottom-left|bottom|bottom-right (default bottom-right, or CLIPLENS_REMINDER_POSITION).
 */
export function sendRemind({ title, subtitle = '', agent, id, inSeconds, at, position } = {}) {
  if (!title || !String(title).trim()) return { ok: false, message: '`title` is required' };
  if (id && !/^[\w.-]{1,64}$/.test(String(id))) return { ok: false, message: '`id` may only contain letters, digits, . _ - (max 64)' };
  if (position && !REMIND_POSITIONS.includes(String(position))) return { ok: false, message: 'invalid `position` (one of ' + REMIND_POSITIONS.join(', ') + ')' };
  // Values are passed after their flag; clamp lengths here (the daemon clamps again).
  const clamp = (s, n) => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, n);
  const args = ['--remind', '--title', clamp(title, 200), '--agent', clamp(agent || process.env.CLIPLENS_AGENT || '', 40)];
  if (subtitle) args.push('--subtitle', clamp(subtitle, 500));
  if (id) args.push('--id', String(id));
  if (position) args.push('--position', String(position));
  try {
    if (at !== undefined && at !== null && String(at) !== '') args.push('--at', String(parseWhen(at)));
    else if (Number(inSeconds) > 0) args.push('--in', String(Math.floor(Number(inSeconds))));
  } catch (e) {
    return { ok: false, message: e.message };
  }
  return runDaemon(args);
}

export function cancelRemind(id) {
  if (!id || !String(id).trim()) return { ok: false, message: '`id` is required' };
  return runDaemon(['--remind-cancel', String(id)]);
}
