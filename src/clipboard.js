/**
 * Clipboard capture/write.
 *
 * Plaintext read/write is CROSS-PLATFORM (Windows via .NET/PowerShell, macOS via
 * pbcopy/pbpaste, Linux via wl-copy/xclip/xsel). The RICH native-format capture
 * (all clipboard formats, HTML/Slack/Mural blobs) is still Windows-only — it
 * relies on the .NET clipboard API; other OSes get a clear "not supported yet"
 * error there, while the common plaintext path just works everywhere.
 */
import { platform } from 'os';

const OS = platform();
const IS_WIN = OS === 'win32';
const IS_MAC = OS === 'darwin';

/**
 * Capture clipboard as text.
 *
 * ENCODING (Windows): do NOT pipe `Get-Clipboard` through stdout with encoding:'utf-8' --
 * PowerShell writes stdout in the console code page (cp1252/OEM), so Node reading it
 * as UTF-8 mangles å/ä/ö and — (the "tröskel"/mojibake bug). Instead read the real
 * UTF-16 clipboard string via .NET, re-derive its UTF-8 bytes, base64 them, and let
 * Node decode base64 -> utf-8 cleanly. Same proven bridge captureFormat() uses.
 * macOS/Linux tools already emit UTF-8, so we read their stdout as UTF-8 directly.
 */
