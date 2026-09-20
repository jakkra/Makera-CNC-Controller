import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizedClosedPolygon,
  effectiveOutlineGeometry,
  closedPathSegments,
  sampleClosedPath,
  pointInPolygon,
  buildFieldProbePreview,
  probeDelaunayTriangles,
} from "./modules/outline-geometry.js";

const square = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }];

test("normalizes a repeated closing point without mutating input", () => {
  const source = [...square, square[0]];
  const result = normalizedClosedPolygon(source);
  assert.equal(result.length, 4);
  assert.equal(source.length, 5);
});

test("curve fitting returns a bounded, closed geometry", () => {
  const result = effectiveOutlineGeometry(square, true, true);
  assert.ok(result.points.length > square.length);
  assert.deepEqual(result.points[0], result.points.at(-1));
  assert.equal(result.limited, false);
});

test("closed path sampling is evenly distributed", () => {
  const path = closedPathSegments(square);
  assert.equal(path.perimeter, 80);
  const samples = sampleClosedPath(path, 8);
  assert.equal(samples.length, 8);
  assert.ok(samples.every((p) => pointInPolygon(p, square) || p.x === 0 || p.x === 20 || p.y === 0 || p.y === 20));
});

test("probe preview includes boundary and interior sites", () => {
  const result = buildFieldProbePreview(square, 8);
  assert.equal(result.tooDense, false);
  assert.ok(result.points.length > 4);
  assert.ok(result.points.every((p) => /^field-probe-\d{4}$/.test(p.id)));
});

test("Delaunay triangulation covers a simple point set", () => {
  const faces = probeDelaunayTriangles([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 5, y: 5 }]);
  assert.ok(faces.length >= 4);
  assert.equal(new Set(faces.flat()).size, 5);
});
