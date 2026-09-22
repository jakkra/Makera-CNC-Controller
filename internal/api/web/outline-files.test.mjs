import test from "node:test";
import assert from "node:assert/strict";
import { createOutlineFilesFeature } from "./modules/outline-files.js";

class FakeBlob {
  constructor(parts, options = {}) {
    this.parts = parts;
    this.type = options.type || "";
  }
}

function fakeDocument() {
  const links = [];
  return {
    links,
    body: {
      appendChild(node) { links.push(node); },
    },
    createElement(tag) {
      assert.equal(tag, "a");
      return {
        href: "blob:test",
        download: "",
        click() { this.clicked = true; },
        remove() { this.removed = true; },
      };
    },
  };
}

function makeFeature(overrides = {}) {
  const events = [];
  const documentRef = fakeDocument();
  const urlRef = {
    createObjectURL(blob) { events.push(["create", blob]); return "blob:test"; },
    revokeObjectURL(url) { events.push(["revoke", url]); },
  };
  let outline = overrides.outline || { points: [], filePending: false };
  const feature = createOutlineFilesFeature({
    documentRef,
    urlRef,
    blobCtor: FakeBlob,
    getOutline: () => outline,
    setOutline: (value) => { outline = value; },
    outlineJSONDocument: () => ({ app: "cnc-proxy" }),
    buildOutlineDXF: () => { events.push(["build-dxf"]); return "DXF CONTENT"; },
    buildHeightOBJ: () => { events.push(["build-obj"]); return "OBJ CONTENT"; },
    buildHeightPGM: () => { events.push(["build-pgm"]); return "PGM CONTENT"; },
    outlineStateFromJSON: (doc) => ({ points: doc.points, closed: !!doc.closed, filePending: false }),
    cancelOutlineCaptureIntents: (value) => events.push(["cancel", value]),
    markGcodeContextOverlayDirty: () => events.push(["dirty"]),
    updateFieldProbePreview: () => events.push(["preview"]),
    renderOutlineCapture: () => events.push(["render-outline"]),
    renderWorkArea: () => events.push(["render-workarea"]),
    setOutlineFeedback: (...args) => events.push(["feedback", ...args]),
    setStatusMessage: (...args) => events.push(["status", ...args]),
    confirmRef: () => overrides.confirm !== false,
    now: () => new Date("2026-01-02T03:04:05.000Z"),
  });
  return { feature, documentRef, events, getOutline: () => outline };
}

test("saveOutlineJSON downloads a typed JSON blob and reports success", () => {
  const { feature, documentRef, events } = makeFeature({ outline: { points: [{ x: 1 }, { x: 2 }] } });
  feature.saveOutlineJSON();
  assert.equal(documentRef.links.length, 1);
  assert.equal(documentRef.links[0].download, "cnc-outline-2026-01-02T03-04-05-000Z.json");
  assert.equal(documentRef.links[0].clicked, true);
  assert.equal(documentRef.links[0].removed, true);
  assert.deepEqual(events[0][0], "create");
  assert.equal(events.at(-1)[0], "feedback");
  assert.deepEqual(events.at(-1).slice(1), ["Outline JSON export started.", "ok"]);
});

test("saveOutlineJSON keeps serializer failures in the bottom feedback callback", () => {
  const { feature, events } = makeFeature();
  const broken = createOutlineFilesFeature({
    outlineJSONDocument: () => { throw new Error("outline needs at least two points"); },
    setOutlineFeedback: (...args) => events.push(["feedback", ...args]),
  });
  broken.saveOutlineJSON();
  assert.deepEqual(events, [["feedback", "Save outline failed: outline needs at least two points", "error"]]);
  assert.equal(typeof feature.saveOutlineJSON, "function");
});

test("loadOutlineFile preserves cancel behavior and does not enter pending state", async () => {
  const current = { points: [{ x: 1 }], filePending: false };
  const { feature, events, getOutline } = makeFeature({ outline: current, confirm: false });
  await feature.loadOutlineFile({ text: async () => JSON.stringify({ points: [{ x: 2 }] }) });
  assert.equal(getOutline(), current);
  assert.equal(current.filePending, false);
  assert.equal(events.length, 0);
});

test("loadOutlineFile reports pending then installs success and refreshes overlays", async () => {
  const current = { points: [], filePending: false };
  const { feature, events, getOutline } = makeFeature({ outline: current });
  await feature.loadOutlineFile({ text: async () => JSON.stringify({ points: [{ x: 1 }, { x: 2 }], closed: true }) });
  assert.deepEqual(getOutline().points, [{ x: 1 }, { x: 2 }]);
  assert.equal(current.filePending, true);
  assert.deepEqual(events.map((event) => event[0]), ["status", "render-outline", "cancel", "dirty", "preview", "render-outline", "render-workarea", "status"]);
  assert.deepEqual(events.at(-1).slice(1), ["outline", "Loaded outline with 2 points.", "ok", { force: true }]);
});

