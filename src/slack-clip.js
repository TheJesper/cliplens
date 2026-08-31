#!/usr/bin/env node
/**
 * slack-clip: Format text for Slack and write to clipboard.
 * 
 * Usage:
 *   node slack-clip.js "**Bold header**\nNormal text\n- Bullet\n1. Numbered"
 *   echo "some text" | node slack-clip.js
 *   node slack-clip.js --file message.txt
 */
import { writeFileSync, readFileSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { notify } from './notify.js';

function encodeU16String(str) {
  const encoded = Buffer.from(str, 'utf16le');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(str.length);
  if (str.length % 2 !== 0) return Buffer.concat([header, encoded, Buffer.alloc(2)]);
  return Buffer.concat([header, encoded]);
}

function encodeCustomMime(pairs) {
  let data = Buffer.alloc(0);
  for (const [key, value] of pairs) data = Buffer.concat([data, encodeU16String(key), encodeU16String(value)]);
  const header = Buffer.alloc(8);
  header.writeUInt32LE(data.length + 4, 0);
  header.writeUInt32LE(pairs.length, 4);
  return Buffer.concat([header, data]);
}

/** Simple markdown-ish → Quill Delta converter */
function textToDelta(text) {
  const ops = [];
  const lines = text.split('\n');
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code block fence (```)
    if (/^```/.test(line)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    // Inside code block — each line gets code-block attribute on newline
    if (inCodeBlock) {
      ops.push({ insert: line });
      ops.push({ attributes: { 'code-block': true }, insert: '\n' });
      continue;
    }

    // Bullet list
    if (/^[-•]\s/.test(line)) {
      const content = line.replace(/^[-•]\s/, '');
      parseInline(content, {}, ops);
      ops.push({ attributes: { list: 'bullet' }, insert: '\n' });
      continue;
    }
    // Numbered list
    if (/^\d+[.)]\s/.test(line)) {
      const content = line.replace(/^\d+[.)]\s/, '');
      parseInline(content, {}, ops);
      ops.push({ attributes: { list: 'ordered' }, insert: '\n' });
      continue;
    }

    // Process inline formatting
    parseInline(line, {}, ops);

    if (i < lines.length - 1) ops.push({ insert: '\n' });
  }

  return { ops };
}

const SMALL_CAPS = Object.fromEntries([...'abcdefghijklmnopqrstuvwxyz'].map((c, i) =>
  [c, 'ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘǫʀꜱᴛᴜᴠᴡxʏᴢ'[i]]));
function toSmallCaps(str) { return [...str].map(c => SMALL_CAPS[c] || c).join(''); }

