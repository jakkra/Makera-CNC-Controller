// Navigation and browser lifecycle ownership for the native DOM application.
// The callbacks are deliberately explicit: this module does not know about
// machine state, features, or API payloads, and therefore cannot invent a
// second lifecycle for those concerns.

export const DEFAULT_VIEW_TABS = ["dashboard", "active-job", "jog", "control", "files", "maintenance", "attention"];
export const DEFAULT_NAV_VIEW_TABS = ["dashboard", "active-job", "jog", "control", "files"];
export const FOREGROUND_PAGE_RELOAD_MS = 60000;
export const PULL_TO_REFRESH_DISTANCE_PX = 88;
export const PULL_TO_REFRESH_DIRECTION_SLOP_PX = 16;

export function viewTabFromURL(locationLike = {}, {
  viewTabs = DEFAULT_VIEW_TABS,
  windowRef = globalThis.window,
} = {}) {
  const pathname = String(locationLike?.pathname || "/").replace(/^\/+|\/+$/g, "");
  if (viewTabs.includes(pathname)) return pathname;
  const queryTab = new URLSearchParams(String(locationLike?.search || "")).get("tab");
  if (viewTabs.includes(queryTab)) return queryTab;
  return windowRef?.matchMedia?.("(max-width: 600px)")?.matches ? "dashboard" : "active-job";
}

export function syncViewTabURL(name, mode, {
  windowRef = globalThis.window,
} = {}) {
  if (mode === "none" || !windowRef?.history) return;
  const url = new URL(windowRef.location.href);
  url.pathname = "/" + name;
  url.searchParams.delete("tab");
  url.hash = "";
  const next = url.pathname + url.search;
  const current = windowRef.location.pathname + windowRef.location.search;
  if (mode === "push" && next === current) return;
  const method = mode === "replace" ? "replaceState" : "pushState";
  windowRef.history[method]({ tab: name }, "", next);
}

