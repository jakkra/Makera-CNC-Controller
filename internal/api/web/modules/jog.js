// Mechanical extraction from app.js; bodies preserved verbatim inside the feature owner.
export const JOG_INPUT_HEARTBEAT_MS = 100;
export const JOG_INPUT_DEADZONE = 0.12;
export const SURFACE_MPG_DETENT_DEG = 15;
export const SURFACE_MPG_DEAD_ZONE = 0.24;
export const SURFACE_MPG_AUDIO_LOOKAHEAD_S = 0.01;
export function surfaceMPGPointerSample(clientX, clientY, rect) { const width = Math.max(1, Number(rect?.width || 0)); const height = Math.max(1, Number(rect?.height || 0)); const dx = Number(clientX) - (Number(rect?.left || 0) + width / 2); const dy = Number(clientY) - (Number(rect?.top || 0) + height / 2); return { angle: Math.atan2(dy, dx) * 180 / Math.PI, radius: Math.hypot(dx, dy) / (Math.min(width, height) / 2) }; }
export function surfaceMPGAngleDelta(previous, current) { return ((Number(current) - Number(previous) + 540) % 360) - 180; }
export function sameJogAxes(a, b) { return ["x", "y", "z", "a"].every((axis) => Number(a?.[axis] || 0) === Number(b?.[axis] || 0)); }
export function sameJogInput(a, b) { return !!a && !!b && a.deadman === b.deadman && a.slow === b.slow && sameJogAxes(a.axes, b.axes); }
export function jogInputActive(input) { return !!input?.deadman && ["x", "y", "z", "a"].some((axis) => Math.abs(Number(input.axes?.[axis] || 0)) > JOG_INPUT_DEADZONE); }

export function syncJogAvailabilityFromMachine(machine, jog, movementOwnedElsewhere = () => false) {
  if (!jog?.caps?.enabled) return;
  if (movementOwnedElsewhere()) return;
  if (jog.armed && (machine.state === "Idle" || machine.state === "Run")) {
    jog.availability = { available: true, message: "Jog session active." };
    if (jog.errorCode === "status_waiting") {
      jog.error = "";
      jog.errorCode = "";
    }
    return;
  }
  const hasMPos = !!machine.mpos && ["x", "y", "z"].some((axis) => Number.isFinite(Number(machine.mpos[axis])));
  const stale = !!machine.stale || Number(machine.age_ms) > 10000;
  let availability;
  if (stale || !machine.state || machine.state === "Unknown") {
    availability = { available: false, reason: "stale_status", message: "Machine status is stale. Wait for a fresh Idle status before jogging." };
  } else if (machine.state !== "Idle") {
    availability = { available: false, reason: "not_idle", message: `Machine is ${machine.state}. Jogging requires fresh Idle status.` };
  } else if (!hasMPos) {
    availability = { available: false, reason: "stale_status", message: "Machine position is unavailable. Wait for a status report with MPos before jogging." };
  } else {
    availability = { available: true, message: "Ready to arm jog." };
  }
  jog.availability = availability;
  const error = jog.errorCode || jog.error;
  const transient = ["busy", "not_idle", "stale_status", "controller_waiting", "machine_error"].includes(error) || String(error || "").toLowerCase().includes("machine left joggable state") || String(error || "").toLowerCase().includes("machine is not ready") || String(error || "").toLowerCase().includes("not idle") || String(error || "").toLowerCase().includes("status is too stale") || String(error || "").toLowerCase().includes("controller requested the machine");
  if (availability.available && transient) {
    jog.error = "";
    jog.errorCode = "";
  }
}

export function movementArmAvailable(jog, machineReadyForOriginSet = () => false, movementOwnedElsewhere = () => false) {
  if (jog.armed || movementOwnedElsewhere()) return true;
  if (!jog.caps?.enabled || jog.link !== "online" || !machineReadyForOriginSet()) return false;
  return !jog.availability || jog.availability.available !== false;
}

