// Exact pure geometry extraction from app.js lines 4334-6325.
export const PROBE_SPOT_DIAMETER_MM = 2;
export const PROBE_SPOT_RADIUS_MM = PROBE_SPOT_DIAMETER_MM / 2;
export const DEFAULT_FIELD_SPOT_GAP_MM = 8;
export const MAX_FIELD_PROBE_POINTS = 1500;
export const OUTLINE_CURVE_TOLERANCE_MM = 0.25;
export const MAX_EFFECTIVE_OUTLINE_POINTS = 4000;

function fieldProbeCenterSpacing(gap = DEFAULT_FIELD_SPOT_GAP_MM) {
  return PROBE_SPOT_DIAMETER_MM + Math.max(0, Number(gap) || 0);
}

export function triangulationEdgeKey(a, b) {
  return Math.min(a, b) + ":" + Math.max(a, b);
}

export function triangleCross(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

export function pointInTriangle2D(point, a, b, c) {
  const epsilon = 1e-8;
  const ab = triangleCross(a, b, point);
  const bc = triangleCross(b, c, point);
  const ca = triangleCross(c, a, point);
  return ab >= -epsilon && bc >= -epsilon && ca >= -epsilon;
}

export function triangleCCW(points, face) {
  const a = points[face[0]], b = points[face[1]], c = points[face[2]];
  const twiceArea = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  return twiceArea < 0 ? [face[0], face[2], face[1]] : face;
}

export function pointInPolygonOrBoundary(point, polygon) {
  if (pointInPolygon(point, polygon)) return true;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    if (distancePointToSegment(point, polygon[j], polygon[i]) <= 0.00001) return true;
  }
  return false;
}
export function effectiveOutlineGeometry(points, closed, curveFit) {
  const source = (points || [])
    .map((p) => ({ x: Number(p.x), y: Number(p.y) }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  const out = [];
  let limited = false;
  const addPoint = (p) => {
    if (limited) return;
    const last = out[out.length - 1];
    if (last && Math.hypot(last.x - p.x, last.y - p.y) <= 0.00005) return;
    if (out.length >= MAX_EFFECTIVE_OUTLINE_POINTS) {
      limited = true;
      return;
    }
    out.push({ x: Number(p.x.toFixed(4)), y: Number(p.y.toFixed(4)) });
  };
  if (!source.length) return { points: [], limited: false };
  if (!curveFit || source.length < 3) {
    for (const p of source) addPoint(p);
    if (closed && source.length > 1) addPoint(source[0]);
    return { points: out, limited };
  }
  addPoint(source[0]);
  if (closed) {
    for (let i = 0; i < source.length && !limited; i++) {
      flattenCurveSegment(
        source[(i - 1 + source.length) % source.length],
        source[i],
        source[(i + 1) % source.length],
        source[(i + 2) % source.length],
        addPoint,
      );
    }
    addPoint(source[0]);
  } else {
    for (let i = 0; i < source.length - 1 && !limited; i++) {
      const p0 = i === 0 ? source[i] : source[i - 1];
      const p1 = source[i];
      const p2 = source[i + 1];
      const p3 = i + 2 < source.length ? source[i + 2] : p2;
      flattenCurveSegment(p0, p1, p2, p3, addPoint);
    }
  }
  return { points: out, limited };
}

export function flattenCurveSegment(p0, p1, p2, p3, addPoint) {
  const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
  const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
  flattenCubic(p1, c1, c2, p2, addPoint, 0);
}

export function flattenCubic(p0, c1, c2, p3, addPoint, depth) {
  if (depth >= 12 || cubicFlatEnough(p0, c1, c2, p3)) {
    addPoint(p3);
    return;
  }
  const a = midpoint(p0, c1);
  const b = midpoint(c1, c2);
  const c = midpoint(c2, p3);
  const d = midpoint(a, b);
  const e = midpoint(b, c);
  const m = midpoint(d, e);
  flattenCubic(p0, a, d, m, addPoint, depth + 1);
  flattenCubic(m, e, c, p3, addPoint, depth + 1);
}

export function cubicFlatEnough(p0, c1, c2, p3) {
  return distancePointToSegment(c1, p0, p3) <= OUTLINE_CURVE_TOLERANCE_MM &&
    distancePointToSegment(c2, p0, p3) <= OUTLINE_CURVE_TOLERANCE_MM;
}

export function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
export function buildFieldProbePreview(points, spotGap, outlinePoints = points) {
  const spacing = fieldProbeCenterSpacing(spotGap);
  const polygon = normalizedClosedPolygon(points);
  if (polygon.length < 3) return { points: [], tooDense: false, issue: "field probe needs a closed outline" };
  const boundary = buildBoundaryProbePoints(polygon, outlinePoints, spacing);
  if (boundary.issue || boundary.tooDense) {
    return { points: [], tooDense: !!boundary.tooDense, issue: boundary.issue || "spot gap creates too many probe points" };
  }
  // Keep every captured/border site fixed, construct the gap-safe first ring
  // needed by flattened curves, then globally optimize the remaining
  // reconstruction mesh. Exact Voronoi/Delaunay holes drive the final minimax
  // moves and any globally resolvable insertion.
  const field = buildRelaxedProbePoints(polygon, spacing, boundary.points);
  const ordered = boundary.points.concat(field.points);
  return {
    points: ordered.map((p, i) => ({
      id: "field-probe-" + String(i + 1).padStart(4, "0"),
      x: p.x,
      y: p.y,
      probe_kind: p.probe_kind,
    })),
    tooDense: field.tooDense,
    issue: field.tooDense ? "spot gap creates too many probe points" : "",
  };
}

export function normalizedClosedPolygon(points) {
  const out = (points || [])
    .map((p) => ({ x: Number(p.x), y: Number(p.y) }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (out.length > 1 && Math.hypot(out[0].x - out.at(-1).x, out[0].y - out.at(-1).y) <= 0.00005) out.pop();
  return out;
}

export function buildBoundaryProbePoints(polygon, outlinePoints, spacing) {
  const path = closedPathSegments(polygon);
  if (!path.segments.length || !Number.isFinite(spacing) || spacing <= 0) {
    return { points: [], tooDense: false, issue: "field probe needs a valid outline" };
  }
  const upperCount = Math.max(1, Math.floor(path.perimeter / spacing + 1e-9));
  if (upperCount >= MAX_FIELD_PROBE_POINTS) {
    return { points: [], tooDense: true, issue: "spot gap creates too many border probe points" };
  }
  // Every point captured by the operator is a mandatory physical probe. Curve
  // fitting changes only the path between those sites; it must never replace
  // them with generated border samples.
  const outlineSeeds = buildOutlineEdgeProbePoints(outlinePoints, path);
  if (outlineSeeds.issue) {
    return { points: [], tooDense: false, issue: outlineSeeds.issue };
  }
  const edgeSeeds = outlineSeeds.points;
  let best;
  if (edgeSeeds.length) {
    // Mandatory captured outline probes split the path into fixed-end
    // intervals. Equal subdivision is the exact minimax solution on each
    // interval: it minimizes its largest along-path gap while respecting the
    // minimum gap. This avoids concentrating the global phase remainder next
    // to a corner (the 1.6×-spacing border hole from the reported layout).
    best = buildCornerPartitionedBoundary(path, edgeSeeds, spacing);
  } else {
    best = buildClosedMinimaxBoundary(path, upperCount, spacing);
  }
  if (!best || best.points.length >= MAX_FIELD_PROBE_POINTS) {
    return { points: [], tooDense: true, issue: "spot gap creates too many border probe points" };
  }
  best.points.sort((a, b) => a.path_distance - b.path_distance);
  return {
    points: best.points.map((point) => ({
      x: point.x,
      y: point.y,
      path_distance: point.path_distance,
      probe_kind: point.probe_kind,
    })),
    tooDense: false,
    issue: "",
  };
}

export function buildCornerPartitionedBoundary(path, edgeSeeds, spacing) {
  const seeds = edgeSeeds.map((point) => ({ ...point })).sort((a, b) => a.path_distance - b.path_distance);
  const points = seeds.map((point) => ({ ...point }));
  const acceptedIndex = createProbeSpacingIndex(points, spacing);
  const intervals = seeds.map((seed, index) => {
    const next = seeds[(index + 1) % seeds.length];
    const end = next.path_distance + (index === seeds.length - 1 ? path.perimeter : 0);
    return { start: seed.path_distance, length: end - seed.path_distance, index };
  }).sort((a, b) => b.length - a.length || a.index - b.index);
  for (const interval of intervals) {
    const maximumParts = Math.max(1, Math.floor(interval.length / spacing + 1e-9));
    let selected = [];
    for (let parts = maximumParts; parts >= 1; parts--) {
      const trial = [];
      const trialIndex = createProbeSpacingIndex(points, spacing);
      let valid = true;
      for (let part = 1; part < parts; part++) {
        const distance = (interval.start + interval.length * part / parts) % path.perimeter;
        const sample = sampleClosedPathAtDistance(path, distance);
        const point = { ...sample, probe_kind: "border" };
        if (!probeSpacingIndexAllows(trialIndex, point)) {
          valid = false;
          break;
        }
        trial.push(point);
        addProbeSpacingPoint(trialIndex, point);
      }
      if (!valid) continue;
      selected = trial;
      break;
    }
    for (const point of selected) {
      if (!probeSpacingIndexAllows(acceptedIndex, point)) continue;
      points.push(point);
      addProbeSpacingPoint(acceptedIndex, point);
    }
  }
  return { points, maxArcGap: closedPathMaxSampleGap(points, path.perimeter) };
}

export function buildClosedMinimaxBoundary(path, upperCount, spacing) {
  let best = null;
  for (let count = upperCount; count >= 1; count--) {
    for (let phaseIndex = 0; phaseIndex < 24; phaseIndex++) {
      const samples = sampleClosedPath(path, count, phaseIndex / 24).map((sample) => ({
        ...sample,
        probe_kind: "border",
      }));
      const spacingIndex = createProbeSpacingIndex([], spacing);
      let valid = true;
      for (const sample of samples) {
        if (!probeSpacingIndexAllows(spacingIndex, sample)) {
          valid = false;
          break;
        }
        addProbeSpacingPoint(spacingIndex, sample);
      }
      if (!valid) continue;
      const candidate = { points: samples, maxArcGap: closedPathMaxSampleGap(samples, path.perimeter) };
      if (!best ||
          candidate.maxArcGap < best.maxArcGap - 1e-9 ||
          (Math.abs(candidate.maxArcGap - best.maxArcGap) <= 1e-9 && candidate.points.length > best.points.length)) {
        best = candidate;
      }
    }
    if (best) break;
  }
  return best || { points: [], maxArcGap: path.perimeter };
}

export function buildOutlineEdgeProbePoints(outlinePoints, path) {
  const points = normalizedClosedPolygon(outlinePoints);
  if (points.length < 3) return { points: [], issue: "" };
  const candidates = [];
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    const projection = projectPointToProbePath(point, path);
    candidates.push({
      ...projection,
      sourceX: point.x,
      sourceY: point.y,
      sourceIndex: index,
    });
  }
  candidates.sort((a, b) => a.path_distance - b.path_distance || a.sourceIndex - b.sourceIndex);
  const selected = candidates.map((candidate) => ({
      x: candidate.sourceX,
      y: candidate.sourceY,
      probe_kind: "outline",
      path_distance: candidate.path_distance,
    }));
  return { points: selected, issue: "" };
}

export function projectPointToProbePath(point, path) {
  let best = { x: path.segments[0].a.x, y: path.segments[0].a.y, path_distance: 0, distance2: Infinity };
  for (const segment of path.segments) {
    const dx = segment.b.x - segment.a.x;
    const dy = segment.b.y - segment.a.y;
    const t = Math.max(0, Math.min(1, ((point.x - segment.a.x) * dx + (point.y - segment.a.y) * dy) / (segment.length * segment.length)));
    const x = segment.a.x + dx * t;
    const y = segment.a.y + dy * t;
    const distance2Value = Math.pow(point.x - x, 2) + Math.pow(point.y - y, 2);
    const pathDistance = segment.start + t * segment.length;
    if (distance2Value < best.distance2 - 1e-12 ||
        (Math.abs(distance2Value - best.distance2) <= 1e-12 && pathDistance < best.path_distance)) {
      best = { x, y, path_distance: pathDistance, distance2: distance2Value };
    }
  }
  return best;
}

export function closedPathSegments(points) {
  const segments = [];
  let perimeter = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length <= 1e-9) continue;
    segments.push({ a, b, start: perimeter, end: perimeter + length, length });
    perimeter += length;
  }
  return { segments, perimeter };
}

export function sampleClosedPath(path, count, phaseFraction = 0) {
  if (!path?.segments?.length || !Number.isInteger(count) || count <= 0) return [];
  const step = path.perimeter / count;
  const out = [];
  let segmentIndex = 0;
  for (let i = 0; i < count; i++) {
    const distance = ((i + phaseFraction) * step) % path.perimeter;
    while (segmentIndex < path.segments.length - 1 && distance > path.segments[segmentIndex].end + 1e-9) {
      segmentIndex++;
    }
    const segment = path.segments[segmentIndex];
    if (!segment) continue;
    const t = Math.max(0, Math.min(1, (distance - segment.start) / segment.length));
    out.push({
      x: segment.a.x + (segment.b.x - segment.a.x) * t,
      y: segment.a.y + (segment.b.y - segment.a.y) * t,
      path_distance: distance,
    });
  }
  return out;
}

export function sampleClosedPathAtDistance(path, rawDistance) {
  const distance = ((rawDistance % path.perimeter) + path.perimeter) % path.perimeter;
  let segment = path.segments.at(-1);
  for (const candidate of path.segments) {
    if (distance <= candidate.end + 1e-9) {
      segment = candidate;
      break;
    }
  }
  const t = Math.max(0, Math.min(1, (distance - segment.start) / segment.length));
  return {
    x: segment.a.x + (segment.b.x - segment.a.x) * t,
    y: segment.a.y + (segment.b.y - segment.a.y) * t,
    path_distance: distance,
  };
}

export function closedPathMaxSampleGap(points, perimeter) {
  if (!points.length) return perimeter;
  const distances = points.map((point) => point.path_distance).sort((a, b) => a - b);
  let maxGap = distances[0] + perimeter - distances.at(-1);
  for (let i = 1; i < distances.length; i++) maxGap = Math.max(maxGap, distances[i] - distances[i - 1]);
  return maxGap;
}

export function createProbeSpacingIndex(points, spacing) {
  const index = { spacing, cells: new Map() };
  for (const point of points) addProbeSpacingPoint(index, point);
  return index;
}

export function addProbeSpacingPoint(index, point) {
  const cellX = Math.floor(point.x / index.spacing);
  const cellY = Math.floor(point.y / index.spacing);
  const key = cellX + ":" + cellY;
  const cell = index.cells.get(key) || [];
  cell.push(point);
  index.cells.set(key, cell);
}

export function probeSpacingIndexAllows(index, candidate) {
  const cellX = Math.floor(candidate.x / index.spacing);
  const cellY = Math.floor(candidate.y / index.spacing);
  for (let y = cellY - 1; y <= cellY + 1; y++) {
    for (let x = cellX - 1; x <= cellX + 1; x++) {
      for (const point of index.cells.get(x + ":" + y) || []) {
        if (Math.hypot(candidate.x - point.x, candidate.y - point.y) + 1e-9 < index.spacing) return false;
      }
    }
  }
  return true;
}

export function buildRelaxedProbePoints(polygon, spacing, reserved = []) {
  const domain = buildProbeDomainSamples(polygon, spacing);
  const boundaryCount = reserved.length;
  const boundaryTargets = buildBoundaryInteriorTargets(reserved, polygon, spacing);
  const boundarySeeds = selectGapSafeBoundaryInteriorSeeds(
    boundaryTargets,
    reserved,
    spacing,
  );
  const fixedCount = boundaryCount;
  const latticeReserved = reserved.concat(boundarySeeds);
  const initial = buildBestProbeLattice(polygon, spacing, latticeReserved, domain);
  const points = reserved.map((point) => ({ ...point }))
    .concat(boundarySeeds.map((point) => ({ ...point, probe_kind: "field" })))
    .concat(initial.points);
  let tooDense = points.length >= MAX_FIELD_PROBE_POINTS && initial.truncated;
  const largeField = points.length >= 250;
  // Solve ordinary plans as reconstruction meshes. Very large plans retain the
  // explicitly constructed boundary layer and use the bounded lattice path so
  // editing cannot lock the UI in the quadratic Delaunay solver.
  const meshOptimized = !tooDense && !largeField && optimizeProbeMesh(
    points,
    fixedCount,
    domain,
    polygon,
    spacing,
    boundaryTargets,
  );
  for (let cycle = 0; cycle < (meshOptimized || largeField ? 0 : 12) && !tooDense; cycle++) {
    for (let iteration = 0; iteration < 36; iteration++) {
      const moved = relaxProbeDistribution(points, fixedCount, domain, polygon, spacing, iteration);
      if (moved <= spacing * 0.0002 && probeDistributionValid(points, fixedCount, polygon, spacing)) break;
    }
    const hole = largestProbeCoverageHole(points, domain, spacing);
    if (!hole.point || hole.distance + 1e-9 < spacing) break;
    if (points.length >= MAX_FIELD_PROBE_POINTS) {
      tooDense = true;
      break;
    }
    points.push({ x: hole.point.x, y: hole.point.y, probe_kind: "field" });
  }
  for (let cycle = 0; cycle < (largeField ? 0 : 8) && !tooDense; cycle++) {
    const hole = largestExactFeasibleProbeHole(points, polygon, spacing);
    if (!hole.point || hole.distance + 1e-9 < spacing) break;
    if (points.length >= MAX_FIELD_PROBE_POINTS) {
      tooDense = true;
      break;
    }
    points.push({ x: hole.point.x, y: hole.point.y, probe_kind: "field" });
    for (let iteration = 0; iteration < 24; iteration++) {
      const moved = relaxProbeDistribution(points, fixedCount, domain, polygon, spacing, iteration);
      if (moved <= spacing * 0.0002 && probeDistributionValid(points, fixedCount, polygon, spacing)) break;
    }
  }
  if (!tooDense && !largeField) improveProbeCovering(points, fixedCount, polygon, spacing, 36);
  // Saturation alone is not optimality: a jammed packing can have no legal
  // insertion while still wasting enough area to support another site after
  // its neighbours move. Seed the worst Delaunay cell under an annealed gap,
  // solve the whole mesh again, and keep the extra probe only if exact hard-gap
  // projection succeeds and the certified covering radius improves.
  for (let insertion = 0;
    insertion < 3 && !tooDense && points.length < 250;
    insertion++) {
    const baseline = probeCoverageCertificate(points, polygon);
    if (points.length >= MAX_FIELD_PROBE_POINTS) {
      tooDense = true;
      break;
    }
    let accepted = null;
    const candidates = baseline.critical.filter((critical) =>
      critical.kind === "interior" &&
      critical.nearest.length > 0 &&
      probeSpotFitsPolygon(critical.point, polygon)
    ).slice(0, 1);
    for (const candidate of candidates) {
      const trial = points.map((point) => ({ ...point }));
      trial.push({ x: candidate.point.x, y: candidate.point.y, probe_kind: "field" });
      if (!optimizeProbeMesh(
        trial,
        fixedCount,
        domain,
        polygon,
        spacing,
        boundaryTargets,
        60,
        baseline,
      )) {
        continue;
      }
      accepted = trial;
      break;
    }
    if (!accepted) break;
    points.splice(0, points.length, ...accepted);
    improveProbeCovering(points, fixedCount, polygon, spacing, 24);
  }
  return {
    points: points.slice(boundaryCount).map((point) => ({
      x: point.x,
      y: point.y,
      probe_kind: "field",
    })),
    tooDense,
  };
}

export function optimizeProbeMesh(
  points,
  fixedCount,
  domain,
  polygon,
  spacing,
  boundaryTargets = [],
  iterationLimit = 80,
  comparisonCertificate = null,
) {
  if (points.length <= fixedCount || !domain.length) return false;
  const original = points.map((point) => ({ ...point }));
  const originalCertificate = comparisonCertificate || probeCoverageCertificate(points, polygon);
  const theoreticalRadius = spacing / Math.sqrt(3);
  const triangulationRefresh = polygon.length > 12 ? 1 : 4;
  let faces = [];
  for (let iteration = 0; iteration < iterationLimit; iteration++) {
    const progress = iterationLimit <= 1 ? 1 : iteration / (iterationLimit - 1);
    const targetLength = spacing * (0.72 + 0.28 * Math.min(1, progress * 1.25));
    const forceX = new Float64Array(points.length);
    const forceY = new Float64Array(points.length);
    const forceWeight = new Float64Array(points.length);
    const anchorX = new Float64Array(points.length);
    const anchorY = new Float64Array(points.length);
    const anchorWeight = new Float64Array(points.length);
    if (!faces.length || iteration % triangulationRefresh === 0) {
      faces = probeDelaunayTriangles(points);
    }
    const edges = new Set();
    const coverageCritical = [];
    for (const face of faces) {
      const center = averagePoint(face.map((index) => points[index]));
      if (!pointInPolygonOrBoundary(center, polygon)) continue;
      const circumcenter = triangleCircumcenter(
        points[face[0]],
        points[face[1]],
        points[face[2]],
      );
      if (circumcenter && pointInPolygonOrBoundary(circumcenter, polygon)) {
        const nearest = nearestProbeSet(circumcenter, points);
        coverageCritical.push({
          point: circumcenter,
          distance2: nearest.distance2,
          nearest: nearest.indices,
        });
      }
      for (const [first, second] of [
        [face[0], face[1]],
        [face[1], face[2]],
        [face[2], face[0]],
      ]) {
        const key = triangulationEdgeKey(first, second);
        if (edges.has(key)) continue;
        edges.add(key);
        const dx = points[second].x - points[first].x;
        const dy = points[second].y - points[first].y;
        const length = Math.hypot(dx, dy);
        if (length <= 1e-12 || length > spacing * 2.4) continue;
        const error = length - targetLength;
        const ux = dx / length;
        const uy = dy / length;
        const firstFree = first >= fixedCount;
        const secondFree = second >= fixedCount;
        if (firstFree) {
          forceX[first] += ux * error;
          forceY[first] += uy * error;
          forceWeight[first] += 1;
        }
        if (secondFree) {
          forceX[second] -= ux * error;
          forceY[second] -= uy * error;
          forceWeight[second] += 1;
        }
      }
    }
    coverageCritical.sort((first, second) => second.distance2 - first.distance2);
    const worstInteriorRadius = coverageCritical.length ?
      Math.sqrt(coverageCritical[0].distance2) :
      theoreticalRadius;
    const coverageCutoff = Math.max(theoreticalRadius, worstInteriorRadius * 0.82);
    for (const critical of coverageCritical) {
      const radius = Math.sqrt(critical.distance2);
      if (radius + 1e-9 < coverageCutoff) break;
      const pull = Math.max(0, radius - theoreticalRadius);
      for (const pointIndex of critical.nearest) {
        if (pointIndex < fixedCount) continue;
        const dx = critical.point.x - points[pointIndex].x;
        const dy = critical.point.y - points[pointIndex].y;
        const length = Math.hypot(dx, dy);
        if (length <= 1e-12) continue;
        forceX[pointIndex] += dx / length * pull * 1.8;
        forceY[pointIndex] += dy / length * pull * 1.8;
        forceWeight[pointIndex] += 1.8;
      }
    }
    const nearestIndex = createProbeNearestIndex(points, spacing);
    const sumX = new Float64Array(points.length);
    const sumY = new Float64Array(points.length);
    const sampleWeight = new Float64Array(points.length);
    for (const sample of domain) {
      const nearest = nearestIndexedProbe(nearestIndex, sample, fixedCount);
      if (nearest.index < fixedCount) continue;
      const weight = Math.max(0.1, nearest.distance2 / (spacing * spacing));
      sumX[nearest.index] += sample.x * weight;
      sumY[nearest.index] += sample.y * weight;
      sampleWeight[nearest.index] += weight;
    }
    for (const target of boundaryTargets) {
      const nearest = nearestIndexedProbe(nearestIndex, target, fixedCount);
      if (nearest.index < fixedCount) continue;
      sumX[nearest.index] += target.x * 3;
      sumY[nearest.index] += target.y * 3;
      sampleWeight[nearest.index] += 3;
    }
    for (let boundaryIndex = 0; boundaryIndex < fixedCount; boundaryIndex++) {
      const nearest = nearestIndexedProbe(nearestIndex, points[boundaryIndex], fixedCount);
      if (nearest.index < fixedCount) continue;
      const dx = points[boundaryIndex].x - points[nearest.index].x;
      const dy = points[boundaryIndex].y - points[nearest.index].y;
      const distance = Math.hypot(dx, dy);
      if (distance <= spacing || distance <= 1e-12) continue;
      anchorX[nearest.index] += dx / distance * (distance - spacing);
      anchorY[nearest.index] += dy / distance * (distance - spacing);
      anchorWeight[nearest.index]++;
    }
    const previous = points.map((point) => ({ ...point }));
    const maxStep = spacing * (0.12 - 0.07 * progress);
    const springStep = 0.2;
    const centroidStep = 0.08;
    for (let pointIndex = fixedCount; pointIndex < points.length; pointIndex++) {
      let dx = forceWeight[pointIndex] ?
        forceX[pointIndex] / forceWeight[pointIndex] * springStep :
        0;
      let dy = forceWeight[pointIndex] ?
        forceY[pointIndex] / forceWeight[pointIndex] * springStep :
        0;
      if (sampleWeight[pointIndex]) {
        dx += (sumX[pointIndex] / sampleWeight[pointIndex] - points[pointIndex].x) * centroidStep;
        dy += (sumY[pointIndex] / sampleWeight[pointIndex] - points[pointIndex].y) * centroidStep;
      }
      if (anchorWeight[pointIndex]) {
        dx += anchorX[pointIndex] / anchorWeight[pointIndex] * 2;
        dy += anchorY[pointIndex] / anchorWeight[pointIndex] * 2;
      }
      const length = Math.hypot(dx, dy);
      if (length > maxStep) {
        dx *= maxStep / length;
        dy *= maxStep / length;
      }
      const candidate = {
        ...points[pointIndex],
        x: points[pointIndex].x + dx,
        y: points[pointIndex].y + dy,
      };
      points[pointIndex] = probeSpotFitsPolygon(candidate, polygon) ?
        candidate :
        probePointInsideAlongMove(previous[pointIndex], candidate, polygon);
    }
  }
  const beforeProjection = points.map((point) => ({ ...point }));
  projectProbeSpacingConstraints(points, beforeProjection, fixedCount, polygon, spacing, 0, 240);
  if (!probeDistributionValid(points, fixedCount, polygon, spacing)) {
    points.splice(0, points.length, ...original);
    return false;
  }
  const optimizedCertificate = probeCoverageCertificate(points, polygon);
  if (!probeCoverageCertificateBetter(optimizedCertificate, originalCertificate)) {
    points.splice(0, points.length, ...original);
    return false;
  }
  return true;
}

export function buildBoundaryInteriorTargets(boundary, polygon, spacing) {
  if (boundary.length < 2) return [];
  const path = closedPathSegments(polygon);
  const ordered = boundary.map((point) => {
    if (Number.isFinite(point.path_distance)) return { ...point };
    return { ...point, ...projectPointToProbePath(point, path) };
  }).sort((first, second) => first.path_distance - second.path_distance);
  const fixedIndex = createProbeSpacingIndex(ordered, spacing);
  const targets = [];
  for (let index = 0; index < ordered.length; index++) {
    const first = ordered[index];
    const second = ordered[(index + 1) % ordered.length];
    const dx = second.x - first.x;
    const dy = second.y - first.y;
    const chord = Math.hypot(dx, dy);
    if (chord <= 1e-9 || chord > spacing * 2 + 1e-7) continue;
    const midpoint = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
    // The inward circle intersection is exactly `spacing` from both interval
    // endpoints. Projecting it away from all other fixed boundary probes gives
    // a constructive, feasible target for the first interior row.
    const idealHeight = Math.sqrt(Math.max(0, spacing * spacing - chord * chord / 4));
    const nx = -dy / chord;
    const ny = dx / chord;
    let target = null;
    for (const sign of [1, -1]) {
      const initialHeight = Math.max(idealHeight, PROBE_SPOT_RADIUS_MM + 0.0002);
      const candidate = {
        x: midpoint.x + nx * initialHeight * sign,
        y: midpoint.y + ny * initialHeight * sign,
      };
      if (!probeSpotFitsPolygon(candidate, polygon)) continue;
      const projected = projectBoundaryInteriorTarget(candidate, ordered, polygon, spacing);
      if (!projected || !probeSpacingIndexAllows(fixedIndex, projected)) continue;
      target = projected;
      break;
    }
    if (!target) continue;
    if (targets.some((existing) => Math.hypot(existing.x - target.x, existing.y - target.y) < spacing * 0.2)) continue;
    targets.push({
      ...target,
      boundary_edge_index: index,
      boundary_target_position: index + 0.5,
    });
  }
  // At a convex corner, the equilateral target for either incident edge is
  // usually too close to the boundary site on the other edge. The exact
  // circle intersection for the two neighbouring boundary sites is the
  // one-site bridge that minimizes both incident triangles while retaining the
  // full spacing from the corner itself.
  for (let index = 0; index < ordered.length; index++) {
    const previous = ordered[(index - 1 + ordered.length) % ordered.length];
    const corner = ordered[index];
    const next = ordered[(index + 1) % ordered.length];
    const dx = next.x - previous.x;
    const dy = next.y - previous.y;
    const chord = Math.hypot(dx, dy);
    if (chord <= 1e-9 || chord >= spacing * 2 - 1e-7) continue;
    const height = Math.sqrt(Math.max(0, spacing * spacing - chord * chord / 4));
    const center = {
      x: (previous.x + next.x) / 2,
      y: (previous.y + next.y) / 2,
    };
    const nx = -dy / chord;
    const ny = dx / chord;
    let best = null;
    for (const sign of [1, -1]) {
      const candidate = {
        x: center.x + nx * height * sign,
        y: center.y + ny * height * sign,
      };
      if (!probeSpotFitsPolygon(candidate, polygon) ||
          !probeSpacingIndexAllows(fixedIndex, candidate)) {
        continue;
      }
      const maxDistance2 = Math.max(
        distance2(previous, candidate),
        distance2(corner, candidate),
        distance2(next, candidate),
      );
      if (!best || maxDistance2 < best.maxDistance2) {
        best = { point: candidate, maxDistance2 };
      }
    }
    if (!best) continue;
    targets.push({
      ...best.point,
      boundary_corner_index: index,
      boundary_target_position: index,
    });
  }
  targets.sort((first, second) =>
    first.boundary_target_position - second.boundary_target_position
  );
  return targets;
}

export function selectGapSafeBoundaryInteriorSeeds(targets, boundary, spacing) {
  if (!targets.length) return [];
  const conflicts = targets.map(() => new Set());
  for (let first = 0; first < targets.length; first++) {
    for (let second = first + 1; second < targets.length; second++) {
      if (Math.hypot(
        targets[first].x - targets[second].x,
        targets[first].y - targets[second].y,
      ) + 1e-9 >= spacing) {
        continue;
      }
      conflicts[first].add(second);
      conflicts[second].add(first);
    }
  }
  const selectedIndices = new Set();
  const contested = new Set();
  const components = [];
  for (let index = 0; index < targets.length; index++) {
    if (!conflicts[index].size) {
      selectedIndices.add(index);
      continue;
    }
    if (contested.has(index)) continue;
    const component = [];
    const pending = [index];
    contested.add(index);
    while (pending.length) {
      const current = pending.pop();
      component.push(current);
      for (const adjacent of conflicts[current]) {
        if (contested.has(adjacent)) continue;
        contested.add(adjacent);
        pending.push(adjacent);
      }
    }
    components.push(component.sort((first, second) => first - second));
  }
  const base = [...selectedIndices].map((index) => targets[index]);
  for (const component of components) {
    // Conflicts are spatially local (normally the two edge targets and bridge
    // target around one corner). Enumerate every maximal independent subset,
    // then solve the incident boundary edges exactly.
    if (component.length > 16) {
      const local = [];
      for (const index of component) {
        if (local.some((selected) => conflicts[index].has(selected))) continue;
        local.push(index);
        selectedIndices.add(index);
      }
      continue;
    }
    const options = [];
    const subsetCount = 1 << component.length;
    for (let mask = 1; mask < subsetCount; mask++) {
      let valid = true;
      let maximal = true;
      const indices = [];
      for (let bit = 0; bit < component.length && valid; bit++) {
        if (!(mask & (1 << bit))) continue;
        const index = component[bit];
        indices.push(index);
        for (let other = bit + 1; other < component.length; other++) {
          if ((mask & (1 << other)) && conflicts[index].has(component[other])) {
            valid = false;
            break;
          }
        }
      }
      if (!valid) continue;
      for (let bit = 0; bit < component.length; bit++) {
        if (mask & (1 << bit)) continue;
        if (indices.every((index) => !conflicts[index].has(component[bit]))) {
          maximal = false;
          break;
        }
      }
      if (maximal) options.push(indices);
    }
    const affectedEdges = new Set();
    for (const index of component) {
      const target = targets[index];
      if (Number.isInteger(target.boundary_edge_index)) {
        affectedEdges.add(target.boundary_edge_index);
      }
      if (Number.isInteger(target.boundary_corner_index)) {
        affectedEdges.add((target.boundary_corner_index - 1 + boundary.length) % boundary.length);
        affectedEdges.add(target.boundary_corner_index);
      }
    }
    let best = null;
    for (const option of options) {
      const sites = base.concat(option.map((index) => targets[index]));
      let maxDistance2 = 0;
      let sumDistance2 = 0;
      for (const edgeIndex of affectedEdges) {
        const first = boundary[edgeIndex];
        const second = boundary[(edgeIndex + 1) % boundary.length];
        let edgeDistance2 = Infinity;
        for (const site of sites) {
          edgeDistance2 = Math.min(edgeDistance2, Math.max(
            distance2(first, site),
            distance2(second, site),
          ));
        }
        maxDistance2 = Math.max(maxDistance2, edgeDistance2);
        sumDistance2 += edgeDistance2;
      }
      const score = {
        option,
        maxDistance2,
        meanDistance2: sumDistance2 / Math.max(1, affectedEdges.size),
      };
      if (!best ||
          score.maxDistance2 < best.maxDistance2 - 1e-9 ||
          (Math.abs(score.maxDistance2 - best.maxDistance2) <= 1e-9 &&
           (score.meanDistance2 < best.meanDistance2 - 1e-9 ||
            (Math.abs(score.meanDistance2 - best.meanDistance2) <= 1e-9 &&
             score.option.length > best.option.length)))) {
        best = score;
      }
    }
    for (const index of best?.option || []) selectedIndices.add(index);
  }
  return [...selectedIndices].sort((first, second) => first - second).map((index) => ({
    ...targets[index],
    boundary_target_index: index,
  }));
}

export function projectBoundaryInteriorTarget(candidate, boundary, polygon, spacing) {
  let point = { ...candidate };
  for (let pass = 0; pass < 48; pass++) {
    const previous = { ...point };
    let worstOverlap = 0;
    for (let index = 0; index < boundary.length; index++) {
      const fixed = boundary[index];
      let dx = point.x - fixed.x;
      let dy = point.y - fixed.y;
      let distance = Math.hypot(dx, dy);
      if (distance + 1e-7 >= spacing) continue;
      if (distance <= 1e-12) {
        const angle = (index + 1) * 2.399963229728653;
        dx = Math.cos(angle);
        dy = Math.sin(angle);
        distance = 1;
      }
      const overlap = spacing + 0.0002 - distance;
      worstOverlap = Math.max(worstOverlap, overlap);
      point.x += dx / distance * overlap;
      point.y += dy / distance * overlap;
    }
    if (!probeSpotFitsPolygon(point, polygon)) {
      point = probePointInsideAlongMove(previous, point, polygon);
    }
    if (worstOverlap <= 0.0001) break;
    if (Math.hypot(point.x - previous.x, point.y - previous.y) <= 1e-10) return null;
  }
  if (!probeSpotFitsPolygon(point, polygon)) return null;
  return point;
}

export function largestExactFeasibleProbeHole(points, polygon, spacing) {
  const certificate = probeCoverageCertificate(points, polygon);
  const spacingIndex = createProbeSpacingIndex(points, spacing);
  for (const critical of certificate.critical) {
    if (critical.distance2 + 1e-8 < spacing * spacing) break;
    if (!probeSpotFitsPolygon(critical.point, polygon)) continue;
    if (!probeSpacingIndexAllows(spacingIndex, critical.point)) continue;
    return { point: critical.point, distance: Math.sqrt(critical.distance2) };
  }
  return { point: null, distance: 0 };
}

export function improveProbeCovering(points, fixedCount, polygon, spacing, maxIterations = 36) {
  if (points.length <= fixedCount) return;
  const theoreticalRadius = spacing / Math.sqrt(3);
  let certificate = probeCoverageCertificate(points, polygon);
  let step = spacing * 0.09;
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const worstRadius = Math.sqrt(certificate.maxDistance2);
    if (worstRadius <= theoreticalRadius + spacing * 0.0001) break;
    const cutoff = Math.max(theoreticalRadius, worstRadius * 0.985);
    const forceX = new Float64Array(points.length);
    const forceY = new Float64Array(points.length);
    const weights = new Float64Array(points.length);
    for (const critical of certificate.critical) {
      const radius = Math.sqrt(critical.distance2);
      if (radius + 1e-9 < cutoff) break;
      if (critical.kind !== "interior" || !critical.nearest.length) continue;
      const severity = Math.max(spacing * 0.002, radius - theoreticalRadius);
      for (const pointIndex of critical.nearest) {
        if (pointIndex < fixedCount) continue;
        const point = points[pointIndex];
        const dx = critical.point.x - point.x;
        const dy = critical.point.y - point.y;
        const length = Math.hypot(dx, dy);
        if (length <= 1e-12) continue;
        forceX[pointIndex] += dx / length * severity;
        forceY[pointIndex] += dy / length * severity;
        weights[pointIndex] += severity;
      }
    }
    if (!weights.some((weight) => weight > 0)) break;
    let accepted = null;
    let acceptedCertificate = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      const attemptStep = step * Math.pow(0.5, attempt);
      const proposed = points.map((point) => ({ ...point }));
      for (let pointIndex = fixedCount; pointIndex < proposed.length; pointIndex++) {
        if (!weights[pointIndex]) continue;
        let dx = forceX[pointIndex] / weights[pointIndex];
        let dy = forceY[pointIndex] / weights[pointIndex];
        const length = Math.hypot(dx, dy);
        if (length <= 1e-12) continue;
        const move = Math.min(attemptStep, length);
        proposed[pointIndex].x += dx / length * move;
        proposed[pointIndex].y += dy / length * move;
      }
      projectProbeSpacingConstraints(proposed, points, fixedCount, polygon, spacing, iteration);
      if (!probeDistributionValid(proposed, fixedCount, polygon, spacing)) continue;
      let maxMove = 0;
      for (let pointIndex = fixedCount; pointIndex < proposed.length; pointIndex++) {
        maxMove = Math.max(maxMove, Math.hypot(
          proposed[pointIndex].x - points[pointIndex].x,
          proposed[pointIndex].y - points[pointIndex].y,
        ));
      }
      if (maxMove <= spacing * 1e-8) continue;
      const proposedCertificate = probeCoverageCertificate(proposed, polygon);
      if (!probeCoverageCertificateBetter(proposedCertificate, certificate)) continue;
      accepted = proposed;
      acceptedCertificate = proposedCertificate;
      step = Math.min(spacing * 0.12, attemptStep * 1.25);
      break;
    }
    if (!accepted) {
      break;
    }
    for (let pointIndex = fixedCount; pointIndex < points.length; pointIndex++) {
      points[pointIndex].x = accepted[pointIndex].x;
      points[pointIndex].y = accepted[pointIndex].y;
    }
    certificate = acceptedCertificate;
  }
}

