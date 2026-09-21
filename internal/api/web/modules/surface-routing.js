// Surface kiosk routing and the explicit representation of jobs started
// outside CNC Proxy. No machine requests are made here; this module only
// derives view state from the already observed snapshot.

export const EXTERNAL_JOB_STATES = ["Run", "Hold", "Pause", "Wait", "Tool"];

export function externalJobState(machineState) {
  return EXTERNAL_JOB_STATES.includes(String(machineState || ""));
}

export function createSurfaceRouting({
  getState = () => ({}),
  isSurfaceKiosk = () => false,
  showTab = () => {},
  fmtDuration = (ms) => `${Math.max(0, Math.round(Number(ms) || 0))} ms`,
  now = () => Date.now(),
} = {}) {
  const state = getState();

  function externalJobInfo(machine, active) {
    if (active?.path || !externalJobState(machine?.state)) return null;
    const rawProgress = String(machine?.fields?.P || "").trim();
    const observedAt = Number(state.externalJobObservedAt) || now();
    return {
      title: "External controller job " + String(machine.state).toLowerCase(),
      detail: "File and G-code line are unavailable because this job was started outside CNC Proxy.",
      progressText: rawProgress ? "Machine-reported progress P: " + rawProgress : "External job; machine progress is unavailable.",
      observedText: "Observed " + fmtDuration(now() - observedAt) + " ago",
    };
  }

  function applySurfaceAutomaticView() {
    if (!isSurfaceKiosk() || !state.surface.auto_switch || !state.machine?.state) return;
    const machineState = String(state.machine.state);
    if (state.surface.manual_view_state === machineState) return;
    // A manual selection applies only to the current machine state. Let the next
    // state transition route the operator to the corresponding Surface view.
    state.surface.manual_view_state = "";
    // A local jog step can briefly report Run. Do not route away from its armed
    // Jog session: changing tabs would deliberately disarm that same session and
    // make the next detent fail. Attention states still take priority below.
    const localJogSession = state.activeTab === "jog" && state.jog?.armed === true;
    const target = ["Tool", "Pause", "Wait", "Hold", "Alarm"].includes(machineState)
      ? "attention"
      : (machineState === "Run" && !localJogSession ? "dashboard" : (machineState === "Idle" ? state.surface.start_view : ""));
    if (target && target !== state.activeTab) showTab(target, "replace");
  }

  return { externalJobState, externalJobInfo, applySurfaceAutomaticView };
}
