#!/usr/bin/env node
/**
 * outlook-lens.js — Parse Outlook Web App multi-mail clipboard into structured summary.
 *
 * When you select multiple emails in OWA and drag/copy, the browser puts a
 * "Web Custom Format0" entry on the clipboard containing JSON metadata:
 *   { itemType, subjects[], sizes[], rowKeys[], latestItemIds[], mailboxInfos[] }
 *
 * This script extracts actionable info WITHOUT reading mail bodies:
 *   - Subject lines
 *   - JIRA keys (e.g. PROJ-123)
 *   - Action flags ([Action needed], [FYA], Reminder, Mandatory, deadline)
 *   - Categories (confluence, github PR, jira-update, meeting, newsletter, admin)
 *
 * Output: tmp/email-summary.txt (relative to script directory)
 *
 * Usage:
 *   clipemail-read          # reads clipboard, writes summary
 *   node src/outlook-lens.js
 */
import { execSync } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const SCRIPT_DIR = import.meta.dirname;
const TMP_DIR = join(SCRIPT_DIR, '..', 'tmp');
const OUTPUT_FILE = join(TMP_DIR, 'email-summary.txt');

// --- Clipboard reading (PowerShell STA) ---

function readClipboardFormat(formatName) {
  const ps = `
Add-Type -AssemblyName System.Windows.Forms
$data = [System.Windows.Forms.Clipboard]::GetDataObject()
if ($data -and $data.GetDataPresent('${formatName}')) {
  $stream = $data.GetData('${formatName}')
  if ($stream -is [System.IO.Stream]) {
    $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
    $text = $reader.ReadToEnd()
    $reader.Close()
    Write-Host $text
  } elseif ($stream -is [string]) {
    Write-Host $stream
  } else {
    Write-Host "UNSUPPORTED_TYPE"
  }
} else {
  Write-Host "FORMAT_NOT_FOUND"
}
`;
  try {
    const result = execSync(
      `powershell -ExecutionPolicy Bypass -STA -Command "${ps.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`,
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
    ).trim();
    return result;
  } catch (err) {
    return null;
  }
}

// --- Categorization ---

const JIRA_KEY_RE = /[A-Z][A-Z0-9]+-\d+/g;

const ACTION_PATTERNS = [
  { re: /\[action needed[:\]]/i, label: 'Action needed' },
  { re: /\[FYA[:\]]/i, label: 'FYA' },
  { re: /\breminder\b/i, label: 'Reminder' },
  { re: /\bmandatory\b/i, label: 'Mandatory' },
  { re: /\bdeadline\b/i, label: 'Deadline' },
  { re: /\burgent\b/i, label: 'Urgent' },
];

function detectCategory(subject) {
  const s = subject.toLowerCase();
  if (/\bconfluence\b/.test(s) || /page (created|updated|edited)/.test(s)) return 'confluence';
  if (/\bpull request\b/.test(s) || /\bPR #?\d+/.test(subject) || /\[.*\].*PR/.test(subject)) return 'github-pr';
  if (JIRA_KEY_RE.test(subject)) return 'jira-update';
  if (/\bmeeting\b/.test(s) || /\bsync\b/.test(s) || /\bworkshop\b/.test(s) || /\bmonthly\b/.test(s) || /\bweekly\b/.test(s)) return 'meeting';
  if (/\bnewsletter\b/.test(s) || /\bdigest\b/.test(s) || /\bannouncement\b/.test(s)) return 'newsletter';
  if (/\badmin\b/.test(s) || /\bexpense\b/.test(s) || /\btimesheet\b/.test(s) || /\bCATS\b/.test(subject) || /\bVBS\b/.test(subject)) return 'admin';
  return 'other';
}

function detectActions(subject) {
  const flags = [];
  for (const { re, label } of ACTION_PATTERNS) {
    if (re.test(subject)) flags.push(label);
  }
  return flags;
}

function extractJiraKeys(subject) {
  const matches = subject.match(JIRA_KEY_RE);
  return matches ? [...new Set(matches)] : [];
}

// --- Main ---

function parseOutlookClip(raw) {
  if (!raw || raw === 'FORMAT_NOT_FOUND' || raw === 'UNSUPPORTED_TYPE') {
    return null;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    // Sometimes the format contains a URL-encoded JSON or wrapper
    // Try to find JSON within the string
    const jsonStart = raw.indexOf('{');
    const jsonEnd = raw.lastIndexOf('}');
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      try {
        data = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
      } catch {
        return null;
      }
    } else {
      return null;
    }
  }

  // Validate structure — we need at least subjects
  const subjects = data.subjects || data.subject || [];
  if (!Array.isArray(subjects) || subjects.length === 0) {
    return null;
  }

  const sizes = data.sizes || [];

  // Process each subject
  const emails = subjects.map((subject, i) => {
    const sizeKB = sizes[i] ? Math.round(sizes[i] / 1024) : null;
    const jiraKeys = extractJiraKeys(subject);
    const actions = detectActions(subject);
    const category = detectCategory(subject);
    return { subject, sizeKB, jiraKeys, actions, category, index: i + 1 };
  });

  return { emails, totalCount: emails.length, raw: data };
}

