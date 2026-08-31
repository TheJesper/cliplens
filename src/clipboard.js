/**
 * Clipboard capture/write for Windows using PowerShell.
 * Captures all available clipboard formats and their data.
 */

/** Capture clipboard as text (basic — for MVP) */
export async function captureText() {
  const { execSync } = await import('child_process');
  const text = execSync('powershell -command "Get-Clipboard"', { encoding: 'utf-8' });
  return text.trim();
}

/** Capture clipboard HTML format */
export async function captureHtml() {
  const { execSync } = await import('child_process');
  const html = execSync('powershell -command "Get-Clipboard -Format Text"', { encoding: 'utf-8' });
  return html;
}

/** List all clipboard formats available (Windows) */
export async function listFormats() {
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

/** Capture a specific clipboard format as base64 */
export async function captureFormat(formatName) {
  const { execSync } = await import('child_process');
  const script = `
    Add-Type -AssemblyName System.Windows.Forms
    $data = [System.Windows.Forms.Clipboard]::GetDataObject().GetData('${formatName}')
    if ($data -is [System.IO.MemoryStream]) {
      [Convert]::ToBase64String($data.ToArray())
    } elseif ($data -is [string]) {
      [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($data))
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

/** Write text to clipboard (handles multiline + special chars safely) */
export async function writeText(text) {
  const { execSync } = await import('child_process');
  const { writeFileSync, unlinkSync } = await import('fs');
  const { tmpdir } = await import('os');
  const { join } = await import('path');

  const tmpTxt = join(tmpdir(), 'cliplens-write.txt');
  const tmpPs = join(tmpdir(), 'cliplens-write.ps1');
  writeFileSync(tmpTxt, text, 'utf-8');
  writeFileSync(tmpPs, `$text = [System.IO.File]::ReadAllText('${tmpTxt.replace(/\\/g, '\\\\')}')
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Clipboard]::SetText($text)
`);
  execSync(`powershell -ExecutionPolicy Bypass -STA -File "${tmpPs}"`);
  unlinkSync(tmpTxt);
  unlinkSync(tmpPs);
}
