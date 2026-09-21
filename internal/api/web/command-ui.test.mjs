import test from "node:test";
import assert from "node:assert/strict";
import { closeCommandPopout, commandPanelPlacement, commandPopoutSummary, createCommandUI } from "./modules/command-ui.js";

function fakeNode({ tagName = "DIV", children = [], hidden = false } = {}) {
  const listeners = new Map();
  const attrs = new Map();
  const classes = new Set();
  const node = {
    tagName,
    children,
    hidden,
    open: false,
    title: "",
    dataset: {},
    scrollTop: 10,
    attrs,
    classList: {
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
    addEventListener(type, handler) { listeners.set(type, handler); },
    dispatch(type, event = {}) { listeners.get(type)?.(event); },
    setAttribute(name, value) { attrs.set(name, value); },
    contains(target) { return target === node || children.includes(target); },
    closest(selector) { return selector === ".command-popout" && node.closestCommandPopout ? node : null; },
    querySelector(selector) { return selector === ".workarea-actions-close" ? node.closeButton || null : null; },
    focus() { node.focused = true; },
  };
  return node;
}

function fakeDocument(nodes) {
  const listeners = new Map();
  return {
    documentElement: { clientWidth: 1024, clientHeight: 768 },
    getElementById(id) { return nodes[id] || null; },
    querySelectorAll(selector) { return selector === ".command-popout" ? nodes.popouts || [] : []; },
    addEventListener(type, handler) { listeners.set(type, handler); },
    dispatch(type, event = {}) { listeners.get(type)?.(event); },
  };
}

test("command panel placement preserves above/below and narrow viewport rules", () => {
  assert.deepEqual(
    commandPanelPlacement({ left: 100, width: 80, top: 100, bottom: 132 }, 440, 1200, 800),
    { top: 140, left: 12, width: 440, maxHeight: 648, arrowLeft: 123, placement: "below" },
  );
  assert.equal(commandPanelPlacement({ left: 100, width: 80, top: 260, bottom: 292 }, 440, 1200, 360).placement, "above");
  assert.equal(commandPanelPlacement({ left: 50, width: 40, top: 80, bottom: 112 }, 440, 240, 480).width, 216);
});

test("command UI preserves menu state, outside dismissal, Escape focus, and work-area restore", () => {
  const dashboardButton = fakeNode();
  const dashboardPanel = fakeNode({ hidden: true });
  const workareaButton = fakeNode();
  const workareaPanel = fakeNode();
  const close = fakeNode();
  workareaPanel.closeButton = close;
  const doc = fakeDocument({
    "dashboard-controls-toggle": dashboardButton,
    "dashboard-toolbar": dashboardPanel,
    "workarea-actions-toggle": workareaButton,
    "workarea-actions-panel": workareaPanel,
  });
  const windowRef = { innerWidth: 500, addEventListener() {} };
  const feature = createCommandUI({ documentRef: doc, windowRef });

  feature.setDashboardControlsOpen(true);
  assert.equal(dashboardPanel.hidden, false);
  assert.equal(dashboardButton.attrs.get("aria-expanded"), "true");
  feature.setDashboardControlsOpen(false, true);
  assert.equal(dashboardPanel.hidden, true);
  assert.equal(dashboardButton.focused, true);

  feature.initDashboardControlsMenu();
  dashboardButton.onclick();
  assert.equal(dashboardPanel.hidden, false);
  doc.dispatch("keydown", { key: "Escape", preventDefault() {} });
  assert.equal(dashboardPanel.hidden, true);
  assert.equal(dashboardButton.focused, true);

  feature.setWorkAreaActionsOpen(true);
  feature.initWorkAreaActionsMenu();
  close.onclick();
  assert.equal(workareaPanel.classList.contains("is-open"), false);
  assert.equal(workareaButton.focused, true);
});

test("closing a command popout only restores focus for explicit dismissal", () => {
  const summary = fakeNode({ tagName: "SUMMARY" });
  const popout = fakeNode({ children: [summary] });
  popout.open = true;
  assert.equal(commandPopoutSummary(popout), summary);
  closeCommandPopout(popout);
  assert.equal(popout.open, false);
  assert.equal(summary.focused, true);
  popout.open = true;
  summary.focused = false;
  closeCommandPopout(popout, false);
  assert.equal(summary.focused, false);
});
