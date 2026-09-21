import test from "node:test";
import assert from "node:assert/strict";
import { buildHeightMeshVertices, solidifyHeightMesh } from "./modules/height-mesh.js";

function normal(vertices, face) {
  const [a, b, c] = face.map((index) => vertices[index]);
  const ab = [b.x - a.x, b.y - a.y, b.z - a.z];
  const ac = [c.x - a.x, c.y - a.y, c.z - a.z];
  return [
    ab[1] * ac[2] - ab[2] * ac[1],
    ab[2] * ac[0] - ab[0] * ac[2],
    ab[0] * ac[1] - ab[1] * ac[0],
  ];
}

test("solidifyHeightMesh winds underside downward and perimeter outward", () => {
  const top = [
    { x: 0, y: 0, z: 1 },
    { x: 2, y: 0, z: 1 },
    { x: 2, y: 2, z: 1 },
    { x: 0, y: 2, z: 1 },
  ];
  const solid = solidifyHeightMesh(top, [[0, 1, 2], [0, 2, 3]], [0, 1, 2, 3], 0);
  assert.equal(solid.vertices.length, 8);
  assert.deepEqual(solid.undersideFaces, [[6, 5, 4], [7, 6, 4]]);
  assert.equal(solid.wallFaces.length, 8);
  assert.ok(solid.undersideFaces.every((face) => normal(solid.vertices, face)[2] < 0));
  assert.ok(solid.wallFaces.every((face) => {
    const n = normal(solid.vertices, face);
    const [a, b, c] = face.map((index) => solid.vertices[index]);
    const cx = (a.x + b.x + c.x) / 3 - 1;
    const cy = (a.y + b.y + c.y) / 3 - 1;
    return n[0] * cx + n[1] * cy > 0;
  }));
});

test("buildHeightMeshVertices preserves coincident samples without duplicate outline vertices", () => {
  const samples = [
    { x: 0, y: 0, z: 5, probe_kind: "outline" },
    { x: 1, y: 1, z: 6, probe_kind: "field" },
  ];
  const outline = [
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    { x: 4, y: 3 },
    { x: 0, y: 3 },
  ];
  const calls = [];
  const vertices = buildHeightMeshVertices(samples, outline, (x, y) => {
    calls.push([x, y]);
    return x + y;
  });
  assert.equal(vertices.length, 5);
  assert.equal(vertices.filter((point) => point.x === 0 && point.y === 0).length, 1);
  assert.deepEqual(calls, [[4, 0], [4, 3], [0, 3]]);
  assert.deepEqual(vertices.at(-1), { x: 0, y: 3, z: 3, probe_kind: "mesh_outline" });
  assert.notEqual(vertices[0], samples[0], "mesh owns cloned sample records");
});

test("buildHeightMeshVertices uses injected interpolation for sharp outline corners", () => {
  const samples = [{ x: 1, y: 1, z: 12 }];
  const outline = [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 0, y: 3 }];
  const calls = [];
  const vertices = buildHeightMeshVertices(samples, outline, (x, y, input) => {
    calls.push({ x, y, input });
    return 100 + x * 10 + y;
  });
  assert.equal(vertices.filter((point) => point.probe_kind === "mesh_outline").length, 3);
  assert.deepEqual(calls.map(({ x, y }) => [x, y]), [[0, 0], [3, 0], [0, 3]]);
  assert.ok(calls.every(({ input }) => input === samples));
  assert.deepEqual(vertices.slice(1).map(({ x, y, z }) => [x, y, z]), [[0, 0, 100], [3, 0, 130], [0, 3, 103]]);
});

test("solidifyHeightMesh rejects invalid underside and incomplete boundaries", () => {
  const top = [{ x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 1 }, { x: 0, y: 1, z: 1 }];
  assert.throws(() => solidifyHeightMesh(top, [[0, 1, 2]], [0, 1, 2], NaN), /underside Z is unavailable/);
  assert.throws(() => solidifyHeightMesh(top, [[0, 1, 2]], [0, 1], 0), /at least three boundary vertices/);
  assert.throws(() => solidifyHeightMesh(top, [[0, 1, 2]], [0, 1, 4], 0), /boundary is not part of the top surface/);
});
