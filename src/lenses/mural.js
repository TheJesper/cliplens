/**
 * Mural Lens -- decode a real Mural clipboard copy into structured data.
 *
 * Real format (captured 2026-08-27, see SPEC-mural-format.md):
 *   CF_HTML fragment: <murally hiddenContent="mly://{base64}"></murally>
 *   base64 -> JSON { canvasLink, muralId, zone, widgets[] }
 *
 * This lens is READ-ONLY. It parses the envelope + widgets into a compact,
 * token-friendly summary rather than dumping the huge raw blob.
 */

/** Extract the mly:// base64 payload from a CF_HTML / HTML string. */
export function extractMlyPayload(html) {
  if (!html) return null;
  const m = html.match(/mly:\/\/([A-Za-z0-9+/=]+)/);
  return m ? m[1] : null;
}

/** Decode a mly:// base64 payload into the Mural JSON envelope. */
export function decodeMly(base64) {
  try {
    const json = Buffer.from(base64, 'base64').toString('utf-8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Parse a Mural clipboard HTML string into a structured summary.
 * @param {string} html - the HTML Format clipboard content.
 * @returns {object} structured, token-friendly summary.
 */
export function parseMuralHtml(html) {
  const payload = extractMlyPayload(html);
  if (!payload) {
    return { type: 'mural-clipboard', ok: false, reason: 'no mly:// payload found' };
  }
  const env = decodeMly(payload);
  if (!env) {
    return { type: 'mural-clipboard', ok: false, reason: 'mly payload did not decode as JSON' };
  }

  const widgets = Array.isArray(env.widgets) ? env.widgets : [];
  const byType = {};
  for (const w of widgets) byType[w.type] = (byType[w.type] || 0) + 1;

  // Compact per-widget view: identity, geometry, and a couple of telling props.
  const items = widgets.map((w) => {
    const p = w.properties || {};
    const short = { id: w.id, type: shortType(w.type), x: w.x, y: w.y, w: w.width, h: w.height };
    if (w.type === 'murally.widget.PhotoWidget') short.icon = p.photoURL ? p.photoURL.split('/').pop() : undefined;
    if (w.type === 'murally.widget.TitledImageWidget') short.imageUrl = p.imageUrl;
    if (w.type === 'murally.widget.ShapeWidget') short.shape = p.shapeType;
    if (w.type === 'murally.widget.ClusterWidget') { short.layout = p.layout; short.group = p.group; }
    if (w.type === 'murally.widget.arrow') {
      short.from = p.startRefId || null;
      short.to = p.endRefId || null;
      short.stroke = p.strokeColor;
    }
    // Colors (fill/text/stroke) -- what makes a diagram "nice".
    const fill = p.background || p.backgroundColor;
    if (fill && fill !== 'rgba(255,255,255,0)' && fill !== '#00000000') short.fill = fill;
    if (p.color) short.textColor = p.color;
    if (p.strokeColor && w.type !== 'murally.widget.arrow') short.stroke = p.strokeColor;
    // Any text-bearing widget: prefer text, then htmlText, then title.
    const content = stripHtml(p.text) || stripHtml(p.htmlText) || stripHtml(p.title);
    if (content) short.text = content;
    return short;
  });

  // Collect just the readable text content, in reading order (top-to-bottom).
  const texts = items
    .filter((i) => i.text)
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((i) => i.text);

  // Bounding box of the selection (useful for layout-aware pens).
  const bbox = widgets.length
    ? widgets.reduce(
        (b, w) => ({
          minX: Math.min(b.minX, w.x),
          minY: Math.min(b.minY, w.y),
          maxX: Math.max(b.maxX, w.x + (w.width || 0)),
          maxY: Math.max(b.maxY, w.y + (w.height || 0)),
        }),
        { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
      )
    : null;

  // Connection graph from arrows: [{from,to}] using widget ids.
  const connections = items
    .filter((i) => i.type === 'arrow' && (i.from || i.to))
    .map((i) => ({ from: i.from, to: i.to }));

  return {
    type: 'mural-clipboard',
    ok: true,
    muralId: env.muralId,
    zone: env.zone,
    canvasLink: env.canvasLink,
    widgetCount: widgets.length,
    widgetTypes: byType,
    bbox,
    texts,
    connections,
    widgets: items,
  };
}

/** Strip HTML tags/entities to plain text. */
function stripHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

/** Strip the "murally.widget." prefix for readability. */
function shortType(t) {
  return String(t || '').replace(/^murally\.widget\./, '');
}