/** Parse inline formatting with parent attributes (supports nesting like bold+link) */
function parseInline(text, parentAttrs, ops) {
  let remaining = text;
  while (remaining.length > 0) {
    // Bold: **text** → real bold
    const boldMatch = remaining.match(/^\*\*(.+?)\*\*/);
    if (boldMatch) {
      parseInline(boldMatch[1], { ...parentAttrs, bold: true }, ops);
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }
    // Italic: *text* or _text_ (parse inside recursively)
    const italicMatch = remaining.match(/^\*(.+?)\*/) || remaining.match(/^_(.+?)_/);
    if (italicMatch) {
      parseInline(italicMatch[1], { ...parentAttrs, italic: true }, ops);
      remaining = remaining.slice(italicMatch[0].length);
      continue;
    }
    // Code: `text`
    const codeMatch = remaining.match(/^`(.+?)`/);
    if (codeMatch) {
      const attrs = { ...parentAttrs, code: true };
      ops.push({ attributes: attrs, insert: codeMatch[1] });
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }
    // Link: [text](url)
    const linkMatch = remaining.match(/^\[(.+?)\]\((.+?)\)/);
    if (linkMatch) {
      const attrs = { ...parentAttrs, link: linkMatch[2] };
      ops.push({ attributes: attrs, insert: linkMatch[1] });
      remaining = remaining.slice(linkMatch[0].length);
      continue;
    }
    // Emoji: :emoji_name:
    const emojiMatch = remaining.match(/^(:[a-z0-9_+-]+:)/);
    if (emojiMatch) {
      ops.push({ insert: { slackemoji: { text: emojiMatch[1] } } });
      remaining = remaining.slice(emojiMatch[0].length);
      continue;
    }
    // Plain text (up to next special char)
    const plainMatch = remaining.match(/^[^*`\[_:]+/) || [remaining[0]];
    const attrs = Object.keys(parentAttrs).length > 0 ? parentAttrs : undefined;
    if (attrs) {
      ops.push({ attributes: attrs, insert: plainMatch[0] });
    } else {
      ops.push({ insert: plainMatch[0] });
    }
    remaining = remaining.slice(plainMatch[0].length);
  }
}

// Sanitize AI-isms → natural human text
function humanize(text) {
  return text
    .replace(/—/g, '-')          // em dash → hyphen
    .replace(/–/g, '-')          // en dash → hyphen
    .replace(/\u201C/g, '"')     // " → "
    .replace(/\u201D/g, '"')     // " → "
    .replace(/\u2018/g, "'")     // ' → '
    .replace(/\u2019/g, "'")     // ' → '
    .replace(/\u2026/g, '...')   // … → ...
    .replace(/\u00A0/g, ' ')     // non-breaking space → space
    .replace(/\u200B/g, '')      // zero-width space → remove
    .replace(/\uFEFF/g, '');     // BOM → remove
}

// Get input text
let text;
const args = process.argv.slice(2);

if (args.includes('--file')) {
  text = readFileSync(args[args.indexOf('--file') + 1], 'utf-8');
} else if (args.length > 0 && args[0] !== '-') {
  text = args.join(' ').replace(/\\n/g, '\n');
} else {
  // Read from stdin
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  text = Buffer.concat(chunks).toString('utf-8');
}

if (!text?.trim()) {
  console.error('Usage: node slack-clip.js "**Bold** text\\n- bullet"');
  process.exit(1);
}

text = humanize(text);

const delta = textToDelta(text);
const deltaJson = JSON.stringify(delta);
const plainText = text.replace(/\*\*/g, '').replace(/\*/g, '').replace(/`/g, '').replace(/\[(.+?)\]\(.+?\)/g, '$1');
const payload = encodeCustomMime([['public.utf8-plain-text', plainText], ['slack/texty', deltaJson]]);

const tmpBin = join(tmpdir(), 'slack-clip.bin');
const tmpTxt = join(tmpdir(), 'slack-clip.txt');
const tmpPs = join(tmpdir(), 'slack-clip.ps1');
writeFileSync(tmpBin, payload);
writeFileSync(tmpTxt, plainText, 'utf-8');
writeFileSync(tmpPs, `
Add-Type -AssemblyName System.Windows.Forms
$bytes = [System.IO.File]::ReadAllBytes('${tmpBin.replace(/\\/g, '\\\\')}')
$plainText = [System.IO.File]::ReadAllText('${tmpTxt.replace(/\\/g, '\\\\')}')
$ms = New-Object System.IO.MemoryStream(,$bytes)
$dataObj = New-Object System.Windows.Forms.DataObject
$dataObj.SetData('Chromium Web Custom MIME Data Format', $ms)
$dataObj.SetData('UnicodeText', $plainText)
for ($i = 0; $i -lt 5; $i++) {
  try { [System.Windows.Forms.Clipboard]::SetDataObject($dataObj, $true); break }
  catch { Start-Sleep -Milliseconds 200 }
}
`, 'utf-8');
execSync(`powershell -ExecutionPolicy Bypass -STA -File "${tmpPs}"`);
unlinkSync(tmpBin);
unlinkSync(tmpTxt);
unlinkSync(tmpPs);

// Preview what was formatted
const preview = plainText.substring(0, 120).replace(/\n/g, ' ↵ ');
console.log('');
console.log('📋 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`✅ Slack-ready! Ctrl+V to paste.`);
console.log(`📝 ${preview}${plainText.length > 120 ? '...' : ''}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');


notify({ message: 'Slack clip ready' });
