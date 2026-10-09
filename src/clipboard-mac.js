/**
 * Clipboard capture/write for macOS using pbcopy/pbpaste and Swift via osascript/NSPasteboard.
 *
 * Replaces the PowerShell-based clipboard.js on darwin.
 * All exported functions match the Windows API surface exactly.
 */
import { execSync, execFileSync } from 'child_process';
import { writeFileSync, unlinkSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape a string for safe interpolation inside a Swift string literal. */
function escSwift(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\0/g, '');
}

/** Generate a cryptographically random temp file path (avoids predictable names). */
function safeTmp(prefix, ext) {
  return join(tmpdir(), `${prefix}-${crypto.randomUUID()}${ext}`);
}

/** Run a small Swift snippet that links AppKit (NSPasteboard lives there). */
function runSwift(code, { maxBuffer = 50 * 1024 * 1024 } = {}) {
  const tmp = safeTmp('cliplens-swift', '.swift');
  writeFileSync(tmp, code, { encoding: 'utf-8', mode: 0o600 });
  try {
    return execFileSync('swift', [tmp], { encoding: 'utf-8', maxBuffer }).trim();
  } finally {
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/** Run a small Swift snippet that writes binary output to a file (for base64 capture). */
function runSwiftBinary(code) {
  const tmp = safeTmp('cliplens-swift', '.swift');
  const outFile = safeTmp('cliplens-out', '.bin');
  writeFileSync(tmp, code.replace(/__OUT_FILE__/g, escSwift(outFile)), { encoding: 'utf-8', mode: 0o600 });
  try {
    execFileSync('swift', [tmp], { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
    if (existsSync(outFile)) {
      const buf = readFileSync(outFile);
      return buf;
    }
    return null;
  } finally {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    try { unlinkSync(outFile); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Public API — matches clipboard.js (Windows) exactly
// ---------------------------------------------------------------------------

/** Capture clipboard as plain text. */
export async function captureText() {
  try {
    const text = execSync('pbpaste', { encoding: 'utf-8' });
    return text;
  } catch {
    return '';
  }
}

/** Capture clipboard HTML (the public.html type if available). */
export async function captureHtml() {
  const code = `
import AppKit
let pb = NSPasteboard.general
if let html = pb.string(forType: .html) {
  print(html, terminator: "")
} else {
  print("", terminator: "")
}
`;
  return runSwift(code);
}

/** List all clipboard formats (UTI types) available. Returns an array of strings. */
export async function listFormats() {
  const code = `
import AppKit
let pb = NSPasteboard.general
let types = pb.types ?? []
for t in types {
  print(t.rawValue)
}
`;
  const result = runSwift(code);
  return result.split('\n').filter(Boolean);
}

/**
 * Capture a specific clipboard format as base64.
 * On macOS, format names are UTIs (e.g. "public.utf8-plain-text", "public.html").
 * Also accepts Windows-style names and maps them to macOS equivalents.
 */
export async function captureFormat(formatName) {
  // Map common Windows format names to macOS UTIs
  const formatMap = {
    'UnicodeText': 'public.utf8-plain-text',
    'Text': 'public.utf8-plain-text',
    'HTML Format': 'public.html',
    'Chromium Web Custom MIME Data Format': 'org.chromium.web-custom-data',
    'PNG': 'public.png',
    'Bitmap': 'public.tiff',
  };
  const uti = formatMap[formatName] || formatName;

  const code = `
import AppKit
import Foundation
let pb = NSPasteboard.general
let type = NSPasteboard.PasteboardType(rawValue: "${escSwift(uti)}")
if let data = pb.data(forType: type) {
  print(data.base64EncodedString(), terminator: "")
} else {
  print("", terminator: "")
}
`;
  return runSwift(code);
}

/** Capture full clipboard snapshot (all formats). */
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
      if (!rawBase64) {
        snapshot.formats.push({ name, sizeBytes: 0, classification: 'empty', preview: '' });
        continue;
      }
      const sizeBytes = Math.ceil(rawBase64.length * 0.75);
      const decoded = Buffer.from(rawBase64, 'base64').toString('utf-8');
      let classification = 'binary';
      let preview = '';

      if (decoded.startsWith('{') || decoded.startsWith('[')) {
        classification = 'json';
        preview = decoded.substring(0, 200);
      } else if (decoded.startsWith('<')) {
        classification = decoded.includes('<svg') ? 'svg' : 'html';
        preview = decoded.substring(0, 200);
      } else if (/^[\x20-\x7E\n\r\t]+$/.test(decoded.substring(0, 100))) {
        classification = 'plain-text';
        preview = decoded.substring(0, 200);
      }

      snapshot.formats.push({ name, sizeBytes, classification, preview, rawBase64 });
    } catch (e) {
      snapshot.formats.push({ name, sizeBytes: 0, classification: 'binary', error: e.message });
    }
  }

  return snapshot;
}

/** Write plain text to clipboard. */
export async function writeText(text) {
  execSync('pbcopy', { input: text, encoding: 'utf-8' });
}

/**
 * Write an HTML Format payload to the macOS clipboard.
 * Sets both public.html and public.utf8-plain-text so apps get rich + plain.
 * @param {string} html — the HTML body (not the CF_HTML wrapper — macOS doesn't use that).
 * @param {string} [plainText] — optional plain text fallback.
 */
export function writeHtmlToClipboard(html, plainText) {
  const tmpHtml = safeTmp('cliplens-html', '.html');
  const tmpTxt = safeTmp('cliplens-txt', '.txt');
  writeFileSync(tmpHtml, html, { encoding: 'utf-8', mode: 0o600 });
  if (plainText) writeFileSync(tmpTxt, plainText, { encoding: 'utf-8', mode: 0o600 });

  const readPlain = plainText
    ? `let plainData = try! Data(contentsOf: URL(fileURLWithPath: "${escSwift(tmpTxt)}"))\npb.setData(plainData, forType: .string)`
    : '';

  const code = `
import AppKit
import Foundation
let pb = NSPasteboard.general
pb.clearContents()
let htmlData = try! Data(contentsOf: URL(fileURLWithPath: "${escSwift(tmpHtml)}"))
pb.setData(htmlData, forType: .html)
${readPlain}
`;
  runSwift(code);
  try { unlinkSync(tmpHtml); } catch { /* ignore */ }
  try { if (plainText) unlinkSync(tmpTxt); } catch { /* ignore */ }
}

/**
 * Write multiple custom MIME types to the clipboard at once.
 * Used by Slack pen (Chromium custom MIME), Mural pen (HTML Format), etc.
 *
 * @param {Array<{type: string, data: Buffer|string}>} items
 *   Each item has a `type` (UTI or mapped name) and `data` (Buffer for binary, string for text).
 */
export function writeCustomFormats(items) {
  const formatMap = {
    'UnicodeText': 'public.utf8-plain-text',
    'Text': 'public.utf8-plain-text',
    'HTML Format': 'public.html',
    'Chromium Web Custom MIME Data Format': 'org.chromium.web-custom-data',
    'PNG': 'public.png',
  };

  // Write each data blob to a temp file
  const fileEntries = items.map((item, i) => {
    const uti = formatMap[item.type] || item.type;
    const tmpFile = safeTmp(`cliplens-fmt-${i}`, '.bin');
    if (Buffer.isBuffer(item.data)) {
      writeFileSync(tmpFile, item.data, { mode: 0o600 });
    } else {
      writeFileSync(tmpFile, item.data, { encoding: 'utf-8', mode: 0o600 });
    }
    return { uti, tmpFile };
  });

  // Build Swift code to set all formats at once
  const setStatements = fileEntries.map(({ uti, tmpFile }) =>
    `pb.setData(try! Data(contentsOf: URL(fileURLWithPath: "${escSwift(tmpFile)}")), forType: NSPasteboard.PasteboardType(rawValue: "${escSwift(uti)}"))`
  ).join('\n');

  const code = `
import AppKit
import Foundation
let pb = NSPasteboard.general
pb.clearContents()
${setStatements}
`;
  try {
    runSwift(code);
  } finally {
    for (const { tmpFile } of fileEntries) {
      try { unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  }
}

/**
 * Write an image file to the clipboard (preserves transparency).
 * Sets both public.png and public.tiff so apps get the format they prefer.
 * @param {string} imagePath — absolute path to an image file.
 */
export function writeImageToClipboard(imagePath) {
  const code = `
import AppKit
import Foundation
let path = "${escSwift(imagePath)}"
guard let image = NSImage(contentsOfFile: path) else {
  fputs("Image not found: \\(path)\\n", stderr)
  exit(1)
}
let pb = NSPasteboard.general
pb.clearContents()
pb.writeObjects([image])
`;
  runSwift(code);
}

/**
 * Save the clipboard image (if present) to a file.
 * @param {string} outPath — where to save the PNG.
 * @returns {{ dims: string } | null} — null if no image on clipboard.
 */
export function saveClipboardImage(outPath) {
  const code = `
import AppKit
import Foundation
let pb = NSPasteboard.general
guard let imgData = pb.data(forType: .tiff) ?? pb.data(forType: .png) else {
  print("NO_IMAGE", terminator: "")
  exit(0)
}
guard let image = NSImage(data: imgData) else {
  print("NO_IMAGE", terminator: "")
  exit(0)
}
guard let tiff = image.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let png = rep.representation(using: .png, properties: [:]) else {
  print("NO_IMAGE", terminator: "")
  exit(0)
}
let url = URL(fileURLWithPath: "${escSwift(outPath)}")
try! png.write(to: url)
let w = Int(image.size.width)
let h = Int(image.size.height)
print("\\(w)x\\(h)", terminator: "")
`;
  const result = runSwift(code);
  if (result === 'NO_IMAGE' || !result) return null;
  return { dims: result };
}
