export function createToolActions({
  documentRef = document, request, validToolID, toolDisplayName,
  getMachine = () => ({}), getPending = () => "", setPending = () => {},
  setSoftDisabled, setElementBusy, setStatusMessage,
  disarmTapMoveForCommand, appendGcodeLine, pollMachine, setTimeoutRef = setTimeout,
} = {}) {
  const document = documentRef;
  const setTimeout = setTimeoutRef;
  const state = {
    get machine() { return getMachine(); },
    get toolPending() { return getPending(); },
    set toolPending(value) { setPending(value); },
  };function customToolID(inputID) {
  const input = document.getElementById(inputID);
  const toolID = Number(input?.value);
  if (!Number.isInteger(toolID) || toolID < 1 || toolID > 999) {
    return null;
  }
  return toolID;
}

function resetToolSelects() {
  const change = document.getElementById("tool-change-select");
  const set = document.getElementById("tool-set-select");
  if (change) change.value = "";
  if (set) set.value = "";
  toggleToolCustomInput("change", false);
  toggleToolCustomInput("set", false);
}

function toggleToolCustomInput(kind, show) {
  const row = document.getElementById("tool-" + kind + "-row");
  const input = document.getElementById(kind === "change" ? "tool-change-id" : "tool-id");
  if (!row || !input) return;
  row.classList.toggle("has-custom", show);
  input.hidden = !show;
  if (show) {
    input.focus();
    input.select();
  }
}

function handleToolSelect(kind, value) {
  toggleToolCustomInput(kind, value === "other");
  clearToolFeedback();
}

function selectedToolID(kind, allowEmpty) {
  const select = document.getElementById("tool-" + kind + "-select");
  const value = select?.value || "";
  if (value === "other") {
    return customToolID(kind === "change" ? "tool-change-id" : "tool-id");
  }
  if (value === "") return null;
  const toolID = Number(value);
  return validToolID(toolID, allowEmpty) ? toolID : null;
}

async function setCurrentTool(toolID = null) {
  if (!beginToolAction("set")) return;
  if (toolID == null) {
    toolID = selectedToolID("set", true);
  }
  if (!validToolID(toolID, true)) {
    finishToolAction("set");
    setToolFeedback("Choose Empty, Probe, 3D Probe, Laser, or tool 1-999.", "error");
    return;
  }
  const toolName = toolDisplayName(toolID);
  setToolFeedback("Disarming Movement before setting " + toolName + "...", "");
  try {
    await disarmTapMoveForCommand();
    setToolFeedback("Sending set-tool command for " + toolName + "...", "");
    const r = await request("/api/tool/current", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool_id: toolID }),
    });
    const result = await r.json();
    setToolFeedback(result.message || "Set-tool command sent; machine confirmation was not available.", result.verified ? "ok" : "");
    resetToolSelects();
    refreshMachineAfterToolAction();
  } catch (e) {
    appendGcodeLine({ seq: "local-" + Date.now(), dir: "recv", source: "api", text: "error: " + e.message });
    setToolFeedback("Set-tool failed: " + e.message, "error");
  } finally {
    finishToolAction("set");
  }
}

async function changeTool(toolID = null) {
  if (!beginToolAction("change")) return;
  if (toolID == null) {
    toolID = selectedToolID("change", false);
  }
  if (!validToolID(toolID, false)) {
    finishToolAction("change");
    setToolFeedback("Choose Probe, 3D Probe, Laser, or tool 1-999.", "error");
    return;
  }
  const toolName = toolDisplayName(toolID);
  setToolFeedback("Disarming Movement before changing to " + toolName + "...", "");
  try {
    await disarmTapMoveForCommand();
    setToolFeedback("Sending change-tool command for " + toolName + "...", "");
    const r = await request("/api/tool/change", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool_id: toolID }),
    });
    const result = await r.json();
    setToolFeedback(result.message || "Change-tool command sent; machine confirmation was not available.", result.verified ? "ok" : "");
    resetToolSelects();
    refreshMachineAfterToolAction();
  } catch (e) {
    appendGcodeLine({ seq: "local-" + Date.now(), dir: "recv", source: "api", text: "error: " + e.message });
    setToolFeedback("Change-tool failed: " + e.message, "error");
  } finally {
    finishToolAction("change");
  }
}

async function continueToolChange() {
  const continueAvailable = state.machine?.state === "Tool";
  if (!continueAvailable) {
    setToolFeedback("Continue is only available while the machine is awaiting a tool.", "error");
    renderToolActions();
    return;
  }
  if (!beginToolAction("continue")) return;
  setToolFeedback("Continuing tool change...", "");
  try {
    const r = await request("/api/tool/continue", { method: "POST" });
    const result = await r.json();
    setToolFeedback(result.message || "Tool-change continue command sent; machine confirmation was not available.", result.verified ? "ok" : "");
    refreshMachineAfterToolAction();
  } catch (e) {
    appendGcodeLine({ seq: "local-" + Date.now(), dir: "recv", source: "api", text: "error: " + e.message });
    setToolFeedback("Continue failed: " + e.message, "error");
    refreshMachineAfterToolAction();
  } finally {
    finishToolAction("continue");
  }
}

