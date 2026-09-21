import test from "node:test";
import assert from "node:assert/strict";
import {
  createLifecycleFeature,
  createNavigationFeature,
  viewTabFromURL,
  syncViewTabURL,
  FOREGROUND_PAGE_RELOAD_MS,
  PULL_TO_REFRESH_DISTANCE_PX,
} from "./modules/navigation.js";

test("URL navigation keeps canonical paths and phone fallback", () => {
  const desktop = { matchMedia: () => ({ matches: false }) };
  const phone = { matchMedia: () => ({ matches: true }) };
  assert.equal(viewTabFromURL({ pathname: "/files", search: "" }, { windowRef: desktop }), "files");
  assert.equal(viewTabFromURL({ pathname: "/", search: "?tab=dashboard" }, { windowRef: desktop }), "dashboard");
  assert.equal(viewTabFromURL({ pathname: "/unknown", search: "" }, { windowRef: desktop }), "active-job");
  assert.equal(viewTabFromURL({ pathname: "/unknown", search: "" }, { windowRef: phone }), "dashboard");

  const calls = [];
  const windowRef = {
    location: { href: "http://localhost/active-job?tab=active-job#old", pathname: "/active-job", search: "?tab=active-job" },
    history: { pushState: (...args) => calls.push(["push", ...args]), replaceState: (...args) => calls.push(["replace", ...args]) },
  };
  syncViewTabURL("files", "push", { windowRef });
  syncViewTabURL("dashboard", "replace", { windowRef });
  syncViewTabURL("files", "none", { windowRef });
  assert.deepEqual(calls, [
    ["push", { tab: "files" }, "", "/files"],
    ["replace", { tab: "dashboard" }, "", "/dashboard"],
  ]);
});

function navDocument() {
  const nodes = new Map();
  const make = (id) => ({ hidden: false, tabIndex: 0, dataset: {}, classList: { toggle() {} }, setAttribute() {}, contains() { return false; } });
  return {
    body: { dataset: {}, classList: { toggle() {} } },
    getElementById: (id) => { if (!nodes.has(id)) nodes.set(id, make(id)); return nodes.get(id); },
    querySelectorAll: () => [],
  };
}

test("showTab preserves operator handoff ordering and only invokes active feature renders", () => {
  const calls = [];
  const windowRef = {
    location: { href: "http://localhost/active-job", pathname: "/active-job", search: "" },
    history: { pushState: (...args) => calls.push(["history", ...args]) },
  };
  const feature = createNavigationFeature({
    documentRef: navDocument(), windowRef,
    getMachine: () => ({ state: "Idle" }), getSurface: () => ({}), setSurface: () => calls.push("surface"),
    isSurfaceKiosk: () => true,
    setActiveTab: (tab) => calls.push(["active", tab]),
    disarmMovementOnControlExit: (tab) => calls.push(["disarm", tab]),
    setDashboardControlsOpen: (open) => calls.push(["dashboard-controls", open]),
    connectFilesSSE: () => calls.push("files-sse"), renderActiveGcode: () => calls.push("active-render"),
    renderDashboard: () => calls.push("dashboard-render"), renderJog: () => calls.push("jog-render"),
    maintenanceLoad: () => calls.push("maintenance"), clearNotice: (key) => calls.push(["clear", key]),
    syncDashboardCameras: () => calls.push("cameras"),
  });
  feature.showTab("files");
  assert.deepEqual(calls.slice(0, 5), ["surface", ["disarm", "files"], ["active", "files"], ["dashboard-controls", false], "files-sse"]);
  assert.ok(calls.includes("files-sse"));
  assert.ok(calls.includes("clear", "jog-availability") || calls.some((call) => Array.isArray(call) && call[0] === "clear"));
});

test("foreground recovery reloads after suspension threshold and reconnects in the short path", () => {
  const calls = [];
  let hiddenAt = 1000;
  const feature = createLifecycleFeature({
    getPageHiddenAt: () => hiddenAt, setPageHiddenAt: (value) => { hiddenAt = value; }, now: () => 2000,
    reloadPage: () => calls.push("reload"), stopDashboardBuiltinCamera: () => calls.push("stop-built"), stopDashboardExternalCamera: () => calls.push("stop-ext"),
    resetEventStream: (key) => calls.push(["reset", key]), connectControlSSE: () => calls.push("control-sse"), filesIsLoaded: () => true, connectFilesSSE: () => calls.push("files-sse"),
    loadDashboardCameras: () => calls.push("cameras"), loadActiveGcode: () => calls.push("gcode"), loadAPICapabilities: () => calls.push("caps"), loadJogCapabilities: () => calls.push("jog-caps"), pollMachine: () => calls.push("poll"),
    getActiveTab: () => "maintenance", maintenanceLoad: () => calls.push("maintenance"),
  });
  assert.equal(feature.recoverForegroundSession(), false);
  assert.equal(hiddenAt, 0);
  assert.deepEqual(calls, ["stop-built", "stop-ext", ["reset", "controlES"], ["reset", "filesES"], "control-sse", "files-sse", "cameras", "gcode", "caps", "jog-caps", "poll", "maintenance"]);

  hiddenAt = 1000;
  const long = createLifecycleFeature({ getPageHiddenAt: () => hiddenAt, setPageHiddenAt: (value) => { hiddenAt = value; }, now: () => 1000 + FOREGROUND_PAGE_RELOAD_MS, reloadPage: () => calls.push("long-reload") });
  assert.equal(long.recoverForegroundSession(), true);
  assert.equal(calls.at(-1), "long-reload");
});

class FakeElement {
  constructor() { this.closest = () => null; }
}

test("pull to refresh triggers only after a vertical threshold and ignores controls", () => {
  const listeners = new Map();
  const classes = new Set();
  const documentRef = {
    hidden: false,
    body: { classList: { toggle: (name, on) => on ? classes.add(name) : classes.delete(name) } },
    documentElement: { style: { setProperty() {} } }, scrollingElement: { scrollTop: 0 },
    addEventListener: (name, handler) => listeners.set(name, handler),
  };
  const windowRef = { scrollY: 0, matchMedia: () => ({ matches: true }) };
  let reloads = 0;
  const feature = createLifecycleFeature({ documentRef, windowRef, ElementCtor: FakeElement, reloadPage: () => { reloads++; } });
  assert.equal(feature.installPullToRefresh(), true);
  const target = new FakeElement();
  listeners.get("touchstart")({ touches: [{ identifier: 1, clientX: 10, clientY: 10 }], target });
  const move = { touches: [{ identifier: 1, clientX: 12, clientY: 10 + PULL_TO_REFRESH_DISTANCE_PX }], preventDefault() { this.prevented = true; } };
  listeners.get("touchmove")(move);
  assert.equal(move.prevented, true);
  listeners.get("touchend")();
  assert.equal(reloads, 1);
  target.closest = () => ({ });
  listeners.get("touchstart")({ touches: [{ identifier: 2, clientX: 10, clientY: 10 }], target });
  listeners.get("touchmove")({ touches: [{ identifier: 2, clientX: 10, clientY: 10 + PULL_TO_REFRESH_DISTANCE_PX }], preventDefault() {} });
  listeners.get("touchend")();
  assert.equal(reloads, 1);
});
