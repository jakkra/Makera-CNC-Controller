import test from "node:test";
import assert from "node:assert/strict";
import { createOriginProbing } from "./modules/origin-probing.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const originProbingModuleSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "modules/origin-probing.js"), "utf8");

const origin = createOriginProbing({ documentRef: { getElementById: () => null, querySelectorAll: () => [] }, getMachine: () => ({ state: "Idle", connected: true }), getUI: () => ({ machine: { learned: {} } }), getJog: () => ({}) });

test("3D probe rules and positioning preserve controller geometry", () => {
  assert.deepEqual(origin.probe3DFieldRules("bore_pocket_x"), { x: true, y: false, z: false, note: "Move the 3D Probe inside the bore or pocket with its contact point below the top surface, and make sure the probe is stable." });
  assert.deepEqual(origin.probe3DInitialPositioning("outside_top_left", 20, 10), { x: -20, y: 10 });
  assert.equal(origin.formatOriginValue(1.25), "1.25");
});

test("3D probe preflight reports learned soft-limit violations", () => {
  const result = origin.probe3DTravelPreflight("outside_top_right", 20, 5, { x: 95, y: 0 }, { x: { min: 0, max: 100 }, y: { min: -20, max: 20 } });
  assert.equal(result.blocked, true);
  assert.match(result.warning, /Soft-limit risk/);
});

test("origin probing interactions bind only on demand and preserve registration and Enter behavior", () => {
  const ids = ["origin-probe-z", "origin-probe-3d", "probe-3d-close", "probe-3d-cancel", "probe-3d-run", "probe-3d-kind", "probe-3d-x", "probe-3d-y", "probe-3d-z", "probe-3d-diameter", "probe-3d-x-field", "probe-3d-y-field", "probe-3d-z-field", "probe-3d-note", "probe-3d-preflight", "probe-3d-modal", "origin-set-xyz-open", "origin-set-open", "origin-presets-open", "origin-xyz-close", "origin-set-close", "origin-presets-close", "origin-xyz-x", "origin-xyz-y", "origin-xyz-z", "origin-set-source", "origin-set-x", "origin-set-y", "saved-origin-select", "origin-xyz-apply", "origin-set-apply", "saved-origin-recall", "saved-origin-save", "saved-origin-delete"];
  const nodes = new Map(ids.map((id) => [id, {
    id, value: "", disabled: false, open: false, focused: false, showCount: 0, closeCount: 0,
    classList: { toggle() {} }, setAttribute() {}, addEventListener(type, callback) { this["on" + type] = callback; },
    showModal() { this.open = true; this.showCount++; }, close() { this.open = false; this.closeCount++; }, focus() { this.focused = true; },
  }]));
  nodes.get("probe-3d-kind").value = "outside_top_left";
  nodes.get("origin-xyz-x").value = "not-a-number";
  nodes.get("origin-set-x").value = "not-a-number";
  nodes.get("origin-set-y").value = "2";
  const registrations = [];
  const messages = [];
  let formRenders = 0;
  const feature = createOriginProbing({
    documentRef: { getElementById: (id) => nodes.get(id) || null, querySelectorAll: () => [] },
    getMachine: () => ({ connected: true, state: "Idle", stale: false }),
    getUI: () => ({ machine: { learned: {} } }),
    getJog: () => ({}),
    renderJog: () => {},
    finiteOr: (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback,
    isProbeToolActive: () => true, is3DProbeToolActive: () => true,
    setTextIfChanged: () => { formRenders++; },
    setElementBusy: () => {}, setSoftDisabled: () => {},
    setStatusMessage: (...args) => messages.push(args),
  });
  assert.equal(registrations.length, 0);
  assert.equal(formRenders, 0, "form setup is deferred until init calls the binder");
  feature.bindInteractions({ bindButtonAction: (node, action) => registrations.push([node.id, action]) });
  assert.deepEqual(registrations.map(([id]) => id), [
    "origin-probe-z", "origin-probe-3d", "probe-3d-close", "probe-3d-cancel", "probe-3d-run",
    "origin-set-xyz-open", "origin-set-open", "origin-presets-open", "origin-xyz-close", "origin-set-close", "origin-presets-close",
    "origin-xyz-apply", "origin-set-apply", "saved-origin-recall", "saved-origin-save", "saved-origin-delete",
  ]);
  assert.ok(formRenders > 0, "3D probe form renders at the original setup point");
  assert.equal(nodes.get("probe-3d-kind").onchange, feature.renderProbe3DForm);
  for (const id of ["probe-3d-x", "probe-3d-y", "probe-3d-z", "probe-3d-diameter"]) assert.equal(nodes.get(id).oninput, feature.renderProbe3DForm);
  let prevented = 0;
  nodes.get("origin-xyz-x").onkeydown({ key: "Enter", preventDefault() { prevented++; } });
  nodes.get("origin-set-x").onkeydown({ key: "Enter", preventDefault() { prevented++; } });
  nodes.get("origin-xyz-x").onkeydown({ key: "x", preventDefault() { prevented += 100; } });
  assert.equal(prevented, 2);
  assert.deepEqual(messages.map((message) => message[1]), ["X value must be finite.", "Origin coordinates must be finite."]);
  const open3D = registrations.find(([id]) => id === "origin-probe-3d")[1];
  open3D();
  assert.equal(nodes.get("probe-3d-modal").showCount, 1);
  assert.equal(nodes.get("probe-3d-kind").focused, true);
  nodes.get("probe-3d-modal").oncancel({ preventDefault() { prevented++; } });
  assert.equal(prevented, 3);
  assert.equal(nodes.get("probe-3d-modal").closeCount, 1);
  assert.match(originProbingModuleSource, /function bindInteractions\(/);
});
