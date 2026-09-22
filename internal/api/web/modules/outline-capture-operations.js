export function createOutlineCaptureOperations({ state, constants = {}, callbacks = {}, performanceRef = globalThis.performance, setTimeoutRef = globalThis.setTimeout, DateRef = Date }) {
  const {
    JOG_INPUT_DEADZONE, OUTLINE_CAPTURE_SETTLE_MS, OUTLINE_CAPTURE_POLL_MS,
    OUTLINE_CAPTURE_TIMEOUT_MS,
  } = constants;
  const {
    currentOutlineCapturePosition, cancelOutlineCaptureIntents, defaultOutlineState,
    markGcodeContextOverlayDirty, finiteOr, cloneFloorProbe, cloneOutlineOrigin,
    currentWorkOrigin, renderOutlineCapture, renderWorkArea, jogInputActive,
    tapMoveTargetBusy, hasPendingOriginOperation, jogEstimateActive,
    outlineCapturePositionsClose, pushOutlineUndo, newID, clearFieldProbeData,
    clearNotice, setStatusMessage, resetJogInputSender, sendJog, setOutlineFeedback,
    confirm, resolveOutlineCaptureIntent,
  } = callbacks;
  const waitForPosition = callbacks.waitForOutlineCapturePosition || ((options) => waitForOutlineCapturePosition(options));
  const dateISO = () => new DateRef().toISOString();

  function startOutlineCapture() {
    const current = state.outline;
    const keepCurveFit = !!current.curveFit;
    const floorZ = finiteOr(current.floorMachineZ, NaN);
    const floorProbe = cloneFloorProbe(current.floorProbe);
    const pos = currentOutlineCapturePosition();
    cancelOutlineCaptureIntents(current);
    state.outline = defaultOutlineState();
    markGcodeContextOverlayDirty();
    state.outline.active = true;
    state.outline.curveFit = keepCurveFit;
    if (Number.isFinite(floorZ)) {
      state.outline.floorMachineZ = floorZ;
      state.outline.floorProbe = floorProbe;
    }
    state.outline.origin = cloneOutlineOrigin(pos?.origin || currentWorkOrigin());
    if (Number.isFinite(floorZ)) {
      state.outline.origin = state.outline.origin || {};
      state.outline.origin.z = floorZ;
    }
    state.outline.feedback = "Outline capture started.";
    state.outline.feedbackKind = "ok";
    renderOutlineCapture();
    renderWorkArea();
  }

  function endOutlineCapture() {
    const current = state.outline;
    if (current.points.length && !confirm("End outline capture and clear the captured outline?")) return;
    const keepCurveFit = !!current.curveFit;
    const floorZ = finiteOr(current.floorMachineZ, NaN);
    const floorProbe = cloneFloorProbe(current.floorProbe);
    cancelOutlineCaptureIntents(current);
    state.outline = defaultOutlineState();
    markGcodeContextOverlayDirty();
    state.outline.curveFit = keepCurveFit;
    if (Number.isFinite(floorZ)) {
      state.outline.floorMachineZ = floorZ;
      state.outline.floorProbe = floorProbe;
    }
    state.outline.feedback = "Outline cleared.";
    renderOutlineCapture();
    renderWorkArea();
  }

  function outlineCaptureMotionPending() {
    const j = state.jog;
    const liveInput = jogInputActive(j.lastInput) || (!!j.deadman && ["x", "y", "z"].some((axis) => Math.abs(Number(j.axes?.[axis] || 0)) > JOG_INPUT_DEADZONE));
    return tapMoveTargetBusy() ||
      !!j.fieldProbeMovePending ||
      !!j.zStepPending ||
      !!j.zProbePending ||
      !!j.probe3DPending ||
      hasPendingOriginOperation() ||
      liveInput ||
      !!state.machine.motion_estimated ||
      jogEstimateActive();
  }

  async function waitForOutlineCapturePosition(options = {}) {
    const now = options.now || (() => performanceRef.now());
    const delay = options.delay || ((ms) => new Promise((resolve) => setTimeoutRef(resolve, ms)));
    const settleMS = finiteOr(options.settleMS, OUTLINE_CAPTURE_SETTLE_MS);
    const pollMS = finiteOr(options.pollMS, OUTLINE_CAPTURE_POLL_MS);
    const timeoutMS = finiteOr(options.timeoutMS, OUTLINE_CAPTURE_TIMEOUT_MS);
    let requiredRevision = Number.isFinite(Number(options.afterRevision)) ? Number(options.afterRevision) : -1;
    const requireMotionSettlement = Number.isFinite(Number(options.afterMotionRevision)) && Number(options.afterMotionRevision) >= 0;
    let requiredMotionRevision = Number.isFinite(Number(options.afterMotionRevision))
      ? Number(options.afterMotionRevision)
      : (Number(state.jog.motionRevision) || 0);
    let requiredMotionStream = Number.isFinite(Number(options.afterMotionStream))
      ? Number(options.afterMotionStream)
      : (Number(state.jog.motionStreamRevision) || 0);
    const startedAt = now();
    let stablePosition = null;
    let stableSince = null;
    while (now() - startedAt <= timeoutMS) {
      const revision = Number(state.jog.statusRevision) || 0;
      const revisionKnown = !!state.jog.motionRevisionKnown;
      if (revisionKnown) {
        const motionStream = Number(state.jog.motionStreamRevision) || 0;
        if (motionStream !== requiredMotionStream) {
          requiredMotionStream = motionStream;
          requiredMotionRevision = Number(state.jog.motionRevision) || 0;
        } else {
          requiredMotionRevision = Math.max(requiredMotionRevision, Number(state.jog.motionRevision) || 0);
        }
      }
      const machineStillJogging = !!state.jog.armed && state.machine?.state !== "Idle";
      if (outlineCaptureMotionPending() || machineStillJogging) {
        // A position report observed before the predicted queue drained cannot
        // authorize a capture. Require the next report after motion clears.
        if (requiredRevision >= 0) requiredRevision = Math.max(requiredRevision, revision);
        stablePosition = null;
        stableSince = null;
      } else {
        const position = currentOutlineCapturePosition();
        const motionSettled = revisionKnown && Number(state.jog.settledMotionRevision || 0) >= requiredMotionRevision;
        const freshObservedPosition = motionSettled || (!requireMotionSettlement && (requiredRevision < 0 || revision > requiredRevision));
        if (position && freshObservedPosition) {
          // The jog server owns the planner queue and marks the exact motion
          // revision covered by a post-queue Idle position. Capture immediately
          // once that contract is satisfied, including a button press made while
          // the browser was still visually catching up.
          if (motionSettled || (!revisionKnown && requiredRevision >= 0)) return position;
          if (stablePosition && outlineCapturePositionsClose(stablePosition, position)) {
            if (stableSince !== null && now() - stableSince >= settleMS) return position;
          } else {
            stablePosition = position;
            stableSince = now();
          }
        }
      }
      await delay(pollMS);
    }
    throw new Error("motion did not settle before the outline capture timeout");
  }

  async function processOutlinePointQueue(o) {
    try {
      while (o.addPointQueued > 0) {
        o.addPointQueued--;
        const revisionKnown = !!state.jog.motionRevisionKnown;
        const afterRevision = state.jog.armed && !revisionKnown ? (Number(state.jog.statusRevision) || 0) : -1;
        const afterMotionRevision = revisionKnown ? (Number(state.jog.motionRevision) || 0) : -1;
        const afterMotionStream = Number(state.jog.motionStreamRevision) || 0;
        const pos = await waitForPosition({ afterRevision, afterMotionRevision, afterMotionStream });
        if (state.outline !== o || !o.active || o.closed) throw new Error("outline capture changed while waiting for motion to settle");
        const capture = {
          id: newID("outline-point"),
          x: pos.work.x,
          y: pos.work.y,
          z: pos.work.z,
          machine_x: pos.machine.x,
          machine_y: pos.machine.y,
          machine_z: pos.machine.z,
          captured_at: dateISO(),
        };
        pushOutlineUndo();
        o.active = true;
        if (!o.origin) o.origin = cloneOutlineOrigin(pos.origin);
        o.points.push(capture);
        clearFieldProbeData();
        clearNotice("outline-point");
        renderOutlineCapture();
        renderWorkArea();
      }
    } catch (e) {
      o.addPointQueued = 0;
      setStatusMessage("outline-point", "Add point failed: " + e.message, "error", { force: true });
    } finally {
      o.addPointPending = false;
      renderOutlineCapture();
      renderWorkArea();
    }
  }

  function failOutlineCaptureIntents(message) {
    const pending = [...(state.jog.outlineCaptureIntents || [])];
    for (const intent of pending) resolveOutlineCaptureIntent(intent.seq, null, message);
  }

  function requestOutlinePositionCapture(o) {
    const capturedAt = dateISO();
    const seq = sendJog({ type: "capture_position" });
    if (!seq) {
      setStatusMessage("outline-point", "Add point failed: movement connection is unavailable", "error", { force: true });
      return false;
    }
    if (!Array.isArray(state.jog.outlineCaptureIntents)) state.jog.outlineCaptureIntents = [];
    state.jog.outlineCaptureIntents.push({ seq, outline: o, capturedAt, resolved: false, position: null, error: "" });
    // Capture is a server-side stop boundary. Force the next sampled gamepad
    // input onto the wire so motion can resume immediately even if its axes are
    // numerically identical to the sample sent before the capture.
    resetJogInputSender();
    renderOutlineCapture();
    return true;
  }

  function addOutlinePoint() {
    const o = state.outline;
    if (!o.active) {
      setOutlineFeedback("Capture outline before adding points.", "error");
      return;
    }
    if (o.closed) {
      setOutlineFeedback("Undo close before adding another point.", "error");
      return;
    }
    if (o.fieldProbePending) return;
    if (state.jog.armed) {
      o.feedback = "";
      o.feedbackKind = "";
      requestOutlinePositionCapture(o);
      return;
    }
    o.addPointQueued = Math.min(32, (Number(o.addPointQueued) || 0) + 1);
    if (o.addPointPending) return;
    o.addPointPending = true;
    o.feedback = "";
    o.feedbackKind = "";
    renderOutlineCapture();
    processOutlinePointQueue(o);
  }

  return {
    startOutlineCapture,
    endOutlineCapture,
    outlineCaptureMotionPending,
    waitForOutlineCapturePosition,
    processOutlinePointQueue,
    failOutlineCaptureIntents,
    requestOutlinePositionCapture,
    addOutlinePoint,
  };
}
