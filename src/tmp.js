/**
 * tmp.js — safe temp-file helpers.
 *
 * SECURITY: temp files must be UNPREDICTABLE and owner-only. A fixed name like
 * `cliplens-slack.md` in a world-writable temp dir is a classic symlink / race
 * target (another user pre-creates or swaps the path). Two rules:
 *   1. Random name (crypto.randomUUID) so it can't be pre-created / guessed.
 *   2. mode 0o600 so only the current user can read/write it (no-op-ish on
 *      Windows ACLs but correct + free on POSIX, and future-proofs the mac/linux
 *      port).
 * Always clean up in a finally.
 */
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

/** Build an unpredictable temp path: <tmp>/cliplens-<uuid><ext>. */
export function tmpPath(ext = '') {
  return join(tmpdir(), `cliplens-${randomUUID()}${ext}`);
}

/**
 * Write data to a fresh, owner-only temp file and return its path.
 * @param {string|Buffer} data
 * @param {string} [ext] e.g. '.ps1', '.md', '.bin'
 */
export function writeTmp(data, ext = '') {
  const p = tmpPath(ext);
  writeFileSync(p, data, { mode: 0o600 });
  return p;
}

/** Best-effort delete; never throws (file may already be gone). */
export function rmTmp(p) {
  try { if (p) unlinkSync(p); } catch { /* already gone */ }
}
