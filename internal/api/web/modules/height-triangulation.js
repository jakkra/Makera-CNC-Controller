import { triangulationEdgeKey, triangleCross, pointInTriangle2D, triangleCCW } from "./outline-geometry.js";

// Pure constrained-Delaunay helpers for the sampled height mesh. The caller
// owns the point set and outline; this module has no DOM, machine, or UI state.

export function constrainedOutlineTriangles(points, outline) {
  const boundary = orderedOutlineBoundaryIndices(points, outline);
  if (boundary.length < 3) throw new Error("field probe needs at least three outline or border samples");
  let faces = triangulateBoundaryRing(points, boundary);
  const boundarySet = new Set(boundary);
  for (let index = 0; index < points.length; index++) {
    if (boundarySet.has(index)) continue;
    faces = insertTriangulationPoint(points, faces, index);
  }
  const constrainedEdges = new Set(boundary.map((vertex, index) =>
    triangulationEdgeKey(vertex, boundary[(index + 1) % boundary.length])
  ));
  return improveConstrainedDelaunay(points, faces, constrainedEdges);
}

export function orderedOutlineBoundaryIndices(points, outline) {
  const projections = points.map((point, index) => ({
    index,
    kind: point.probe_kind,
    projection: projectPointToClosedPath(point, outline),
  }));
  const hasKinds = projections.some(({ kind }) => kind === "outline" || kind === "border" || kind === "mesh_outline");
  const boundary = projections.filter(({ kind, projection }) =>
    hasKinds ? kind === "outline" || kind === "border" || kind === "mesh_outline" : projection.distance <= 0.05
  );
  boundary.sort((a, b) => a.projection.along - b.projection.along || a.index - b.index);
  const indices = boundary.map(({ index }) => index);
  if (polygonIndexArea(points, indices) < 0) indices.reverse();
  return indices;
}

function projectPointToClosedPath(point, outline) {
  let along = 0;
  let best = { distance: Infinity, along: 0 };
  for (let index = 0; index < outline.length; index++) {
    const a = outline[index];
    const b = outline[(index + 1) % outline.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (length <= 1e-12) continue;
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (length * length)));
    const x = a.x + dx * t;
    const y = a.y + dy * t;
    const distance = Math.hypot(point.x - x, point.y - y);
    if (distance < best.distance - 1e-9 || (Math.abs(distance - best.distance) <= 1e-9 && along + t * length < best.along)) {
      best = { distance, along: along + t * length };
    }
    along += length;
  }
  return best;
}

function polygonIndexArea(points, indices) {
  let twiceArea = 0;
  for (let index = 0; index < indices.length; index++) {
    const a = points[indices[index]];
    const b = points[indices[(index + 1) % indices.length]];
    twiceArea += a.x * b.y - b.x * a.y;
  }
  return twiceArea / 2;
}

function triangulateBoundaryRing(points, boundary) {
  const remaining = boundary.slice();
  const faces = [];
  let guard = remaining.length * remaining.length;
  while (remaining.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let index = 0; index < remaining.length; index++) {
      const prev = remaining[(index - 1 + remaining.length) % remaining.length];
      const current = remaining[index];
      const next = remaining[(index + 1) % remaining.length];
      if (triangleCross(points[prev], points[current], points[next]) <= 1e-10) continue;
      const containsBoundary = remaining.some((candidate) =>
        candidate !== prev && candidate !== current && candidate !== next &&
        pointInTriangle2D(points[candidate], points[prev], points[current], points[next])
      );
      if (containsBoundary) continue;
      faces.push([prev, current, next]);
      remaining.splice(index, 1);
      clipped = true;
      break;
    }
    if (!clipped) throw new Error("probed outline boundary could not be triangulated");
  }
  if (remaining.length === 3 && Math.abs(triangleCross(points[remaining[0]], points[remaining[1]], points[remaining[2]])) > 1e-10) {
    faces.push(triangleCCW(points, remaining));
  }
  if (!faces.length) throw new Error("probed outline boundary could not form a mesh");
  return faces;
}

