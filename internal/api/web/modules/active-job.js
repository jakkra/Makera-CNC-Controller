export function mountActiveJobSelection({
  request,
  setActiveSelectPendingPath,
  setActiveGcode,
  relPath,
  setActiveFeedback,
  setNotice,
  renderFiles,
  renderActiveGcode,
  showTab,
}) {
  async function selectActiveGcode(path) {
    setActiveSelectPendingPath(path);
    setActiveFeedback("Loading preview for " + relPath(path) + "...", "");
    renderFiles();
    try {
      const r = await request("/api/gcode/active", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      setActiveGcode(await r.json());
      setActiveFeedback("Preview loaded for " + relPath(path) + ".", "ok");
      showTab("active-job");
    } catch (e) {
      setActiveFeedback("Preview failed: " + e.message, "error");
      setNotice("Select gcode failed: " + e.message, "error", "active-gcode");
    } finally {
      setActiveSelectPendingPath("");
      renderFiles();
      renderActiveGcode();
    }
  }

  return { selectActiveGcode };
}

export function mountActiveJobLoader({
  request,
  getActiveGcodeLoading,
  setActiveGcodeLoading,
  setActiveGcode,
  clearConnectivityIssue,
  setConnectivityIssue,
  renderActiveGcode,
  getMachine,
  renderAttention,
}) {
  async function loadActiveGcode() {
    if (getActiveGcodeLoading()) return;
    setActiveGcodeLoading(true);
    try {
      const r = await request("/api/gcode/active");
      setActiveGcode(await r.json());
      clearConnectivityIssue("active-gcode");
      renderActiveGcode();
      renderAttention(getMachine() || {});
    } catch (e) {
      setConnectivityIssue("active-gcode", "Active gcode unavailable: " + e.message);
    } finally {
      setActiveGcodeLoading(false);
    }
  }

  return { loadActiveGcode };
}

export function mountActiveJobRunner({
  request,
  getActiveGcode,
  getActiveGcodePending,
  setActiveGcodePending,
  machineActionState,
  confirmRef,
  relPath,
  setActiveFeedback,
  renderActiveGcode,
  clearNotice,
  pollMachine,
  appendGcodeLine,
  setNotice,
}) {
  async function runActiveGcode() {
    const active = getActiveGcode() || {};
    if (!active.path) {
      setActiveFeedback("Select an active gcode before running.", "error");
      return;
    }
    if (!active.runnable) {
      setActiveFeedback(active.message || "Active gcode is not runnable.", "error");
      return;
    }
    if (machineActionState() !== "Idle") {
      setActiveFeedback("Machine must be Idle before running active gcode.", "error");
      return;
    }
    if (getActiveGcodePending()) return;
    if (!confirmRef("Start " + relPath(active.path) + "?")) return;
    setActiveGcodePending("run");
    setActiveFeedback("Sending run command for " + relPath(active.path) + "...", "");
    renderActiveGcode();
    try {
      const r = await request("/api/gcode/active/run", { method: "POST" });
      const result = await r.json();
      setActiveFeedback(result.message || "Run command sent; machine confirmation was not available.", result.verified ? "ok" : "");
      clearNotice("active-gcode-run");
      pollMachine();
      setTimeout(pollMachine, 1200);
    } catch (e) {
      appendGcodeLine({ seq: "local-" + Date.now(), dir: "recv", source: "api", text: "error: " + e.message });
      setActiveFeedback("Run failed: " + e.message, "error");
      setNotice("Run failed: " + e.message, "error", "active-gcode-run");
    } finally {
      setActiveGcodePending("");
      renderActiveGcode();
    }
  }

  return { runActiveGcode };
}

export function mountActiveJobControl({
  request,
  getActiveGcodePending,
  setActiveGcodePending,
  machineActionState,
  confirmRef,
  setActiveFeedback,
  renderMachine,
  pollMachine,
}) {
  async function runActiveJobControl(action) {
    if (getActiveGcodePending()) {
      setActiveFeedback("Another active job action is still in progress.", "error");
      return false;
    }
    const machineState = machineActionState();
    const expectedState = action === "pause_job" ? "Run" : (action === "resume_job" ? "Pause" : "");
    if (!expectedState || machineState !== expectedState) {
      setActiveFeedback(action === "resume_job"
        ? `Resume is unavailable while the machine is ${machineState}.`
        : `Pause is unavailable while the machine is ${machineState}.`, "error");
      return false;
    }
    if (action === "pause_job" && !confirmRef("Pause the running job and enable manual paused controls?")) return;
    setActiveGcodePending(action);
    setActiveFeedback(action === "pause_job" ? "Pausing job..." : "Restoring the paused job...", "");
    renderMachine();
    try {
      const response = await request("/api/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const result = await response.json();
      setActiveFeedback(result.message, result.verified ? "ok" : "error");
      await pollMachine();
      return !!result.verified;
    } catch (error) {
      setActiveFeedback((action === "pause_job" ? "Pause failed: " : "Resume failed: ") + error.message, "error");
      return false;
    } finally {
      setActiveGcodePending("");
      renderMachine();
    }
  }

  return { runActiveJobControl };
}

export function mountPausedJobCommand({
  request,
  getActiveGcodePending,
  setActiveGcodePending,
  getRaiseDistance,
  setActiveFeedback,
  renderActiveGcode,
  pollMachine,
}) {
  async function runPausedJobCommand(action, options = {}) {
    if (getActiveGcodePending()) return;
    const body = { action, ...options };
    if (action === "raise_z") {
      const distance = Number(getRaiseDistance());
      if (!Number.isFinite(distance) || distance <= 0 || distance > 50) {
        setActiveFeedback("Raise distance must be greater than 0 and at most 50 mm.", "error");
        return;
      }
      body.distance_mm = distance;
    }
    setActiveGcodePending(action);
    const pendingText = {
      raise_z: "Raising Z while the job is paused...",
      stop_spindle: "Stopping spindle while the job is paused...",
      start_spindle: "Starting spindle from the paused job context...",
    };
    setActiveFeedback(pendingText[action] || "Sending paused job command...", "");
    renderActiveGcode();
    try {
      const response = await request("/api/gcode/active/paused-command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      setActiveFeedback(result.message, result.verified ? "ok" : "error");
      await pollMachine();
    } catch (error) {
      setActiveFeedback("Paused command failed: " + error.message, "error");
    } finally {
      setActiveGcodePending("");
      renderActiveGcode();
    }
  }

  return { runPausedJobCommand };
}
export function previewBoundsText(bounds) {
  const min = bounds.min || [];
  const max = bounds.max || [];
  const dx = Number(max[0]) - Number(min[0]);
  const dy = Number(max[1]) - Number(min[1]);
  const dz = Number(max[2]) - Number(min[2]);
  if (![dx, dy, dz].every(Number.isFinite)) return "";
  const xyz = `X ${dx.toFixed(2)} Y ${dy.toFixed(2)} Z ${dz.toFixed(2)} mm`;
  const da = Number(bounds.max_a) - Number(bounds.min_a);
  if (Number.isFinite(da) && Math.abs(da) > 0.0001) return `${xyz} A ${Math.abs(da).toFixed(2)} deg`;
  return xyz;
}

export function gcodeCursorForPlayedLine(segments, playedLine) {
  let low = 0;
  let high = Array.isArray(segments) ? segments.length : 0;
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    const line = Number(segments[mid]?.line) || 0;
    if (line < playedLine) low = mid + 1;
    else high = mid;
  }
  return low;
}

export function mountActiveJobPreview({ cursorForPlayedLine }) {
  function activeJobPreviewState(machine, preview, activePath) {
    const job = machine?.active_job;
    const segments = Array.isArray(preview?.segments) ? preview.segments : [];
    if (!job) return null;
    if (job.path && activePath && job.path !== activePath) return null;
    const playedLines = Math.max(0, Math.trunc(Number(job.played_lines) || 0));
    if (playedLines <= 0) return null;
    const percent = Math.max(0, Math.min(100, Math.trunc(Number(job.percent) || 0)));
    const elapsedMs = Math.max(0, Number(job.elapsed_ms) || 0);
    const remainingValue = Number(job.remaining_ms);
    const remainingMs = Number.isFinite(remainingValue) && remainingValue >= 0 ? remainingValue : null;
    const wpos = machine?.wpos || {};
    let position = null;
    if ([wpos.x, wpos.y, wpos.z].every((value) => Number.isFinite(Number(value)))) {
      position = [
        Number(wpos.x),
        Number(wpos.y),
        Number(wpos.z),
        Number.isFinite(Number(wpos.a)) ? -Number(wpos.a) : 0,
      ];
    }
    return { playedLines, percent, elapsedMs, remainingMs, cursor: cursorForPlayedLine(segments, playedLines), position };
  }

  return { activeJobPreviewState };
}

export function mountFeedOverride({
  request,
  getActiveGcodePending,
  setActiveGcodePending,
  getMachine,
  setFeedOverridePendingPercent,
  setActiveFeedback,
  renderActiveGcode,
  pollMachine,
}) {
  async function setFeedOverride(percent) {
    if (getActiveGcodePending()) return;
    percent = Math.max(50, Math.min(200, Math.round(Number(percent) / 10) * 10));
    if (!Number.isFinite(percent)) return;
    setActiveGcodePending("feed_override");
    setFeedOverridePendingPercent(percent);
    setActiveFeedback("Setting feed override to " + percent + "%...", "");
    renderActiveGcode();
    try {
      const response = await request("/api/feed-override", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ percent }),
      });
      const result = await response.json();
      setActiveFeedback(result.message, result.verified ? "ok" : "error");
      await pollMachine();
    } catch (error) {
      setActiveFeedback("Feed override failed: " + error.message, "error");
    } finally {
      setActiveGcodePending("");
      setFeedOverridePendingPercent(null);
      renderActiveGcode();
    }
  }

  function adjustFeedOverride(delta) {
    const current = Number(getMachine()?.feed?.override);
    if (!Number.isFinite(current)) return;
    return setFeedOverride(current + delta);
  }

  return { setFeedOverride, adjustFeedOverride };
}

