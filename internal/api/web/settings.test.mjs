import test from "node:test";
import assert from "node:assert/strict";
import {
  createSettingsFeature,
  MACHINE_SETTING_IDS,
  defaultGamepadSettings,
  defaultMachineSettings,
  normalizeGamepadSettings,
  normalizeMachineSettings,
  normalizeUISettings,
  machineLearnedSummaryLines,
} from "./modules/settings.js";

function element(value = "") {
  return {
    value: String(value), checked: false, disabled: false, dataset: {}, textContent: "",
    children: [], appendChild(child) { this.children.push(child); }, append(...children) { this.children.push(...children); },
    addEventListener() {}, setCustomValidity(message) { this.validationMessage = message; }, reportValidity() { return false; },
    contains() { return false; }, setAttribute(name, value) { this[name] = value; },
  };
}

function documentFixture() {
  const nodes = new Map();
  const get = (id) => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  return { activeElement: null, getElementById: get, createElement: () => element(), nodes };
}

test("machine normalization preserves firmware learned bounds and clamps tap feed", () => {
  const machine = normalizeMachineSettings({
    work_area: { x_min: -300, x_max: 0, y_min: -200, y_max: 0 },
    feed_min_mm_min: -20,
    feed_max_mm_min: 15000,
    tap_feed_mm_min: 9000,
    learned: {
      work_area: { x_min: -302, x_max: -1, y_min: -212, y_max: -1 },
      z_min_mm: -10,
      z_max_mm: 1,
      config_numbers: { "coordinate.clearance_z": -4 },
    },
  }, { newID: (prefix) => `${prefix}-test` });
  assert.deepEqual(machine.work_area, { x_min: -302, x_max: -1, y_min: -212, y_max: -1 });
  assert.equal(machine.feed_min_mm_min, 1);
  assert.equal(machine.feed_max_mm_min, 10000);
  assert.equal(machine.tap_feed_mm_min, 9000);
  assert.equal(machine.safe_z_mm, -4);
});

test("gamepad normalization filters duplicate and unknown macro bindings", () => {
  const normalized = normalizeGamepadSettings({
    axes: { x: { axis: 99, scale: 0 }, y: { invert: false } },
    deadman_button: 70,
    slow_buttons: [4, 4, -1, 5],
    outline_button: 7,
    macro_buttons: [
      { id: "one", button: 2, macro_id: "m2" },
      { id: "duplicate", button: 2, macro_id: "m1" },
      { id: "unknown", button: 3, macro_id: "missing" },
    ],
  }, new Set(["m1", "m2"]), (prefix) => `${prefix}-generated`);
  assert.equal(normalized.axes.x.axis, 31);
  assert.equal(normalized.axes.x.scale, 1);
  assert.equal(normalized.deadman_button, defaultGamepadSettings().deadman_button);
  assert.deepEqual(normalized.slow_buttons, [4, 5]);
  assert.deepEqual(normalized.macro_buttons, [{ id: "one", button: 2, macro_id: "m2" }]);
});

test("UI normalization keeps one macro placement and uses normalized machine/gamepad shapes", () => {
  const ui = normalizeUISettings({
    macros: [{ id: "m1", name: "Probe", lines: "G38.2 Z-5" }, { id: "m1", name: "duplicate" }],
    macro_buttons: [{ id: "s1", macro_id: "m1", region: "toolbar" }, { id: "s2", macro_id: "m1" }],
    gamepad: { macro_buttons: [{ button: 2, macro_id: "m1" }] },
    machine: { safe_z_disabled: true },
    log: { autoscroll: false },
    dashboard: { profiles: [] },
  }, { newID: (prefix) => `${prefix}-generated`, normalizeDashboardSettings: (settings) => settings });
  assert.equal(ui.macros.length, 1);
  assert.equal(ui.macro_buttons.length, 1);
  assert.equal(ui.macro_buttons[0].region, "toolbar");
  assert.equal(ui.gamepad.macro_buttons.length, 1);
  assert.equal(ui.machine.safe_z_disabled, true);
  assert.equal(ui.log.autoscroll, false);
});

