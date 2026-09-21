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
