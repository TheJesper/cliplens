/**
 * EXAMPLE private lens (READ adapter).
 *
 * Copy this into `private-lenses/acme.js` (gitignored) and make it real. A lens turns a raw clipboard
 * payload from some app into clean, structured, token-friendly data. Pure functions, read-only.
 *
 * Keep anything company-specific in here — it never reaches the public repo.
 */

export default {
  name: 'acme',                 // adapter id
  // Return true if this lens recognizes the clipboard payload (so ClipLens can auto-pick the right lens).
  match(formats) {
    return formats.some((f) => f.name === 'acme/board' || (f.preview || '').includes('acme://'));
  },
  // Turn the raw payload into a compact structured summary for an agent.
  read(payload) {
    // payload = { formats: [{ name, classification, preview, data }], text }
    const raw = payload.text || '';
    const id = (raw.match(/acme:\/\/([\w-]+)/) || [])[1] || null;
    return {
      source: 'acme',
      boardId: id,
      itemCount: (raw.match(/item/gi) || []).length,
      // ...decode your internal format here...
    };
  },
};
