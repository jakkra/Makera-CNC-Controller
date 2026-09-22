export function createOriginProbing({
  documentRef = document, getMachine = () => ({}), getUI = () => ({}), getJog = () => ({}),
  getActiveTab = () => "", getOutline = () => ({}), request, pollMachine, sendJog, connectJog,
  appendGcodeLine, renderJog, renderMachineSettings, refreshMachineLearnedSettings,
  queueSaveUISettings, normalizeMachineSettings, defaultMachineSettings, normalizeMachineLearned,
  currentWorkOrigin, currentAxisValues, axisValue, fmtCoord, finiteOr, newID, tapMoveTargetBusy,
  isProbeToolActive, is3DProbeToolActive, controlLocallyOwned, setSoftDisabled, setTextIfChanged,
  setElementBusy, setStatusMessage, setTapFeedback, clampNumber, refreshMachine = pollMachine,
  setTimeoutRef = setTimeout, clearTimeoutRef = clearTimeout,
} = {}) {
  const document = documentRef;
  const setTimeout = setTimeoutRef;
  const clearTimeout = clearTimeoutRef;
  const state = {
    get machine() { return getMachine(); },
    get ui() { return getUI(); },
    get jog() { return getJog(); },
    get activeTab() { return getActiveTab(); },
    get outline() { return getOutline(); },
  };function machineReadyForOriginSet() {
  const m = state.machine || {};
  const age = Number(m.age_ms);
  return !!m.connected && m.state === "Idle" && !m.stale && (!Number.isFinite(age) || age <= 10000);
}

function renderOriginButtons() {
  const j = state.jog;
  const pendingAxis = hasPendingOriginOperation();
  const zProbePending = !!j.zProbePending;
  const probe3DPending = !!j.probe3DPending;
  const jogReady = !!j.caps?.enabled && j.link === "online" && j.armed;
  const externalJogBusy = !j.armed && j.availability && !j.availability.available && j.availability.reason === "busy";
  const apiReady = !j.armed && machineReadyForOriginSet() && !externalJogBusy;
  const ready = (jogReady || apiReady) && !j.armPending && !tapMoveTargetBusy() && !j.zStepPending && !pendingAxis && !zProbePending;
  const busy = !!j.armPending || tapMoveTargetBusy() || !!j.zStepPending || !!pendingAxis || zProbePending;
  const probeReady = apiReady && isProbeToolActive();
  const probe3DReady = apiReady && is3DProbeToolActive();
  for (const btn of document.querySelectorAll("[data-origin-zero]")) {
    btn.disabled = busy;
    setSoftDisabled(btn, !busy && !ready);
  }
  const probe = document.getElementById("origin-probe-z");
  if (probe) {
    probe.disabled = busy;
    setSoftDisabled(probe, !busy && !probeReady);
    setTextIfChanged(probe, zProbePending && !probe3DPending ? "Probing..." : "Probe Z");
  }
  const probe3D = document.getElementById("origin-probe-3d");
  if (probe3D) {
    probe3D.disabled = busy;
    setSoftDisabled(probe3D, !busy && !probe3DReady);
    setTextIfChanged(probe3D, probe3DPending ? "Probing..." : "3D Probe");
  }
  for (const id of ["origin-set-xyz-open", "origin-set-open", "origin-presets-open"]) {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = busy;
  }
  for (const id of ["origin-xyz-x", "origin-xyz-y", "origin-xyz-z", "origin-set-source", "origin-set-x", "origin-set-y"]) {
    const input = document.getElementById(id);
    if (input) input.disabled = busy;
  }
  for (const id of ["origin-xyz-apply", "origin-set-apply"]) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    btn.disabled = busy;
    setSoftDisabled(btn, !busy && !ready);
    setTextIfChanged(btn, pendingAxis ? "Setting..." : (id === "origin-xyz-apply" ? "Set XYZ" : "Set Origin"));
  }
  renderSavedOriginSelect();
  const save = document.getElementById("saved-origin-save");
  const label = document.getElementById("saved-origin-label");
  const currentOrigin = currentWorkOrigin();
  if (label) label.disabled = busy;
  if (save) {
    save.disabled = busy;
    setSoftDisabled(save, !busy && !currentOrigin);
  }
  const del = document.getElementById("saved-origin-delete");
  const selected = selectedSavedOrigin();
  const recall = document.getElementById("saved-origin-recall");
  if (recall) {
    recall.disabled = busy || !selected;
    setSoftDisabled(recall, !busy && !!selected && !ready);
  }
  if (del) {
    del.disabled = busy || !selected;
  }
  renderOriginSetSourceLabels();
}

function setOriginFeedback(text, kind = "") {
  setStatusMessage("origin-action", text, kind, { force: true });
}

