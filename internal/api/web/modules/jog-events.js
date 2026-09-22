// Applies movement service events to shared controller state. Browser timing, DOM access,
// and app-specific lifecycle effects are injected so behavior remains testable.
export function createJogEventHandler({ state, documentRef, performanceRef, callbacks = {} } = {}) {
  const {
    flushQueuedTapMoveArm,
    resetJogInputSender,
    clearDisarmedMovementState,
    clearNotice,
    reconcileObservedMachineStatus,
    mergeMachineStatusForDisplay,
    resolveOutlineCaptureIntent,
    tapMoveArmSuccessText,
    requestMovementDisarm,
    completeCommandDisarm,
    finishSurfaceMPGGesture,
    setStatusMessage,
    beginOriginVerification,
    clearOriginVerification,
    setOriginFeedback,
    handleOriginAck,
    completeWorkCoordinateMove,
    clearFieldProbeMove,
    renderJog,
    renderOutlineCapture,
    jogErrorText,
    tapMoveArmFailureText,
    cancelWorkCoordinateMove,
    originTargetLabel,
    hasPendingOriginOperation,
    deferSurfaceMPGMachineRender,
    renderSurfaceMPGWheel,
    renderMachine,
  } = callbacks;

  function applyJogEvent(ev) {
    let machineChanged = false;
    let surfaceMPGOnly = false;
    if (ev.type === "hello" && ev.capabilities) {
      state.jog.motionStreamRevision = (Number(state.jog.motionStreamRevision) || 0) + 1;
      state.jog.motionRevision = 0;
      state.jog.settledMotionRevision = 0;
      state.jog.motionRevisionKnown = false;
      state.jog.caps = ev.capabilities;
      state.jog.availability = ev.capabilities.availability || null;
      if (state.jog.availability?.available && state.jog.errorCode === "busy") {
        state.jog.error = "";
        state.jog.errorCode = "";
      }
      flushQueuedTapMoveArm();
    } else if (ev.type === "state") {
      const wasArmed = state.jog.armed;
      const armed = !!ev.armed;
      if (state.jog.armed !== armed) resetJogInputSender();
      state.jog.armed = armed;
      if (wasArmed && !armed) {
        clearDisarmedMovementState();
        if (!ev.seq && !state.jog.armPending) {
          state.jog.tapFeedback = "Movement disarmed.";
          state.jog.tapFeedbackKind = "ok";
        }
      }
      if (ev.availability) {
        state.jog.availability = ev.availability;
        if (ev.availability.available) {
          state.jog.error = "";
          state.jog.errorCode = "";
        } else if (ev.availability.reason && !state.jog.armed) {
          state.jog.error = "";
          state.jog.errorCode = "";
        }
      }
    } else if (ev.type === "status" && ev.status) {
      clearNotice("machine-status");
      state.jog.statusRevision = (Number(state.jog.statusRevision) || 0) + 1;
      const motionRevision = Number(ev.status.motion_revision);
      const settledMotionRevision = Number(ev.status.settled_motion_revision);
      if (Number.isFinite(motionRevision) && Number.isFinite(settledMotionRevision)) {
        state.jog.motionRevisionKnown = true;
        state.jog.motionRevision = Math.max(Number(state.jog.motionRevision) || 0, motionRevision);
        state.jog.settledMotionRevision = Math.max(Number(state.jog.settledMotionRevision) || 0, settledMotionRevision);
      }
      const nextMachine = {
        ...state.machine,
        state: ev.status.state || state.machine.state,
        age_ms: ev.status.age_ms,
        observed_at: ev.status.observed_at || state.machine.observed_at,
        raw: ev.status.raw || state.machine.raw,
        mpos: ev.status.mpos || state.machine.mpos,
        wpos: ev.status.wpos || state.machine.wpos,
        motion_estimated: false,
        connected: true,
      };
      state.machine = ev.status.mpos ? reconcileObservedMachineStatus(nextMachine) : mergeMachineStatusForDisplay(nextMachine);
      machineChanged = true;
      if ((ev.status.state === "Idle" || ev.status.state === "Run") && state.jog.errorCode === "status_waiting") {
        state.jog.error = "";
        state.jog.errorCode = "";
      } else if (ev.status.state === "Idle") {
        state.jog.error = "";
        state.jog.errorCode = "";
      }
    } else if (ev.type === "motion" && ev.motion) {
      const motionRevision = Number(ev.motion.revision);
      if (Number.isFinite(motionRevision)) {
        state.jog.motionRevisionKnown = true;
        state.jog.motionRevision = Math.max(Number(state.jog.motionRevision) || 0, motionRevision);
      }
      const predicted = ev.motion.estimated || ev.motion.observed || ev.motion.target;
      if (!state.jog.targetMotionPending) state.jog.target = ev.motion.target || state.jog.target;
      state.jog.mpos = predicted || state.jog.mpos;
      state.jog.wpos = ev.motion.estimated_wpos || state.jog.wpos;
      state.jog.observed = ev.motion.observed || state.jog.observed;
      state.jog.estimated = !!ev.motion.estimated;
      if (state.jog.estimated && Number(ev.motion.queue_lead_ms) > 0) {
        state.jog.estimatedUntil = performanceRef.now() + Number(ev.motion.queue_lead_ms) + 75;
      } else if (!state.jog.estimated) {
        state.jog.estimatedUntil = 0;
      }
      state.jog.lead = ev.motion.lead || state.jog.lead;
      if (predicted) {
        state.jog.path.push(predicted);
        if (state.jog.path.length > 80) state.jog.path.shift();
      }
      if (predicted) {
        state.machine = {
          ...state.machine,
          mpos: predicted,
          wpos: ev.motion.estimated_wpos || state.machine.wpos,
          motion_estimated: !!ev.motion.estimated,
        };
        machineChanged = true;
      }
    } else if (ev.type === "position_capture" && ev.position) {
      state.jog.sent.delete(ev.seq);
      resolveOutlineCaptureIntent(ev.seq, ev.position);
    } else if (ev.type === "ack") {
      const sent = state.jog.sent.get(ev.seq);
      if (sent) {
        documentRef.getElementById("jog-latency").textContent = Math.round(performanceRef.now() - sent) + "ms";
        state.jog.sent.delete(ev.seq);
      }
      if (ev.seq && ev.seq === state.jog.armPending) {
        const action = state.jog.armPendingAction;
        const armed = action === "arm";
        const disarmAfterArm = armed && state.jog.disarmAfterPendingArm;
        if (state.jog.armed !== armed) resetJogInputSender();
        state.jog.armed = armed;
        state.jog.armPending = 0;
        state.jog.armPendingAction = "";
        if (action === "disarm") {
          // The server releases the jog lease and cancels any pending target as
          // part of disarm. Mirror that lifecycle locally so a target whose
          // completion was never observed cannot keep tap movement busy after
          // the operator disarms and arms again.
          clearDisarmedMovementState();
        }
        state.jog.tapFeedback = tapMoveArmSuccessText(action);
        state.jog.tapFeedbackKind = "ok";
        if (disarmAfterArm) {
          state.jog.disarmAfterPendingArm = false;
          requestMovementDisarm();
        }
      }
      completeCommandDisarm(ev.seq);
      if (ev.seq && (ev.seq === state.jog.targetPending || ev.seq === state.jog.targetMotionPending)) {
        state.jog.targetPending = 0;
        state.jog.target = ev.target || state.jog.target;
        state.jog.tapFeedback = "Moving to " + state.jog.targetLabel + "...";
        state.jog.tapFeedbackKind = "";
      }
      if (ev.seq && ev.seq === state.jog.zStepPending) {
        state.jog.zStepPending = 0;
        state.jog.tapFeedback = "Z move sent: " + state.jog.zStepLabel;
        state.jog.tapFeedbackKind = "";
      }
      if (ev.seq && ev.seq === state.jog.surfaceStepPending) {
        const source = state.jog.surfaceStepSource;
        state.jog.surfaceStepPending = 0;
        state.jog.surfaceStepSource = "";
        if (source === "mpg") {
          state.jog.surfaceWheel.gestureAccepted++;
          finishSurfaceMPGGesture();
          surfaceMPGOnly = true;
        } else {
          setStatusMessage("surface-jog", state.jog.zStepLabel + " accepted.", "ok", { force: true });
        }
      }
      if (ev.seq && ev.seq === state.jog.originPending) {
        if (state.jog.originPendingMode === "jog-reference") {
          state.jog.originPending = 0;
          state.jog.originPendingAxis = "";
          state.jog.originPendingTargets = ev.target || null;
          if (state.jog.originPendingTargets) beginOriginVerification();
          else {
            const label = state.jog.originPendingLabel;
            clearOriginVerification();
            setOriginFeedback("Set " + label + " failed: machine did not return an origin verification target.", "error");
          }
        } else {
          handleOriginAck();
        }
      }
      state.jog.error = "";
      state.jog.errorCode = "";
    } else if (ev.type === "target_complete") {
      if (ev.seq && ev.seq === state.jog.targetMotionPending) {
        state.jog.targetPending = 0;
        state.jog.targetMotionPending = 0;
        state.jog.target = ev.target || state.jog.target;
        completeWorkCoordinateMove(ev.seq);
        clearFieldProbeMove(ev.seq);
        state.jog.tapFeedback = "Reached " + state.jog.targetLabel + ".";
        state.jog.tapFeedbackKind = "ok";
      }
    } else if (ev.type === "error") {
      const terminalSessionError = ev.code !== "status_waiting";
      if (!terminalSessionError) {
        // A delayed status reply is an internal retry state, not an operator
        // warning and not a terminal result for any pending movement action.
        if (state.jog.errorCode === "status_waiting") {
          state.jog.error = "";
          state.jog.errorCode = "";
        }
        renderJog();
        renderOutlineCapture();
        return;
      }
      if (ev.seq && resolveOutlineCaptureIntent(ev.seq, null, ev.message || jogErrorText(ev.code))) {
        state.jog.sent.delete(ev.seq);
        renderJog();
        return;
      }
      completeCommandDisarm(ev.seq, ev.message || jogErrorText(ev.code));
      if (ev.seq && ev.seq === state.jog.armPending) {
        const action = state.jog.armPendingAction;
        state.jog.armPending = 0;
        state.jog.armPendingAction = "";
        state.jog.disarmAfterPendingArm = false;
        state.jog.tapFeedback = tapMoveArmFailureText(action, ev.message || jogErrorText(ev.code));
        state.jog.tapFeedbackKind = "error";
      }
      if (!ev.seq && terminalSessionError && state.jog.armQueuedAction) {
        const action = state.jog.armQueuedAction;
        state.jog.armQueuedAction = "";
        state.jog.tapFeedback = tapMoveArmFailureText(action, ev.message || jogErrorText(ev.code));
        state.jog.tapFeedbackKind = "error";
      }
      if (ev.seq && (ev.seq === state.jog.targetPending || ev.seq === state.jog.targetMotionPending)) {
        state.jog.targetPending = 0;
        state.jog.targetMotionPending = 0;
        cancelWorkCoordinateMove(ev.seq);
        clearFieldProbeMove(ev.seq);
        state.jog.tapFeedback = "Move failed: " + (ev.message || jogErrorText(ev.code));
        state.jog.tapFeedbackKind = "error";
      }
      if (ev.seq && ev.seq === state.jog.zStepPending) {
        state.jog.zStepPending = 0;
        state.jog.tapFeedback = "Z move failed: " + (ev.message || jogErrorText(ev.code));
        state.jog.tapFeedbackKind = "error";
      }
      if (ev.seq && ev.seq === state.jog.surfaceStepPending) {
        const source = state.jog.surfaceStepSource;
        state.jog.surfaceStepPending = 0;
        state.jog.surfaceStepSource = "";
        if (source === "mpg") state.jog.surfaceWheel.blocked = true;
        setStatusMessage("surface-jog", "Jog failed: " + (ev.message || jogErrorText(ev.code)), "error", { force: true });
      }
      if (ev.seq && ev.seq === state.jog.originPending) {
        const label = originTargetLabel(state.jog.originPendingLabel, state.jog.originPendingTargets);
        clearOriginVerification();
        setOriginFeedback("Set " + label + " failed: " + (ev.message || jogErrorText(ev.code)), "error");
      }
      if (!ev.seq && terminalSessionError && (state.jog.targetPending || state.jog.targetMotionPending)) {
        state.jog.targetPending = 0;
        state.jog.targetMotionPending = 0;
        cancelWorkCoordinateMove();
        clearFieldProbeMove();
        state.jog.tapFeedback = "Move failed: " + (ev.message || jogErrorText(ev.code));
        state.jog.tapFeedbackKind = "error";
      }
      if (!ev.seq && terminalSessionError && state.jog.zStepPending) {
        state.jog.zStepPending = 0;
        state.jog.tapFeedback = "Z move failed: " + (ev.message || jogErrorText(ev.code));
        state.jog.tapFeedbackKind = "error";
      }
      if (!ev.seq && terminalSessionError && state.jog.surfaceStepPending) {
        const source = state.jog.surfaceStepSource;
        state.jog.surfaceStepPending = 0;
        state.jog.surfaceStepSource = "";
        if (source === "mpg") state.jog.surfaceWheel.blocked = true;
        setStatusMessage("surface-jog", "Jog failed: " + (ev.message || jogErrorText(ev.code)), "error", { force: true });
      }
      if (!ev.seq && terminalSessionError && state.jog.originPendingMode === "jog" && hasPendingOriginOperation()) {
        const label = originTargetLabel(state.jog.originPendingLabel, state.jog.originPendingTargets);
        clearOriginVerification();
        setOriginFeedback("Set " + label + " failed: " + (ev.message || jogErrorText(ev.code)), "error");
      }
      if (!ev.seq && terminalSessionError && state.jog.armPending) {
        const action = state.jog.armPendingAction;
        state.jog.armPending = 0;
        state.jog.armPendingAction = "";
        state.jog.disarmAfterPendingArm = false;
        state.jog.tapFeedback = tapMoveArmFailureText(action, ev.message || jogErrorText(ev.code));
        state.jog.tapFeedbackKind = "error";
      }
      state.jog.errorCode = ev.code || "";
      state.jog.error = ev.message || ev.code || "jog error";
      if (ev.code === "controller_waiting" || ev.code === "not_idle" || ev.code === "stale_status") {
        state.jog.armed = false;
        clearDisarmedMovementState();
      }
    }
    if (machineChanged) {
      if (deferSurfaceMPGMachineRender()) renderSurfaceMPGWheel();
      else renderMachine();
    }
    else if (surfaceMPGOnly) renderSurfaceMPGWheel();
    else {
      renderJog();
      renderOutlineCapture();
    }
  }

  return applyJogEvent;
}
