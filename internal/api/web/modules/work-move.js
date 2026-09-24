export function createWorkMoveInteractions({
  documentRef = globalThis.document,
  getCurrentAxisValues = () => ({ mpos: null, wpos: null }),
  getCurrentWorkOrigin = () => null,
  getMachineSettings = () => ({}),
  getDefaultMachineSettings = () => ({}),
  normalizeMachineSettings = (machine) => machine || {},
  getJogCaps = () => null,
  getJogLink = () => "",
  getJogArmed = () => false,
  getJogTargetPending = () => 0,
  getJogTargetMotionPending = () => 0,
  getJogZStepPending = () => 0,
  getJogWorkMovePending = () => 0,
  setJogWorkMovePending = () => {},
  getJogTarget = () => null,
  getJogObserved = () => null,
  getJogMpos = () => null,
  getMachineMpos = () => null,
  setJogTarget = () => {},
  setJogTargetPending = () => {},
  setJogTargetMotionPending = () => {},
  setJogTargetLabel = () => {},
  setJogZStepPending = () => {},
  setJogZStepLabel = () => {},
  setJogFeedback = () => {},
  axisValue = () => null,
  formatOriginValue = (value) => String(value),
  finiteOr = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback,
  feedBoundsFor = () => ({ min: 0, max: Number.MAX_SAFE_INTEGER }),
  clampNumber = (value, min, max) => Math.max(min, Math.min(max, value)),
  safeZForTapMove = () => 0,
  controlLocallyOwned = () => false,
  clearControlDrafts = () => {},
  hasPendingOriginOperation = () => false,
  jogErrorText = (error) => error || "",
  setTapFeedback = () => {},
  setSoftDisabled = () => {},
  connectJog = () => {},
  sendJog = () => 0,
  renderJog = () => {},
} = {}) {
  const document = documentRef;

  function currentTapFeed() {
    const input = document.getElementById("tap-feed-mm-min");
    const machine = getMachineSettings();
    const fallback = machine?.tap_feed_mm_min || getDefaultMachineSettings().tap_feed_mm_min;
    const bounds = feedBoundsFor(machine);
    const raw = String(input?.value ?? "").trim();
    const value = raw === "" ? NaN : Number(raw);
    if (!Number.isFinite(value)) {
      input?.setCustomValidity("Enter a feed rate.");
      input?.reportValidity?.();
      throw new Error("Feed must be a number.");
    }
    input?.setCustomValidity("");
    return clampNumber(finiteOr(value, fallback), bounds.min, bounds.max);
  }

  function workMoveInput(axis) {
    return document.getElementById("work-move-" + axis);
  }

  function workMoveField(axis) {
    return document.querySelector('[data-work-move-axis="' + axis + '"]');
  }

  function workMoveInputIsLive(input) {
    return input?.dataset.dirty !== "1";
  }

  function renderWorkMoveFieldState(axis, input) {
    const field = workMoveField(axis);
    const reset = document.querySelector('[data-work-move-reset="' + axis + '"]');
    const live = workMoveInputIsLive(input);
    if (field) {
      field.classList.toggle("is-live", live);
      field.classList.toggle("is-stale", !live);
      field.dataset.workMoveState = live ? "live" : "stale";
      field.title = live
        ? "Work " + axis.toUpperCase() + " follows the current coordinate."
        : "Work " + axis.toUpperCase() + " is edited; reset to follow the current coordinate.";
    }
    if (reset) {
      reset.disabled = live;
      reset.title = "Reset Work " + axis.toUpperCase() + " to current coordinate";
      reset.setAttribute("aria-label", reset.title);
    }
  }

  function tapMoveTargetBusy() {
    return !!getJogTargetPending() || !!getJogTargetMotionPending();
  }

  function renderWorkMoveControls(originBusy = hasPendingOriginOperation()) {
    const { wpos } = getCurrentAxisValues();
    const busy = tapMoveTargetBusy() || !!getJogZStepPending() || originBusy;
    for (const axis of ["x", "y", "z"]) {
      const input = workMoveInput(axis);
      if (!input) continue;
      const value = axisValue(wpos, axis);
      if (workMoveInputIsLive(input) && !controlLocallyOwned(input)) {
        input.value = value === null ? "" : formatOriginValue(value);
      }
      input.disabled = busy;
      renderWorkMoveFieldState(axis, input);
    }
    const btn = document.getElementById("work-move-send");
    if (!btn) return;
    const caps = getJogCaps();
    const ready = !!caps?.enabled && getJogLink() === "online" && getJogArmed() && !busy;
    btn.disabled = busy;
    setSoftDisabled(btn, !busy && !ready);
  }

  function workMoveTargetLabel(workTargets) {
    const parts = ["x", "y", "z"]
      .filter((axis) => Number.isFinite(Number(workTargets?.[axis])))
      .map((axis) => axis.toUpperCase() + " " + formatOriginValue(workTargets[axis]));
    return "W " + parts.join(" ");
  }

  function tapTargetLabel(target) {
    return `X ${target.x.toFixed(1)} Y ${target.y.toFixed(1)}`;
  }

  function resetWorkMoveInput(axis) {
    const input = workMoveInput(axis);
    if (!input) return;
    input.dataset.dirty = "0";
    renderWorkMoveControls();
  }

  function completeWorkCoordinateMove(seq) {
    if (!seq || seq !== getJogWorkMovePending()) return false;
    setJogWorkMovePending(0);
    clearControlDrafts("work-move-x", "work-move-y", "work-move-z");
    const { wpos } = getCurrentAxisValues();
    for (const axis of ["x", "y", "z"]) {
      const value = axisValue(wpos, axis);
      const input = workMoveInput(axis);
      if (input && value !== null) input.value = formatOriginValue(value);
    }
    return true;
  }

  function cancelWorkCoordinateMove(seq) {
    const pending = getJogWorkMovePending();
    if (!pending || (seq && seq !== pending)) return;
    setJogWorkMovePending(0);
  }

  function workMoveTargetsFromInputs() {
    const origin = getCurrentWorkOrigin();
    if (!origin) throw new Error("Current work origin is unavailable.");
    const machineTargets = {};
    const workTargets = {};
    for (const axis of ["x", "y", "z"]) {
      const input = workMoveInput(axis);
      const raw = String(input?.value || "").trim();
      if (raw === "") continue;
      const workValue = finiteOr(raw, NaN);
      if (!Number.isFinite(workValue)) throw new Error("Work " + axis.toUpperCase() + " must be a number.");
      const offset = axisValue(origin, axis);
      if (offset === null) throw new Error("Current " + axis.toUpperCase() + " work origin is unavailable.");
      machineTargets[axis] = workValue + offset;
      workTargets[axis] = workValue;
    }
    if (!Object.keys(machineTargets).length) throw new Error("Enter at least one work coordinate.");
    return { machineTargets, label: workMoveTargetLabel(workTargets) };
  }

  function sendWorkCoordinateMove() {
    const caps = getJogCaps();
    if (caps && !caps.enabled) {
      setTapFeedback(jogErrorText("disabled"), "error");
      return;
    }
    if (getJogLink() !== "online") {
      setTapFeedback("Jog service is not connected.", "error");
      connectJog();
      return;
    }
    if (!getJogArmed()) {
      setTapFeedback("Arm Movement before moving to work coordinates.", "error");
      return;
    }
    if (tapMoveTargetBusy() || getJogZStepPending() || hasPendingOriginOperation()) return;
    let move;
    try {
      move = workMoveTargetsFromInputs();
    } catch (e) {
      setTapFeedback(e.message, "error");
      return;
    }
    let feed;
    try {
      feed = currentTapFeed();
    } catch (e) {
      setTapFeedback(e.message, "error");
      return;
    }
    const machine = normalizeMachineSettings(getMachineSettings());
    const safeZEnabled = !machine.safe_z_disabled;
    const seq = sendJog({ type: "target", target: move.machineTargets, feed_mm_min: feed, safe_z_enabled: safeZEnabled, safe_z_mm: safeZForTapMove(machine) });
    if (!seq) {
      setTapFeedback("Jog service is not connected.", "error");
      return;
    }
    const base = getJogTarget() || getJogObserved() || getJogMpos() || getMachineMpos() || {};
    setJogTarget({ ...base, ...move.machineTargets });
    setJogTargetPending(seq);
    setJogTargetMotionPending(seq);
    setJogWorkMovePending(seq);
    setJogTargetLabel(move.label);
    setJogFeedback("Sending move to " + move.label + "...", "");
    renderJog();
  }

  function sendTapMove(target) {
    if (getJogLink() !== "online") {
      setTapFeedback("Jog service is not connected.", "error");
      connectJog();
      return;
    }
    if (!getJogArmed()) {
      setTapFeedback("Arm Movement before selecting a target.", "error");
      return;
    }
    if (tapMoveTargetBusy() || getJogZStepPending() || hasPendingOriginOperation()) return;
    let feed;
    try {
      feed = currentTapFeed();
    } catch (e) {
      setTapFeedback(e.message, "error");
      return;
    }
    const machine = normalizeMachineSettings(getMachineSettings());
    const safeZEnabled = !machine.safe_z_disabled;
    const label = tapTargetLabel(target);
    const seq = sendJog({ type: "target", target: { x: target.x, y: target.y }, feed_mm_min: feed, safe_z_enabled: safeZEnabled, safe_z_mm: safeZForTapMove(machine) });
    if (!seq) {
      setTapFeedback("Jog service is not connected.", "error");
      return;
    }
    const base = getJogTarget() || getJogObserved() || getJogMpos() || getMachineMpos() || {};
    setJogTarget({ ...base, x: target.x, y: target.y });
    setJogTargetPending(seq);
    setJogTargetMotionPending(seq);
    setJogTargetLabel(label);
    setJogFeedback("Sending target " + label + "...", "");
    renderJog();
  }

  function currentZStepDistance() {
    const value = Number(document.getElementById("z-step-distance")?.value);
    return [10, 1, 0.1, 0.01].includes(value) ? value : 1;
  }

  function zStepLabel(distance) {
    const sign = distance > 0 ? "+" : "-";
    const abs = Math.abs(distance);
    const text = abs >= 1 ? abs.toFixed(0) : (abs >= 0.1 ? abs.toFixed(1) : abs.toFixed(2));
    return "Z" + sign + " " + text + " mm";
  }

  function stepZ(dir) {
    const caps = getJogCaps();
    if (caps && !caps.enabled) {
      setTapFeedback(jogErrorText("disabled"), "error");
      return;
    }
    if (getJogLink() !== "online") {
      setTapFeedback("Jog service is not connected.", "error");
      connectJog();
      return;
    }
    if (!getJogArmed()) {
      setTapFeedback("Arm Movement before moving Z.", "error");
      return;
    }
    if (tapMoveTargetBusy() || getJogZStepPending() || hasPendingOriginOperation()) return;
    const distance = currentZStepDistance() * dir;
    const label = zStepLabel(distance);
    const seq = sendJog({ type: "step", axis: "z", distance });
    if (!seq) {
      setTapFeedback("Jog service is not connected.", "error");
      return;
    }
    setJogZStepPending(seq);
    setJogZStepLabel(label);
    setJogFeedback("Sending " + label + "...", "");
    renderJog();
  }

  function bindInteractions({
    bindButtonAction,
    workMoveInput: workMoveInputRef = workMoveInput,
    renderWorkMoveControls: renderWorkMoveControlsRef = renderWorkMoveControls,
    sendWorkCoordinateMove: sendWorkCoordinateMoveRef = sendWorkCoordinateMove,
    resetWorkMoveInput: resetWorkMoveInputRef = resetWorkMoveInput,
  } = {}) {
    for (const axis of ["x", "y", "z"]) {
      const input = workMoveInputRef(axis);
      input.oninput = () => {
        input.dataset.dirty = "1";
        renderWorkMoveControlsRef();
      };
      input.onkeydown = (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          sendWorkCoordinateMoveRef();
        }
      };
    }
    for (const button of document.querySelectorAll("[data-work-move-reset]")) {
      bindButtonAction(button, (event) => {
        event.preventDefault();
        resetWorkMoveInputRef(button.dataset.workMoveReset);
      });
    }
    bindButtonAction(document.getElementById("work-move-send"), sendWorkCoordinateMoveRef);
  }

  return {
    bindInteractions,
    currentTapFeed,
    workMoveInput,
    workMoveField,
    workMoveInputIsLive,
    renderWorkMoveFieldState,
    tapMoveTargetBusy,
    renderWorkMoveControls,
    workMoveTargetLabel,
    tapTargetLabel,
    resetWorkMoveInput,
    completeWorkCoordinateMove,
    cancelWorkCoordinateMove,
    workMoveTargetsFromInputs,
    sendWorkCoordinateMove,
    sendTapMove,
    currentZStepDistance,
    zStepLabel,
    stepZ,
  };
}
