#!/usr/bin/env node
/**
 * reclip -- re-clip the last thing (or a specific agent's last thing) to the
 * clipboard, exactly, no regeneration. Terminal counterpart to /reclip.
 *
 * Usage:
 *   reclip            # re-clip the most recent clip
 *   reclip pp         # re-clip pp's most recent clip
 */
import { latestByAgent } from './history.js';
import { replay } from './replay.js';

const agent = process.argv[2] || '';
const entry = latestByAgent(agent);
if (!entry) {
  console.error('No clip history yet — nothing to re-clip.');
  process.exit(1);
}
const res = await replay(entry);
if (!res.ok) {
  console.error(`Reclip failed (${res.format}): ${res.detail}`);
  process.exit(1);
}
const who = entry.agent || 'unknown';
console.log(`♻️  Re-clipped ${res.format} (${who}) — ${res.detail}. Ctrl+V now.`);
