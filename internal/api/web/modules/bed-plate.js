// Makera Z1 MDF bed plate drawn under the Surface XY target map.
//
// Geometry is taken from Makera's "Makera-Z1_MDF-v2.1.STEP" (SolidWorks
// export, 2026-05-12): a 206 x 206 x 15 mm plate with 1 mm corner chamfers.
// Coordinates below are plate-local millimetres seen from above, measured from
// the plate's front-left corner (X to the right, Y towards the back).
//
// Placement in machine coordinates is derived from the firmware anchor: the
// Z1 anchor is an L-shaped block `coordinate.anchor_width` mm wide sitting
// flush with the plate's front and left edges, and `coordinate.anchor1_x/y`
// is its inner corner. The plate's front-left corner is therefore anchor1
// minus anchor_width on both axes. The two Ø5 holes centred in those 15 mm
// strips (7.5, 96) and (96, 7.5) are consistent with that layout.

export const BED_PLATE = Object.freeze({
  width: 206,
  depth: 206,
  chamfer: 1,
  // Ø5 holes. The 4 x 4 grid at 20/65/110/160 mm is named by column letter
  // and row number; (65, 65) and (160, 160) are not drilled in the STEP.
  holes: Object.freeze([
    [7.5, 96], [20, 20], [20, 65], [20, 110], [20, 160], [65, 20], [65, 110], [65, 160], [96, 7.5],
    [110, 20], [110, 65], [110, 110], [110, 160], [160, 20], [160, 65], [160, 110], [198.5, 96],
  ]),
  // Ø10 counterbores (2 mm deep) over Ø5.5 holes.
  counterbores: Object.freeze([
    [7.5, 85], [10.5, 120], [10.5, 159], [10.5, 196], [12, 45], [30, 7.5], [34, 42.5], [34, 80], [34, 120],
    [34, 159], [34, 196], [40, 90], [45, 12], [80, 159], [80, 196], [80.04, 42.5], [80.04, 80], [80.04, 122.9],
    [85, 7.5], [125, 10.5], [125, 42.5], [125, 80], [125, 123], [125, 159], [125, 196], [170, 196], [173, 10.5],
    [173, 42.5], [173, 80], [173, 123], [173, 159], [196, 10.5], [196, 42.5], [196, 80], [196, 123], [196, 159],
  ]),
  // Single Ø10.5 hole.
  largeHoles: Object.freeze([[196, 196]]),
});

const GRID = [20, 65, 110, 160];
const DEFAULT_ANCHOR_WIDTH = 15;
const DEFAULT_ANCHOR_LENGTH = 100;
const FEATURE_SNAP_MM = 6;

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function positive(value, fallback) {
  const n = finite(value);
  return n !== null && n > 0 ? n : fallback;
}

// Returns where the plate sits in machine coordinates, or null when the
// machine has not reported its anchors yet.
export function bedPlatePlacement(learned) {
  const model = learned?.identity?.model;
  if (model && !/z1/i.test(model)) return null;
  const anchors = learned?.anchors;
  const ax = finite(anchors?.anchor1?.x);
  const ay = finite(anchors?.anchor1?.y);
  if (!anchors?.available || ax === null || ay === null) return null;
  const numbers = learned?.config_numbers || {};
  const anchorWidth = positive(numbers["coordinate.anchor_width"], DEFAULT_ANCHOR_WIDTH);
  const anchorLength = positive(numbers["coordinate.anchor_length"], DEFAULT_ANCHOR_LENGTH);
  const a2x = finite(anchors?.anchor2?.x);
  const a2y = finite(anchors?.anchor2?.y);
  return {
    x0: ax - anchorWidth,
    y0: ay - anchorWidth,
    anchorWidth,
    anchorLength,
    anchor1: { x: ax, y: ay },
    anchor2: a2x !== null && a2y !== null ? { x: a2x, y: a2y } : null,
  };
}

// Machine-coordinate rectangle the map shows: the travel area, extended to
// include the plate when its placement is known.
export function bedMapExtent(work, placement) {
  const out = { x_min: work.x_min, x_max: work.x_max, y_min: work.y_min, y_max: work.y_max };
  if (placement) {
    out.x_min = Math.min(out.x_min, placement.x0);
    out.x_max = Math.max(out.x_max, placement.x0 + BED_PLATE.width);
    out.y_min = Math.min(out.y_min, placement.y0);
    out.y_max = Math.max(out.y_max, placement.y0 + BED_PLATE.depth);
  }
  // Room for the grid labels above and to the right of the plate.
  if (placement) { out.x_min -= 3; out.x_max += 9; out.y_min -= 3; out.y_max += 9; }
  return out;
}

function gridName(px, py) {
  const col = GRID.findIndex((g) => Math.abs(g - px) < 0.01);
  const row = GRID.findIndex((g) => Math.abs(g - py) < 0.01);
  return col >= 0 && row >= 0 ? "ABCD"[col] + (row + 1) : "";
}

function bedFeatures() {
  const out = [];
  for (const [x, y] of BED_PLATE.holes) {
    const name = gridName(x, y);
    out.push({ x, y, r: 2.5, label: name ? `Ø5 hole ${name}` : "Ø5 hole" });
  }
  for (const [x, y] of BED_PLATE.counterbores) out.push({ x, y, r: 5, label: "Ø10 counterbore" });
  for (const [x, y] of BED_PLATE.largeHoles) out.push({ x, y, r: 5.25, label: "Ø10.5 hole" });
  return out;
}

const FEATURES = bedFeatures();

