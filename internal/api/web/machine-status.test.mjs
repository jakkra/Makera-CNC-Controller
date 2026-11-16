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

test("toolbar keeps Wi-Fi SSID and signal current independently of CNC state", () => {
  const nodes = new Map();
  for (const id of ["alarm-panel", "mode", "age", "pending", "state", "status-mpos", "status-wpos", "status-feed", "status-spindle", "status-tool", "toolbar-wifi", "toolbar-wifi-signal", "toolbar-wifi-ssid"]) {
    nodes.set(id, { textContent: "", setAttribute(key, value) { this[key] = value; } });
  }
  let machine = { connected: true, state: "Idle", network: { controller: { state: "connected", ssid: "Workshop <CNC>", signal_dbm: -63, signal_percent: 55 } } };
  const status = createMachineStatusFeature({
    documentRef: { getElementById: (id) => nodes.get(id) || null, querySelectorAll: () => [] },
    getMachine: () => machine,
  });
  status.renderMachine();
  assert.equal(nodes.get("toolbar-wifi-signal").textContent, "-63 dBm");
  assert.equal(nodes.get("toolbar-wifi-ssid").textContent, "Workshop <CNC>");
  assert.match(nodes.get("toolbar-wifi")["aria-label"], /Sensei Wi-Fi.*Workshop <CNC>.*-63 dBm/);
  const originalNode = nodes.get("toolbar-wifi-ssid");
  machine = { connected: false, state: "Unknown", network: { controller: { state: "connected", ssid: "Other network", signal_dbm: -50 } } };
  status.renderMachine();
  assert.equal(nodes.get("toolbar-wifi-signal").textContent, "-50 dBm");
  assert.equal(nodes.get("toolbar-wifi-ssid").textContent, "Other network");
  assert.equal(nodes.get("toolbar-wifi-ssid"), originalNode);
  machine.network.controller = { state: "connected", ssid: "Other network", signal_percent: 55 };
  status.renderMachine();
  assert.equal(nodes.get("toolbar-wifi-signal").textContent, "Wi-Fi —", "percent-only telemetry must never be relabelled as dBm");
  machine.network.controller = { state: "not_connected" };
  status.renderMachine();
  assert.equal(nodes.get("toolbar-wifi-signal").textContent, "Wi-Fi —");
  assert.equal(nodes.get("toolbar-wifi-ssid").textContent, "Offline");
  machine.network = undefined;
  status.renderMachine();
  assert.equal(nodes.get("toolbar-wifi-ssid").textContent, "Unavailable");
});

test("toolbar shows reported spindle temperature beside Wi-Fi", () => {
  const nodes = new Map();
  for (const id of ["alarm-panel", "mode", "age", "pending", "state", "status-mpos", "status-wpos", "status-feed", "status-spindle", "status-tool", "toolbar-spindle-temp", "toolbar-spindle-temp-value"]) {
    nodes.set(id, { textContent: "", setAttribute(key, value) { this[key] = value; } });
  }
  let machine = { connected: true, state: "Idle", spindle: { current_rpm: 0, target_rpm: 12000, override: 100, spindle_temp_c: 45.5, power_temp_c: 27.8 } };
  const status = createMachineStatusFeature({
    documentRef: { getElementById: (id) => nodes.get(id) || null, querySelectorAll: () => [] },
    getMachine: () => machine,
  });
  status.renderMachine();
  assert.equal(nodes.get("toolbar-spindle-temp-value").textContent, "45.5 °C");
  assert.equal(nodes.get("toolbar-spindle-temp")["aria-label"], "Spindle temperature: 45.5 °C");
  machine = { connected: true, state: "Idle", spindle: { current_rpm: 0, target_rpm: 0, override: 100 } };
  status.renderMachine();
  assert.equal(nodes.get("toolbar-spindle-temp-value").textContent, "—", "models without the field must not show a temperature");
  machine = { connected: false, state: "Unknown", spindle: { current_rpm: 0, target_rpm: 0, override: 100, spindle_temp_c: 50 } };
  status.renderMachine();
  assert.equal(nodes.get("toolbar-spindle-temp-value").textContent, "—", "stale temperature must not be shown while disconnected");
  assert.equal(nodes.get("toolbar-spindle-temp")["aria-label"], "Spindle temperature unavailable");
});
