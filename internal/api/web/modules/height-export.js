// Pure field-probe height raster/export helpers. The application supplies the
// current outline, coordinate transforms, geometry predicates, and formatting
// callbacks so this module has no DOM, machine-I/O, or hidden state access.

export function interpolateZ(x, y, samples) {
  let num = 0;
  let den = 0;
  for (const s of samples) {
    const dx = x - s.x;
    const dy = y - s.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < 1e-9) return s.z;
    const w = 1 / d2;
    num += s.z * w;
    den += w;
  }
  return den ? num / den : 0;
}

export function buildInterpolatedHeightGrid({
  origin,
  getOutline = () => ({}),
  requireHeightExportOutline = () => {},
  outlineExportPoints,
  outlineEffectiveExportPoints,
  fieldProbeExportPoints,
  exportExtents,
  fieldProbeSpotGap,
  fieldProbeCenterSpacing,
  pointInPolygonOrBoundary,
  interpolateZ: interpolate = interpolateZ,
} = {}) {
  const outlineState = getOutline();
  requireHeightExportOutline(outlineState);
  const rawOutline = outlineExportPoints(origin, outlineState);
  const outline = outlineEffectiveExportPoints(origin, outlineState);
  const samples = fieldProbeExportPoints(origin, outlineState);
  if (rawOutline.length < 3 || outline.length < 3) throw new Error("closed outline needs at least three valid points");
  if (samples.length < 3) throw new Error("field probe needs at least three samples");
  const ext = exportExtents({ x_min: Infinity, x_max: -Infinity, y_min: Infinity, y_max: -Infinity }, outline);
  const spacing = fieldProbeCenterSpacing(fieldProbeSpotGap(outlineState));
  const cols = Math.max(2, Math.min(512, Math.floor(ext.width / spacing) + 1));
  const rows = Math.max(2, Math.min(512, Math.floor(ext.height / spacing) + 1));
  const actualX = ext.width / Math.max(1, cols - 1);
  const actualY = ext.height / Math.max(1, rows - 1);
  const grid = [];
  for (let r = 0; r < rows; r++) {
    const y = ext.y_min + r * actualY;
    const row = [];
    for (let c = 0; c < cols; c++) {
      const x = ext.x_min + c * actualX;
      if (!pointInPolygonOrBoundary({ x, y }, outline)) {
        row.push(null);
        continue;
      }
      row.push({ x, y, z: interpolate(x, y, samples) });
    }
    grid.push(row);
  }
  return {
    points: grid,
    rows,
    cols,
    xMin: ext.x_min,
    xMax: ext.x_max,
    yMin: ext.y_min,
    yMax: ext.y_max,
    xSpacing: actualX,
    ySpacing: actualY,
  };
}

export function buildHeightPGM({
  getOutline = () => ({}),
  requireHeightExportOutline = () => {},
  exportWorkOrigin,
  buildInterpolatedHeightGrid,
  fieldProbeHeightReference,
  axisValue,
  pathNum,
  fieldProbeSpotGap,
  PROBE_SPOT_DIAMETER_MM,
} = {}) {
  const outlineState = getOutline();
  requireHeightExportOutline(outlineState);
  const origin = exportWorkOrigin();
  const mesh = buildInterpolatedHeightGrid(origin, outlineState);
  const values = [];
  for (const row of mesh.points) {
    for (const p of row) if (p) values.push(p.z);
  }
  if (!values.length) throw new Error("field probe has no samples inside the outline");
  const minZ = Math.min(...values);
  const maxZ = Math.max(...values);
  const span = maxZ - minZ || 1;
  const reference = fieldProbeHeightReference(origin, outlineState);
  const originX = axisValue(origin, "x") ?? 0;
  const originY = axisValue(origin, "y") ?? 0;
  const rows = [
    "P2",
    "# CNC Proxy outline height image",
    "# units: mm",
    "# xy coordinates: CNC work coordinates",
    "# cnc_xy_origin_machine_mm: " + pathNum(originX) + " " + pathNum(originY),
    "# z coordinates: " + reference.label,
    "# z_reference_machine_mm: " + pathNum(reference.machineZ),
    "# x_min_mm: " + pathNum(mesh.xMin),
    "# x_max_mm: " + pathNum(mesh.xMax),
    "# y_min_mm: " + pathNum(mesh.yMin),
    "# y_max_mm: " + pathNum(mesh.yMax),
    "# x_spacing_mm: " + pathNum(mesh.xSpacing),
    "# y_spacing_mm: " + pathNum(mesh.ySpacing),
    "# raster_columns: X min to X max",
    "# raster_rows: Y max to Y min",
    "# probe_diameter_mm: " + pathNum(PROBE_SPOT_DIAMETER_MM),
    "# spot_gap_mm: " + pathNum(fieldProbeSpotGap(outlineState)),
    "# z_min_mm: " + pathNum(minZ),
    "# z_max_mm: " + pathNum(maxZ),
    mesh.cols + " " + mesh.rows,
    "65535",
  ];
  for (let r = mesh.rows - 1; r >= 0; r--) {
    const row = [];
    for (let c = 0; c < mesh.cols; c++) {
      const p = mesh.points[r][c];
      row.push(p ? String(Math.round(((p.z - minZ) / span) * 65535)) : "0");
    }
    rows.push(row.join(" "));
  }
  return rows.join("\n") + "\n";
}
