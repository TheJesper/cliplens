/**
 * links.js - what may become a clickable link or raw HTML in a pasted clip.
 *
 * SECURITY: clip text often comes from an agent that read untrusted content. A pasted link must
 * not run script (javascript:), open local files (file:) or leak Windows credentials over SMB
 * (\\host\share), and text must not inject markup or attributes.
 */

const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/** The URL when it is an absolute http(s)/mailto link, else null (render the text only). */
export function safeUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s || /[\u0000-\u001F\u007F\s]/.test(s) || s.startsWith('\\') || s.startsWith('//')) return null;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  return SAFE_SCHEMES.has(u.protocol) ? s : null;
}

/** HTML-escape text AND attribute values (quotes included). */
export function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