test("loadOutlineFile clears pending and reports parser failures", async () => {
  const current = { points: [], filePending: false };
  const { feature, events, getOutline } = makeFeature({ outline: current });
  const broken = createOutlineFilesFeature({
    getOutline: () => current,
    outlineStateFromJSON: () => { throw new Error("file is invalid"); },
    setStatusMessage: (...args) => events.push(["status", ...args]),
    renderOutlineCapture: () => events.push(["render-outline"]),
  });
  await broken.loadOutlineFile({ text: async () => "{}" });
  assert.equal(getOutline(), current);
  assert.equal(current.filePending, false);
  assert.deepEqual(events, [
    ["status", "outline", "Loading outline...", "", { force: true }],
    ["render-outline"],
    ["render-outline"],
    ["status", "outline", "Load outline failed: file is invalid", "error", { force: true }],
  ]);
});

test("exportOutline downloads a timestamped DXF and reports success", () => {
  const { feature, documentRef, events } = makeFeature({ outline: { points: [{ x: 1 }, { x: 2 }] } });
  feature.exportOutline();
  assert.equal(documentRef.links.length, 1);
  assert.equal(documentRef.links[0].download, "cnc-outline-2026-01-02T03-04-05-000Z.dxf");
  assert.equal(documentRef.links[0].clicked, true);
  const blob = events.find((event) => event[0] === "create")[1];
  assert.equal(blob.type, "application/dxf");
  assert.equal(blob.parts[0], "DXF CONTENT");
  assert.deepEqual(events.filter((event) => event[0] === "build-dxf").length, 1);
  assert.deepEqual(events.at(-1), ["feedback", "DXF export started.", "ok"]);
});

test("exportOutline preserves point guard and reports builder failures", () => {
  const short = makeFeature({ outline: { points: [{ x: 1 }] } });
  short.feature.exportOutline();
  assert.equal(short.documentRef.links.length, 0);
  assert.deepEqual(short.events, [["feedback", "Export failed: outline needs at least two points", "error"]]);

  const failureEvents = [];
  const broken = createOutlineFilesFeature({
    getOutline: () => ({ points: [{ x: 1 }, { x: 2 }] }),
    buildOutlineDXF: () => { throw new Error("invalid geometry"); },
    setOutlineFeedback: (...args) => failureEvents.push(["feedback", ...args]),
  });
  broken.exportOutline();
  assert.deepEqual(failureEvents, [["feedback", "Export failed: invalid geometry", "error"]]);
});

test("height exports download timestamped files with the established MIME types and feedback", () => {
  const obj = makeFeature();
  obj.feature.exportHeightOBJ();
  assert.equal(obj.documentRef.links[0].download, "cnc-outline-height-2026-01-02T03-04-05-000Z.obj");
  assert.equal(obj.events.find((event) => event[0] === "create")[1].type, "text/plain");
  assert.equal(obj.events.find((event) => event[0] === "create")[1].parts[0], "OBJ CONTENT");
  assert.deepEqual(obj.events.at(-1), ["feedback", "OBJ export started.", "ok"]);

  const pgm = makeFeature();
  pgm.feature.exportHeightImage();
  assert.equal(pgm.documentRef.links[0].download, "cnc-outline-height-2026-01-02T03-04-05-000Z.pgm");
  assert.equal(pgm.events.find((event) => event[0] === "create")[1].type, "image/x-portable-graymap");
  assert.equal(pgm.events.find((event) => event[0] === "create")[1].parts[0], "PGM CONTENT");
  assert.deepEqual(pgm.events.at(-1), ["feedback", "Height image export started.", "ok"]);
});

test("height exports preserve their distinct builder error feedback", () => {
  const events = [];
  const feature = createOutlineFilesFeature({
    buildHeightOBJ: () => { throw new Error("OBJ unavailable"); },
    buildHeightPGM: () => { throw new Error("PGM unavailable"); },
    setOutlineFeedback: (...args) => events.push(["feedback", ...args]),
  });
  feature.exportHeightOBJ();
  feature.exportHeightImage();
  assert.deepEqual(events, [
    ["feedback", "OBJ export failed: OBJ unavailable", "error"],
    ["feedback", "Height image export failed: PGM unavailable", "error"],
  ]);
});