export async function captureText() {
  if (IS_WIN) {
    const s = await readClipboardStringAsUtf8(`[System.Windows.Forms.Clipboard]::GetText()`);
    return s.trim();
  }
  const { spawnSync } = await import('child_process');
  const chain = IS_MAC
    ? [['pbpaste', []]]
    : [['wl-paste', ['--no-newline']], ['xclip', ['-selection', 'clipboard', '-o']], ['xsel', ['--clipboard', '--output']]];
  for (const [cmd, args] of chain) {
    const r = spawnSync(cmd, args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
    if (r.error) continue; // tool not installed -> try the next
    if (r.status === 0) return (r.stdout || '').replace(/\r\n/g, '\n').trimEnd();
  }
  throw new Error(
    IS_MAC
      ? 'Could not read clipboard (pbpaste failed).'
      : 'Could not read clipboard. Install one of: wl-clipboard (Wayland), xclip, or xsel.'
  );
}

/**
 * Read a .NET clipboard string and return it as a correct UTF-8 JS string.
 * The string is UTF-8-encoded inside PowerShell, base64'd, and decoded by Node --
 * so no console-code-page corruption can occur on the wire. Returns the string
 * verbatim (no trim) so callers decide whether to trim.
 *
 * The PowerShell runs from a temp .ps1 via -File (never -Command "..."), so no
 * script content is ever interpolated into a cmd.exe command line — matching the
 * injection-safe pattern used across the codebase.
 */
async function readClipboardStringAsUtf8(getterExpr) {
  const { execSync } = await import('child_process');
  const { writeFileSync, unlinkSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join } = await import('path');
  const { randomUUID } = await import('crypto');
  const ps = join(tmpdir(), `cliplens-read-${randomUUID()}.ps1`);
  writeFileSync(ps, `Add-Type -AssemblyName System.Windows.Forms
$s = ${getterExpr}
if ($null -eq $s) { '' } else {
  [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($s))
}
`, { encoding: 'utf-8', mode: 0o600 });
  try {
    const b64 = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -STA -File "${ps}"`, { encoding: 'utf-8' }).trim();
    return Buffer.from(b64, 'base64').toString('utf-8');
  } finally {
    try { unlinkSync(ps); } catch { /* already gone */ }
  }
}

/** List all clipboard formats available (Windows). Non-Windows: plaintext only. */
export async function listFormats() {
  if (!IS_WIN) return ['text/plain']; // rich-format enumeration is Windows-only
  const { execSync } = await import('child_process');
  // Use .NET to get all formats. Force an array so a single format doesn't
  // deserialize to a bare string (which callers would iterate char-by-char).
  const script = `
    Add-Type -AssemblyName System.Windows.Forms
    $f = @([System.Windows.Forms.Clipboard]::GetDataObject().GetFormats())
    ConvertTo-Json -InputObject $f
  `;
  const result = execSync(`powershell -command "${script.replace(/\n/g, '; ')}"`, { encoding: 'utf-8' });
  const parsed = JSON.parse(result);
  return Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
}

/**
 * Capture a specific clipboard format as base64.
 *
 * ENCODING NOTE: Windows hands string formats (e.g. 'HTML Format') back to us
 * already decoded via the ANSI codepage (cp1252), but their bytes on the wire
 * are UTF-8. UTF-8-encoding that mangled string double-corrupts multibyte chars
 * (em-dash — became â€", å/ä/ö broke). So for string data we re-derive the
 * ORIGINAL bytes through cp1252 and base64 those; Node then decodes as UTF-8
 * correctly. cp1252 round-trips genuine single-byte text loss-lessly too.
 */
export async function captureFormat(formatName) {
  if (!IS_WIN) {
    // Only plaintext is portable; the rich .NET format blobs are Windows-only.
    if (/plain|text/i.test(formatName)) {
      const t = await captureText();
      return Buffer.from(t, 'utf-8').toString('base64');
    }
    throw new Error(`Rich clipboard format "${formatName}" capture is Windows-only for now.`);
  }
  const { execSync } = await import('child_process');
  const script = `
    Add-Type -AssemblyName System.Windows.Forms
    $data = [System.Windows.Forms.Clipboard]::GetDataObject().GetData('${formatName}')
    if ($data -is [System.IO.MemoryStream]) {
      [Convert]::ToBase64String($data.ToArray())
    } elseif ($data -is [string]) {
      $cp = [System.Text.Encoding]::GetEncoding(1252)
      [Convert]::ToBase64String($cp.GetBytes($data))
    } else {
      'UNSUPPORTED_TYPE:' + $data.GetType().FullName
    }
  `;
  const result = execSync(`powershell -command "${script.replace(/\n/g, '; ')}"`, { encoding: 'utf-8' });
  return result.trim();
}

/** Capture full clipboard snapshot (all formats) */
export async function captureSnapshot(appHint) {
  const formats = await listFormats();
  const snapshot = {
    id: crypto.randomUUID(),
    appHint: appHint || 'unknown',
    capturedAt: new Date().toISOString(),
    formats: [],
  };

  for (const name of formats) {
    try {
      const rawBase64 = await captureFormat(name);
      const sizeBytes = Math.ceil(rawBase64.length * 0.75);
      const decoded = Buffer.from(rawBase64, 'base64').toString('utf-8');
      let classification = 'binary';
      let preview = '';

      if (decoded.startsWith('{') || decoded.startsWith('[')) { classification = 'json'; preview = decoded.substring(0, 200); }
      else if (decoded.startsWith('<')) { classification = decoded.includes('<svg') ? 'svg' : 'html'; preview = decoded.substring(0, 200); }
      else if (/^[\x20-\x7E\n\r\t]+$/.test(decoded.substring(0, 100))) { classification = 'plain-text'; preview = decoded.substring(0, 200); }

      snapshot.formats.push({ name, sizeBytes, classification, preview, rawBase64 });
    } catch (e) {
      snapshot.formats.push({ name, sizeBytes: 0, classification: 'binary', error: e.message });
    }
  }

  return snapshot;
}

/** Write text to clipboard (handles multiline + special chars safely). Cross-platform. */
export async function writeText(text) {
  if (!IS_WIN) return writeTextPosix(text);
  const { execSync } = await import('child_process');
  const { writeTmp, rmTmp } = await import('./tmp.js');

  const tmpTxt = writeTmp(text, '.txt');
  const tmpPs = writeTmp(`$text = [System.IO.File]::ReadAllText('${tmpTxt.replace(/\\/g, '\\\\')}')
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Clipboard]::SetText($text)
`, '.ps1');
  try {
    execSync(`powershell -ExecutionPolicy Bypass -STA -File "${tmpPs}"`);
  } finally {
    rmTmp(tmpTxt);
    rmTmp(tmpPs);
  }
}

/**
 * macOS/Linux clipboard write. Feeds UTF-8 text on stdin so multiline + special
 * chars (å ä ö, emoji) survive with no shell-escaping. Tries the platform tools
 * in order and uses the first that is installed.
 */
async function writeTextPosix(text) {
  const { spawnSync } = await import('child_process');
  const buf = Buffer.from(text, 'utf-8');
  const chain = IS_MAC
    ? [['pbcopy', []]]
    : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
  for (const [cmd, args] of chain) {
    const r = spawnSync(cmd, args, { input: buf });
    if (r.error) continue; // tool not installed -> try the next
    if (r.status === 0) return;
  }
  throw new Error(
    IS_MAC
      ? 'Could not write clipboard (pbcopy failed).'
      : 'Could not write clipboard. Install one of: wl-clipboard (Wayland), xclip, or xsel.'
  );
}
