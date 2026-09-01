#!/usr/bin/env node
/**
 * Mural Pen -- write native Mural sticky content to the clipboard.
 *
 * Mural stickies paste as an HTML payload shaped like:
 *   <html v="1"><div>...rich content...</div></html>
 * (see templates/registry.json for a real captured example).
 *
 * This is the sticky's INNER rich content -- a text/emoji sticky. Raster image
 * widgets (uploaded PNGs) use a different Mural mechanism and are NOT produced
 * here; a "fatcow icon" is therefore rendered as its emoji glyph (cow 🐄).
 *
 * STATUS: mechanism verified (writes HTML Format clipboard). Paste-into-Mural
 * fidelity depends on Mural's current clipboard reader and should be validated
 * against a real Mural paste before relying on it.
 *
 * Usage:
 *   node src/pens/mural.js --emoji 🐄 --label "FatCow"
 *   node src/pens/mural.js --file sticky.md
 */
import { writeFileSync, readFileSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { appendHistory } from '../history.js';

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Build the Mural sticky HTML payload. Each line becomes a <div>; blank lines
 * become <div><br /></div>, matching the captured registry template shape.
 *
 * @param {string[]} lines - content lines (already plain text / emoji).
 * @returns {string} the `<html v="1">...</html>` payload.
 */
export function buildStickyHtml(lines) {
  const body = lines
    .map((l) => (l.trim() === '' ? '<div><br /></div>' : `<div><span>${esc(l)}</span></div>`))
    .join('');
  return `<html v="1">${body}</html>`;
}

/**
 * Build a single-emoji icon sticky (large glyph + optional label under it).
 */
export function buildIconSticky(emoji, label = '') {
  const lines = [emoji];
  if (label) {
    lines.push('');
    lines.push(label);
  }
  return buildStickyHtml(lines);
}

// ===================================================================
// Widget engine -- emits the REAL Mural format captured from a live board:
//   <murally hiddenContent="mly://{base64(envelope)}"></murally>
// See SPEC-mural-format.md and mural-widgets.json for the schema.
// ===================================================================

import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __dir = dirname(fileURLToPath(import.meta.url));
const CATALOG = JSON.parse(readFileSync(join(__dir, 'mural-widgets.json'), 'utf-8'));

let _idCounter = 0;
/** Unique widget id in Mural's "{n}-{ms}{seq}" style. */
function newWidgetId() {
  _idCounter += 1;
  return `0-${Date.now()}${String(_idCounter).padStart(3, '0')}`;
}

/** Deep-substitute {{OWNER}} / {{TS}} placeholders in a template object. */
function fill(obj, ctx) {
  if (typeof obj === 'string') {
    if (obj === '{{OWNER}}') return ctx.owner;
    if (obj === '{{TS}}') return ctx.ts;
    if (obj === '{{ID}}') return ctx.id;
    return obj;
  }
  if (Array.isArray(obj)) return obj.map((v) => fill(v, ctx));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const k of Object.keys(obj)) out[k] = fill(obj[k], ctx);
    return out;
  }
  return obj;
}

/** Convert plain text to Mural htmlText inner format. */
function toHtmlText(text) {
  if (!text) return '<html v="1"><div><br></div></html>';
  const divs = String(text)
    .split('\n')
    .map((l) => (l === '' ? '<div><br></div>' : `<div>${esc(l)}</div>`))
    .join('');
  return `<html v="1">${divs}</html>`;
}

/**
 * Build sticky/text htmlText where the FIRST line is a clickable link.
 * Used for Jira stickies: line 1 = <a href=jiraUrl>KEY</a>, rest = plain lines.
 */
function toHtmlTextWithLink(text, url) {
  const lines = String(text ?? '').split('\n');
  const first = lines[0] ?? '';
  const rest = lines.slice(1);
  const head = `<div><a href="${esc(url)}">${esc(first)}</a></div>`;
  const body = rest.map((l) => (l === '' ? '<div><br></div>' : `<div>${esc(l)}</div>`)).join('');
  return `<html v="1">${head}${body}</html>`;
}