export function probeCoverageCertificateBetter(candidate, current) {
  const scale = Math.max(1, current.maxDistance2, candidate.maxDistance2);
  const tolerance = scale * 1e-9;
  if (candidate.maxDistance2 < current.maxDistance2 - tolerance) return true;
  if (candidate.maxDistance2 > current.maxDistance2 + tolerance) return false;
  const limit = Math.min(24, candidate.critical.length, current.critical.length);
  for (let index = 1; index < limit; index++) {
    const difference = candidate.critical[index].distance2 - current.critical[index].distance2;
    if (difference < -tolerance) return true;
    if (difference > tolerance) return false;
  }
  return false;
}

export function buildProbeDomainSamples(polygon, spacing) {
  const bounds = pointBounds(polygon);
  const width = Math.max(0, bounds.x_max - bounds.x_min);
  const height = Math.max(0, bounds.y_max - bounds.y_min);
  const maxSamples = 30000;
  const step = Math.max(spacing / 4, Math.sqrt((width * height) / maxSamples) || spacing / 4);
  const samples = [];
  let row = 0;
  for (let y = bounds.y_min + PROBE_SPOT_RADIUS_MM; y <= bounds.y_max - PROBE_SPOT_RADIUS_MM + 1e-9; y += step, row++) {
    const offset = row % 2 ? step / 2 : 0;
    for (let x = bounds.x_min + PROBE_SPOT_RADIUS_MM + offset; x <= bounds.x_max - PROBE_SPOT_RADIUS_MM + 1e-9; x += step) {
      const point = { x, y };
      if (probeSpotFitsPolygon(point, polygon)) samples.push(point);
    }
  }
  const center = polygonCentroid(polygon);
  if (probeSpotFitsPolygon(center, polygon)) samples.push(center);
  return samples;
}