test("settings renderer preserves focused local machine and gamepad drafts", () => {
  const documentRef = documentFixture();
  const ui = { macros: [{ id: "m1", name: "Probe" }], gamepad: defaultGamepadSettings(), machine: defaultMachineSettings() };
  const feature = createSettingsFeature({ documentRef, getUI: () => ui, setUI: (next) => Object.assign(ui, next), fmtCoord: (n) => Number(n).toFixed(1) });
  const machineMin = documentRef.getElementById("machine-x-min");
  machineMin.value = "draft";
  documentRef.activeElement = machineMin;
  feature.renderMachineSettings();
  assert.equal(machineMin.value, "draft");
  documentRef.activeElement = null;
  feature.renderMachineSettings();
  assert.equal(machineMin.value, String(ui.machine.work_area.x_min));

  const axis = documentRef.getElementById("gamepad-axis-x");
  axis.value = "draft-axis";
  documentRef.activeElement = axis;
  feature.renderGamepadSettings();
  assert.equal(axis.value, "draft-axis");
});

test("gamepad settings handler updates durable mapping through the save callback", () => {
  const documentRef = documentFixture();
  const ui = { macros: [{ id: "m1", name: "Probe" }], gamepad: defaultGamepadSettings(), machine: defaultMachineSettings() };
  let saves = 0;
  const feature = createSettingsFeature({ documentRef, getUI: () => ui, queueSaveUISettings: () => { saves++; }, getSelectedMacroId: () => "m1", newID: (prefix) => `${prefix}-new` });
  documentRef.getElementById("gamepad-axis-x").value = "2";
  documentRef.getElementById("gamepad-invert-x").checked = true;
  documentRef.getElementById("gamepad-speed-x").value = "50";
  feature.updateGamepadAxis("x");
  assert.deepEqual(ui.gamepad.axes.x, { axis: 2, invert: true, scale: 0.5 });
  feature.addGamepadMacroBinding();
  assert.deepEqual(ui.gamepad.macro_buttons, [{ id: "gamepad-macro-new", button: 1, macro_id: "m1" }]);
  assert.equal(saves, 2);
});

test("machine settings binder installs dirty drafts and shared onchange handler", () => {
  const nodes = new Map();
  for (const id of MACHINE_SETTING_IDS) {
    const node = element();
    node.listeners = [];
    node.addEventListener = (type, handler) => node.listeners.push([type, handler]);
    nodes.set(id, node);
  }
  const documentRef = { getElementById: (id) => nodes.get(id) || null };
  const feature = createSettingsFeature({ documentRef, getUI: () => ({ machine: defaultMachineSettings() }) });
  const updates = [];
  feature.bindMachineSettingsInteractions({ updateMachineSettings: () => updates.push("update") });

  for (const id of MACHINE_SETTING_IDS) {
    const node = nodes.get(id);
    assert.deepEqual(node.listeners.map(([type]) => type), ["input", "change"]);
    assert.equal(typeof node.listeners[0][1], "function");
    assert.equal(node.onchange instanceof Function, true);
    node.onchange();
  }
  assert.equal(updates.length, MACHINE_SETTING_IDS.length);
});

test("feed step binder preserves button values and zero fallback", () => {
  const buttons = [element(), element(), element()];
  buttons[0].dataset.feedStep = "500";
  buttons[1].dataset.feedStep = "-500";
  buttons[2].dataset.feedStep = "invalid";
  const documentRef = { querySelectorAll: (selector) => {
    assert.equal(selector, "[data-feed-step]");
    return buttons;
  }, getElementById: () => null };
  const feature = createSettingsFeature({ documentRef });
  const deltas = [];
  feature.bindFeedStepInteractions({ stepTapFeed: (delta) => deltas.push(delta) });
  assert.equal(buttons.every((button) => typeof button.onclick === "function"), true);
  buttons.forEach((button) => button.onclick());
  assert.deepEqual(deltas, [500, -500, 0]);
});

test("learned summary remains concise and data-derived", () => {
  const lines = machineLearnedSummaryLines({
    identity: { model: "Z1", version: "1.2", file_type: "gcode" },
    work_area: { x_min: -2, x_max: 3, y_min: -4, y_max: 5 },
    feed: { max_xy_mm_min: 1200 },
    config: { one: true }, diagnostics: { status: {} },
  }, { fmtCoord: (n) => Number(n).toFixed(1) });
  assert.deepEqual(lines, ["Z1 / 1.2 / gcode", "travel X -2.0..3.0  Y -4.0..5.0", "XY max feed 1200 mm/min", "1 config values, 1 diagnostic groups"]);
});
