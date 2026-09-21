import test from "node:test";
import assert from "node:assert/strict";
import { mountWorkareaOutline } from "./modules/workarea-outline.js";

test("outline capture position tolerance is stable", () => {
  const feature = mountWorkareaOutline({ stateFacade: { workarea: {}, outline: { points: [], active: false, closed: false }, jog: {}, machine: {} }, documentRef: { getElementById: () => null, querySelectorAll: () => [] } });
  assert.equal(feature.outlineCapturePositionsClose({ machine: { x: 1, y: 2, z: 3 } }, { machine: { x: 1.01, y: 2.01, z: 3.01 } }, 0.02), true);
  assert.equal(feature.outlineCapturePositionsClose({ machine: { x: 1, y: 2, z: 3 } }, { machine: { x: 1.1, y: 2, z: 3 } }, 0.02), false);
});

test("mount exposes geometry and cleanup boundary", () => {
  const attrs = new Map();
  const node = { setAttribute: (key, value) => attrs.set(key, value), removeAttribute: () => {}, classList: { toggle: () => {} }, querySelector: () => null };
  const feature = mountWorkareaOutline({ stateFacade: { workarea: { zoom: 1, panX: 0, panY: 0 }, outline: { points: [], active: false, closed: false }, jog: {}, machine: {} }, documentRef: { getElementById: () => node, querySelectorAll: () => [] } });
  feature.resetWorkAreaView();
  feature.applyWorkAreaViewport();
  assert.ok(attrs.has("transform"));
  assert.equal(feature.state?.workarea, undefined);
  assert.equal(typeof feature.cleanup, "function");
  assert.ok(feature.geometry);
  const snap = feature.outlineSnapshot();
  feature.restoreOutlineSnapshot(snap);
  feature.cleanup();
});

test("render and capture transitions use injected renderer and callbacks", () => {
  const nodes = new Map();
  const makeNode = () => ({ setAttribute() {}, removeAttribute() {}, classList: { toggle() {} }, querySelector: () => null, innerHTML: "" });
  const documentRef = { getElementById: (id) => nodes.get(id) || nodes.set(id, makeNode()).get(id), querySelectorAll: () => [] };
  const state = { ui: { machine: {} }, workarea: { zoom: 1, panX: 0, panY: 0 }, outline: { active: true, closed: false, points: [], origin: null, undo: [], redo: [], fieldProbeResults: [], fieldProbePreview: [] }, jog: { outlineCaptureIntents: [], mpos: { x: 1, y: 2, z: 3 } }, machine: { mpos: { x: 1, y: 2, z: 3 }, wpos: { x: 0, y: 0, z: 0 } }, activeTab: "active-job" };
  let rendered = 0;
  const feature = mountWorkareaOutline({ stateFacade: state, documentRef, normalizeMachineSettings: () => ({ work_area: { x_min: 0, x_max: 20, y_min: 0, y_max: 20 } }), hasGcodeRenderer: () => true, renderActiveGcode: () => { rendered++; }, currentAxisValues: () => ({ mpos: state.machine.mpos, wpos: state.machine.wpos }), visualWorkOrigin: () => ({ x: 0, y: 0 }), setWorkAreaToolRadius: () => {}, syncGcodeContextOverlay: () => true, callbacks: { setStatusMessage() {} } });
  feature.renderWorkArea();
  assert.equal(rendered, 1);
  const outline = state.outline;
  assert.equal(feature.appendOutlineCapturedPosition(outline, { origin: { x: 0, y: 0, z: 0 }, work: { x: 1, y: 2, z: 3 }, machine: { x: 1, y: 2, z: 3 } }, "now"), true);
  assert.equal(outline.points.length, 1);
  feature.restoreOutlineSnapshot({ active: true, points: [], closed: false, origin: null });
  assert.equal(outline.points.length, 0);
});

test("hover position uses the injected coordinate formatter", () => {
  const hover = { hidden: true, textContent: "" };
  const documentRef = { getElementById: (id) => id === "workarea-hover-position" ? hover : null, querySelectorAll: () => [] };
  const feature = mountWorkareaOutline({
    stateFacade: {
      ui: { machine: {} },
      workarea: { zoom: 1, panX: 0, panY: 0 },
      outline: { points: [], active: false, closed: false },
      jog: {},
      machine: {},
    },
    documentRef,
    normalizeMachineSettings: () => ({ work_area: { x_min: 0, x_max: 20, y_min: 0, y_max: 20 } }),
    visualWorkOrigin: () => ({ x: 0, y: 0 }),
    fmtCoord: (value) => `coord:${value}`,
  });
  feature.updateWorkAreaHoverPosition({ x: 50, y: 50 });
  assert.equal(hover.hidden, false);
  assert.match(hover.textContent, /M coord:/);
});
