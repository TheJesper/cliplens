#!/usr/bin/env node
/**
 * install-hooks.mjs — installs the ClipLens git hooks.
 *
 * Writes .git/hooks/pre-commit and .git/hooks/pre-push, both of which run
 * tools/check-no-secrets.mjs to block company/internal data from entering the
 * public repo. Idempotent: overwrites the hooks each run.
 *
 * Run:  node tools/install-hooks.mjs   (also runs automatically via npm "prepare")
 */
import { writeFileSync, chmodSync, existsSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

let gitDir;
try {
  gitDir = execSync('git rev-parse --git-dir', { encoding: 'utf8' }).trim();
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
  writeFileSync(path, script, { encoding: 'utf8' });
  try { chmodSync(path, 0o755); } catch { /* Windows: ignore */ }
  console.log(`installed ${hook}`);
}
console.log('✓ ClipLens git hooks installed (pre-commit + pre-push run the no-secrets scan).');
