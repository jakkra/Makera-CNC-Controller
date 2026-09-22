import test from "node:test";
import assert from "node:assert/strict";
import { createDashboardView } from "./modules/dashboard-view.js";

function dashboardDocument() {
  const elements = new Map();
  const dashboardJob = { classList: { values: new Map(), toggle(name, value) { this.values.set(name, value); } } };
  const fallback = { classList: { values: new Map(), toggle(name, value) { this.values.set(name, value); } } };
  for (const [id, element] of [
    ["dashboard-state", { textContent: "", className: "" }],
    ["dashboard-job-title", { textContent: "" }],
    ["dashboard-progress-bar", { value: -1 }],
    ["dashboard-progress-label", { textContent: "" }],
    ["dashboard-elapsed", { textContent: "" }],
    ["dashboard-remaining", { textContent: "" }],
  ]) elements.set(id, element);
  return {
    dashboardJob,
    fallback,
    documentRef: {
      getElementById(id) { return id === "dashboard-toolpath-fallback" ? fallback : elements.get(id) || null; },
      querySelector(selector) { return selector === ".dashboard-job" ? dashboardJob : null; },
    },
    elements,
  };
}

test("dashboard view renders active job state and delegates dashboard surfaces", () => {
  const dom = dashboardDocument();
  const calls = [];
  const view = createDashboardView({
    documentRef: dom.documentRef,
    getMachine: () => ({ state: "Run" }),
    getActiveGcode: () => ({ path: "/sd/gcodes/job.nc", preview: { line_count: 12, bounds: {} } }),
    externalJobInfo: () => null,
    activeGcodeDisplaySegments: () => [{ x: 1 }],
    activeJobPreviewState: () => ({ percent: 25, playedLines: 3, elapsedMs: 2000, remainingMs: 6000 }),
    renderMachineReadouts: (machine) => calls.push(["readouts", machine.state]),
    renderDashboardTelemetry: (machine) => calls.push(["telemetry", machine.state]),
    renderDashboardGcodeStream: (live) => calls.push(["stream", live.percent]),
    drawDashboardGcodePreview: (preview, live) => calls.push(["preview", preview.segments.length, live.percent]),
    relPath: (path) => path.replace("/sd/gcodes/", ""),
    fmtDuration: (ms) => `${ms}ms`,
  });

  view.renderDashboard();

  assert.equal(dom.elements.get("dashboard-state").textContent, "Running");
  assert.equal(dom.elements.get("dashboard-state").className, "badge state-Run");
  assert.equal(dom.elements.get("dashboard-job-title").textContent, "job.nc");
  assert.equal(dom.elements.get("dashboard-progress-bar").value, 25);
  assert.equal(dom.elements.get("dashboard-progress-label").textContent, "25% · line 3 / 12");
  assert.equal(dom.elements.get("dashboard-elapsed").textContent, "2000ms");
  assert.equal(dom.elements.get("dashboard-remaining").textContent, "6000ms");
  assert.deepEqual(calls, [["readouts", "Run"], ["telemetry", "Run"], ["stream", 25], ["preview", 1, 25]]);
  assert.equal(dom.dashboardJob.classList.values.get("is-empty"), false);
  assert.equal(dom.fallback.classList.values.get("has-toolpath"), true);
});

test("dashboard view preserves external-job and empty preview presentation", () => {
  const dom = dashboardDocument();
  const calls = [];
  const view = createDashboardView({
    documentRef: dom.documentRef,
    getMachine: () => ({ state: "Idle" }),
    getActiveGcode: () => ({}),
    externalJobInfo: () => ({ title: "remote.nc", progressText: "External progress", observedText: "Observed" }),
    renderDashboardGcodeStream: (live) => calls.push(["stream", live]),
    drawDashboardGcodePreview: (preview, live) => calls.push(["preview", preview.segments.length, live]),
  });

  view.renderDashboard();

  assert.equal(dom.elements.get("dashboard-state").textContent, "Ready");
  assert.equal(dom.elements.get("dashboard-job-title").textContent, "External job · Idle");
  assert.equal(dom.elements.get("dashboard-progress-bar").value, 0);
  assert.equal(dom.elements.get("dashboard-progress-label").textContent, "External progress");
  assert.equal(dom.elements.get("dashboard-elapsed").textContent, "Observed");
  assert.equal(dom.elements.get("dashboard-remaining").textContent, "-");
  assert.deepEqual(calls, [["stream", null], ["preview", 0, null]]);
  assert.equal(dom.dashboardJob.classList.values.get("is-empty"), true);
  assert.equal(dom.fallback.classList.values.get("has-toolpath"), false);
});

test("dashboard toolpath fallback opens Active Job from click and keyboard", () => {
  const dom = dashboardDocument();
  const listeners = new Map();
  dom.fallback.addEventListener = (type, handler) => listeners.set(type, handler);
  const tabs = [];
  const view = createDashboardView({ documentRef: dom.documentRef });

  view.bindInteractions({ showTab: (tab) => tabs.push(tab) });
  listeners.get("click")();
  const ignored = { key: "Escape", prevented: false, preventDefault() { this.prevented = true; } };
  listeners.get("keydown")(ignored);
  const enter = { key: "Enter", prevented: false, preventDefault() { this.prevented = true; } };
  listeners.get("keydown")(enter);
  const space = { key: " ", prevented: false, preventDefault() { this.prevented = true; } };
  listeners.get("keydown")(space);

  assert.deepEqual(tabs, ["active-job", "active-job", "active-job"]);
  assert.equal(ignored.prevented, false);
  assert.equal(enter.prevented, true);
  assert.equal(space.prevented, true);
});
