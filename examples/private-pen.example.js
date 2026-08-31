/**
 * EXAMPLE private pen (WRITE adapter).
 *
 * Copy this into `private-pens/acme.js` (gitignored) and make it real. A pen turns structured input into
 * the native clipboard format a target app expects, so a normal Ctrl+V pastes a real native object.
 *
 * Keep anything company-specific in here — it never reaches the public repo.
 */

export default {
  name: 'acme',
  // Build the clipboard payload(s) for the target app from structured input.
  // Return an array of { format, data } that ClipLens writes to the OS clipboard.
  write(input) {
    // input = whatever your agent produced, e.g. { title, items: [...] }
    const envelope = {
      v: 1,
      title: input.title || '',
      items: input.items || [],
    };
    const b64 = Buffer.from(JSON.stringify(envelope), 'utf-8').toString('base64');
    const html = `<acme hidden="acme://${b64}"></acme>`;
    return [
      { format: 'HTML Format', data: html },   // most apps read structured data from the HTML clipboard
      { format: 'text', data: input.title || '' }, // plain-text fallback
    ];
  },
};
