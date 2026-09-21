// Surface jog presentation and local preferences. Machine actions stay in
// app.js/jog.js; this module only owns the stable DOM projection and the
// per-device view choices around those actions.

export const SURFACE_VIEW_PREFERENCES_KEY = "cnc-proxy.surface-view-preferences.v1";

export function defaultSurfaceViewPreferences() {
  return {
    auto_switch: true,
    start_view: "jog",
    method: "directional",
    motion: "step",
    step_mm: 1,
    mpg_axis: "x",
    mpg_feedback: "confirmed",
    position_space: "work",
  };
}

export function loadSurfaceViewPreferences({ storage, key = SURFACE_VIEW_PREFERENCES_KEY } = {}) {
  const fallback = defaultSurfaceViewPreferences();
  try {
    const preferenceStorage = storage === undefined ? globalThis.localStorage : storage;
    const raw = preferenceStorage?.getItem?.(key);
    if (!raw) return fallback;
    const saved = JSON.parse(raw);
    return {
      auto_switch: saved?.auto_switch !== false,
      start_view: ["jog", "active-job", "dashboard"].includes(saved?.start_view) ? saved.start_view : fallback.start_view,
      method: saved?.method === "mpg" ? "mpg" : "directional",
      motion: saved?.motion === "hold" ? "hold" : "step",
      step_mm: [10, 1, 0.1, 0.01].includes(Number(saved?.step_mm)) ? Number(saved.step_mm) : fallback.step_mm,
      mpg_axis: ["x", "y", "z", "a"].includes(saved?.mpg_axis) ? saved.mpg_axis : fallback.mpg_axis,
      mpg_feedback: saved?.mpg_feedback === "detent" ? "detent" : fallback.mpg_feedback,
      position_space: saved?.position_space === "machine" ? "machine" : fallback.position_space,
    };
  } catch {
    return fallback;
  }
}

export function saveSurfaceViewPreferences(surface, {
  storage,
  key = SURFACE_VIEW_PREFERENCES_KEY,
} = {}) {
  try {
    const preferenceStorage = storage === undefined ? globalThis.localStorage : storage;
    preferenceStorage?.setItem?.(key, JSON.stringify(surface));
  } catch {
    // View preferences are optional and must never affect machine control.
  }
}

export function isSurfaceKiosk(windowRef = globalThis.window) {
  return typeof windowRef !== "undefined" && windowRef?.matchMedia?.("(any-pointer: coarse) and (min-width: 700px)")?.matches === true;
}

export function surfaceStepDistance(surface = {}) {
  return [10, 1, 0.1, 0.01].includes(Number(surface.step_mm)) ? Number(surface.step_mm) : 1;
}

export function surfaceStepUnit(axis) {
  return String(axis).toLowerCase() === "a" ? "°" : "mm";
}

export function surfaceJogOptionsSummary(surface = {}) {
  const motion = surface.motion === "hold" ? "Hold" : "Step";
  const step = surfaceStepDistance(surface);
  const method = surface.method === "mpg" ? "MPG" : "Directional";
  return `${motion} · ${step} mm/° · ${method}`;
}

export function surfaceQuickActionState(machineState) {
  return {
    setup: machineState === "Idle",
    hold: machineState === "Run",
    resume: machineState === "Hold" || machineState === "Pause",
    details: machineState !== "Idle",
  };
}

