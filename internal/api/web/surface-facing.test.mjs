import test from "node:test";
import assert from "node:assert/strict";
import { ENTRY_CLEARANCE_MM, facingGcode, facingPlan, facingTracePoints, surfaceMeasurements } from "./modules/surface-facing.js";

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

// Replays the program and returns every move that lowers Z, in machine XY.
function descents(plan) {
  const pos = { x: NaN, y: NaN, z: NaN };
  const out = [];
  for (const line of facingGcode(plan).split("\n")) {
    if (line.startsWith(";") || !/^G[01] /.test(line) && !line.startsWith("G53")) continue;
    const word = (letter) => { const m = line.match(new RegExp(letter + "(-?[0-9.]+)")); return m ? Number(m[1]) : null; };
    const machineZ = line.startsWith("G53");
    const x = word(" X"), y = word(" Y"), z = word(" Z");
    if (x != null) pos.x = x + plan.origin.x;
    if (y != null) pos.y = y + plan.origin.y;
    if (z != null) {
      const next = machineZ ? z - plan.origin.z : z;
      // The opening lifts happen before any XY is known and only move up to Safe Z.
      if (next < pos.z && Number.isFinite(pos.x)) out.push({ x: pos.x, y: pos.y, z: next, xyMove: x != null || y != null });
      pos.z = next;
    }
  }
  return out;
}

test("measured height range retains tilt while plane deviation removes it", () => {
  assert.ok(Math.abs(args.surface.range - 0.3) < 1e-8);
  assert.ok(args.surface.planeDeviation < 1e-8);
  const center = { machine_x: -70, machine_y: -55, machine_z: -24.6 };
  const deflected = surfaceMeasurements({ ...outline, fieldProbeResults: [...corners, center] });
  assert.ok(Math.abs(deflected.planeDeviation - 0.25) < 1e-8);
});

test("facing descends outside the stock and enters from the side", () => {
  const plan = facingPlan(args);
  assert.equal(plan.entry.corner, "front-left");
  assert.equal(plan.entry.x, -90 - 6 - ENTRY_CLEARANCE_MM);
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
    ["G53 G0 Z-3.0000", "G0 X-9.0000 Y0.0000", "G1 Z0.1250 F120.0000", "G1 X0.0000 Y0.0000 F480.0000", "G1 X40.0000 Y0.0000 F480.0000"]);
  assert.ok(lines.includes("G1 Z-0.0500 F120.0000"));
  assert.deepEqual(lines.slice(-3), ["G53 G0 Z-3.0000", "M5", "M2"]);
});

test("no move lowers Z with the cutter over the stock", () => {
  for (const entryCorner of ["auto", "front-left", "front-right", "back-left", "back-right"]) {
    const plan = facingPlan({ ...args, parameters: { ...args.parameters, entryCorner } });
    const radius = args.parameters.diameter / 2;
    const moves = descents(plan);
    assert.ok(moves.length >= plan.levels.length);
    for (const move of moves) {
      assert.equal(move.xyMove, false, `${entryCorner}: descent combined with XY motion`);
      const clear = move.x + radius <= plan.bounds.left - ENTRY_CLEARANCE_MM + 1e-9 ||
        move.x - radius >= plan.bounds.right + ENTRY_CLEARANCE_MM - 1e-9;
      assert.ok(clear, `${entryCorner}: descent at X ${move.x} is over the stock`);
    }
  }
});

test("each entry corner starts on its own row and side", () => {
  const at = (entryCorner, limits = args.limits) => facingPlan({ ...args, limits, parameters: { ...args.parameters, entryCorner } });
  const backRight = at("back-right");
  assert.deepEqual([backRight.entry.x, backRight.entry.y], [-50 + 6 + ENTRY_CLEARANCE_MM, -40]);
  assert.deepEqual(backRight.rows, [-40, -47.5, -55, -62.5, -70]);
  assert.match(facingGcode(backRight), /G0 X49\.0000 Y30\.0000\nG1 Z[^\n]+\nG1 X40\.0000 Y30\.0000/);
  const tight = { ...args.limits, x_min: -92 };
  assert.equal(at("auto", tight).entry.corner, "front-right");
  assert.throws(() => at("back-left", tight), /back left corner/);
  assert.throws(() => at("auto", { ...args.limits, x_min: -92, x_max: -48 }), /beyond an X edge/);
});

test("hand-captured corners within 5 mm are faced as their bounding box", () => {
  const rough = [
    { machine_x: -90.6, machine_y: -70.2, machine_z: -25 },
    { machine_x: -50.1, machine_y: -69.5, machine_z: -24.8 },
    { machine_x: -49.4, machine_y: -40.3, machine_z: -24.7 },
    { machine_x: -89.8, machine_y: -39.6, machine_z: -24.9 },
  ];
  const plan = facingPlan({ ...args, outline: { ...outline, points: rough } });
  assert.deepEqual(plan.bounds, { left: -90.6, right: -49.4, front: -70.2, back: -39.6 });
  const skewed = rough.map((p, i) => i === 2 ? { ...p, machine_x: -44 } : p);
  assert.throws(() => facingPlan({ ...args, outline: { ...outline, points: skewed } }), /within 5 mm/);
});

test("the trace covers the cutter sweep including the side entry", () => {
  const plan = facingPlan(args);
  const xs = facingTracePoints(plan, args.limits).map((p) => p.x);
  assert.equal(Math.min(...xs), plan.entry.x - 6);
  assert.equal(Math.max(...xs), -50 + 6);
});

test("facing rejects stale setups, incomplete scans, extra geometry and unsafe parameters", () => {
  assert.throws(() => facingPlan({ ...args, origin: { ...args.origin, z: -26 } }), /work Z/);
  assert.throws(() => facingPlan({ ...args, machine: { ...args.machine, fields: { R: "8.8" } } }), /rotation/);
  assert.throws(() => facingPlan({ ...args, outline: { ...outline, fieldProbeComplete: false } }), /Complete the surface probe/);
  assert.throws(() => facingPlan({ ...args, outline: { ...outline, points: [...corners, corners[0]] } }), /four-corner/);
  assert.throws(() => facingPlan({ ...args, parameters: { ...args.parameters, stepover: 13 } }), /Stepover/);
});
