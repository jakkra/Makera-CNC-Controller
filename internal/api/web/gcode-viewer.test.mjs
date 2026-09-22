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
  "populateGcodePathScene", "clearGcodeScene", "fitGcodeCamera", "updateGcodeCamera", "drawGcodePreview",
];

function viewer({ deps = {}, documentRef, getActiveGcode = () => null, getMachine = () => ({}), getFiles = () => new Map(), getOutline = () => ({}) } = {}) {
  return mountGcodeViewer({
    THREE: { Vector3: class { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } } },
    documentRef: documentRef || { getElementById: () => null, activeElement: null },
    getActiveGcode,
    getMachine,
    getFiles,
    getOutline,
    deps,
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

test("G-code source and timeline interactions stay owned by the production viewer", () => {
  assert.match(moduleSource, /function bindInteractions\(/);
  assert.match(appSource, /gcodeViewer\.bindInteractions\(\{ clearControlDrafts \}\)/);
  assert.doesNotMatch(appSource, /const gcodeSourceScroll = document\.getElementById/);
  assert.doesNotMatch(appSource, /const gcodeTimeline = document\.getElementById/);
  const sourceScroll = {};
  const timeline = { dataset: {}, value: "0" };
  const detail = { textContent: "", title: "" };
  const nodes = new Map([
    ["active-gcode-source-scroll", sourceScroll],
    ["gcode-timeline", timeline],
    ["gcode-timeline-event-detail", detail],
  ]);
  const documentRef = { getElementById: (id) => nodes.get(id) || null, activeElement: null };
  let observed = null;
  let cleared = null;
  let progressUpdates = 0;
  class ResizeObserverStub {
    constructor(callback) { this.callback = callback; }
    observe(node) { observed = node; }
  }
  const feature = viewer({
    documentRef,
    deps: {
      ResizeObserverRef: ResizeObserverStub,
      clearControlDrafts: (node) => { cleared = node; },
      updateGcodeProgress: () => { progressUpdates++; },
      setTextIfChanged: (node, value) => { node.textContent = value; },
    },
  });
  const view = feature.getGcodeView();
  view.segments = [{}, {}, {}];
  view.followLive = true;
  view.timelineEventLine = 7;
  feature.bindInteractions();

  assert.equal(typeof sourceScroll.onscroll, "function");
  assert.equal(typeof sourceScroll.onwheel, "function");
  assert.equal(typeof sourceScroll.onpointerdown, "function");
  assert.equal(typeof sourceScroll.ontouchstart, "function");
  assert.equal(typeof sourceScroll.onkeydown, "function");
  assert.equal(observed, sourceScroll);
  sourceScroll.onpointerdown();
  assert.ok(feature.getActiveGcodeSource().userScrollingUntil > Date.now());

  timeline.onpointerdown();
  assert.equal(view.timelineDragging, true);
  assert.equal(view.followLive, false);
  assert.equal(timeline.dataset.dragging, "1");
  timeline.value = "2";
  timeline.oninput({ target: timeline });
  assert.equal(view.cursor, 2);
  assert.equal(view.timelineEventLine, 0);
  assert.equal(detail.textContent, "Program events");
  timeline.value = "99";
  timeline.onpointerup();
  assert.equal(view.cursor, 3, "release clamps the timeline cursor to the available segments");
  assert.equal(view.timelineDragging, false);
  assert.equal(cleared, timeline);
  assert.equal(progressUpdates, 2);
});

test("drawGcodePreview keeps the empty path branch and synchronizes its live source", () => {
  const calls = [];
  const feature = viewer({ deps: {
    renderGcodeTimelineEvents: (...args) => calls.push(["events", ...args]),
    setGcodePreviewEmpty: (text) => calls.push(["empty", text]),
    updateGcodeTimeline: (total) => calls.push(["timeline", total]),
    syncActiveGcodeSourceLine: (live) => calls.push(["source", live]),
  } });
  const preview = { segments: [], events: [{ kind: "attention", line: 4 }], tool_metadata: [{ number: 2 }], line_count: 12 };
  feature.drawGcodePreview(preview, null);
  assert.deepEqual(calls, [["events", preview.events, preview.tool_metadata, 12], ["empty", "No plotted moves"], ["timeline", 0], ["source", null]]);
  assert.equal(feature.getGcodeView().followLive, false);
});

test("drawGcodePreview preserves local timeline ownership when the canvas is unavailable", () => {
  const calls = [];
  const feature = viewer({ deps: {
    ensureGcodeViewer: () => false,
    gcodeTimelineLocallyOwned: () => true,
    updateGcodeTimeline: (total) => calls.push(["timeline", total]),
    syncActiveGcodeSourceLine: (live) => calls.push(["source", live]),
  } });
  const view = feature.getGcodeView();
  view.cursor = 2;
  const segments = [{ line: 1 }, { line: 2 }, { line: 3 }];
  const live = { cursor: 1, playedLines: 2 };
  feature.drawGcodePreview({ segments, bounds: { min: [0, 0, 0], max: [1, 1, 1] } }, live);
  assert.equal(view.segments, segments);
  assert.equal(view.cursor, 2, "a locally owned timeline keeps its current cursor");
  assert.equal(view.followLive, false);
  assert.equal(view.live, live);
  assert.deepEqual(calls, [["timeline", 3], ["source", live]]);
});

test("drawGcodePreview fits a new path once, then keeps live cursor local to a selected timeline event", () => {
  const calls = [];
  let timelineOwned = false;
  const bounds = { min: [0, 0, 0], max: [4, 5, 6] };
  const feature = viewer({
    getActiveGcode: () => ({ path: "part.nc", entry: { name: "part.nc" } }),
    deps: {
      ensureGcodeViewer: () => true,
      syncGcodeContextOverlay: () => {},
      combineGcodeBounds: (_path, context) => context || bounds,
      gcodeCameraFitKey: () => "fit-part",
      rebuildGcodeScene: (...args) => calls.push(["rebuild", ...args]),
      fitGcodeCamera: (value) => calls.push(["fit", value]),
      gcodeTimelineLocallyOwned: () => timelineOwned,
      setGcodePreviewEmpty: (text) => calls.push(["empty", text]),
      updateGcodeTimeline: (total) => calls.push(["timeline", total]),
      updateGcodeProgress: () => calls.push(["progress"]),
      scheduleGcodeRender: () => calls.push(["schedule"]),
    },
  });
  const preview = { segments: [{ line: 2 }, { line: 7 }], bounds, line_count: 9, plotted_segments: 2, total_distance: 5, has_4axis: true };
  feature.drawGcodePreview(preview, { cursor: 1 });
  const view = feature.getGcodeView();
  assert.equal(view.key, "part.nc:9:2:5:4|");
  assert.equal(view.fitKey, "fit-part");
  assert.equal(view.cursor, 1);
  assert.equal(view.followLive, true);
  assert.equal(view.has4Axis, true);
  assert.equal(calls.filter(([name]) => name === "rebuild").length, 1);
  assert.equal(calls.filter(([name]) => name === "fit").length, 1);
  view.timelineEventLine = 7;
  timelineOwned = true;
  feature.drawGcodePreview(preview, { cursor: 2 });
  assert.equal(view.cursor, 1, "a locally selected event retains the displayed cursor during live updates");
  assert.equal(calls.filter(([name]) => name === "rebuild").length, 1, "an unchanged key does not rebuild the path");
  assert.equal(calls.filter(([name]) => name === "fit").length, 1, "an unchanged fit key does not refit the camera");
  assert.equal(calls.filter(([name]) => name === "schedule").length, 2);
});

test("drawGcodePreview renders context-only outlines and keeps the empty-context fallback", () => {
  const calls = [];
  const outline = { active: true, points: [{ x: 0, y: 0 }, { x: 2, y: 1 }] };
  let showContext = true;
  const feature = viewer({ getOutline: () => outline, deps: {
    ensureGcodeViewer: () => true,
    syncGcodeContextOverlay: () => { const view = feature.getGcodeView(); view.contextVisible = showContext; view.contextKey = "outline-1"; view.contextBounds = { min: [0, 0, 0], max: [2, 1, 0] }; },
    clearGcodeScene: () => calls.push(["clear"]),
    combineGcodeBounds: (path, context) => context,
    gcodeCameraFitKey: () => "outline-fit",
    rebuildGcodeScene: (preview, segments) => calls.push(["rebuild", preview, segments]),
    fitGcodeCamera: () => calls.push(["fit"]),
    setGcodePreviewEmpty: (text) => calls.push(["empty", text]),
    updateGcodeTimeline: (total) => calls.push(["timeline", total]),
    syncActiveGcodeSourceLine: (live) => calls.push(["source", live]),
    updateGcodeProgress: () => calls.push(["progress"]),
    scheduleGcodeRender: () => calls.push(["schedule"]),
  } });
  feature.drawGcodePreview({ segments: [] });
  const view = feature.getGcodeView();
  assert.equal(view.key, "context-only|outline-1");
  assert.deepEqual(view.segments, []);
  assert.ok(calls.some(([name, preview]) => name === "rebuild" && preview.bounds === view.contextBounds));
  assert.ok(calls.some(([name]) => name === "fit"));
  assert.ok(calls.some(([name, text]) => name === "empty" && text === ""));
  assert.ok(calls.some(([name, total]) => name === "timeline" && total === 0));

  showContext = false;
  view.key = "stale-context";
  calls.length = 0;
  feature.drawGcodePreview({ segments: [] });
  assert.deepEqual(calls, [["clear"], ["empty", "No plotted moves"], ["timeline", 0], ["source", null]]);
});

test("production orbit helpers retain pinch and wheel bounds", () => {
  const { gcodeOrbitAnglesForDirection, gcodePinchDistance, gcodeOrbitRadiusAfterPinch, gcodeOrbitRadiusAfterWheel } = viewer();
  assert.deepEqual(gcodeOrbitAnglesForDirection({ x: 1, y: 1, z: 1 }).theta, Math.atan2(1, 1));
  assert.equal(gcodePinchDistance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
  assert.equal(gcodeOrbitRadiusAfterPinch(100, 100, 200), 50);
  assert.equal(gcodeOrbitRadiusAfterWheel(100, -10000) < 100, true);
});
