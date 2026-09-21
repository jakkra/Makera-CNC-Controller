import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "app.js"), "utf8");
const outlineModuleSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "modules/outline.js"),
  "utf8",
);
const outlineHelpers = new Set([
  "fieldProbeSpotGap",
  "fieldProbeCenterSpacing",
  "outlineWorkPoints",
  "fieldProbePlanPointMatchesResult",
  "selectedFieldProbePoint",
  "selectedFieldProbeResult",
  "selectFieldProbePoint",
  "outlinePointLabel",
  "outlineSummaryText",
  "setOutlineFeedback",
  "isProbeToolActive",
  "is3DProbeToolActive",
]);

function extractFunction(name) {
  const functionSource = outlineHelpers.has(name)
    ? outlineModuleSource.replace(/^export /gm, "").replace(/^  /gm, "")
    : source;
  let start = functionSource.indexOf("\nfunction " + name + "(");
  if (start < 0) start = functionSource.indexOf("\nasync function " + name + "(");
  if (start < 0) throw new Error("function not found in app.js or outline.js: " + name);
  const bodyStart = functionSource.indexOf("{", functionSource.indexOf(")", functionSource.indexOf("(", start)));
  let depth = 0;
  for (let i = bodyStart; i < functionSource.length; i++) {
    if (functionSource[i] === "{") depth++;
    else if (functionSource[i] === "}" && --depth === 0) return functionSource.slice(start + 1, i + 1);
  }
  throw new Error("unbalanced function body: " + name);
}

function extractConst(name) {
  const match = source.match(new RegExp("^const " + name + " = .*;$", "m"));
  if (!match) throw new Error("constant not found in app.js: " + name);
  return match[0];
}

function outlineJSONContext(state) {
  const ctx = vm.createContext({ state });
  const constants = [
    "DEFAULT_FIELD_SPOT_GAP_MM",
    "MAX_FIELD_PROBE_POINTS",
    "MAX_EFFECTIVE_OUTLINE_POINTS",
  ];
  const functions = [
    "axisValue",
    "cloneOutlinePoint",
    "cloneOutlineOrigin",
    "cloneFloorProbe",
    "defaultOutlineState",
    "fieldProbeSpotGap",
    "outlineJSONDocument",
    "outlineStateFromJSON",
    "floorProbeFromJSON",
    "outlineOriginFromJSON",
    "boundedOutlineNumber",
    "outlinePointFromJSON",
  ];
  vm.runInContext(constants.map(extractConst).concat(functions.map(extractFunction)).join("\n"), ctx);
  return ctx;
}

test("outline JSON save and load preserves the captured outline and samples", () => {
  const point = (id, x, y, z) => ({
    id,
    x,
    y,
    z,
    machine_x: x - 200,
    machine_y: y - 100,
    machine_z: z - 40,
    captured_at: "2026-07-24T12:00:00Z",
    probed: true,
    probe_output: "[PRB]",
  });
  const state = {
    outline: {
      points: [point("one", 10, 20, 3), point("two", 40, 20, 3), point("three", 40, 60, 3)],
      closed: true,
      curveFit: true,
      origin: { x: -210, y: -120, z: -43 },
      fieldSpotGapMM: 4.5,
      floorMachineZ: -43,
      floorProbe: {
        machine_x: -190,
        machine_y: -90,
        machine_z: -43,
        captured_at: "2026-07-24T11:59:00Z",
        probe_output: "[PRB:-190,-90,-43:1]",
        verified: true,
      },
      fieldReferenceMachineZ: -43,
      fieldReferenceKind: "floor",
      fieldProbeResults: [point("sample", 20, 30, 2.5)],
    },
  };
  const ctx = outlineJSONContext(state);
  const document = vm.runInContext("outlineJSONDocument()", ctx);
  const restored = JSON.parse(vm.runInContext("JSON.stringify(outlineStateFromJSON(" + JSON.stringify(document) + "))", ctx));

  assert.equal(document.kind, "capture-outline");
  assert.equal(document.version, 1);
  assert.equal(restored.active, true);
  assert.equal(restored.closed, true);
  assert.equal(restored.curveFit, true);
  assert.deepEqual(restored.origin, { x: -210, y: -120, z: -43 });
  assert.equal(restored.fieldSpotGapMM, 4.5);
  assert.equal(restored.floorMachineZ, -43);
  assert.deepEqual(restored.floorProbe, {
    machine_x: -190,
    machine_y: -90,
    machine_z: -43,
    captured_at: "2026-07-24T11:59:00Z",
    probe_output: "[PRB:-190,-90,-43:1]",
    verified: true,
  });
  assert.equal(restored.fieldReferenceMachineZ, -43);
  assert.equal(restored.fieldReferenceKind, "floor");
  assert.equal(restored.points.length, 3);
  assert.equal(restored.points[2].machine_y, -40);
  assert.equal(restored.fieldProbeResults.length, 1);
  assert.equal(restored.fieldProbeResults[0].machine_z, -37.5);
});