// Nearest plate hole within a few millimetres of a machine coordinate, with its
// centre in machine coordinates.
export function nearestBedFeature(placement, x, y) {
  if (!placement) return null;
  const px = x - placement.x0;
  const py = y - placement.y0;
  let best = null;
  for (const f of FEATURES) {
    const d = Math.hypot(f.x - px, f.y - py);
    if (d <= FEATURE_SNAP_MM + f.r && (!best || d < best.d)) best = { ...f, d };
  }
  if (!best) return null;
  return { label: best.label, x: placement.x0 + best.x, y: placement.y0 + best.y, distance: best.d };
}

function signed(n) {
  const v = Math.abs(n) < 0.05 ? 0 : n;
  return (v >= 0 ? "+" : "") + v.toFixed(1);
}

// Text for the target readout. Without a known plate it is the plain machine
// coordinate the map always showed.
export function describeBedTarget(placement, x, y) {
  const base = `X ${x.toFixed(1)}  Y ${y.toFixed(1)} mm`;
  if (!placement) return { primary: base, detail: "" };
  const parts = [];
  const px = x - placement.x0;
  const py = y - placement.y0;
  const onPlate = px >= 0 && px <= BED_PLATE.width && py >= 0 && py <= BED_PLATE.depth;
  parts.push(`Anchor 1 ${signed(x - placement.anchor1.x)} / ${signed(y - placement.anchor1.y)}`);
  const feature = nearestBedFeature(placement, x, y);
  if (feature) parts.push(`${feature.label} at X ${feature.x.toFixed(1)} Y ${feature.y.toFixed(1)}`);
  else if (!onPlate) parts.push("Off the bed plate");
  return { primary: base, detail: parts.join(" · "), feature };
}

function n(v) {
  return Number(v.toFixed(2));
}

// Draw in machine millimeters with Y inverted for the SVG plane.
export function bedPlateDrawing(placement) {
  if (!placement) return "";
  const X = n;
  const Y = (y) => n(-y);
  let out = "";
  const { x0, y0 } = placement;
  const c = BED_PLATE.chamfer;
  const W = BED_PLATE.width;
  const D = BED_PLATE.depth;
  const pts = [[c, 0], [W - c, 0], [W, c], [W, D - c], [W - c, D], [c, D], [0, D - c], [0, c]]
    .map(([px, py]) => `${X(x0 + px)},${Y(y0 + py)}`).join(" ");
  out += `<polygon class="bed-plate" points="${pts}"/>`;
  // Anchor block footprint: an L along the front and left edges.
  const aw = placement.anchorWidth;
  const al = Math.min(placement.anchorLength + aw, W);
  const l = [[0, 0], [al, 0], [al, aw], [aw, aw], [aw, al], [0, al]]
    .map(([px, py]) => `${X(x0 + px)},${Y(y0 + py)}`).join(" ");
  out += `<polygon class="bed-anchor" points="${l}"/>`;
  for (const g of GRID) {
    out += `<text class="bed-grid-label" x="${X(x0 + g)}" y="${Y(y0 + D + 2.5)}" text-anchor="middle">${"ABCD"[GRID.indexOf(g)]}</text>`;
    out += `<text class="bed-grid-label" x="${X(x0 + W + 2.5)}" y="${n(Y(y0 + g) + 1.9)}" text-anchor="start">${GRID.indexOf(g) + 1}</text>`;
  }
  for (const f of FEATURES) {
    const cls = f.r === 5 ? "bed-counterbore" : "bed-hole";
    out += `<circle class="${cls}" cx="${X(x0 + f.x)}" cy="${Y(y0 + f.y)}" r="${f.r}"/>`;
    if (f.r === 5) out += `<circle class="bed-hole" cx="${X(x0 + f.x)}" cy="${Y(y0 + f.y)}" r="2.75"/>`;
  }
  const a1 = placement.anchor1;
  out += `<g class="bed-anchor-point"><circle cx="${X(a1.x)}" cy="${Y(a1.y)}" r="2.2"/><text x="${X(a1.x) + 4}" y="${Y(a1.y) - 4}">Anchor 1</text></g>`;
  if (placement.anchor2) {
    const a2 = placement.anchor2;
    out += `<g class="bed-anchor-point"><circle cx="${X(a2.x)}" cy="${Y(a2.y)}" r="2.2"/><text x="${X(a2.x) + 4}" y="${Y(a2.y) - 4}">Anchor 2</text></g>`;
  }
  return out;
}

// SVG for the map. Machine Y grows towards the back of the machine, which is
// up on screen, so SVG y is the negated machine Y.
export function bedPlateSVG({ work, placement, target = null }) {
  const ext = bedMapExtent(work, placement);
  const w = ext.x_max - ext.x_min;
  const h = ext.y_max - ext.y_min;
  const X = (x) => n(x);
  const Y = (y) => n(-y);
  let out = `<svg xmlns="http://www.w3.org/2000/svg" class="bed-map-svg" viewBox="${n(ext.x_min)} ${n(-ext.y_max)} ${n(w)} ${n(h)}" preserveAspectRatio="none" aria-hidden="true">`;
  out += bedPlateDrawing(placement);
  out += `<rect class="bed-travel" x="${X(work.x_min)}" y="${Y(work.y_max)}" width="${n(work.x_max - work.x_min)}" height="${n(work.y_max - work.y_min)}"/>`;
  if (target) {
    const tx = X(target.x);
    const ty = Y(target.y);
    out += `<g class="bed-target"><circle cx="${tx}" cy="${ty}" r="3.2"/><line x1="${n(tx - 7)}" y1="${ty}" x2="${n(tx + 7)}" y2="${ty}"/><line x1="${tx}" y1="${n(ty - 7)}" x2="${tx}" y2="${n(ty + 7)}"/></g>`;
    if (target.feature) out += `<circle class="bed-target-feature" cx="${X(target.feature.x)}" cy="${Y(target.feature.y)}" r="6.5"/>`;
  }
  return out + "</svg>";
}