export function createSurfaceJogFeature({
  stateFacade,
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  getActiveTab = () => "active-job",
  getMachine = () => ({}),
  getReadOnly = () => false,
  getTapMoveTargetBusy = () => false,
  getPendingOriginOperation = () => false,
  getMachineActionState = () => String(getMachine()?.state || "Unknown"),
  getMovementArmAvailable = () => false,
  getMovementArmLabel = (j) => j?.armed ? "Disarm Movement" : "Arm Movement",
  renderMachineReadouts = () => {},
  fmtActiveTool = () => "Tool —",
  fmtSpindle = () => "Spindle —",
  dashboardOptionalNumber = () => null,
  renderJog = () => {},
  stopSurfaceHoldJog = () => false,
  saveSurfaceViewPreferences = () => {},
  setTextIfChanged = () => {},
  setSoftDisabled = () => {},
  setStatusMessage = () => {},
  machineStateForSurface = () => getMachineActionState(),
} = {}) {
  if (!stateFacade) throw new TypeError("stateFacade is required");
  const state = stateFacade;
  const document = documentRef;
  const window = windowRef;
  const machineActionState = getMachineActionState;

  function surfaceJogBaseReady() {
    return !!state.jog.caps?.enabled && state.jog.link === "online" && state.jog.armed &&
      !getTapMoveTargetBusy() && !state.jog.zStepPending && !getPendingOriginOperation();
  }

  function surfaceJogReady() {
    return surfaceJogBaseReady() && !state.jog.surfaceStepPending;
  }

  function surfaceMPGGestureActive() {
    return state.activeTab === "jog" && state.jog?.armed === true && state.jog?.surfaceWheel?.pointerId !== null;
  }

  function surfaceJogDisplayState(machineState = typeof machineActionState === "function" ? machineActionState() : String(state.machine?.state || "Unknown")) {
    return machineState === "Run" && surfaceMPGGestureActive() ? "Idle" : machineState;
  }

  function deferSurfaceMPGMachineRender(machineState = String(state.machine?.state || "Unknown")) {
    return surfaceMPGGestureActive() && (machineState === "Idle" || machineState === "Run");
  }

  function renderSurfaceMPGWheel(ready = surfaceJogBaseReady()) {
    const surface = state.surface;
    const j = state.jog;
    const wheel = document?.getElementById("surface-mpg-wheel");
    if (wheel) {
      wheel.setAttribute("aria-valuenow", String(j.surfaceWheel.value));
      wheel.setAttribute("aria-valuetext", `${j.surfaceWheel.value} increments on ${surface.mpg_axis.toUpperCase()}`);
      wheel.style.setProperty("--wheel-angle", `${Number(j.surfaceWheel.angle || 0)}deg`);
      const turning = j.surfaceWheel.pointerId !== null;
      wheel.classList.toggle("is-turning", turning);
      wheel.classList.toggle("is-disabled", !ready && !turning);
      wheel.tabIndex = ready || turning ? 0 : -1;
    }
    setTextIfChanged(document?.getElementById("surface-mpg-wheel-step"), `${surfaceStepDistance(surface)}${surface.mpg_axis === "a" ? "°" : " mm"} / click`);
  }

  function renderSurfaceQuickActions(machineState = getMachineActionState()) {
    const root = document?.getElementById("surface-quick-actions");
    const actions = surfaceQuickActionState(machineState);
    for (const button of document?.querySelectorAll?.("[data-surface-setup]") || []) button.hidden = !actions.setup;
    const hold = document?.getElementById("surface-footer-hold");
    const resume = document?.getElementById("surface-footer-resume");
    const details = document?.getElementById("surface-footer-job");
    if (hold) {
      hold.hidden = !actions.hold;
      hold.disabled = getReadOnly() || !!state.controlPendingAction || !!state.activeGcodePending;
      hold.setAttribute("aria-busy", String(state.controlPendingAction === "hold"));
    }
    if (resume) {
      resume.hidden = !actions.resume;
      resume.disabled = getReadOnly() || !!state.controlPendingAction || !!state.activeGcodePending;
      resume.setAttribute("aria-busy", String(state.activeGcodePending === "resume_job" || state.controlPendingAction === "resume"));
      setTextIfChanged(resume, machineState === "Pause" ? "▶ Resume job" : "▶ Resume");
    }
    if (details) details.hidden = !actions.details;
    const vacuum = document?.getElementById("surface-footer-vacuum");
    const vacuumValue = dashboardOptionalNumber(state.machine?.spindle?.vacuum_mode);
    const vacuumKnown = vacuumValue !== null;
    const vacuumEnabled = vacuumValue !== null && vacuumValue !== 0;
    if (vacuum) {
      vacuum.disabled = state.autoVacuumPending || getReadOnly() || !vacuumKnown;
      vacuum.setAttribute("aria-pressed", String(vacuumEnabled));
      vacuum.setAttribute("aria-busy", String(state.autoVacuumPending));
      vacuum.title = !vacuumKnown ? "Auto Vacuum state is not reported by this machine" : (vacuumEnabled ? "Turn Auto Vacuum off" : "Turn Auto Vacuum on");
      setTextIfChanged(vacuum, state.autoVacuumPending ? "Auto Vacuum…" : (vacuumKnown ? `Auto Vacuum · ${vacuumEnabled ? "On" : "Off"}` : "Auto Vacuum · —"));
    }
    root?.classList.toggle("is-job-state", !actions.setup);
    const labels = {
      Idle: "Machine ready",
      Run: "Job running — setup controls locked",
      Hold: "Motion held",
      Pause: "Job paused",
      Wait: "Operator action required",
      Tool: "Tool change required",
    };
    setTextIfChanged(document?.getElementById("surface-footer-state"), labels[machineState] || `Machine: ${machineState}`);
  }

  function renderSurfaceJog() {
    const surface = state.surface;
    const j = state.jog;
    const ready = surfaceJogBaseReady();
    const surfaceButtonBusy = !!j.surfaceStepPending && j.surfaceStepSource !== "mpg";
    const busy = surfaceButtonBusy || !!j.zStepPending || getTapMoveTargetBusy() || getPendingOriginOperation();
    const arm = document?.getElementById("surface-jog-arm");
    if (arm) {
      setTextIfChanged(arm, getMovementArmLabel(j));
      arm.classList.toggle("armed", j.armed);
      arm.disabled = !!j.armPending || !!j.armQueuedAction || !getMovementArmAvailable();
    }
    for (const id of ["surface-jog-motion", "surface-jog-step", "surface-auto-switch", "surface-start-view", "surface-mpg-feedback"]) {
      const el = document?.getElementById(id);
      if (!el || el === document?.activeElement) continue;
      if (id === "surface-jog-motion") el.value = surface.motion;
      else if (id === "surface-jog-step") el.value = String(surface.step_mm);
      else if (id === "surface-auto-switch") el.checked = surface.auto_switch;
      else if (id === "surface-mpg-feedback") el.value = surface.mpg_feedback;
      else el.value = surface.start_view;
    }
    document?.getElementById("surface-directional-panel")?.toggleAttribute("hidden", surface.method !== "directional");
    document?.getElementById("surface-mpg-panel")?.toggleAttribute("hidden", surface.method !== "mpg");
    document?.getElementById("surface-jog-directional")?.setAttribute("aria-pressed", String(surface.method === "directional"));
    document?.getElementById("surface-jog-mpg")?.setAttribute("aria-pressed", String(surface.method === "mpg"));
    renderMachineReadouts(state.machine || {});
    const machineState = surfaceJogDisplayState(machineStateForSurface());
    setTextIfChanged(document?.getElementById("surface-position-state"), machineState === "Idle" ? "Ready to move" : "Machine: " + machineState);
    const detail = state.machine?.connected === false ? "Machine connection unavailable" : `${fmtActiveTool(state.machine?.tool)} · ${fmtSpindle(state.machine?.spindle)}`;
    setTextIfChanged(document?.getElementById("surface-position-detail"), detail);
    renderSurfaceQuickActions(machineState);
    setTextIfChanged(document?.getElementById("surface-jog-options-summary"), surfaceJogOptionsSummary(surface));
    for (const button of document?.querySelectorAll?.("[data-surface-step]") || []) button.setAttribute("aria-pressed", String(Number(button.dataset.surfaceStep) === surfaceStepDistance(surface)));
    for (const button of document?.querySelectorAll?.("[data-surface-motion]") || []) button.setAttribute("aria-pressed", String(button.dataset.surfaceMotion === surface.motion));
    for (const button of document?.querySelectorAll?.(".surface-mpg-axis") || []) button.setAttribute("aria-pressed", String(button.dataset.surfaceMpgAxis === surface.mpg_axis));
    for (const button of document?.querySelectorAll?.("[data-surface-axis], [data-surface-z-sign], [data-surface-a-sign], [data-surface-a-turn], [data-surface-hold-sign]") || []) {
      button.disabled = busy;
      setSoftDisabled(button, !busy && !ready);
    }
    renderSurfaceMPGWheel(ready && !surfaceButtonBusy);
  }

  function initializeSurfaceMobileOptions(isMobile = window?.matchMedia?.("(max-width: 600px)")?.matches === true) {
    const options = document?.getElementById("surface-mobile-options");
    if (options) options.open = !isMobile;
  }

  function selectSurfaceJogMethod(method) {
    state.surface.method = method === "mpg" ? "mpg" : "directional";
    if (window?.matchMedia?.("(max-width: 600px)")?.matches) {
      const options = document?.getElementById("surface-mobile-options");
      if (options) { options.open = false; options.querySelector("summary")?.focus(); }
    }
    saveSurfaceViewPreferences();
    renderSurfaceJog();
  }

  function selectSurfaceMPGAxis(axis) {
    if (!["x", "y", "z", "a"].includes(axis)) return;
    state.surface.mpg_axis = axis;
    saveSurfaceViewPreferences();
    renderSurfaceJog();
  }

  function selectSurfaceStep(step) {
    const value = Number(step);
    state.surface.step_mm = [10, 1, 0.1, 0.01].includes(value) ? value : 1;
    const select = document?.getElementById("surface-jog-step");
    if (select) select.value = String(state.surface.step_mm);
    saveSurfaceViewPreferences();
    renderSurfaceJog();
  }

  function selectSurfaceMotion(motion) {
    stopSurfaceHoldJog();
    state.surface.motion = motion === "hold" ? "hold" : "step";
    const select = document?.getElementById("surface-jog-motion");
    if (select) select.value = state.surface.motion;
    saveSurfaceViewPreferences();
    renderSurfaceJog();
  }

  return {
    surfaceJogBaseReady,
    surfaceJogReady,
    surfaceMPGGestureActive,
    surfaceJogDisplayState,
    deferSurfaceMPGMachineRender,
    renderSurfaceJog,
    renderSurfaceMPGWheel,
    surfaceQuickActionState,
    renderSurfaceQuickActions,
    surfaceJogOptionsSummary,
    initializeSurfaceMobileOptions,
    selectSurfaceJogMethod,
    selectSurfaceMPGAxis,
    selectSurfaceStep,
    selectSurfaceMotion,
    surfaceStepDistance: () => surfaceStepDistance(state.surface),
    surfaceStepUnit,
  };
}