function buildOutput(parsed) {
  const { emails, totalCount } = parsed;
  const now = new Date().toISOString().replace(/\.\d+Z$/, '');
  const lines = [];

  lines.push(`=== Outlook Clip: ${totalCount} emails ===`);
  lines.push(`Captured: ${now}`);
  lines.push('');

  // Action required
  const actionEmails = emails.filter(e => e.actions.length > 0);
  if (actionEmails.length > 0) {
    lines.push('## Action Required');
    for (const e of actionEmails) {
      const prefix = e.actions.map(a => `[${a}]`).join(' ');
      lines.push(`- ${prefix} ${e.subject}`);
    }
    lines.push('');
  }

  // JIRA updates
  const jiraEmails = emails.filter(e => e.category === 'jira-update');
  if (jiraEmails.length > 0) {
    lines.push(`## JIRA Updates (${jiraEmails.length})`);
    for (const e of jiraEmails) {
      const keys = e.jiraKeys.join(', ');
      lines.push(`- ${keys}: ${e.subject}`);
    }
    lines.push('');
  }

  // Meetings
  const meetings = emails.filter(e => e.category === 'meeting');
  if (meetings.length > 0) {
    lines.push(`## Meetings (${meetings.length})`);
    for (const e of meetings) {
      lines.push(`- ${e.subject}`);
    }
    lines.push('');
  }

  // GitHub PRs
  const prs = emails.filter(e => e.category === 'github-pr');
  if (prs.length > 0) {
    lines.push(`## GitHub PRs (${prs.length})`);
    for (const e of prs) {
      lines.push(`- ${e.subject}`);
    }
    lines.push('');
  }

  // Confluence
  const confluence = emails.filter(e => e.category === 'confluence');
  if (confluence.length > 0) {
    lines.push(`## Confluence (${confluence.length})`);
    for (const e of confluence) {
      lines.push(`- ${e.subject}`);
    }
    lines.push('');
  }

  // Newsletter / Admin
  const newsletters = emails.filter(e => e.category === 'newsletter');
  if (newsletters.length > 0) {
    lines.push(`## Newsletters (${newsletters.length})`);
    for (const e of newsletters) {
      lines.push(`- ${e.subject}`);
    }
    lines.push('');
  }

  const admin = emails.filter(e => e.category === 'admin');
  if (admin.length > 0) {
    lines.push(`## Admin (${admin.length})`);
    for (const e of admin) {
      lines.push(`- ${e.subject}`);
    }
    lines.push('');
  }

  // All subjects (numbered)
  lines.push('## All Subjects');
  for (const e of emails) {
    const sizeStr = e.sizeKB ? ` (${e.sizeKB} KB)` : '';
    lines.push(`${e.index}. ${e.subject}${sizeStr}`);
  }
  lines.push('');

  // Stats footer
  const allJiraKeys = [...new Set(emails.flatMap(e => e.jiraKeys))];
  const categories = {};
  for (const e of emails) {
    categories[e.category] = (categories[e.category] || 0) + 1;
  }
  lines.push('---');
  lines.push(`Total: ${totalCount} | Actions: ${actionEmails.length} | JIRA keys: ${allJiraKeys.length} | PRs: ${prs.length} | Meetings: ${meetings.length}`);

  return lines.join('\n');
}

function printTerminalSummary(parsed) {
  const { emails, totalCount } = parsed;
  const actionEmails = emails.filter(e => e.actions.length > 0);
  const allJiraKeys = [...new Set(emails.flatMap(e => e.jiraKeys))];
  const categories = {};
  for (const e of emails) {
    categories[e.category] = (categories[e.category] || 0) + 1;
  }

  console.log(`\n📧 Outlook Clip: ${totalCount} emails parsed`);
  console.log(`   Actions: ${actionEmails.length} | JIRA keys: ${allJiraKeys.length}`);

  const topCats = Object.entries(categories)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([cat, n]) => `${cat}(${n})`)
    .join(', ');
  console.log(`   Categories: ${topCats}`);

  if (actionEmails.length > 0) {
    console.log('\n   ⚡ Action items:');
    for (const e of actionEmails.slice(0, 5)) {
      console.log(`      - ${e.subject}`);
    }
    if (actionEmails.length > 5) {
      console.log(`      ... and ${actionEmails.length - 5} more`);
    }
  }

  console.log(`\n   → ${OUTPUT_FILE}`);
}

// --- Entry point ---

function main() {
  // Try "Web Custom Format0" first (OWA drag format)
  let raw = readClipboardFormat('Web Custom Format0');

  // Fallback: try other known OWA formats
  if (!raw || raw === 'FORMAT_NOT_FOUND') {
    raw = readClipboardFormat('application/x-openwebapp-dragdata');
  }

  if (!raw || raw === 'FORMAT_NOT_FOUND' || raw === 'UNSUPPORTED_TYPE') {
    console.error('❌ No Outlook Web clipboard data found.');
    console.error('   Select emails in OWA, then drag or copy them before running this.');
    console.error('   Expected format: "Web Custom Format0" or "application/x-openwebapp-dragdata"');
    process.exit(1);
  }

  const parsed = parseOutlookClip(raw);
  if (!parsed) {
    console.error('❌ Could not parse clipboard data as Outlook email metadata.');
    console.error('   The clipboard contains data but not in the expected OWA format.');
    console.error('   Tip: make sure you selected emails (not text) in Outlook Web.');
    process.exit(1);
  }

  // Ensure tmp/ exists
  mkdirSync(TMP_DIR, { recursive: true });

  // Write output file
  const output = buildOutput(parsed);
  writeFileSync(OUTPUT_FILE, output, 'utf-8');

  // Terminal summary
  printTerminalSummary(parsed);
}

main();