/**
 * Build one widget object from a spec.
 * @param {object} spec
 * @param {string} spec.kind   - "sticky" | "text" | "shape" | "arrow"
 * @param {number} spec.x @param {number} spec.y
 * @param {number} [spec.width] @param {number} [spec.height]
 * @param {string} [spec.text] - text content (sticky/text/shape)
 * @param {string} [spec.color] - fill color (sticky backgroundColor / shape background)
 * @param {string} [spec.shapeType] - for kind "shape"
 * @param {object} [spec.props] - extra property overrides
 * @param {object} ctx - { owner, ts, stackingOrder }
 */
export function buildWidget(spec, ctx) {
  const typeDef = CATALOG.types[spec.kind];
  if (!typeDef) throw new Error(`Unknown widget kind: ${spec.kind}`);

  const id = newWidgetId();
  const wctx = { owner: ctx.owner, ts: ctx.ts, id };

  const properties = {
    ...fill(CATALOG.commonProperties, wctx),
    ...fill(typeDef.properties, wctx),
  };

  // Content + styling per kind.
  if (spec.text != null && (spec.kind === 'sticky' || spec.kind === 'text' || spec.kind === 'shape')) {
    properties.text = String(spec.text);
    // If a link is provided, make the first line a clickable <a href>.
    properties.htmlText = spec.link
      ? toHtmlTextWithLink(spec.text, spec.link)
      : toHtmlText(spec.text);
  }
  if (spec.color) {
    if (spec.kind === 'sticky') {
      properties.backgroundColor = typeDef.colors?.[spec.color] || spec.color;
    } else if (spec.kind === 'shape') {
      properties.background = spec.color;
    }
  }
  if (spec.kind === 'shape' && spec.shapeType) properties.shapeType = spec.shapeType;
  // Shape border control (thin, subtle by default when a card color is set).
  if (spec.kind === 'shape') {
    if (spec.stroke) properties.strokeColor = spec.stroke;
    if (spec.strokeSize != null) properties.strokeSize = spec.strokeSize;
    if (spec.strokeStyle) properties.strokeStyle = spec.strokeStyle;
  }
  if (spec.kind === 'arrow') {
    if (spec.startRefId) properties.startRefId = spec.startRefId;
    if (spec.endRefId) properties.endRefId = spec.endRefId;
    if (spec.points) properties.points = spec.points;
    if (spec.stroke) properties.strokeColor = spec.stroke;
    if (spec.strokeWidth != null) properties.strokeWidth = spec.strokeWidth;
    if (spec.startTipType) properties.startTipType = spec.startTipType;
    if (spec.endTipType) properties.endTipType = spec.endTipType;
  }
  if (spec.props) Object.assign(properties, spec.props);

  const size = typeDef.size || { width: 168, height: 168 };
  return {
    ...fill(CATALOG.commonWidget, wctx),
    id,
    type: typeDef.widgetType,
    x: spec.x ?? 0,
    y: spec.y ?? 0,
    width: spec.width ?? size.width,
    height: spec.height ?? size.height,
    stackingOrder: ctx.stackingOrder++,
    properties,
  };
}

/**
 * Build a "card": a grouped component = ClusterWidget containing a colored
 * rounded box + an optional icon (PhotoWidget referencing a hosted Mural asset)
 * + a text label. Mirrors the exact structure captured from a real board.
 * Returns an array of widgets (cluster first, then its children with parentId).
 *
 * @param {object} spec
 * @param {number} spec.x @param {number} spec.y - top-left on canvas
 * @param {number} [spec.width=233] @param {number} [spec.height=53]
 * @param {string} [spec.text]  - label
 * @param {string} [spec.color] - box fill (default soft green #f0faeb)
 * @param {string} [spec.stroke] - box border (default #b3b3b3, size 1)
 * @param {string} [spec.iconUrl] - hosted Mural asset photoURL (icon rendered)
 * @param {object} ctx - { owner, ts, stackingOrder }
 * @param {string} [refId] - optional stable id for the cluster (edge targeting)
 */
