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