function renderOriginSetSourceLabels() {
  const machineCoordinates = document.getElementById("origin-set-source")?.value === "machine";
  const xLabel = document.getElementById("origin-set-x-label");
  const yLabel = document.getElementById("origin-set-y-label");
  if (xLabel) xLabel.textContent = machineCoordinates ? "Machine X" : "X Offset";
  if (yLabel) yLabel.textContent = machineCoordinates ? "Machine Y" : "Y Offset";
  renderOriginSetChange();
}

function hasPendingOriginOperation() {
  return !!state.jog.originPendingAxis || !!state.jog.originPending || !!state.jog.originPendingTargets;
}

function savedOrigins() {
  const machine = state.ui.machine || defaultMachineSettings();
  return Array.isArray(machine.saved_origins) ? machine.saved_origins : [];
}

function selectedSavedOrigin() {
  const id = document.getElementById("saved-origin-select")?.value || "";
  return savedOrigins().find((origin) => origin.id === id) || null;
}

function savedOriginLabel(origin) {
  if (!origin) return "";
  return `${origin.label} (${fmtCoord(origin.origin?.x)}, ${fmtCoord(origin.origin?.y)})`;
}

function renderSavedOriginSelect() {
  const select = document.getElementById("saved-origin-select");
  if (!select) return;
  const origins = savedOrigins();
  const signature = JSON.stringify(origins.map((origin) => [origin.id, savedOriginLabel(origin)]));
  // Rebuild options only when the backing list changed and the operator does
  // not own the control (focused/open); a deferred rebuild happens on the next
  // render after blur.
  if (select.dataset.originsSignature !== signature && !controlLocallyOwned(select)) {
    const previous = select.value;
    select.innerHTML = "";
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = origins.length ? "Select saved zero" : "No saved zeros";
    select.appendChild(empty);
    for (const origin of origins) {
      const option = document.createElement("option");
      option.value = origin.id;
      option.textContent = savedOriginLabel(origin);
      select.appendChild(option);
    }
    if (origins.some((origin) => origin.id === previous)) select.value = previous;
    select.dataset.originsSignature = signature;
  }
  select.disabled = hasPendingOriginOperation();
}

function saveCurrentOrigin() {
  if (hasPendingOriginOperation()) return;
  const origin = currentWorkOrigin();
  if (!origin || axisValue(origin, "x") === null || axisValue(origin, "y") === null) {
    setTapFeedback("Current work zero is unavailable.", "error");
    return;
  }
  const input = document.getElementById("saved-origin-label");
  const label = String(input?.value || "").trim();
  if (!label) {
    setTapFeedback("Enter a label before saving the current zero.", "error");
    return;
  }
  const machine = normalizeMachineSettings(state.ui.machine);
  const saved = {
    id: newID("origin"),
    label: label.slice(0, 80),
    origin: { x: axisValue(origin, "x"), y: axisValue(origin, "y") },
    created_at: new Date().toISOString(),
  };
  state.ui.machine = normalizeMachineSettings({
    ...machine,
    saved_origins: [...savedOrigins(), saved],
  });
  if (input) input.value = "";
  queueSaveUISettings();
  renderMachineSettings();
  renderJog();
  const select = document.getElementById("saved-origin-select");
  if (select) select.value = saved.id;
  setOriginFeedback("Saved origin " + saved.label + ".", "ok");
}

function deleteSelectedOrigin() {
  if (hasPendingOriginOperation()) return;
  const selected = selectedSavedOrigin();
  if (!selected) {
    setTapFeedback("Select a saved zero to delete.", "error");
    return;
  }
  const machine = normalizeMachineSettings(state.ui.machine);
  state.ui.machine = normalizeMachineSettings({
    ...machine,
    saved_origins: savedOrigins().filter((origin) => origin.id !== selected.id),
  });
  queueSaveUISettings();
  renderMachineSettings();
  renderJog();
  setOriginFeedback("Deleted saved origin " + selected.label + ".");
}

function originCommandLine(axis, value = 0) {
  return "G10L20P0" + axis.toUpperCase() + formatOriginValue(value);
}

function formatOriginValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  if (Math.abs(n) < 0.00005) return "0";
  return n.toFixed(4).replace(/\.?0+$/, "");
}

function originTargetsFromXYZ() {
  const targets = {};
  for (const axis of ["x", "y", "z"]) {
    const raw = String(document.getElementById("origin-xyz-" + axis)?.value || "").trim();
    if (!raw) continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(axis.toUpperCase() + " value must be finite.");
    targets[axis] = value;
  }
  if (!originAxes(targets).length) throw new Error("Enter at least one coordinate.");
  return { targets, label: "XYZ" };
}