export function buildCard(spec, ctx, refId) {
  const W = spec.width ?? 233;
  const H = spec.height ?? 53;
  const clusterId = refId || newWidgetId();
  const common = (id) => ({ ...fill(CATALOG.commonProperties, { owner: ctx.owner, ts: ctx.ts, id }) });

  // Cluster (group container)
  const cluster = {
    ...fill(CATALOG.commonWidget, { owner: ctx.owner }),
    id: clusterId,
    type: 'murally.widget.ClusterWidget',
    x: spec.x ?? 0, y: spec.y ?? 0, width: W, height: H,
    stackingOrder: ctx.stackingOrder++,
    properties: {
      ...common(clusterId),
      strokeColor: '#eaeaea', strokeWidth: 3, strokeStyle: 'solid',
      background: '#ffffff', showTitle: false, titleFontSize: 36,
      layout: 'free', group: true,
    },
  };

  // Inner colored rounded box (relative coords 0,0)
  const rectId = newWidgetId();
  const rect = {
    ...fill(CATALOG.commonWidget, { owner: ctx.owner }),
    id: rectId,
    type: 'murally.widget.ShapeWidget',
    x: 0, y: 0, width: W, height: H,
    stackingOrder: ctx.stackingOrder++,
    properties: {
      ...common(rectId),
      ...fill(CATALOG.types.shape.properties, { owner: ctx.owner, ts: ctx.ts, id: rectId }),
      shapeType: 'rectangle',
      background: spec.color || '#f0faeb',
      strokeColor: spec.stroke || '#b3b3b3',
      strokeSize: spec.strokeSize != null ? spec.strokeSize : 1,
      strokeStyle: 'solid',
      text: '', htmlText: '<html v="1"><div><br></div></html>',
      parentId: clusterId,
    },
  };

  const widgets = [cluster, rect];

  // Optional icon (only if we have a hosted asset URL).
  const hasIcon = !!spec.iconUrl;
  if (hasIcon) {
    const iconId = newWidgetId();
    widgets.push({
      ...fill(CATALOG.commonWidget, { owner: ctx.owner }),
      id: iconId,
      type: 'murally.widget.PhotoWidget',
      x: 10, y: Math.round((H - 32) / 2), width: 32, height: 32,
      stackingOrder: ctx.stackingOrder++,
      properties: {
        ...common(iconId),
        aspectRatio: 1, border: false, contentPrivate: false,
        dlpDownloadRestricted: false, footer: '', link: null, mask: null,
        naturalHeight: 32, naturalWidth: 32,
        photoURL: spec.iconUrl, privateImage: false, showCaption: true,
        tags: [], thumbURL: '', parentId: clusterId,
      },
    });
  }

  // Text label. Matches the real in-card TextWidget: textType "stickyNote",
  // content lives in `text` as html-v1 markup, no separate htmlText field.
  const textId = newWidgetId();
  const labelHtml = `<html v="1"><div><span>${esc(spec.text || '')}</span></div></html>`;
  widgets.push({
    ...fill(CATALOG.commonWidget, { owner: ctx.owner }),
    id: textId,
    type: 'murally.widget.TextWidget',
    x: hasIcon ? 51 : 16, y: Math.round((H - 20) / 2), width: W - (hasIcon ? 60 : 30), height: 20,
    stackingOrder: ctx.stackingOrder++,
    properties: {
      ...common(textId),
      fontFamily: 'proxima-nova',
      fontSize: 16,
      textAlign: 'left',
      backgroundColor: 'rgba(255,255,255,0)',
      textType: 'stickyNote',
      bold: false, italic: false, strike: false, underline: false,
      text: labelHtml,
      link: null,
      labels: [],
      parentId: clusterId,
    },
  });

  return { widgets, clusterId };
}