test("outline JSON load rejects malformed geometry", () => {
  const ctx = outlineJSONContext({ outline: {} });
  assert.throws(
    () => vm.runInContext(`outlineStateFromJSON({app: "cnc-proxy", kind: "capture-outline", version: 1, units: "mm", outline: {points: [{x: 0, y: 0}]}})`, ctx),
    /between 2 and/,
  );
  assert.throws(
    () => vm.runInContext(`outlineStateFromJSON({app: "cnc-proxy", kind: "capture-outline", version: 1, units: "mm", outline: {points: [{id: "a", x: 0, y: 0, z: 0, machine_x: 0, machine_y: 0, machine_z: 0}, {id: "b", x: "bad", y: 0, z: 0, machine_x: 0, machine_y: 0, machine_z: 0}]}})`, ctx),
    /missing x/,
  );
});

test("outline file load reports transient completion only through the bottom status bar", async () => {
  const messages = [];
  const state = {
    outline: {
      points: [],
      filePending: false,
      feedback: "",
      feedbackKind: "",
    },
  };
  const loaded = {
    points: [{}, {}, {}, {}],
    closed: true,
    fieldProbeResults: [],
    feedback: "",
    feedbackKind: "",
  };
  let previewUpdates = 0;
  const ctx = vm.createContext({
    state,
    confirm: () => true,
    outlineStateFromJSON: () => loaded,
    cancelOutlineCaptureIntents: () => {},
    markGcodeContextOverlayDirty: () => {},
    updateFieldProbePreview: () => { previewUpdates++; },
    renderOutlineCapture: () => {},
    renderWorkArea: () => {},
    setStatusMessage: (...args) => messages.push(args),
  });
  vm.runInContext([
    extractFunction("installLoadedOutlineState"),
    extractFunction("loadOutlineFile"),
  ].join("\n"), ctx);
  await vm.runInContext(`loadOutlineFile({text: async () => "{}"})`, ctx);

  assert.equal(state.outline, loaded);
  assert.equal(previewUpdates, 1, "a loaded closed outline always regenerates the current probe plan");
  assert.deepEqual(messages.map(([key, text, kind]) => ({ key, text, kind })), [
    { key: "outline", text: "Loading outline...", kind: "" },
    { key: "outline", text: "Loaded outline with 4 points.", kind: "ok" },
  ]);
});

