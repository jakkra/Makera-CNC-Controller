import test from "node:test";
import assert from "node:assert/strict";
import {
  createDashboardTelemetry,
  dashboardATCText,
  dashboardAlarmText,
  dashboardControllerText,
  dashboardLaserText,
  dashboardOnOff,
  dashboardOptionalNumber,
  dashboardRotaryText,
} from "./modules/dashboard-telemetry.js";

test("dashboard telemetry formatters preserve machine values and unknown states", () => {
  assert.equal(dashboardOptionalNumber("12.5"), 12.5);
  assert.equal(dashboardOptionalNumber(""), null);
  assert.equal(dashboardOptionalNumber("bad"), null);
  assert.equal(dashboardOnOff(1), "On");
  assert.equal(dashboardOnOff(0), "Off");
  assert.equal(dashboardOnOff(null), null);
  assert.equal(dashboardRotaryText({ wpos: { a: 1.23456, c: -2 } }), "A 1.235° · C -2.000°");
  assert.equal(dashboardLaserText({ testing: true, power: 50, scale: 2 }), "Testing · power 50.0 · scale 2.0");
  assert.equal(dashboardATCText(5), "Z probing");
  assert.equal(dashboardATCText(8), "State 8");
  assert.equal(dashboardControllerText({ model: 3, inch_mode: false, absolute_mode: true }), "Z1 · mm · absolute");
  assert.equal(dashboardAlarmText({ code: 10, message: "Soft limit", recovery: "power_cycle" }), "Soft limit · power cycle");
});

function telemetryDocument() {
  const rows = new Map();
  for (const key of ["rotary", "probe", "vacuum", "air", "outputs", "laser", "atc", "leveling", "controller", "alarm"]) {
    const output = { textContent: "old" };
    rows.set(key, { hidden: false, output, querySelector: (selector) => selector === "strong" ? output : null });
  }
  const empty = { hidden: false };
  return {
    rows,
    empty,
    documentRef: {
      querySelector(selector) {
        const match = selector.match(/^\[data-dashboard-telemetry="(.+)"\]$/);
        return match ? rows.get(match[1]) || null : null;
      },
      getElementById(id) { return id === "dashboard-telemetry-empty" ? empty : null; },
    },
  };
}

test("dashboard telemetry renderer updates existing rows through injected state and document", () => {
  const dom = telemetryDocument();
  const machine = {
    wpos: { a: 4 },
    wireless_probe_voltage: 3.3,
    spindle: { vacuum_mode: 1, blowing_mode: 0, bed_clean_mode: 1 },
    controller: { model: 3, absolute_mode: true },
  };
  const writes = [];
  const telemetry = createDashboardTelemetry({
    documentRef: dom.documentRef,
    getMachine: () => machine,
    setTextIfChanged: (node, value) => { writes.push([node, value]); node.textContent = value; },
  });

  telemetry.renderDashboardTelemetry();

  assert.equal(dom.rows.get("rotary").output.textContent, "A 4.000°");
  assert.equal(dom.rows.get("probe").output.textContent, "3.30 V");
  assert.equal(dom.rows.get("vacuum").output.textContent, "On");
  assert.equal(dom.rows.get("air").output.textContent, "Off");
  assert.equal(dom.rows.get("outputs").output.textContent, "Bed clean On");
  assert.equal(dom.rows.get("laser").hidden, true);
  assert.equal(dom.rows.get("alarm").hidden, true);
  assert.equal(dom.empty.hidden, true);
  assert.equal(writes.length, 6);
});

test("dashboard telemetry renderer hides empty rows and shows the empty state", () => {
  const dom = telemetryDocument();
  const telemetry = createDashboardTelemetry({ documentRef: dom.documentRef });
  telemetry.renderDashboardTelemetry({});
  for (const row of dom.rows.values()) assert.equal(row.hidden, true);
  assert.equal(dom.empty.hidden, false);
});
