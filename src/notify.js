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
import { spawn } from 'child_process';
import { existsSync, readdirSync, writeFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

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
export function notify({ icon, sound = true, message = 'Clip ready', agent = 'cliplens' } = {}) {
  try {
    // Preferred path: the cross-platform cliplens-toast binary (tao + wry).
    // Built locally (not bundled) -- if absent we fall back to the OS-native path.
    const bin = findToastBinary();
    if (bin) {
      // Route legacy notify through the semantic path as a "clip" card.
      sendNotify({ kind: 'clip', title: message, agent });
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
 * @returns {"daemon"|"oneshot"|"noop"} how the notification was delivered.
 */
export function sendNotify({
  title = 'Clip ready',
  subtitle = '',
  agent,
  kind,
  emoji,
  accent,
  sound = 'off',
  position,
  size,
  width,
  height,
  scale,
  offset,
  duration,
  id,
} = {}) {
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
    const esc = (s) => String(s).replace(/'/g, "''");
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
    const psFile = join(tmpdir(), `cliplens-toast-${Date.now()}.ps1`);
    writeFileSync(psFile, '﻿' + ps, 'utf-8');
    const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', psFile], {
      detached: true, stdio: 'ignore',
    });
    child.unref();
    setTimeout(() => { try { unlinkSync(psFile); } catch {} }, 8000).unref?.();
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
