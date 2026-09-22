// Dashboard presentation. This feature reads server state through explicit
// getters and projects it onto the existing dashboard DOM. It owns no machine
// I/O, timers, commands, or live-update subscriptions.

export function createDashboardView({
  documentRef = globalThis.document,
  getMachine = () => ({}),
  getActiveGcode = () => ({}),
  externalJobInfo = () => null,
  activeGcodeDisplaySegments = () => [],
  activeJobPreviewState = () => null,
  renderMachineReadouts = () => {},
  renderDashboardTelemetry = () => {},
  renderDashboardGcodeStream = () => {},
  drawDashboardGcodePreview = () => {},
  relPath = (value) => value || "",
  fmtDuration = (value) => String(value ?? ""),
} = {}) {
  const document = documentRef;

  function bindInteractions({ showTab = () => {} } = {}) {
    const preview = document.getElementById("dashboard-toolpath-fallback");
    if (!preview) return;
    const open = () => showTab("active-job");
    preview.addEventListener("click", open);
    preview.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      open();
    });
  }

  function renderDashboard() {
    const machine = getMachine() || {};
    const active = getActiveGcode() || {};
    const external = externalJobInfo(machine, active);
    const preview = active.preview || {};
    const dashboardPreview = { ...preview, segments: activeGcodeDisplaySegments(active) };
    const live = active.path ? activeJobPreviewState(machine, dashboardPreview, active.path) : null;
    const setText = (id, value) => {
      const element = document.getElementById(id);
      if (element) element.textContent = value;
    };

    document.querySelector(".dashboard-job")?.classList.toggle("is-empty", !active.path);

    const machineState = document.getElementById("dashboard-state");
    if (machineState) {
      const labels = { Idle: "Ready", Run: "Running", Hold: "Held", Pause: "Paused", Wait: "Waiting", Tool: "Tool change", Alarm: "Alarm" };
      machineState.textContent = labels[machine.state] || machine.state || "Unknown";
      machineState.className = "badge state-" + (machine.state || "Unknown");
    }
    renderMachineReadouts(machine);
    setText("dashboard-job-title", active.path ? relPath(active.path) : (external ? `External job · ${machine.state || "active"}` : "No active job"));

    const progress = document.getElementById("dashboard-progress-bar");
    if (progress) progress.value = live ? live.percent : 0;
    const lineCount = Math.max(0, Number(preview.line_count) || 0);
    setText("dashboard-progress-label", live ? `${live.percent}% · line ${live.playedLines}${lineCount ? " / " + lineCount : ""}` : (external ? external.progressText : "Progress"));
    setText("dashboard-elapsed", live ? fmtDuration(live.elapsedMs) : (external ? external.observedText : "-"));
    setText("dashboard-remaining", live && Number.isFinite(live.remainingMs) ? fmtDuration(live.remainingMs) : "-");
    renderDashboardTelemetry(machine);
    renderDashboardGcodeStream(live);
    document.getElementById("dashboard-toolpath-fallback")?.classList.toggle("has-toolpath", dashboardPreview.segments.length > 0 && !!dashboardPreview.bounds);
    drawDashboardGcodePreview(dashboardPreview, live);
  }

  return { renderDashboard, bindInteractions };
}
