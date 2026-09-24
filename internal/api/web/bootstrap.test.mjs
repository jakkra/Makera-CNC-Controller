import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMdiMacros } from "./modules/mdi-macros.js";
import { createOriginProbing } from "./modules/origin-probing.js";

test("production entrypoint links and composes once without starting resources before DOM readiness", () => {
  const entrypoint = new URL("./app.js", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
    import assert from "node:assert/strict";
    const events = [];
    globalThis.document = {
      addEventListener: (name, handler) => events.push({ name, handler }),
    };
    globalThis.window = {
      matchMedia: () => ({ matches: false }),
      location: { href: "http://localhost/active-job", pathname: "/active-job", search: "" },
    };
    if (!globalThis.navigator) globalThis.navigator = {};
    globalThis.localStorage = { getItem: () => null };
    globalThis.fetch = () => assert.fail("fetch before DOM readiness");
    globalThis.WebSocket = class { constructor() { assert.fail("WebSocket before DOM readiness"); } };
    globalThis.EventSource = class { constructor() { assert.fail("SSE before DOM readiness"); } };
    globalThis.setTimeout = () => assert.fail("timer before DOM readiness");
    globalThis.setInterval = () => assert.fail("polling before DOM readiness");
    await import(${JSON.stringify(entrypoint)});
    assert.equal(events.length, 1);
    assert.equal(events[0].name, "DOMContentLoaded");
    assert.equal(typeof events[0].handler, "function");
  `], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("production feature composition keeps settings persistence late-bound", () => {
  const elements = new Map();
  const element = (id) => elements.get(id) || elements.set(id, {
    id,
    value: "",
    innerHTML: "",
    dataset: {},
    style: {},
    disabled: false,
    appendChild() {},
    querySelector: () => null,
    setAttribute() {},
  }).get(id);
  const documentRef = {
    getElementById: (id) => element(id),
    querySelectorAll: () => [],
    createElement: () => ({
      dataset: {},
      style: {},
      appendChild() {},
      querySelector: () => ({ onclick: null }),
    }),
  };
  const ui = { macros: [], macro_buttons: [], gamepad: { macro_buttons: [] }, machine: { saved_origins: [] } };
  const machine = { connected: true, state: "Idle", stale: false };
  let queueSaveUISettings = () => {};
  let saves = 0;
  const lateBoundSaver = (...args) => queueSaveUISettings(...args);
  const mdi = createMdiMacros({
    documentRef,
    getUI: () => ui,
    newID: (prefix) => `${prefix}-1`,
    escapeHtml: (value) => value,
    bindButtonAction: () => {},
    clearControlDrafts: () => {},
    setControlValueIfIdle: () => {},
    setSoftDisabled: () => {},
    setNotice: () => {},
    clearNotice: () => {},
    queueSaveUISettings: lateBoundSaver,
    renderGamepadSettings: () => {},
    confirmRef: () => true,
    sendGcode: async () => true,
    rememberCommand: () => {},
    setStatusMessage: () => {},
  });
  const origin = createOriginProbing({
    documentRef,
    getMachine: () => machine,
    getUI: () => ui,
    getJog: () => ({}),
    queueSaveUISettings: lateBoundSaver,
    normalizeMachineSettings: (value) => ({ saved_origins: [], ...value }),
    defaultMachineSettings: () => ({ saved_origins: [] }),
    currentWorkOrigin: () => ({ x: 2, y: 3 }),
    axisValue: (value, axis) => Number.isFinite(Number(value?.[axis])) ? Number(value[axis]) : null,
    fmtCoord: (value) => String(value),
    finiteOr: (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback,
    newID: (prefix) => `${prefix}-1`,
    controlLocallyOwned: () => false,
    setSoftDisabled: () => {},
    setTextIfChanged: () => {},
    setElementBusy: () => {},
    setStatusMessage: () => {},
    setTapFeedback: () => {},
    renderMachineSettings: () => {},
    renderJog: () => {},
  });

  // Match the bootstrap order: both feature factories are created before the
  // UI-settings feature assigns the real saver.
  queueSaveUISettings = () => { saves++; };
  element("macro-name").value = "Probe";
  element("macro-lines").value = "G38.2 Z-2 F50";
  element("macro-placement").value = "panel";
  mdi.saveMacroFromForm();
  assert.ok(saves > 0, "saving a macro must call the real saver after construction");
  const savesAfterMacro = saves;
  element("saved-origin-label").value = "Fixture";
  origin.saveCurrentOrigin();

  assert.ok(saves > savesAfterMacro, "saving an origin must call the real saver after construction");
  const appSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "app.js"), "utf8");
  const mdiBlock = appSource.slice(appSource.indexOf("const mdiMacros"), appSource.indexOf("const toolActions"));
  const originBlock = appSource.slice(appSource.indexOf("const originProbing"), appSource.indexOf("const dashboardCamera"));
  const lateBoundPattern = /queueSaveUISettings:\s*\(\.\.\.args\) => queueSaveUISettings\(\.\.\.args\)/;
  assert.match(mdiBlock, lateBoundPattern);
  assert.match(originBlock, lateBoundPattern);
});
