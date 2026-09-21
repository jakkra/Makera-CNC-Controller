export function createJogView({
  stateFacade,
  documentRef,
  jogPanelMessage = () => ({ text: "", kind: "" }),
  setStatusMessage = () => {},
  clearNotice = () => {},
  setTextIfChanged = () => {},
  movementArmLabel = () => "Arm Movement",
  hasPendingOriginOperation = () => false,
  movementArmAvailable = () => false,
  normalizeMachineSettings = (value) => value || {},
  feedBoundsFor = () => ({ min: 0, max: 0 }),
  finiteOr = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback,
  clampNumber = (value, min, max) => Math.max(min, Math.min(max, value)),
  controlLocallyOwned = () => false,
  tapMoveTargetBusy = () => false,
  renderWorkMoveControls = () => {},
  renderOriginButtons = () => {},
  consumeJogAlertFeedback = () => {},
  renderWorkArea = () => {},
  renderSurfaceJog = () => {},
  setSoftDisabled = () => {},
} = {}) {
  if (!stateFacade) throw new TypeError("stateFacade is required");
  const state = stateFacade;
  const document = documentRef;

  function renderJog() {
    const jog = state.jog;
    document.getElementById("jog-link").textContent = jog.link;
    document.getElementById("jog-pad").textContent = jog.pad || "-";
    const dead = document.getElementById("jog-deadman");
    dead.textContent = jog.deadman ? "on" : "off";
    dead.className = jog.deadman ? "on" : "";
    const message = jogPanelMessage();
    if (state.activeTab === "control" || state.activeTab === "jog") setStatusMessage("jog-availability", message.text, message.kind);
    else clearNotice("jog-availability");
    const arm = document.getElementById("jog-arm");
    setTextIfChanged(arm, movementArmLabel(jog));
    arm.classList.toggle("armed", jog.armed);
    arm.setAttribute("aria-pressed", jog.armed ? "true" : "false");
    const armBusy = !!jog.armPending || !!jog.armQueuedAction;
    const originBusy = hasPendingOriginOperation();
    const tapOperationBusy = originBusy || !!jog.zProbePending;
    arm.disabled = armBusy || tapOperationBusy || !movementArmAvailable();
    const feed = document.getElementById("tap-feed-mm-min");
    const machine = normalizeMachineSettings(state.ui.machine);
    const feedBounds = feedBoundsFor(machine);
    const feedValue = clampNumber(finiteOr(feed?.value, machine.tap_feed_mm_min), feedBounds.min, feedBounds.max);
    if (feed) {
      feed.min = String(Math.round(feedBounds.min));
      feed.max = String(Math.round(feedBounds.max));
      if (!controlLocallyOwned(feed)) feed.value = String(feedValue);
      feed.disabled = tapMoveTargetBusy() || !!jog.zStepPending || tapOperationBusy;
    }
    for (const button of document.querySelectorAll("[data-feed-step]")) {
      const step = Number(button.dataset.feedStep) || 0;
      button.disabled = !!feed?.disabled || (step < 0 && feedValue <= feedBounds.min) || (step > 0 && feedValue >= feedBounds.max);
    }
    renderWorkMoveControls(tapOperationBusy);
    renderOriginButtons();
    const zStepDistance = document.getElementById("z-step-distance");
    if (zStepDistance) zStepDistance.disabled = !!jog.zStepPending || tapMoveTargetBusy() || tapOperationBusy;
    const zStepReady = !!jog.caps?.enabled && jog.link === "online" && jog.armed && !jog.zStepPending && !tapMoveTargetBusy() && !tapOperationBusy;
    const zStepBusy = !!jog.zStepPending || tapMoveTargetBusy() || tapOperationBusy;
    for (const button of document.querySelectorAll("[data-z-step-dir]")) {
      button.disabled = zStepBusy;
      setSoftDisabled(button, !zStepBusy && !zStepReady);
    }
    consumeJogAlertFeedback("tap-move", jog, "tapFeedback", "tapFeedbackKind");
    const plot = document.getElementById("workarea-plot");
    if (plot) plot.classList.toggle("not-armed", !jog.armed);
    renderWorkArea();
    renderSurfaceJog();
  }

  return { renderJog };
}
