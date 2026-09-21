import test from "node:test";
import assert from "node:assert/strict";
import { createActiveJobView } from "./modules/active-job-view.js";

function fakeDOM() {
  const nodes = new Map();
  const make = () => ({ hidden: false, disabled: false, value: "", textContent: "", attrs: new Map(), setAttribute(name, value) { this.attrs.set(name, value); } });
  for (const id of [
    "active-gcode-title", "active-gcode-meta", "active-gcode-run", "paused-job-controls", "paused-job-raise",
    "feed-override-controls", "feed-override-decrease", "feed-override-increase", "feed-override-reset", "feed-override-value",
  ]) nodes.set(id, make());
  const actions = make();
  const workspace = make();
  workspace.classList = { value: null, toggle(name, value) { this.value = [name, value]; } };
  return {
    nodes,
    documentRef: {
      getElementById: (id) => nodes.get(id) || null,
      querySelector: (selector) => selector === ".active-gcode-actions" ? actions : selector === ".active-gcode-workspace" ? workspace : null,
    },
    actions,
    workspace,
  };
}

test("active job view renders empty active job through explicit callbacks", () => {
  const dom = fakeDOM();
  const calls = [];
  const view = createActiveJobView({
    documentRef: dom.documentRef,
    getActiveGcode: () => ({ path: "", runnable: false }),
    getMachine: () => ({ state: "Idle" }),
    machineActionState: () => "Idle",
    ensureActiveGcodeGeometry: (value) => calls.push(["geometry", value]),
    ensureActiveGcodeSource: (value) => calls.push(["source", value]),
    drawGcodePreview: (value) => calls.push(["preview", value]),
    renderActiveJobProgress: (...args) => calls.push(["progress", ...args]),
    renderProgramToolLists: (...args) => calls.push(["tools", ...args]),
    renderDashboard: () => calls.push(["dashboard"]),
    renderJobControls: () => calls.push(["controls"]),
    setSoftDisabled: (node, value) => { node.softDisabled = value; },
  });

  view.renderActiveGcode();

  assert.equal(dom.nodes.get("active-gcode-title").textContent, "No active gcode selected.");
  assert.equal(dom.nodes.get("active-gcode-meta").textContent, "-");
  assert.equal(dom.nodes.get("active-gcode-run").softDisabled, true);
  assert.deepEqual(dom.workspace.classList.value, ["is-empty", true]);
  assert.deepEqual(calls.map(([name]) => name), ["controls", "geometry", "source", "preview", "progress", "tools", "dashboard"]);
});

test("active job view keeps feed controls busy and preserves pending value", () => {
  const dom = fakeDOM();
  const view = createActiveJobView({
    documentRef: dom.documentRef,
    getActiveGcode: () => ({ path: "/job.nc", runnable: true }),
    getMachine: () => ({ state: "Run", feed: { override: 100 } }),
    getActiveGcodePending: () => "feed_override",
    getFeedOverridePendingPercent: () => 125,
    machineActionState: () => "Run",
    externalJobInfo: () => null,
    activeGcodeDisplaySegments: () => [],
    renderActiveJobProgress: () => {},
    drawGcodePreview: () => {},
    renderDashboard: () => {},
    renderProgramToolLists: () => {},
    ensureActiveGcodeGeometry: () => {},
    ensureActiveGcodeSource: () => {},
    activeJobPreviewState: () => null,
    getFile: () => ({ size: 12, sync: "synced" }),
    relPath: (path) => path,
    fmtSize: (value) => `${value} B`,
    syncLabel: { synced: "Synced" },
    renderJobControls: () => {},
    setSoftDisabled: () => {},
  });

  view.renderActiveGcode();

  assert.equal(dom.nodes.get("feed-override-value").value, "125%");
  assert.equal(dom.nodes.get("feed-override-controls").attrs.get("aria-busy"), "true");
  assert.equal(dom.nodes.get("feed-override-decrease").disabled, true);
  assert.equal(dom.nodes.get("active-gcode-run").disabled, true);
  assert.equal(dom.actions.attrs.get("data-machine-state"), "Run");
});
