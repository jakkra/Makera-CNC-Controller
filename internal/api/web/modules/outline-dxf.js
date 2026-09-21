// R12 DXF export for a captured outline. The caller owns application state and
// supplies the current snapshot plus all coordinate/serialization helpers.
// This keeps export formatting independent from DOM, machine I/O, and feedback.

export function buildOutlineDXF({
  stateSnapshot,
  exportWorkOrigin,
  outlineEffectiveExportPoints,
  outlineExportPoints,
  dxfNumber,
  dxfBounds,
  dxfPairs,
  addOutlinePolylineDXF,
} = {}) {
  const outline = stateSnapshot || {};
  const origin = exportWorkOrigin();
  let points = outline.curveFit && outline.points.length >= 3
    ? outlineEffectiveExportPoints(origin, outline)
    : outlineExportPoints(origin, outline);
  if (outline.closed && points.length > 2) {
    const first = points[0];
    const last = points[points.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) <= 0.00005) points = points.slice(0, -1);
  }
  if (points.length < 2) throw new Error("outline needs at least two valid points");
  for (const point of points) {
    dxfNumber(point.x);
    dxfNumber(point.y);
  }

  const bounds = dxfBounds(points);
  const lines = [];
  dxfPairs(lines, [
    [0, "SECTION"],
    [2, "HEADER"],
    [9, "$ACADVER"],
    [1, "AC1009"],
    [9, "$INSBASE"],
    [10, 0],
    [20, 0],
    [30, 0],
    [9, "$INSUNITS"],
    [70, 4],
    [9, "$MEASUREMENT"],
    [70, 1],
    [9, "$EXTMIN"],
    [10, dxfNumber(bounds.minX)],
    [20, dxfNumber(bounds.minY)],
    [30, 0],
    [9, "$EXTMAX"],
    [10, dxfNumber(bounds.maxX)],
    [20, dxfNumber(bounds.maxY)],
    [30, 0],
    [0, "ENDSEC"],
    [0, "SECTION"],
    [2, "TABLES"],
    [0, "TABLE"],
    [2, "LTYPE"],
    [70, 1],
    [0, "LTYPE"],
    [2, "CONTINUOUS"],
    [70, 64],
    [3, "Solid line"],
    [72, 65],
    [73, 0],
    [40, 0],
    [0, "ENDTAB"],
    [0, "TABLE"],
    [2, "LAYER"],
    [70, 2],
    [0, "LAYER"],
    [2, "0"],
    [70, 0],
    [62, 7],
    [6, "CONTINUOUS"],
    [0, "LAYER"],
    [2, "OUTLINE"],
    [70, 0],
    [62, 7],
    [6, "CONTINUOUS"],
    [0, "ENDTAB"],
    [0, "ENDSEC"],
    [0, "SECTION"],
    [2, "ENTITIES"],
  ]);
  addOutlinePolylineDXF(lines, points, outline.closed);
  dxfPairs(lines, [
    [0, "ENDSEC"],
    [0, "EOF"],
  ]);
  return lines.join("\r\n") + "\r\n";
}
