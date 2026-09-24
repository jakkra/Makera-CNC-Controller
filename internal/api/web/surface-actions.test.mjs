import test from "node:test";
import assert from "node:assert/strict";
import { createSurfaceActions } from "./modules/surface-actions.js";

function makeActions(overrides = {}) {
  const jog = {
    armed: true,
    surfaceStepPending: 0,
    surfaceStepSource: "",
    surfaceWheel: { gestureSteps: 0 },
    axes: { x: 0, y: 0, z: 0, a: 0 },
  };
  const events = [];
  const calls = {
    request: [],
    status: [],
    input: [],
    renders: 0,
  };
  const options = {
    getMachine: () => ({ spindle: { vacuum_mode: 0 } }),
    getJog: () => jog,
    request: async (...args) => {
      calls.request.push(args);
      return { json: async () => ({ enabled: true }) };
    },
    dashboardOptionalNumber: (value) => Number.isFinite(Number(value)) ? Number(value) : null,
    setAutoVacuumPending: (value) => events.push(["vacuum-pending", value]),
    setVacuumMode: (value) => events.push(["vacuum-mode", value]),
    renderSurfaceQuickActions: () => events.push(["vacuum-render"]),
    clearNotice: (key) => events.push(["clear-notice", key]),
    setTimeoutRef: (callback, delay) => events.push(["timeout", callback, delay]),
    pollMachine: () => events.push(["poll"]),
    surfaceJogBaseReady: () => true,
    surfaceJogReady: () => true,
    surfaceStepDistance: () => 0.1,
    surfaceStepUnit: (axis) => axis === "a" ? "°" : "mm",
    sendJog: (message) => { events.push(["send-jog", message]); return 12; },
    sendJogInput: (message, force) => calls.input.push([message, force]),
    setStatusMessage: (...args) => calls.status.push(args),
    renderJog: () => { calls.renders++; },
    renderSurfaceMPGWheel: () => events.push(["mpg-render"]),
    ...overrides,
  };
  return { actions: createSurfaceActions(options), jog, calls, events };
}

test("Auto Vacuum preserves request, pending lifecycle, machine update, and poll timing", async () => {
  const { actions, calls, events } = makeActions();
  await actions.setAutoVacuum(true);
  assert.deepEqual(calls.request, [["/api/outputs/auto-vacuum", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  }]]);
  assert.deepEqual(events.map(([name, value, delay]) => name === "timeout" ? [name, value, delay] : [name, value]), [
    ["vacuum-pending", true],
    ["vacuum-render", undefined],
    ["vacuum-mode", 1],
    ["clear-notice", "auto-vacuum"],
    ["timeout", events[4][1], 1200],
    ["vacuum-pending", false],
    ["vacuum-render", undefined],
  ]);
  assert.equal(typeof events[4][1], "function");
});

test("Auto Vacuum reports failures and always clears pending state", async () => {
  const { actions, events } = makeActions({
    request: async () => { throw new Error("offline"); },
    appendGcodeLine: (line) => events.push(["line", line]),
    setNotice: (...args) => events.push(["notice", ...args]),
  });
  await actions.setAutoVacuum(true);
  assert.equal(events.find(([name]) => name === "line")[1].text, "error: offline");
  assert.deepEqual(events.find(([name]) => name === "notice"), ["notice", "Auto Vacuum could not be updated: offline", "error", "auto-vacuum"]);
  assert.deepEqual(events.slice(-2).map(([name, value]) => [name, value]), [["vacuum-pending", false], ["vacuum-render", undefined]]);
});

test("movement takeover confirms before toggling another controller", () => {
  let confirmed = false;
  let toggled = 0;
  const { actions } = makeActions({
    movementOwnedElsewhere: () => true,
    confirmRef: () => confirmed,
    toggleTapMoveArm: () => { toggled++; },
  });
  assert.equal(actions.toggleSurfaceMovementArm(), false);
  assert.equal(toggled, 0);
  confirmed = true;
  assert.equal(actions.toggleSurfaceMovementArm(), true);
  assert.equal(toggled, 1);
});

test("Surface step preserves pending guard, payload, label, status, and render order", () => {
  const { actions, jog, calls, events } = makeActions();
  assert.equal(actions.sendSurfaceStep("a", -1, "button", 360), true);
  assert.deepEqual(events.find(([name]) => name === "send-jog"), ["send-jog", { type: "step", axis: "a", distance: -360 }]);
  assert.equal(jog.surfaceStepPending, 12);
  assert.equal(jog.surfaceStepSource, "button");
  assert.equal(jog.zStepLabel, "A− 360°");
  assert.deepEqual(calls.status[0], ["surface-jog", "Sending A− 360°...", "", { timeoutMs: 0, force: true }]);
  assert.equal(calls.renders, 1);
  jog.surfaceStepPending = 12;
  assert.equal(actions.sendSurfaceStep("x", 1), false);
});

test("Surface step reconnects when jog service does not return a sequence", () => {
  let reconnects = 0;
  const { actions, calls } = makeActions({ sendJog: () => 0, connectJog: () => { reconnects++; } });
  assert.equal(actions.sendSurfaceStep("x", 1), false);
  assert.equal(reconnects, 1);
  assert.deepEqual(calls.status[0], ["surface-jog", "Jog service is not connected.", "error", { force: true }]);
});

test("Surface MPG step uses MPG feedback and does not render the jog view", () => {
  const { actions, calls, events } = makeActions();
  assert.equal(actions.sendSurfaceStep("x", 1, "mpg"), true);
  assert.equal(calls.renders, 0);
  assert.deepEqual(events.at(-1), ["mpg-render"]);
  assert.deepEqual(calls.status[0], ["surface-jog", "MPG X active...", "", { timeoutMs: 0, force: true }]);
});

test("Surface hold jog sends axis input, and stop sends a zero deadman release", () => {
  const { actions, jog, calls } = makeActions();
  assert.equal(actions.beginSurfaceHoldJog("z", -1), true);
  assert.deepEqual(jog.surfaceInput, { axis: "z", sign: -1 });
  assert.deepEqual(jog.axes, { x: 0, y: 0, z: -1, a: 0 });
  assert.deepEqual(calls.input[0], [{ deadman: true, axes: { x: 0, y: 0, z: -1, a: 0 } }, true]);
  assert.equal(actions.stopSurfaceHoldJog(), true);
  assert.deepEqual(calls.input[1], [{ deadman: false, axes: { x: 0, y: 0, z: 0, a: 0 } }, true]);
  assert.equal(jog.surfaceInput, null);
  assert.equal(actions.stopSurfaceHoldJog(), false);
});

test("Surface hold jog refuses motion when the jog session is not ready", () => {
  const { actions, jog, calls } = makeActions({ surfaceJogReady: () => false });
  assert.equal(actions.beginSurfaceHoldJog("x", 1), false);
  assert.equal(jog.surfaceInput, undefined);
  assert.deepEqual(calls.status[0], ["surface-jog", "Arm Movement after a fresh Idle status before jogging.", "error", { force: true }]);
  assert.equal(calls.input.length, 0);
});
