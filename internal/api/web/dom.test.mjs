import test from "node:test";
import assert from "node:assert/strict";
import { bindButtonAction } from "./modules/dom.js";

function makeButton() {
  const listeners = new Map();
  const button = {
    dataset: {},
    disabled: false,
    capturedPointer: null,
    addEventListener(type, handler) {
      const list = listeners.get(type) || [];
      list.push(handler);
      listeners.set(type, list);
    },
    setPointerCapture(pointerId) {
      this.capturedPointer = pointerId;
    },
    contains(node) {
      return node === this;
    },
    dispatch(type, overrides = {}) {
      const event = {
        button: 0,
        pointerId: 1,
        clientX: 10,
        clientY: 10,
        defaultPrevented: false,
        propagationStopped: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.propagationStopped = true; },
        ...overrides,
      };
      for (const handler of listeners.get(type) || []) handler(event);
      return event;
    },
    listenerCount(type) {
      return (listeners.get(type) || []).length;
    },
  };
  const documentRef = { elementFromPoint: () => button };
  let now = 1000;
  return { button, documentRef, performanceRef: { now: () => now }, setNow: (value) => { now = value; } };
}

test("bindButtonAction captures a primary pointer and invokes on an in-bounds release", () => {
  const { button, documentRef, performanceRef } = makeButton();
  let calls = 0;
  bindButtonAction(button, () => { calls++; }, { documentRef, performanceRef });

  button.dispatch("pointerdown", { pointerId: 7, clientX: 20, clientY: 30 });
  const release = button.dispatch("pointerup", { pointerId: 7, clientX: 25, clientY: 35 });

  assert.equal(button.capturedPointer, 7);
  assert.equal(calls, 1);
  assert.equal(release.defaultPrevented, true);
});

test("bindButtonAction suppresses a drag-out release", () => {
  const { button, documentRef, performanceRef } = makeButton();
  const outside = {};
  documentRef.elementFromPoint = () => outside;
  let calls = 0;
  bindButtonAction(button, () => { calls++; }, { documentRef, performanceRef });

  button.dispatch("pointerdown", { pointerId: 2, clientX: 20, clientY: 30 });
  const release = button.dispatch("pointerup", { pointerId: 2, clientX: 40, clientY: 31 });

  assert.equal(calls, 0);
  assert.equal(release.defaultPrevented, false);
});

test("bindButtonAction suppresses the synthetic click after a pointer release", () => {
  const { button, documentRef, performanceRef } = makeButton();
  let calls = 0;
  bindButtonAction(button, () => { calls++; }, { documentRef, performanceRef });

  button.dispatch("pointerdown");
  button.dispatch("pointerup");
  const click = button.dispatch("click");

  assert.equal(calls, 1);
  assert.equal(click.defaultPrevented, true);
  assert.equal(click.propagationStopped, true);
});

test("bindButtonAction keeps ordinary click as the fallback path", () => {
  const { button, documentRef, performanceRef, setNow } = makeButton();
  let calls = 0;
  bindButtonAction(button, () => { calls++; }, { documentRef, performanceRef });

  setNow(2000);
  const click = button.dispatch("click");

  assert.equal(calls, 1);
  assert.equal(click.defaultPrevented, false);
  assert.equal(click.propagationStopped, false);
});

test("bindButtonAction ignores disabled controls", () => {
  const { button, documentRef, performanceRef } = makeButton();
  let calls = 0;
  bindButtonAction(button, () => { calls++; }, { documentRef, performanceRef });

  button.disabled = true;
  button.dispatch("pointerdown", { pointerId: 3 });
  button.dispatch("pointerup", { pointerId: 3 });
  button.dispatch("click");

  assert.equal(button.capturedPointer, null);
  assert.equal(calls, 0);
});

test("bindButtonAction binds each element only once", () => {
  const { button, documentRef, performanceRef, setNow } = makeButton();
  const calls = [];
  bindButtonAction(button, () => { calls.push("first"); }, { documentRef, performanceRef });
  bindButtonAction(button, () => { calls.push("second"); }, { documentRef, performanceRef });

  assert.equal(button.listenerCount("click"), 1);
  setNow(2000);
  button.dispatch("click");
  assert.deepEqual(calls, ["first"]);
});