/**
 * Assemble a full Mural clipboard payload (CF_HTML) from widget specs.
 * Specs with kind:'card' expand into a grouped ClusterWidget component.
 * @param {object[]} specs - array of widget specs (see buildWidget / buildCard)
 * @param {object} [opts] - { owner, muralId, canvasLink, zone }
 * @returns {{ cfHtml: string, envelope: object, refToId: object }}
 */
export function buildMuralPayload(specs, opts = {}) {
  const ctx = {
    owner: opts.owner || 'anon',
    ts: Date.now(),
    stackingOrder: 1,
  };
  const widgets = [];
  const refToId = {};
  for (const s of specs) {
    if (s.kind === 'card') {
      const { widgets: cw, clusterId } = buildCard(s, ctx, undefined);
      if (s._ref) refToId[s._ref] = clusterId;
      widgets.push(...cw);
    } else {
      const w = buildWidget(s, ctx);
      if (s._ref) refToId[s._ref] = w.id;
      widgets.push(w);
    }
  }
  const envelope = {
    canvasLink: opts.canvasLink || '',
    ...CATALOG.envelope,
    ...(opts.muralId ? { muralId: opts.muralId } : {}),
    ...(opts.zone ? { zone: opts.zone } : {}),
    widgets,
  };
  const b64 = Buffer.from(JSON.stringify(envelope), 'utf-8').toString('base64');
  const fragment = `<murally hiddenContent="mly://${b64}"></murally>`;
  return { cfHtml: toCfHtml(fragment), envelope, refToId };
}

/**
 * High-level: write a set of widgets to the clipboard as a real Mural paste.
 * @param {object[]} specs
 * @param {object} [opts] - { owner, muralId, canvasLink, zone, record, agent }
 * @returns {{ count: number, bytes: number }}
 */
export function penWidgets(specs, opts = {}) {
  const { cfHtml } = buildMuralPayload(specs, opts);
  writeHtmlClipboard(cfHtml);
  let clipId = null;
  if (opts.record !== false) {
    clipId = appendHistory({
      format: 'mural-widgets',
      // Store specs AND the board context so reclip can rebuild the exact same
      // paste — without owner/muralId/zone Mural renders empty holders.
      text: JSON.stringify({
        specs,
        owner: opts.owner,
        muralId: opts.muralId,
        zone: opts.zone,
        canvasLink: opts.canvasLink,
      }),
      title: `🧩 Mural: ${specs.length} widget(s)`,
      agent: opts.agent || process.env.CLIPLENS_AGENT || 'cliplens',
    });
  }
  return { count: specs.length, bytes: Buffer.byteLength(cfHtml, 'utf-8'), clipId };
}

/**
 * Wrap a body in the CF_HTML clipboard header Windows requires. Offsets are
 * computed against the byte length of the preamble (ASCII), matching the
 * Microsoft CF_HTML spec.
 */
export function toCfHtml(fragment) {
  const header =
    'Version:0.9\r\n' +
    'StartHTML:<<S>>\r\n' +
    'EndHTML:<<E>>\r\n' +
    'StartFragment:<<SF>>\r\n' +
    'EndFragment:<<EF>>\r\n';
  const pre = '<html><body><!--StartFragment-->';
  const post = '<!--EndFragment--></body></html>';

  // First pass to measure, then substitute real byte offsets.
  const build = (s, e, sf, ef) =>
    header
      .replace('<<S>>', String(s).padStart(10, '0'))
      .replace('<<E>>', String(e).padStart(10, '0'))
      .replace('<<SF>>', String(sf).padStart(10, '0'))
      .replace('<<EF>>', String(ef).padStart(10, '0')) +
    pre +
    fragment +
    post;

  const enc = (str) => Buffer.byteLength(str, 'utf-8');
  const draft = build(0, 0, 0, 0);
  const headLen = enc(draft) - enc(pre + fragment + post);
  const startHtml = headLen;
  const startFragment = headLen + enc(pre);
  const endFragment = startFragment + enc(fragment);
  const endHtml = endFragment + enc(post);
  return build(startHtml, endHtml, startFragment, endFragment);
}