test("field probing keeps every travel and retract at the starting machine Z", async () => {
  const calls = [];
  const workAreaRenders = [];
  const state = {
    jog: { armed: false },
    outline: {
      active: true,
      closed: true,
      points: [{}, {}, {}],
      origin: { x: -200, y: -100, z: -40 },
      floorMachineZ: -40,
      fieldProbePreview: [{ id: "first", x: 1, y: 2 }, { id: "second", x: 3, y: 4 }],
      fieldProbeResults: [{
        id: "first",
        x: 1,
        y: 2,
        z: -42,
        machine_x: -199,
        machine_y: -98,
        machine_z: -42,
      }],
      fieldProbeTooDense: false,
      fieldProbePending: false,
      fieldProbeIndex: 0,
      feedback: "",
      feedbackKind: "",
    },
  };
  const ctx = vm.createContext({
    state,
    isProbeToolActive: () => true,
    cancelOutlineFieldSpacingUpdate: () => {},
    commitOutlineFieldSpacingDraft: () => true,
    clearControlDrafts: () => {},
    markGcodeContextOverlayDirty: () => {},
    updateFieldProbePreview: () => {},
    currentOutlineCapturePosition: () => ({ machine: { z: -41 } }),
    setOutlineFeedback: () => {},
    renderOutlineCapture: () => {},
    renderWorkArea: () => workAreaRenders.push({
      pending: state.outline.fieldProbePending,
      index: state.outline.fieldProbeIndex,
      results: state.outline.fieldProbeResults.length,
    }),
    confirmProbeAction: async () => true,
    fmtCoord: (value) => String(value),
    pollMachine: () => {},
    probeZAtWorkPoint: async (point, opts) => {
      calls.push({ point, opts });
      return { x: point.x, y: point.y, z: -42, machine_x: point.x - 200, machine_y: point.y - 100, machine_z: -42 };
    },
  });
  vm.runInContext(["axisValue", "finiteOr", "cloneOutlineOrigin", "fieldProbePlanPointMatchesResult", "unprobedFieldProbePoints", "runFieldProbe"].map(extractFunction).join("\n"), ctx);
  await vm.runInContext("runFieldProbe()", ctx);

  assert.equal(calls.length, 1, "only the point without a matching sample is probed");
  assert.equal(calls[0].point.id, "second");
  for (const { opts } of calls) {
    assert.equal(opts.safeZMM, -41);
    assert.equal(opts.retractZMM, -41);
    assert.equal("retractAboveMM" in opts, false);
  }
  assert.ok(workAreaRenders.some((render) => render.pending && render.index === 1 && render.results === 1), "remaining target renders before its probe completes");
  assert.equal(state.outline.fieldProbeResults.length, 2, "existing and new samples are retained");
});

test("field probing without a floor confirms and uses the current Z origin", async () => {
  let confirmation = null;
  const state = {
    jog: { armed: false },
    outline: {
      active: true,
      closed: true,
      points: [{}, {}, {}],
      origin: { x: -200, y: -100, z: -40 },
      floorMachineZ: null,
      fieldProbePreview: [{ id: "only", x: 1, y: 2 }],
      fieldProbeResults: [],
      fieldProbeTooDense: false,
      fieldProbePending: false,
      fieldProbeIndex: 0,
      feedback: "",
      feedbackKind: "",
    },
  };
  const ctx = vm.createContext({
    state,
    isProbeToolActive: () => true,
    cancelOutlineFieldSpacingUpdate: () => {},
    commitOutlineFieldSpacingDraft: () => true,
    clearControlDrafts: () => {},
    markGcodeContextOverlayDirty: () => {},
    updateFieldProbePreview: () => {},
    currentOutlineCapturePosition: () => ({ machine: { z: -35 } }),
    setOutlineFeedback: () => {},
    renderOutlineCapture: () => {},
    renderWorkArea: () => {},
    pollMachine: () => {},
    confirmProbeAction: async (options) => {
      confirmation = options;
      return true;
    },
    fmtCoord: (value) => String(value),
    probeZAtWorkPoint: async (point) => ({
      x: point.x,
      y: point.y,
      z: 1.25,
      machine_x: point.x - 200,
      machine_y: point.y - 100,
      machine_z: -38.75,
    }),
  });
  vm.runInContext(["axisValue", "finiteOr", "cloneOutlineOrigin", "fieldProbePlanPointMatchesResult", "unprobedFieldProbePoints", "runFieldProbe"].map(extractFunction).join("\n"), ctx);
  await vm.runInContext("runFieldProbe()", ctx);

  assert.equal(state.outline.fieldProbeResults.length, 1);
  assert.equal(state.outline.fieldReferenceMachineZ, -40);
  assert.equal(state.outline.fieldReferenceKind, "work_origin");
  assert.match(confirmation.warning, /No floor probe is recorded/);
  assert.match(confirmation.warning, /current Z origin/);
  assert.match(confirmation.warning, /Consider probing the floor first/);
});
