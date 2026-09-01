#!/usr/bin/env node
/**
 * clip-clear -- wipe all saved ClipLens clip history from disk.
 * Terminal counterpart to the cliplens_clear MCP tool / "/clip clear".
 *
 * Usage:  clip-clear        (also linked as the short alias if configured)
 */
import { clearHistory, historyPath } from './history.js';

const n = clearHistory();
if (n > 0) {
  console.log(`🧹 Cleared clip history — ${n} clip(s) removed (${historyPath()}).`);
} else {
  console.log('🧹 Clip history already empty — nothing to clear.');
}
