/**
 * humanize — strip AI-tells from text before it hits the clipboard.
 * Rule (operator 2026-09-02): text written via cliplens must not carry obvious
 * "written by AI" fingerprints, UNLESS they were already in the input. The `write`
 * path applies this by default; pass --raw to leave text untouched (true passthrough).
 *
 * Deliberately conservative: only rewrites well-known AI punctuation tells, never
 * touches the actual words. Swedish-casual friendly.
 */

/** The AI-tell transforms, in order. Each is [pattern, replacement]. */
const TELLS = [
  // em/en dash used as a clause connector "X — Y" / "X – Y" → comma "X, Y"
  [/\s+[—–]\s+/g, ", "],
  // stray em/en dash glued to words → plain hyphen
  [/[—–]/g, "-"],
  // unicode ellipsis → three dots
  [/…/g, "..."],
  // fancy bullet at line start → plain dash
  [/^[ \t]*[•▪◦]\s+/gm, "- "],
  // narrow/no-break spaces AI sometimes emits → normal space
  [/[   ]/g, " "],
  // collapse a double space left by the dash swap (but keep newlines)
  [/ {2,}/g, " "],
];

/** Returns text with AI punctuation tells removed. Pure. */
export function humanize(text) {
  if (typeof text !== "string" || !text) return text;
  let out = text;
  for (const [pat, rep] of TELLS) out = out.replace(pat, rep);
  return out;
}

/** True if the text still contains an AI-tell (for --check / tests). */
export function hasAiTells(text) {
  return /[—–…•▪◦   ]/.test(String(text ?? ""));
}