function originTargetsFromSaved(saved) {
  if (!saved) throw new Error("select a saved zero to recall.");
  const { mpos } = currentAxisValues();
  const mx = axisValue(mpos, "x");
  const my = axisValue(mpos, "y");
  if (mx === null || my === null) throw new Error("current machine XY position is unavailable.");
  return {
    targets: { x: mx - saved.origin.x, y: my - saved.origin.y },
    label: saved.label,
  };
}

function machineAnchorPoints() {
  const anchors = normalizeMachineLearned(state.ui.machine?.learned).anchors;
  const anchor1X = axisValue(anchors?.anchor1, "x");
  const anchor1Y = axisValue(anchors?.anchor1, "y");
  const anchor2X = axisValue(anchors?.anchor2, "x");
  const anchor2Y = axisValue(anchors?.anchor2, "y");
  if (!anchors?.available || anchor1X === null || anchor1Y === null || anchor2X === null || anchor2Y === null) return null;
  return {
    anchor1: { x: anchor1X, y: anchor1Y },
    anchor2: { x: anchor2X, y: anchor2Y },
  };
}

function originTargetsFromOriginSource() {
  const source = document.getElementById("origin-set-source")?.value || "anchor1";
  const x = finiteOr(document.getElementById("origin-set-x")?.value, NaN);
  const y = finiteOr(document.getElementById("origin-set-y")?.value, NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Origin coordinates must be finite.");
  const { mpos } = currentAxisValues();
  const mx = axisValue(mpos, "x");
  const my = axisValue(mpos, "y");
  if (mx === null || my === null) throw new Error("Current machine XY position is unavailable.");
  let machineOrigin;
  let label;
  if (source === "machine") {
    machineOrigin = { x, y };
    label = "machine coordinate origin";
  } else {
    const anchors = machineAnchorPoints();
    if (!anchors) throw new Error("Machine anchor positions are unavailable. Learn machine parameters first.");
    const selected = source === "anchor2" ? "anchor2" : "anchor1";
    const anchor = anchors[selected];
    machineOrigin = { x: anchor.x + x, y: anchor.y + y };
    label = (selected === "anchor2" ? "Anchor 2" : "Anchor 1") + " origin";
  }
  return {
    targets: { x: mx - machineOrigin.x, y: my - machineOrigin.y },
    label,
    machineOrigin,
  };
}

function originReferenceRequestFromInputs() {
  const reference = document.getElementById("origin-set-source")?.value || "anchor1";
  const x = finiteOr(document.getElementById("origin-set-x")?.value, NaN);
  const y = finiteOr(document.getElementById("origin-set-y")?.value, NaN);
  if (!["anchor1", "anchor2", "machine"].includes(reference)) throw new Error("Origin reference is invalid.");
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Origin coordinates must be finite.");
  return {
    reference,
    x,
    y,
    label: reference === "anchor2" ? "Anchor 2 origin" : (reference === "anchor1" ? "Anchor 1 origin" : "machine coordinate origin"),
  };
}

function renderOriginSetChange() {
  const out = document.getElementById("origin-set-change");
  if (!out) return;
  try {
    const { machineOrigin } = originTargetsFromOriginSource();
    const current = currentWorkOrigin();
    const currentX = axisValue(current, "x");
    const currentY = axisValue(current, "y");
    if (currentX === null || currentY === null) {
      out.textContent = "Change from current origin: unavailable (machine and work XY required).";
      return;
    }
    const signed = (value) => (value >= 0 ? "+" : "") + formatOriginValue(value);
    out.textContent = "Change from current origin: X " + signed(machineOrigin.x - currentX) + "  Y " + signed(machineOrigin.y - currentY) + " mm";
  } catch (e) {
    out.textContent = "Change from current origin: " + e.message;
  }
}

function originAxes(targets) {
  return ["x", "y", "z"].filter((axis) => Number.isFinite(Number(targets?.[axis])));
}

function originTargetLabel(label, targets) {
  const parts = originAxes(targets).map((axis) => axis.toUpperCase() + " " + formatOriginValue(targets[axis]));
  return label || parts.join(" ");
}

function clearOriginVerification() {
  if (state.jog.originVerifyTimer) {
    clearTimeout(state.jog.originVerifyTimer);
    state.jog.originVerifyTimer = null;
  }
  state.jog.originPending = 0;
  state.jog.originPendingAxis = "";
  state.jog.originPendingMode = "";
  state.jog.originPendingAxes = [];
  state.jog.originPendingIndex = 0;
  state.jog.originPendingTargets = null;
  state.jog.originPendingLabel = "";
  state.jog.originVerifyDeadline = 0;
}

function beginOriginVerification() {
  state.jog.originPending = 0;
  state.jog.originPendingAxis = "";
  state.jog.originVerifyDeadline = Date.now() + 5000;
  setOriginFeedback("Verifying " + originTargetLabel(state.jog.originPendingLabel, state.jog.originPendingTargets) + "...");
  if (!checkOriginVerification()) scheduleOriginVerification();
}

function checkOriginVerification() {
  const targets = state.jog.originPendingTargets;
  const axes = originAxes(targets);
  if (!axes.length || state.jog.originPending) return false;
  const values = axes.map((axis) => {
    const w = state.jog.originPendingMode === "jog"
      ? (axisValue(state.jog.wpos, axis) ?? axisValue(state.machine.wpos, axis))
      : (axisValue(state.machine.wpos, axis) ?? axisValue(state.jog.wpos, axis));
    return { axis, w, target: Number(targets[axis]) };
  });
  if (values.every((v) => v.w !== null && Math.abs(v.w - v.target) <= 0.01)) {
    const label = originTargetLabel(state.jog.originPendingLabel, targets);
    clearOriginVerification();
    setOriginFeedback(label + " set.", "ok");
    return true;
  }
  if (Date.now() > state.jog.originVerifyDeadline) {
    const seen = values.map((v) => v.w === null ? v.axis.toUpperCase() + " no WPos" : v.axis.toUpperCase() + " " + v.w.toFixed(3)).join(", ");
    const label = originTargetLabel(state.jog.originPendingLabel, targets);
    clearOriginVerification();
    setOriginFeedback("Set " + label + " could not be verified (" + seen + ").", "error");
    return true;
  }
  return false;
}

function scheduleOriginVerification() {
  if (state.jog.originVerifyTimer) clearTimeout(state.jog.originVerifyTimer);
  if (!state.jog.originPendingTargets || state.jog.originPending) return;
  state.jog.originVerifyTimer = setTimeout(async () => {
    state.jog.originVerifyTimer = null;
    if (!state.jog.originPendingTargets || state.jog.originPending) return;
    if (checkOriginVerification()) {
      renderJog();
      return;
    }
    await pollMachine();
    if (!state.jog.originPendingTargets || state.jog.originPending) return;
    if (checkOriginVerification()) renderJog();
    else scheduleOriginVerification();
  }, 350);
}

async function setOriginViaGcode(targets, label) {
  const axes = originAxes(targets);
  state.jog.originPending = -1;
  state.jog.originPendingAxis = axes[0] || "";
  state.jog.originPendingMode = "api";
  state.jog.originPendingAxes = axes;
  state.jog.originPendingIndex = 0;
  state.jog.originPendingTargets = { ...targets };
  state.jog.originPendingLabel = label;
  setOriginFeedback("Setting " + originTargetLabel(label, targets) + "...");
  renderJog();
  try {
    for (const axis of axes) {
      state.jog.originPendingAxis = axis;
      await request("/api/gcode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ line: originCommandLine(axis, targets[axis]) }),
      });
    }
    beginOriginVerification();
  } catch (e) {
    const pendingLabel = originTargetLabel(label, targets);
    clearOriginVerification();
    setOriginFeedback("Set " + pendingLabel + " failed: " + e.message, "error");
    appendGcodeLine({ seq: "local-" + Date.now(), dir: "recv", source: "api", text: "error: " + e.message });
  } finally {
    renderJog();
  }
}

