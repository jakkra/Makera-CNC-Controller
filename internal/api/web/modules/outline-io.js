// Pure outline import/export and path serialization helpers.
// Browser state, DOM, and downloads stay in app.js; these functions only
// transform the values supplied by their callers.

export function pathNum(n) {
  if (!Number.isFinite(n)) return "0";
  const v = Math.abs(Number(n)) < 0.00005 ? 0 : Number(n);
  return v.toFixed(4).replace(/\.?0+$/, "");
}

export function pathPoint(p) {
  return pathNum(p.x) + " " + pathNum(p.y);
}

export function outlineCubicSegments(points, closed) {
  if (points.length < 2) return [];
  const count = closed ? points.length : points.length - 1;
  const segments = [];
  for (let i = 0; i < count; i++) {
    const p0 = closed ? points[(i - 1 + points.length) % points.length] : (i === 0 ? points[i] : points[i - 1]);
    const p1 = points[i];
    const p2 = closed ? points[(i + 1) % points.length] : points[i + 1];
    const p3 = closed ? points[(i + 2) % points.length] : (i + 2 < points.length ? points[i + 2] : p2);
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    segments.push({ start: p1, c1, c2, end: p2 });
  }
  return segments;
}

export function outlinePathD(points, closed, curveFit) {
  if (!points.length) return "";
  let d = "M " + pathPoint(points[0]);
  if (!curveFit || points.length < 3) {
    for (let i = 1; i < points.length; i++) d += " L " + pathPoint(points[i]);
    if (closed && points.length > 1) d += " Z";
    return d;
  }
  for (const segment of outlineCubicSegments(points, closed)) {
    d += " C " + pathPoint(segment.c1) + " " + pathPoint(segment.c2) + " " + pathPoint(segment.end);
  }
  return closed ? d + " Z" : d;
}

export function dxfPair(lines, code, value) {
  lines.push(String(code), String(value));
}

export function dxfPairs(lines, pairs) {
  for (const [code, value] of pairs) dxfPair(lines, code, value);
}

export function dxfNumber(value) {
  if (!Number.isFinite(value)) throw new Error("outline contains an invalid coordinate");
  return pathNum(value);
}

export function dxfBounds(points) {
  return points.reduce((bounds, point) => ({
    minX: Math.min(bounds.minX, point.x),
    minY: Math.min(bounds.minY, point.y),
    maxX: Math.max(bounds.maxX, point.x),
    maxY: Math.max(bounds.maxY, point.y),
  }), {
    minX: points[0].x,
    minY: points[0].y,
    maxX: points[0].x,
    maxY: points[0].y,
  });
}

export function addOutlinePolylineDXF(lines, points, closed) {
  dxfPairs(lines, [
    [0, "POLYLINE"],
    [8, "OUTLINE"],
    [66, 1],
    [70, closed ? 1 : 0],
    [10, 0],
    [20, 0],
    [30, 0],
  ]);
  for (const point of points) {
    dxfPairs(lines, [
      [0, "VERTEX"],
      [8, "OUTLINE"],
      [10, dxfNumber(point.x)],
      [20, dxfNumber(point.y)],
      [30, 0],
      [70, 0],
    ]);
  }
  dxfPairs(lines, [
    [0, "SEQEND"],
    [8, "OUTLINE"],
  ]);
}

export function outlineJSONDocument(outline, {
  cloneOutlinePoint,
  cloneOutlineOrigin,
  cloneFloorProbe,
  fieldProbeSpotGap,
} = {}) {
  if (outline.points.length < 2) throw new Error("outline needs at least two points");
  return {
    app: "cnc-proxy",
    kind: "capture-outline",
    version: 1,
    units: "mm",
    outline: {
      points: outline.points.map(cloneOutlinePoint),
      closed: !!outline.closed,
      curve_fit: !!outline.curveFit,
      origin: cloneOutlineOrigin(outline.origin),
      field_spot_gap_mm: fieldProbeSpotGap(),
      floor_machine_z: Number.isFinite(outline.floorMachineZ) ? outline.floorMachineZ : null,
      floor_probe: cloneFloorProbe(outline.floorProbe),
      field_reference_machine_z: Number.isFinite(outline.fieldReferenceMachineZ) ? outline.fieldReferenceMachineZ : null,
      field_reference_kind: outline.fieldReferenceKind || "",
      field_probe_complete: !!outline.fieldProbeComplete,
      field_probe_results: outline.fieldProbeResults.map(cloneOutlinePoint),
    },
  };
}