export function movementArmLabel(jog = {}) {
  if (jog.armPending) return jog.armPendingAction === "arm" ? "Arming..." : "Disarming...";
  if (jog.armQueuedAction) return "Connecting...";
  if (jog.armed) return "Disarm Movement";
  if (jog.availability?.reason === "busy") return "Disarm other controller";
  return "Arm Movement";
}

export function createJogFeature({ jogState, surfaceState, documentRef = globalThis.document, windowRef = globalThis, WebSocketCtor = windowRef.WebSocket, performanceRef = globalThis.performance, setTimeoutRef = globalThis.setTimeout, clearTimeoutRef = globalThis.clearTimeout, renderJog, renderMachine, renderSurfaceMPGWheel, setStatusMessage, applyJogEvent, failOutlineCaptureIntents, completeCommandDisarm, cancelWorkCoordinateMove, clearFieldProbeMove, hasPendingOriginOperation, originTargetLabel, clearOriginVerification, setOriginFeedback, tapMoveArmFailureText, toggleTapMoveArm, connectURL = null, clampAxis: clampAxisRef, currentGamepad, mappedAxis, buttonStates, buttonPressed, gamepadLabel, captureGamepadOutlineButton, handleGamepadOutlineButton, handleGamepadMacroButtons, sameButtonStates, resetMobileWorkAreaJog, getWorkarea, getUI, surfaceJogReady, sendSurfaceStep, stepZ } = {}) {
  const state = { jog: jogState, surface: surfaceState, get ui() { return getUI?.() || {}; }, get workarea() { return getWorkarea?.() || {}; } }; const document = documentRef; const window = windowRef; const WebSocket = WebSocketCtor; const performance = performanceRef; const setTimeout = setTimeoutRef; const clearTimeout = clearTimeoutRef; const setStatus = setStatusMessage; const clampAxis = clampAxisRef || ((v) => Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0); const SURFACE_MPG_AUDIO_LOOKAHEAD_S = 0.01; const AudioContextCtor = windowRef.AudioContext || windowRef.webkitAudioContext; const navigatorRef = windowRef.navigator; let surfaceMPGAudioContext = null; let surfaceMPGAudioResume = null; let surfaceMPGNextClickTime = 0; let surfaceMPGFeedbackTimer = null;
  function jogURL() { return connectURL || ((window.location?.protocol === "https:" ? "wss:" : "ws:") + "//" + window.location?.host + "/api/jog/ws"); }
  function clearJogReconnect() { if (state.jog.reconnectTimer) { clearTimeout(state.jog.reconnectTimer); state.jog.reconnectTimer = null; } }
  function connectJog() {
    // Capabilities are authoritative. Do not create a WebSocket until they are
    // known, and never enter the reconnect loop when the server has disabled
    // jogging. A disabled feature is a stable UI state, not an operator error.
    if (!state.jog.caps) {
      state.jog.link = "checking";
      renderJog();
      return;
    }
    if (!state.jog.caps.enabled) {
      disableJogConnection();
      renderJog();
      return;
    }
    if (!("WebSocket" in window)) {
      state.jog.link = "unsupported";
      state.jog.error = "WebSocket unavailable";
      renderJog();
      return;
    }
    const existing = state.jog.ws;
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) return;
    clearJogReconnect();
    const ws = new WebSocket(jogURL());
    state.jog.ws = ws;
    state.jog.link = "connecting";
    renderJog();
    ws.onopen = () => {
      if (state.jog.ws !== ws) return;
      state.jog.link = "online";
      state.jog.reconnectAttempt = 0;
      state.jog.error = "";
      state.jog.errorCode = "";
      resetJogInputSender();
      renderJog();
    };
    ws.onclose = () => {
      if (state.jog.ws !== ws) return;
      state.jog.ws = null;
      state.jog.link = "offline";
      state.jog.armed = false;
      clearDisconnectedJogInput();
      state.jog.disarmAfterPendingArm = false;
      state.jog.sent.clear();
      failOutlineCaptureIntents("movement connection closed before the position was captured");
      resetJogInputSender();
      completeCommandDisarm(state.jog.commandDisarm?.seq, "Movement disconnected before the command.");
      if (state.jog.armQueuedAction) {
        const action = state.jog.armQueuedAction;
        state.jog.armQueuedAction = "";
        state.jog.tapFeedback = tapMoveArmFailureText(action, "jog service disconnected");
        state.jog.tapFeedbackKind = "error";
      }
      if (state.jog.armPending) {
        const action = state.jog.armPendingAction;
        state.jog.armPending = 0;
        state.jog.armPendingAction = "";
        state.jog.tapFeedback = tapMoveArmFailureText(action, "jog service disconnected");
        state.jog.tapFeedbackKind = "error";
      }
      if (state.jog.targetPending || state.jog.targetMotionPending) {
        state.jog.targetPending = 0;
        state.jog.targetMotionPending = 0;
        cancelWorkCoordinateMove();
        clearFieldProbeMove();
        state.jog.tapFeedback = "Move failed: jog service disconnected.";
        state.jog.tapFeedbackKind = "error";
      }
      if (state.jog.zStepPending) {
        state.jog.zStepPending = 0;
        state.jog.tapFeedback = "Z move failed: jog service disconnected.";
        state.jog.tapFeedbackKind = "error";
      }
      if (state.jog.surfaceStepPending) {
        state.jog.surfaceStepPending = 0;
        setStatusMessage("surface-jog", "Jog failed: jog service disconnected.", "error", { force: true });
      }
      if (state.jog.originPendingMode === "jog" && hasPendingOriginOperation()) {
        const label = originTargetLabel(state.jog.originPendingLabel, state.jog.originPendingTargets);
        clearOriginVerification();
        setOriginFeedback("Set " + label + " failed: jog service disconnected.", "error");
      }
      renderJog();
      scheduleJogReconnect();
    };
    ws.onerror = () => {
      if (state.jog.ws !== ws) return;
      state.jog.error = "jog socket error";
      state.jog.errorCode = "";
      renderJog();
      try {
        ws.close();
      } catch {
        // Browser will report the close asynchronously.
      }
    };
    ws.onmessage = (e) => {
      if (state.jog.ws !== ws) return;
      try {
        applyJogEvent(JSON.parse(e.data));
      } catch (err) {
        state.jog.error = "bad jog event: " + err.message;
        state.jog.errorCode = "";
        renderJog();
      }
    };
  }
  
  function disableJogConnection() {
    clearJogReconnect();
    const ws = state.jog.ws;
    state.jog.ws = null;
    state.jog.link = "disabled";
    state.jog.armed = false;
    state.jog.armQueuedAction = "";
    state.jog.error = "";
    state.jog.errorCode = "";
    clearDisconnectedJogInput();
    if (ws) {
      try {
        ws.close(1000, "jogging disabled");
      } catch {
        // The socket may already be closing; clearing our reference is enough.
      }
    }
  }
  
  function scheduleJogReconnect() {
    if (!state.jog.caps?.enabled) {
      clearJogReconnect();
      return;
    }
    if (state.jog.reconnectTimer || document.hidden) return;
    const attempt = Math.min(state.jog.reconnectAttempt++, 5);
    const delay = Math.min(10000, 500 * 2 ** attempt);
    state.jog.link = "reconnecting";
    renderJog();
    state.jog.reconnectTimer = setTimeout(() => {
      state.jog.reconnectTimer = null;
      connectJog();
    }, delay);
  }
  
  function sameJogInput(a, b) {
    return !!a && !!b && a.deadman === b.deadman && a.slow === b.slow && sameJogAxes(a.axes, b.axes);
  }
  
  function jogInputActive(input) {
    return !!input?.deadman && ["x", "y", "z", "a"].some((axis) => Math.abs(Number(input.axes?.[axis] || 0)) > JOG_INPUT_DEADZONE);
  }
  
  function resetJogInputSender() {
    state.jog.lastInput = null;
    state.jog.lastInputSentAt = 0;
  }
  
  function clearDisconnectedJogInput() {
    resetMobileWorkAreaJog();
    state.jog.surfaceInput = null;
    if (state.jog.surfaceWheel) {
      state.jog.surfaceWheel.pointerId = null;
      state.jog.surfaceWheel.lastAngle = null;
      state.jog.surfaceWheel.remainder = 0;
      state.jog.surfaceWheel.gestureSteps = 0;
      state.jog.surfaceWheel.gestureAccepted = 0;
      state.jog.surfaceWheel.gestureReleased = false;
      state.jog.surfaceWheel.gestureAxis = "";
      state.jog.surfaceWheel.blocked = false;
    }
    state.jog.pad = "";
    state.jog.deadman = false;
    state.jog.axes = { x: 0, y: 0, z: 0, a: 0 };
    state.jog.buttons = [];
    state.jog.surfaceStepSource = "";
    resetJogInputSender();
  }
  
  function sendJogInput(msg, force = false) {
    const ws = state.jog.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connectJog();
      return 0;
    }
  
    const input = {
      type: "input",
      deadman: !!msg.deadman,
      slow: !!msg.slow,
      axes: {
        x: clampAxis(Number(msg.axes?.x || 0)),
        y: clampAxis(Number(msg.axes?.y || 0)),
        z: clampAxis(Number(msg.axes?.z || 0)),
      },
    };
    const now = performance.now();
    const previous = state.jog.lastInput;
    const changed = !sameJogInput(previous, input);
    const urgentStop = jogInputActive(previous) && !jogInputActive(input);
    const heartbeatDue = jogInputActive(input) && now - Number(state.jog.lastInputSentAt || 0) >= JOG_INPUT_HEARTBEAT_MS;
    if (!force && !changed && !heartbeatDue) return 0;
  
    // Gamepad intent is latest-wins. Never build a browser-side train of stale
    // active samples behind a congested WebSocket; the next sample retries the
    // newest axes. A stop always enters the socket immediately and therefore
    // sits behind at most the one frame the browser has already handed off.
    if (!force && !urgentStop && Number(ws.bufferedAmount || 0) > 0) return 0;
    input.seq = msg.seq || state.jog.seq++;
    ws.send(JSON.stringify(input));
    state.jog.lastInput = input;
    state.jog.lastInputSentAt = now;
    return input.seq;
  }
  
  function sendJog(msg, force = false) {
    if (msg.type === "input") return sendJogInput(msg, force);
    const ws = state.jog.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connectJog();
      return 0;
    }
    if (!msg.seq) msg.seq = state.jog.seq++;
    state.jog.sent.set(msg.seq, performance.now());
    ws.send(JSON.stringify(msg));
    return msg.seq;
  }
  
  function sampleJog() {
    try {
      if (state.jog.inputSuspended) {
        const changed = releaseJogInput();
        if (changed) renderJog();
        return;
      }
      if (state.jog.surfaceInput) {
        const { axis, sign } = state.jog.surfaceInput;
        const axes = { x: axis === "x" ? sign : 0, y: axis === "y" ? sign : 0, z: axis === "z" ? sign : 0, a: axis === "a" ? sign : 0 };
        state.jog.pad = "Surface";
        state.jog.deadman = true;
        state.jog.axes = axes;
        if (state.jog.armed) sendJog({ type: "input", deadman: true, axes });
        return;
      }
      if (state.workarea?.mobileJogActive) {
        const axes = state.workarea.mobileJogAxes || { x: 0, y: 0, z: 0 };
        state.jog.pad = "Touch";
        state.jog.deadman = true;
        state.jog.axes = axes;
        if (state.jog.armed) sendJog({ type: "input", deadman: true, axes });
        return;
      }
      const gp = currentGamepad();
      if (!gp) {
        const changed = releaseJogInput();
        if (changed) renderJog();
        return;
      }
      const gamepad = state.ui.gamepad;
      const axes = {
        x: mappedAxis(gp, "x"),
        y: mappedAxis(gp, "y"),
        z: mappedAxis(gp, "z"),
      };
      const buttons = buttonStates(gp);
      const deadman = buttonPressed(gp, gamepad.deadman_button);
      const slow = gamepad.slow_buttons.some((btn) => buttonPressed(gp, btn));
      const label = gamepadLabel(gp);
      const changed = state.jog.preferredPadIndex !== gp.index ||
        state.jog.pad !== label ||
        state.jog.deadman !== deadman ||
        !sameJogAxes(state.jog.axes, axes) ||
        !sameButtonStates(state.jog.buttons, buttons);
      state.jog.preferredPadIndex = gp.index;
      state.jog.pad = label;
      state.jog.deadman = deadman;
      state.jog.axes = axes;
      const capturingOutlineButton = captureGamepadOutlineButton(buttons);
      // The stop/latest input frame must precede a point-capture request on the
      // WebSocket. This makes a release+button press in one sampled gamepad frame
      // freeze the endpoint of the released motion, never the previous position.
      if (state.jog.armed) sendJog({ type: "input", deadman, axes, slow });
      handleGamepadOutlineButton(buttons, capturingOutlineButton);
      handleGamepadMacroButtons(buttons, deadman);
      state.jog.buttons = buttons;
      if (changed) renderJog();
    } catch (e) {
      state.jog.error = "gamepad read failed: " + e.message;
      renderJog();
    } finally {
      scheduleJogSample();
    }
  }
  
  function releaseJogInput(force = false) {
    const touchChanged = resetMobileWorkAreaJog();
    const surfaceChanged = !!state.jog.surfaceInput;
    state.jog.surfaceInput = null;
    const changed = touchChanged || surfaceChanged || !!state.jog.pad || !!state.jog.deadman ||
      !sameJogAxes(state.jog.axes, { x: 0, y: 0, z: 0, a: 0 }) ||
      (Array.isArray(state.jog.buttons) && state.jog.buttons.length > 0);
    state.jog.pad = "";
    state.jog.deadman = false;
    state.jog.axes = { x: 0, y: 0, z: 0, a: 0 };
    state.jog.buttons = [];
    if (state.jog.armed && (force || changed || jogInputActive(state.jog.lastInput))) {
      sendJog({ type: "input", deadman: false, axes: state.jog.axes }, true);
    }
    return changed;
  }
  
  function scheduleJogSample() {
    if (state.jog.sampleTimer) return;
    const ms = Math.max(8, Number(state.jog.caps?.tick_ms) || 20);
    state.jog.sampleTimer = setTimeout(() => {
      state.jog.sampleTimer = null;
      sampleJog();
    }, ms);
  }
  
  function prepareSurfaceMPGFeedback() {
    if (!AudioContextCtor) return null;
    try {
      if (!surfaceMPGAudioContext) surfaceMPGAudioContext = new AudioContextCtor({ latencyHint: "interactive" });
      if (surfaceMPGAudioContext.state !== "running" && !surfaceMPGAudioResume) {
        surfaceMPGAudioResume = Promise.resolve(surfaceMPGAudioContext.resume?.())
          .catch(() => null)
          .then(() => surfaceMPGAudioContext)
          .finally(() => { surfaceMPGAudioResume = null; });
      }
    } catch {
      surfaceMPGAudioContext = null;
      surfaceMPGAudioResume = null;
    }
    return surfaceMPGAudioContext;
  }
  
  function playSurfaceMPGClick(audio) {
    if (!audio || audio.state !== "running") return false;
    const now = audio.currentTime;
    // Browser/WebAudio can receive several acknowledgement callbacks inside one
    // render turn. Space the physical feedback pulses so they remain audible as
    // distinct detents instead of summing into one nearly silent transient.
    // Starting exactly at currentTime can miss the first audio render quantum in
    // Firefox. The oscillator then joins after the fast fade has already begun,
    // making an otherwise identical click sound randomly quiet. A tiny fixed
    // lead gives every pulse the same full attack without adding perceptible lag.
    const start = Math.max(now + SURFACE_MPG_AUDIO_LOOKAHEAD_S, surfaceMPGNextClickTime);
    surfaceMPGNextClickTime = start + 0.03;
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = "square";
    oscillator.frequency.setValueAtTime(900, start);
    // Keep each detent equally prominent; system volume remains the operator's
    // overall loudness control.  This is deliberately twice the original level
    // for the comparatively quiet Surface speakers.
    gain.gain.setValueAtTime(0.15, start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.026);
    oscillator.connect(gain);
    gain.connect(audio.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.027);
    return true;
  }
  
  function pulseSurfaceMPGDetent(wheel) {
    try {
      navigatorRef?.vibrate?.(8);
    } catch {
      // Vibration is optional and is not exposed by most desktop hardware.
    }
    const audio = prepareSurfaceMPGFeedback();
    if (!playSurfaceMPGClick(audio) && surfaceMPGAudioResume) {
      const resume = surfaceMPGAudioResume;
      resume.then((resumedAudio) => { playSurfaceMPGClick(resumedAudio); }).catch(() => {});
    }
    if (!wheel) return;
    wheel.classList.add("is-detent");
    if (surfaceMPGFeedbackTimer) clearTimeout(surfaceMPGFeedbackTimer);
    surfaceMPGFeedbackTimer = setTimeout(() => {
      wheel.classList.remove("is-detent");
      surfaceMPGFeedbackTimer = null;
    }, 55);
  }
  
  function finishSurfaceMPGGesture() {
    const gesture = state.jog.surfaceWheel;
    if (!gesture.gestureReleased || state.jog.surfaceStepPending) return false;
    if (!gesture.blocked && gesture.gestureAccepted > 0) {
      const noun = gesture.gestureAccepted === 1 ? "increment" : "increments";
      setStatusMessage(
        "surface-jog",
        `MPG ${gesture.gestureAxis.toUpperCase()}: ${gesture.gestureAccepted} ${noun} accepted.`,
        "ok",
        { force: true },
      );
    }
    gesture.gestureSteps = 0;
    gesture.gestureAccepted = 0;
    gesture.gestureReleased = false;
    gesture.gestureAxis = "";
    gesture.blocked = false;
    return true;
  }
  
  function bindSurfaceMPGWheel() {
    const wheel = document.getElementById("surface-mpg-wheel");
    if (!wheel) return;
    const release = (e) => {
      if (state.jog.surfaceWheel.pointerId !== e.pointerId) return;
      state.jog.surfaceWheel.pointerId = null;
      state.jog.surfaceWheel.lastAngle = null;
      state.jog.surfaceWheel.remainder = 0;
      state.jog.surfaceWheel.gestureReleased = true;
      finishSurfaceMPGGesture();
      renderSurfaceMPGWheel();
      renderMachine();
    };
    const retainPointerCapture = (e) => {
      if (state.jog.surfaceWheel.pointerId !== e.pointerId) return;
      // Chrome can transiently drop capture while relaying a fast touch gesture.
      // Reclaim it while the pointer is still held; pointerup/cancel remains the
      // terminal path and is also observed on window below.
      if (e.buttons) {
        try {
          wheel.setPointerCapture?.(e.pointerId);
          return;
        } catch {
          // The window-level release handlers below cover a capture failure.
        }
      }
      release(e);
    };
    wheel.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !surfaceJogReady()) return;
      const sample = surfaceMPGPointerSample(e.clientX, e.clientY, wheel.getBoundingClientRect());
      if (sample.radius < SURFACE_MPG_DEAD_ZONE) return;
      state.jog.surfaceWheel.pointerId = e.pointerId;
      state.jog.surfaceWheel.lastAngle = sample.angle;
      state.jog.surfaceWheel.remainder = 0;
      state.jog.surfaceWheel.gestureSteps = 0;
      state.jog.surfaceWheel.gestureAccepted = 0;
      state.jog.surfaceWheel.gestureReleased = false;
      state.jog.surfaceWheel.gestureAxis = state.surface.mpg_axis;
      state.jog.surfaceWheel.blocked = false;
      prepareSurfaceMPGFeedback();
      wheel.setPointerCapture?.(e.pointerId);
      e.preventDefault();
      renderSurfaceMPGWheel();
    });
    wheel.addEventListener("pointermove", (e) => {
      if (state.jog.surfaceWheel.pointerId !== e.pointerId) return;
      if (state.jog.surfaceWheel.blocked) return;
      const sample = surfaceMPGPointerSample(e.clientX, e.clientY, wheel.getBoundingClientRect());
      if (sample.radius < SURFACE_MPG_DEAD_ZONE) {
        state.jog.surfaceWheel.lastAngle = null;
        return;
      }
      if (!Number.isFinite(state.jog.surfaceWheel.lastAngle)) {
        state.jog.surfaceWheel.lastAngle = sample.angle;
        return;
      }
      const delta = surfaceMPGAngleDelta(state.jog.surfaceWheel.lastAngle, sample.angle);
      state.jog.surfaceWheel.lastAngle = sample.angle;
      state.jog.surfaceWheel.angle = (Number(state.jog.surfaceWheel.angle || 0) + delta + 360) % 360;
      state.jog.surfaceWheel.remainder += delta;
      while (Math.abs(state.jog.surfaceWheel.remainder) >= SURFACE_MPG_DETENT_DEG) {
        const sign = state.jog.surfaceWheel.remainder > 0 ? 1 : -1;
        state.jog.surfaceWheel.remainder -= SURFACE_MPG_DETENT_DEG * sign;
        if (state.surface.mpg_feedback === "detent") pulseSurfaceMPGDetent(wheel);
        if (!state.jog.surfaceStepPending && sendSurfaceStep(state.jog.surfaceWheel.gestureAxis, sign, "mpg")) {
          state.jog.surfaceWheel.gestureSteps++;
          state.jog.surfaceWheel.value += sign;
          if (state.surface.mpg_feedback !== "detent") pulseSurfaceMPGDetent(wheel);
        } else {
          if (!state.jog.surfaceStepPending) state.jog.surfaceWheel.remainder = 0;
        }
      }
      renderSurfaceMPGWheel();
    });
    wheel.addEventListener("pointerup", release);
    wheel.addEventListener("pointercancel", release);
    wheel.addEventListener("lostpointercapture", retainPointerCapture);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    wheel.addEventListener("keydown", (e) => {
      if (!["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft"].includes(e.key)) return;
      e.preventDefault();
      const sign = ["ArrowUp", "ArrowRight"].includes(e.key) ? 1 : -1;
      if (state.jog.surfaceStepPending) return;
      prepareSurfaceMPGFeedback();
      if (sendSurfaceStep(state.surface.mpg_axis, sign)) {
        state.jog.surfaceWheel.value += sign;
        state.jog.surfaceWheel.angle = (Number(state.jog.surfaceWheel.angle || 0) + SURFACE_MPG_DETENT_DEG * sign + 360) % 360;
        pulseSurfaceMPGDetent(wheel);
      }
      renderSurfaceMPGWheel();
    });
  }
  function bindZStepInteractions({ bindButtonAction, stepZ: stepZHandler = stepZ } = {}) {
    for (const btn of document.querySelectorAll("[data-z-step-dir]")) {
      bindButtonAction(btn, () => stepZHandler(Number(btn.dataset.zStepDir) || 1));
    }
  }
  function bindJogArmInteractions({ bindButtonAction, toggleTapMoveArm: toggle = toggleTapMoveArm } = {}) {
    bindButtonAction(document.getElementById("jog-arm"), toggle);
  }
  return { connectJog, disableJogConnection, scheduleJogReconnect, resetJogInputSender, sendJogInput, sendJog, sampleJog, releaseJogInput, scheduleJogSample, finishSurfaceMPGGesture, bindSurfaceMPGWheel, bindZStepInteractions, bindJogArmInteractions, cleanup() { releaseJogInput(true); disableJogConnection(); } };
}

