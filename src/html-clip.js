#!/usr/bin/env node
/**
 * html-clip: Format markdown text as rich HTML and write to clipboard.
 * Works with: Outlook, Teams, Google Docs, Notion, Word — anything that reads HTML paste.
 *
 * Usage:
 *   clipmail --file message.md
 *   clipmail "**Bold** and `code`"
 */
import { writeFileSync, readFileSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { notify } from './notify.js';

/** Simple markdown → HTML converter */
function markdownToHtml(text) {
  let html = text;

  // Code blocks (``` fenced)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
    `<pre style="background:#f4f4f4;padding:12px;border-radius:4px;font-family:Consolas,monospace;font-size:13px;overflow-x:auto"><code>${code.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre>`
  );

  // Process line by line for lists
  const lines = html.split('\n');
  let result = [];
  let inList = null; // 'ul' or 'ol'

  for (const line of lines) {
    // Bullet list
    if (/^[-•]\s/.test(line)) {
      if (inList !== 'ul') { if (inList) result.push(`</${inList}>`); result.push('<ul>'); inList = 'ul'; }
      result.push(`<li>${processInline(line.replace(/^[-•]\s/, ''))}</li>`);
      continue;
    }
    // Numbered list
    if (/^\d+[.)]\s/.test(line)) {
      if (inList !== 'ol') { if (inList) result.push(`</${inList}>`); result.push('<ol>'); inList = 'ol'; }
      result.push(`<li>${processInline(line.replace(/^\d+[.)]\s/, ''))}</li>`);
      continue;
    }
    // End list
    if (inList && line.trim() === '') { result.push(`</${inList}>`); inList = null; result.push('<br>'); continue; }
    if (inList) { result.push(`</${inList}>`); inList = null; }

    // Empty line = paragraph break
    if (line.trim() === '') { result.push('<br>'); continue; }

    result.push(`<p style="margin:0 0 4px 0">${processInline(line)}</p>`);
  }
  if (inList) result.push(`</${inList}>`);

  return result.join('\n');
}

/** Process inline formatting */
function processInline(text) {
  // Bold: **text**
  text = text.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  // Italic: *text* or _text_
  text = text.replace(/\*(.+?)\*/g, '<i>$1</i>');
  text = text.replace(/_(.+?)_/g, '<i>$1</i>');
  // Code: `text`
  text = text.replace(/`(.+?)`/g, '<code style="background:#f0f0f0;padding:1px 4px;border-radius:3px;font-family:Consolas,monospace;font-size:13px">$1</code>');
  // Links: [text](url)
  text = text.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" style="color:#0563C1">$1</a>');
  return text;
}

/** Build Windows "HTML Format" clipboard payload */
function buildHtmlFormat(html) {
  const preamble = `Version:0.9\r\nStartHTML:SSSSSSSSSS\r\nEndHTML:EEEEEEEEEE\r\nStartFragment:FFFFFFFFFF\r\nEndFragment:GGGGGGGGGG\r\n`;
  const prefix = `<html><body><!--StartFragment-->`;
  const suffix = `<!--EndFragment--></body></html>`;
  const full = preamble + prefix + html + suffix;

  const startHtml = preamble.length;
  const startFragment = startHtml + prefix.length;
  const endFragment = startFragment + html.length;
  const endHtml = endFragment + suffix.length;

  return full
    .replace('SSSSSSSSSS', String(startHtml).padStart(10, '0'))
    .replace('EEEEEEEEEE', String(endHtml).padStart(10, '0'))
    .replace('FFFFFFFFFF', String(startFragment).padStart(10, '0'))
    .replace('GGGGGGGGGG', String(endFragment).padStart(10, '0'));
}

// Get input
let text;
const args = process.argv.slice(2);

if (args.includes('--file')) {
  text = readFileSync(args[args.indexOf('--file') + 1], 'utf-8');
} else if (args.length > 0 && args[0] !== '-') {
  text = args.join(' ').replace(/\\n/g, '\n');
} else {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  text = Buffer.concat(chunks).toString('utf-8');
}

if (!text?.trim()) {
  console.error('Usage: clipmail "**Bold** text\\n- bullet" or clipmail --file msg.md');
  process.exit(1);
}

// Sanitize AI-isms
text = text
  .replace(/—/g, '-').replace(/–/g, '-')
  .replace(/\u201C/g, '"').replace(/\u201D/g, '"')
  .replace(/\u2018/g, "'").replace(/\u2019/g, "'")
  .replace(/\u2026/g, '...').replace(/\u00A0/g, ' ')
  .replace(/\u200B/g, '').replace(/\uFEFF/g, '');

const html = markdownToHtml(text);
const htmlFormat = buildHtmlFormat(html);
const plainText = text.replace(/\*\*/g, '').replace(/\*/g, '').replace(/_/g, '').replace(/`/g, '').replace(/\[(.+?)\]\(.+?\)/g, '$1');

// Write to clipboard with both HTML Format and plain text
const tmpHtml = join(tmpdir(), 'clipmail.html');
const tmpTxt = join(tmpdir(), 'clipmail.txt');
const tmpPs = join(tmpdir(), 'clipmail.ps1');
writeFileSync(tmpHtml, htmlFormat, 'utf-8');
writeFileSync(tmpTxt, plainText, 'utf-8');
writeFileSync(tmpPs, `
Add-Type -AssemblyName System.Windows.Forms
$htmlBytes = [System.IO.File]::ReadAllBytes('${tmpHtml.replace(/\\/g, '\\\\')}')
$plainText = [System.IO.File]::ReadAllText('${tmpTxt.replace(/\\/g, '\\\\')}')
$ms = New-Object System.IO.MemoryStream(,$htmlBytes)
$dataObj = New-Object System.Windows.Forms.DataObject
$dataObj.SetData('HTML Format', $ms)
$dataObj.SetData('UnicodeText', $plainText)
for ($i = 0; $i -lt 5; $i++) {
  try { [System.Windows.Forms.Clipboard]::SetDataObject($dataObj, $true); break }
  catch { Start-Sleep -Milliseconds 200 }
}
`);
execSync(`powershell -ExecutionPolicy Bypass -STA -File "${tmpPs}"`);
unlinkSync(tmpHtml);
unlinkSync(tmpTxt);
unlinkSync(tmpPs);

const preview = plainText.substring(0, 120).replace(/\n/g, ' ↵ ');
console.log('');
console.log('📋 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`✅ HTML-ready! Ctrl+V in Outlook/Teams/Docs.`);
console.log(`📝 ${preview}${plainText.length > 120 ? '...' : ''}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

notify({ message: 'HTML clip ready' });