export function buildBestProbeLattice(polygon, spacing, reserved, domain) {
  const offsets = [0, 0.5];
  const scoreStride = Math.max(1, Math.ceil(domain.length / 2500));
  const scoringDomain = scoreStride === 1 ? domain : domain.filter((_, index) => index % scoreStride === 0);
  let best = { points: [], truncated: false, score: null };
  const consider = (candidate) => {
    if (candidate.truncated) return { ...candidate, score: null };
    const score = probeCoverageScore(reserved.concat(candidate.points), scoringDomain, spacing);
    if (!best.score ||
        score.maxDistance2 < best.score.maxDistance2 - 1e-9 ||
        (Math.abs(score.maxDistance2 - best.score.maxDistance2) <= 1e-9 &&
         (score.meanDistance2 < best.score.meanDistance2 - 1e-9 ||
          (Math.abs(score.meanDistance2 - best.score.meanDistance2) <= 1e-9 &&
           candidate.points.length > best.points.length)))) {
      best = { ...candidate, score };
    }
    return null;
  };
  for (const kind of ["triangular", "square"]) {
    const rotationDegrees = kind === "triangular" ? [0, 10, 20, 30, 40, 50] : [0, 15, 30, 45, 60, 75];
    const rotations = rotationDegrees.map((degrees) => degrees * Math.PI / 180);
    for (const rotation of rotations) {
      for (const offsetX of offsets) {
        for (const offsetY of offsets) {
          const candidate = buildProbeLatticeCandidate(polygon, spacing, reserved, kind, rotation, offsetX, offsetY);
          // This one lattice is already a constructive proof that more than
          // the supported number of mutually gap-safe probes fit. No broader
          // search or relaxation can make the requested preview usable.
          const truncated = consider(candidate);
          if (truncated) return truncated;
        }
      }
    }
  }
  return best;
}

