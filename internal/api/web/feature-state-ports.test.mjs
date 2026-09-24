import test from "node:test";
import assert from "node:assert/strict";
import { createFeatureStatePorts } from "./modules/feature-state-ports.js";

test("feature state ports expose only their named state boundaries", () => {
  const root = {
    activeTab: "jog",
    jog: { armed: false },
    machine: { state: "Idle" },
    outline: { active: false },
    ui: { machine: {} },
    workarea: { zoom: 1 },
    surface: { motion: "step" },
    controlPendingAction: "",
    activeGcodePending: "",
    autoVacuumPending: false,
  };
  const ports = createFeatureStatePorts(root);

  assert.deepEqual(Object.keys(ports.gamepad), ["jog", "outline", "ui"]);
  assert.deepEqual(Object.keys(ports.outlineCapture), ["jog", "machine", "outline"]);
  assert.equal("activeGcodePending" in ports.outlineCapture, false);
  assert.equal("surface" in ports.fieldProbing, false);
  assert.equal(Object.isFrozen(ports), true);
  assert.equal(Object.isSealed(ports.gamepad), true);
});

test("feature state ports follow and apply replacement state", () => {
  const root = { jog: { armed: false }, machine: {}, outline: {}, ui: {}, workarea: {} };
  const ports = createFeatureStatePorts(root);
  const nextJog = { armed: true };
  const nextOutline = { active: true };

  root.jog = nextJog;
  ports.outlineCapture.outline = nextOutline;

  assert.equal(ports.gamepad.jog, nextJog);
  assert.equal(root.outline, nextOutline);
  assert.equal(ports.fieldProbing.outline, nextOutline);
});

test("feature state ports require a root state object", () => {
  assert.throws(() => createFeatureStatePorts(null), /rootState is required/);
});
