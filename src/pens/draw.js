/**
 * draw.js -- architectural diagram layer on top of the Mural pen.
 *
 * You describe a diagram logically (nodes + edges + layout intent); this lays
 * it out on a grid and emits Mural widget specs (boxes + labels + connectors),
 * then hands them to the pen. The agent never computes coordinates by hand.
 *
 *   drawDiagram({
 *     nodes: [{ id:'client', label:'Client', shape:'rectangle' }, ...],
 *     edges: [{ from:'client', to:'api', label:'HTTPS' }, ...],
 *     layout: 'flow-lr' | 'flow-tb' | 'grid',
 *   }, { owner, muralId, zone, canvasLink })
 *
 * Shapes map to catalog shapeTypes. Nodes become ShapeWidgets with centered
 * text; edges become arrow widgets whose start/end reference the node ids so
 * Mural keeps them attached.
 */
import { penWidgets, buildMuralPayload } from './mural.js';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
let ASSETS = { boards: {} };
try { ASSETS = JSON.parse(readFileSync(join(__dir, 'mural-assets.json'), 'utf-8')); } catch { /* optional */ }

/** Resolve a friendly icon name -> hosted Mural asset URL for a given board. */
export function resolveIcon(iconName, muralId) {
  if (!iconName || !muralId) return null;
  const board = ASSETS.boards?.[muralId];
  return board?.[iconName] || null;
}

const NODE_W = 200;
const NODE_H = 100;
const GAP_X = 140;
const GAP_Y = 120;

/** Map friendly shape names to real Mural shapeTypes (see mural-widgets.json). */
const SHAPE_ALIAS = {
  box: 'rectangle',
  rectangle: 'rectangle',
  rounded: 'rounded_square',
  process: 'rounded_square',
  db: 'database',
  database: 'database',
  store: 'database',
  decision: 'rhombus_smart',
  diamond: 'rhombus_smart',
  service: 'hexagon_smart',
  hexagon: 'hexagon_smart',
  actor: 'ellipse',
  ellipse: 'ellipse',
  circle: 'ellipse',
  start: 'ellipse',
  end: 'ellipse',
};

/**
 * Lay out nodes and produce widget specs + an id map for edges.
 * @param {object} diagram
 * @param {number} originX @param {number} originY - top-left of the diagram
 * @returns {{ specs: object[], nodePos: Record<string,{x,y,w,h}> }}
 */
export function layoutDiagram(diagram, originX = 0, originY = 0, muralId = null) {
  const { nodes = [], edges = [], layout = 'flow-lr' } = diagram;
  const nodePos = {};
  const specs = [];

  // Position nodes.
  const cols = layout === 'grid' ? Math.ceil(Math.sqrt(nodes.length)) : nodes.length;
  nodes.forEach((n, i) => {
    let col, row;
    if (layout === 'flow-tb') { col = 0; row = i; }
    else if (layout === 'grid') { col = i % cols; row = Math.floor(i / cols); }
    else { col = i; row = 0; } // flow-lr default
    const w = n.width || (n.card || n.icon ? 233 : NODE_W);
    const h = n.height || (n.card || n.icon ? 53 : NODE_H);
    const x = originX + col * ((n.card || n.icon ? 233 : NODE_W) + GAP_X);
    const y = originY + row * ((n.card || n.icon ? 53 : NODE_H) + GAP_Y);
    nodePos[n.id] = { x, y, w, h };
  });

  // Nodes -> card (grouped box+icon+text) when icon/card requested, else shape.
  nodes.forEach((n) => {
    const p = nodePos[n.id];
    const iconUrl = n.icon ? resolveIcon(n.icon, muralId) : null;
    if (n.card || iconUrl) {
      specs.push({
        _ref: n.id,
        kind: 'card',
        x: p.x, y: p.y, width: p.w, height: p.h,
        text: n.label || '',
        color: n.color || '#f0faeb',
        iconUrl,
      });
    } else {
      specs.push({
        _ref: n.id,
        kind: 'shape',
        shapeType: SHAPE_ALIAS[n.shape] || SHAPE_ALIAS.box,
        x: p.x, y: p.y, width: p.w, height: p.h,
        text: n.label || '',
        color: n.color,
        stroke: n.stroke || (n.color ? '#c8c8c8' : '#b3b3b3'),
        strokeSize: n.strokeSize != null ? n.strokeSize : 1,
        strokeStyle: 'solid',
      });
    }
  });

  // Edges become arrows routed edge-to-edge (not center) so the connector is
  // fully visible between the two cards. Thin, with a solid arrowhead.
  edges.forEach((e) => {
    const a = nodePos[e.from], b = nodePos[e.to];
    if (!a || !b) return;
    // Connect from right-edge of a to left-edge of b for flow-lr; fall back to
    // centers for other directions.
    let ax, ay, bx, by;
    if (b.x >= a.x + a.w) { // b is to the right
      ax = a.x + a.w; ay = a.y + a.h / 2; bx = b.x; by = b.y + b.h / 2;
    } else if (b.y >= a.y + a.h) { // b is below
      ax = a.x + a.w / 2; ay = a.y + a.h; bx = b.x + b.w / 2; by = b.y;
    } else {
      ax = a.x + a.w / 2; ay = a.y + a.h / 2; bx = b.x + b.w / 2; by = b.y + b.h / 2;
    }
    const ox = Math.min(ax, bx), oy = Math.min(ay, by);
    specs.push({
      _edge: { from: e.from, to: e.to },
      kind: 'arrow',
      x: ox, y: oy,
      width: Math.abs(bx - ax) || 1, height: Math.abs(by - ay) || 1,
      points: [{ x: ax - ox, y: ay - oy }, { x: bx - ox, y: by - oy }],
      stroke: '#7a7a7a',
      strokeWidth: 2,
      startTipType: 'none',
      endTipType: 'arrow-solid',
      label: e.label,
    });
  });

  return { specs, nodePos };
}

/**
 * Draw a diagram to the clipboard as a real Mural paste.
 * @param {object} diagram - { nodes, edges, layout, originX?, originY? }
 * @param {object} [opts]  - { owner, muralId, zone, canvasLink, record, agent }
 * @returns {{ count:number, bytes:number, nodes:number, edges:number }}
 */
export function drawDiagram(diagram, opts = {}) {
  const { specs } = layoutDiagram(diagram, diagram.originX || 0, diagram.originY || 0, opts.muralId || null);

  // Two-pass: build once to get generated ids per _ref (buildMuralPayload
  // returns refToId, correct even when cards expand to multiple widgets), then
  // set arrow start/end refs so Mural attaches connectors to the nodes.
  const { refToId } = buildMuralPayload(specs, opts);
  specs.forEach((s) => {
    if (s._edge) {
      s.startRefId = refToId[s._edge.from] || null;
      s.endRefId = refToId[s._edge.to] || null;
    }
  });

  const res = penWidgets(specs, opts);
  const nodes = specs.filter((s) => s._ref).length;
  const edges = specs.filter((s) => s._edge).length;
  return { ...res, nodes, edges };
}