export function buildProbeLatticeCandidate(polygon, spacing, reserved, kind, rotation, offsetXFrac, offsetYFrac) {
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const toLattice = (point) => ({ x: point.x * cos + point.y * sin, y: -point.x * sin + point.y * cos });
  const fromLattice = (point) => ({ x: point.x * cos - point.y * sin, y: point.x * sin + point.y * cos });
  const bounds = pointBounds(polygon.map(toLattice));
  const rowGap = kind === "triangular" ? spacing * Math.sqrt(3) / 2 : spacing;
  const firstY = Math.floor((bounds.y_min - rowGap) / rowGap) * rowGap + offsetYFrac * rowGap;
  const firstX = Math.floor((bounds.x_min - spacing) / spacing) * spacing + offsetXFrac * spacing;
  const spacingIndex = createProbeSpacingIndex(reserved, spacing);
  const points = [];
  let truncated = false;
  let row = 0;
  for (let y = firstY; y <= bounds.y_max + rowGap + 1e-9; y += rowGap, row++) {
    const rowOffset = kind === "triangular" && row % 2 ? spacing / 2 : 0;
    for (let x = firstX + rowOffset; x <= bounds.x_max + spacing + 1e-9; x += spacing) {
      const source = fromLattice({ x, y });
      const point = { x: source.x, y: source.y, probe_kind: "field" };
      if (!probeSpotFitsPolygon(point, polygon) || !probeSpacingIndexAllows(spacingIndex, point)) continue;
      if (reserved.length + points.length >= MAX_FIELD_PROBE_POINTS) {
        truncated = true;
        break;
      }
      points.push(point);
      addProbeSpacingPoint(spacingIndex, point);
    }
    if (truncated) break;
  }
  return { points, truncated };
}

