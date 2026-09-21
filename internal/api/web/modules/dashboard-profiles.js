export const DASHBOARD_PANEL_DEFS = [{ id: "machine", label: "Machine" }, { id: "job", label: "Current job" }, { id: "telemetry", label: "Machine telemetry" }, { id: "gcode", label: "Gcode stream" }];

export function defaultDashboardSettings() {
  return {
    profiles: [{
      id: "overview",
      name: "Overview",
      layout: "job-focus",
      density: "comfortable",
      background: "solid",
      panels: DASHBOARD_PANEL_DEFS.map((panel) => panel.id),
      gcode_lines: 9,
    }],
    default_profile_id: "overview",
  };
}

export function normalizeDashboardSettings(settings) {
  const defaults = defaultDashboardSettings();
  const knownPanels = new Set(DASHBOARD_PANEL_DEFS.map((panel) => panel.id));
  const profiles = [];
  const seen = new Set();
  for (const candidate of Array.isArray(settings?.profiles) ? settings.profiles : []) {
    const id = String(candidate?.id || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const panels = [];
    const seenPanels = new Set();
    for (const panel of Array.isArray(candidate.panels) ? candidate.panels : []) {
      if (!knownPanels.has(panel) || seenPanels.has(panel)) continue;
      seenPanels.add(panel);
      panels.push(panel);
    }
    const lines = Math.trunc(Number(candidate.gcode_lines));
    profiles.push({
      id,
      name: String(candidate.name || id).trim() || id,
      layout: ["grid", "job-focus", "stacked"].includes(candidate.layout) ? candidate.layout : "job-focus",
      density: candidate.density === "compact" ? "compact" : "comfortable",
      background: candidate.background === "transparent" ? "transparent" : "solid",
      panels: panels.length ? panels : [...defaults.profiles[0].panels],
      gcode_lines: lines >= 3 && lines <= 30 ? lines : defaults.profiles[0].gcode_lines,
    });
  }
  if (!profiles.length) return defaults;
  const requestedDefault = String(settings?.default_profile_id || "").trim();
  return {
    profiles,
    default_profile_id: profiles.some((profile) => profile.id === requestedDefault) ? requestedDefault : profiles[0].id,
  };
}

// Owns dashboard profile selection, URL state, settings dialog, and panel layout.
// dashboardState is a narrow facade containing only dashboard fields and UI settings.
export function createDashboardProfiles({
  dashboardState: state,
  documentRef: document,
  windowRef: window,
  navigatorRef: navigator,
  confirmRef: confirm,
  normalizeDashboardSettings,
  viewTabFromURL,
  setDashboardControlsOpen,
  renderDashboard,
  newID,
  saveUISettings,
  setNotice,
  getDashboardGcodeView,
  scheduleDashboardGcodeRender,
}) {
  function dashboardURLState(locationLike = window.location) {
    const query = new URLSearchParams(String(locationLike?.search || ""));
    const embed = String(query.get("embed") || "").toLowerCase();
    return {
      profile: String(query.get("profile") || "").trim(),
      embed: embed === "1" || embed === "true" || embed === "yes",
    };
  }

  function dashboardProfileByID(id) {
    return state.ui.dashboard?.profiles?.find((profile) => profile.id === id) || null;
  }

  function currentDashboardProfile() {
    const settings = normalizeDashboardSettings(state.ui.dashboard);
    const find = (id) => settings.profiles.find((profile) => profile.id === id) || null;
    return find(state.dashboardProfileID) || find(settings.default_profile_id) || settings.profiles[0];
  }

  function isWideSurfaceOverview() {
    return typeof window !== "undefined" && window.matchMedia?.("(min-width: 1320px)")?.matches === true;
  }

  function dashboardPanelVisible(panelID, profile, forceSurfaceOverview = isWideSurfaceOverview()) {
    return profile.panels.includes(panelID) || (forceSurfaceOverview && (panelID === "machine" || panelID === "job"));
  }

  function resolveDashboardProfile() {
    state.ui.dashboard = normalizeDashboardSettings(state.ui.dashboard);
    const requested = state.dashboardRequestedProfileID;
    const fallback = state.ui.dashboard.default_profile_id || state.ui.dashboard.profiles[0]?.id;
    state.dashboardProfileID = dashboardProfileByID(requested) ? requested : fallback;
    renderDashboardProfileControls();
    applyDashboardProfile(currentDashboardProfile());
    renderDashboard();
  }

  function applyDashboardURLState(locationLike = window.location) {
    const urlState = dashboardURLState(locationLike);
    state.dashboardRequestedProfileID = urlState.profile;
    state.dashboardEmbed = urlState.embed && viewTabFromURL(locationLike) === "dashboard";
    document.body.classList.toggle("dashboard-embed", state.dashboardEmbed);
    if (state.dashboardEmbed) setDashboardControlsOpen(false);
    if (state.dashboardSettingsLoaded || !state.dashboardProfileID) resolveDashboardProfile();
    else applyDashboardProfile(currentDashboardProfile());
  }

  function syncDashboardProfileURL(profileID, embed = state.dashboardEmbed, mode = "push") {
    const url = new URL(window.location.href);
    url.pathname = "/dashboard";
    url.searchParams.delete("tab");
    if (profileID) url.searchParams.set("profile", profileID);
    else url.searchParams.delete("profile");
    if (embed) url.searchParams.set("embed", "1");
    else url.searchParams.delete("embed");
    url.hash = "";
    const next = url.pathname + url.search;
    const current = window.location.pathname + window.location.search;
    if (mode === "push" && next === current) return;
    window.history[mode === "replace" ? "replaceState" : "pushState"](
      { tab: "dashboard", profile: profileID, embed: !!embed },
      "",
      next,
    );
  }

  function selectDashboardProfile(profileID, urlMode = "push") {
    const profile = dashboardProfileByID(profileID);
    if (!profile) return false;
    state.dashboardRequestedProfileID = profile.id;
    state.dashboardProfileID = profile.id;
    applyDashboardProfile(profile);
    syncDashboardProfileURL(profile.id, state.dashboardEmbed, urlMode);
    return true;
  }

  function renderDashboardProfileControls() {
    const select = document.getElementById("dashboard-profile");
    if (!select) return;
    const prior = select.value;
    const fragment = document.createDocumentFragment();
    for (const profile of state.ui.dashboard.profiles) {
      const option = document.createElement("option");
      option.value = profile.id;
      option.textContent = profile.name;
      fragment.appendChild(option);
    }
    select.replaceChildren(fragment);
    select.value = dashboardProfileByID(state.dashboardProfileID) ? state.dashboardProfileID : prior;
  }

  function applyDashboardProfile(profile) {
    if (!profile) return;
    const grid = document.querySelector(".dashboard-grid");
    if (!grid) return;
    grid.classList.remove(
      "layout-grid",
      "layout-job-focus",
      "layout-stacked",
      "dashboard-density-compact",
      "dashboard-job-focus-split",
      "dashboard-panel-count-1",
      "dashboard-panel-count-2",
      "dashboard-panel-count-3",
      "dashboard-panel-count-4",
    );
    grid.classList.add("layout-" + profile.layout);
    grid.classList.toggle("dashboard-density-compact", profile.density === "compact");
    document.body.classList.toggle("dashboard-background-transparent", profile.background === "transparent");
    const visible = new Set(profile.panels);
    if (isWideSurfaceOverview()) {
      visible.add("machine");
      visible.add("job");
    }
    grid.classList.add(`dashboard-panel-count-${visible.size}`);
    grid.classList.toggle(
      "dashboard-job-focus-split",
      profile.layout === "job-focus" && visible.has("job") && visible.size > 1,
    );
    const order = new Map(profile.panels.map((panel, index) => [panel, index]));
    for (const panel of document.querySelectorAll("[data-dashboard-panel]")) {
      const id = panel.dataset.dashboardPanel;
      panel.hidden = !dashboardPanelVisible(id, profile, isWideSurfaceOverview());
      panel.style.order = String(order.get(id) ?? DASHBOARD_PANEL_DEFS.length);
    }
    const select = document.getElementById("dashboard-profile");
    if (select && select.value !== profile.id) select.value = profile.id;
    const dashboardGcodeView = getDashboardGcodeView?.();
    if (dashboardGcodeView?.renderer) {
      dashboardGcodeView.renderer.setClearColor(0x202832, profile.background === "transparent" ? 0 : 1);
    }
    scheduleDashboardGcodeRender();
  }

  function dashboardProfileSlug(name, profiles = state.ui.dashboard.profiles) {
    const stem = String(name || "dashboard").toLowerCase().normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "dashboard";
    const used = new Set(profiles.map((profile) => profile.id));
    if (!used.has(stem)) return stem;
    for (let suffix = 2; suffix < 1000; suffix++) {
      const id = `${stem}-${suffix}`;
      if (!used.has(id)) return id;
    }
    return newID("dashboard").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  }

  function renderDashboardPanelOrder(panels) {
    const container = document.getElementById("dashboard-panel-order");
    if (!container) return;
    const selected = new Set(panels);
    const ordered = [
      ...panels.map((id) => DASHBOARD_PANEL_DEFS.find((panel) => panel.id === id)).filter(Boolean),
      ...DASHBOARD_PANEL_DEFS.filter((panel) => !selected.has(panel.id)),
    ];
    const fragment = document.createDocumentFragment();
    for (const definition of ordered) {
      const row = document.createElement("div");
      row.className = "dashboard-panel-row";
      row.dataset.dashboardPanelOption = definition.id;
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = selected.has(definition.id);
      checkbox.setAttribute("aria-label", `Show ${definition.label}`);
      const label = document.createElement("span");
      label.textContent = definition.label;
      const up = document.createElement("button");
      up.type = "button";
      up.textContent = "↑";
      up.setAttribute("aria-label", `Move ${definition.label} up`);
      up.onclick = () => {
        const previous = row.previousElementSibling;
        if (previous) container.insertBefore(row, previous);
        refreshDashboardPanelOrderButtons();
      };
      const down = document.createElement("button");
      down.type = "button";
      down.textContent = "↓";
      down.setAttribute("aria-label", `Move ${definition.label} down`);
      down.onclick = () => {
        const next = row.nextElementSibling;
        if (next) container.insertBefore(next, row);
        refreshDashboardPanelOrderButtons();
      };
      row.append(checkbox, label, up, down);
      fragment.appendChild(row);
    }
    container.replaceChildren(fragment);
    refreshDashboardPanelOrderButtons();
  }

  function refreshDashboardPanelOrderButtons() {
    const rows = Array.from(document.querySelectorAll("#dashboard-panel-order .dashboard-panel-row"));
    rows.forEach((row, index) => {
      const buttons = row.querySelectorAll("button");
      if (buttons[0]) buttons[0].disabled = index === 0;
      if (buttons[1]) buttons[1].disabled = index === rows.length - 1;
    });
  }

  function openDashboardSettings(createNew = false) {
    const profile = currentDashboardProfile();
    state.dashboardDraftProfileID = createNew ? "" : profile.id;
    document.getElementById("dashboard-profile-name").value = createNew ? "" : profile.name;
    document.getElementById("dashboard-layout").value = profile.layout;
    document.getElementById("dashboard-density").value = profile.density;
    document.getElementById("dashboard-background").value = profile.background;
    document.getElementById("dashboard-default").checked = !createNew && profile.id === state.ui.dashboard.default_profile_id;
    document.getElementById("dashboard-gcode-lines-count").value = String(profile.gcode_lines);
    document.getElementById("dashboard-delete").disabled = createNew || state.ui.dashboard.profiles.length <= 1;
    renderDashboardPanelOrder(profile.panels);
    document.getElementById("dashboard-settings-modal")?.showModal();
    document.getElementById("dashboard-profile-name")?.focus();
  }

  function closeDashboardSettings() {
    document.getElementById("dashboard-settings-modal")?.close();
    state.dashboardDraftProfileID = "";
  }

  function dashboardProfileFromForm() {
    const nameInput = document.getElementById("dashboard-profile-name");
    const name = String(nameInput?.value || "").trim();
    if (!name) {
      nameInput?.setCustomValidity("Enter a dashboard name.");
      nameInput?.reportValidity();
      return null;
    }
    nameInput.setCustomValidity("");
    const panels = Array.from(document.querySelectorAll("#dashboard-panel-order .dashboard-panel-row"))
      .filter((row) => row.querySelector('input[type="checkbox"]')?.checked)
      .map((row) => row.dataset.dashboardPanelOption);
    if (!panels.length) {
      setNotice("Dashboard layout requires at least one panel.", "error", "dashboard-settings");
      return null;
    }
    const lines = Math.max(3, Math.min(30, Math.trunc(Number(document.getElementById("dashboard-gcode-lines-count")?.value) || 9)));
    return {
      id: state.dashboardDraftProfileID || dashboardProfileSlug(name),
      name,
      layout: document.getElementById("dashboard-layout")?.value || "job-focus",
      density: document.getElementById("dashboard-density")?.value || "comfortable",
      background: document.getElementById("dashboard-background")?.value || "solid",
      panels,
      gcode_lines: lines,
    };
  }

  async function saveDashboardProfile() {
    const profile = dashboardProfileFromForm();
    if (!profile) return;
    const modal = document.getElementById("dashboard-settings-modal");
    const save = document.getElementById("dashboard-save");
    const previousDashboard = normalizeDashboardSettings(state.ui.dashboard);
    save.disabled = true;
    modal?.setAttribute("aria-busy", "true");
    const profiles = [...state.ui.dashboard.profiles];
    const index = profiles.findIndex((candidate) => candidate.id === profile.id);
    if (index >= 0) profiles[index] = profile;
    else profiles.push(profile);
    state.ui.dashboard.profiles = profiles;
    if (document.getElementById("dashboard-default")?.checked || !dashboardProfileByID(state.ui.dashboard.default_profile_id)) {
      state.ui.dashboard.default_profile_id = profile.id;
    }
    state.dashboardRequestedProfileID = profile.id;
    state.dashboardProfileID = profile.id;
    const saved = await saveUISettings({ successMessage: `Dashboard layout saved: ${profile.name}` });
    save.disabled = false;
    modal?.removeAttribute("aria-busy");
    if (!saved) {
      state.ui.dashboard = previousDashboard;
      resolveDashboardProfile();
      return;
    }
    closeDashboardSettings();
    selectDashboardProfile(profile.id, "push");
  }

  async function deleteDashboardProfile() {
    const profile = dashboardProfileByID(state.dashboardDraftProfileID);
    if (!profile || state.ui.dashboard.profiles.length <= 1) return;
    if (!confirm(`Delete dashboard layout “${profile.name}”?`)) return;
    const button = document.getElementById("dashboard-delete");
    const modal = document.getElementById("dashboard-settings-modal");
    const previousDashboard = normalizeDashboardSettings(state.ui.dashboard);
    button.disabled = true;
    modal?.setAttribute("aria-busy", "true");
    state.ui.dashboard.profiles = state.ui.dashboard.profiles.filter((candidate) => candidate.id !== profile.id);
    if (state.ui.dashboard.default_profile_id === profile.id) {
      state.ui.dashboard.default_profile_id = state.ui.dashboard.profiles[0].id;
    }
    state.dashboardRequestedProfileID = state.ui.dashboard.default_profile_id;
    state.dashboardProfileID = state.dashboardRequestedProfileID;
    const saved = await saveUISettings({ successMessage: `Dashboard layout deleted: ${profile.name}` });
    button.disabled = false;
    modal?.removeAttribute("aria-busy");
    if (!saved) {
      state.ui.dashboard = previousDashboard;
      resolveDashboardProfile();
      return;
    }
    closeDashboardSettings();
    selectDashboardProfile(state.dashboardProfileID, "replace");
  }

  async function copyDashboardURL(embed) {
    const profile = currentDashboardProfile();
    const url = new URL(window.location.href);
    url.pathname = "/dashboard";
    url.search = "";
    url.searchParams.set("profile", profile.id);
    if (embed) url.searchParams.set("embed", "1");
    try {
      await navigator.clipboard.writeText(url.href);
      setNotice(embed ? "OBS dashboard URL copied." : "Dashboard URL copied.", "ok", "dashboard-copy");
    } catch (error) {
      setNotice("Copying dashboard URL failed: " + error.message, "error", "dashboard-copy");
    }
  }

  return { dashboardURLState, dashboardProfileByID, currentDashboardProfile, isWideSurfaceOverview, dashboardPanelVisible, resolveDashboardProfile, applyDashboardURLState, syncDashboardProfileURL, selectDashboardProfile, renderDashboardProfileControls, applyDashboardProfile, dashboardProfileSlug, renderDashboardPanelOrder, refreshDashboardPanelOrderButtons, openDashboardSettings, closeDashboardSettings, dashboardProfileFromForm, saveDashboardProfile, deleteDashboardProfile, copyDashboardURL };
}
