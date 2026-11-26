import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createEdgeProbing, measuredEdgeAngle } from "./modules/probe-edge.js";
import { createSurfaceRouting } from "./modules/surface-routing.js";

test("edge angle uses signed machine-axis drift regardless of touch order", () => {
  const a = { x: 0, y: -11 };
  const b = { x: 100, y: -10.75 };
  const measured = measuredEdgeAngle(a, b, "y");
  assert.equal(measured.baselineMM, 100);
  assert.equal(measured.driftMM, 0.25);
  assert.equal(measured.angleDegrees.toFixed(3), "0.143");
  assert.deepEqual(measuredEdgeAngle(b, a, "y"), measured);
  assert.equal(measuredEdgeAngle({ x: -11, y: 0 }, { x: -10.75, y: 100 }, "x").angleDegrees.toFixed(3), "-0.143");
  assert.equal(measuredEdgeAngle(a, { x: 0, y: -10 }, "y"), null);
});

test("measure angle captures two verified contacts with a manual move between them and draws the edge", async () => {
  const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const ids = ["origin-probe-edge", "origin-probe-angle", "probe-edge-modal", "probe-edge-close",
    "probe-edge-title", "probe-edge-placement", "probe-edge-result", "probe-edge-run",
    "probe-edge-reset", "probe-edge-direction", "probe-edge-travel", "probe-edge-tip", "workarea-probed-edge"];
  function element(id) {
    return {
      id, disabled: false, open: false, attrs: {},
      setAttribute(name, value) { this.attrs[name] = String(value); },
      removeAttribute(name) { delete this.attrs[name]; },
      addEventListener(type, action) { this[type] = action; },
      showModal() { this.open = true; }, close() { this.open = false; },
      reportValidity() { return true; },
    };
  }
  const nodes = new Map(ids.map((id) => {
    assert.ok(html.includes(`id="${id}"`));
    return [id, element(id)];
  }));
  const get = (id) => nodes.get(id);
  get("probe-edge-direction").value = "y-";
  get("probe-edge-travel").valueAsNumber = 10;
  get("probe-edge-tip").valueAsNumber = 2;
  const line = element("line");
  const circles = [element("circle"), element("circle")];
  const group = get("workarea-probed-edge");
  group.querySelector = () => line;
  group.querySelectorAll = () => circles;
  const jog = {};
  const machine = { tool: { active: 9999 } };
  const replies = [{ x: 0, y: -11 }, { x: 0, y: -10.75 }, { x: 100, y: -10.75 }];
  const messages = [];
  const requests = [];
  let finishResponse;
  const feature = createEdgeProbing({
    document: { getElementById: get },
    getMachine: () => machine, getJog: () => jog, machineReady: () => true, hasOtherMotion: () => false,
    request: (path, options) => {
      requests.push([path, JSON.parse(options.body)]);
      return new Promise((resolve) => {
        finishResponse = () => {
          const point = replies.shift();
          resolve({ json: async () => ({ axis: "y", machine_edge_mm: point.y, machine_point: point }) });
        };
      });
    },
    setStatusMessage: (key, text, kind) => messages.push([key, text, kind]),
    renderJog: () => {},
    renderWorkArea: () => feature.renderMap((point) => ({ x: point.x / 2, y: -point.y })),
    pollMachine: () => {},
  });
  feature.bind((node, action) => { node.click = action; });
  const dialog = get("probe-edge-modal");
  const run = get("probe-edge-run");
  get("origin-probe-angle").click();
  assert.equal(run.textContent, "Probe point 1");
  const first = run.click();
  assert.equal(jog.zProbePending, true);
  assert.equal(run.disabled, true);
  assert.equal(run.attrs["aria-busy"], "true");
  get("probe-edge-close").click();
  assert.equal(dialog.open, true);
  finishResponse();
  await first;
  assert.equal(jog.zProbePending, false);
  assert.equal(dialog.open, false);
  assert.match(messages.at(-1)[1], /Jog along X to point 2/);
  assert.equal(line.attrs.display, "none");
  assert.equal(circles[0].attrs.cy, "11");

  machine.tool.active = 999990;
  get("origin-probe-angle").click();
  assert.equal(run.textContent, "Probe point 2");
  assert.equal(get("probe-edge-direction").disabled, true);
  const duplicate = run.click();
  finishResponse();
  await duplicate;
  assert.equal(dialog.open, true);
  assert.match(messages.at(-1)[1], /different point/);
  assert.equal(line.attrs.display, "none");
  const second = run.click();
  finishResponse();
  await second;
  assert.equal(dialog.open, false);
  assert.deepEqual(messages.at(-1), ["origin-action", "0.143° from X · 0.250 mm drift over 100.000 mm", "ok"]);
  assert.deepEqual(line.attrs, { display: "inline", x1: "0", y1: "11", x2: "50", y2: "10.75" });
  assert.deepEqual(requests, Array(3).fill(["/api/probe/edge", { axis: "y", direction: -1, travel_mm: 10, tip_diameter_mm: 2 }]));
  get("origin-probe-angle").click();
  assert.equal(run.disabled, true);
  assert.match(get("probe-edge-result").textContent, /0.143°/);
  get("probe-edge-reset").click();
  assert.equal(run.textContent, "Probe point 1");
  assert.equal(run.disabled, false);
  assert.equal(group.attrs.display, "none");
});

test("a Control probe stays visible through motion and yields to an alarm", () => {
  const state = { activeTab: "control", surface: { auto_switch: true, start_view: "jog" },
    machine: { state: "Run" }, jog: { zProbePending: true } };
  const tabs = [];
  const routing = createSurfaceRouting({ getState: () => state, isSurfaceKiosk: () => true, showTab: (tab) => tabs.push(tab) });
  routing.applySurfaceAutomaticView();
  state.machine.state = "Idle";
  routing.applySurfaceAutomaticView();
  assert.deepEqual(tabs, []);
  state.machine.state = "Alarm";
  routing.applySurfaceAutomaticView();
  assert.deepEqual(tabs, ["attention"]);
});