export function bindActiveJobInteractions({
  documentRef,
  bindButtonAction,
  runActiveGcode,
  runJobControl,
  adjustFeedOverride,
  setFeedOverride,
  runPausedJobCommand,
}) {
  bindButtonAction(documentRef.getElementById("active-gcode-run"), runActiveGcode);
  for (const button of documentRef.querySelectorAll("[data-job-control]")) {
    bindButtonAction(button, () => runJobControl(button.dataset.jobControl));
  }
  bindButtonAction(documentRef.getElementById("feed-override-decrease"), () => adjustFeedOverride(-10));
  bindButtonAction(documentRef.getElementById("feed-override-increase"), () => adjustFeedOverride(10));
  bindButtonAction(documentRef.getElementById("feed-override-reset"), () => setFeedOverride(100));
  for (const button of documentRef.querySelectorAll("[data-machine-feed-delta]")) {
    bindButtonAction(button, () => adjustFeedOverride(Number(button.dataset.machineFeedDelta)));
  }
  for (const button of documentRef.querySelectorAll("[data-machine-feed-reset]")) {
    bindButtonAction(button, () => setFeedOverride(100));
  }
  bindButtonAction(documentRef.getElementById("paused-job-raise"), () => runPausedJobCommand("raise_z"));
}

export function mountActiveJobDispatch({
  documentRef,
  machineActionState,
  jobControlModel,
  setActiveFeedback,
  runActiveJobControl,
  sendControl,
  runPausedJobCommand,
}) {
  async function resumeActiveJob() {
    const machineState = machineActionState();
    if (machineState === "Pause") return runActiveJobControl("resume_job");
    if (machineState === "Hold") return sendControl("resume");
    setActiveFeedback(`Resume is unavailable while the machine is ${machineState}.`, "error");
    return false;
  }

  async function runJobControl(action) {
    const model = jobControlModel();
    const control = model.actions[action];
    if (!control?.visible || control.disabled) {
      setActiveFeedback("This job control is unavailable for the current machine state.", "error");
      return false;
    }
    if (action === "pause") return runActiveJobControl("pause_job");
    if (action === "resume") return runActiveJobControl("resume_job");
    if (action === "stop-spindle") return runPausedJobCommand("stop_spindle");
    if (action === "start-spindle") {
      if (model.speed !== null) return runPausedJobCommand("start_spindle");
      const speed = Number(documentRef.getElementById("paused-job-spindle-speed")?.value);
      const direction = String(documentRef.getElementById("paused-job-spindle-direction")?.value || "");
      if (!Number.isFinite(speed) || speed <= 0 || speed > 13000) {
        setActiveFeedback("Enter a spindle speed from 1 to 13,000 rpm before starting.", "error");
        return false;
      }
      if (direction !== "M3" && direction !== "M4") {
        setActiveFeedback("Choose clockwise or counterclockwise spindle direction before starting.", "error");
        return false;
      }
      return runPausedJobCommand("start_spindle", { speed_rpm: speed, direction });
    }
    return false;
  }

  return { resumeActiveJob, runJobControl };
}