async function setReferenceOriginViaAPI(origin) {
  state.jog.originPending = -1;
  state.jog.originPendingAxis = "xy";
  state.jog.originPendingMode = "api-reference";
  state.jog.originPendingAxes = ["x", "y"];
  state.jog.originPendingTargets = null;
  state.jog.originPendingLabel = origin.label;
  setOriginFeedback("Setting " + origin.label + "...");
  renderJog();
  try {
    const response = await request("/api/origin/reference", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reference: origin.reference, x: origin.x, y: origin.y }),
    });
    const result = await response.json();
    state.jog.originPendingTargets = result.target || null;
    if (!state.jog.originPendingTargets) throw new Error("machine did not return an origin verification target");
    beginOriginVerification();
  } catch (e) {
    clearOriginVerification();
    setOriginFeedback("Set " + origin.label + " failed: " + e.message, "error");
    appendGcodeLine({ seq: "local-" + Date.now(), dir: "recv", source: "api", text: "error: " + e.message });
  } finally {
    renderJog();
  }
}

function setReferenceOriginViaJog(origin) {
  const seq = sendJog({
    type: "origin_reference",
    reference: origin.reference,
    x: origin.x,
    y: origin.y,
  });
  if (!seq) {
    setOriginFeedback("Set " + origin.label + " failed: jog service is not connected.", "error");
    return;
  }
  state.jog.originPending = seq;
  state.jog.originPendingAxis = "xy";
  state.jog.originPendingMode = "jog-reference";
  state.jog.originPendingAxes = ["x", "y"];
  state.jog.originPendingIndex = 0;
  state.jog.originPendingTargets = null;
  state.jog.originPendingLabel = origin.label;
  setOriginFeedback("Setting " + origin.label + "...");
  renderJog();
}