async function calibrateCurrentTool() {
  if (!beginToolAction("calibrate")) return;
  setToolFeedback("Sending calibration command...", "");
  try {
    const r = await request("/api/tool/calibrate", { method: "POST" });
    const result = await r.json();
    setToolFeedback(result.message || "Calibration command sent; machine confirmation was not available.", result.verified ? "ok" : "");
    refreshMachineAfterToolAction();
  } catch (e) {
    appendGcodeLine({ seq: "local-" + Date.now(), dir: "recv", source: "api", text: "error: " + e.message });
    setToolFeedback("Calibration failed: " + e.message, "error");
  } finally {
    finishToolAction("calibrate");
  }
}

function beginToolAction(action) {
  if (state.toolPending) {
    setToolFeedback("Tool action already in progress.", "error");
    renderToolActions();
    return false;
  }
  state.toolPending = action;
  renderToolActions();
  return true;
}

function finishToolAction(action) {
  if (state.toolPending === action) state.toolPending = "";
  renderToolActions();
}

function refreshMachineAfterToolAction() {
  pollMachine();
  setTimeout(pollMachine, 1200);
}

function renderToolActions(m = state.machine || {}) {
  const set = document.getElementById("tool-set");
  const change = document.getElementById("tool-change-set");
  const cont = document.getElementById("tool-continue");
  const cal = document.getElementById("tool-calibrate");
  const setSelect = document.getElementById("tool-set-select");
  const changeSelect = document.getElementById("tool-change-select");
  const setInput = document.getElementById("tool-id");
  const changeInput = document.getElementById("tool-change-id");
  const pendingAction = state.toolPending || "";
  const setPending = pendingAction === "set";
  const changePending = pendingAction === "change";
  const continuePending = pendingAction === "continue";
  const calibratePending = pendingAction === "calibrate";
  const waitingForTool = m.state === "Tool";
  const continueAvailable = waitingForTool;
  const row = document.getElementById("tool-wait-row");
  const label = document.getElementById("tool-wait-status");
  if (row) row.classList.toggle("is-waiting", waitingForTool);
  if (label) label.textContent = continueAvailable ? "Awaiting tool" : "Tool change";

  if (setSelect) setSelect.disabled = setPending || waitingForTool;
  if (changeSelect) changeSelect.disabled = changePending || waitingForTool;
  if (setInput) setInput.disabled = setPending || waitingForTool;
  if (changeInput) changeInput.disabled = changePending || waitingForTool;
  if (set) {
    set.disabled = setPending || waitingForTool;
    setSoftDisabled(set, !!pendingAction && !setPending);
    set.textContent = setPending ? "Setting..." : "Set";
    setElementBusy(set, setPending);
  }
  if (change) {
    change.disabled = changePending || waitingForTool;
    setSoftDisabled(change, !!pendingAction && !changePending);
    change.textContent = changePending ? "Changing..." : "Change";
    setElementBusy(change, changePending);
  }
  if (cont) {
    cont.textContent = continuePending ? "Continuing..." : "Continue";
    cont.disabled = continuePending;
    setSoftDisabled(cont, !continuePending && !continueAvailable);
    setElementBusy(cont, continuePending);
  }
  if (cal) {
    cal.disabled = calibratePending || waitingForTool;
    setSoftDisabled(cal, !!pendingAction && !calibratePending);
    cal.textContent = calibratePending ? "Calibrating..." : "Calibrate";
    setElementBusy(cal, calibratePending);
  }
}

function setToolFeedback(text, kind) {
  setStatusMessage("tool", text, kind, { force: true });
}

function clearToolFeedback() {
  setStatusMessage("tool", "");
}

  function bindInteractions({ bindButtonAction } = {}) {
    bindButtonAction(document.getElementById("tool-set"), () => setCurrentTool());
    bindButtonAction(document.getElementById("tool-change-set"), () => changeTool());
    bindButtonAction(document.getElementById("tool-continue"), continueToolChange);
    bindButtonAction(document.getElementById("tool-calibrate"), calibrateCurrentTool);
    document.getElementById("tool-set-select").onchange = (e) => handleToolSelect("set", e.target.value);
    document.getElementById("tool-change-select").onchange = (e) => handleToolSelect("change", e.target.value);
  }

  return { bindInteractions, customToolID, resetToolSelects, toggleToolCustomInput, handleToolSelect, selectedToolID, setCurrentTool, changeTool, continueToolChange, calibrateCurrentTool, beginToolAction, finishToolAction, refreshMachineAfterToolAction, renderToolActions, setToolFeedback, clearToolFeedback };
}
