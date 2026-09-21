import test from "node:test";
import assert from "node:assert/strict";
import { capturedOutlinePosition } from "./modules/outline-capture.js";

test("capturedOutlinePosition normalizes machine, work, and origin coordinates", () => {
  assert.deepEqual(capturedOutlinePosition({
    mpos: { x: 12.5, y: -3, z: 8 },
    wpos: { x: 2.5, y: -5, z: 10 },
  }), {
    machine: { x: 12.5, y: -3, z: 8 },
    work: { x: 2.5, y: -5, z: 10 },
    origin: { x: 10, y: 2, z: -2 },
  });
});

test("capturedOutlinePosition rejects incomplete coordinates", () => {
  assert.throws(() => capturedOutlinePosition({ mpos: { x: 1, y: 2 }, wpos: { x: 0, y: 0, z: 0 } }), /include X, Y, and Z/);
});
