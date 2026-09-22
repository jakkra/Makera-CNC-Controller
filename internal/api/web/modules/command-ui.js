export function commandPanelPlacement(rect, preferredWidth, viewportWidth, viewportHeight) {
  const margin = 12;
  const width = Math.max(0, Math.min(preferredWidth, viewportWidth - margin * 2));
  const maxLeft = Math.max(margin, viewportWidth - margin - width);
  const left = Math.round(Math.min(Math.max(rect.left + rect.width / 2 - width / 2, margin), maxLeft));
  const belowTop = rect.bottom + 8;
  const belowHeight = viewportHeight - belowTop - margin;
  const aboveHeight = rect.top - margin - 8;
  const placeAbove = belowHeight < 180 && aboveHeight > belowHeight;
  const top = placeAbove
    ? Math.max(margin, rect.top - 8 - Math.max(0, aboveHeight))
    : Math.max(margin, belowTop);
  const maxHeight = Math.max(0, placeAbove ? aboveHeight : belowHeight);
  const arrowMin = Math.min(16, Math.max(0, width - 10));
  const arrowMax = Math.max(arrowMin, width - 26);
  const arrowLeft = Math.round(Math.min(Math.max(rect.left + rect.width / 2 - left - 5, arrowMin), arrowMax));
  return { top: Math.round(top), left, width, maxHeight: Math.round(maxHeight), arrowLeft, placement: placeAbove ? "above" : "below" };
}

export function commandPopoutSummary(popout) {
  return Array.from(popout?.children || []).find((el) => el.tagName === "SUMMARY") || null;
}

export function closeCommandPopout(popout, restoreFocus = true) {
  if (!popout?.open) return;
  popout.open = false;
  if (restoreFocus) commandPopoutSummary(popout)?.focus();
}

