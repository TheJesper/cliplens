#!/usr/bin/env node
/**
 * install-hooks.mjs — installs the ClipLens git hooks.
 *
 * Writes .git/hooks/pre-commit and .git/hooks/pre-push, both of which run
 * tools/check-no-secrets.mjs to block company/internal data from entering the
 * public repo. Idempotent for its own hooks; a hook it did not write is left alone, and it only acts
 * inside the ClipLens repo itself (not when installed as a dependency of another project).
 *
 * Run:  node tools/install-hooks.mjs   (also runs automatically via npm "prepare")
 */
import { writeFileSync, readFileSync, chmodSync, existsSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let gitDir;
try {
  const top = execSync('git rev-parse --show-toplevel', { encoding: 'utf8', cwd: pkgRoot }).trim();
  if (resolve(top).toLowerCase() !== pkgRoot.toLowerCase()) {
    console.log('ClipLens is inside another git repo - not touching its hooks.');
    process.exit(0);
  }
  const hp = execSync('git config --get core.hooksPath', { encoding: 'utf8', cwd: pkgRoot, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (hp) {
    console.log(`core.hooksPath is set (${hp}) - add tools/check-no-secrets.mjs to your own hooks there.`);
    process.exit(0);
  }
} catch { /* no hooksPath set: fine */ }
try {
  gitDir = resolve(pkgRoot, execSync('git rev-parse --git-dir', { encoding: 'utf8', cwd: pkgRoot }).trim());
} catch {
  console.error('Not a git repo — skipping hook install.');
  process.exit(0); // don't fail npm install outside a repo
}

const hooksDir = join(gitDir, 'hooks');
if (!existsSync(hooksDir)) mkdirSync(hooksDir, { recursive: true });

// POSIX sh works for Git Bash on Windows and Unix alike.
const script = `#!/bin/sh
# ClipLens hook — blocks company/internal data from reaching the public repo.
node tools/check-no-secrets.mjs || exit 1
`;

for (const hook of ['pre-commit', 'pre-push']) {
  const path = join(hooksDir, hook);
  if (existsSync(path) && !readFileSync(path, 'utf8').includes('# ClipLens hook')) {
    console.log(`kept your own ${hook} (add "node tools/check-no-secrets.mjs" to it yourself)`);
    continue;
  }
  writeFileSync(path, script, { encoding: 'utf8' });
  try { chmodSync(path, 0o755); } catch { /* Windows: ignore */ }
  console.log(`installed ${hook}`);
}
console.log('✓ ClipLens git hooks installed (pre-commit + pre-push run the no-secrets scan).');