function insertTriangulationPoint(points, faces, pointIndex) {
  const point = points[pointIndex];
  const containingIndex = faces.findIndex((face) =>
    pointInTriangle2D(point, points[face[0]], points[face[1]], points[face[2]])
  );
  if (containingIndex < 0) throw new Error("field probe sample lies outside the probed outline boundary");
  const containing = faces[containingIndex];
  const hitEdge = [[containing[0], containing[1]], [containing[1], containing[2]], [containing[2], containing[0]]]
    .find(([a, b]) => pointOnSegment2D(point, points[a], points[b]));
  if (hitEdge) {
    const [edgeA, edgeB] = hitEdge;
    const adjacent = [];
    for (let index = 0; index < faces.length; index++) {
      if (faces[index].includes(edgeA) && faces[index].includes(edgeB)) adjacent.push(index);
    }
    const adjacentSet = new Set(adjacent);
    const nextFaces = faces.filter((_, index) => !adjacentSet.has(index));
    for (const index of adjacent) {
      const opposite = faces[index].find((vertex) => vertex !== edgeA && vertex !== edgeB);
      nextFaces.push(triangleCCW(points, [edgeA, pointIndex, opposite]));
      nextFaces.push(triangleCCW(points, [pointIndex, edgeB, opposite]));
    }
    return nextFaces;
  }
  const nextFaces = faces.slice();
  nextFaces.splice(containingIndex, 1,
    triangleCCW(points, [containing[0], containing[1], pointIndex]),
    triangleCCW(points, [containing[1], containing[2], pointIndex]),
    triangleCCW(points, [containing[2], containing[0], pointIndex]));
  return nextFaces;
}

function pointOnSegment2D(point, a, b) {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length <= 1e-12 || Math.abs(triangleCross(a, b, point)) > Math.max(1, length) * 1e-8) return false;
  const dot = (point.x - a.x) * (point.x - b.x) + (point.y - a.y) * (point.y - b.y);
  return dot < -1e-8;
}

function improveConstrainedDelaunay(points, faces, constrainedEdges) {
  const optimized = faces.map((face) => triangleCCW(points, face));
  const maxPasses = Math.max(16, points.length * 4);
  for (let pass = 0; pass < maxPasses; pass++) {
    let flipCount = 0;
    const touchedFaces = new Set();
    for (const edge of triangulationEdges(optimized).values()) {
      if (edge.faces.length !== 2 || constrainedEdges.has(edge.key)) continue;
      const [firstIndex, secondIndex] = edge.faces;
      if (touchedFaces.has(firstIndex) || touchedFaces.has(secondIndex)) continue;
      const oppositeA = optimized[firstIndex].find((vertex) => vertex !== edge.a && vertex !== edge.b);
      const oppositeB = optimized[secondIndex].find((vertex) => vertex !== edge.a && vertex !== edge.b);
      if (oppositeA === undefined || oppositeB === undefined || oppositeA === oppositeB) continue;
      if (!quadrilateralAllowsFlip(points, edge.a, edge.b, oppositeA, oppositeB)) continue;
      if (!pointInsideCircumcircle(points[edge.a], points[edge.b], points[oppositeA], points[oppositeB])) continue;
      optimized[firstIndex] = triangleCCW(points, [oppositeA, oppositeB, edge.a]);
      optimized[secondIndex] = triangleCCW(points, [oppositeB, oppositeA, edge.b]);
      touchedFaces.add(firstIndex);
      touchedFaces.add(secondIndex);
      flipCount++;
    }
    if (!flipCount) return optimized;
  }
  throw new Error("constrained field triangulation did not converge");
}

function triangulationEdges(faces) {
  const edges = new Map();
  for (let faceIndex = 0; faceIndex < faces.length; faceIndex++) {
    const face = faces[faceIndex];
    for (const [a, b] of [[face[0], face[1]], [face[1], face[2]], [face[2], face[0]]]) {
      const key = triangulationEdgeKey(a, b);
      const edge = edges.get(key) || { key, a: Math.min(a, b), b: Math.max(a, b), faces: [] };
      edge.faces.push(faceIndex);
      edges.set(key, edge);
    }
  }
  return edges;
}

function quadrilateralAllowsFlip(points, edgeA, edgeB, oppositeA, oppositeB) {
  const sideA = triangleCross(points[oppositeA], points[oppositeB], points[edgeA]);
  const sideB = triangleCross(points[oppositeA], points[oppositeB], points[edgeB]);
  const scale = Math.max(
    Math.hypot(points[oppositeB].x - points[oppositeA].x, points[oppositeB].y - points[oppositeA].y),
    1,
  );
  return sideA * sideB < -Math.pow(scale, 4) * 1e-18;
}

function pointInsideCircumcircle(a, b, c, point) {
  const ax = a.x - point.x;
  const ay = a.y - point.y;
  const bx = b.x - point.x;
  const by = b.y - point.y;
  const cx = c.x - point.x;
  const cy = c.y - point.y;
  const determinant =
    (ax * ax + ay * ay) * (bx * cy - by * cx) -
    (bx * bx + by * by) * (ax * cy - ay * cx) +
    (cx * cx + cy * cy) * (ax * by - ay * bx);
  const orientation = triangleCross(a, b, c);
  const scale = Math.max(Math.abs(ax), Math.abs(ay), Math.abs(bx), Math.abs(by), Math.abs(cx), Math.abs(cy), 1);
  const epsilon = Math.pow(scale, 4) * 1e-12;
  return orientation > 0 ? determinant > epsilon : determinant < -epsilon;
}
