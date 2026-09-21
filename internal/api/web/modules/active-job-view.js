// Active Job presentation. This module projects the current active-job state
// onto existing nodes; it does not fetch data or send machine commands.

export function createActiveJobView({
  documentRef = globalThis.document,
  getActiveGcode = () => ({}),
  getMachine = () => ({}),
  getActiveGcodePending = () => "",
  getFeedOverridePendingPercent = () => null,
  externalJobInfo = () => null,
  relPath = (value) => value || "",
  fmtSize = (value) => String(value ?? ""),
  syncLabel = {},
  machineActionState = () => "",
  renderProgramToolLists = () => {},
  ensureActiveGcodeGeometry = () => {},
  ensureActiveGcodeSource = () => {},
  drawGcodePreview = () => {},
  fmtDuration = (value) => String(value ?? ""),
  renderDashboard = () => {},
  activeJobPreviewState = () => null,
  activeGcodeDisplaySegments = () => [],
  renderJobControls = () => {},
  setSoftDisabled = () => {},
  getFile = () => null,
  gcodeToolLabel = (tool) => tool?.name || "",
} = {}) {
  const document = documentRef;

  function renderActiveJobProgress(live, preview = {}, external = null) {
    const progress = document.getElementById("active-gcode-progress");
    const elapsed = document.getElementById("active-gcode-elapsed");
    const remaining = document.getElementById("active-gcode-remaining");
    if (!progress || !elapsed || !remaining) return;
    if (!live) {
      progress.textContent = external ? external.progressText : "-";
      elapsed.textContent = external ? external.observedText : "-";
      remaining.textContent = "-";
      return;
    }
    const totalLines = Math.max(0, Number(preview.line_count) || 0);
    const lineText = totalLines ? `line ${live.playedLines} / ${totalLines}` : `line ${live.playedLines}`;
    progress.textContent = `${live.percent}% · ${lineText}`;
    elapsed.textContent = fmtDuration(live.elapsedMs);
    remaining.textContent = Number.isFinite(live.remainingMs) ? fmtDuration(live.remainingMs) : "-";
  }

  function renderActiveGcode() {
    const active = getActiveGcode() || {};
    const machine = getMachine() || {};
    const external = externalJobInfo(machine, active);
    const title = document.getElementById("active-gcode-title");
    const meta = document.getElementById("active-gcode-meta");
    const run = document.getElementById("active-gcode-run");
    if (!title || !meta || !run) return;

    renderActiveGcodeControls(active);
    document.querySelector(".active-gcode-workspace")?.classList.toggle("is-empty", !active.path);

    if (!active.path) {
      title.textContent = external ? external.title : "No active gcode selected.";
      meta.textContent = external ? external.detail : "-";
      run.disabled = false;
      setSoftDisabled(run, true);
      ensureActiveGcodeGeometry(null);
      ensureActiveGcodeSource(null);
      drawGcodePreview(null);
      renderActiveJobProgress(null, {}, external);
      renderProgramToolLists({}, machine);
      renderDashboard();
      return;
    }

    title.textContent = relPath(active.path);
    ensureActiveGcodeGeometry(active);
    ensureActiveGcodeSource(active);
    const preview = active.preview || {};
    const renderedPreview = { ...preview, segments: activeGcodeDisplaySegments(active) };
    const live = activeJobPreviewState(machine, renderedPreview, active.path);
    const tools = Array.isArray(preview.tool_metadata) && preview.tool_metadata.length
      ? preview.tool_metadata.map((tool) => [gcodeToolLabel(tool), tool.name].filter(Boolean).join(" · ")).join(" | ")
      : (Array.isArray(preview.tools) && preview.tools.length ? "tools T" + preview.tools.join(", T") : "");
    const entry = active.entry || getFile(active.path) || {};
    const sync = syncLabel[entry.sync] || entry.sync || "";
    meta.textContent = [
      fmtSize(entry.size || 0, false),
      sync,
      preview.has_4axis ? "4-axis" : "",
      tools,
    ].filter(Boolean).join(" | ");
    renderProgramToolLists(preview, machine);
    const machineReady = machineActionState() === "Idle";
    const pending = getActiveGcodePending();
    run.disabled = !!pending;
    setSoftDisabled(run, !pending && (!active.runnable || !machineReady));
    renderActiveJobProgress(live, preview);
    drawGcodePreview(renderedPreview, live);
    renderDashboard();
  }

  function renderActiveGcodeControls(active) {
    const machineState = machineActionState();
    document.querySelector(".active-gcode-actions")?.setAttribute("data-machine-state", machineState);
    const pending = !!getActiveGcodePending();
    const run = document.getElementById("active-gcode-run");
    const paused = document.getElementById("paused-job-controls");
    const raise = document.getElementById("paused-job-raise");
    const feedControls = document.getElementById("feed-override-controls");
    const feedDecrease = document.getElementById("feed-override-decrease");
    const feedIncrease = document.getElementById("feed-override-increase");
    const feedReset = document.getElementById("feed-override-reset");
    const feedValue = document.getElementById("feed-override-value");
    if (!run || !paused || !raise || !feedControls || !feedDecrease || !feedIncrease || !feedReset || !feedValue) return;

    const running = machineState === "Run";
    const suspended = machineState === "Pause";
    const held = machineState === "Hold";
    run.hidden = running || suspended || held;
    paused.hidden = !suspended;
    raise.hidden = !suspended;
    feedControls.hidden = !running && !suspended && !held;
    const feedOverride = Number(getMachine()?.feed?.override);
    const hasFeedOverride = Number.isFinite(feedOverride);
    const roundedFeedOverride = hasFeedOverride ? Math.round(feedOverride) : 0;
    const pendingPercent = getFeedOverridePendingPercent();
    const shownFeedOverride = getActiveGcodePending() === "feed_override" && Number.isFinite(pendingPercent)
      ? pendingPercent
      : roundedFeedOverride;
    feedValue.value = hasFeedOverride ? Math.round(shownFeedOverride) + "%" : "-";
    feedValue.textContent = feedValue.value;
    feedControls.setAttribute("aria-busy", pending ? "true" : "false");
    feedDecrease.disabled = pending || !hasFeedOverride || roundedFeedOverride <= 50;
    feedIncrease.disabled = pending || !hasFeedOverride || roundedFeedOverride >= 200;
    feedReset.disabled = pending || roundedFeedOverride === 100;
    raise.disabled = pending;
    run.disabled = pending;
    if (!pending) setSoftDisabled(run, !active?.runnable || machineState !== "Idle");
    renderJobControls();
  }

  return { renderActiveGcode, renderActiveGcodeControls };
}
