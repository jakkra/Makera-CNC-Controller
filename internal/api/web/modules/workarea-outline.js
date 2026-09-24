// Mechanical work-area/outline extraction. Bodies preserve current app.js behavior.
import * as geometry from "./outline-geometry.js";
export { geometry };
export function axisValue(values, axis) {
  const n = Number(values?.[axis]);
  return Number.isFinite(n) ? n : null;
}
export function mountWorkareaOutline({ stateFacade, documentRef, constants = {}, geometryModule = geometry, callbacks = {}, defaultWorkAreaView = () => ({ zoom: 1, panX: 0, panY: 0 }), normalizeMachineSettings = (m) => m || {}, currentWorkOrigin = () => null, currentAxisValues = () => ({}), syncGcodeContextOverlay = () => false, gcodeContextOverlayBounds = () => null, setWorkAreaToolRadius = () => {}, markGcodeContextOverlayDirty = () => {}, hasGcodeRenderer = () => false, renderActiveGcode = () => {}, renderWorkAreaOutline = () => {}, renderWorkAreaFieldProbePreview = () => {}, visualWorkOrigin = () => null, tapMoveTargetBusy = () => false, jogEstimateActive = () => false, hasPendingOriginOperation = () => false, updateFieldProbePreview = () => {}, machineActionState = () => "Unknown", finiteOr = (v, fallback) => Number.isFinite(Number(v)) ? Number(v) : fallback, clampNumber = (n, min, max) => Math.max(min, Math.min(max, n)), cloneOutlinePoint = (p) => ({ ...p }), cloneOutlineOrigin = (p) => p ? ({ ...p }) : null, pathNum = (n) => Number.isFinite(n) ? (Math.abs(Number(n)) < 0.00005 ? 0 : Number(n)).toFixed(4).replace(/\.?0+$/, "") : "0", fmtCoord = (n) => Number.isFinite(Number(n)) ? Number(n).toFixed(3) : "-", newID = (prefix) => `${prefix}-${Date.now()}`, clearNotice = () => {}, renderOutlineCapture = () => {}, renderWorkArea = () => {} } = {}) {
  if (!stateFacade) throw new TypeError("stateFacade is required");
  const state = stateFacade;
  const document = documentRef;
  const { WORKAREA_PAD = 6, WORKAREA_VIEW_SIZE = 100, WORKAREA_MIN_ZOOM = 1, WORKAREA_MAX_ZOOM = 8, WORKAREA_ZOOM_STEP = 1.25, WORKAREA_PAN_THRESHOLD_PX = 4, OUTLINE_CAPTURE_POSITION_TOLERANCE_MM = 0.02 } = constants;
  const { setTextIfChanged = () => {}, setStatusMessage = () => {}, renderOutline = () => {}, renderProbePreview = () => {} } = callbacks;
  function normalizeWorkAreaView() {
    const v = state.workarea || (state.workarea = defaultWorkAreaView());
    v.zoom = clampNumber(Number(v.zoom) || WORKAREA_MIN_ZOOM, WORKAREA_MIN_ZOOM, WORKAREA_MAX_ZOOM);
    const half = WORKAREA_VIEW_SIZE / (2 * v.zoom);
    const cx = clampNumber(WORKAREA_VIEW_SIZE / 2 + finiteOr(v.panX, 0), half, WORKAREA_VIEW_SIZE - half);
    const cy = clampNumber(WORKAREA_VIEW_SIZE / 2 + finiteOr(v.panY, 0), half, WORKAREA_VIEW_SIZE - half);
    v.panX = cx - WORKAREA_VIEW_SIZE / 2;
    v.panY = cy - WORKAREA_VIEW_SIZE / 2;
    return v;
  }

  function workAreaViewCenter() {
    const v = normalizeWorkAreaView();
    return {
      x: WORKAREA_VIEW_SIZE / 2 + v.panX,
      y: WORKAREA_VIEW_SIZE / 2 + v.panY,
    };
  }

  function applyWorkAreaViewport() {
    const group = document.getElementById("workarea-viewport");
    const v = normalizeWorkAreaView();
    const c = workAreaViewCenter();
    if (group) {
      group.setAttribute("transform", `translate(${WORKAREA_VIEW_SIZE / 2} ${WORKAREA_VIEW_SIZE / 2}) scale(${pathNum(v.zoom)}) translate(${pathNum(-c.x)} ${pathNum(-c.y)})`);
    }
    const zoomOut = document.getElementById("workarea-zoom-out");
    const reset = document.getElementById("workarea-zoom-reset");
    const zoomIn = document.getElementById("workarea-zoom-in");
    if (zoomOut) zoomOut.disabled = v.zoom <= WORKAREA_MIN_ZOOM + 1e-6;
    if (zoomIn) zoomIn.disabled = v.zoom >= WORKAREA_MAX_ZOOM - 1e-6;
    if (reset) reset.disabled = v.zoom <= WORKAREA_MIN_ZOOM + 1e-6 && Math.abs(v.panX) < 1e-6 && Math.abs(v.panY) < 1e-6;
  }

  function resetWorkAreaView() {
    state.workarea = { ...defaultWorkAreaView() };
    applyWorkAreaViewport();
  }

  function setWorkAreaZoom(nextZoom, anchorLocal = null) {
    const v = normalizeWorkAreaView();
    const anchor = anchorLocal || { x: WORKAREA_VIEW_SIZE / 2, y: WORKAREA_VIEW_SIZE / 2 };
    const anchorContent = workAreaLocalToContentPoint(anchor);
    v.zoom = clampNumber(Number(nextZoom) || v.zoom, WORKAREA_MIN_ZOOM, WORKAREA_MAX_ZOOM);
    v.panX = anchorContent.x - ((anchor.x - WORKAREA_VIEW_SIZE / 2) / v.zoom) - WORKAREA_VIEW_SIZE / 2;
    v.panY = anchorContent.y - ((anchor.y - WORKAREA_VIEW_SIZE / 2) / v.zoom) - WORKAREA_VIEW_SIZE / 2;
    applyWorkAreaViewport();
  }

  function zoomWorkArea(multiplier, anchorLocal = null) {
    const v = normalizeWorkAreaView();
    setWorkAreaZoom(v.zoom * multiplier, anchorLocal);
  }

  function panWorkArea(deltaX, deltaY) {
    const v = normalizeWorkAreaView();
    v.panX -= deltaX / v.zoom;
    v.panY -= deltaY / v.zoom;
    applyWorkAreaViewport();
  }

  function workAreaSVGPointFromClient(e) {
    const svg = document.getElementById("workarea-plot");
    if (!svg) return null;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    return pt.matrixTransform(ctm.inverse());
  }

  function workAreaLocalToContentPoint(local) {
    const v = normalizeWorkAreaView();
    const c = workAreaViewCenter();
    return {
      x: ((local.x - WORKAREA_VIEW_SIZE / 2) / v.zoom) + c.x,
      y: ((local.y - WORKAREA_VIEW_SIZE / 2) / v.zoom) + c.y,
    };
  }

  function hideWorkAreaHoverPosition() {
    const el = document.getElementById("workarea-hover-position");
    if (!el) return;
    el.hidden = true;
  }

  function updateWorkAreaHoverPosition(local) {
    const el = document.getElementById("workarea-hover-position");
    if (!el) return;
    if (!local) {
      hideWorkAreaHoverPosition();
      return;
    }
    const machine = workAreaToMachinePoint(workAreaLocalToContentPoint(local));
    if (!machine) {
      hideWorkAreaHoverPosition();
      return;
    }
    const origin = visualWorkOrigin();
    const ox = axisValue(origin, "x");
    const oy = axisValue(origin, "y");
    const work = {
      x: ox === null ? NaN : machine.x - ox,
      y: oy === null ? NaN : machine.y - oy,
    };
    el.textContent = `M ${fmtCoord(machine.x)}, ${fmtCoord(machine.y)}  W ${fmtCoord(work.x)}, ${fmtCoord(work.y)}`;
    el.hidden = false;
  }

  function workAreaBounds() {
    const m = normalizeMachineSettings(state.ui.machine);
    return m.work_area;
  }

  function workAreaRect() {
    const b = workAreaBounds();
    const spanX = Math.max(1, b.x_max - b.x_min);
    const spanY = Math.max(1, b.y_max - b.y_min);
    const usable = WORKAREA_VIEW_SIZE - WORKAREA_PAD * 2;
    if (spanX >= spanY) {
      const height = usable * (spanY / spanX);
      return { x: WORKAREA_PAD, y: WORKAREA_PAD + (usable - height) / 2, width: usable, height };
    }
    const width = usable * (spanX / spanY);
    return { x: WORKAREA_PAD + (usable - width) / 2, y: WORKAREA_PAD, width, height: usable };
  }

  function workAreaMMToSVGUnits() {
    const b = workAreaBounds();
    const r = workAreaRect();
    const spanX = Math.max(1, b.x_max - b.x_min);
    const spanY = Math.max(1, b.y_max - b.y_min);
    return Math.min(r.width / spanX, r.height / spanY);
  }

  function workAreaMMRadius(mm) {
    const b = workAreaBounds();
    const r = workAreaRect();
    const sx = r.width / Math.max(1e-9, b.x_max - b.x_min);
    const sy = r.height / Math.max(1e-9, b.y_max - b.y_min);
    return Math.max(0.45, Number(mm) * Math.min(sx, sy));
  }

  function machineToWorkAreaPoint(p) {
    if (!p || !Number.isFinite(Number(p.x)) || !Number.isFinite(Number(p.y))) return null;
    const b = workAreaBounds();
    const r = workAreaRect();
    const x = r.x + ((Number(p.x) - b.x_min) / (b.x_max - b.x_min)) * r.width;
    const y = r.y + ((b.y_max - Number(p.y)) / (b.y_max - b.y_min)) * r.height;
    return { x, y };
  }

  function workAreaToMachinePoint(p) {
    const b = workAreaBounds();
    const r = workAreaRect();
    if (p.x < r.x || p.x > r.x + r.width || p.y < r.y || p.y > r.y + r.height) {
      return null;
    }
    return {
      x: b.x_min + ((p.x - r.x) / r.width) * (b.x_max - b.x_min),
      y: b.y_max - ((p.y - r.y) / r.height) * (b.y_max - b.y_min),
    };
  }

  function renderWorkArea() {
    applyWorkAreaViewport();
    renderWorkAreaBoundary();
    renderWorkAreaGrid();
    renderWorkAreaOrigin();
    renderWorkAreaOutline();
    renderWorkAreaFieldProbePreview();
    setWorkAreaToolRadius();
    // `observed` is deliberately kept as raw reconciliation input. It can lag
    // several status polls behind the planner estimate and must never become the
    // displayed position merely because the estimate's wall-clock timer elapsed.
    const spindle = state.jog.mpos || state.machine.mpos || state.jog.observed;
    const target = state.jog.target;
    setWorkAreaMarker("workarea-spindle", spindle);
    setWorkAreaMarker("workarea-target", target);
    if (hasGcodeRenderer() && syncGcodeContextOverlay() && state.activeTab === "active-job") {
      renderActiveGcode();
    }
  }

  function renderWorkAreaBoundary() {
    const boundary = document.getElementById("workarea-boundary");
    if (!boundary) return;
    const r = workAreaRect();
    boundary.setAttribute("x", r.x.toFixed(2));
    boundary.setAttribute("y", r.y.toFixed(2));
    boundary.setAttribute("width", r.width.toFixed(2));
    boundary.setAttribute("height", r.height.toFixed(2));
  }

  function renderWorkAreaGrid() {
    const grid = document.getElementById("workarea-grid");
    if (!grid) return;
    const r = workAreaRect();
    const lines = [];
    for (let i = 1; i < 4; i++) {
      const x = r.x + (r.width * i) / 4;
      const y = r.y + (r.height * i) / 4;
      lines.push(`<line x1="${x.toFixed(2)}" y1="${r.y.toFixed(2)}" x2="${x.toFixed(2)}" y2="${(r.y + r.height).toFixed(2)}"></line>`);
      lines.push(`<line x1="${r.x.toFixed(2)}" y1="${y.toFixed(2)}" x2="${(r.x + r.width).toFixed(2)}" y2="${y.toFixed(2)}"></line>`);
    }
    grid.innerHTML = lines.join("");
  }

  function renderWorkAreaOrigin() {
    const origin = visualWorkOrigin();
    const ox = axisValue(origin, "x");
    const oy = axisValue(origin, "y");
    document.getElementById("workarea-origin-x")?.setAttribute("display", "none");
    document.getElementById("workarea-origin-y")?.setAttribute("display", "none");
    setWorkAreaMarker("workarea-origin", ox !== null && oy !== null ? { x: ox, y: oy } : null);
  }

  function setWorkAreaMarker(id, machinePoint) {
    const el = document.getElementById(id);
    if (!el) return;
    const p = machineToWorkAreaPoint(machinePoint);
    if (!p) {
      el.setAttribute("display", "none");
      return;
    }
    el.setAttribute("transform", `translate(${p.x.toFixed(2)} ${p.y.toFixed(2)})`);
    el.removeAttribute("display");
  }

  function outlineSnapshot() {
    const o = state.outline;
    return {
      active: o.active,
      points: o.points.map(cloneOutlinePoint),
      closed: !!o.closed,
      origin: cloneOutlineOrigin(o.origin),
    };
  }

  function restoreOutlineSnapshot(snap) {
    const o = state.outline;
    const floorZ = finiteOr(o.floorMachineZ, NaN);
    o.active = !!snap.active;
    o.points = snap.points.map(cloneOutlinePoint);
    o.closed = !!snap.closed;
    o.origin = cloneOutlineOrigin(snap.origin);
    if (Number.isFinite(floorZ)) {
      o.origin = o.origin || {};
      o.origin.z = floorZ;
      for (const point of o.points) {
        const machineZ = Number(point.machine_z);
        if (Number.isFinite(machineZ)) point.z = machineZ - floorZ;
      }
    }
    clearFieldProbeData();
    if (o.closed) updateFieldProbePreview();
  }

  function pushOutlineUndo() {
    const o = state.outline;
    o.undo.push(outlineSnapshot());
    if (o.undo.length > 100) o.undo.shift();
    o.redo = [];
  }

  function currentOutlineCapturePosition() {
    const { mpos, wpos } = currentAxisValues();
    const mx = axisValue(mpos, "x");
    const my = axisValue(mpos, "y");
    const mz = axisValue(mpos, "z");
    const wx = axisValue(wpos, "x");
    const wy = axisValue(wpos, "y");
    const wz = axisValue(wpos, "z");
    if (mx !== null && my !== null && wx !== null && wy !== null && wz !== null) {
      const origin = { x: mx - wx, y: my - wy };
      if (mz !== null) origin.z = mz - wz;
      return {
        machine: { x: mx, y: my, z: mz },
        work: { x: wx, y: wy, z: wz },
        origin,
      };
    }
    const origin = state.outline.origin || currentWorkOrigin();
    const ox = axisValue(origin, "x");
    const oy = axisValue(origin, "y");
    const oz = axisValue(origin, "z");
    if (mx !== null && my !== null && mz !== null && ox !== null && oy !== null && oz !== null) {
      return {
        machine: { x: mx, y: my, z: mz },
        work: { x: mx - ox, y: my - oy, z: mz - oz },
        origin,
      };
    }
    return null;
  }

  function outlineCaptureMotionPending() {
    const j = state.jog;
    const liveInput = jogInputActive(j.lastInput) || (!!j.deadman && ["x", "y", "z"].some((axis) => Math.abs(Number(j.axes?.[axis] || 0)) > JOG_INPUT_DEADZONE));
    return tapMoveTargetBusy() ||
      !!j.fieldProbeMovePending ||
      !!j.zStepPending ||
      !!j.zProbePending ||
      !!j.probe3DPending ||
      hasPendingOriginOperation() ||
      liveInput ||
      !!state.machine.motion_estimated ||
      jogEstimateActive();
  }

  function outlineCapturePositionsClose(a, b, tolerance = OUTLINE_CAPTURE_POSITION_TOLERANCE_MM) {
    if (!a?.machine || !b?.machine) return false;
    return ["x", "y", "z"].every((axis) => {
      const av = axisValue(a.machine, axis);
      const bv = axisValue(b.machine, axis);
      return av !== null && bv !== null && Math.abs(av - bv) <= tolerance;
    });
  }

  function outlineCaptureIntentCount(o = state.outline) {
    return (state.jog?.outlineCaptureIntents || []).filter((intent) => intent.outline === o).length;
  }

  function cancelOutlineCaptureIntents(o = state.outline) {
    if (!state.jog) return;
    state.jog.outlineCaptureIntents = (state.jog.outlineCaptureIntents || []).filter((intent) => intent.outline !== o);
  }

  function capturedOutlinePosition(position) {
    const machine = {};
    const work = {};
    const origin = {};
    for (const axis of ["x", "y", "z"]) {
      const m = Number(position?.mpos?.[axis]);
      const w = Number(position?.wpos?.[axis]);
      if (!Number.isFinite(m) || !Number.isFinite(w)) {
        throw new Error("captured machine and work positions must include X, Y, and Z");
      }
      machine[axis] = m;
      work[axis] = w;
      origin[axis] = m - w;
    }
    return { machine, work, origin };
  }

  function appendOutlineCapturedPosition(o, pos, capturedAt = new Date().toISOString()) {
    if (state.outline !== o || !o.active || o.closed) return false;
    pushOutlineUndo();
    o.active = true;
    if (!o.origin) o.origin = cloneOutlineOrigin(pos.origin);
    o.points.push({
      id: newID("outline-point"),
      x: pos.work.x,
      y: pos.work.y,
      z: pos.work.z,
      machine_x: pos.machine.x,
      machine_y: pos.machine.y,
      machine_z: pos.machine.z,
      captured_at: capturedAt,
    });
    clearFieldProbeData();
    clearNotice("outline-point");
    return true;
  }

  function resolveOutlineCaptureIntent(seq, position = null, error = "") {
    const intents = state.jog.outlineCaptureIntents || [];
    const intent = intents.find((candidate) => candidate.seq === seq);
    if (!intent) return false;
    intent.position = position;
    intent.error = error;
    intent.resolved = true;

    while (intents.length && intents[0].resolved) {
      const next = intents.shift();
      if (state.outline !== next.outline || !next.outline.active || next.outline.closed) continue;
      if (next.error) {
        setStatusMessage("outline-point", "Add point failed: " + next.error, "error", { force: true });
        continue;
      }
      try {
        appendOutlineCapturedPosition(next.outline, capturedOutlinePosition(next.position), next.capturedAt);
      } catch (e) {
        setStatusMessage("outline-point", "Add point failed: " + e.message, "error", { force: true });
      }
    }
    renderOutlineCapture();
    renderWorkArea();
    return true;
  }

  function failOutlineCaptureIntents(message) {
    const pending = [...(state.jog.outlineCaptureIntents || [])];
    for (const intent of pending) resolveOutlineCaptureIntent(intent.seq, null, message);
  }

  function clearFieldProbeData(keepPreview = false) {
    const o = state.outline;
    markGcodeContextOverlayDirty();
    o.fieldProbeResults = [];
    o.fieldProbeComplete = false;
    o.fieldReferenceMachineZ = null;
    o.fieldReferenceKind = "";
    o.fieldProbeIndex = 0;
    o.fieldProbeTooDense = false;
    o.fieldProbeIssue = "";
    if (!keepPreview) {
      o.fieldProbePreview = [];
      o.fieldProbeSelectedID = "";
    }
  }

  function outlineEditingMarkersVisible(outline, probes) {
    return !outline?.closed || !(probes || []).length;
  }
  return { geometry: geometryModule, normalizeWorkAreaView, workAreaViewCenter, applyWorkAreaViewport, resetWorkAreaView, setWorkAreaZoom, zoomWorkArea, panWorkArea, workAreaSVGPointFromClient, workAreaLocalToContentPoint, hideWorkAreaHoverPosition, updateWorkAreaHoverPosition, workAreaBounds, workAreaRect, workAreaMMToSVGUnits, workAreaMMRadius, machineToWorkAreaPoint, workAreaToMachinePoint, renderWorkArea, outlineSnapshot, restoreOutlineSnapshot, outlineCapturePositionsClose, outlineCaptureIntentCount, cancelOutlineCaptureIntents, appendOutlineCapturedPosition, resolveOutlineCaptureIntent, clearFieldProbeData, outlineEditingMarkersVisible, cleanup() { cancelOutlineCaptureIntents(state.outline); } };
}
