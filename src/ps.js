/**
 * ps.js - quoting helpers for the few places that still build PowerShell script text.
 *
 * SECURITY: PowerShell treats U+2018, U+2019, U+201A and U+201B as single-quote delimiters, so
 * escaping only ASCII ' lets smart-quote text break out of a '...' literal and run as code.
 * Always pass untrusted text (clipboard, tool args, file names, format names) through psq().
 * Prefer env vars / files over text interpolation where practical.
 */

const QUOTES = /['\u2018\u2019\u201A\u201B]/g;
// control chars except \t \n \r
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Escape a value for use INSIDE a PowerShell single-quoted literal ('...'). */
export function psq(value) {
  return String(value ?? '').replace(CONTROL, '').replace(QUOTES, (m) => m + m);
}