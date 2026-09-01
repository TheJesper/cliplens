/**
 * hints.js -- occasional, friendly one-liners the agent can sprinkle into
 * responses. Keeps discovery light: the user learns features over time instead
 * of reading a manual. Pull one with randomHint(); the caller decides when to
 * show it (e.g. once per session, or ~1 in 5 clips — don't nag).
 */

import { historyEnabled } from './history.js';

/** Hints shown only when history is OFF (the default). */
const HISTORY_OFF_HINTS = [
  'Hint: clip history is OFF by default (nothing saved to disk). Turn it on with CLIPLENS_HISTORY=on to enable reclip — clips then live max 1h and auto-expire.',
  'Tip: want to re-paste a past clip? Enable history (CLIPLENS_HISTORY=on). It stays on disk at most 1h, then self-clears.',
];

/** Hints shown when history is ON. */
const HISTORY_ON_HINTS = [
  'Hint: every clip returns a clipId — reclip that exact clip later with cliplens_reclip { id }.',
  'Hint: clips auto-expire after ~1h (CLIPLENS_HISTORY_TTL_MIN). Wipe them now with /clip clear (cliplens_clear).',
  'Tip: "/cl" is shorthand for /clip clear — clears all saved clips instantly.',
];

/** General hints, always eligible. */
const GENERAL_HINTS = [
  'Tip: say "read the Mural I just copied" and I\'ll run the mural lens on your clipboard.',
  'Tip: I can drop a whole board of Jira stickies — copy nothing in between, just Ctrl+V after.',
  'Tip: paste a DevTools console dump and I\'ll strip 99% of the noise for you.',
  'Tip: org-specific formats go in private-lenses/ + private-pens/ (gitignored) — never pushed public.',
];

/**
 * Return a single context-appropriate hint string (or null to stay quiet).
 * @param {object} [opts]
 * @param {number} [opts.chance=0.25] probability of returning a hint at all
 */
export function randomHint({ chance = 0.25 } = {}) {
  if (Math.random() > chance) return null;
  const pool = [
    ...(historyEnabled() ? HISTORY_ON_HINTS : HISTORY_OFF_HINTS),
    ...GENERAL_HINTS,
  ];
  return pool[Math.floor(Math.random() * pool.length)];
}

/** All hints (for a /clip hints listing). */
export function allHints() {
  return { historyOff: HISTORY_OFF_HINTS, historyOn: HISTORY_ON_HINTS, general: GENERAL_HINTS };
}
