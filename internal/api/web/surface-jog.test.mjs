import test from "node:test";
import assert from "node:assert/strict";
import {
  SURFACE_VIEW_PREFERENCES_KEY,
  defaultSurfaceViewPreferences,
  isSurfaceKiosk,
  loadSurfaceViewPreferences,
  saveSurfaceViewPreferences,
  createSurfaceJogFeature,
  surfaceJogOptionsSummary,
  surfaceQuickActionState,
  surfaceStepDistance,
  surfaceStepUnit,
} from "./modules/surface-jog.js";

test("Surface preferences keep the established defaults and reject invalid persisted values", () => {
  assert.deepEqual(defaultSurfaceViewPreferences(), {
    auto_switch: true,
    start_view: "jog",
    method: "directional",
    motion: "step",
    step_mm: 1,
    mpg_axis: "x",
    mpg_feedback: "confirmed",
    position_space: "work",
  });
  const storage = { getItem: () => JSON.stringify({ auto_switch: false, start_view: "bad", method: "bad", motion: "bad", step_mm: 7, mpg_axis: "bad", mpg_feedback: "bad", position_space: "bad" }) };
  assert.deepEqual(loadSurfaceViewPreferences({ storage }), { ...defaultSurfaceViewPreferences(), auto_switch: false });
});

test("Surface preferences persist under the stable per-device key", () => {
  let saved = null;
  const storage = { setItem: (key, value) => { saved = { key, value }; } };
  const surface = { method: "mpg", step_mm: 0.1 };
  saveSurfaceViewPreferences(surface, { storage });
  assert.equal(saved.key, SURFACE_VIEW_PREFERENCES_KEY);
  assert.deepEqual(JSON.parse(saved.value), surface);
});

test("restricted storage never blocks Surface startup or preference changes", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() { throw new Error("storage denied"); },
  });
  try {
    assert.deepEqual(loadSurfaceViewPreferences(), defaultSurfaceViewPreferences());
    assert.doesNotThrow(() => saveSurfaceViewPreferences({ method: "mpg" }));
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  }
});

test("Surface step labels, summaries, kiosk detection, and quick actions retain operator semantics", () => {
  assert.equal(surfaceStepDistance({ step_mm: 0.1 }), 0.1);
  assert.equal(surfaceStepDistance({ step_mm: 99 }), 1);
  assert.equal(surfaceStepUnit("a"), "°");
  assert.equal(surfaceStepUnit("x"), "mm");
  assert.equal(surfaceJogOptionsSummary({ motion: "hold", step_mm: 0.1, method: "mpg" }), "Hold · 0.1 mm/° · MPG");
  assert.deepEqual(surfaceQuickActionState("Idle"), { setup: true, hold: false, resume: false, details: false });
  assert.deepEqual(surfaceQuickActionState("Pause"), { setup: false, hold: false, resume: true, details: true });
  assert.equal(isSurfaceKiosk({ matchMedia: () => ({ matches: true }) }), true);
  assert.equal(isSurfaceKiosk({ matchMedia: () => ({ matches: false }) }), false);
});

test("Surface rendering preserves focused drafts and exposes pending motion", () => {
  const focusedStep = { value: "0.1", classList: { toggle() {} }, setAttribute() {}, toggleAttribute() {}, style: { setProperty() {} } };
  const stepButton = { dataset: { surfaceStep: "1" }, disabled: false, setAttribute(name, value) { this[name] = value; }, classList: { toggle() {} }, style: { setProperty() {} } };
  const axisButton = { dataset: { surfaceAxis: "x" }, disabled: false, setAttribute(name, value) { this[name] = value; }, classList: { toggle() {} }, style: { setProperty() {} } };
  const ids = new Map([
    ["surface-jog-step", focusedStep],
    ["surface-jog-arm", { classList: { toggle() {} }, setAttribute() {}, disabled: false }],
    ["surface-mpg-wheel", { classList: { toggle() {} }, setAttribute() {}, style: { setProperty() {} } }],
    ["surface-mpg-wheel-step", { textContent: "" }],
  ]);
  const documentRef = {
    activeElement: focusedStep,
    getElementById(id) { return ids.get(id) || null; },
    querySelectorAll(selector) {
      if (selector === "[data-surface-step]") return [stepButton];
      if (selector.includes("[data-surface-axis]")) return [axisButton];
      return [];
    },
  };
  const state = {
    activeTab: "jog",
    readOnly: false,
    controlPendingAction: "",
    activeGcodePending: "",
    autoVacuumPending: false,
    machine: { connected: true, state: "Idle", spindle: {} },
    surface: { method: "directional", motion: "step", step_mm: 1, mpg_axis: "x", mpg_feedback: "confirmed", auto_switch: true, start_view: "jog" },
    jog: { caps: { enabled: true }, link: "online", armed: true, surfaceStepPending: 7, surfaceStepSource: "button", zStepPending: 0, surfaceWheel: { pointerId: null, value: 0, angle: 0 } },
  };
  const feature = createSurfaceJogFeature({
    stateFacade: state,
    documentRef,
    getMachineActionState: () => "Idle",
    getMovementArmAvailable: () => true,
    getMovementArmLabel: () => "Disarm Movement",
    renderMachineReadouts: () => {},
    renderJog: () => {},
    stopSurfaceHoldJog: () => {},
    setTextIfChanged(node, value) { if (node) node.textContent = value; },
    setSoftDisabled(node, value) { node.ariaDisabled = value ? "true" : undefined; },
  });
  feature.renderSurfaceJog();
  assert.equal(focusedStep.value, "0.1", "live rendering must not overwrite an active local draft");
  assert.equal(axisButton.disabled, true, "a pending step keeps neighboring motion controls disabled");
  state.jog.surfaceStepPending = 0;
  state.jog.surfaceStepSource = "";
  feature.renderSurfaceJog();
  assert.equal(axisButton.disabled, false);
});
