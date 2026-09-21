import test from "node:test";
import assert from "node:assert/strict";
import { buildOutlineDXF } from "./modules/outline-dxf.js";

test("DXF builder passes its state snapshot to coordinate helpers", () => {
  const snapshot = { points: [{ x: 1, y: 2 }, { x: 3, y: 4 }], closed: false, curveFit: false };
  let seen;
  const dxf = buildOutlineDXF({
    stateSnapshot: snapshot,
    exportWorkOrigin: () => ({ x: 0, y: 0 }),
    outlineExportPoints: (_origin, outline) => { seen = outline; return [{ x: 1, y: 2 }, { x: 3, y: 4 }]; },
    outlineEffectiveExportPoints: () => [],
    dxfNumber: (value) => String(value),
    dxfBounds: (points) => ({ minX: points[0].x, minY: points[0].y, maxX: points[points.length - 1].x, maxY: points[points.length - 1].y }),
    dxfPairs: (lines, pairs) => { for (const [code, value] of pairs) lines.push(String(code), String(value)); },
    addOutlinePolylineDXF: () => {},
  });
  assert.equal(seen, snapshot);
  assert.match(dxf, /SECTION/);
});