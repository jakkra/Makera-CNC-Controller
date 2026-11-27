import test from "node:test";
import assert from "node:assert/strict";
import { facingReadiness } from "./modules/machining-view.js";

const corners = [
  { machine_x: -90, machine_y: -70, machine_z: -25 },
  { machine_x: -50, machine_y: -70, machine_z: -24.8 },
  { machine_x: -50, machine_y: -40, machine_z: -24.7 },
  { machine_x: -90, machine_y: -40, machine_z: -24.9 },
];

test("the facing checklist follows outline capture and surface probing", () => {
  assert.equal(facingReadiness({}).ready, false);
  assert.match(facingReadiness({}).outline.detail, /Not captured/);
  const capturing = facingReadiness({ active: true, points: corners.slice(0, 2) });
  assert.match(capturing.outline.detail, /Capturing · 2 points/);
  const closed = facingReadiness({ active: true, closed: true, points: corners });
  assert.equal(closed.outline.done, true);
  assert.equal(closed.probe.done, false);
  const triangle = facingReadiness({ closed: true, points: corners.slice(0, 3) });
  assert.match(triangle.outline.detail, /four corners/);
  const probed = facingReadiness({ closed: true, points: corners, fieldProbeResults: corners, fieldReferenceMachineZ: -25, fieldProbeComplete: true });
  assert.equal(probed.ready, true);
  assert.match(probed.probe.detail, /4 points · 0\.300 mm/);
});