export function probeCoverageScore(points, domain, spacing) {
  if (!points.length || !domain.length) return { maxDistance2: Infinity, meanDistance2: Infinity };
  const index = createProbeNearestIndex(points, spacing);
  let maxDistance2 = 0;
  let sumDistance2 = 0;
  for (const sample of domain) {
    const nearest = nearestIndexedProbe(index, sample).distance2;
    maxDistance2 = Math.max(maxDistance2, nearest);
    sumDistance2 += nearest;
  }
  return { maxDistance2, meanDistance2: sumDistance2 / domain.length };
}

// Return the exact covering radius for this finite probe set over the polygon.
// In the interior, every local maximum of the nearest-site distance is a
// Voronoi vertex, hence the circumcenter of a Delaunay triangle. On a polygon
// edge, all squared point distances share the same quadratic term; their lower
// envelope changes only where two affine remainders cross. Evaluating those
// breakpoints makes the boundary result exact as well—there is no raster/grid
// resolution hidden in this certificate.
export function probeCoverageCertificate(points, polygon) {
  if (!points.length || polygon.length < 3) {
    return { maxDistance2: Infinity, point: null, critical: [], exact: false };
  }
  const critical = [];
  const faces = probeDelaunayTriangles(points);
  for (const face of faces) {
    const center = triangleCircumcenter(points[face[0]], points[face[1]], points[face[2]]);
    if (!center || !pointInPolygonOrBoundary(center, polygon)) continue;
    const nearest = nearestProbeSet(center, points);
    critical.push({
      point: center,
      distance2: nearest.distance2,
      nearest: nearest.indices,
      kind: "interior",
    });
  }
  const boundary = exactBoundaryProbeCriticalPoints(points, polygon);
  critical.push(...boundary);
  if (!critical.length) {
    const point = polygonCentroid(polygon);
    const nearest = nearestProbeSet(point, points);
    critical.push({ point, distance2: nearest.distance2, nearest: nearest.indices, kind: "fallback" });
  }
  critical.sort((a, b) =>
    b.distance2 - a.distance2 ||
    a.point.y - b.point.y ||
    a.point.x - b.point.x
  );
  return {
    maxDistance2: critical[0].distance2,
    point: critical[0].point,
    critical,
    exact: true,
  };
}

