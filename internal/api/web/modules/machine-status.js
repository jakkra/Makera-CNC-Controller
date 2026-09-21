// Machine status feature extracted mechanically from app.js. Function bodies remain unchanged.
export function createMachineStatusFeature({
  documentRef = globalThis.document,
  getMachine = () => ({}),
  getActiveGcode = () => ({}),
  getActiveGcodePending = () => "",
  getFeedOverridePendingPercent = () => null,
  getReadOnly = () => false,
  getControlPendingAction = () => "",
  getLastControlResult = () => null,
  setLastControlResult = () => {},
  getCurrentAxisValues = () => ({}),
  toolDisplayName = (toolID) => `T${toolID}`,
  fmtDashboardFeed = () => "-",
  fmtDashboardSpindle = () => "-",
  fmtCoord = (value) => value == null ? "-" : String(value),
  axisValue = (values, axis) => values?.[axis] ?? null,
  fmtActiveTool = () => "-",
  machineFeedOverrideControlModel = () => ({ pending: false, value: "-", decreaseDisabled: true, increaseDisabled: true, resetDisabled: true, available: false }),
  setTextIfChanged = (node, value) => { if (node && node.textContent !== value) node.textContent = value; },
  fmtAge = () => "-",
  pendingCount = () => 0,
  fmtPos = () => "-",
  fmtActiveFeed = () => "-",
  fmtSpindle = () => "-",
  renderToolActions = () => {},
  renderActiveGcode = () => {},
  syncJogAvailabilityFromMachine = () => {},
  checkOriginVerification = () => {},
  renderJog = () => {},
  renderOutlineCapture = () => {},
  clearNotice = () => {},
  setStatusMessage = () => {},
  HALT_REASON = {},
} = {}) {
  const document = documentRef;
  const state = {
    get machine() { return getMachine(); },
    get activeGcode() { return getActiveGcode(); },
    get activeGcodePending() { return getActiveGcodePending(); },
    get feedOverridePendingPercent() { return getFeedOverridePendingPercent(); },
    get readOnly() { return getReadOnly(); },
    get controlPendingAction() { return getControlPendingAction(); },
    get lastControlResult() { return getLastControlResult(); },
    set lastControlResult(value) { setLastControlResult(value); },
  };
  const currentAxisValues = getCurrentAxisValues;

function gcodeToolMetadata(toolMetadata, toolID) {
  const number = Number(toolID);
  if (!Number.isFinite(number) || !Array.isArray(toolMetadata)) return null;
  return toolMetadata.find((tool) => Number(tool?.number) === number) || null;
}

function gcodeToolLabel(tool) {
  if (!tool) return "";
  const diameter = Number(tool.diameter_mm);
  const kind = String(tool.kind || "").trim();
  const descriptor = [Number.isFinite(diameter) && diameter > 0 ? `${diameter} mm` : "", kind].filter(Boolean).join(" ");
  return descriptor ? `T${tool.number} · ${descriptor}` : `T${tool.number}`;
}

function programToolListModel(preview = {}, activeToolID = null) {
  const metadata = new Map();
  for (const tool of Array.isArray(preview?.tool_metadata) ? preview.tool_metadata : []) {
    const number = Number(tool?.number);
    if (Number.isInteger(number) && number > 0) metadata.set(number, tool);
  }
  const used = new Set(metadata.keys());
  for (const tool of Array.isArray(preview?.tools) ? preview.tools : []) {
    const number = Number(tool);
    if (Number.isInteger(number) && number > 0) used.add(number);
  }
  const changes = new Map();
  for (const event of Array.isArray(preview?.events) ? preview.events : []) {
    if (event?.kind !== "tool_change") continue;
    const number = Number(event.tool);
    if (!Number.isInteger(number) || number <= 0) continue;
    used.add(number);
    changes.set(number, (changes.get(number) || 0) + 1);
  }
  const active = Number(activeToolID);
  return [...used].sort((a, b) => a - b).map((number) => {
    const tool = metadata.get(number) || null;
    const changeCount = changes.get(number) || 0;
    return {
      number,
      label: tool ? gcodeToolLabel(tool) : toolDisplayName(number),
      detail: String(tool?.name || "").trim(),
      changeCount,
      active: Number.isFinite(active) && active === number,
    };
  });
}

function renderProgramToolLists(preview = {}, machine = state.machine) {
  const tools = programToolListModel(preview, machine?.tool?.active);
  const key = JSON.stringify(tools);
  for (const root of document.querySelectorAll("[data-program-tool-list]")) {
    if (root.dataset.programToolKey === key) continue;
    root.dataset.programToolKey = key;
    root.hidden = tools.length === 0;
    const fragment = document.createDocumentFragment();
    const heading = document.createElement("div");
    heading.className = "program-tool-list-heading";
    const title = document.createElement("span");
    title.textContent = "Program tools";
    const count = document.createElement("small");
    count.textContent = `${tools.length} tool${tools.length === 1 ? "" : "s"}`;
    heading.append(title, count);
    fragment.appendChild(heading);
    for (const tool of tools) {
      const row = document.createElement("div");
      row.className = "program-tool-row";
      row.classList.toggle("is-current", tool.active);
      const label = document.createElement("strong");
      label.textContent = tool.label;
      const detail = document.createElement("small");
      detail.textContent = tool.detail || "No Fusion tool details";
      const changes = document.createElement("span");
      changes.className = "program-tool-count";
      const changeText = `${tool.changeCount} change${tool.changeCount === 1 ? "" : "s"}`;
      changes.textContent = tool.active ? `Current · ${changeText}` : changeText;
      row.append(label, detail, changes);
      fragment.appendChild(row);
    }
    root.replaceChildren(fragment);
  }
}

function toolChangeTargetLabel(machine = state.machine, preview = state.activeGcode?.preview) {
  const target = Number(machine?.tool?.target);
  if (!Number.isFinite(target)) return "";
  const tool = gcodeToolMetadata(preview?.tool_metadata, target);
  if (!tool) return toolDisplayName(target);
  return [gcodeToolLabel(tool), String(tool.name || "").trim()].filter(Boolean).join(" · ");
}

function toolChangeAttentionDetail(machine = state.machine, preview = state.activeGcode?.preview) {
  const target = toolChangeTargetLabel(machine, preview);
  const subject = target ? `Tool change requested for ${target}.` : "Tool change requested.";
  return `${subject} Confirm the physical change, then continue.`;
}

function machineReadoutModel(machine, positions = {}, toolMetadata = []) {
  const wpos = positions.wpos || machine?.wpos || {};
  const mpos = positions.mpos || machine?.mpos || {};
  const feed = fmtDashboardFeed(machine?.feed);
  const spindle = fmtDashboardSpindle(machine?.spindle);
  const offset = Number(machine?.tool?.offset);
  const toolInfo = gcodeToolMetadata(toolMetadata, machine?.tool?.active);
  return {
    axes: ["x", "y", "z", "a"].map((axis) => ({
      axis,
      work: fmtCoord(axisValue(wpos, axis)),
      machine: fmtCoord(axisValue(mpos, axis)),
      available: axisValue(wpos, axis) !== null || axisValue(mpos, axis) !== null,
    })),
    metrics: {
      feed,
      spindle,
      tool: {
        current: toolInfo ? gcodeToolLabel(toolInfo) : fmtActiveTool(machine?.tool),
        detail: toolInfo?.name || (Number.isFinite(offset) ? `TLO ${offset.toFixed(3)}` : "TLO -"),
      },
    },
  };
}

function renderMachineReadouts(machine = state.machine || {}) {
  for (const host of document.querySelectorAll("[data-machine-readout-host]")) {
    const jogHost = !!host.closest("#jog-view");
    const model = machineReadoutModel(machine, jogHost ? currentAxisValues() : { wpos: machine.wpos, mpos: machine.mpos }, state.activeGcode?.preview?.tool_metadata || []);
    for (const axis of model.axes) {
      const row = host.querySelector(`[data-machine-axis="${axis.axis}"]`);
      if (!row) continue;
      setTextIfChanged(row.querySelector('[data-machine-space="work"]'), axis.work);
      setTextIfChanged(row.querySelector('[data-machine-space="machine"]'), axis.machine);
      row.classList.toggle("is-unavailable", !axis.available);
    }
    for (const [name, metric] of Object.entries(model.metrics)) {
      const row = host.querySelector(`[data-machine-metric="${name}"]`);
      if (!row) continue;
      setTextIfChanged(row.querySelector("[data-machine-primary]"), metric.current);
      setTextIfChanged(row.querySelector("[data-machine-secondary]"), metric.detail);
    }
    const feedControls = host.querySelector("[data-machine-feed-override]");
    if (feedControls) {
      const control = machineFeedOverrideControlModel(
        machine,
        state.activeGcodePending,
        state.feedOverridePendingPercent,
        state.readOnly,
      );
      feedControls.hidden = state.readOnly || !host.closest(".dashboard-machine");
      feedControls.setAttribute("aria-busy", String(control.pending));
      const reset = feedControls.querySelector("[data-machine-feed-reset]");
      setTextIfChanged(reset, control.value);
      for (const button of feedControls.querySelectorAll("button")) {
        if (button.dataset.machineFeedDelta === "-10") button.disabled = control.decreaseDisabled;
        else if (button.dataset.machineFeedDelta === "10") button.disabled = control.increaseDisabled;
        else button.disabled = control.resetDisabled;
        button.title = control.available ? "" : "Feed override is available while the connected machine is Idle, running, held, or paused.";
      }
    }
  }
}

function haltReason(m) {
  if (m?.halt_reason) return m.halt_reason;
  const h = m?.fields?.H;
  const code = Number.parseInt(String(h || "").split(",")[0], 10);
  if (!Number.isFinite(code)) return null;
  return {
    code,
    message: HALT_REASON[code] || "Unknown alarm",
    recovery: code >= 41 ? "power_cycle" : (code >= 21 ? "reset" : "unlock"),
  };
}

function recoveryText(recovery, reason = null) {
  if (reason?.code === 10) {
    return "Soft limit halt. Clear the physical cause, then recover; the proxy sends $X, verifies status, and falls back to M999 if firmware stays in Alarm.";
  }
  switch (recovery) {
  case "unlock":
    return "Clear the cause, unlock, then home before moving.";
  case "reset":
    return "Clear the cause, reset the machine, reconnect, then home.";
  case "power_cycle":
    return "Switch the machine off and on, reconnect, then home.";
  default:
    return "Inspect the cause before moving the machine.";
  }
}

function machineActionState(machine = state.machine) {
  const age = Number(machine?.age_ms);
  if (!machine?.connected || machine?.stale || (Number.isFinite(age) && age > 10000)) return "Unknown";
  return String(machine?.state || "Unknown");
}

function jobControlModel(machine = state.machine, pendingAction = "", readOnly = state.readOnly) {
  const actionState = machineActionState(machine);
  const control = machine?.job_control;
  const hasContract = !!control && typeof control === "object";
  const spindle = control?.spindle && typeof control.spindle === "object" ? control.spindle : {};
  const speed = Number(spindle.speed_rpm);
  const speedKnown = spindle.speed_known === true && Number.isFinite(speed) && speed > 0;
  const pending = String(pendingAction || "");
  const usable = !readOnly && actionState !== "Unknown";
  const available = {
    pause: hasContract ? control.can_pause === true : actionState === "Run",
    resume: hasContract ? control.can_resume === true : actionState === "Pause",
    "stop-spindle": hasContract ? control.can_stop_spindle === true : actionState === "Pause",
    // An explicitly supplied speed/direction is safe to expose only after the
    // server has confirmed a paused job. The request remains server-validated;
    // the browser does not manufacture a value from telemetry.
    "start-spindle": hasContract && (control.can_start_spindle === true || (control.paused === true && !speedKnown)),
  };
  const actions = {};
  for (const [action, visible] of Object.entries(available)) {
    const actionPending = pending === action ||
      (action === "pause" && pending === "pause_job") ||
      (action === "resume" && pending === "resume_job") ||
      (action === "stop-spindle" && pending === "stop_spindle") ||
      (action === "start-spindle" && pending === "start_spindle");
    actions[action] = {
      visible: !!visible && usable,
      disabled: !!pending || !usable,
      pending: actionPending,
    };
  }
  return { actions, speed: speedKnown ? Math.round(speed) : null };
}

function jobControlLabel(action, model, compact = false) {
  switch (action) {
  case "pause":
    return compact ? "Pause" : "Pause job";
  case "resume":
    return compact ? "Resume" : "Resume job";
  case "stop-spindle":
    return "Stop spindle";
  case "start-spindle":
    return model.speed === null ? "Start spindle" : `Start · ${model.speed.toLocaleString("en-US")} rpm`;
  default:
    return action;
  }
}

function renderJobControls(machine = state.machine || {}) {
  const model = jobControlModel(machine, state.activeGcodePending, state.readOnly);
  for (const group of document.querySelectorAll("[data-job-controls]")) {
    const compact = group.classList.contains("dashboard-job-controls");
    group.setAttribute("aria-busy", String(!!state.activeGcodePending));
    let visibleAction = false;
    for (const button of group.querySelectorAll("[data-job-control]")) {
      const action = button.dataset.jobControl;
      const control = model.actions[action];
      if (!control) continue;
      // Overview is deliberately shortcut-only: an unknown speed belongs in
      // Active Job, where its explicit direction/speed fields are visible.
      const visible = control.visible && !(compact && action === "start-spindle" && model.speed === null);
      button.hidden = !visible;
      button.disabled = control.disabled;
      button.setAttribute("aria-busy", String(control.pending));
      setTextIfChanged(button, jobControlLabel(action, model, compact));
      visibleAction ||= visible;
    }
    const explicitStart = !compact && model.actions["start-spindle"].visible && model.speed === null;
    for (const field of group.querySelectorAll("[data-job-start-field]")) {
      field.hidden = !explicitStart;
      const input = field.querySelector("input, select");
      if (input) input.disabled = model.actions["start-spindle"].disabled;
    }
    group.hidden = !visibleAction;
    group.classList.toggle("has-explicit-start", explicitStart);
  }
}

function renderMachine() {
  const m = state.machine || {};
  document.getElementById("mode").textContent = m.mode || "owner";
  document.getElementById("age").textContent = fmtAge(m.age_ms);
  document.getElementById("pending").textContent = String(pendingCount());
  const el = document.getElementById("state");
  const actionableState = machineActionState(m);
  const displayState = actionableState === "Unknown" && m.reconnecting ? "Reconnecting" : actionableState;
  el.textContent = displayState;
  el.className = "badge state-" + actionableState;
  document.getElementById("status-mpos").textContent = fmtPos(m.mpos, !!m.motion_estimated);
  document.getElementById("status-wpos").textContent = fmtPos(m.wpos, !!m.motion_estimated);
  document.getElementById("status-feed").textContent = fmtActiveFeed(m.feed);
  document.getElementById("status-spindle").textContent = fmtSpindle(m.spindle);
  document.getElementById("status-tool").textContent = fmtActiveTool(m.tool);
  renderToolStatus(m);
  const connection = document.getElementById("status-connection");
  if (connection) {
    const status = m.reconnecting ? "reconnecting" : (m.connected ? "connected" : "outage");
    const label = status === "connected" ? "Connected to machine" :
      (status === "reconnecting" ? "Reconnecting to machine" : "Machine connection outage");
    connection.className = "connection-status " + status;
    connection.setAttribute("aria-label", label);
    connection.title = label;
  }
  renderAlarmPanel(m);
  renderAttention(m);
  renderJobControls(m);
  renderActiveGcode();
  syncJogAvailabilityFromMachine(m);
  checkOriginVerification();
  renderJog();
  renderOutlineCapture();
}

function renderAttention(m) {
  const machineState = machineActionState(m);
  const details = {
    Pause: "The job is paused. Review the job before resuming motion.",
    Wait: "The controller is waiting for an operator decision. Review the active job before resuming.",
    Hold: "Motion is on hold. Make sure the work area is clear before resuming.",
    Alarm: "The machine reported an alarm. Clear the physical cause before attempting recovery.",
  };
  setTextIfChanged(document.getElementById("attention-state"), "Machine state: " + machineState);
  const detail = machineState === "Tool"
    ? toolChangeAttentionDetail(m, state.activeGcode?.preview)
    : (details[machineState] || "No operator action is currently requested.");
  setTextIfChanged(document.getElementById("attention-detail"), detail);
  const resume = document.getElementById("attention-resume");
  const recover = document.getElementById("attention-recover");
  const tool = document.getElementById("attention-open-tool");
  const resumeAction = attentionResumeAction(machineState);
  if (resume) {
    resume.hidden = state.readOnly || !resumeAction;
    resume.disabled = !!state.activeGcodePending || !!state.controlPendingAction;
    resume.setAttribute("aria-busy", String(
      state.activeGcodePending === "resume_job" || state.controlPendingAction === "resume",
    ));
    resume.dataset.resumeAction = resumeAction;
    setTextIfChanged(resume, machineState === "Pause" ? "Resume paused job" : "Resume motion");
  }
  if (recover) recover.hidden = state.readOnly || machineState !== "Alarm";
  if (tool) tool.hidden = state.readOnly || machineState !== "Tool";
}

function attentionResumeAction(machineState) {
  if (machineState === "Pause") return "resume_job";
  if (machineState === "Hold") return "resume";
  return "";
}

function renderToolStatus(m) {
  const tool = m.tool || null;
  const active = Number.isFinite(tool?.active) ? toolDisplayName(tool.active) : "-";
  const target = Number.isFinite(tool?.target) ? " -> " + toolDisplayName(tool.target) : "";
  const tlo = Number.isFinite(tool?.offset) ? tool.offset.toFixed(3) : "N/A";
  const wpRaw = String(m.fields?.W || "").split(",")[0];
  const wp = Number.parseFloat(wpRaw);
  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };
  setText("tool-active-status", active + target);
  setText("tool-tlo-status", tlo);
  setText("tool-wp-status", Number.isFinite(wp) ? wp.toFixed(2) + "v" : "-");
  renderToolActions(m);
}

