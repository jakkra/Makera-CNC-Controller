// Dashboard telemetry presentation. This module only derives display values
// from a machine snapshot and projects them onto existing DOM rows; it does
// not poll, send commands, or replace any dashboard nodes.

export function dashboardOptionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function dashboardOnOff(value) {
  const number = dashboardOptionalNumber(value);
  return number === null ? null : (number !== 0 ? "On" : "Off");
}

export function dashboardRotaryText(machine) {
  const position = machine?.wpos || machine?.mpos || {};
  const values = [];
  for (const axis of ["a", "b", "c"]) {
    const value = dashboardOptionalNumber(position[axis]);
    if (value !== null) values.push(`${axis.toUpperCase()} ${value.toFixed(3)}°`);
  }
  return values.length ? values.join(" · ") : null;
}

export function dashboardLaserText(laser) {
  if (!laser) return null;
  const stateText = laser.testing ? "Testing" : (laser.state ? "Firing" : (laser.mode ? "Ready" : "Off"));
  const power = dashboardOptionalNumber(laser.power);
  const scale = dashboardOptionalNumber(laser.scale);
  const details = [];
  if (power !== null) details.push(`power ${power.toFixed(1)}`);
  if (scale !== null) details.push(`scale ${scale.toFixed(1)}`);
  return details.length ? `${stateText} · ${details.join(" · ")}` : stateText;
}

export function dashboardATCText(value) {
  const stateCode = dashboardOptionalNumber(value);
  if (stateCode === null) return null;
  const labels = {
    0: "Idle",
    1: "Dropping tool",
    2: "Picking tool",
    3: "Calibrating",
    4: "Measuring margin",
    5: "Z probing",
    6: "Auto leveling",
    9: "Done",
  };
  return labels[stateCode] || `State ${stateCode}`;
}

export function dashboardControllerText(controller) {
  if (!controller) return null;
  const models = { 1: "C1", 2: "CA1", 3: "Z1" };
  const model = models[controller.model] || `Model ${controller.model}`;
  return `${model} · ${controller.inch_mode ? "inch" : "mm"} · ${controller.absolute_mode ? "absolute" : "relative"}`;
}

export function dashboardAlarmText(reason) {
  if (!reason) return null;
  const message = String(reason.message || `Alarm ${reason.code ?? ""}`).trim();
  const recovery = String(reason.recovery || "").replaceAll("_", " ").trim();
  return recovery ? `${message} · ${recovery}` : message;
}

export function createDashboardTelemetry({
  documentRef = globalThis.document,
  getMachine = () => ({}),
  setTextIfChanged = (node, value) => {
    if (node && node.textContent !== value) node.textContent = value;
  },
} = {}) {
  const document = documentRef;

  function renderDashboardTelemetry(machine = getMachine()) {
    const spindle = machine?.spindle || {};
    const probeV = dashboardOptionalNumber(machine?.wireless_probe_voltage);
    const levelDelta = dashboardOptionalNumber(machine?.leveling_max_delta);
    const values = {
      rotary: dashboardRotaryText(machine),
      probe: probeV === null ? null : `${probeV.toFixed(2)} V`,
      vacuum: dashboardOnOff(spindle.vacuum_mode),
      air: dashboardOnOff(spindle.blowing_mode),
      outputs: (() => {
        const values = [];
        const bed = dashboardOnOff(spindle.bed_clean_mode);
        const external = dashboardOnOff(spindle.external_mode);
        if (bed !== null) values.push(`Bed clean ${bed}`);
        if (external !== null) values.push(`External ${external}`);
        return values.length ? values.join(" · ") : null;
      })(),
      laser: dashboardLaserText(machine?.laser),
      atc: dashboardATCText(machine?.atc_state),
      leveling: levelDelta === null ? null : `Max delta ${levelDelta.toFixed(3)} mm`,
      controller: dashboardControllerText(machine?.controller),
      alarm: dashboardAlarmText(machine?.halt_reason),
    };
    let visible = 0;
    for (const [key, value] of Object.entries(values)) {
      const row = document.querySelector(`[data-dashboard-telemetry="${key}"]`);
      const output = row?.querySelector("strong");
      if (!row || !output) continue;
      row.hidden = value === null;
      if (value !== null) {
        setTextIfChanged(output, value);
        visible++;
      }
    }
    const empty = document.getElementById("dashboard-telemetry-empty");
    if (empty) empty.hidden = visible > 0;
  }

  return {
    dashboardOptionalNumber,
    dashboardOnOff,
    dashboardRotaryText,
    dashboardLaserText,
    dashboardATCText,
    dashboardControllerText,
    dashboardAlarmText,
    renderDashboardTelemetry,
  };
}
