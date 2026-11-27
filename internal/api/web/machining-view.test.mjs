import test from "node:test";
import assert from "node:assert/strict";
import { automaticProbeGap, facingReadiness, rectangleFromCorners } from "./modules/machining-view.js";

const corners = [
  { machine_x: -90, machine_y: -70, machine_z: -25 },
  { machine_x: -50, machine_y: -70, machine_z: -24.8 },
  { machine_x: -50, machine_y: -40, machine_z: -24.7 },
  { machine_x: -90, machine_y: -40, machine_z: -24.9 },
];

test("the facing guide follows corner marking and surface measuring", () => {
  assert.equal(facingReadiness({}).ready, false);
  assert.match(facingReadiness({}).outline.detail, /Not marked/);
  assert.match(facingReadiness({ active: true, points: corners.slice(0, 1) }).outline.detail, /1 of 2 corners set/);
  const closed = facingReadiness({ active: true, closed: true, points: corners });
  assert.equal(closed.outline.done, true);
  assert.equal(closed.outline.detail, "40.0 × 30.0 mm");
  assert.equal(closed.probe.done, false);
  assert.match(facingReadiness({ closed: true, points: corners.slice(0, 3) }).outline.detail, /Start over/);
  const measuring = facingReadiness({ closed: true, points: corners, fieldProbePending: true, fieldProbeIndex: 2, fieldProbePreview: [1, 2, 3, 4, 5] });
  assert.match(measuring.probe.detail, /point 3 of 5/);
  const probed = facingReadiness({ closed: true, points: corners, fieldProbeResults: corners, fieldReferenceMachineZ: -25, fieldProbeComplete: true });
  assert.equal(probed.ready, true);
  assert.match(probed.probe.detail, /4 points · 0\.300 mm/);
});

test("two opposite corners become a closed axis-aligned rectangle in either order", () => {
  const a = { id: "a", x: 10, y: 20, z: 5, machine_x: -90, machine_y: -70, machine_z: -25 };
  const b = { id: "b", x: 50, y: 50, z: 5, machine_x: -50, machine_y: -40, machine_z: -25 };
  const rect = rectangleFromCorners(a, b);
  assert.deepEqual(rect.map((p) => [p.machine_x, p.machine_y, p.x, p.y]),
    [[-90, -70, 10, 20], [-50, -70, 50, 20], [-50, -40, 50, 50], [-90, -40, 10, 50]]);
  assert.equal(new Set(rect.map((p) => p.id)).size, 4);
  assert.equal(facingReadiness({ closed: true, points: rect }).outline.done, true);
  assert.equal(facingReadiness({ closed: true, points: rectangleFromCorners(b, a) }).outline.done, true);
  assert.equal(rectangleFromCorners(a, { ...b, machine_x: -88 }), null, "corners on the same edge are rejected");
});

test("the automatic probe gap gives about four points per side", () => {
  assert.equal(automaticProbeGap(40, 30), 8);
  assert.equal(automaticProbeGap(10, 12), 5);
  assert.equal(automaticProbeGap(600, 400), 50);
});