export function probeMeshQualityCertificate(points, polygon) {
  let triangleCount = 0;
  let maxEdge = 0;
  let minAngle = Math.PI;
  let maxRadiusEdgeRatio = 0;
  for (const face of probeDelaunayTriangles(points)) {
    const triangle = face.map((index) => points[index]);
    const centroid = averagePoint(triangle);
    const edgeMidpoints = [
      midpoint(triangle[0], triangle[1]),
      midpoint(triangle[1], triangle[2]),
      midpoint(triangle[2], triangle[0]),
    ];
    if (!pointInPolygonOrBoundary(centroid, polygon) ||
        edgeMidpoints.some((point) => !pointInPolygonOrBoundary(point, polygon))) {
      continue;
    }
    const sides = [
      Math.hypot(triangle[1].x - triangle[0].x, triangle[1].y - triangle[0].y),
      Math.hypot(triangle[2].x - triangle[1].x, triangle[2].y - triangle[1].y),
      Math.hypot(triangle[0].x - triangle[2].x, triangle[0].y - triangle[2].y),
    ];
    const shortest = Math.min(...sides);
    const longest = Math.max(...sides);
    if (shortest <= 1e-12) continue;
    const angles = sides.map((opposite, index) => {
      const first = sides[(index + 1) % 3];
      const second = sides[(index + 2) % 3];
      const cosine = (first * first + second * second - opposite * opposite) /
        (2 * first * second);
      return Math.acos(Math.max(-1, Math.min(1, cosine)));
    });
    const circumcenter = triangleCircumcenter(...triangle);
    if (!circumcenter) continue;
    triangleCount++;
    maxEdge = Math.max(maxEdge, longest);
    minAngle = Math.min(minAngle, ...angles);
    maxRadiusEdgeRatio = Math.max(
      maxRadiusEdgeRatio,
      Math.sqrt(distance2(circumcenter, triangle[0])) / shortest,
    );
  }
  return {
    exact: true,
    triangleCount,
    maxEdge,
    minAngleDegrees: triangleCount ? minAngle * 180 / Math.PI : 0,
    maxRadiusEdgeRatio,
  };
}

// Exhaustively certify the first reconstruction layer. For every consecutive
// pair of physical boundary probes, choose the field probe that minimizes the
// longer of its two incident triangle edges. This directly measures the
// boundary-to-field moat that a global nearest-neighbour score can hide.
export function probeBoundaryLayerCertificate(points, polygon) {
  const firstField = points.findIndex((point) => point.probe_kind === "field");
  if (firstField < 2 || firstField >= points.length) {
    return { exact: true, edgeCount: 0, maxThirdEdge: Infinity, worst: null };
  }
  const boundary = points.slice(0, firstField);
  const field = points.slice(firstField);
  const edges = [];
  for (let edgeIndex = 0; edgeIndex < boundary.length; edgeIndex++) {
    const first = boundary[edgeIndex];
    const second = boundary[(edgeIndex + 1) % boundary.length];
    let best = null;
    for (let fieldIndex = 0; fieldIndex < field.length; fieldIndex++) {
      const point = field[fieldIndex];
      const centroid = averagePoint([first, second, point]);
      const edgeMidpoints = [
        midpoint(first, point),
        midpoint(second, point),
      ];
      if (!pointInPolygonOrBoundary(centroid, polygon) ||
          edgeMidpoints.some((candidate) => !pointInPolygonOrBoundary(candidate, polygon))) {
        continue;
      }
      const firstDistance = Math.hypot(point.x - first.x, point.y - first.y);
      const secondDistance = Math.hypot(point.x - second.x, point.y - second.y);
      const maxThirdEdge = Math.max(firstDistance, secondDistance);
      const candidate = {
        edgeIndex,
        fieldIndex: firstField + fieldIndex,
        firstDistance,
        secondDistance,
        maxThirdEdge,
      };
      if (!best ||
          candidate.maxThirdEdge < best.maxThirdEdge - 1e-9 ||
          (Math.abs(candidate.maxThirdEdge - best.maxThirdEdge) <= 1e-9 &&
           candidate.fieldIndex < best.fieldIndex)) {
        best = candidate;
      }
    }
    if (best) edges.push(best);
  }
  edges.sort((first, second) =>
    second.maxThirdEdge - first.maxThirdEdge ||
    first.edgeIndex - second.edgeIndex
  );
  return {
    exact: true,
    edgeCount: edges.length,
    maxThirdEdge: edges[0]?.maxThirdEdge ?? Infinity,
    worst: edges[0] || null,
    edges,
  };
}

