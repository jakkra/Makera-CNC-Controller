import test from "node:test";
import assert from "node:assert/strict";
import { createOutlineCoordination, OUTLINE_FIELD_SPACING_DEBOUNCE_MS } from "./modules/outline-coordination.js";

function makeDocument(nodes) {
  return { getElementById: (id) => nodes.get(id) || null };
}

test("tool radius updates both stable work-area markers", () => {
  const nodes = new Map([
    ["workarea-spindle-marker", { attrs: {}, setAttribute(name, value) { this.attrs[name] = value; } }],
    ["workarea-target-marker", { attrs: {}, setAttribute(name, value) { this.attrs[name] = value; } }],
  ]);
  const controls = createOutlineCoordination({ documentRef: makeDocument(nodes), workAreaMMToSVGUnits: () => 2 });
  controls.setWorkAreaToolRadius();
  assert.equal(nodes.get("workarea-spindle-marker").attrs.r, "3.175");
  assert.equal(nodes.get("workarea-target-marker").attrs.r, "3.175");
});

test("overlay revision increments and undo uses the current outline object", () => {
  let revision = 4;
  let outline = { undo: [], redo: ["stale"] };
  const snapshots = [{ active: true }];
  const controls = createOutlineCoordination({
    getOutline: () => outline,
    getGcodeContextRevision: () => revision,
    setGcodeContextRevision: (value) => { revision = value; },
    outlineSnapshot: () => snapshots.shift(),
  });
  controls.markGcodeContextOverlayDirty();
  assert.equal(revision, 5);
  controls.pushOutlineUndo();
  assert.deepEqual(outline.undo, [{ active: true }]);
  assert.deepEqual(outline.redo, []);
  outline = { undo: Array.from({ length: 100 }, (_, index) => index), redo: [1] };
  controls.pushOutlineUndo();
  assert.equal(outline.undo.length, 100);
  assert.deepEqual(outline.redo, []);
});

test("capture position prefers complete machine/work coordinates and falls back to saved origin", () => {
  let axis = {
    mpos: { x: 10, y: 20, z: 30 },
    wpos: { x: 1, y: 2, z: 3 },
  };
  const outline = { origin: { x: 7, y: 8, z: 9 } };
  const controls = createOutlineCoordination({ getOutline: () => outline, getCurrentAxisValues: () => axis });
  assert.deepEqual(controls.currentOutlineCapturePosition(), {
    machine: { x: 10, y: 20, z: 30 },
    work: { x: 1, y: 2, z: 3 },
    origin: { x: 9, y: 18, z: 27 },
  });
  axis = { mpos: { x: 10, y: 20, z: 30 }, wpos: {} };
  assert.deepEqual(controls.currentOutlineCapturePosition(), {
    machine: { x: 10, y: 20, z: 30 },
    work: { x: 3, y: 12, z: 21 },
    origin: { x: 7, y: 8, z: 9 },
  });
  axis = { mpos: {}, wpos: {} };
  assert.equal(controls.currentOutlineCapturePosition(), null);
});

test("curve-fit toggle clears probe data before preview and render callbacks", () => {
  const checkbox = { checked: true };
  const outline = { curveFit: false };
  const order = [];
  const controls = createOutlineCoordination({
    documentRef: makeDocument(new Map([["outline-curve-fit", checkbox]])),
    getOutline: () => outline,
    clearFieldProbeData: () => order.push("clear"),
    updateFieldProbePreview: () => order.push("preview"),
    renderOutlineCaptureView: () => order.push("outline"),
    renderWorkArea: () => order.push("workarea"),
  });
  controls.toggleOutlineCurveFit();
  assert.equal(outline.curveFit, true);
  assert.deepEqual(order, ["clear", "preview", "outline", "workarea"]);
});

test("field spacing commits validation and clamps the stored value", () => {
  const input = {
    value: "999",
    validityMessage: "",
    setCustomValidity(message) { this.validityMessage = message; },
    reportValidity() { this.reported = true; },
  };
  const outline = { fieldSpotGapMM: 8 };
  const controls = createOutlineCoordination({ documentRef: makeDocument(new Map([["outline-field-spacing", input]])), getOutline: () => outline });
  assert.equal(controls.commitOutlineFieldSpacingDraft(), true);
  assert.equal(outline.fieldSpotGapMM, 250);
  input.value = "";
  assert.equal(controls.commitOutlineFieldSpacingDraft(), false);
  assert.equal(input.validityMessage, "Enter a number.");
  assert.equal(input.reported, true);
});

test("field spacing debounce keeps one timer and flushes in the established order", () => {
  const input = {
    value: "8",
    dataset: {},
    setCustomValidity() {},
    reportValidity() {},
  };
  const outline = { fieldSpotGapMM: 8, fieldProbeIssue: "Too dense" };
  const timers = new Map();
  const delays = [];
  const cleared = [];
  let nextID = 1;
  const order = [];
  const controls = createOutlineCoordination({
    documentRef: makeDocument(new Map([["outline-field-spacing", input]])),
    getOutline: () => outline,
    setTimeoutRef: (callback, delay) => { const id = nextID++; timers.set(id, callback); delays.push(delay); return id; },
    clearTimeoutRef: (id) => { cleared.push(id); timers.delete(id); },
    clearControlDrafts: (node) => { order.push(["drafts", node]); },
    clearFieldProbeData: (keepPreview) => order.push(["clear", keepPreview]),
    updateFieldProbePreview: () => order.push(["preview"]),
    setStatusMessage: (...args) => order.push(["status", ...args]),
    renderOutlineCaptureView: () => order.push(["outline"]),
    renderWorkArea: () => order.push(["workarea"]),
  });
  assert.equal(controls.scheduleOutlineFieldSpacingUpdate(), true);
  input.value = "8.2";
  assert.equal(controls.scheduleOutlineFieldSpacingUpdate(), true);
  assert.deepEqual(delays, [OUTLINE_FIELD_SPACING_DEBOUNCE_MS, OUTLINE_FIELD_SPACING_DEBOUNCE_MS]);
  assert.deepEqual(cleared, [1]);
  assert.equal(timers.size, 1);
  const [timerID, callback] = [...timers.entries()][0];
  timers.delete(timerID);
  callback();
  assert.equal(outline.fieldSpotGapMM, 8.2);
  assert.deepEqual(order.map(([name]) => name), ["drafts", "clear", "preview", "status", "outline", "workarea"]);
  assert.equal(timers.size, 0);
});

test("flush can commit without rendering while still clearing the local draft", () => {
  const input = { value: "4", setCustomValidity() {}, reportValidity() {} };
  const outline = { fieldSpotGapMM: 8, fieldProbeIssue: "" };
  const calls = [];
  const controls = createOutlineCoordination({
    documentRef: makeDocument(new Map([["outline-field-spacing", input]])),
    getOutline: () => outline,
    clearControlDrafts: () => calls.push("drafts"),
    clearFieldProbeData: (keep) => calls.push(["clear", keep]),
    updateFieldProbePreview: () => calls.push("preview"),
    renderOutlineCaptureView: () => calls.push("outline"),
    renderWorkArea: () => calls.push("workarea"),
  });
  assert.equal(controls.flushOutlineFieldSpacingUpdate(false), true);
  assert.equal(outline.fieldSpotGapMM, 4);
  assert.deepEqual(calls, ["drafts", ["clear", true], "preview"]);
});
