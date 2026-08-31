#!/usr/bin/env node
/**
 * Image Pen -- put a real image (PNG/etc.) on the Windows clipboard as a
 * bitmap, so any app (Mural, Slack, Teams, Word...) pastes it as an image.
 *
 * This is NOT a Mural sticky -- it is a genuine clipboard image. Mural accepts
 * pasted images as image widgets. For icons (e.g. FatCow), point at the .png.
 *
 * Usage:
 *   node src/pens/image.js "C:\path\to\icon.png"
 */
import { existsSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeFileSync, unlinkSync } from 'fs';
import { appendHistory } from '../history.js';

/**
 * Write an image file to the clipboard preserving transparency. Standard
 * Clipboard.SetImage uses CF_BITMAP which flattens alpha onto an opaque
 * background. Instead we register the "PNG" clipboard format (keeps alpha) plus
 * a 32-bit DIBV5 fallback, which apps like Mural/Slack/Teams honor.
 * @param {string} imagePath - absolute path to an image file.
 * @param {object} [opts]
 * @param {boolean} [opts.record=true] - record to clip history (off during replay)
 * @param {string}  [opts.agent] - sender agent for history
 */
export function penImage(imagePath, { record = true, agent } = {}) {
  if (!existsSync(imagePath)) {
    throw new Error(`Image not found: ${imagePath}`);
  }
  const tmpPs = join(tmpdir(), 'cliplens-img-pen.ps1');
  const p = imagePath.replace(/'/g, "''");
  writeFileSync(
    tmpPs,
    `Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$path = '${p}'
# Load without locking the file, and force a 32bpp ARGB copy so alpha is kept.
$src = [System.Drawing.Image]::FromFile($path)
$bmp = New-Object System.Drawing.Bitmap $src.Width, $src.Height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::Transparent)
$g.DrawImage($src, 0, 0, $src.Width, $src.Height)
$g.Dispose()
$src.Dispose()

# Encode PNG (alpha-preserving) into a MemoryStream.
$png = New-Object System.IO.MemoryStream
$bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)

$data = New-Object System.Windows.Forms.DataObject
# 1) "PNG" format -- Chromium/Mural/Slack/Teams read this and keep transparency.
$data.SetData('PNG', $false, $png)
# 2) Standard Bitmap fallback for apps that only read CF_BITMAP.
$data.SetData([System.Windows.Forms.DataFormats]::Bitmap, $true, $bmp)

for ($i = 0; $i -lt 5; $i++) {
  try { [System.Windows.Forms.Clipboard]::SetDataObject($data, $true); break }
  catch { Start-Sleep -Milliseconds 200 }
}
$bmp.Dispose()
$png.Dispose()
`
  );
  execSync(`powershell -NoProfile -ExecutionPolicy Bypass -STA -File "${tmpPs}"`);
  unlinkSync(tmpPs);
  if (record) {
    appendHistory({ format: 'image', imagePath, agent: agent || process.env.CLIPLENS_AGENT || 'cliplens' });
  }
  return { path: imagePath };
}

// CLI entry point
if (process.argv[1]?.replace(/\\/g, '/').endsWith('pens/image.js')) {
  const imagePath = process.argv[2];
  if (!imagePath) {
    console.error('Usage: node src/pens/image.js "C:\\path\\to\\icon.png"');
    process.exit(1);
  }
  try {
    penImage(imagePath);
    console.log(`🖼️  Image on clipboard: ${imagePath}. Ctrl+V to paste (Mural/Slack/Teams/Word).`);
  } catch (e) {
    console.error('Image pen error:', e.message);
    process.exit(1);
  }
}
