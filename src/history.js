/**
 * history.js -- Agent-generated clip history (ring buffer).
 *
 * SECURITY: This stores ONLY clips that ClipLens itself generates
 * (via the slack/plain/html/mural/image pens). It NEVER reads or stores the
 * user's system Ctrl+C clipboard -- doing so would be a privacy/security risk.
 * The history is opt-in output only.
 *
 * Storage: ~/.cliplens/history.json  (max MAX_ENTRIES, newest first)
 *
 * PAYLOAD-AGNOSTIC: every entry has a `format` and enough data to REPLAY the
 * clip exactly, with no regeneration:
 *   plain  -> { text }
 *   slack  -> { text }              (markdown source; re-encoded by slack pen)
 *   html   -> { text }              (markdown source; re-encoded by html pen)
 *   mural  -> { text }              (sticky markdown/lines; re-encoded by mural pen)
 *   image  -> { imagePath }         (path to the source image file)
 *
 * `title` is a short human label for the picker. `agent` is who produced it.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const MAX_ENTRIES = 10;

export function historyDir() {
  return join(homedir(), '.cliplens');
}

export function historyPath() {
  return join(historyDir(), 'history.json');
}

/** Read the history array (newest first). Never throws. */
export function readHistory() {
  try {
    const raw = readFileSync(historyPath(), 'utf-8');
    const data = JSON.parse(raw);
    return Array.isArray(data.entries) ? data.entries : [];
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
 * Append an agent-generated clip to the ring buffer. Payload-agnostic: pass
 * whatever the format needs to replay (text for text-ish formats, imagePath for
 * images). Keeps at most MAX_ENTRIES, newest first, de-duplicating an identical
 * consecutive clip. Never throws -- history must never break a clip op.
 *
 * @param {object} entry
 * @param {string}  entry.format     - plain | slack | html | mural | image
 * @param {string} [entry.text]      - source text/markdown (text-ish formats)
 * @param {string} [entry.imagePath] - absolute path (image format)
 * @param {string} [entry.title]     - short label for the picker
 * @param {string} [entry.agent]     - who produced it. Default "cliplens"
 */
export function appendHistory({ format = 'plain', text, imagePath, title = '', agent = 'cliplens' } = {}) {
  try {
    // Must have something replayable.
    const hasText = typeof text === 'string' && text.trim() !== '';
    const hasImage = typeof imagePath === 'string' && imagePath.trim() !== '';
    if (!hasText && !hasImage) return;

    const dir = historyDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const entries = readHistory();

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
    // Never let history writing break the clip operation.
    return null;
  }
}

export { MAX_ENTRIES };

/** Look up a clip by its id (returned when it was created). */
export function getById(id) {
  if (!id) return null;
  return readHistory().find((e) => e.id === id) || null;
}

/**
 * Most recent entry, optionally filtered by sender agent (case-insensitive).
 * Falls back to the most recent overall when agent is empty or unmatched.
 * @param {string} [agent]
 * @returns {object|null}
 */
export function latestByAgent(agent = '') {
  const entries = readHistory();
  if (entries.length === 0) return null;
  const want = String(agent || '').trim().toLowerCase();
  if (want) {
    const hit = entries.find(e => String(e.agent || '').trim().toLowerCase() === want);
    if (hit) return hit;
  }
  return entries[0];
}

/** Alias: the single most recent clip (any agent). */
export function latest() {
  return latestByAgent('');
}
