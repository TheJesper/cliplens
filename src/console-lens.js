#!/usr/bin/env node
/**
 * Console Lens — Reads clipboard, strips noise, saves filtered output.
 * 
 * Usage:
 *   clipconsole              → read clip, filter, save to tmp/console-filtered.txt
 *   clipconsole --raw        → also save raw to tmp/console-raw.txt
 * 
 * Output: tmp/console-filtered.txt (relative to the project)
 * Agents: just read that file when user says "check console"
 */
import { execSync } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'tmp');
mkdirSync(outDir, { recursive: true });

// Get clipboard
const raw = execSync('powershell -command "Get-Clipboard -Raw"', { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });

if (process.argv.includes('--raw')) {
  writeFileSync(join(outDir, 'console-raw.txt'), raw, 'utf-8');
}

// Filter
const lines = raw.split(/\r?\n/);
const seen = new Set();
const signal = [];
const counts = {};

// Patterns to KEEP (signal)
const keepPatterns = [
  /\bCORS\b/i,
  /Access-Control/,
  /net::ERR_/,
  /\d{3}\s*\(/,  // HTTP status codes like "404 (Not Found)"
  /\b(GET|POST|PUT|DELETE|PATCH)\s+https?:/,
  /^Error/,
  /Error:/,
  /Failed to fetch/,
  /TypeError:/,
  /Uncaught/,
  /no-response.*url/,
  /Federated module/,
  /React error/,
  /^✅|^❌|^⚠️/,
  /peerDependencySDK/,
];

// Patterns to ALWAYS STRIP (noise)
const stripPatterns = [
  /^\s*\w{1,3}\s*@\s*app\.\w+\.bundle\.js:\d+$/,  // tc @ app...bundle.js:187
  /^\s*\w{1,3}\s*@\s*\w+\.\w+\.chunk\.js:\d+$/,    // ec @ chunk.js:N
  /^\s*postMessage$/,
  /^\s*await in \w+$/,
  /^\s*setTimeout$/,
  /^\s*Promise\.then$/,
  /^\s*network request$/,
  /^\s*attributes$/,
  /^_handle @/,
  /^await in _handle$/,
  /^_getResponse @/,
  /^await in _getResponse$/,
  /^handleAll @/,
  /^handle @/,
  /^handleRequest @/,
  /was preloaded using link preload but not used/,
];

// Patterns that are NOISE but we count
const noiseCountPatterns = [
  { pattern: /NG websocket got new message/, key: 'websocket_messages' },
  { pattern: /walkme_lib/, key: 'walkme_noise' },
  { pattern: /ccauth token util/, key: 'ccauth_logs' },
  { pattern: /Adobe Analytics/, key: 'adobe_analytics' },
  { pattern: /\[Violation\]/, key: 'violations' },
];

for (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed) continue;

  // Check noise counts
  let isCountedNoise = false;
  for (const { pattern, key } of noiseCountPatterns) {
    if (pattern.test(trimmed)) {
      counts[key] = (counts[key] || 0) + 1;
      isCountedNoise = true;
      break;
    }
  }
  if (isCountedNoise) continue;

  // Strip minified stack frames
  let isStripped = false;
  for (const p of stripPatterns) {
    if (p.test(trimmed)) { isStripped = true; break; }
  }
  if (isStripped) continue;

  // Keep signal lines (deduplicated)
  for (const p of keepPatterns) {
    if (p.test(trimmed)) {
      // Deduplicate by normalizing (remove timestamps/message IDs)
      const normalized = trimmed.replace(/\d{7,}/g, 'N');
      if (!seen.has(normalized)) {
        seen.add(normalized);
        signal.push(trimmed);
      }
      break;
    }
  }
}

// Build output
let output = `## Console Lens Output (${lines.length} lines → ${signal.length} unique signals)\n\n`;

if (signal.length === 0) {
  output += 'No errors or warnings found.\n';
} else {
  // Group by type
  const cors = signal.filter(l => /CORS|Access-Control/.test(l));
  const http = signal.filter(l => /\b(GET|POST|PUT|DELETE|PATCH)\s+https?:/.test(l) && !/CORS/.test(l));
  const errors = signal.filter(l => /Error:|TypeError:|Uncaught|Failed to fetch|Federated|React error/.test(l) && !/CORS/.test(l) && !/\b(GET|POST|PUT)\s+https?:/.test(l));
  const info = signal.filter(l => /^✅|peerDependencySDK/.test(l));
  const other = signal.filter(l => !cors.includes(l) && !http.includes(l) && !errors.includes(l) && !info.includes(l));

  if (info.length) {
    output += `### Info\n`;
    info.forEach(l => output += `  ${l}\n`);
    output += '\n';
  }
  if (cors.length) {
    output += `### CORS Blocked (${cors.length})\n`;
    cors.forEach(l => {
      const url = l.match(/https?:\/\/[^\s']+/)?.[0] || l;
      output += `  ❌ ${url}\n`;
    });
    output += '\n';
  }
  if (http.length) {
    output += `### HTTP Failures (${http.length})\n`;
    http.forEach(l => output += `  ❌ ${l.substring(0, 200)}\n`);
    output += '\n';
  }
  if (errors.length) {
    output += `### JS Errors (${errors.length})\n`;
    errors.forEach(l => output += `  ❌ ${l.substring(0, 200)}\n`);
    output += '\n';
  }
  if (other.length) {
    output += `### Other Signal (${other.length})\n`;
    other.forEach(l => output += `  ${l.substring(0, 200)}\n`);
    output += '\n';
  }
}

// Noise summary
if (Object.keys(counts).length) {
  output += `### Noise (filtered out)\n`;
  for (const [key, count] of Object.entries(counts)) {
    output += `  ℹ️ ${key}: ×${count}\n`;
  }
  output += '\n';
}

output += `---\nRaw: ${lines.length} lines, ${raw.length} chars\nFiltered: ${signal.length} unique signals\nReduction: ${Math.round((1 - signal.length / Math.max(lines.length, 1)) * 100)}%\n`;

writeFileSync(join(outDir, 'console-filtered.txt'), output, 'utf-8');
console.log(output);
console.log(`\n📄 Saved to: tmp/console-filtered.txt`);