function sendNextJogOriginAxis() {
  const axes = state.jog.originPendingAxes || [];
  const axis = axes[state.jog.originPendingIndex] || "";
  const targets = state.jog.originPendingTargets || {};
  if (!axis) {
    beginOriginVerification();
    return true;
  }
  const seq = sendJog({ type: "origin", axis, value: Number(targets[axis]) || 0 });
  if (!seq) {
    const label = originTargetLabel(state.jog.originPendingLabel, targets);
    clearOriginVerification();
    setOriginFeedback("Set " + label + " failed: jog service is not connected.", "error");
    return false;
  }
  state.jog.originPending = seq;
  state.jog.originPendingAxis = axis;
  setOriginFeedback("Setting " + originTargetLabel(state.jog.originPendingLabel, targets) + "...");
  renderJog();
  return true;
}

function handleOriginAck() {
  state.jog.originPending = 0;
  state.jog.originPendingIndex += 1;
  if (state.jog.originPendingIndex < state.jog.originPendingAxes.length) {
    sendNextJogOriginAxis();
    return;
  }
  beginOriginVerification();
}

function applyOriginTargets(targets, label) {
  const axes = originAxes(targets);
  if (!axes.length) return;
  if (hasPendingOriginOperation() || tapMoveTargetBusy() || state.jog.zStepPending) return;
  if (state.jog.armed) {
    if (state.jog.link !== "online") {
      setOriginFeedback("Jog service is not connected.", "error");
      connectJog();
      return;
    }
    state.jog.originPendingMode = "jog";
    state.jog.originPendingAxes = axes;
    state.jog.originPendingIndex = 0;
    state.jog.originPendingTargets = { ...targets };
    state.jog.originPendingLabel = label;
    sendNextJogOriginAxis();
    return;
  }
  if (!machineReadyForOriginSet()) {
    setOriginFeedback("Machine must be connected and Idle to set origin.", "error");
    return;
  }
  setOriginViaGcode(targets, label);
}

function setOriginAxis(axis) {
  axis = String(axis || "").toLowerCase();
  if (!["x", "y", "z"].includes(axis)) return;
  applyOriginTargets({ [axis]: 0 }, axis.toUpperCase() + "0");
}

function openOriginDialog(id) {
  const dialog = document.getElementById(id);
  if (!dialog || dialog.open) return;
  renderOriginButtons();
  dialog.showModal();
  if (id === "origin-set-modal") refreshMachineLearnedSettings();
}

function closeOriginDialog(id) {
  document.getElementById(id)?.close();
}

function probe3DFieldRules(kind) {
  kind = String(kind || "");
  const x = !kind.endsWith("_y");
  const y = !kind.endsWith("_x");
  const z = !kind.startsWith("bore_pocket");
  const note = kind.startsWith("bore_pocket")
    ? "Move the 3D Probe inside the bore or pocket with its contact point below the top surface, and make sure the probe is stable."
    : "Z Offset is the probe tip-to-surface distance during edge probing. Make sure the 3D Probe is stable.";
  return { x, y, z, note };
}

function probe3DInitialPositioning(kind, xOffset, yOffset) {
  const x = Math.abs(Number(xOffset));
  const y = Math.abs(Number(yOffset));
  switch (String(kind || "")) {
    case "outside_top_left": return { x: -x, y };
    case "outside_top_right": return { x, y };
    case "outside_bottom_right": return { x, y: -y };
    case "outside_bottom_left": return { x: -x, y: -y };
    case "inside_top_left": return { x, y: -y };
    case "inside_top_right": return { x: -x, y: -y };
    case "inside_bottom_right": return { x: -x, y };
    case "inside_bottom_left": return { x, y };
    case "boss_block": return { x: -x, y: -y };
    case "boss_block_x": return { x: -x };
    case "boss_block_y": return { y: -y };
    default: return {};
  }
}

