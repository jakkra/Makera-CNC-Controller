import test from "node:test";
import assert from "node:assert/strict";
import { facingGcode, facingPlan, surfaceMeasurements } from "./modules/surface-facing.js";

const corners = [
  { machine_x: -90, machine_y: -70, machine_z: -25 },
  { machine_x: -50, machine_y: -70, machine_z: -24.8 },
  { machine_x: -50, machine_y: -40, machine_z: -24.7 },
  { machine_x: -90, machine_y: -40, machine_z: -24.9 },
];
const outline = { points: corners, fieldProbeResults: corners, fieldReferenceMachineZ: -25, fieldProbeComplete: true, closed: true };
const args = {
  outline,
  surface: surfaceMeasurements(outline),
  origin: { x: -90, y: -70, z: -25 },
  machine: { connected: true, state: "Idle" },
  limits: { x_min: -200, x_max: 0, y_min: -200, y_max: 0, z_min: -100, z_max: 0 },
  safeZ: -3,
  parameters: { tool: 2, diameter: 12, stepover: 8, stepdown: 0.2, targetZ: -0.05, rpm: 10000, feed: 480, plunge: 120 },
};

test("measured height range retains tilt while plane deviation removes it", () => {
  assert.ok(Math.abs(args.surface.range - 0.3) < 1e-8);
  assert.ok(args.surface.planeDeviation < 1e-8);
  const center = { machine_x: -70, machine_y: -55, machine_z: -24.6 };
  const deflected = surfaceMeasurements({ ...outline, fieldProbeResults: [...corners, center] });
  assert.ok(Math.abs(deflected.planeDeviation - 0.25) < 1e-8);
});

test("facing uses bounded layers and enters outside the stock before the first cutting move", () => {
  const plan = facingPlan(args);
  assert.equal(plan.entry, -96.5);
  assert.deepEqual(plan.rows, [-70, -62.5, -55, -47.5, -40]);
  assert.equal(plan.levels.length, 2);
  assert.ok(plan.levels[0] >= args.surface.high - args.parameters.stepdown);
  assert.ok(Math.abs(plan.levels.at(-1) - args.parameters.targetZ) < 1e-8);
  const lines = facingGcode(plan).trim().split("\n");
  const pause = lines.indexOf("M600");
  assert.ok(lines.indexOf("M6 T2") < pause);
  assert.deepEqual(lines.slice(pause - 2, pause + 3), ["G53 G0 Z-3.0000",
    "; Confirm work zero, tool length and cutter clearance before resuming", "M600", "M3 S10000", "G4 S2"]);
  assert.deepEqual(lines.slice(pause + 3, pause + 8),
    ["G53 G0 Z-3.0000", "G0 X-6.5000 Y0.0000", "G1 Z0.1250 F120.0000", "G1 X0.0000 Y0.0000 F480.0000", "G1 X40.0000 Y0.0000 F480.0000"]);
  assert.ok(lines.includes("G1 Z-0.0500 F120.0000"));
  assert.deepEqual(lines.slice(-3), ["G53 G0 Z-3.0000", "M5", "M2"]);
  const rightEntry = facingPlan({ ...args, limits: { ...args.limits, x_min: -92 } });
  assert.equal(rightEntry.entry, -43.5);
  assert.match(facingGcode(rightEntry), /G0 X46.5000 Y0.0000\nG1 Z[^\n]+\nG1 X40.0000/);
});

test("facing rejects stale setups, incomplete scans, extra geometry and unsafe leads", () => {
  assert.throws(() => facingPlan({ ...args, origin: { ...args.origin, z: -26 } }), /work Z/);
  assert.throws(() => facingPlan({ ...args, machine: { ...args.machine, fields: { R: "8.8" } } }), /rotation/);
  assert.throws(() => facingPlan({ ...args, outline: { ...outline, fieldProbeComplete: false } }), /Complete the surface probe/);
  assert.throws(() => facingPlan({ ...args, outline: { ...outline, points: [...corners, corners[0]] } }), /four-corner/);
  assert.throws(() => facingPlan({ ...args, limits: { ...args.limits, x_min: -92, x_max: -48 } }), /room to enter/);
  assert.throws(() => facingPlan({ ...args, parameters: { ...args.parameters, stepover: 13 } }), /Stepover/);
});