export function probeDelaunayTriangles(points) {
  if (points.length < 3) return [];
  const bounds = pointBounds(points);
  const span = Math.max(bounds.x_max - bounds.x_min, bounds.y_max - bounds.y_min, 1);
  const centerX = (bounds.x_min + bounds.x_max) / 2;
  const centerY = (bounds.y_min + bounds.y_max) / 2;
  const vertices = points.concat([
    { x: centerX - 32 * span, y: centerY - 24 * span },
    { x: centerX, y: centerY + 32 * span },
    { x: centerX + 32 * span, y: centerY - 24 * span },
  ]);
  const pointCount = points.length;
  let faces = [[pointCount, pointCount + 1, pointCount + 2]];
  const insertionOrder = points.map((point, index) => ({ point, index }))
    .sort((first, second) =>
      first.point.x - second.point.x ||
      first.point.y - second.point.y ||
      first.index - second.index
    );
  for (const insertion of insertionOrder) {
    const bad = [];
    for (let faceIndex = 0; faceIndex < faces.length; faceIndex++) {
      const face = faces[faceIndex];
      if (probePointInCircumcircle(
        insertion.point,
        vertices[face[0]],
        vertices[face[1]],
        vertices[face[2]],
      )) {
        bad.push(faceIndex);
      }
    }
    if (!bad.length) throw new Error("probe coverage triangulation could not insert a site");
    const badSet = new Set(bad);
    const edges = new Map();
    for (const faceIndex of bad) {
      const face = faces[faceIndex];
      for (const [a, b] of [[face[0], face[1]], [face[1], face[2]], [face[2], face[0]]]) {
        const key = triangulationEdgeKey(a, b);
        const edge = edges.get(key) || { a, b, count: 0 };
        edge.count++;
        edges.set(key, edge);
      }
    }
    faces = faces.filter((_, faceIndex) => !badSet.has(faceIndex));
    for (const edge of edges.values()) {
      if (edge.count !== 1) continue;
      if (Math.abs(triangleCross(vertices[edge.a], vertices[edge.b], insertion.point)) <= 1e-12) continue;
      faces.push(triangleCCW(vertices, [edge.a, edge.b, insertion.index]));
    }
  }
  const result = faces.filter((face) => face.every((index) => index < pointCount));
  const used = new Set(result.flat());
  if (used.size !== pointCount) throw new Error("probe coverage triangulation omitted a site");
  return result;
}

export function probePointInCircumcircle(point, a, b, c) {
  const center = triangleCircumcenter(a, b, c);
  if (!center) return false;
  const radius2 = distance2(center, a);
  const tolerance = Math.max(1, radius2) * 1e-10;
  return distance2(center, point) <= radius2 + tolerance;
}

export function triangleCircumcenter(a, b, c) {
  const denominator = 2 * (
    a.x * (b.y - c.y) +
    b.x * (c.y - a.y) +
    c.x * (a.y - b.y)
  );
  const scale = Math.max(
    Math.hypot(b.x - a.x, b.y - a.y),
    Math.hypot(c.x - b.x, c.y - b.y),
    Math.hypot(a.x - c.x, a.y - c.y),
    1,
  );
  if (Math.abs(denominator) <= scale * scale * 1e-12) return null;
  const aa = a.x * a.x + a.y * a.y;
  const bb = b.x * b.x + b.y * b.y;
  const cc = c.x * c.x + c.y * c.y;
  return {
    x: (aa * (b.y - c.y) + bb * (c.y - a.y) + cc * (a.y - b.y)) / denominator,
    y: (aa * (c.x - b.x) + bb * (a.x - c.x) + cc * (b.x - a.x)) / denominator,
  };
}

export function nearestProbeSet(candidate, points) {
  let nearest = Infinity;
  let indices = [];
  for (let index = 0; index < points.length; index++) {
    const value = distance2(candidate, points[index]);
    if (!Number.isFinite(nearest)) {
      nearest = value;
      indices = [index];
      continue;
    }
    const tolerance = Math.max(1, nearest, value) * 1e-8;
    if (value < nearest - tolerance) {
      nearest = value;
      indices = [index];
    } else if (Math.abs(value - nearest) <= tolerance) {
      indices.push(index);
    }
  }
  return { distance2: nearest, indices };
}