function probe3DTravelPreflight(kind, xOffset, yOffset, mpos, bounds) {
  const delta = probe3DInitialPositioning(kind, xOffset, yOffset);
  const issues = [];
  for (const axis of ["x", "y"]) {
    if (!Object.hasOwn(delta, axis)) continue;
    const current = Number(mpos?.[axis]);
    const min = Number(bounds?.[axis]?.min);
    const max = Number(bounds?.[axis]?.max);
    if (![current, delta[axis], min, max].every(Number.isFinite) || min >= max) continue;
    const target = current + delta[axis];
    const label = axis.toUpperCase();
    if (target < min) {
      issues.push(`${label} target ${target.toFixed(3)} mm is below learned minimum ${min.toFixed(3)} mm (maximum ${label} Offset here: ${Math.max(0, current - min).toFixed(3)} mm).`);
    } else if (target > max) {
      issues.push(`${label} target ${target.toFixed(3)} mm is above learned maximum ${max.toFixed(3)} mm (maximum ${label} Offset here: ${Math.max(0, max - current).toFixed(3)} mm).`);
    }
  }
  return {
    blocked: issues.length > 0,
    warning: issues.length ? "Soft-limit risk: " + issues.join(" ") + " Reduce the offset or reposition the probe." : "",
  };
}

function probe3DLearnedTravelBounds() {
  const learned = state.ui.machine?.learned || {};
  const soft = learned.soft_endstop || {};
  const xMin = Number(soft.x_min);
  const xMax = Number(soft.x_max);
  const yMin = Number(soft.y_min);
  const yMax = Number(soft.y_max);
  return {
    x: Number.isFinite(xMin) && Number.isFinite(xMax) && xMin < xMax ? { min: xMin, max: xMax } : null,
    y: Number.isFinite(yMin) && Number.isFinite(yMax) && yMin < yMax ? { min: yMin, max: yMax } : null,
  };
}

function probe3DPreflightFromControls() {
  const kind = document.getElementById("probe-3d-kind")?.value || "";
  const x = Number(document.getElementById("probe-3d-x")?.value);
  const y = Number(document.getElementById("probe-3d-y")?.value);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { blocked: false, warning: "" };
  return probe3DTravelPreflight(kind, x, y, state.machine.mpos, probe3DLearnedTravelBounds());
}

function renderProbe3DForm() {
  const kind = document.getElementById("probe-3d-kind")?.value || "";
  const rules = probe3DFieldRules(kind);
  const pending = !!state.jog.probe3DPending;
  for (const axis of ["x", "y", "z"]) {
    const field = document.getElementById("probe-3d-" + axis + "-field");
    const input = document.getElementById("probe-3d-" + axis);
    const active = !!rules[axis];
    field?.classList.toggle("is-inactive", !active);
    field?.setAttribute("aria-hidden", active ? "false" : "true");
    if (input) input.disabled = pending || !active;
  }
  const kindSelect = document.getElementById("probe-3d-kind");
  const diameter = document.getElementById("probe-3d-diameter");
  if (kindSelect) kindSelect.disabled = pending;
  if (diameter) diameter.disabled = pending;
  const note = document.getElementById("probe-3d-note");
  if (note) note.textContent = rules.note;
  const preflight = probe3DPreflightFromControls();
  const preflightNode = document.getElementById("probe-3d-preflight");
  if (preflightNode) {
    preflightNode.textContent = preflight.warning;
    preflightNode.classList.toggle("is-visible", preflight.blocked);
    preflightNode.setAttribute("aria-hidden", preflight.blocked ? "false" : "true");
  }
  const run = document.getElementById("probe-3d-run");
  if (run) {
    run.disabled = pending || preflight.blocked;
    setTextIfChanged(run, pending ? "Probing..." : "Probe");
    setElementBusy(run, pending);
  }
  const cancel = document.getElementById("probe-3d-cancel");
  const close = document.getElementById("probe-3d-close");
  if (cancel) cancel.disabled = pending;
  if (close) close.disabled = pending;
}

function probe3DNumber(id, label, positive = false) {
  const raw = String(document.getElementById(id)?.value || "").trim();
  const value = Number(raw);
  if (raw === "" || !Number.isFinite(value)) throw new Error(label + " must be a number.");
  if (value < 0 || value > 5000 || (positive && value === 0)) {
    throw new Error(label + (positive ? " must be greater than 0 and no more than 5000 mm." : " must be between 0 and 5000 mm."));
  }
  return value;
}

function probe3DRequestFromControls() {
  return {
    kind: document.getElementById("probe-3d-kind")?.value || "",
    x_offset_mm: probe3DNumber("probe-3d-x", "X Offset"),
    y_offset_mm: probe3DNumber("probe-3d-y", "Y Offset"),
    z_offset_mm: probe3DNumber("probe-3d-z", "Z Offset"),
    diameter_mm: probe3DNumber("probe-3d-diameter", "Probe Diameter", true),
  };
}

