/**
 * state.js -- local, machine-only toggles for ClipLens.
 *
 * WHY THIS EXISTS:
 *  - Some settings (like clip history / "cache") must be togglable at RUNTIME,
 *    without editing mcp.json or restarting the client.
 *  - They must be LOCAL: the fact that a user turned history ON is a per-machine
 *    choice, never committed. The repo default is always OFF.
 *
 * WHERE IT LIVES: ~/.cliplens/state.json  -- same home-dir folder as history,
 * completely outside the git repo, so nothing here is ever checked in.
 *
 *   { "history": true }   // history/cache toggled ON locally
 *
 * PRECEDENCE for a setting like history:
 *   1. env CLIPLENS_HISTORY (if explicitly set) -- wins, for CI / power users
 *   2. local state.json toggle                  -- the /cliplens cache on|off switch
 *   3. built-in default (OFF)                   -- privacy-first, repo default
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export function stateDir() {
  return join(homedir(), '.cliplens');
}

export function statePath() {
  return join(stateDir(), 'state.json');
}

/** Read the whole local state object. Never throws. */
export function readState() {
  try {
    return JSON.parse(readFileSync(statePath(), 'utf-8')) || {};
  } catch {
    return {};
  }
}

/** Write one key into local state (merges, never clobbers other keys). */
export function setState(key, value) {
  try {
    const dir = stateDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const cur = readState();
    cur[key] = value;
    writeFileSync(statePath(), JSON.stringify(cur, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/** Remove a key from local state (revert to default). */
export function clearStateKey(key) {
  try {
    const cur = readState();
    if (!(key in cur)) return true;
    delete cur[key];
    if (Object.keys(cur).length === 0) rmSync(statePath(), { force: true });
    else writeFileSync(statePath(), JSON.stringify(cur, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/** Parse an env flag as a tri-state: true | false | undefined (unset/blank). */
export function envFlag(name) {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const v = String(raw).trim().toLowerCase();
  if (v === '') return undefined;
  if (v === 'on' || v === '1' || v === 'true' || v === 'yes') return true;
  return false; // any other explicit value = off
}
