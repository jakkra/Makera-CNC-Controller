import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mountGcodeViewer } from "./modules/gcode-viewer.js";

const appSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "app.js"), "utf8");
const moduleSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "modules/gcode-viewer.js"), "utf8");

function extractFunction(source, name) {
  const match = new RegExp(`(?:async )?function ${name}\\s*\\(`).exec(source);
  assert.ok(match, `missing ${name}`);
  let index = source.indexOf("{", source.indexOf(")", match.index));
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (; index < source.length; index++) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") { quote = char; continue; }
    if (char === "{") depth++;
    if (char === "}" && --depth === 0) return source.slice(match.index, index + 1);
  }
  throw new Error(`unclosed ${name}`);
}

const movedNames = [
  "dashboardGcodeWindow", "renderDashboardGcodeStream", "drawDashboardGcodePreview",
  "ensureActiveGcodeGeometry", "ensureActiveGcodeSource", "renderActiveGcodeSource",
  "gcodeSourceWindow", "renderGcodeTimelineEvents", "updateGcodeTimeline",
  "ensureGcodeViewer", "ensureDashboardGcodeViewer", "bindGcodeOrbitControls",
  "populateGcodePathScene", "clearGcodeScene", "fitGcodeCamera", "updateGcodeCamera",
];

function viewer() {
  return mountGcodeViewer({
    THREE: { Vector3: class { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } } },
    documentRef: { getElementById: () => null, activeElement: null },
    getViewerSnapshot: () => ({}),
  });
}

test("production G-code viewer keeps dashboard windows bounded around the current line", () => {
  const { dashboardGcodeWindow } = viewer();
  assert.deepEqual(dashboardGcodeWindow(100, 0, 9), { start: 0, end: 9, current: 0 });
  assert.deepEqual(dashboardGcodeWindow(100, 50, 9), { start: 45, end: 54, current: 50 });
  assert.deepEqual(dashboardGcodeWindow(3, 99, 30), { start: 0, end: 3, current: 3 });
});

test("viewer functions remain production implementations behind app composition wrappers", () => {
  for (const name of movedNames) {
    const normalize = (value) => value.replace(/\s+/g, " ").trim();
    assert.match(normalize(extractFunction(moduleSource, name)), new RegExp(`function ${name}\\s*\\(`), name);
    assert.match(extractFunction(appSource, name), new RegExp(`gcodeViewer\\.${name}`), name);
  }
});

test("production source and timeline helpers preserve bounded ranges and event buckets", () => {
  const { gcodeSourceWindow, gcodeTimelineEventMarkers, gcodeTimelineMarkerLabel } = viewer();
  assert.deepEqual(gcodeSourceWindow(100, 400, 200, 20, 2), { start: 18, end: 32 });
  const markers = gcodeTimelineEventMarkers([
    { kind: "tool_change", line: 2, tool: 3 },
    { kind: "spindle", line: 3, code: "M3", value: 12000 },
    { kind: "a_index", line: 90, value: -90 },
  ], 100, 4);
  assert.equal(markers.length, 2);
  assert.equal(gcodeTimelineMarkerLabel(markers[0]), "T3+");
  assert.equal(gcodeTimelineMarkerLabel(markers[1]), "A");
});

test("production orbit helpers retain pinch and wheel bounds", () => {
  const { gcodeOrbitAnglesForDirection, gcodePinchDistance, gcodeOrbitRadiusAfterPinch, gcodeOrbitRadiusAfterWheel } = viewer();
  assert.deepEqual(gcodeOrbitAnglesForDirection({ x: 1, y: 1, z: 1 }).theta, Math.atan2(1, 1));
  assert.equal(gcodePinchDistance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
  assert.equal(gcodeOrbitRadiusAfterPinch(100, 100, 200), 50);
  assert.equal(gcodeOrbitRadiusAfterWheel(100, -10000) < 100, true);
});