function openProbe3D() {
  if (state.jog.armed) {
    setOriginFeedback("Disarm Movement before running 3D probe.", "error");
    return;
  }
  if (!machineReadyForOriginSet()) {
    setOriginFeedback("Machine must be connected and Idle to run 3D probe.", "error");
    return;
  }
  if (!is3DProbeToolActive()) {
    setOriginFeedback("3D probe requires the 3D Probe tool to be active.", "error");
    return;
  }
  const dialog = document.getElementById("probe-3d-modal");
  if (!dialog || dialog.open) return;
  renderProbe3DForm();
  dialog.showModal();
  document.getElementById("probe-3d-kind")?.focus();
}

function closeProbe3D() {
  if (state.jog.probe3DPending) return;
  document.getElementById("probe-3d-modal")?.close();
}

async function runProbe3D() {
  if (state.jog.zProbePending || tapMoveTargetBusy() || state.jog.zStepPending || hasPendingOriginOperation()) return;
  if (state.jog.armed) {
    setOriginFeedback("Disarm Movement before running 3D probe.", "error");
    return;
  }
  if (!machineReadyForOriginSet()) {
    setOriginFeedback("Machine must be connected and Idle to run 3D probe.", "error");
    return;
  }
  if (!is3DProbeToolActive()) {
    setOriginFeedback("3D probe requires the 3D Probe tool to be active.", "error");
    return;
  }
  let body;
  try {
    body = probe3DRequestFromControls();
  } catch (e) {
    setOriginFeedback(e.message, "error");
    return;
  }
  const preflight = probe3DTravelPreflight(body.kind, body.x_offset_mm, body.y_offset_mm, state.machine.mpos, probe3DLearnedTravelBounds());
  if (preflight.blocked) {
    setOriginFeedback(preflight.warning, "error");
    renderProbe3DForm();
    return;
  }

  state.jog.zProbePending = true;
  state.jog.probe3DPending = true;
  setOriginFeedback("Starting 3D probe...");
  renderJog();
  renderProbe3DForm();
  try {
    const resp = await request("/api/probe/3d", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await resp.json();
    // M480 owns all subsequent motion and origin changes, so a completed Tap
    // Move target no longer represents an active or useful machine target.
    // Clear it only after the 3D-probe command has been accepted; rejected
    // requests retain the marker.
    state.jog.target = null;
    state.jog.targetLabel = "";
    setOriginFeedback(result.message || "3D probe command sent; machine completion was not available.", result.verified ? "ok" : "");
    document.getElementById("probe-3d-modal")?.close();
    pollMachine();
    setTimeout(pollMachine, 1200);
  } catch (e) {
    setOriginFeedback("3D probe failed: " + e.message, "error");
    appendGcodeLine({ seq: "local-" + Date.now(), dir: "recv", source: "api", text: "error: " + e.message });
  } finally {
    state.jog.probe3DPending = false;
    state.jog.zProbePending = false;
    renderProbe3DForm();
    renderJog();
  }
}

function applyXYZOrigin() {
  try {
    const { targets, label } = originTargetsFromXYZ();
    applyOriginTargets(targets, label);
  } catch (e) {
    setOriginFeedback(e.message, "error");
  }
}

function applyOriginSource() {
  try {
    const origin = originReferenceRequestFromInputs();
    if (hasPendingOriginOperation() || tapMoveTargetBusy() || state.jog.zStepPending) return;
    if (state.jog.armed) {
      if (state.jog.link !== "online") {
        setOriginFeedback("Jog service is not connected.", "error");
        connectJog();
        return;
      }
      setReferenceOriginViaJog(origin);
      return;
    }
    if (!machineReadyForOriginSet()) {
      setOriginFeedback("Machine must be connected and Idle to set origin.", "error");
      return;
    }
    setReferenceOriginViaAPI(origin);
  } catch (e) {
    setOriginFeedback(e.message, "error");
    renderJog();
  }
}

async function runAutoZProbe() {
  if (state.jog.zProbePending || tapMoveTargetBusy() || state.jog.zStepPending || hasPendingOriginOperation()) return;
  if (state.jog.armed) {
    setOriginFeedback("Disarm Movement before running Z probe.", "error");
    renderJog();
    return;
  }
  if (!machineReadyForOriginSet()) {
    setOriginFeedback("Machine must be connected and Idle to run Z probe.", "error");
    renderJog();
    return;
  }
  if (!isProbeToolActive()) {
    setOriginFeedback("Z probe requires the probe tool to be active.", "error");
    renderJog();
    return;
  }
  const { wpos } = currentAxisValues();
  if (axisValue(wpos, "x") === null || axisValue(wpos, "y") === null) {
    setOriginFeedback("Current work XY is unavailable.", "error");
    renderJog();
    return;
  }
  state.jog.zProbePending = true;
  setOriginFeedback("Starting Z probe...");
  renderJog();
  try {
    const resp = await request("/api/probe/auto-z", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const result = await resp.json();
    const msg = result.message || "Z probe command sent.";
    setOriginFeedback(msg, result.verified ? "ok" : "");
    await pollMachine();
  } catch (e) {
    setOriginFeedback("Z probe failed: " + e.message, "error");
    appendGcodeLine({ seq: "local-" + Date.now(), dir: "recv", source: "api", text: "error: " + e.message });
  } finally {
    state.jog.zProbePending = false;
    renderJog();
  }
}

function recallSelectedOrigin() {
  try {
    const { targets, label } = originTargetsFromSaved(selectedSavedOrigin());
    applyOriginTargets(targets, label);
  } catch (e) {
    setOriginFeedback(e.message, "error");
  }
}

  function bindInteractions({ bindButtonAction }) {
    bindButtonAction(document.getElementById("origin-probe-z"), runAutoZProbe);
    bindButtonAction(document.getElementById("origin-probe-3d"), openProbe3D);
    bindButtonAction(document.getElementById("probe-3d-close"), closeProbe3D);
    bindButtonAction(document.getElementById("probe-3d-cancel"), closeProbe3D);
    bindButtonAction(document.getElementById("probe-3d-run"), runProbe3D);
    document.getElementById("probe-3d-kind").onchange = renderProbe3DForm;
    for (const id of ["probe-3d-x", "probe-3d-y", "probe-3d-z", "probe-3d-diameter"]) {
      document.getElementById(id).oninput = renderProbe3DForm;
    }
    document.getElementById("probe-3d-modal").addEventListener("cancel", (e) => {
      e.preventDefault();
      closeProbe3D();
    });
    renderProbe3DForm();
    bindButtonAction(document.getElementById("origin-set-xyz-open"), () => openOriginDialog("origin-xyz-modal"));
    bindButtonAction(document.getElementById("origin-set-open"), () => openOriginDialog("origin-set-modal"));
    bindButtonAction(document.getElementById("origin-presets-open"), () => openOriginDialog("origin-presets-modal"));
    bindButtonAction(document.getElementById("origin-xyz-close"), () => closeOriginDialog("origin-xyz-modal"));
    bindButtonAction(document.getElementById("origin-set-close"), () => closeOriginDialog("origin-set-modal"));
    bindButtonAction(document.getElementById("origin-presets-close"), () => closeOriginDialog("origin-presets-modal"));
    for (const id of ["origin-xyz-x", "origin-xyz-y", "origin-xyz-z"]) {
      const input = document.getElementById(id);
      if (!input) continue;
      input.onkeydown = (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          applyXYZOrigin();
        }
      };
    }
    document.getElementById("origin-set-source").onchange = renderJog;
    for (const id of ["origin-set-x", "origin-set-y"]) {
      const input = document.getElementById(id);
      input.oninput = renderOriginSetChange;
      input.onkeydown = (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          applyOriginSource();
        }
      };
    }
    document.getElementById("saved-origin-select").onchange = renderJog;
    bindButtonAction(document.getElementById("origin-xyz-apply"), applyXYZOrigin);
    bindButtonAction(document.getElementById("origin-set-apply"), applyOriginSource);
    bindButtonAction(document.getElementById("saved-origin-recall"), recallSelectedOrigin);
    bindButtonAction(document.getElementById("saved-origin-save"), saveCurrentOrigin);
    bindButtonAction(document.getElementById("saved-origin-delete"), deleteSelectedOrigin);
  }

  return { bindInteractions, machineReadyForOriginSet, renderOriginButtons, setOriginFeedback, renderOriginSetSourceLabels, hasPendingOriginOperation, savedOrigins, selectedSavedOrigin, savedOriginLabel, renderSavedOriginSelect, saveCurrentOrigin, deleteSelectedOrigin, originCommandLine, formatOriginValue, originTargetsFromXYZ, originTargetsFromSaved, machineAnchorPoints, originTargetsFromOriginSource, originReferenceRequestFromInputs, renderOriginSetChange, originAxes, originTargetLabel, clearOriginVerification, beginOriginVerification, checkOriginVerification, scheduleOriginVerification, setOriginViaGcode, setReferenceOriginViaAPI, setReferenceOriginViaJog, sendNextJogOriginAxis, handleOriginAck, applyOriginTargets, setOriginAxis, openOriginDialog, closeOriginDialog, probe3DFieldRules, probe3DInitialPositioning, probe3DTravelPreflight, probe3DLearnedTravelBounds, probe3DPreflightFromControls, renderProbe3DForm, probe3DNumber, probe3DRequestFromControls, openProbe3D, closeProbe3D, runProbe3D, applyXYZOrigin, applyOriginSource, runAutoZProbe, recallSelectedOrigin };
}
