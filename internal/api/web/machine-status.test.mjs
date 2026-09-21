import test from "node:test";
import assert from "node:assert/strict";
import { createMachineStatusFeature } from "./modules/machine-status.js";

function feature(overrides = {}) {
  let machine = overrides.machine || {};
  let pending = overrides.pending || "";
  let readOnly = !!overrides.readOnly;
  return createMachineStatusFeature({
    getMachine: () => machine,
    getActiveGcode: () => ({ preview: { tool_metadata: [{ number: 2, diameter_mm: 3.175, kind: "end mill", name: "Test tool" }] } }),
    getActiveGcodePending: () => pending,
    getReadOnly: () => readOnly,
    toolDisplayName: (number) => `Tool ${number}`,
    fmtDashboardFeed: (value) => `${value ?? "-"} mm/min`,
    fmtDashboardSpindle: (value) => `${value ?? "-"} rpm`,
    fmtCoord: (value) => value == null ? "-" : Number(value).toFixed(3),
    axisValue: (values, axis) => values?.[axis] ?? null,
    fmtActiveTool: (tool) => `Tool ${tool?.active ?? "-"}`,
    ...overrides.deps,
  });
}

test("machine status factory exposes tool and readout models with named dependencies", () => {
  const status = feature();
  assert.equal(status.gcodeToolLabel({ number: 2, diameter_mm: 3.175, kind: "end mill" }), "T2 · 3.175 mm end mill");
  assert.deepEqual(status.programToolListModel({ tools: [2, 4], events: [{ kind: "tool_change", tool: 2 }] }, 2).map((tool) => tool.number), [2, 4]);
  const model = status.machineReadoutModel(
    { feed: 120, spindle: 10000, tool: { active: 2 }, wpos: { x: 1, y: 2 }, mpos: { x: 11, y: 12 } },
    {},
    [{ number: 2, diameter_mm: 3.175, kind: "end mill", name: "Test tool" }],
  );
  assert.deepEqual(model.axes[0], { axis: "x", work: "1.000", machine: "11.000", available: true });
  assert.equal(model.metrics.tool.current, "T2 · 3.175 mm end mill");
  assert.equal(model.metrics.feed, "120 mm/min");
});

test("machine status lifecycle models account for stale, read-only, and pending states", () => {
  const status = feature({ machine: { connected: true, state: "Run", job_control: { can_pause: true } }, pending: "pause" });
  assert.equal(status.machineActionState({ connected: false, state: "Run" }), "Unknown");
  assert.equal(status.machineActionState({ connected: true, state: "Idle", age_ms: 10001 }), "Unknown");
  const model = status.jobControlModel(undefined, "pause", false);
  assert.equal(model.actions.pause.visible, true);
  assert.equal(model.actions.pause.pending, true);
  assert.equal(model.actions.resume.disabled, true);
  assert.deepEqual(status.jobControlModel({ connected: true, state: "Run" }, "", true).actions.pause, { visible: false, disabled: true, pending: false });
});

test("alarm panel lifecycle clears stale recovery feedback when alarm ends", () => {
  const cleared = [];
  const status = feature({
    machine: { state: "Idle" },
    deps: { clearNotice: (key) => cleared.push(key), setStatusMessage: () => {} },
  });
  const panel = { hidden: false };
  const nodes = new Map([["alarm-panel", panel]]);
  const documentRef = { getElementById: (id) => nodes.get(id), querySelectorAll: () => [] };
  const local = createMachineStatusFeature({
    documentRef,
    getMachine: () => ({ state: "Idle" }),
    getControlPendingAction: () => "",
    setLastControlResult: () => {},
    clearNotice: (key) => cleared.push(key),
    setStatusMessage: () => {},
  });
  local.renderAlarmPanel({ state: "Idle" });
  assert.equal(panel.hidden, true);
  assert.deepEqual(cleared, ["alarm", "control-recover"]);
  assert.equal(status.recoveryButtonText("unlock"), "Unlock Alarm");
});
