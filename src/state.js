/**
 * state.js -- ClipLens local config + runtime toggles (the central config hub).
 *
 * WHY THIS EXISTS:
 *  - Some settings must be togglable at RUNTIME, without editing mcp.json or
 *    restarting the client.
 *  - They must be LOCAL: a user's choices are per-machine, never committed.
 *    The repo default is always the privacy-first / safe value.
 *
 * WHERE IT LIVES: ~/.cliplens/state.json -- same home-dir folder as history,
 * completely outside the git repo (gitignored), so nothing here is checked in.
 *
 * CONFIG KEYS (this is the one place to add new ones — see CONFIG_KEYS below):
 *   history      bool    clip cache on/off        (default OFF)  env: CLIPLENS_HISTORY
 *   imageDir     string  where clip images save   (default OS temp) env: CLIPLENS_IMAGE_DIR
 *   askImageDir  bool    ask user for image dir?   (default OFF)
 *   remindCache  bool    show the "cache is off" reminder? (default ON)
 *   -- FUTURE: add reminder2, reminder3, ... here as simple keys. --
 *
 * PRECEDENCE (for any setting that also has an env override):
 *   1. env var (if explicitly set)  -- wins, for CI / power users
 *   2. local state.json value       -- the runtime toggle
 *   3. built-in default             -- safe / privacy-first, matches the repo
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/**
 * Registry of known config keys — kind + default + optional env override.
 * Adding a new toggle/reminder? Add one row here and a thin accessor below.
 * Keeping them listed in one place makes the config self-documenting and lets
 * configSummary() report everything without hunting through the codebase.
 */
export const CONFIG_KEYS = {
  history:     { kind: 'bool',   default: false, env: 'CLIPLENS_HISTORY' },
  imageDir:    { kind: 'string', default: null,  env: 'CLIPLENS_IMAGE_DIR' },
  askImageDir: { kind: 'bool',   default: false },
  remindCache: { kind: 'bool',   default: true },
};

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

/**
 * Resolve where clipboard images are saved. Precedence:
 *   1. env CLIPLENS_IMAGE_DIR (if set)      -- CI / power users
 *   2. local state.json { imageDir }        -- the user's configured folder
 *   3. OS temp dir (os.tmpdir())            -- cross-platform default
 * Never returns the repo. The chosen dir is created by the caller if needed.
 */
export async function imageDir() {
  const env = process.env.CLIPLENS_IMAGE_DIR;
  if (env && env.trim()) return env.trim();
  const saved = readState().imageDir;
  if (saved && String(saved).trim()) return String(saved).trim();
  const { tmpdir } = await import('os');
  return tmpdir();
}

/**
 * Should the agent ASK the user which temp folder to use for images?
 * Controlled by local state.json { askImageDir: true }. Off by default, so the
 * cross-platform temp dir is used silently unless the user opts into being asked.
 * This is purely local (never committed) — same file as the cache toggle.
 */
export function shouldAskImageDir() {
  return readState().askImageDir === true;
}

/**
 * Reminder 1: should we nudge that the clip cache is OFF? Defaults ON, so users
 * learn they can enable reclip; they can silence it with { remindCache: false }.
 * FUTURE reminders (reminder2, ...) follow this exact shape: a bool key in
 * CONFIG_KEYS + a thin accessor here that defaults sensibly.
 */
export function shouldRemindCache() {
  return readState().remindCache !== false; // default ON unless explicitly off
}

/**
 * A readable snapshot of all config (effective values + where each came from).
 * Powers a future "/cliplens config" listing. Env is not resolved for imageDir
 * here to avoid an async import; callers that need the live dir use imageDir().
 */
export function configSummary() {
  const st = readState();
  const out = {};
  for (const [key, spec] of Object.entries(CONFIG_KEYS)) {
    const envSet = spec.env ? process.env[spec.env] : undefined;
    const hasEnv = envSet !== undefined && String(envSet).trim() !== '';
    const hasLocal = key in st;
    out[key] = {
      value: hasEnv ? envSet : (hasLocal ? st[key] : spec.default),
      source: hasEnv ? `env ${spec.env}` : (hasLocal ? 'local' : 'default'),
    };
  }
  return out;
}
