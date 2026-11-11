/**
 * image-size.js — safe image downscaling, reusable across ClipLens.
 *
 * Problem: a huge image (e.g. an 8000px screenshot or design frame) read at full
 * resolution overflows an agent's context window and forces a /rewind. ClipLens
 * already caps clipboard images to a safe max edge; this module is the SAME logic
 * broken out so it also works on an image FILE on disk.
 *
 * Cross-platform:
 *   Windows → System.Drawing (PowerShell), HighQualityBicubic
 *   macOS   → NSImage/NSBitmapImageRep (Swift)
 *
 * The write-side callers downscale a clipboard image; this one downscales a file,
 * so `cliplens_safe_image` and the clipboard path share one implementation.
 */
import { execSync, execFileSync } from 'child_process';
import { existsSync, writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { psq } from './ps.js';
import crypto from 'crypto';

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

/**
 * Downscale an image FILE so its longest side is at most `edge` px, writing a PNG
 * to `destPath`. If the image is already within `edge` (or edge <= 0), it is copied
 * through at full size. Returns dims info; never throws for a missing-image case —
 * returns null so callers can report cleanly.
 *
 * @param {string} srcPath  absolute path to the source image
 * @param {string} destPath absolute path to write the (possibly downscaled) PNG
 * @param {number} edge     max longest-side px; 0/negative = no limit (copy through)
 * @returns {{ dims: string, originalDims: string, downscaled: boolean } | null}
 */
export function downscaleImageFile(srcPath, destPath, edge) {
  if (!existsSync(srcPath)) return null;
  const cap = Number.isFinite(edge) && edge > 0 ? Math.round(edge) : 0;

  let result;
  if (IS_MAC) {
    result = runSwiftResize(srcPath, destPath, cap);
  } else if (IS_WIN) {
    result = runWinResize(srcPath, destPath, cap);
  } else {
    // Linux: no bundled image lib. Best effort — copy through, report size unknown.
    // (A future enhancement could shell out to ImageMagick `convert` if present.)
    try {
      const { copyFileSync } = require('fs');
      copyFileSync(srcPath, destPath);
    } catch { return null; }
    return { dims: 'unknown', originalDims: 'unknown', downscaled: false };
  }

  if (!result || result === 'NO_IMAGE') return null;
  const [savedDims, origDims] = result.split('|');
  const dims = (savedDims || result).trim();
  const originalDims = (origDims || savedDims || result).trim();
  return { dims, originalDims, downscaled: dims !== originalDims };
}

/** Windows: System.Drawing load + HighQualityBicubic downscale. */
function runWinResize(srcPath, destPath, cap) {
  const src = psq(srcPath);
  const dst = psq(destPath);
  const tmpPs = join(tmpdir(), `cliplens-resize-${crypto.randomUUID()}.ps1`);
  writeFileSync(tmpPs, `
Add-Type -AssemblyName System.Drawing
try {
  $img = [System.Drawing.Image]::FromFile('${src}')
} catch { Write-Host "NO_IMAGE"; exit 0 }
$ow = $img.Width; $oh = $img.Height
$edge = ${cap}
$longest = [Math]::Max($ow, $oh)
if ($edge -gt 0 -and $longest -gt $edge) {
  $scale = $edge / $longest
  $nw = [int][Math]::Round($ow * $scale)
  $nh = [int][Math]::Round($oh * $scale)
  $bmp = New-Object System.Drawing.Bitmap $nw, $nh
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($img, 0, 0, $nw, $nh)
  $g.Dispose()
  $bmp.Save('${dst}', [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "$($nw)x$($nh)|$($ow)x$($oh)"
} else {
  $img.Save('${dst}', [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Host "$($ow)x$($oh)|$($ow)x$($oh)"
}
$img.Dispose()
`, { encoding: 'utf-8', mode: 0o600 });
  try {
    return execSync(`powershell -NoProfile -ExecutionPolicy Bypass -STA -File "${tmpPs}"`, { encoding: 'utf-8' }).trim();
  } finally {
    try { unlinkSync(tmpPs); } catch { /* ignore */ }
  }
}

/** macOS: NSImage load + NSBitmapImageRep PNG, downscaled proportionally. */
function runSwiftResize(srcPath, destPath, cap) {
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const tmp = join(tmpdir(), `cliplens-resize-${crypto.randomUUID()}.swift`);
  writeFileSync(tmp, `
import AppKit
import Foundation
guard let img = NSImage(contentsOfFile: "${esc(srcPath)}"),
      let tiff = img.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff) else { print("NO_IMAGE", terminator: ""); exit(0) }
let ow = rep.pixelsWide, oh = rep.pixelsHigh
let edge = ${cap}
let longest = max(ow, oh)
func writePng(_ r: NSBitmapImageRep, _ w: Int, _ h: Int, _ ow: Int, _ oh: Int) {
  if let png = r.representation(using: .png, properties: [:]) {
    try? png.write(to: URL(fileURLWithPath: "${esc(destPath)}"))
    print("\\(w)x\\(h)|\\(ow)x\\(oh)", terminator: "")
  } else { print("NO_IMAGE", terminator: "") }
}
if edge > 0 && longest > edge {
  let scale = Double(edge) / Double(longest)
  let nw = Int((Double(ow) * scale).rounded()), nh = Int((Double(oh) * scale).rounded())
  let dst = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: nw, pixelsHigh: nh,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: dst)
  NSGraphicsContext.current?.imageInterpolation = .high
  rep.draw(in: NSRect(x: 0, y: 0, width: nw, height: nh))
  NSGraphicsContext.restoreGraphicsState()
  writePng(dst, nw, nh, ow, oh)
} else {
  writePng(rep, ow, oh, ow, oh)
}
`, { encoding: 'utf-8', mode: 0o600 });
  try {
    return execFileSync('swift', [tmp], { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }).trim();
  } finally {
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
}