export function floorProbeFromJSON(raw, { cloneFloorProbe } = {}) {
  if (raw == null) return null;
  if (typeof raw !== "object") throw new Error("floor probe is invalid");
  const probe = cloneFloorProbe(raw);
  if (!probe) throw new Error("floor probe coordinates are invalid");
  return probe;
}

export function outlineOriginFromJSON(raw) {
  if (raw == null) return null;
  if (typeof raw !== "object") throw new Error("outline origin is invalid");
  const origin = {};
  for (const axis of ["x", "y", "z"]) {
    const value = Number(raw[axis]);
    if (Number.isFinite(value)) origin[axis] = value;
  }
  if (!Object.keys(origin).length) throw new Error("outline origin is invalid");
  return origin;
}

export function boundedOutlineNumber(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

export function outlinePointFromJSON(raw, index, { newID } = {}) {
  if (!raw || typeof raw !== "object") throw new Error("outline point " + index + " is invalid");
  const point = {};
  for (const field of ["x", "y", "z", "machine_x", "machine_y", "machine_z"]) {
    const value = Number(raw[field]);
    if (!Number.isFinite(value)) throw new Error("outline point " + index + " is missing " + field);
    point[field] = value;
  }
  point.id = typeof raw.id === "string" && raw.id ? raw.id.slice(0, 160) : newID("outline-point");
  point.captured_at = typeof raw.captured_at === "string" ? raw.captured_at.slice(0, 80) : "";
  point.probed = !!raw.probed;
  point.probe_kind = typeof raw.probe_kind === "string" ? raw.probe_kind.slice(0, 24) : "";
  point.probe_output = typeof raw.probe_output === "string" ? raw.probe_output.slice(0, 4096) : "";
  return point;
}

export function outlineStateFromJSON(doc, {
  defaultOutlineState,
  cloneFloorProbe,
  newID,
  axisValue,
  maxEffectiveOutlinePoints,
  maxFieldProbePoints,
  defaultFieldSpotGapMM,
} = {}) {
  if (!doc || doc.app !== "cnc-proxy" || doc.kind !== "capture-outline" || doc.version !== 1 || doc.units !== "mm") {
    throw new Error("file is not a CNC Proxy outline JSON export");
  }
  const raw = doc.outline;
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.points)) {
    throw new Error("outline points are missing");
  }
  if (raw.points.length < 2 || raw.points.length > maxEffectiveOutlinePoints) {
    throw new Error("outline must contain between 2 and " + maxEffectiveOutlinePoints + " points");
  }
  const next = defaultOutlineState();
  next.active = true;
  next.points = raw.points.map((point, i) => outlinePointFromJSON(point, i + 1, { newID }));
  next.closed = !!raw.closed;
  next.curveFit = !!raw.curve_fit;
  next.origin = outlineOriginFromJSON(raw.origin);
  next.fieldSpotGapMM = boundedOutlineNumber(raw.field_spot_gap_mm, 0, 250, defaultFieldSpotGapMM);
  next.floorProbe = floorProbeFromJSON(raw.floor_probe, { cloneFloorProbe });
  const floorMachineZ = Number(raw.floor_machine_z);
  next.floorMachineZ = next.floorProbe?.machine_z ??
    (raw.floor_machine_z !== null && raw.floor_machine_z !== "" && Number.isFinite(floorMachineZ) ? floorMachineZ : null);
  const fieldReferenceMachineZ = Number(raw.field_reference_machine_z);
  next.fieldReferenceMachineZ = raw.field_reference_machine_z !== null && raw.field_reference_machine_z !== "" && Number.isFinite(fieldReferenceMachineZ)
    ? fieldReferenceMachineZ
    : (Number.isFinite(next.floorMachineZ) ? next.floorMachineZ : axisValue(next.origin, "z"));
  next.fieldReferenceKind = raw.field_reference_kind === "floor" || raw.field_reference_kind === "work_origin"
    ? raw.field_reference_kind
    : (Number.isFinite(next.floorMachineZ) ? "floor" : (Number.isFinite(next.fieldReferenceMachineZ) ? "work_origin" : ""));
  const samples = raw.field_probe_results == null ? [] : raw.field_probe_results;
  if (!Array.isArray(samples) || samples.length > maxFieldProbePoints) {
    throw new Error("field probe samples are invalid");
  }
  next.fieldProbeResults = samples.map((point, i) => outlinePointFromJSON(point, i + 1, { newID }));
  next.fieldProbeComplete = raw.field_probe_complete === true && next.fieldProbeResults.length >= 3;
  return next;
}
