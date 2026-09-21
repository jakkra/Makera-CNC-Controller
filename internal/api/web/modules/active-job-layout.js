// Active Job's local layout state. This module owns only the two-pane view
// chrome; job loading, controls, and G-code rendering remain separate.

export const DEFAULT_ACTIVE_JOB_SPLIT_PERCENT = 32;
export const ACTIVE_JOB_SPLIT_STEP_PERCENT = 2;
export const ACTIVE_JOB_SPLIT_MIN_LEFT_PX = 260;
export const ACTIVE_JOB_SPLIT_MIN_PREVIEW_PX = 320;
export const ACTIVE_JOB_SPLITTER_PX = 16;

export function activeJobSplitBounds(width, {
  minLeftPx = ACTIVE_JOB_SPLIT_MIN_LEFT_PX,
  minPreviewPx = ACTIVE_JOB_SPLIT_MIN_PREVIEW_PX,
  splitterPx = ACTIVE_JOB_SPLITTER_PX,
} = {}) {
  const available = Number(width);
  if (!(available > 0)) return { min: 0, max: 100 };
  const min = Math.min(50, (minLeftPx / available) * 100);
  const previewMax = ((available - splitterPx - minPreviewPx) / available) * 100;
  return {
    min,
    max: Math.max(min, Math.min(100, previewMax)),
  };
}

export function createActiveJobLayout({
  documentRef = globalThis.document,
  getState = () => ({}),
  scheduleActiveGcodeSourceRender = () => {},
  scheduleGcodeRender = () => {},
  renderGcodeLog = () => {},
  defaultSplitPercent = DEFAULT_ACTIVE_JOB_SPLIT_PERCENT,
  splitStepPercent = ACTIVE_JOB_SPLIT_STEP_PERCENT,
  minLeftPx = ACTIVE_JOB_SPLIT_MIN_LEFT_PX,
  minPreviewPx = ACTIVE_JOB_SPLIT_MIN_PREVIEW_PX,
  splitterPx = ACTIVE_JOB_SPLITTER_PX,
} = {}) {
  const document = documentRef;
  const state = getState();
  const boundsFor = (width) => activeJobSplitBounds(width, { minLeftPx, minPreviewPx, splitterPx });

  function showActiveJobLeftTab(name) {
    const tabs = ["source", "console"];
    if (!tabs.includes(name)) name = "source";
    state.activeJobLeftTab = name;
    for (const tab of tabs) {
      const button = document.getElementById("active-job-left-tab-" + tab);
      const panel = document.getElementById(tab === "source" ? "active-gcode-source" : "active-gcode-console");
      const active = tab === name;
      if (panel) panel.hidden = !active;
      button?.setAttribute("aria-selected", String(active));
      if (button) button.tabIndex = active ? 0 : -1;
    }
    document.getElementById("active-gcode-left")?.classList.toggle("is-console-active", name === "console");
    document.getElementById("active-gcode-source-position")?.classList.toggle("is-hidden", name !== "source");
    if (name === "source") scheduleActiveGcodeSourceRender();
    else renderGcodeLog();
  }

  function setActiveJobSplitPercent(percent) {
    const workspace = document.querySelector(".active-gcode-workspace");
    const splitter = document.getElementById("active-gcode-splitter");
    if (!workspace || !splitter) return;
    const bounds = boundsFor(workspace.clientWidth);
    const next = Math.max(bounds.min, Math.min(bounds.max, Number(percent) || defaultSplitPercent));
    state.activeJobSplitPercent = next;
    workspace.style.setProperty("--active-gcode-left-width", `${next}%`);
    splitter.setAttribute("aria-valuemin", String(Math.round(bounds.min)));
    splitter.setAttribute("aria-valuemax", String(Math.round(bounds.max)));
    splitter.setAttribute("aria-valuenow", String(Math.round(next)));
    splitter.setAttribute("aria-valuetext", `Job details ${Math.round(next)} percent`);
    scheduleActiveGcodeSourceRender();
    scheduleGcodeRender();
  }

  function bindActiveJobSplitter() {
    const workspace = document.querySelector(".active-gcode-workspace");
    const splitter = document.getElementById("active-gcode-splitter");
    if (!workspace || !splitter) return;
    const setFromClientX = (clientX) => {
      const rect = workspace.getBoundingClientRect();
      if (!(rect.width > 0)) return;
      setActiveJobSplitPercent(((clientX - rect.left) / rect.width) * 100);
    };
    splitter.onpointerdown = (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      splitter.classList.add("dragging");
      splitter.setPointerCapture(event.pointerId);
      setFromClientX(event.clientX);
    };
    splitter.onpointermove = (event) => {
      if (!splitter.hasPointerCapture(event.pointerId)) return;
      setFromClientX(event.clientX);
    };
    const release = (event) => {
      if (splitter.hasPointerCapture(event.pointerId)) splitter.releasePointerCapture(event.pointerId);
      splitter.classList.remove("dragging");
    };
    splitter.onpointerup = release;
    splitter.onpointercancel = release;
    splitter.onlostpointercapture = () => splitter.classList.remove("dragging");
    splitter.onkeydown = (event) => {
      const bounds = boundsFor(workspace.clientWidth);
      let next = state.activeJobSplitPercent;
      if (event.key === "ArrowLeft") next -= splitStepPercent;
      else if (event.key === "ArrowRight") next += splitStepPercent;
      else if (event.key === "Home") next = bounds.min;
      else if (event.key === "End") next = bounds.max;
      else return;
      event.preventDefault();
      setActiveJobSplitPercent(next);
    };
    setActiveJobSplitPercent(state.activeJobSplitPercent);
  }

  return { showActiveJobLeftTab, activeJobSplitBounds: boundsFor, setActiveJobSplitPercent, bindActiveJobSplitter };
}
