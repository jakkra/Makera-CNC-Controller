// Surface machine actions. The factory deliberately accepts narrow state
// slices and callbacks so the composition root does not become the owner of
// Surface jog behavior.

export function createSurfaceActions({
  getMachine = () => ({}),
  getReadOnly = () => false,
  getAutoVacuumPending = () => false,
  setAutoVacuumPending = () => {},
  setVacuumMode = () => {},
  request,
  appendGcodeLine = () => {},
  clearNotice = () => {},
  setNotice = () => {},
  pollMachine = () => {},
  renderSurfaceQuickActions = () => {},
  dashboardOptionalNumber = () => null,
  setTimeoutRef = globalThis.setTimeout,
  movementOwnedElsewhere = () => false,
  confirmRef = globalThis.confirm,
  toggleTapMoveArm = () => {},
  getJog = () => ({}),
  surfaceJogBaseReady = () => false,
  surfaceJogReady = () => false,
  surfaceStepDistance = () => 1,
  surfaceStepUnit = (axis) => String(axis).toLowerCase() === "a" ? "°" : "mm",
  sendJog = () => 0,
  connectJog = () => {},
  setStatusMessage = () => {},
  renderJog = () => {},
  renderSurfaceMPGWheel = () => {},
  sendJogInput = () => {},
} = {}) {
  if (typeof request !== "function") throw new TypeError("request is required");

  async function setAutoVacuum(enabled) {
    const machine = getMachine() || {};
    const current = dashboardOptionalNumber(machine.spindle?.vacuum_mode);
    if (getAutoVacuumPending() || current === null || getReadOnly()) return;
    setAutoVacuumPending(true);
    renderSurfaceQuickActions();
    try {
      const response = await request("/api/outputs/auto-vacuum", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !!enabled }),
      });
      const result = await response.json();
      setVacuumMode(result.enabled ? 1 : 0);
      clearNotice("auto-vacuum");
      setTimeoutRef(pollMachine, 1200);
    } catch (e) {
      appendGcodeLine({ seq: "local-" + Date.now(), dir: "recv", source: "api", text: "error: " + e.message });
      setNotice("Auto Vacuum could not be updated: " + e.message, "error", "auto-vacuum");
    } finally {
      setAutoVacuumPending(false);
      renderSurfaceQuickActions();
    }
  }

  function toggleSurfaceMovementArm() {
    if (movementOwnedElsewhere() && !confirmRef("Another controller has armed movement. Disarm that session before taking control?")) return false;
    toggleTapMoveArm();
    return true;
  }

  function sendSurfaceStep(axis, sign, source = "button", explicitDistance = 0) {
    const jog = getJog();
    if (jog.surfaceStepPending) return false;
    if (!surfaceJogBaseReady()) {
      setStatusMessage("surface-jog", "Arm Movement after a fresh Idle status before jogging.", "error", { force: true });
      return false;
    }
    const magnitude = Number(explicitDistance) > 0 ? Number(explicitDistance) : surfaceStepDistance();
    const distance = magnitude * (sign < 0 ? -1 : 1);
    const seq = sendJog({ type: "step", axis, distance });
    if (!seq) {
      setStatusMessage("surface-jog", "Jog service is not connected.", "error", { force: true });
      connectJog();
      return false;
    }
    jog.surfaceStepPending = seq;
    jog.surfaceStepSource = source;
    jog.zStepLabel = `${axis.toUpperCase()}${distance >= 0 ? "+" : "−"} ${Math.abs(distance)}${surfaceStepUnit(axis) === "°" ? "°" : " mm"}`;
    if (source === "mpg") {
      if (!jog.surfaceWheel.gestureSteps) {
        setStatusMessage("surface-jog", `MPG ${axis.toUpperCase()} active...`, "", { timeoutMs: 0, force: true });
      }
      renderSurfaceMPGWheel();
    } else {
      setStatusMessage("surface-jog", "Sending " + jog.zStepLabel + "...", "", { timeoutMs: 0, force: true });
      renderJog();
    }
    return true;
  }

  function beginSurfaceHoldJog(axis, sign) {
    const jog = getJog();
    if (!surfaceJogReady()) {
      setStatusMessage("surface-jog", "Arm Movement after a fresh Idle status before jogging.", "error", { force: true });
      return false;
    }
    jog.surfaceInput = { axis, sign: sign < 0 ? -1 : 1 };
    jog.pad = "Surface";
    jog.deadman = true;
    jog.axes = {
      x: axis === "x" ? (sign < 0 ? -1 : 1) : 0,
      y: axis === "y" ? (sign < 0 ? -1 : 1) : 0,
      z: axis === "z" ? (sign < 0 ? -1 : 1) : 0,
      a: axis === "a" ? (sign < 0 ? -1 : 1) : 0,
    };
    setStatusMessage("surface-jog", "Jogging " + axis.toUpperCase() + "; release to stop.", "", { timeoutMs: 0, force: true });
    sendJogInput({ deadman: true, axes: jog.axes }, true);
    renderJog();
    return true;
  }

  function stopSurfaceHoldJog() {
    const jog = getJog();
    if (!jog.surfaceInput) return false;
    jog.surfaceInput = null;
    jog.pad = "";
    jog.deadman = false;
    jog.axes = { x: 0, y: 0, z: 0, a: 0 };
    if (jog.armed) sendJogInput({ deadman: false, axes: jog.axes }, true);
    clearNotice("surface-jog");
    renderJog();
    return true;
  }

  return {
    setAutoVacuum,
    toggleSurfaceMovementArm,
    sendSurfaceStep,
    beginSurfaceHoldJog,
    stopSurfaceHoldJog,
  };
}