export function exactBoundaryProbeCriticalPoints(points, polygon) {
  const critical = [];
  for (let edgeIndex = 0; edgeIndex < polygon.length; edgeIndex++) {
    const a = polygon[edgeIndex];
    const b = polygon[(edgeIndex + 1) % polygon.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length2 = dx * dx + dy * dy;
    if (length2 <= 1e-18) continue;
    const lines = points.map((point, index) => ({
      slope: 2 * (dx * (a.x - point.x) + dy * (a.y - point.y)),
      intercept: distance2(a, point),
      index,
    })).sort((first, second) =>
      second.slope - first.slope ||
      first.intercept - second.intercept ||
      first.index - second.index
    );
    const unique = [];
    for (const line of lines) {
      const previous = unique.at(-1);
      const tolerance = Math.max(1, Math.abs(line.slope), Math.abs(previous?.slope || 0)) * 1e-12;
      if (previous && Math.abs(line.slope - previous.slope) <= tolerance) continue;
      unique.push(line);
    }
    const hull = [];
    for (const line of unique) {
      let start = -Infinity;
      while (hull.length) {
        const previous = hull.at(-1);
        start = (previous.line.intercept - line.intercept) / (line.slope - previous.line.slope);
        if (start > previous.start + 1e-12) break;
        hull.pop();
      }
      if (!hull.length) start = -Infinity;
      hull.push({ line, start });
    }
    const parameters = [0, 1];
    for (let index = 1; index < hull.length; index++) {
      if (hull[index].start > 0 && hull[index].start < 1) parameters.push(hull[index].start);
    }
    for (const t of parameters) {
      const point = { x: a.x + dx * t, y: a.y + dy * t };
      const nearest = nearestProbeSet(point, points);
      critical.push({
        point,
        distance2: nearest.distance2,
        nearest: nearest.indices,
        kind: "boundary",
        edge: edgeIndex,
      });
    }
  }
  return critical;
}

export function largestProbeCoverageHole(points, domain, spacing) {
  if (!points.length || !domain.length) return { point: null, distance: 0 };
  const index = createProbeNearestIndex(points, spacing);
  let point = null;
  let distance2Value = -Infinity;
  for (const sample of domain) {
    const nearest = nearestIndexedProbe(index, sample).distance2;
    if (nearest > distance2Value + 1e-12) {
      point = sample;
      distance2Value = nearest;
    }
  }
  return { point, distance: Math.sqrt(Math.max(0, distance2Value)) };
}

export function relaxProbeDistribution(points, fixedCount, domain, polygon, spacing, iteration) {
  if (points.length <= fixedCount || !domain.length) return 0;
  const index = createProbeNearestIndex(points, spacing);
  const sumX = new Float64Array(points.length);
  const sumY = new Float64Array(points.length);
  const counts = new Uint32Array(points.length);
  for (const sample of domain) {
    // Fixed boundary and first-ring sites own their actual Voronoi cells.
    // Samples assigned to those cells must not pull a deeper movable site
    // through the hard spacing barrier.
    const nearest = nearestIndexedProbe(index, sample);
    if (nearest.index < fixedCount) continue;
    sumX[nearest.index] += sample.x;
    sumY[nearest.index] += sample.y;
    counts[nearest.index]++;
  }
  const proposed = points.map((point) => ({ ...point }));
  const relaxation = 0.42;
  const maxStep = spacing * 0.28;
  for (let pointIndex = fixedCount; pointIndex < points.length; pointIndex++) {
    if (!counts[pointIndex]) continue;
    const point = points[pointIndex];
    let vx = (sumX[pointIndex] / counts[pointIndex] - point.x) * relaxation;
    let vy = (sumY[pointIndex] / counts[pointIndex] - point.y) * relaxation;
    const length = Math.hypot(vx, vy);
    if (length > maxStep) {
      vx *= maxStep / length;
      vy *= maxStep / length;
    }
    proposed[pointIndex].x += vx;
    proposed[pointIndex].y += vy;
  }
  projectProbeSpacingConstraints(proposed, points, fixedCount, polygon, spacing, iteration);
  if (!probeDistributionValid(proposed, fixedCount, polygon, spacing)) {
    let accepted = null;
    for (let attempt = 1; attempt <= 14; attempt++) {
      const alpha = Math.pow(2, -attempt);
      const blended = points.map((point, pointIndex) => pointIndex < fixedCount ? point : ({
        ...point,
        x: point.x + (proposed[pointIndex].x - point.x) * alpha,
        y: point.y + (proposed[pointIndex].y - point.y) * alpha,
      }));
      if (probeDistributionValid(blended, fixedCount, polygon, spacing)) {
        accepted = blended;
        break;
      }
    }
    if (!accepted) return 0;
    proposed.splice(0, proposed.length, ...accepted);
  }
  let maxMove = 0;
  for (let pointIndex = fixedCount; pointIndex < points.length; pointIndex++) {
    maxMove = Math.max(maxMove, Math.hypot(proposed[pointIndex].x - points[pointIndex].x, proposed[pointIndex].y - points[pointIndex].y));
    points[pointIndex].x = proposed[pointIndex].x;
    points[pointIndex].y = proposed[pointIndex].y;
  }
  return maxMove;
}

export function createProbeNearestIndex(points, spacing) {
  const index = { spacing, points, cells: new Map() };
  for (let pointIndex = 0; pointIndex < points.length; pointIndex++) {
    const point = points[pointIndex];
    const cellX = Math.floor(point.x / spacing);
    const cellY = Math.floor(point.y / spacing);
    const key = cellX + ":" + cellY;
    const cell = index.cells.get(key) || [];
    cell.push(pointIndex);
    index.cells.set(key, cell);
  }
  return index;
}

export function nearestIndexedProbe(index, candidate, minimumIndex = 0) {
  const cellX = Math.floor(candidate.x / index.spacing);
  const cellY = Math.floor(candidate.y / index.spacing);
  let bestIndex = -1;
  let bestDistance2 = Infinity;
  for (let radius = 0; radius <= 3; radius++) {
    for (let y = cellY - radius; y <= cellY + radius; y++) {
      for (let x = cellX - radius; x <= cellX + radius; x++) {
        if (radius && x > cellX - radius && x < cellX + radius && y > cellY - radius && y < cellY + radius) continue;
        for (const pointIndex of index.cells.get(x + ":" + y) || []) {
          if (pointIndex < minimumIndex) continue;
          const distance = distance2(candidate, index.points[pointIndex]);
          if (distance < bestDistance2) {
            bestDistance2 = distance;
            bestIndex = pointIndex;
          }
        }
      }
    }
    if (bestIndex >= 0 && bestDistance2 <= Math.pow(radius * index.spacing, 2)) break;
  }
  if (bestIndex < 0) {
    for (let pointIndex = minimumIndex; pointIndex < index.points.length; pointIndex++) {
      const distance = distance2(candidate, index.points[pointIndex]);
      if (distance < bestDistance2) {
        bestDistance2 = distance;
        bestIndex = pointIndex;
      }
    }
  }
  return { index: bestIndex, distance2: bestDistance2 };
}

export function projectProbeSpacingConstraints(proposed, previous, fixedCount, polygon, spacing, iteration, passLimit = 10) {
  const target = spacing + 0.0002;
  for (let pass = 0; pass < passLimit; pass++) {
    let maxOverlap = 0;
    const index = createProbeNearestIndex(proposed, spacing);
    for (let i = 0; i < proposed.length; i++) {
      const cellX = Math.floor(proposed[i].x / spacing);
      const cellY = Math.floor(proposed[i].y / spacing);
      for (let y = cellY - 1; y <= cellY + 1; y++) {
        for (let x = cellX - 1; x <= cellX + 1; x++) {
          for (const j of index.cells.get(x + ":" + y) || []) {
            if (j <= i) continue;
            let dx = proposed[i].x - proposed[j].x;
            let dy = proposed[i].y - proposed[j].y;
            let distance = Math.hypot(dx, dy);
            if (distance >= target) continue;
            if (distance <= 1e-12) {
              const angle = ((i + 1) * 2.399963229728653 + (j + iteration + 1) * 0.7548776662466927);
              dx = Math.cos(angle);
              dy = Math.sin(angle);
              distance = 1;
            }
            const overlap = target - distance;
            const ux = dx / distance;
            const uy = dy / distance;
            const iFree = i >= fixedCount;
            const jFree = j >= fixedCount;
            if (!iFree && !jFree) continue;
            maxOverlap = Math.max(maxOverlap, overlap);
            if (iFree && jFree) {
              proposed[i].x += ux * overlap / 2;
              proposed[i].y += uy * overlap / 2;
              proposed[j].x -= ux * overlap / 2;
              proposed[j].y -= uy * overlap / 2;
            } else if (iFree) {
              proposed[i].x += ux * overlap;
              proposed[i].y += uy * overlap;
            } else if (jFree) {
              proposed[j].x -= ux * overlap;
              proposed[j].y -= uy * overlap;
            }
          }
        }
      }
    }
    for (let pointIndex = fixedCount; pointIndex < proposed.length; pointIndex++) {
      if (probeSpotFitsPolygon(proposed[pointIndex], polygon)) continue;
      proposed[pointIndex] = probePointInsideAlongMove(previous[pointIndex], proposed[pointIndex], polygon);
    }
    if (maxOverlap <= 0.0001) break;
  }
}

export function probePointInsideAlongMove(previous, candidate, polygon) {
  if (probeSpotFitsPolygon(candidate, polygon)) return candidate;
  let low = 0;
  let high = 1;
  let best = { ...previous };
  for (let iteration = 0; iteration < 28; iteration++) {
    const ratio = (low + high) / 2;
    const point = {
      ...candidate,
      x: previous.x + (candidate.x - previous.x) * ratio,
      y: previous.y + (candidate.y - previous.y) * ratio,
    };
    if (probeSpotFitsPolygon(point, polygon)) {
      best = point;
      low = ratio;
    } else {
      high = ratio;
    }
  }
  return best;
}

export function probeDistributionValid(points, fixedCount, polygon, spacing) {
  const spacingIndex = createProbeSpacingIndex([], spacing);
  for (let pointIndex = 0; pointIndex < points.length; pointIndex++) {
    const point = points[pointIndex];
    if (pointIndex >= fixedCount && !probeSpotFitsPolygon(point, polygon)) return false;
    if (pointIndex >= fixedCount && !probeSpacingIndexAllows(spacingIndex, point)) return false;
    addProbeSpacingPoint(spacingIndex, point);
  }
  return true;
}

export function pointBounds(points) {
  const out = { x_min: Infinity, x_max: -Infinity, y_min: Infinity, y_max: -Infinity };
  for (const p of points) {
    out.x_min = Math.min(out.x_min, p.x);
    out.x_max = Math.max(out.x_max, p.x);
    out.y_min = Math.min(out.y_min, p.y);
    out.y_max = Math.max(out.y_max, p.y);
  }
  return out;
}

export function probeSpotFitsPolygon(center, polygon) {
  if (!pointInPolygon(center, polygon)) return false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    if (distancePointToSegment(center, polygon[j], polygon[i]) < PROBE_SPOT_RADIUS_MM - 1e-9) return false;
  }
  return true;
}

export function distancePointToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (!len2) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function polygonCentroid(points) {
  let twiceArea = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[j];
    const b = points[i];
    const cross = a.x * b.y - b.x * a.y;
    twiceArea += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  if (Math.abs(twiceArea) < 1e-9) return averagePoint(points);
  return { x: cx / (3 * twiceArea), y: cy / (3 * twiceArea) };
}

export function averagePoint(points) {
  if (!points.length) return { x: 0, y: 0 };
  let x = 0;
  let y = 0;
  for (const point of points) {
    x += point.x;
    y += point.y;
  }
  return { x: x / points.length, y: y / points.length };
}

export function distance2(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const crosses = ((a.y > point.y) !== (b.y > point.y)) &&
      (point.x < ((b.x - a.x) * (point.y - a.y)) / ((b.y - a.y) || 1e-12) + a.x);
    if (crosses) inside = !inside;
  }
  return inside;
}
