export function createUISettingsFeature({
  stateFacade,
  documentRef,
  request,
  normalizeUISettings,
  clearConnectivityIssue = () => {},
  setConnectivityIssue = () => {},
  setNotice = () => {},
  clearNotice = () => {},
  maintenanceRender = () => {},
  renderMacroButtons = () => {},
  renderMacroEditor = () => {},
  renderGamepadSettings = () => {},
  renderMachineSettings = () => {},
  renderJog = () => {},
  renderGcodeLog = () => {},
  renderWorkArea = () => {},
  resolveDashboardProfile = () => {},
  showTab = () => {},
} = {}) {
  if (!stateFacade) throw new TypeError("stateFacade is required");
  const state = stateFacade;

  async function loadUISettings() {
    try {
      const response = await request("/api/ui/settings");
      applyUISettings(await response.json());
      clearConnectivityIssue("ui-settings");
    } catch (error) {
      setConnectivityIssue("ui-settings", "UI settings unavailable: " + error.message);
      applyUISettings(state.ui);
    }
  }

  function applyAPICapabilities(caps) {
    state.readOnly = !!caps?.read_only;
    maintenanceRender();
    documentRef.body.classList.toggle("read-only", state.readOnly);
    for (const id of [
      "command-actions", "ctl-halt", "tab-jog", "tab-control", "tab-files",
      "active-gcode-run", "active-gcode-pause", "paused-job-controls",
      "feed-override-controls", "alarm-actions", "attention-resume", "attention-recover",
      "dashboard-external-camera-focus-open",
    ]) {
      const element = documentRef.getElementById(id);
      if (element) element.hidden = state.readOnly;
    }
    for (const element of documentRef.querySelectorAll("[data-machine-feed-override]")) {
      element.hidden = state.readOnly || !element.closest(".dashboard-machine");
    }
    if (state.readOnly && ["jog", "control", "files"].includes(state.activeTab)) {
      showTab("dashboard", "replace");
    }
  }

  async function loadAPICapabilities() {
    try {
      const response = await request("/api/capabilities");
      applyAPICapabilities(await response.json());
      clearConnectivityIssue("api-capabilities");
    } catch (error) {
      setConnectivityIssue("api-capabilities", "API capabilities unavailable: " + error.message);
    }
  }

  function applyUISettings(ui) {
    state.ui = normalizeUISettings(ui);
    state.dashboardSettingsLoaded = true;
    state.logFilter = state.ui.log.filter || "all";
    const logFilter = documentRef.getElementById("log-filter");
    const logAutoscroll = documentRef.getElementById("log-autoscroll");
    if (logFilter) logFilter.value = state.logFilter;
    if (logAutoscroll) logAutoscroll.checked = state.ui.log.autoscroll !== false;
    if (!state.selectedMacroId && state.ui.macros.length) state.selectedMacroId = state.ui.macros[0].id;
    renderMacroButtons();
    renderMacroEditor();
    renderGamepadSettings();
    renderMachineSettings();
    renderJog();
    renderGcodeLog();
    renderWorkArea();
    resolveDashboardProfile();
  }

  function queueSaveUISettings() {
    clearTimeout(state.settingsSaveTimer);
    state.settingsSaveTimer = setTimeout(saveUISettings, 250);
  }

  async function saveUISettings(options = {}) {
    clearTimeout(state.settingsSaveTimer);
    state.settingsSaveTimer = null;
    try {
      const response = await request("/api/ui/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state.ui),
      });
      applyUISettings(await response.json());
      if (options.successMessage) setNotice(options.successMessage, "ok", "ui-settings-save");
      else clearNotice("ui-settings-save");
      return true;
    } catch (error) {
      setNotice("Saving UI settings failed: " + error.message, "error", "ui-settings-save");
      return false;
    }
  }

  return { loadUISettings, applyAPICapabilities, loadAPICapabilities, applyUISettings, queueSaveUISettings, saveUISettings };
}
