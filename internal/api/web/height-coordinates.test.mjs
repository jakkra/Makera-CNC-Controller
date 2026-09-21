import test from "node:test";
import assert from "node:assert/strict";
import {
  exportExtents,
  fieldProbeExportPoints,
  fieldProbeHeightReference,
  outlineEffectiveExportPoints,
  outlineExportPoints,
} from "./modules/height-coordinates.js";

const axisValue = (values, axis) => values?.[axis] ?? null;
const finiteOr = (value, fallback) => value === "" || value === null || typeof value === "undefined" ? fallback : Number.isFinite(Number(value)) ? Number(value) : fallback;

test("outline and field probe points use one live work origin and preserve metadata", () => {
  const origin = { x: 10, y: 20, z: -5 };
  const outline = { closed: true, curveFit: false, points: [
    { x: 99, y: 99, z: 99, machine_x: 12, machine_y: 24, machine_z: -3, captured_at: "a", probed: true },
  ] };
  assert.deepEqual(outlineExportPoints(origin, outline, axisValue), [{
    x: 2, y: 4, z: 2, captured_at: "a", probed: true,
  }]);
  const field = { floorMachineZ: -10, fieldProbeResults: [
    { x: 0, y: 0, z: 7, machine_x: 13, machine_y: 25, machine_z: -8, captured_at: "b", probe_kind: "field" },
  ] };
  assert.deepEqual(fieldProbeExportPoints(origin, field, axisValue, (frame, state) => fieldProbeHeightReference(frame, state, finiteOr, axisValue)), [{
    x: 3, y: 5, z: 2, captured_at: "b", probe_kind: "field",
  }]);
});

test("height coordinate helpers preserve curve-fit limits and extents fallbacks", () => {
  const outline = { closed: true, curveFit: true, points: [{ x: 0, y: 0 }] };
  assert.deepEqual(outlineEffectiveExportPoints({ x: 0, y: 0, z: 0 }, outline, axisValue, () => ({ limited: false, points: [{ x: 1, y: 2 }] })), [{ x: 1, y: 2 }]);
  assert.throws(() => outlineEffectiveExportPoints({ x: 0, y: 0, z: 0 }, outline, axisValue, () => ({ limited: true, points: [] })), /curve fit generated too many outline points/);
  assert.deepEqual(exportExtents({ x_min: Infinity, x_max: -Infinity, y_min: Infinity, y_max: -Infinity }, []), {
    x_min: 0, x_max: 1, y_min: 0, y_max: 1, width: 1, height: 1,
  });
  assert.deepEqual(exportExtents({ x_min: Infinity, x_max: -Infinity, y_min: Infinity, y_max: -Infinity }, [{ x: 2, y: -3 }, { x: 6, y: 4 }]), {
    x_min: 2, x_max: 6, y_min: -3, y_max: 4, width: 4, height: 7,
  });
});

test("field probe reference falls back from floor to captured origin to current origin", () => {
  assert.equal(fieldProbeHeightReference({ z: -3 }, { floorMachineZ: -10, fieldReferenceMachineZ: -20 }, finiteOr, axisValue).machineZ, -10);
  assert.equal(fieldProbeHeightReference({ z: -3 }, { floorMachineZ: null, fieldReferenceMachineZ: -20 }, finiteOr, axisValue).machineZ, -20);
  assert.equal(fieldProbeHeightReference({ z: -3 }, { floorMachineZ: null, fieldReferenceMachineZ: null }, finiteOr, axisValue).machineZ, -3);
  assert.throws(() => fieldProbeHeightReference({}, { floorMachineZ: null, fieldReferenceMachineZ: null }, finiteOr, axisValue), /field probe Z reference is unavailable/);
});
