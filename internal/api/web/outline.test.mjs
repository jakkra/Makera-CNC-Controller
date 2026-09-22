import test from "node:test";
import assert from "node:assert/strict";
import { createOutlineFeature } from "./modules/outline.js";

function fixture() {
  let outline = {
    active: true,
    closed: true,
    curveFit: true,
    points: [{ x: 0, y: 0, z: 1 }, { x: 10, y: 0, z: 1 }, { x: 10, y: 10, z: 1 }],
    fieldSpotGapMM: 8,
    fieldProbePreview: [{ id: "p1", x: 2, y: 3, z: 0 }],
    fieldProbeResults: [{ id: "p1", x: 2.01, y: 3.01, z: 4 }],
    fieldProbeSelectedID: "",
  };
  const renders = [];
  const feature = createOutlineFeature({
    getOutline: () => outline,
    getMachine: () => ({ tool: { active: 0 } }),
    renderOutlineCapture: () => renders.push("outline"),
    renderWorkArea: () => renders.push("workarea"),
    normalizedClosedPolygon: (points) => points,
    pointInPolygonOrBoundary: () => true,
  });
  return { feature, renders, get outline() { return outline; }, replace: (next) => { outline = next; } };
}

test("outline model preserves spacing, labels, summaries, and probe matching", () => {
  const { feature } = fixture();
  assert.equal(feature.fieldProbeSpotGap(), 8);
  assert.equal(feature.fieldProbeCenterSpacing(), 10);
  assert.deepEqual(feature.outlineWorkPoints(), [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
  assert.equal(feature.fieldProbePlanPointMatchesResult({ id: "p1", x: 2, y: 3 }, { id: "p1", x: 2.01, y: 3.01 }), true);
  assert.equal(feature.outlinePointLabel({ x: 1, y: 2, z: 3 }), "X 1.000 Y 2.000 Z 3.000");
  assert.equal(feature.outlineSummaryText(), "3 points | closed | curve fit | 1 field probes | 1 Z samples");
});

test("outline selection uses current state and preserves render lifecycle", () => {
  const fixtureState = fixture();
  assert.equal(fixtureState.feature.selectFieldProbePoint("p1"), true);
  assert.equal(fixtureState.outline.fieldProbeSelectedID, "p1");
  assert.deepEqual(fixtureState.renders, ["outline", "workarea"]);
  assert.equal(fixtureState.feature.selectedFieldProbeResult().z, 4);
  fixtureState.replace({ ...fixtureState.outline, fieldProbeSelectedID: "missing" });
  assert.equal(fixtureState.feature.selectedFieldProbePoint(), null);
});

test("outline feature follows replaced outline state and tool state", () => {
  const fixtureState = fixture();
  fixtureState.replace({ ...fixtureState.outline, active: false, floorMachineZ: 4 });
  assert.equal(fixtureState.feature.outlineSummaryText(), "floor Z0 at M 4.000");
  assert.equal(fixtureState.feature.isProbeToolActive(), true);
  assert.equal(fixtureState.feature.is3DProbeToolActive(), false);
});

function historyFeature(outline, calls) {
  return createOutlineFeature({
    getOutline: () => outline,
    renderOutlineCapture: () => calls.push(["outline-render", outline.feedback]),
    renderWorkArea: () => calls.push(["workarea-render", outline.feedback]),
    pushOutlineUndo: () => calls.push(["push-undo", outline.closed, outline.points.length]),
    outlineSnapshot: () => {
      calls.push(["snapshot", outline.points[0]?.x]);
      return { active: outline.active, closed: outline.closed, points: outline.points.map((point) => ({ ...point })) };
    },
    restoreOutlineSnapshot: (snapshot) => {
      calls.push(["restore", snapshot.points[0]?.x]);
      outline.active = snapshot.active;
      outline.closed = snapshot.closed;
      outline.points = snapshot.points.map((point) => ({ ...point }));
    },
    updateFieldProbePreview: () => calls.push(["preview", outline.closed]),
  });
}

test("closing an outline keeps its validation, undo, preview, and render order", () => {
  const outline = { points: [{}], closed: false, active: false, feedback: "", feedbackKind: "" };
  const calls = [];
  const feature = historyFeature(outline, calls);
  feature.closeOutline();
  assert.equal(outline.feedback, "Close outline needs at least two points.");
  assert.equal(outline.feedbackKind, "error");
  assert.deepEqual(calls, [["outline-render", "Close outline needs at least two points."]]);

  calls.length = 0;
  outline.points = [{ x: 0, y: 0 }, { x: 5, y: 0 }];
  outline.closed = true;
  feature.closeOutline();
  assert.equal(outline.feedback, "Outline is already closed.");
  assert.equal(outline.feedbackKind, "error");
  assert.deepEqual(calls, [["outline-render", "Outline is already closed."]]);

  calls.length = 0;
  outline.closed = false;
  outline.points = [{ x: 0, y: 0 }, { x: 5, y: 0 }];
  feature.closeOutline();
  assert.equal(outline.active, true);
  assert.equal(outline.closed, true);
  assert.equal(outline.feedback, "Outline closed.");
  assert.equal(outline.feedbackKind, "ok");
  assert.deepEqual(calls, [
    ["push-undo", false, 2],
    ["preview", true],
    ["outline-render", "Outline closed."],
    ["workarea-render", "Outline closed."],
  ]);
});

test("outline undo and redo preserve snapshot stack ordering and render lifecycle", () => {
  const previous = { active: false, closed: false, points: [{ x: 1, y: 1 }] };
  const outline = {
    active: true, closed: true, points: [{ x: 2, y: 2 }], undo: [previous], redo: [],
    feedback: "", feedbackKind: "",
  };
  const calls = [];
  const feature = historyFeature(outline, calls);
  feature.undoOutline();
  assert.deepEqual(outline.points, [{ x: 1, y: 1 }]);
  assert.deepEqual(outline.undo, []);
  assert.deepEqual(outline.redo, [{ active: true, closed: true, points: [{ x: 2, y: 2 }] }]);
  assert.equal(outline.feedback, "Undo.");
  assert.deepEqual(calls.splice(0), [
    ["snapshot", 2], ["restore", 1], ["outline-render", "Undo."], ["workarea-render", "Undo."],
  ]);

  feature.redoOutline();
  assert.deepEqual(outline.points, [{ x: 2, y: 2 }]);
  assert.deepEqual(outline.undo, [{ active: false, closed: false, points: [{ x: 1, y: 1 }] }]);
  assert.deepEqual(outline.redo, []);
  assert.equal(outline.feedback, "Redo.");
  assert.deepEqual(calls, [
    ["snapshot", 1], ["restore", 2], ["outline-render", "Redo."], ["workarea-render", "Redo."],
  ]);
});
