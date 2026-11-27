import { RECTANGLE_TOLERANCE_MM, rectangle, surfaceMeasurements } from "./surface-facing.js";
import { setTextIfChanged } from "./dom.js";

const MIN_SIDE_MM = 2 * RECTANGLE_TOLERANCE_MM + 0.1;

// Readiness of each step before a facing program can be planned. Pure, so the
// guide and its tests agree on what "done" means.
export function facingReadiness(outline = {}) {
  const points = (outline.points || []).map((p) => ({ x: p.machine_x, y: p.machine_y }));
  const closed = !!outline.closed && points.length >= 3;
  const rectangular = closed && !outline.curveFit && !!rectangle(points);
  const surface = surfaceMeasurements(outline);
  const probed = closed && !!outline.fieldProbeComplete && !!surface && surface.points.length >= 4;
  let outlineDetail = "Not marked";
  if (outline.active && !outline.closed) outlineDetail = `${points.length} of 2 corners set`;
  else if (closed && !rectangular) outlineDetail = "The outline is not a rectangle aligned to X and Y. Start over.";
  else if (rectangular) {
    const box = rectangle(points);
    outlineDetail = `${(box.right - box.left).toFixed(1)} × ${(box.back - box.front).toFixed(1)} mm`;
  }
  let probeDetail = "Not measured";
  if (outline.fieldProbePending) {
    const total = (outline.fieldProbePreview || []).length;
    probeDetail = `Measuring point ${Math.min((outline.fieldProbeIndex || 0) + 1, total)} of ${total}…`;
  } else if (probed) probeDetail = `${surface.points.length} points · ${surface.range.toFixed(3)} mm high-to-low`;
  else if (surface) probeDetail = "Partly measured";
  return {
    outline: { done: rectangular, detail: outlineDetail },
    probe: { done: rectangular && probed, detail: probeDetail },
    ready: rectangular && probed,
  };
}

// Expand two opposite corners into a closed, axis-aligned outline. Work
// coordinates are derived from the work offset recorded with the first corner.
export function rectangleFromCorners(a, b) {
  if (![a, b].every((p) => [p?.x, p?.y, p?.machine_x, p?.machine_y].every(Number.isFinite))) return null;
  if (Math.abs(a.machine_x - b.machine_x) < MIN_SIDE_MM || Math.abs(a.machine_y - b.machine_y) < MIN_SIDE_MM) return null;
  const offset = { x: a.machine_x - a.x, y: a.machine_y - a.y };
  const corner = (mx, my, source, id) => ({
    ...source, id, x: mx - offset.x, y: my - offset.y, machine_x: mx, machine_y: my,
  });
  return [
    corner(a.machine_x, a.machine_y, a, a.id),
    corner(b.machine_x, a.machine_y, a, `${a.id}-b`),
    corner(b.machine_x, b.machine_y, b, b.id),
    corner(a.machine_x, b.machine_y, b, `${b.id}-d`),
  ];
}

export const DEFAULT_PROBE_GRID = Object.freeze({ columns: 3, rows: 3, insetMM: 10 });

