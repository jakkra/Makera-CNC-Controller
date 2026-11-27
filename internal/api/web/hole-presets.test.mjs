import test from "node:test";
import assert from "node:assert/strict";
import { FACING_MATERIALS, helixPreset } from "./modules/facing-presets.js";
import { alignmentPlan } from "./modules/alignment-holes.js";

test("every material has a helix preset the hole planner accepts", () => {
  const machine = {
    connected: true, state: "Idle", age_ms: 0, fields: { R: "0" }, tool: { active: 3, offset: 41 },
    mpos: { x: -170, y: -120, z: -10 }, wpos: { x: 10, y: 30, z: 40 },
  };
  for (const { id } of FACING_MATERIALS) {
    const preset = helixPreset(id);
    assert.ok(preset.stepdown > 0 && preset.stepdown <= 0.5, id);
    alignmentPlan({
      centers: [{ x: -170, y: -120 }, { x: -80, y: -120 }], adjustment: 0, depth: 6, safeZ: -10, machine,
      limits: { x_min: -206, x_max: 0, y_min: -206, y_max: 0, z_min: -100, z_max: 0 }, ...preset,
    });
  }
  assert.ok(helixPreset("aluminium").feed < helixPreset("softwood").feed);
});
