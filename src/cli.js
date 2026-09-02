#!/usr/bin/env node
/**
 * cliplens CLI
 * 
 * Usage:
 *   cliplens capture --app mural --out snapshot.json
 *   cliplens inspect snapshot.json
 *   cliplens diff a.json b.json
 *   cliplens patch snapshot.json --text "New text"
 *   cliplens write patched.json
 */
import { captureSnapshot, listFormats, captureText, writeText } from './clipboard.js';
import { sendNotify } from './notify.js';
import { appendHistory } from './history.js';
import { readFileSync, writeFileSync } from 'fs';

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };

switch (cmd) {
  case 'capture': {
    const app = flag('app') || 'unknown';
    const out = flag('out') || `snapshot-${Date.now()}.json`;
    console.log(`Capturing clipboard (app hint: ${app})...`);
    const snapshot = await captureSnapshot(app);
    writeFileSync(out, JSON.stringify(snapshot, null, 2));
    console.log(`Saved ${snapshot.formats.length} formats to ${out}`);
    for (const f of snapshot.formats) {
      console.log(`  ${f.classification.padEnd(10)} ${f.name} (${f.sizeBytes} bytes)`);
    }
    break;
  }
  case 'inspect': {
    const file = args[1];
    if (!file) { console.error('Usage: cliplens inspect <file.json>'); process.exit(1); }
    const snap = JSON.parse(readFileSync(file, 'utf-8'));
    console.log(`Snapshot: ${snap.id} (${snap.appHint}, ${snap.capturedAt})`);
    console.log(`Formats: ${snap.formats.length}\n`);
    for (const f of snap.formats) {
      console.log(`[${f.classification}] ${f.name} — ${f.sizeBytes} bytes`);
      if (f.preview) console.log(`  ${f.preview.substring(0, 100)}`);
      console.log('');
    }
    break;
  }
  case 'diff': {
    const [, fileA, fileB] = args;
    if (!fileA || !fileB) { console.error('Usage: cliplens diff <a.json> <b.json>'); process.exit(1); }
    const a = JSON.parse(readFileSync(fileA, 'utf-8'));
    const b = JSON.parse(readFileSync(fileB, 'utf-8'));
    console.log(`Diffing ${a.formats.length} formats...`);
    for (const af of a.formats) {
      const bf = b.formats.find(f => f.name === af.name);
      if (!bf) { console.log(`  REMOVED: ${af.name}`); continue; }
      if (af.rawBase64 !== bf.rawBase64) {
        console.log(`  CHANGED: ${af.name} (${af.sizeBytes} → ${bf.sizeBytes} bytes)`);
      }
    }
    for (const bf of b.formats) {
      if (!a.formats.find(f => f.name === bf.name)) console.log(`  ADDED: ${bf.name}`);
    }
    break;
  }
  case 'formats': {
    const formats = await listFormats();
    console.log('Current clipboard formats:');
    for (const f of formats) console.log(`  ${f}`);
    break;
  }
  case 'text': {
    const text = await captureText();
    console.log(text);
    break;
  }
  case 'write': {
    // Put plaintext on the clipboard (UTF-8, so å ä ö survive). Text comes from
    // the argument, or from stdin when piped / when no argument is given.
    // Skip flags AND the value token after each flag, so --type/--agent values
    // never leak into the text being written.
    const positional = [];
    for (let i = 1; i < args.length; i++) {
      if (args[i].startsWith('--')) { i++; continue; }
      positional.push(args[i]);
    }
    let text = positional.join(' ');
    if (!text && !process.stdin.isTTY) {
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      text = Buffer.concat(chunks).toString('utf8');
    }
    if (!text) {
      console.error('cliplens write: nothing to write (pass text as an argument or pipe it on stdin)');
      process.exit(1);
    }
    await writeText(text);
    // Sender + clip type on the notification (same as the MCP write path).
    const agent = flag('agent') || process.env.CLIPLENS_AGENT || 'cliplens';
    const type = flag('type') || 'Vanilla';
    const clipId = appendHistory({ text, format: 'plain', agent });
    sendNotify({ kind: 'clip', format: type, title: `${type}-clip klar`, subtitle: `${[...text].length} tecken · Ctrl+V`, agent });
    console.log(`✅ ${[...text].length} tecken på clipboard (UTF-8) — ${agent} · ${type}${clipId ? ` · id=${clipId}` : ''}. Ctrl+V.`);
    break;
  }
  default:
    console.log('cliplens — ClipLens — universal clipboard skill');
    console.log('Commands: capture, inspect, diff, formats, text, write');
    console.log('Use --help for details');
}
