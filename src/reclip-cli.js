#!/usr/bin/env node
/**
 * reclip -- re-clip the last thing (or a specific agent's last thing) to the
 * clipboard, exactly, no regeneration. Terminal counterpart to /reclip.
 *
 * Usage:
 *   reclip            # re-clip the most recent clip
 *   reclip pp         # re-clip pp's most recent clip
 *   reclip clip_ab12  # re-clip a SPECIFIC clip by id (the id returned when it was written)
 */
import { latestByAgent, getById } from './history.js';
import { replay } from './replay.js';

const arg = process.argv[2] || '';
// A clip id (returned at write time) re-clips that exact clip; anything else is an agent name.
const entry = arg.startsWith('clip_') ? getById(arg) : latestByAgent(arg);
if (!entry) {
  console.error(
    arg.startsWith('clip_')
      ? `No clip with id ${arg} in history.`
      : 'No clip history yet — nothing to re-clip.',
  );
  process.exit(1);
}
const res = await replay(entry);
if (!res.ok) {
  console.error(`Reclip failed (${res.format}): ${res.detail}`);
  process.exit(1);
}
const who = entry.agent || 'unknown';
console.log(`♻️  Re-clipped ${res.format} (${who}) — ${res.detail}. Ctrl+V now.`);
