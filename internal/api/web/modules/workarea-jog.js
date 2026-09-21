// Work-area pointer interaction and the touch jog state machine.  The module
// owns only interaction state; machine I/O and work-area/probe policy remain
// in the injected callbacks so extraction cannot change their contracts.

export function mobileWorkAreaJogEnabled(windowRef = globalThis, maxWidth = 600) {
  return typeof windowRef !== "undefined" && Number(windowRef?.innerWidth) <= maxWidth;
}

export function mobileJogAxisForResponse(value, clampAxis = (v) => Math.max(-1, Math.min(1, Number.isFinite(v) ? v : 0)), deadzone = 0.12) {
  value = clampAxis(value);
  if (Math.abs(value) < 1e-6) return 0;
  const sign = value < 0 ? -1 : 1;
  return sign * (deadzone + (1 - deadzone) * Math.cbrt(Math.abs(value)));
}

export function mobileWorkAreaJogAxes(originX, originY, clientX, clientY, radiusPX, clampAxis, deadzone = 0.12) {
  const radius = Math.max(1, Number(radiusPX) || 1);
  const dx = Number(clientX) - Number(originX);
  const dy = Number(clientY) - Number(originY);
  const distance = Math.hypot(dx, dy);
  const scale = distance > radius ? radius / distance : 1;
  return {
    x: mobileJogAxisForResponse((dx * scale) / radius, clampAxis, deadzone),
    y: mobileJogAxisForResponse((-dy * scale) / radius, clampAxis, deadzone),
    z: 0,
  };
}

export function mobileWorkAreaJogRadius(svg, clampNumber = (value, min, max) => Math.max(min, Math.min(max, value)), minRadius = 56, maxRadius = 88) {
  const rect = svg?.getBoundingClientRect?.();
  const size = Math.min(Number(rect?.width) || 0, Number(rect?.height) || 0);
  return clampNumber(size * 0.22, minRadius, maxRadius);
}

