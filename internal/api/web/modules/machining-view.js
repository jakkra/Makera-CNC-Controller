import { rectangle, surfaceMeasurements } from "./surface-facing.js";
import { setTextIfChanged } from "./dom.js";

// Readiness of each step before a facing program can be planned. Pure, so the
// checklist and its tests agree on what "done" means.
export function facingReadiness(outline = {}) {
  const points = (outline.points || []).map((p) => ({ x: p.machine_x, y: p.machine_y }));
  const closed = !!outline.closed && points.length >= 3;
  const rectangular = closed && !outline.curveFit && !!rectangle(points);
  const surface = surfaceMeasurements(outline);
  const probed = closed && !!outline.fieldProbeComplete && !!surface && surface.points.length >= 4;
  let outlineDetail = "Not captured";
  if (outline.active && !outline.closed) outlineDetail = `Capturing · ${points.length} point${points.length === 1 ? "" : "s"}`;
  else if (closed && !rectangular) outlineDetail = "Closed, but facing needs four corners aligned to X and Y";
  else if (rectangular) outlineDetail = "Four-corner outline ready";
  let probeDetail = "Not probed";
  if (outline.fieldProbePending) probeDetail = "Probing…";
  else if (probed) probeDetail = `${surface.points.length} points · ${surface.range.toFixed(3)} mm peak-to-valley`;
  else if (surface) probeDetail = "Partly probed";
  return {
    outline: { done: rectangular, detail: outlineDetail },
    probe: { done: rectangular && probed, detail: probeDetail },
    ready: rectangular && probed,
  };
}

export function createMachiningView({ document, getOutline, showTab, bindButtonAction }) {
  const node = (id) => document.getElementById(id);

  function step(name, { done, detail }) {
    const item = node("machining-step-" + name);
    if (!item) return;
    item.classList.toggle("done", done);
    setTextIfChanged(item.querySelector(".machining-step-state"), done ? "✓" : "•");
    setTextIfChanged(item.querySelector(".machining-step-detail"), detail);
  }

  function render() {
    if (node("machining-view")?.hidden !== false) return;
    const ready = facingReadiness(getOutline() || {});
    step("outline", ready.outline);
    step("probe", ready.probe);
    const open = node("surface-facing-open");
    if (open) {
      open.disabled = !ready.ready;
      open.title = ready.ready ? "" : "Capture the outline and probe the surface first";
    }
  }

  function bind() {
    for (const button of document.querySelectorAll("[data-machining-goto]")) {
      bindButtonAction(button, () => showTab(button.dataset.machiningGoto));
    }
  }

  return { bind, render };
}
