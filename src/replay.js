/**
 * replay.js -- re-write a stored clip to the clipboard EXACTLY, no regeneration.
 *
 * Given a history entry {format, text?, imagePath?}, dispatch to the right
 * writer. This is the engine behind /reclip and cliplens_reclip: deterministic,
 * zero tokens, works for text/slack/html/mural/image alike.
 */
import { writeFileSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeText } from './clipboard.js';
import { penImage } from './pens/image.js';
import { buildStickyHtml, toCfHtml, writeHtmlClipboard } from './pens/mural.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Replay a history entry to the clipboard.
 * @param {object} entry - {format, text?, imagePath?, agent?, title?}
 * @returns {Promise<{ok:boolean, format:string, detail:string}>}
 */
export async function replay(entry) {
  if (!entry || !entry.format) {
    return { ok: false, format: 'none', detail: 'no entry to replay' };
  }
  const fmt = entry.format;
  try {
    switch (fmt) {
      case 'plain': {
        await writeText(entry.text ?? '');
        return { ok: true, format: fmt, detail: `${(entry.text ?? '').length} chars` };
      }
      case 'slack': {
        runNode('slack-clip.js', entry.text ?? '');
        return { ok: true, format: fmt, detail: 'Slack rich text' };
      }
      case 'html': {
        runNode('html-clip.js', entry.text ?? '');
        return { ok: true, format: fmt, detail: 'HTML (Teams/Outlook)' };
      }
      case 'mural': {
        const lines = (entry.text ?? '').split('\n');
        writeHtmlClipboard(toCfHtml(buildStickyHtml(lines)));
        return { ok: true, format: fmt, detail: 'Mural sticky' };
      }
      case 'mural-widgets': {
        // entry.text is a JSON array of widget specs from penWidgets/drawDiagram.
        const specs = JSON.parse(entry.text || '[]');
        const { penWidgets } = await import('./pens/mural.js');
        penWidgets(specs, { record: false });
        return { ok: true, format: fmt, detail: `${specs.length} Mural widget(s)` };
      }
      case 'image': {
        penImage(entry.imagePath, { record: false });
        return { ok: true, format: fmt, detail: entry.imagePath };
      }
      default:
        return { ok: false, format: fmt, detail: `unknown format "${fmt}"` };
    }
  } catch (e) {
    return { ok: false, format: fmt, detail: e.message };
  }
}

/** Run a text-writing pen CLI on a temp file (avoids shell escaping). */
function runNode(script, text) {
  const tmp = join(tmpdir(), `cliplens-replay-${Date.now()}.md`);
  writeFileSync(tmp, text, 'utf-8');
  try {
    execSync(`node "${join(__dirname, script)}" --file "${tmp}"`, { encoding: 'utf-8' });
  } finally {
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
}
