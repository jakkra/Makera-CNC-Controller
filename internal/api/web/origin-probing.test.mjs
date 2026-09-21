import test from "node:test";
import assert from "node:assert/strict";
import { createOriginProbing } from "./modules/origin-probing.js";

const origin = createOriginProbing({ documentRef: { getElementById: () => null, querySelectorAll: () => [] }, getMachine: () => ({ state: "Idle", connected: true }), getUI: () => ({ machine: { learned: {} } }), getJog: () => ({}) });

test("3D probe rules and positioning preserve controller geometry", () => {
  assert.deepEqual(origin.probe3DFieldRules("bore_pocket_x"), { x: true, y: false, z: false, note: "Move the 3D Probe inside the bore or pocket with its contact point below the top surface, and make sure the probe is stable." });
  assert.deepEqual(origin.probe3DInitialPositioning("outside_top_left", 20, 10), { x: -20, y: 10 });
  assert.equal(origin.formatOriginValue(1.25), "1.25");
});

test("3D probe preflight reports learned soft-limit violations", () => {
  const result = origin.probe3DTravelPreflight("outside_top_right", 20, 5, { x: 95, y: 0 }, { x: { min: 0, max: 100 }, y: { min: -20, max: 20 } });
  assert.equal(result.blocked, true);
  assert.match(result.warning, /Soft-limit risk/);
});