export function createWorkAreaJogFeature({
  state,
  documentRef = globalThis.document,
  windowRef = globalThis,
  constants = {},
  clampNumber,
  clampAxis,
  pathNum,
  workAreaSVGPointFromClient,
  workAreaLocalToContentPoint,
  workAreaToMachinePoint,
  sendTapMove,
  sendJog,
  connectJog,
  setTapFeedback,
  renderJog,
  jogInputActive,
  tapMoveTargetBusy,
  hasPendingOriginOperation,
  selectedFieldProbePoint,
  selectFieldProbePoint,
  updateSelectedFieldProbeDrag,
  restoreSelectedFieldProbePosition,
  finishSelectedFieldProbeMove,
  moveSelectedFieldProbePointBy,
  panWorkArea,
  renderWorkArea,
  updateWorkAreaHoverPosition,
  hideWorkAreaHoverPosition,
}) {
  const document = documentRef;
  const window = windowRef;
  const {
    MOBILE_WORKAREA_MAX_WIDTH_PX = 600,
    MOBILE_JOG_RADIUS_MIN_PX = 56,
    MOBILE_JOG_RADIUS_MAX_PX = 88,
    JOG_INPUT_DEADZONE = 0.12,
    WORKAREA_ZOOM_STEP = 1.25,
    WORKAREA_PAN_THRESHOLD_PX = 4,
  } = constants;

  function isMobileWorkAreaJogEnabled() {
    return mobileWorkAreaJogEnabled(window, MOBILE_WORKAREA_MAX_WIDTH_PX);
  }

  function mobileWorkAreaActionsOpen() {
    return !!document.getElementById("workarea-actions-panel")?.classList.contains("is-open");
  }

  function mobileWorkAreaJogReady() {
    return isMobileWorkAreaJogEnabled() &&
      !mobileWorkAreaActionsOpen() &&
      state.activeTab === "control" &&
      state.jog.link === "online" &&
      state.jog.armed &&
      !state.jog.inputSuspended &&
      !tapMoveTargetBusy() &&
      !state.jog.fieldProbeMovePending &&
      !state.jog.zStepPending &&
      !state.jog.zProbePending &&
      !state.jog.probe3DPending &&
      !hasPendingOriginOperation() &&
      !state.outline.fieldProbePointMovePending &&
      !state.outline.fieldProbePending;
  }

  function getMobileWorkAreaJogRadius(svg) {
    return mobileWorkAreaJogRadius(svg, clampNumber, MOBILE_JOG_RADIUS_MIN_PX, MOBILE_JOG_RADIUS_MAX_PX);
  }

  function setMobileWorkAreaJogVisual(origin, knob, radiusPX) {
    const svg = document.getElementById("workarea-plot");
    const group = document.getElementById("workarea-mobile-jog");
    if (!svg || !group || !origin || !knob) return;
    const ctm = svg.getScreenCTM?.();
    const screenScale = ctm ? Math.hypot(Number(ctm.a) || 0, Number(ctm.b) || 0) : 0;
    const radius = screenScale > 0 ? radiusPX / screenScale : 18;
    const base = group.querySelector(".mobile-jog-base");
    const line = group.querySelector(".mobile-jog-line");
    const handle = group.querySelector(".mobile-jog-knob");
    base?.setAttribute("cx", pathNum(origin.x));
    base?.setAttribute("cy", pathNum(origin.y));
    base?.setAttribute("r", pathNum(radius));
    line?.setAttribute("x1", pathNum(origin.x));
    line?.setAttribute("y1", pathNum(origin.y));
    line?.setAttribute("x2", pathNum(knob.x));
    line?.setAttribute("y2", pathNum(knob.y));
    handle?.setAttribute("cx", pathNum(knob.x));
    handle?.setAttribute("cy", pathNum(knob.y));
    group.removeAttribute("display");
    svg.classList.add("mobile-jogging");
  }

  function resetMobileWorkAreaJog(e = null) {
    const v = state.workarea;
    if (e && v.mobileJogPointerId !== e.pointerId) return false;
    const wasActive = !!v.mobileJogActive;
    const pointerId = v.mobileJogPointerId;
    v.mobileJogPointerId = null;
    v.mobileJogOriginClientX = 0;
    v.mobileJogOriginClientY = 0;
    v.mobileJogOriginLocal = null;
    v.mobileJogKnobLocal = null;
    v.mobileJogRadiusPX = 0;
    v.mobileJogAxes = { x: 0, y: 0, z: 0 };
    v.mobileJogActive = false;
    const svg = document.getElementById("workarea-plot");
    const group = document.getElementById("workarea-mobile-jog");
    group?.setAttribute("display", "none");
    svg?.classList.remove("mobile-jogging");
    if (svg && pointerId !== null) {
      try {
        svg.releasePointerCapture(pointerId);
      } catch {
        // Pointer capture may already have been released by the browser.
      }
    }
    return wasActive;
  }

  function startMobileWorkAreaJog(e, local) {
    if (!mobileWorkAreaJogReady()) return false;
    if (e.target?.closest?.("#workarea-actions-toggle, #workarea-actions-panel")) return false;
    const svg = document.getElementById("workarea-plot");
    if (!svg || !local) return false;
    const stopped = { x: 0, y: 0, z: 0 };
    if (!sendJog({ type: "input", deadman: true, axes: stopped }, true)) {
      setTapFeedback("Jog service is not connected.", "error");
      e.preventDefault();
      return true;
    }
    const v = state.workarea;
    v.mobileJogPointerId = e.pointerId;
    v.mobileJogOriginClientX = e.clientX;
    v.mobileJogOriginClientY = e.clientY;
    v.mobileJogOriginLocal = { x: local.x, y: local.y };
    v.mobileJogKnobLocal = { x: local.x, y: local.y };
    v.mobileJogRadiusPX = getMobileWorkAreaJogRadius(svg);
    v.mobileJogAxes = stopped;
    v.mobileJogActive = true;
    state.jog.pad = "Touch";
    state.jog.deadman = true;
    state.jog.axes = stopped;
    setMobileWorkAreaJogVisual(v.mobileJogOriginLocal, v.mobileJogKnobLocal, v.mobileJogRadiusPX);
    try {
      svg.setPointerCapture(e.pointerId);
    } catch {
      // Pointer capture is best-effort; cancellation paths still force a stop.
    }
    e.preventDefault();
    renderJog();
    return true;
  }

  function updateMobileWorkAreaJog(e) {
    const v = state.workarea;
    if (!v?.mobileJogActive || v.mobileJogPointerId !== e.pointerId) return false;
    const wasMoving = jogInputActive({ deadman: true, axes: v.mobileJogAxes });
    const axes = mobileWorkAreaJogAxes(
      v.mobileJogOriginClientX,
      v.mobileJogOriginClientY,
      e.clientX,
      e.clientY,
      v.mobileJogRadiusPX,
      clampAxis,
      JOG_INPUT_DEADZONE,
    );
    const dx = e.clientX - v.mobileJogOriginClientX;
    const dy = e.clientY - v.mobileJogOriginClientY;
    const distance = Math.hypot(dx, dy);
    const scale = distance > v.mobileJogRadiusPX ? v.mobileJogRadiusPX / distance : 1;
    const knob = workAreaSVGPointFromClient({
      clientX: v.mobileJogOriginClientX + dx * scale,
      clientY: v.mobileJogOriginClientY + dy * scale,
    });
    v.mobileJogAxes = axes;
    if (knob) v.mobileJogKnobLocal = knob;
    state.jog.deadman = true;
    state.jog.axes = axes;
    sendJog({ type: "input", deadman: true, axes });
    setMobileWorkAreaJogVisual(v.mobileJogOriginLocal, v.mobileJogKnobLocal, v.mobileJogRadiusPX);
    e.preventDefault();
    const moving = jogInputActive({ deadman: true, axes });
    if (moving !== wasMoving) renderJog();
    return true;
  }

  function stopMobileWorkAreaJog(e = null) {
    const v = state.workarea;
    if (!v?.mobileJogActive || (e && v.mobileJogPointerId !== e.pointerId)) return false;
    resetMobileWorkAreaJog(e);
    state.jog.pad = "";
    state.jog.deadman = false;
    state.jog.axes = { x: 0, y: 0, z: 0, a: 0 };
    if (state.jog.armed) sendJog({ type: "input", deadman: false, axes: state.jog.axes }, true);
    e?.preventDefault?.();
    renderJog();
    return true;
  }

  function handleWorkAreaTap(local) {
    if (isMobileWorkAreaJogEnabled()) return;
    const target = workAreaToMachinePoint(workAreaLocalToContentPoint(local));
    if (!target) return;
    sendTapMove(target);
  }

  function handleWorkAreaPointerDown(e) {
    if (typeof e.button === "number" && e.button !== 0) return;
    const svg = document.getElementById("workarea-plot");
    const local = workAreaSVGPointFromClient(e);
    if (!svg || !local) return;
    if (startMobileWorkAreaJog(e, local)) return;
    updateWorkAreaHoverPosition(local);
    const v = state.workarea;
    v.pointerId = e.pointerId;
    v.pointerStartX = local.x;
    v.pointerStartY = local.y;
    v.pointerLastX = local.x;
    v.pointerLastY = local.y;
    v.clientStartX = e.clientX;
    v.clientStartY = e.clientY;
    v.tapLocal = { x: local.x, y: local.y };
    v.tapProbeID = String(e.target?.dataset?.fieldProbeId || "");
    const selected = selectedFieldProbePoint();
    v.probeDragID = selected && selected.id === v.tapProbeID && !state.outline.fieldProbePointMovePending && !state.outline.fieldProbePending
      ? selected.id
      : "";
    v.probeDragOriginal = v.probeDragID ? { id: selected.id, x: selected.x, y: selected.y, fieldProbeComplete: !!state.outline.fieldProbeComplete } : null;
    v.probeDragging = false;
    v.dragging = false;
    try {
      svg.setPointerCapture(e.pointerId);
    } catch {
      // Pointer capture is best-effort; pointerup still handles ordinary clicks.
    }
    e.preventDefault();
  }

  function handleWorkAreaPointerMove(e) {
    if (updateMobileWorkAreaJog(e)) return;
    const v = state.workarea;
    const svg = document.getElementById("workarea-plot");
    const local = workAreaSVGPointFromClient(e);
    if (!svg || !local) return;
    if (!v || v.pointerId !== e.pointerId) {
      updateWorkAreaHoverPosition(local);
      return;
    }
    const moved = Math.hypot(e.clientX - v.clientStartX, e.clientY - v.clientStartY);
    if (!v.dragging && moved > WORKAREA_PAN_THRESHOLD_PX) {
      v.dragging = true;
      v.probeDragging = !!v.probeDragID;
      svg.classList.add(v.probeDragging ? "moving-probe" : "panning");
    }
    if (v.dragging) {
      if (v.probeDragging) updateSelectedFieldProbeDrag(local);
      else panWorkArea(local.x - v.pointerLastX, local.y - v.pointerLastY);
      v.pointerLastX = local.x;
      v.pointerLastY = local.y;
      updateWorkAreaHoverPosition(local);
      e.preventDefault();
    } else {
      updateWorkAreaHoverPosition(local);
    }
  }

  function clearWorkAreaPointer(e) {
    const v = state.workarea;
    if (!v || (e && v.pointerId !== e.pointerId)) return;
    const svg = document.getElementById("workarea-plot");
    if (svg) {
      svg.classList.remove("panning");
      svg.classList.remove("moving-probe");
      if (e) {
        try {
          svg.releasePointerCapture(e.pointerId);
        } catch {
          // The browser may already have released capture.
        }
      }
    }
    v.pointerId = null;
    v.dragging = false;
    v.tapLocal = null;
    v.tapProbeID = "";
    v.probeDragID = "";
    v.probeDragOriginal = null;
    v.probeDragging = false;
  }

  function handleWorkAreaPointerUp(e) {
    if (stopMobileWorkAreaJog(e)) return;
    const v = state.workarea;
    if (!v || v.pointerId !== e.pointerId) return;
    const wasDragging = !!v.dragging;
    const wasProbeDrag = !!v.probeDragging;
    const local = wasDragging ? workAreaSVGPointFromClient(e) : v.tapLocal;
    const probeID = wasDragging ? "" : v.tapProbeID;
    const probeOriginal = wasProbeDrag ? v.probeDragOriginal : null;
    clearWorkAreaPointer(e);
    updateWorkAreaHoverPosition(local);
    e.preventDefault();
    if (wasProbeDrag) finishSelectedFieldProbeMove(probeOriginal);
    else if (!wasDragging && probeID) selectFieldProbePoint(probeID);
    else if (!wasDragging && local) handleWorkAreaTap(local);
  }

  function handleWorkAreaWheel(e) {
    const local = workAreaSVGPointFromClient(e);
    if (!local) return;
    e.preventDefault();
    const multiplier = e.deltaY < 0 ? WORKAREA_ZOOM_STEP : 1 / WORKAREA_ZOOM_STEP;
    // Zooming stays in the viewport owner; this callback is intentionally
    // injected so the interaction module does not duplicate view state.
    constants.zoomWorkArea(multiplier, local);
  }

  function bindWorkAreaInteractions() {
    const svg = document.getElementById("workarea-plot");
    if (!svg || svg.dataset.workareaBound === "true") return;
    svg.dataset.workareaBound = "true";
    svg.addEventListener("pointerdown", handleWorkAreaPointerDown);
    svg.addEventListener("pointermove", handleWorkAreaPointerMove);
    svg.addEventListener("pointerup", handleWorkAreaPointerUp);
    svg.addEventListener("pointerleave", hideWorkAreaHoverPosition);
    svg.addEventListener("pointercancel", (e) => {
      if (stopMobileWorkAreaJog(e)) return;
      const original = state.workarea?.probeDragOriginal;
      if (original) {
        restoreSelectedFieldProbePosition(original);
        renderWorkArea();
      }
      clearWorkAreaPointer(e);
      hideWorkAreaHoverPosition();
    });
    svg.addEventListener("lostpointercapture", (e) => {
      if (state.workarea?.mobileJogPointerId === e.pointerId) stopMobileWorkAreaJog(e);
    });
    window.addEventListener("pointerup", stopMobileWorkAreaJog);
    window.addEventListener("pointercancel", stopMobileWorkAreaJog);
    svg.addEventListener("wheel", handleWorkAreaWheel, { passive: false });
    svg.addEventListener("keydown", (e) => {
      const probeID = String(e.target?.dataset?.fieldProbeId || "");
      if (!probeID) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        selectFieldProbePoint(probeID);
        return;
      }
      if (probeID !== state.outline.fieldProbeSelectedID || !e.key.startsWith("Arrow")) return;
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === "ArrowLeft" ? -step : (e.key === "ArrowRight" ? step : 0);
      const dy = e.key === "ArrowDown" ? -step : (e.key === "ArrowUp" ? step : 0);
      moveSelectedFieldProbePointBy(dx, dy);
    });
  }

  return {
    mobileWorkAreaJogEnabled: isMobileWorkAreaJogEnabled,
    mobileWorkAreaActionsOpen,
    mobileWorkAreaJogReady,
    mobileJogAxisForResponse: (value) => mobileJogAxisForResponse(value, clampAxis, JOG_INPUT_DEADZONE),
    mobileWorkAreaJogAxes: (originX, originY, clientX, clientY, radiusPX) => mobileWorkAreaJogAxes(originX, originY, clientX, clientY, radiusPX, clampAxis, JOG_INPUT_DEADZONE),
    mobileWorkAreaJogRadius: getMobileWorkAreaJogRadius,
    setMobileWorkAreaJogVisual,
    resetMobileWorkAreaJog,
    startMobileWorkAreaJog,
    updateMobileWorkAreaJog,
    stopMobileWorkAreaJog,
    handleWorkAreaTap,
    handleWorkAreaPointerDown,
    handleWorkAreaPointerMove,
    handleWorkAreaPointerUp,
    handleWorkAreaWheel,
    clearWorkAreaPointer,
    bindWorkAreaInteractions,
  };
}
