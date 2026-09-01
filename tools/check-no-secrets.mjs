#!/usr/bin/env node
/**
 * check-no-secrets.mjs — push gate for the public ClipLens repo.
 *
 * Scans all git-TRACKED files for company/internal markers that must never
 * reach the public repo. Exits non-zero (blocking the push) if any are found.
 *
 * Run manually:   node tools/check-no-secrets.mjs
 * Wired as:       .git/hooks/pre-push  (see tools/install-hooks.mjs)
 */
import { execSync } from 'child_process';
import { readFileSync } from 'fs';

// Patterns that indicate internal/company content (case-insensitive where sensible).
const PATTERNS = [
  { re: /\bCUCO-\d+/, label: 'Jira key (CUCO-xxxx)' },
  { re: /\bTECH-\d+/, label: 'Jira key (TECH-xxxx)' },
  { re: /\bVBCT-\d+/, label: 'Jira key (VBCT-xxxx)' },
  { re: /vgcs[-.]?\d|vgcs0959/i, label: 'VGCS mural/workspace id' },
  { re: /vgcs-jira|vgcs-confluence|it\.volvo\.net|vgt\.volvo\.com|vgthosting/i, label: 'Volvo internal URL' },
  { re: /\bu[0-9a-f]{20,}\b/, label: 'Mural owner id (u…)' },
  { re: /consultant\.volvo\.com|@volvo\.com/i, label: 'Volvo email' },
  { re: /app\.mural\.co\/t\/[a-z]*\d[a-z0-9]*\/m\//, label: 'specific Mural board link' },
];

// Files/dirs to skip even if tracked (docs may legitimately mention a term).
const SKIP = [/^\.gitignore$/, /^tools\/check-no-secrets\.mjs$/];

function tracked() {
  return execSync('git ls-files', { encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter(Boolean);
}

const hits = [];
for (const file of tracked()) {
  if (SKIP.some((r) => r.test(file))) continue;
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { continue; } // binary/unreadable
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const { re, label } of PATTERNS) {
      if (re.test(line)) hits.push({ file, line: i + 1, label, snippet: line.trim().slice(0, 80) });
    }
  });
}

if (hits.length) {
  console.error('\n\x1b[31m✖ PUSH BLOCKED — company/internal data found in tracked files:\x1b[0m\n');
  for (const h of hits) console.error(`  ${h.file}:${h.line}  [${h.label}]  ${h.snippet}`);
  console.error('\nRemove it, or move the file to a gitignored path (private-*/, *.local.md, tmp/).');
  console.error('Override for one push (not recommended):  git push --no-verify\n');
  process.exit(1);
}
console.log('✓ no-secrets check passed — no company data in tracked files.');
