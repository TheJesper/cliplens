#!/usr/bin/env node
/**
 * check-updates.mjs — is the installed ClipLens behind the repo?
 *
 * The skill runs this at session start. It reads the central registry
 * (~/.cliplens/install.json — written by install.mjs, records where the repo
 * lives + which version was installed), reads the repo's current version.json,
 * and compares. Output is a single line the agent can act on:
 *
 *   UP_TO_DATE     0.2.0
 *   UPDATE         installed=0.2.0 repo=0.3.0  (skill 2 -> 3)
 *   NOT_INSTALLED  (no registry — run tools/install.mjs)
 *
 * With --json it prints a machine-readable object instead.
 * Never throws for the caller: exits 0 always, so a stale check can't break a
 * clip. The agent decides whether to surface "there's a new version".
 */
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { REGISTRY_FILE } from './lib/clients.mjs';

const AS_JSON = process.argv.includes('--json');
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

/** semver-ish compare: returns 1 if a>b, -1 if a<b, 0 if equal. Missing => 0.0.0. */
function cmp(a = '0.0.0', b = '0.0.0') {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

const repo = readJson(join(REPO_ROOT, 'version.json')) || { version: '0.0.0', skillVersion: '0' };
const reg = existsSync(REGISTRY_FILE) ? readJson(REGISTRY_FILE) : null;

let result;
if (!reg) {
  result = {
    status: 'NOT_INSTALLED',
    repoVersion: repo.version,
    message: 'ClipLens is not registered on this machine. Run: node tools/install.mjs',
  };
} else {
  const behind = cmp(repo.version, reg.version) > 0;
  const skillBehind = cmp(repo.skillVersion, reg.skillVersion) > 0;
  if (behind || skillBehind) {
    const change = repo.changelog?.[repo.version] || '';
    result = {
      status: 'UPDATE',
      installedVersion: reg.version,
      repoVersion: repo.version,
      installedSkill: reg.skillVersion,
      repoSkill: repo.skillVersion,
      repoRoot: reg.repoRoot,
      changelog: change,
      message: `A newer ClipLens is available (installed ${reg.version} → repo ${repo.version}). Update with: node "${join(reg.repoRoot || REPO_ROOT, 'tools', 'install.mjs')}"`,
    };
  } else {
    result = {
      status: 'UP_TO_DATE',
      version: reg.version,
      repoRoot: reg.repoRoot,
      message: `ClipLens ${reg.version} is up to date.`,
    };
  }
}

if (AS_JSON) {
  console.log(JSON.stringify(result, null, 2));
} else if (result.status === 'UPDATE') {
  console.log(`UPDATE  installed=${result.installedVersion} repo=${result.repoVersion} (skill ${result.installedSkill} -> ${result.repoSkill})`);
  if (result.changelog) console.log(`        ${result.changelog}`);
  console.log(`        ${result.message}`);
} else if (result.status === 'NOT_INSTALLED') {
  console.log(`NOT_INSTALLED  ${result.message}`);
} else {
  console.log(`UP_TO_DATE  ${result.version}`);
}

process.exit(0);