/**
 * Write an HTML Format payload to the Windows clipboard via PowerShell.
 */
export function writeHtmlClipboard(cfHtml) {
  const tmpTxt = join(tmpdir(), 'cliplens-mural.html');
  const tmpPs = join(tmpdir(), 'cliplens-mural.ps1');
  writeFileSync(tmpTxt, cfHtml, 'utf-8');
  writeFileSync(
    tmpPs,
    `Add-Type -AssemblyName System.Windows.Forms
$htmlBytes = [System.IO.File]::ReadAllBytes('${tmpTxt.replace(/\\/g, '\\\\')}')
$ms = New-Object System.IO.MemoryStream(,$htmlBytes)
$dataObj = New-Object System.Windows.Forms.DataObject
$dataObj.SetData('HTML Format', $ms)
for ($i = 0; $i -lt 5; $i++) {
  try { [System.Windows.Forms.Clipboard]::SetDataObject($dataObj, $true); break }
  catch { Start-Sleep -Milliseconds 200 }
}
`
  );
  execSync(`pwsh -NoProfile -STA -ExecutionPolicy Bypass -File "${tmpPs}"`);
  unlinkSync(tmpTxt);
  unlinkSync(tmpPs);
}

/**
 * Build a batch of stickies in one clipboard payload. Each item becomes its own
 * `<html v="1">` sticky, concatenated — Mural splits them into separate widgets.
 * @param {Array<{emoji?:string,label?:string,lines?:string[]}>} items
 * @returns {string} concatenated sticky payloads.
 */
export function buildStickyBatch(items) {
  return items
    .map((it) => {
      if (it.lines) return buildStickyHtml(it.lines);
      return buildIconSticky(it.emoji || '', it.label || '');
    })
    .join('');
}

/**
 * High-level: write a batch of icon stickies to the clipboard as Mural HTML.
 * @param {Array<{emoji?:string,label?:string}>} items
 * @returns {{ payload: string, bytes: number, count: number }}
 */
export function penStickyBatch(items) {
  const payload = buildStickyBatch(items);
  const cf = toCfHtml(payload);
  writeHtmlClipboard(cf);
  return { payload, bytes: Buffer.byteLength(cf, 'utf-8'), count: items.length };
}

/**
 * High-level: write an emoji/label sticky to the clipboard as Mural HTML.
 * @returns {{ sticky: string, bytes: number }}
 */
export function penIconSticky(emoji, label = '', { record = true, agent } = {}) {
  const sticky = buildIconSticky(emoji, label);
  const cf = toCfHtml(sticky);
  writeHtmlClipboard(cf);
  if (record) {
    // Store the sticky source (emoji + optional label) as text so replay
    // rebuilds the exact same sticky via buildStickyHtml.
    const lines = label ? [emoji, '', label] : [emoji];
    appendHistory({ format: 'mural', text: lines.join('\n'), title: `🟨 ${label || emoji}`, agent: agent || process.env.CLIPLENS_AGENT || 'cliplens' });
  }
  return { sticky, bytes: Buffer.byteLength(cf, 'utf-8') };
}

// CLI entry point
if (process.argv[1]?.replace(/\\/g, '/').endsWith('pens/mural.js')) {
  const args = process.argv.slice(2);
  let emoji = '\u{1F404}'; // cow
  let label = '';
  let file = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--emoji') emoji = args[++i];
    else if (args[i] === '--label') label = args[++i];
    else if (args[i] === '--file') file = args[++i];
  }
  let sticky;
  if (file) {
    const lines = readFileSync(file, 'utf-8').split('\n');
    sticky = buildStickyHtml(lines);
    writeHtmlClipboard(toCfHtml(sticky));
  } else {
    sticky = penIconSticky(emoji, label).sticky;
  }
  console.log('📋 Mural sticky written to clipboard (HTML Format). Ctrl+V in Mural.');
  console.log('payload:', sticky);
}