export function createCommandUI({
  documentRef,
  windowRef,
  elementCtor = globalThis.Element,
  getComputedStyleRef = globalThis.getComputedStyle,
  requestAnimationFrameRef = globalThis.requestAnimationFrame,
}) {
  function setDashboardControlsOpen(open, restoreFocus = false) {
    const button = documentRef.getElementById("dashboard-controls-toggle");
    const panel = documentRef.getElementById("dashboard-toolbar");
    if (!button || !panel) return;
    const expanded = !!open;
    panel.hidden = !expanded;
    button.setAttribute("aria-expanded", String(expanded));
    const label = expanded ? "Hide dashboard layout controls" : "Show dashboard layout controls";
    button.setAttribute("aria-label", label);
    button.title = label;
    if (!expanded && restoreFocus) button.focus();
  }

  function initDashboardControlsMenu() {
    const button = documentRef.getElementById("dashboard-controls-toggle");
    const panel = documentRef.getElementById("dashboard-toolbar");
    if (!button || !panel) return;
    button.onclick = () => setDashboardControlsOpen(panel.hidden);
    documentRef.addEventListener("click", (event) => {
      if (panel.hidden || button.contains(event.target) || panel.contains(event.target)) return;
      setDashboardControlsOpen(false);
    });
    documentRef.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || panel.hidden) return;
      event.preventDefault();
      setDashboardControlsOpen(false, true);
    });
  }

  function setWorkAreaActionsOpen(open, restoreFocus = false) {
    const button = documentRef.getElementById("workarea-actions-toggle");
    const panel = documentRef.getElementById("workarea-actions-panel");
    if (!button || !panel) return;
    panel.classList.toggle("is-open", !!open);
    button.setAttribute("aria-expanded", String(!!open));
    if (!open && restoreFocus) button.focus();
  }

  function initWorkAreaActionsMenu() {
    const button = documentRef.getElementById("workarea-actions-toggle");
    const panel = documentRef.getElementById("workarea-actions-panel");
    const close = panel?.querySelector(".workarea-actions-close");
    if (!button || !panel || !close) return;
    button.onclick = () => setWorkAreaActionsOpen(!panel.classList.contains("is-open"));
    close.onclick = () => setWorkAreaActionsOpen(false, true);
    documentRef.addEventListener("click", (event) => {
      if (!panel.classList.contains("is-open")) return;
      if (button.contains(event.target) || panel.contains(event.target)) return;
      setWorkAreaActionsOpen(false);
    });
    documentRef.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !panel.classList.contains("is-open")) return;
      event.preventDefault();
      setWorkAreaActionsOpen(false, true);
    });
    windowRef.addEventListener("resize", () => {
      if (windowRef.innerWidth > 600) setWorkAreaActionsOpen(false);
    });
  }

  function initCommandPopouts() {
    const popouts = Array.from(documentRef.querySelectorAll(".command-popout"));
    const commandMenu = documentRef.getElementById("command-menu");
    const commandActions = documentRef.getElementById("command-actions");
    const mobileToggle = documentRef.getElementById("mobile-actions-toggle");
    let positionFrame = 0;

    function setMobileMenuOpen(open) {
      commandActions?.classList.toggle("mobile-menu-open", !!open);
      mobileToggle?.setAttribute("aria-expanded", String(!!open));
    }

    mobileToggle?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      setMobileMenuOpen(!commandActions?.classList.contains("mobile-menu-open"));
    });

    const directChild = (el, predicate) => Array.from(el.children).find(predicate) || null;
    function positionPopout(popout) {
      if (!popout.open) return;
      const trigger = directChild(popout, (el) => el.tagName === "SUMMARY");
      const panel = directChild(popout, (el) => el.classList.contains("command-panel"));
      if (!trigger || !panel) return;

      const rect = trigger.getBoundingClientRect();
      const viewportWidth = windowRef.innerWidth || documentRef.documentElement.clientWidth || 1024;
      const viewportHeight = windowRef.innerHeight || documentRef.documentElement.clientHeight || 768;
      const preferredWidth = Number.parseFloat(getComputedStyleRef(panel).getPropertyValue("--command-panel-pref-width")) || 440;
      const placement = commandPanelPlacement(rect, preferredWidth, viewportWidth, viewportHeight);

      panel.style.setProperty("--command-panel-top", placement.top + "px");
      panel.style.setProperty("--command-panel-left", placement.left + "px");
      panel.style.setProperty("--command-panel-width", placement.width + "px");
      panel.style.setProperty("--command-panel-max-height", placement.maxHeight + "px");
      panel.style.setProperty("--command-panel-arrow-left", placement.arrowLeft + "px");
      panel.dataset.placement = placement.placement;
    }

    function positionOpenPopouts() {
      positionFrame = 0;
      for (const popout of popouts) positionPopout(popout);
    }

    function schedulePopoutPosition() {
      if (positionFrame) return;
      positionFrame = requestAnimationFrameRef(positionOpenPopouts);
    }

    for (const popout of popouts) {
      const trigger = commandPopoutSummary(popout);
      const panel = directChild(popout, (el) => el.classList.contains("command-panel"));
      const closeButton = panel?.querySelector(".command-panel-close");
      if (trigger) trigger.setAttribute("aria-expanded", "false");
      closeButton?.addEventListener("click", () => closeCommandPopout(popout));
      popout.addEventListener("toggle", () => {
        if (trigger) trigger.setAttribute("aria-expanded", String(popout.open));
        if (!popout.open) return;
        if (panel) panel.scrollTop = 0;
        for (const other of popouts) {
          if (other !== popout) closeCommandPopout(other, false);
        }
        schedulePopoutPosition();
      });
    }
    documentRef.addEventListener("click", (e) => {
      const target = e.target instanceof elementCtor ? e.target : null;
      if (target?.closest(".command-popout")) return;
      for (const popout of popouts) closeCommandPopout(popout, false);
      if (!target?.closest("#command-actions")) setMobileMenuOpen(false);
    });
    documentRef.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      for (const popout of popouts) closeCommandPopout(popout);
      setMobileMenuOpen(false);
      mobileToggle?.focus();
    });
    windowRef.addEventListener("resize", schedulePopoutPosition);
    windowRef.addEventListener("scroll", schedulePopoutPosition, true);
    commandMenu?.addEventListener("scroll", schedulePopoutPosition, { passive: true });
    windowRef.visualViewport?.addEventListener("resize", schedulePopoutPosition);
    windowRef.visualViewport?.addEventListener("scroll", schedulePopoutPosition);
  }

  function bindInteractions() {
    initCommandPopouts();
  }

  return {
    setDashboardControlsOpen,
    initDashboardControlsMenu,
    setWorkAreaActionsOpen,
    initWorkAreaActionsMenu,
    initCommandPopouts,
    bindInteractions,
  };
}