export function createMachiningView({
  document, getOutline, getMachine, getJog, getReadOnly = () => false, showTab, bindButtonAction,
  startOutlineCapture, addOutlinePoint, closeOutline, flushOutlineFieldSpacingUpdate, runFieldProbe,
  toggleArm, sendStep, isProbeToolActive, setStatusMessage,
  saveSession = () => {}, loadSession = () => false,
}) {
  const node = (id) => document.getElementById(id);
  const feedback = (text, kind = "error") => setStatusMessage("facing-guide", text, kind, { force: true });
  let owned = false;
  let sessionKey = "";

  // Keep the marked stock and its measurements across reloads and deploys,
  // so a test does not mean probing everything again.
  function persist() {
    const o = getOutline() || {};
    if (o.fieldProbePending || o.addPointPending) return;
    const key = [o.active, o.closed, (o.points || []).length, (o.fieldProbeResults || []).length, o.fieldProbeComplete,
      JSON.stringify(o.fieldProbeGrid || null)].join("|");
    if (key === sessionKey) return;
    sessionKey = key;
    saveSession();
  }

  function restoreSession() {
    if (loadSession()) {
      sessionKey = "";
      persist();
      render();
    }
  }

  function selectedGrid() {
    const size = Number(node("facing-grid")?.value) || DEFAULT_PROBE_GRID.columns;
    const inset = Number(node("facing-inset")?.value);
    return { columns: size, rows: size, insetMM: Number.isFinite(inset) ? inset : DEFAULT_PROBE_GRID.insetMM };
  }

  // Re-plan the probe points; this clears any earlier measurement of them.
  function applyGrid() {
    const o = getOutline();
    if (!o?.closed || o.fieldProbePending) return;
    o.fieldProbeGrid = selectedGrid();
    flushOutlineFieldSpacingUpdate();
    render();
  }

  function step(name, { done, detail }, locked = false) {
    const item = node("machining-step-" + name);
    if (!item) return;
    item.classList.toggle("done", done);
    item.classList.toggle("locked", locked);
    setTextIfChanged(item.querySelector(".machining-step-detail"), detail);
  }

  function corners(outline) {
    const points = outline.points || [];
    if (outline.closed && points.length === 4) return [points[0], points[2]];
    return [points[0] || null, points[1] || null];
  }

  // Once the second corner lands, turn the two corners into a closed rectangle.
  function completeRectangle() {
    const o = getOutline();
    if (!owned || !o?.active || o.closed || o.points.length !== 2 || o.addPointPending || o.addPointQueued) return;
    const rect = rectangleFromCorners(o.points[0], o.points[1]);
    if (!rect) {
      o.points.pop();
      feedback(`Corner 2 must be at least ${MIN_SIDE_MM.toFixed(0)} mm away from corner 1 in both X and Y. Move to the opposite corner and set it again.`);
      return;
    }
    o.points = rect;
    owned = false;
    o.fieldProbeGrid = selectedGrid();
    closeOutline();
  }

  function render() {
    persist();
    if (node("machining-view")?.hidden !== false) return;
    completeRectangle();
    const outline = getOutline() || {};
    const machine = getMachine() || {};
    const jog = getJog() || {};
    const ready = facingReadiness(outline);
    const readOnly = getReadOnly();
    step("outline", ready.outline);
    step("probe", ready.probe, !ready.outline.done);
    step("plan", { done: false, detail: ready.ready ? "Ready to plan" : "" }, !ready.ready);

    // Step 1: jog and corners.
    const arm = node("facing-arm");
    setTextIfChanged(arm, jog.armPending ? "…" : jog.armed ? "Disarm Movement" : "Arm Movement");
    arm.classList.toggle("armed", !!jog.armed);
    arm.disabled = readOnly || !!jog.armPending;
    for (const button of document.querySelectorAll("[data-facing-jog]")) button.disabled = readOnly || !jog.armed || !!jog.surfaceStepPending;
    const w = machine.wpos || {};
    setTextIfChanged(node("facing-position"), Number.isFinite(w.x) && Number.isFinite(w.y)
      ? `X ${w.x.toFixed(2)}  Y ${w.y.toFixed(2)}${Number.isFinite(w.z) ? `  Z ${w.z.toFixed(2)}` : ""}` : "Position unknown");
    const [c1, c2] = corners(outline);
    const at = (p) => p ? `X ${p.x.toFixed(2)}  Y ${p.y.toFixed(2)}` : "not set";
    setTextIfChanged(node("facing-corner-1-value"), at(c1));
    setTextIfChanged(node("facing-corner-2-value"), at(c2));
    const capturing = !!outline.addPointPending || !!outline.addPointQueued;
    const laser = isProbeToolActive();
    node("facing-corner-1").disabled = readOnly || capturing || outline.fieldProbePending;
    node("facing-corner-2").disabled = readOnly || capturing || !c1 || !!outline.closed || outline.fieldProbePending;
    node("facing-corners-reset").hidden = !c1;
    node("facing-tool-warning").hidden = laser;

    // Step 2: measure.
    const disarmNeeded = !!jog.armed;
    node("facing-measure-disarm").hidden = !disarmNeeded;
    node("facing-measure-tool").hidden = laser;
    const count = (outline.fieldProbePreview || []).length;
    const grid = outline.fieldProbeGrid;
    setTextIfChanged(node("facing-measure-plan"), !ready.outline.done ? ""
      : outline.fieldProbeIssue ? `Cannot place the points: ${outline.fieldProbeIssue}.`
      : grid ? `${count} points, ${grid.insetMM} mm in from the edges` : `${count} points (outline from Probing)`);
    for (const id of ["facing-grid", "facing-inset"]) node(id).disabled = readOnly || !ready.outline.done || !!outline.fieldProbePending;
    const measure = node("facing-measure");
    measure.disabled = readOnly || !ready.outline.done || !laser || disarmNeeded || !!outline.fieldProbePending || ready.probe.done ||
      !count || !!outline.fieldProbeIssue;
    const measured = (outline.fieldProbeResults || []).length;
    const left = Math.max(0, count - measured);
    setTextIfChanged(measure, outline.fieldProbePending ? "Measuring…" : ready.probe.done ? "Surface measured"
      : measured && left ? `Continue measuring (${left} left)` : "Measure surface");
    const failure = !outline.fieldProbePending && outline.feedbackKind === "error" &&
      /^Field Z probe failed/.test(outline.feedback || "") ? outline.feedback : "";
    node("facing-measure-error").hidden = !failure;
    setTextIfChanged(node("facing-measure-error"), failure);

    // Step 3: plan.
    const open = node("surface-facing-open");
    open.disabled = !ready.ready;
  }

  function setCorner(index) {
    const o = getOutline();
    if (index === 1) {
      if (o.points?.length && !document.defaultView?.confirm?.("Start over with a new corner 1? The current corners and measurements are cleared.")) return;
      startOutlineCapture();
      owned = true;
    } else {
      if (o.closed || o.points?.length !== 1) return;
      owned = true;
    }
    addOutlinePoint();
    render();
  }

  function bind() {
    for (const button of document.querySelectorAll("[data-machining-goto]")) {
      bindButtonAction(button, () => showTab(button.dataset.machiningGoto));
    }
    bindButtonAction(node("facing-arm"), () => { toggleArm(); render(); });
    for (const button of document.querySelectorAll("[data-facing-jog]")) {
      bindButtonAction(button, () => {
        const [axis, sign] = button.dataset.facingJog;
        sendStep(axis, sign === "-" ? -1 : 1, Number(node("facing-jog-step").value) || 1);
      });
    }
    bindButtonAction(node("facing-corner-1"), () => setCorner(1));
    bindButtonAction(node("facing-corner-2"), () => setCorner(2));
    bindButtonAction(node("facing-corners-reset"), () => setCorner(1));
    for (const id of ["facing-grid", "facing-inset"]) node(id).addEventListener("change", applyGrid);
    bindButtonAction(node("facing-measure-disarm"), () => { toggleArm(); render(); });
    bindButtonAction(node("facing-measure"), async () => {
      await runFieldProbe({ purpose: "facing" });
      render();
    });
  }

  return { bind, render, restoreSession };
}