function renderAlarmPanel(m) {
  const panel = document.getElementById("alarm-panel");
  const reason = haltReason(m);
  panel.hidden = m.state !== "Alarm";
  if (panel.hidden) {
    clearNotice("alarm");
    if (state.controlPendingAction !== "recover") {
      state.lastControlResult = null;
      clearNotice("control-recover");
    }
    return;
  }

  const code = reason ? "H:" + reason.code : "H:-";
  const message = reason?.message || "Unknown alarm";
  const recovery = reason?.recovery || "inspect";
  document.getElementById("alarm-title").textContent = `Alarm ${code}: ${message}`;
  document.getElementById("alarm-detail").textContent = recoveryText(recovery, reason);
  const btn = document.getElementById("alarm-recover");
  const pending = state.controlPendingAction === "recover";
  btn.hidden = recovery === "power_cycle";
  btn.disabled = pending || recovery === "inspect";
  btn.textContent = pending ? "Recovering..." : recoveryButtonText(recovery, reason);
  let statusText = "";
  let statusKind = "";
  if (pending) {
    statusText = "Sending recovery command and verifying machine status...";
  } else if (state.lastControlResult?.action === "recover" && state.lastControlResult?.message) {
    statusText = state.lastControlResult.message;
    statusKind = state.lastControlResult.failed ? "error" : "ok";
  } else {
    statusText = recovery === "power_cycle" ? "This halt class cannot be cleared in software." : "";
    statusKind = recovery === "power_cycle" ? "error" : "";
  }
  setStatusMessage("alarm", statusText, statusKind);
}

function recoveryButtonText(recovery, reason = null) {
  if (reason?.code === 10) return "Unlock Soft Limit";
  switch (recovery) {
  case "unlock":
    return "Unlock Alarm";
  case "reset":
    return "Reset Machine";
  default:
    return "Recover";
  }
}

  return {
    gcodeToolMetadata, gcodeToolLabel, programToolListModel, renderProgramToolLists, toolChangeTargetLabel, toolChangeAttentionDetail,
    machineReadoutModel, renderMachineReadouts, haltReason, recoveryText, machineActionState, jobControlModel,
    jobControlLabel, renderJobControls, renderMachine, renderAttention, attentionResumeAction, renderToolStatus,
    renderAlarmPanel, recoveryButtonText,
  };
}