export function createNavigationFeature({
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  viewTabs = DEFAULT_VIEW_TABS,
  navViewTabs = DEFAULT_NAV_VIEW_TABS,
  getActiveTab = () => "active-job",
  setActiveTab = () => {},
  getMachine = () => ({}),
  getSurface = () => ({}),
  setSurface = () => {},
  isSurfaceKiosk = () => false,
  disarmMovementOnControlExit = () => {},
  setDashboardControlsOpen = () => {},
  connectFilesSSE = () => {},
  renderActiveGcode = () => {},
  renderDashboard = () => {},
  renderJog = () => {},
  maintenanceLoad = () => {},
  clearNotice = () => {},
  syncDashboardCameras = () => {},
} = {}) {
  const document = documentRef;
  const window = windowRef;

  function setHeaderCollapsed(collapsed) {
    const button = document?.getElementById("header-toggle");
    document?.body?.classList.toggle("header-collapsed", !!collapsed);
    if (!button) return;
    const expanded = !collapsed;
    const label = expanded ? "Hide top bars" : "Show top bars";
    button.textContent = expanded ? "▴" : "▾";
    button.setAttribute("aria-expanded", String(expanded));
    button.setAttribute("aria-label", label);
    button.title = label;
    if (collapsed) document.querySelectorAll?.(".command-popout[open]").forEach((popout) => { popout.open = false; });
  }

  function showTab(name, urlMode = "push") {
    if (!viewTabs.includes(name)) name = "active-job";
    if (urlMode === "push" && isSurfaceKiosk()) {
      const surface = getSurface() || {};
      setSurface({ ...surface, manual_view_state: String(getMachine()?.state || "") });
    }
    disarmMovementOnControlExit(name);
    setActiveTab(name);
    if (name !== "dashboard") setDashboardControlsOpen(false);
    if (document?.body) document.body.dataset.activeTab = name;
    for (const tab of viewTabs) {
      const view = document?.getElementById(tab + "-view");
      if (view) view.hidden = tab !== name;
      const button = document?.getElementById("tab-" + tab);
      const active = tab === name;
      button?.classList.toggle("active", active);
      button?.setAttribute("aria-selected", String(active));
      if (button) button.tabIndex = active ? 0 : -1;
    }
    for (const button of document?.querySelectorAll?.("[data-surface-view]") || []) {
      if (button.dataset.surfaceView === name) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
    if (name === "files") connectFilesSSE();
    if (name === "active-job") renderActiveGcode();
    if (name === "dashboard") renderDashboard();
    if (name === "control" || name === "jog") renderJog();
    if (name === "maintenance") maintenanceLoad();
    else clearNotice("jog-availability");
    syncDashboardCameras();
    syncViewTabURL(name, urlMode, { windowRef: window });
  }

  function bindInteractions({
    showTab: showTabCallback = showTab,
    setHeaderCollapsed: setHeaderCollapsedCallback = setHeaderCollapsed,
    reloadPage = () => window?.location?.reload(),
    applyDashboardURLState = () => {},
    viewTabFromURL: viewTabFromURLCallback = viewTabFromURL,
  } = {}) {
    applyDashboardURLState();
    document.getElementById("header-toggle").onclick = () => setHeaderCollapsedCallback(!document.body.classList.contains("header-collapsed"));
    document.getElementById("development-refresh").onclick = reloadPage;
    for (const [index, name] of navViewTabs.entries()) {
      const tab = document.getElementById("tab-" + name);
      tab.onclick = () => showTabCallback(name);
      tab.onkeydown = (e) => {
        let next = index;
        if (e.key === "ArrowRight") next = (index + 1) % navViewTabs.length;
        else if (e.key === "ArrowLeft") next = (index - 1 + navViewTabs.length) % navViewTabs.length;
        else if (e.key === "Home") next = 0;
        else if (e.key === "End") next = navViewTabs.length - 1;
        else return;
        e.preventDefault();
        const nextTab = document.getElementById("tab-" + navViewTabs[next]);
        showTabCallback(navViewTabs[next]);
        nextTab.focus();
      };
    }
    window.addEventListener("popstate", () => {
      applyDashboardURLState();
      showTabCallback(viewTabFromURLCallback(window.location, { viewTabs, windowRef: window }), "none");
    });
    showTabCallback(viewTabFromURLCallback(window.location, { viewTabs, windowRef: window }), "replace");
  }

  return { setHeaderCollapsed, showTab, bindInteractions };
}

export function pageScrollIsAtTop({ documentRef = globalThis.document, windowRef = globalThis.window } = {}) {
  const root = documentRef?.scrollingElement || documentRef?.documentElement;
  return Math.max(Number(windowRef?.scrollY) || 0, Number(root?.scrollTop) || 0) <= 0;
}

export function pullToRefreshTargetAllowed(target, { ElementCtor = globalThis.Element } = {}) {
  if (!ElementCtor || !(target instanceof ElementCtor)) return false;
  return !target.closest("button, a, input, select, textarea, [contenteditable], [role=slider], dialog, canvas, video");
}

export function createLifecycleFeature({
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  ElementCtor = globalThis.Element,
  now = () => Date.now(),
  getPageHiddenAt = () => 0,
  setPageHiddenAt = () => {},
  reloadPage: reloadPageCallback = () => windowRef?.location?.reload(),
  stopDashboardBuiltinCamera = () => {},
  stopDashboardExternalCamera = () => {},
  resetEventStream = () => {},
  connectControlSSE = () => {},
  filesIsLoaded = () => false,
  connectFilesSSE = () => {},
  loadDashboardCameras = () => {},
  loadActiveGcode = () => {},
  loadAPICapabilities = () => {},
  loadJogCapabilities = () => {},
  pollMachine = () => {},
  getActiveTab = () => "",
  maintenanceLoad = () => {},
  setJogInputSuspended = () => {},
  releaseJogInput = () => false,
  renderJog = () => {},
  connectJog = () => {},
  scheduleJogSample = () => {},
  getPreferredPadIndex = () => null,
  setPreferredPadIndex = () => {},
  clearJogError = () => {},
  viewTabs = DEFAULT_VIEW_TABS,
} = {}) {
  const document = documentRef;
  const window = windowRef;
  let pullToRefreshGesture = null;

  function reloadPage() { reloadPageCallback(); }

  function recoverForegroundSession() {
    const hiddenAt = getPageHiddenAt();
    const hiddenFor = hiddenAt ? now() - hiddenAt : 0;
    setPageHiddenAt(0);
    if (hiddenFor >= FOREGROUND_PAGE_RELOAD_MS) {
      reloadPage();
      return true;
    }
    stopDashboardBuiltinCamera();
    stopDashboardExternalCamera();
    resetEventStream("controlES");
    resetEventStream("filesES");
    connectControlSSE();
    if (filesIsLoaded()) connectFilesSSE();
    loadDashboardCameras();
    loadActiveGcode();
    loadAPICapabilities();
    loadJogCapabilities();
    pollMachine();
    if (getActiveTab() === "maintenance") maintenanceLoad();
    return false;
  }

  function updatePullToRefreshIndicator(distance = 0, ready = false) {
    const progress = Math.max(0, Math.min(1, Number(distance) / PULL_TO_REFRESH_DISTANCE_PX));
    document?.body?.classList.toggle("pull-refresh-pulling", progress > 0);
    document?.body?.classList.toggle("pull-refresh-ready", !!ready);
    document?.documentElement?.style?.setProperty("--pull-refresh-offset", `${Math.round(progress * 48)}px`);
    document?.documentElement?.style?.setProperty("--pull-refresh-turn", `${Math.round(progress * 180)}deg`);
  }

  function installPullToRefresh() {
    if (!window?.matchMedia?.("(pointer: coarse)")?.matches) return false;
    document?.addEventListener("touchstart", (event) => {
      const touch = event.touches?.[0];
      if (!touch || event.touches.length !== 1 || !pageScrollIsAtTop({ documentRef: document, windowRef: window }) || !pullToRefreshTargetAllowed(event.target, { ElementCtor })) {
        pullToRefreshGesture = null;
        updatePullToRefreshIndicator();
        return;
      }
      pullToRefreshGesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY, triggered: false };
    }, { passive: true });
    document?.addEventListener("touchmove", (event) => {
      const gesture = pullToRefreshGesture;
      if (!gesture) return;
      const touch = [...event.touches].find((candidate) => candidate.identifier === gesture.id);
      if (!touch) { pullToRefreshGesture = null; updatePullToRefreshIndicator(); return; }
      const deltaX = touch.clientX - gesture.x;
      const deltaY = touch.clientY - gesture.y;
      if (deltaY <= 0 || (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > PULL_TO_REFRESH_DIRECTION_SLOP_PX)) {
        pullToRefreshGesture = null;
        updatePullToRefreshIndicator();
        return;
      }
      const ready = deltaY >= PULL_TO_REFRESH_DISTANCE_PX;
      updatePullToRefreshIndicator(deltaY, ready);
      if (!ready || gesture.triggered) return;
      gesture.triggered = true;
      event.preventDefault();
    }, { passive: false });
    document?.addEventListener("touchend", () => {
      const triggered = pullToRefreshGesture?.triggered;
      pullToRefreshGesture = null;
      updatePullToRefreshIndicator();
      if (triggered) reloadPage();
    }, { passive: true });
    document?.addEventListener("touchcancel", () => { pullToRefreshGesture = null; updatePullToRefreshIndicator(); }, { passive: true });
    return true;
  }

  function bindBrowserLifecycle() {
    window?.addEventListener("online", () => loadJogCapabilities());
    document?.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        setPageHiddenAt(now());
        stopDashboardBuiltinCamera();
        stopDashboardExternalCamera();
        setJogInputSuspended(true);
        if (releaseJogInput(true)) renderJog();
      } else {
        setJogInputSuspended(false);
        if (recoverForegroundSession()) return;
        connectJog();
        scheduleJogSample();
      }
    });
    window?.addEventListener("blur", () => { setJogInputSuspended(true); if (releaseJogInput(true)) renderJog(); });
    window?.addEventListener("focus", () => { if (document.hidden) return; setJogInputSuspended(false); connectJog(); scheduleJogSample(); });
    window?.addEventListener("pageshow", (event) => { if (event.persisted) reloadPage(); });
    window?.addEventListener("pagehide", () => { stopDashboardBuiltinCamera(); stopDashboardExternalCamera(); setJogInputSuspended(true); releaseJogInput(true); });
    window?.addEventListener("gamepadconnected", (event) => { setPreferredPadIndex(event.gamepad?.index ?? getPreferredPadIndex()); clearJogError(); connectJog(); scheduleJogSample(); renderJog(); });
    window?.addEventListener("gamepaddisconnected", (event) => { if (getPreferredPadIndex() === event.gamepad?.index) setPreferredPadIndex(null); releaseJogInput(true); renderJog(); });
  }

  return { reloadPage, recoverForegroundSession, pageScrollIsAtTop: () => pageScrollIsAtTop({ documentRef: document, windowRef: window }), pullToRefreshTargetAllowed: (target) => pullToRefreshTargetAllowed(target, { ElementCtor }), updatePullToRefreshIndicator, installPullToRefresh, bindBrowserLifecycle };
}
