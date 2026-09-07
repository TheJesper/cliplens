#!/usr/bin/env node
/**
 * install.mjs — the universal ClipLens installer.
 *
 * Detects every AI client on this machine (Kiro, Claude Code, Claude Desktop,
 * VS Code Copilot, Cursor, Windsurf, Codex, Gemini) and wires ClipLens into
 * each one, in that client's native format:
 *   - MCP config  (JSON mcpServers | JSON servers | TOML mcp_servers)
 *   - skill/rules (flat .md | folder/SKILL.md | .mdc rule | AGENTS.md)
 *
 * It also records what it did (and where this repo lives + which version) in a
 * central registry at ~/.cliplens/install.json, so the update-checker can later
 * tell an agent "there's a newer ClipLens — want to update?".
 *
 * Usage:
 *   node tools/install.mjs                 # install into every detected client
 *   node tools/install.mjs --only kiro,cursor
 *   node tools/install.mjs --dry-run       # show what would change, write nothing
 *   node tools/install.mjs --list          # list detected clients and exit
 *
 * Idempotent: merges into existing configs, overwrites the ClipLens entries,
 * never touches other servers/skills. Safe to re-run after every git pull.
 */
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, statSync,
} from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { CLIENTS, REGISTRY_DIR, REGISTRY_FILE, mcpEntry } from './lib/clients.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER_NAME = 'cliplens';

// ---- args -----------------------------------------------------------------
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const LIST = argv.includes('--list');
const onlyIdx = argv.indexOf('--only');
const ONLY = onlyIdx >= 0 && argv[onlyIdx + 1]
  ? new Set(argv[onlyIdx + 1].split(',').map((s) => s.trim()))
  : null;

// ---- helpers ---------------------------------------------------------------
const log = (...a) => console.log(...a);
const changes = [];

function readVersion() {
  try {
    return JSON.parse(readFileSync(join(REPO_ROOT, 'version.json'), 'utf8'));
  } catch {
    return { version: '0.0.0', skillVersion: '0' };
  }
}

function clientPresent(c) {
  return c.detect.some((p) => existsSync(p));
}

function ensureDir(file) {
  const d = dirname(file);
  if (!existsSync(d)) {
    if (!DRY) mkdirSync(d, { recursive: true });
  }
}

function readJson(file) {
  if (!existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; }
}

// ---- MCP writers (one per format) -----------------------------------------
function writeMcpJson(file, key) {
  const cfg = readJson(file);
  if (!cfg[key] || typeof cfg[key] !== 'object') cfg[key] = {};
  const entry = mcpEntry(REPO_ROOT);
  // VS Code ("servers") uses type:"stdio"; harmless elsewhere but keep it clean.
  cfg[key][SERVER_NAME] = key === 'servers'
    ? { type: 'stdio', ...entry }
    : entry;
  ensureDir(file);
  if (!DRY) writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  changes.push(`MCP  → ${file} (${key}.${SERVER_NAME})`);
}

function writeMcpToml(file) {
  const serverPath = join(REPO_ROOT, 'src', 'mcp-server.js').replace(/\\/g, '\\\\');
  const block = [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = "node"`,
    `args = ["${serverPath}"]`,
    '',
  ].join('\n');
  let out;
  if (existsSync(file)) {
    let cur = readFileSync(file, 'utf8');
    const re = new RegExp(`\\[mcp_servers\\.${SERVER_NAME}\\][\\s\\S]*?(?=\\n\\[|$)`, 'g');
    out = re.test(cur) ? cur.replace(re, block) : `${cur.trimEnd()}\n\n${block}`;
  } else {
    out = block;
  }
  ensureDir(file);
  if (!DRY) writeFileSync(file, out, 'utf8');
  changes.push(`MCP  → ${file} ([mcp_servers.${SERVER_NAME}])`);
}

// ---- skill writers (one per kind) -----------------------------------------
function skillBody() {
  return readFileSync(join(REPO_ROOT, 'SKILL.md'), 'utf8');
}

function writeSkill(c) {
  if (!c.skillKind || !c.userSkill) return; // client has no skill surface
  const body = skillBody();
  let target;
  switch (c.skillKind) {
    case 'flat-md':
      target = join(c.userSkill, `${SERVER_NAME}.md`);
      ensureDir(target);
      if (!DRY) writeFileSync(target, body, 'utf8');
      break;
    case 'folder':
      target = join(c.userSkill, SERVER_NAME, 'SKILL.md');
      ensureDir(target);
      if (!DRY) writeFileSync(target, body, 'utf8');
      break;
    case 'rules-mdc': {
      // Cursor rule: needs frontmatter with description + alwaysApply.
      target = join(c.userSkill, `${SERVER_NAME}.mdc`);
      const mdc = [
        '---',
        'description: ClipLens — read/write the system clipboard in native app formats (Slack, Mural, Outlook/Teams, Figma). Default plaintext; formatting opt-in.',
        'alwaysApply: false',
        '---',
        '',
        body,
      ].join('\n');
      ensureDir(target);
      if (!DRY) writeFileSync(target, mdc, 'utf8');
      break;
    }
    default:
      return;
  }
  changes.push(`skill→ ${target}`);
}

// ---- registry (repo location + installed version) -------------------------
function writeRegistry(installed, ver) {
  if (!existsSync(REGISTRY_DIR) && !DRY) mkdirSync(REGISTRY_DIR, { recursive: true });
  const record = {
    repoRoot: REPO_ROOT,
    version: ver.version,
    skillVersion: ver.skillVersion,
    installedAt: new Date().toISOString(),
    clients: installed.map((c) => ({
      id: c.id, label: c.label, mcp: c.userMcp, skill: c.userSkill || null,
    })),
  };
  if (!DRY) writeFileSync(REGISTRY_FILE, JSON.stringify(record, null, 2) + '\n', 'utf8');
  changes.push(`registry → ${REGISTRY_FILE} (repoRoot + version ${ver.version})`);
}

// ---- main ------------------------------------------------------------------
const ver = readVersion();
const detected = CLIENTS.filter(clientPresent);
const targets = detected.filter((c) => !ONLY || ONLY.has(c.id));

if (LIST) {
  log(`ClipLens ${ver.version} — detected clients:\n`);
  for (const c of CLIENTS) {
    log(`  ${clientPresent(c) ? '✅' : '  '} ${c.id.padEnd(16)} ${c.label}`);
  }
  process.exit(0);
}

log(`ClipLens ${ver.version} installer${DRY ? ' (dry-run)' : ''}`);
log(`repo: ${REPO_ROOT}\n`);

if (targets.length === 0) {
  log('No matching AI clients detected. Nothing to do.');
  log('Tip: run `node tools/install.mjs --list` to see what was probed.');
  process.exit(0);
}

for (const c of targets) {
  log(`• ${c.label}`);
  if (c.mcpFormat === 'toml') writeMcpToml(c.userMcp);
  else writeMcpJson(c.userMcp, c.mcpFormat); // 'mcpServers' or 'servers'
  writeSkill(c);
}

writeRegistry(targets, ver);

log('');
if (DRY) {
  log('Would apply:');
} else {
  log('Applied:');
}
for (const ch of changes) log(`  ${ch}`);

log('');
log(DRY
  ? 'Dry-run only — nothing written. Re-run without --dry-run to apply.'
  : `Done. Restart your AI client(s) so they pick up the new MCP server. Re-run this after every \`git pull\` to stay current.`);
