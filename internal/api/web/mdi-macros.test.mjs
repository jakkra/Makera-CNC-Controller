import test from "node:test";
import assert from "node:assert/strict";
import { createMdiMacros } from "./modules/mdi-macros.js";

test("macro placement and command submission use explicit state callbacks", async () => {
  const ui = { macros: [{ id: "m1", name: "Probe", description: "", color: "", lines: ["G38.2 Z-2 F50"], created_at: "", updated_at: "" }], macro_buttons: [], gamepad: { macro_buttons: [] } };
  let selected = "m1"; let pending = false; const sent = [];
  const documentRef = { getElementById: () => ({ innerHTML: "", appendChild() {}, querySelector: () => ({ onclick: null }), style: {}, dataset: {} }), createElement: () => ({ style: {}, appendChild() {}, querySelector: () => ({ onclick: null }) }) };
  const mdi = createMdiMacros({ getUI: () => ui, newID: (prefix) => `${prefix}-1`, getSelectedMacroId: () => selected, setSelectedMacroId: (v) => { selected = v; }, getMacroRunning: () => false, setMacroRunning: () => {}, escapeHtml: (v) => v, bindButtonAction: () => {}, clearControlDrafts: () => {}, setControlValueIfIdle: () => {}, setSoftDisabled: () => {}, setNotice: () => {}, clearNotice: () => {}, queueSaveUISettings: () => {}, renderGamepadSettings: () => {}, sendGcode: async (line) => { sent.push(line); return true; }, rememberCommand: () => {}, setStatusMessage: () => {}, documentRef });
  mdi.setMacroPlacement("m1", "panel");
  assert.equal(ui.macro_buttons[0].region, "panel");
  await mdi.runMacro(ui.macros[0]);
  assert.deepEqual(sent, ["G38.2 Z-2 F50"]);
  assert.equal(pending, false);
});

test("manual command submission preserves pending guard and feedback callbacks", async () => {
  const messages = []; let pending = false; const sent = [];
  const mdi = createMdiMacros({ documentRef: { getElementById: () => null }, getUI: () => ({ macros: [], macro_buttons: [] }), rememberCommand: () => {}, setStatusMessage: (...args) => messages.push(args), sendGcode: async (line) => { sent.push(line); return true; } });
  const result = await mdi.submitGcode("  M114  ", { getPending: () => pending, setPending: (v) => { pending = v; }, render: () => {} });
  assert.equal(result, true); assert.deepEqual(sent, ["M114"]); assert.equal(pending, false); assert.equal(messages.length, 2);
});

test("manual command binder preserves submit trimming, reset, and keyboard history behavior", async () => {
  const form = { onsubmit: null };
  const input = { value: "  G0 X1  ", onkeydown: null, setSelectionRange() {} };
  const nodes = new Map([["gcode-form", form], ["gcode-input", input]]);
  let historyIndex = 3;
  const submitted = [];
  const navigated = [];
  const mdi = createMdiMacros({
    documentRef: { getElementById: (id) => nodes.get(id) || null },
    getUI: () => ({ macros: [], macro_buttons: [] }),
    getHistoryIndex: () => historyIndex,
    setHistoryIndex: (value) => { historyIndex = value; },
  });
  mdi.bindCommandInteractions({
    submitGcode: (line) => { submitted.push(line); },
    navigateCommandHistory: (element, direction) => navigated.push([element, direction]),
  });

  let prevented = 0;
  form.onsubmit({ preventDefault: () => { prevented++; } });
  assert.equal(prevented, 1);
  assert.equal(input.value, "");
  assert.deepEqual(submitted, ["G0 X1"]);

  input.onkeydown({ key: "ArrowUp", preventDefault: () => { prevented++; } });
  input.onkeydown({ key: "ArrowDown", preventDefault: () => { prevented++; } });
  assert.deepEqual(navigated, [[input, -1], [input, 1]]);
  assert.equal(prevented, 3);

  historyIndex = 2;
  input.onkeydown({ key: "M", preventDefault: () => { throw new Error("typing must not prevent default"); } });
  assert.equal(historyIndex, -1);

  input.value = "   ";
  form.onsubmit({ preventDefault: () => { prevented++; } });
  assert.equal(input.value, "   ");
  assert.deepEqual(submitted, ["G0 X1"]);
});
