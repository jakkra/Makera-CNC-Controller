import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SAVED_POSITION_SLOTS, SAVED_POSITIONS_KEY, normalizeSavedPositions, loadSavedPositions, createSurfaceSavedPositions,
} from "./modules/surface-saved-positions.js";

const here = dirname(fileURLToPath(import.meta.url));

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return { data, getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); } };
}

function fakeDom() {
  const node = (dataset = {}) => {
    const attrs = {};
    const small = { textContent: "" };
    return {
      dataset, disabled: false, textContent: "", small,
      classList: { set: new Set(), toggle(c, on) { on ? this.set.add(c) : this.set.delete(c); }, contains(c) { return this.set.has(c); } },
      setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; }, attrs,
      querySelector: () => small,
    };
  };
  const slots = SAVED_POSITION_SLOTS.map((s) => node({ surfacePosition: s }));
  const root = node();
  const save = node();
  return {
    slots, root, save,
    getElementById: (id) => (id === "surface-positions" ? root : id === "surface-positions-save" ? save : null),
    querySelectorAll: (sel) => (sel === "[data-surface-position]" ? slots : []),
  };
}

test("saved positions preserve XYZ, legacy XY, and missing coordinates", () => {
  assert.deepEqual(normalizeSavedPositions({ A: { x: "1", y: 2, z: 9 }, B: { x: NaN, y: 1 }, Z: { x: 1, y: 1 } }),
    { A: { x: 1, y: 2, z: 9 }, B: null, C: null, D: null });
  assert.deepEqual(loadSavedPositions(memoryStorage({ [SAVED_POSITIONS_KEY]: "{oops" })), { A: null, B: null, C: null, D: null });
  assert.deepEqual(loadSavedPositions({ getItem() { throw new Error("blocked"); } }), { A: null, B: null, C: null, D: null });
});

test("saving stores the current machine XYZ and recall defaults to XY", () => {
  const dom = fakeDom();
  const storage = memoryStorage();
  const moves = [];
  const messages = [];
  let mpos = { x: -150.25, y: -120.5, z: -40 };
  const saved = createSurfaceSavedPositions({
    documentRef: dom, storage,
    getMachinePosition: () => mpos,
    sendTapMove: (...args) => moves.push(args),
    setStatusMessage: (key, text, kind) => messages.push([key, text, kind]),
  });
  saved.bind((button, action) => { button.action = action; });
  assert.equal(dom.slots[0].small.textContent, "Empty");

  dom.slots[0].action();
  assert.match(messages.at(-1)[1], /Position A is empty/);
  assert.equal(moves.length, 0);

  dom.save.action();
  assert.equal(saved.isSaving(), true);
  assert.equal(dom.save.attrs["aria-pressed"], "true");
  dom.slots[0].action();
  assert.equal(saved.isSaving(), false);
  assert.deepEqual(saved.positions().A, { x: -150.25, y: -120.5, z: -40 });
  assert.deepEqual(JSON.parse(storage.data[SAVED_POSITIONS_KEY]).A, { x: -150.25, y: -120.5, z: -40 });
  assert.equal(messages.at(-1)[1], "Saved position A at X -150.3 Y -120.5 Z -40.0.");
  assert.equal(dom.slots[0].small.textContent, "X -150.3\nY -120.5");

  mpos = { x: -60, y: -120.5, z: 0 };
  dom.save.action();
  dom.slots[1].action();
  dom.slots[0].action();
  dom.slots[1].action();
  const clearance = { requireSafeZ: true, fastSafeZ: true, yRetractMM: 0 };
  assert.deepEqual(moves, [[{ x: -150.25, y: -120.5 }, "position A", clearance], [{ x: -60, y: -120.5 }, "position B", clearance]]);
});

test("saving without a machine position reports an error and keeps the slot", () => {
  const dom = fakeDom();
  const messages = [];
  const saved = createSurfaceSavedPositions({ documentRef: dom, storage: memoryStorage(), getMachinePosition: () => null, setStatusMessage: (k, t, kind) => messages.push([t, kind]) });
  saved.bind((button, action) => { button.action = action; });
  dom.save.action();
  dom.slots[2].action();
  assert.deepEqual(messages.at(-1), ["Current machine position is unavailable.", "error"]);
  assert.equal(saved.positions().C, null);
});

test("Surface jog view lists the four saved position slots", () => {
  const html = readFileSync(join(here, "index.html"), "utf8");
  assert.deepEqual([...html.matchAll(/data-surface-position="([^"]+)"/g)].map((m) => m[1]), [...SAVED_POSITION_SLOTS]);
  assert.match(html, /id="surface-positions-save"/);
});

test("recall always uses both XY coordinates and can add saved Z alongside the Y retreat", () => {
  const dom = fakeDom();
  const storage = memoryStorage({ [SAVED_POSITIONS_KEY]: JSON.stringify({
    A: { x: -20, y: -150, z: -40, tool: 3 }, B: { x: -80 }, C: { x: -16, y: -8 }, D: { x: -30, y: -30, z: -10 },
  }) });
  const moves = [];
  const messages = [];
  let includeZ = false;
  let activeTool = 3;
  const saved = createSurfaceSavedPositions({
    documentRef: dom, storage,
    getRecallOptions: () => ({ includeZ, retractMM: 200 }),
    getActiveTool: () => activeTool,
    sendTapMove: (...args) => moves.push(args),
    setStatusMessage: (_, message) => messages.push(message),
  });
  saved.bind((button, action) => { button.action = action; });
  assert.equal(dom.slots[0].small.textContent, "X -20.0\nY -150.0");
  const clearance = { requireSafeZ: true, fastSafeZ: true, yRetractMM: 200 };
  dom.slots[0].action();
  dom.slots[1].action();
  assert.match(messages.at(-1), /Position B has no saved Y/);
  dom.slots[2].action();
  assert.deepEqual(moves, [[{ x: -20, y: -150 }, "position A", clearance], [{ x: -16, y: -8 }, "position C", clearance]]);

  includeZ = true;
  saved.render();
  assert.equal(dom.slots[0].small.textContent, "X -20.0\nY -150.0\nZ -40.0");
  dom.slots[0].action();
  assert.deepEqual(moves.at(-1), [{ x: -20, y: -150, z: -40 }, "position A", clearance]);
  dom.slots[2].action();
  assert.match(messages.at(-1), /Position C has no saved Z/);
  assert.equal(moves.length, 3);

  // Saved Z is a machine coordinate: never replay it with a different or unknown tool.
  activeTool = 5;
  dom.slots[0].action();
  assert.match(messages.at(-1), /Position A Z was saved with T3, but the machine reports T5/);
  activeTool = null;
  dom.slots[0].action();
  assert.match(messages.at(-1), /machine reports an unknown tool/);
  activeTool = 3;
  dom.slots[3].action();
  assert.match(messages.at(-1), /saved with an unrecorded tool/);
  assert.equal(moves.length, 3);
  includeZ = false;
  activeTool = 5;
  dom.slots[0].action();
  assert.deepEqual(moves.at(-1), [{ x: -20, y: -150 }, "position A", clearance]);
});
