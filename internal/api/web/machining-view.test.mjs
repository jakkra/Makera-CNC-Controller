import test from "node:test";
import assert from "node:assert/strict";
import { facingReadiness, rectangleFromCorners } from "./modules/machining-view.js";
import { buildGridFieldProbePreview } from "./modules/outline-geometry.js";
import { createSurfaceRouting } from "./modules/surface-routing.js";

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

test("the facing probe grid is held in from every stock edge", () => {
  const outline = [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 40 }, { x: 0, y: 40 }];
  const grid = buildGridFieldProbePreview(outline, { columns: 3, rows: 3, insetMM: 10 });
  assert.equal(grid.points.length, 9);
  assert.equal(grid.issue, "");
  const xs = grid.points.map((p) => p.x);
  const ys = grid.points.map((p) => p.y);
  assert.deepEqual([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)], [10, 50, 10, 30]);
  assert.deepEqual(grid.points.slice(0, 4).map((p) => [p.x, p.y]), [[10, 10], [30, 10], [50, 10], [50, 20]], "serpentine order");
  assert.equal(new Set(grid.points.map((p) => p.id)).size, 9);
  assert.equal(buildGridFieldProbePreview(outline, { columns: 2, rows: 2, insetMM: 25 }).points.length, 0);
  assert.match(buildGridFieldProbePreview(outline, { columns: 2, rows: 2, insetMM: 25 }).issue, /too small/);
  assert.deepEqual(buildGridFieldProbePreview(outline, { columns: 1, rows: 1, insetMM: 10 }).points.map((p) => [p.x, p.y]), [[30, 20]]);
});

test("the Surface kiosk stays on Machining while the guide jogs or probes", () => {
  const state = {
    activeTab: "machining", machine: { state: "Run" }, jog: { armed: true }, outline: {},
    surface: { auto_switch: true, manual_view_state: "Idle", start_view: "jog" },
  };
  const shown = [];
  const routing = createSurfaceRouting({ getState: () => state, isSurfaceKiosk: () => true, showTab: (tab) => shown.push(tab), fmtDuration: String });
  routing.applySurfaceAutomaticView();
  state.machine.state = "Idle";
  routing.applySurfaceAutomaticView();
  state.jog.armed = false;
  state.outline.fieldProbePending = true;
  state.machine.state = "Run";
  routing.applySurfaceAutomaticView();
  assert.deepEqual(shown, []);
  state.outline.fieldProbePending = false;
  state.machine.state = "Alarm";
  routing.applySurfaceAutomaticView();
  assert.deepEqual(shown, ["attention"], "attention states still take over");
});

test("an Idle status after a failed measurement keeps the operator on Machining", () => {
  const state = {
    activeTab: "machining", machine: { state: "Idle" }, jog: {}, outline: {},
    surface: { auto_switch: true, manual_view_state: "", start_view: "jog" },
  };
  const shown = [];
  const routing = createSurfaceRouting({ getState: () => state, isSurfaceKiosk: () => true, showTab: (tab) => shown.push(tab), fmtDuration: String });
  routing.applySurfaceAutomaticView();
  assert.deepEqual(shown, []);
  state.activeTab = "dashboard";
  routing.applySurfaceAutomaticView();
  assert.deepEqual(shown, ["jog"], "other views still return to the start view");
});
