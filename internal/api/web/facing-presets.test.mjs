import test from "node:test";
import assert from "node:assert/strict";
import { FACING_CUTTERS, FACING_MATERIALS, facingPreset } from "./modules/facing-presets.js";
import { chooseEntry, facingPlan, surfaceMeasurements } from "./modules/surface-facing.js";

test("every material and cutter has a preset the facing planner accepts", () => {
  const corners = [
    { machine_x: -90, machine_y: -70, machine_z: -25 }, { machine_x: -50, machine_y: -70, machine_z: -24.8 },
    { machine_x: -50, machine_y: -40, machine_z: -24.7 }, { machine_x: -90, machine_y: -40, machine_z: -24.9 },
  ];
  const outline = { points: corners, fieldProbeResults: corners, fieldReferenceMachineZ: -25, fieldProbeComplete: true, closed: true };
  for (const { id } of FACING_MATERIALS) {
    for (const diameter of FACING_CUTTERS) {
      const preset = facingPreset(id, diameter);
      assert.ok(preset.stepover > 0 && preset.stepover < diameter, `${id} ${diameter} stepover`);
      assert.ok(preset.plunge > 0 && preset.plunge <= preset.feed, `${id} ${diameter} descent feed`);
      assert.ok(Number.isInteger(preset.rpm));
      facingPlan({
        outline, surface: surfaceMeasurements(outline), origin: { x: -90, y: -70, z: -25 },
        machine: { connected: true, state: "Idle" }, safeZ: -3,
        limits: { x_min: -200, x_max: 0, y_min: -200, y_max: 0, z_min: -100, z_max: 0 },
        parameters: { tool: 1, diameter, targetZ: -0.05, ...preset },
      });
    }
  }
  assert.ok(facingPreset("aluminium", 6).feed < facingPreset("hardwood", 6).feed);
  assert.deepEqual(facingPreset("softwood", 5), { ...facingPreset("softwood", 4), stepover: 2 }, "custom sizes use the nearest cutter");
});

test("the entry corner preview follows the choice and machine travel", () => {
  const bounds = { left: -90, right: -50, front: -70, back: -40 };
  const limits = { x_min: -200, x_max: 0 };
  assert.equal(chooseEntry({ bounds, diameter: 6, limits, choice: "back-right" }).corner, "back-right");
  assert.equal(chooseEntry({ bounds, diameter: 6, limits }).corner, "front-left");
  assert.equal(chooseEntry({ bounds, diameter: 6, limits: { x_min: -92, x_max: 0 } }).corner, "front-right");
  assert.equal(chooseEntry({ bounds, diameter: NaN, limits }), null);
});
