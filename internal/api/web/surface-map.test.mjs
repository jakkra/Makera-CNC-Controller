import test from "node:test";
import assert from "node:assert/strict";
import { createSurfaceControls } from "./modules/surface-controls.js";

test("both views share one XY map, and a confirmed target sends one move", () => {
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, {
      handlers: {}, style: {}, value: "", disabled: false, open: false,
      addEventListener(type, fn) { this.handlers[type] = fn; },
      setAttribute() {},
      classList: { add() {}, remove() {} },
      showModal() { this.open = true; },
      close() { this.open = false; },
      getBoundingClientRect: () => ({ left: 0, right: 100, top: 0, bottom: 100, width: 100, height: 100 }),
    });
    return nodes.get(id);
  }
  let now = 0, armed = false, busy = false;
  const moves = [], errors = [];
  const controls = createSurfaceControls({
    state: { ui: { machine: { work_area: { x_min: -100, x_max: 0, y_min: -100, y_max: 0 } } } },
    documentRef: { getElementById: node },
    performanceRef: { now: () => now },
    callbacks: {
      normalizeMachineSettings: (settings) => settings,
      clampNumber: (value, min, max) => Math.max(min, Math.min(value, max)),
      movementArmLabel: () => armed ? "Disarm Movement" : "Arm Movement",
      xyMapMovement: () => ({ armed, ready: armed && !busy, armAvailable: true, busy }),
      reportXYMapError: (message) => errors.push(message),
      sendXYMapTarget: (target) => { moves.push(target); busy = true; controls.renderXYMapControls(); },
    },
  });
  controls.bindSurfaceXYMap();
  const open = node("surface-map-open");
  const plot = node("surface-xy-map-plot");
  const move = node("surface-map-move");
  open.handlers.click();
  plot.handlers.pointerdown({ button: 0, pointerId: 1, clientX: 30, clientY: 40 });
  plot.handlers.pointerup({ button: 0, pointerId: 1, clientX: 30, clientY: 40 });
  assert.equal(node("surface-map-x").value, "-70.000");
  assert.equal(node("surface-map-y").value, "-40.000");
  assert.equal(move.disabled, true);
  assert.deepEqual(moves, []);
  armed = true;
  controls.renderXYMapControls();
  assert.equal(move.disabled, false);

  const event = { button: 0, pointerId: 2, clientX: 25, clientY: 25, preventDefault() {} };
  move.handlers.pointerdown(event);
  now = 100;
  move.handlers.pointerup(event);
  assert.equal(errors.length, 1);
  assert.deepEqual(moves, []);

  move.handlers.pointerdown(event);
  now = 750;
  move.handlers.pointerup(event);
  move.handlers.click({ detail: 1 });
  assert.deepEqual(moves, [{ x: -70, y: -40 }]);
  assert.equal(move.disabled, true);
  busy = false;
  node("surface-map-close").handlers.click();
  node("workarea-map-open").handlers.click();
  assert.equal(node("surface-xy-map-modal").open, true);
  assert.equal(node("surface-map-x").value, "");
  assert.equal(move.disabled, true);
});
