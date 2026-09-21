import test from "node:test";
import assert from "node:assert/strict";
import { constrainedOutlineTriangles, orderedOutlineBoundaryIndices } from "./modules/height-triangulation.js";

const square = [
  { x: 0, y: 0 },
  { x: 4, y: 0 },
  { x: 4, y: 4 },
  { x: 0, y: 4 },
];

test("triangulation preserves the constrained square boundary and inserts interior samples", () => {
  const points = square.map((point) => ({ ...point, probe_kind: "outline" })).concat({ x: 2, y: 2, probe_kind: "field" });
  const faces = constrainedOutlineTriangles(points, square);
  assert.equal(faces.length, 4);
  assert.ok(faces.every((face) => face.includes(4)));
  const edges = new Set(faces.flatMap((face) => [
    [face[0], face[1]], [face[1], face[2]], [face[2], face[0]],
  ].map(([a, b]) => Math.min(a, b) + ":" + Math.max(a, b))));
  for (const edge of [[0, 1], [1, 2], [2, 3], [0, 3]]) assert.ok(edges.has(edge.join(":")));
});

test("boundary ordering is normalized counter-clockwise", () => {
  const reversed = square.slice().reverse().map((point) => ({ ...point, probe_kind: "outline" }));
  const indices = orderedOutlineBoundaryIndices(reversed, square);
  assert.equal(indices.length, 4);
  const area = indices.reduce((sum, index, i) => {
    const a = reversed[index];
    const b = reversed[indices[(i + 1) % indices.length]];
    return sum + a.x * b.y - b.x * a.y;
  }, 0) / 2;
  assert.ok(area > 0);
});

test("triangulation rejects insufficient boundaries and samples outside the outline", () => {
  assert.throws(
    () => constrainedOutlineTriangles(square.slice(0, 2), square),
    /field probe needs at least three outline or border samples/,
  );
  const outside = square.map((point) => ({ ...point, probe_kind: "outline" })).concat({ x: 9, y: 9, probe_kind: "field" });
  assert.throws(
    () => constrainedOutlineTriangles(outside, square),
    /field probe sample lies outside the probed outline boundary/,
  );
});
