/**
 * history.js -- Agent-generated clip history (ring buffer).
 *
 * SECURITY MODEL:
 *  - OPT-IN. History is OFF by default. Nothing is written to disk unless the
 *    user turns it on with  CLIPLENS_HISTORY=on  (or =1/true/yes).
 *  - EPHEMERAL. Even when on, entries expire after CLIPLENS_HISTORY_TTL_MIN
 *    minutes (default 60) and are purged automatically on every read/append,
 *    so nothing sensitive lingers on disk for long.
 *  - This stores ONLY clips ClipLens itself generates (via the pens). It NEVER
 *    reads or stores the user's own Ctrl+C clipboard.
 *  - Clear everything at any time with clearHistory() (the /clip clear command).
 *
 * Storage: ~/.cliplens/history.json  (max MAX_ENTRIES, newest first)
 *
 * PAYLOAD-AGNOSTIC: every entry has a `format` and enough data to REPLAY the
 * clip exactly, with no regeneration (plain/slack/html/mural text, or image path,
 * or mural-widgets JSON with board context).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const MAX_ENTRIES = 10;

/** Is disk history enabled? OFF unless CLIPLENS_HISTORY is on/1/true/yes. */
export function historyEnabled() {
  const v = String(process.env.CLIPLENS_HISTORY || '').trim().toLowerCase();
  return v === 'on' || v === '1' || v === 'true' || v === 'yes';
}

/** TTL in minutes (default 60). 0 or negative disables expiry. */
function ttlMinutes() {
  const n = Number(process.env.CLIPLENS_HISTORY_TTL_MIN);
  return Number.isFinite(n) ? n : 60;
}

export function historyDir() {
  return join(homedir(), '.cliplens');
}

export function historyPath() {
  return join(historyDir(), 'history.json');
}

/** Drop entries older than the TTL. Returns the surviving list. */
function purgeExpired(entries) {
  const mins = ttlMinutes();
  if (!(mins > 0)) return entries;
  const cutoff = Date.now() - mins * 60 * 1000;
  return entries.filter((e) => {
    const t = Date.parse(e.ts || '');
    return Number.isFinite(t) ? t >= cutoff : false; // no/invalid ts -> expired
  });
}

/**
 * Read the history array (newest first). Never throws. Purges expired entries
 * (and writes the pruned list back so disk never holds stale/secret clips).
 */
export function readHistory() {
  try {
    const raw = readFileSync(historyPath(), 'utf-8');
    const data = JSON.parse(raw);
    const all = Array.isArray(data.entries) ? data.entries : [];
    const alive = purgeExpired(all);
    if (alive.length !== all.length) {
      // Rewrite the pruned list (or remove the file entirely if empty).
      try {
        if (alive.length === 0) rmSync(historyPath(), { force: true });
        else writeFileSync(historyPath(), JSON.stringify({ entries: alive }, null, 2), 'utf-8');
      } catch { /* best-effort */ }
    }
    return alive;
  } catch {
    return [];
  }
}

/** Stable identity for dedup: format + its replay payload. */
function entryKey(e) {
  return `${e.format}|${e.text ?? ''}|${e.imagePath ?? ''}`;
}

/** Short label from an entry when no explicit title is given. */
function deriveTitle(entry) {
  if (entry.title) return entry.title;
  if (entry.format === 'image' && entry.imagePath) {
    const base = entry.imagePath.split(/[\\/]/).pop() || entry.imagePath;
    return `🖼️ ${base}`;
  }
  if (entry.text) return entry.text.replace(/\s+/g, ' ').trim().slice(0, 60);
  return entry.format || 'clip';
}

/**
 * Append an agent-generated clip to the ring buffer. NO-OP (returns null) when
 * history is disabled — that is the default, so nothing hits disk unless the
 * user opted in. Purges expired entries on write. Never throws.
 *
 * @returns {string|null} the clip id (for reclip), or null when disabled/failed.
 */
export function appendHistory({ format = 'plain', text, imagePath, title = '', agent = 'cliplens' } = {}) {
  try {
    if (!historyEnabled()) return null; // opt-in: off by default, nothing on disk

    const hasText = typeof text === 'string' && text.trim() !== '';
    const hasImage = typeof imagePath === 'string' && imagePath.trim() !== '';
    if (!hasText && !hasImage) return null;

    const dir = historyDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const entries = readHistory(); // already purges expired

    const entry = {
      id: `clip_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      format,
      ...(hasText ? { text } : {}),
      ...(hasImage ? { imagePath } : {}),
      agent,
      ts: new Date().toISOString(),
    };
    entry.title = deriveTitle({ ...entry, title });

    // Skip if identical to the most recent entry (same format + payload).
    if (entries[0] && entryKey(entries[0]) === entryKey(entry)) return entries[0].id;

    entries.unshift(entry);
    const trimmed = entries.slice(0, MAX_ENTRIES);
    writeFileSync(historyPath(), JSON.stringify({ entries: trimmed }, null, 2), 'utf-8');
    return entry.id;
  } catch {
    return null; // never let history writing break the clip op
  }
}

export { MAX_ENTRIES };

/** Look up a clip by its id (returned when it was created). */
export function getById(id) {
  if (!id) return null;
  return readHistory().find((e) => e.id === id) || null;
}

/**
 * Wipe all clip history from disk (the /clip clear command). Returns the number
 * of entries removed. Safe to call even when history is off / file absent.
 */
export function clearHistory() {
  try {
    const n = readHistory().length; // count survivors (post-purge)
    rmSync(historyPath(), { force: true });
    return n;
  } catch {
    return 0;
  }
}

/**
 * Most recent entry, optionally filtered by sender agent (case-insensitive).
 * Falls back to the most recent overall when agent is empty or unmatched.
 */
export function latestByAgent(agent = '') {
  const entries = readHistory();
  if (entries.length === 0) return null;
  const want = String(agent || '').trim().toLowerCase();
  if (want) {
    const hit = entries.find((e) => String(e.agent || '').trim().toLowerCase() === want);
    if (hit) return hit;
  }
  return entries[0];
}

/** Alias: the single most recent clip (any agent). */
export function latest() {
  return latestByAgent('');
}
