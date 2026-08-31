/**
 * private.js — auto-discovery for ORG-SPECIFIC lenses & pens.
 *
 * The public repo ships only generic adapters. Anything company-specific — an internal tool's clipboard
 * format, a proprietary board, a private log filter — lives in gitignored folders so it can never leak
 * upstream:
 *
 *     <repo>/private-lenses/   your read adapters   (gitignored)
 *     <repo>/private-pens/     your write adapters  (gitignored)
 *
 * Drop a `.js` file in there exporting the adapter shape (see examples/). It is discovered here at runtime;
 * if the folders don't exist, this is a silent no-op. Nothing in private-* is ever committed.
 */
import { readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

async function loadDir(dir) {
  const abs = join(ROOT, dir);
  let files;
  try {
    files = readdirSync(abs).filter((f) => f.endsWith('.js') && !f.endsWith('.example.js'));
  } catch {
    return []; // folder absent -> nothing private installed, that's fine
  }
  const loaded = [];
  for (const f of files) {
    try {
      const mod = await import(pathToFileURL(join(abs, f)).href);
      loaded.push({ name: (mod.default?.name) || f.replace(/\.js$/, ''), file: f, module: mod });
    } catch (err) {
      console.warn(`[cliplens] failed to load private adapter ${dir}/${f}: ${err.message}`);
    }
  }
  return loaded;
}

/** Load all private lenses (read adapters). Returns [{ name, file, module }]. */
export const loadPrivateLenses = () => loadDir('private-lenses');

/** Load all private pens (write adapters). Returns [{ name, file, module }]. */
export const loadPrivatePens = () => loadDir('private-pens');

/** Discover everything private, for a CLI/MCP listing. */
export async function loadPrivateAdapters() {
  const [lenses, pens] = await Promise.all([loadPrivateLenses(), loadPrivatePens()]);
  return { lenses, pens };
}
