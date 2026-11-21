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

test("saved positions normalize to four XY slots and survive bad storage", () => {
  assert.deepEqual(normalizeSavedPositions({ A: { x: "1", y: 2, z: 9 }, B: { x: NaN, y: 1 }, Z: { x: 1, y: 1 } }),
    { A: { x: 1, y: 2 }, B: null, C: null, D: null });
  assert.deepEqual(loadSavedPositions(memoryStorage({ [SAVED_POSITIONS_KEY]: "{oops" })), { A: null, B: null, C: null, D: null });
  assert.deepEqual(loadSavedPositions({ getItem() { throw new Error("blocked"); } }), { A: null, B: null, C: null, D: null });
});

test("saving stores the current machine XY and going to a slot sends a tap move", () => {
  const dom = fakeDom();
  const storage = memoryStorage();
  const moves = [];
  const messages = [];
  let mpos = { x: -150.25, y: -120.5, z: -40 };
  const saved = createSurfaceSavedPositions({
    documentRef: dom, storage,
    getMachinePosition: () => mpos,
    sendTapMove: (target, label) => moves.push([target, label]),
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
  assert.deepEqual(saved.positions().A, { x: -150.25, y: -120.5 });
  assert.deepEqual(JSON.parse(storage.data[SAVED_POSITIONS_KEY]).A, { x: -150.25, y: -120.5 });
  assert.equal(messages.at(-1)[1], "Saved position A at X -150.3 Y -120.5.");
  assert.equal(dom.slots[0].small.textContent, "X -150.3\nY -120.5");

  mpos = { x: -60, y: -120.5 };
  dom.save.action();
  dom.slots[1].action();
  dom.slots[0].action();
  dom.slots[1].action();
  assert.deepEqual(moves, [[{ x: -150.25, y: -120.5 }, "position A"], [{ x: -60, y: -120.5 }, "position B"]]);
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
