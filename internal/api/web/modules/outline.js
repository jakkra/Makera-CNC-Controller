// Outline/probe model and editing helpers. DOM and machine actions remain
// late-bound through named callbacks so this slice can be integrated without a
// whole-app context.
export function workPointToMachinePoint(point, origin) {
  const axisValue = (values, axis) => {
    const value = Number(values?.[axis]);
    return Number.isFinite(value) ? value : null;
  };
  const ox = axisValue(origin, "x");
  const oy = axisValue(origin, "y");
  const oz = axisValue(origin, "z");
  if (ox === null || oy === null) return null;
  const out = { x: Number(point.x) + ox, y: Number(point.y) + oy };
  if (axisValue(point, "z") !== null && oz !== null) out.z = Number(point.z) + oz;
  return out;
}

export function createOutlineFeature({
  getOutline,
  getMachine = () => ({}),
  getWorkarea = () => ({}),
  setOutline,
  renderOutlineCapture = () => {},
  renderWorkArea = () => {},
  setStatusMessage = () => {},
  setTapFeedback = () => {},
  pushOutlineUndo = () => {},
  outlineSnapshot = () => null,
  restoreOutlineSnapshot = () => {},
  updateFieldProbePreview = () => {},
  confirmRef = async () => false,
  fmtCoord = (value) => Number.isFinite(Number(value)) ? Number(value).toFixed(3) : "-",
  axisValue = (values, axis) => values?.[axis] ?? null,
  normalizedClosedPolygon = (points) => points,
  pointInPolygonOrBoundary = () => true,
  DEFAULT_FIELD_SPOT_GAP_MM = 8,
  PROBE_SPOT_DIAMETER_MM = 2,
} = {}) {
  const state = {
    get outline() { return getOutline?.() || {}; },
    get machine() { return getMachine?.() || {}; },
    get workarea() { return getWorkarea?.() || {}; },
  };

  function fieldProbeSpotGap(outline = state.outline) {
    const v = Number(outline?.fieldSpotGapMM);
    return Number.isFinite(v) ? Math.max(0, Math.min(250, v)) : DEFAULT_FIELD_SPOT_GAP_MM;
  }

  function fieldProbeCenterSpacing(gap = fieldProbeSpotGap()) {
    return PROBE_SPOT_DIAMETER_MM + Math.max(0, Number(gap) || 0);
  }

  function outlineWorkPoints() {
    return state.outline.points
      .map((p) => ({ x: Number(p.x), y: Number(p.y) }))
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  }

  function fieldProbePlanPointMatchesResult(plan, result) {
    if (!plan || !result || plan.id !== result.id) return false;
    return Math.hypot(Number(plan.x) - Number(result.x), Number(plan.y) - Number(result.y)) <= 0.05;
  }

  function selectedFieldProbePoint(outline = state.outline) {
    const selectedID = String(outline?.fieldProbeSelectedID || "");
    return (outline?.fieldProbePreview || []).find((point) => point.id === selectedID) || null;
  }

  function selectedFieldProbeResult(outline = state.outline) {
    const point = selectedFieldProbePoint(outline);
    return point
      ? (outline?.fieldProbeResults || []).find((result) => fieldProbePlanPointMatchesResult(point, result)) || null
      : null;
  }

  function unprobedFieldProbePoints(plan, results) {
    const samples = Array.isArray(results) ? results : [];
    return (Array.isArray(plan) ? plan : [])
      .map((point, index) => ({ point, index }))
      .filter(({ point }) => !samples.some((sample) => fieldProbePlanPointMatchesResult(point, sample)));
  }

  function selectFieldProbePoint(id) {
    const o = state.outline;
    const point = (o.fieldProbePreview || []).find((candidate) => candidate.id === id);
    if (!point) return false;
    o.fieldProbeSelectedID = point.id;
    renderOutlineCapture();
    renderWorkArea();
    return true;
  }

  function outlinePointLabel(p) {
    return "X " + fmtCoord(p.x) + " Y " + fmtCoord(p.y) + " Z " + fmtCoord(p.z);
  }

  function outlineSummaryText() {
    const o = state.outline;
    if (!o.active) return Number.isFinite(o.floorMachineZ) ? "floor Z0 at M " + fmtCoord(o.floorMachineZ) : "";
    const count = o.points.length;
    const parts = [count + " point" + (count === 1 ? "" : "s")];
    if (o.closed) parts.push("closed");
    if (o.curveFit) parts.push("curve fit");
    if (o.fieldProbePreview.length) parts.push(o.fieldProbePreview.length + " field probes");
    if (o.fieldProbeResults.length) parts.push(o.fieldProbeResults.length + " Z samples");
    if (Number.isFinite(o.floorMachineZ)) parts.push("floor Z0 at M " + fmtCoord(o.floorMachineZ));
    else if (o.fieldProbeResults.length && Number.isFinite(o.fieldReferenceMachineZ)) {
      parts.push("field Z0 at M " + fmtCoord(o.fieldReferenceMachineZ));
    }
    return parts.join(" | ");
  }

  function setOutlineFeedback(text, kind = "") {
    state.outline.feedback = text;
    state.outline.feedbackKind = kind;
    renderOutlineCapture();
  }

  function isProbeToolActive() {
    return Number(state.machine?.tool?.active) === 0;
  }

  function is3DProbeToolActive() {
    return Number(state.machine?.tool?.active) === 9999;
  }

  function fieldProbeMoveCandidate(local, workAreaToMachinePoint, workAreaLocalToContentPoint, cloneOutlineOrigin, currentWorkOrigin) {
    const machinePoint = workAreaToMachinePoint(workAreaLocalToContentPoint(local));
    const origin = cloneOutlineOrigin(state.outline.origin || currentWorkOrigin());
    const ox = axisValue(origin, "x");
    const oy = axisValue(origin, "y");
    if (!machinePoint || ox === null || oy === null) return null;
    const candidate = { x: machinePoint.x - ox, y: machinePoint.y - oy };
    const polygon = normalizedClosedPolygon(outlineWorkPoints());
    return polygon.length >= 3 && pointInPolygonOrBoundary(candidate, polygon) ? candidate : null;
  }

  function closeOutline() {
    const o = state.outline;
    if (o.points.length < 2) {
      setOutlineFeedback("Close outline needs at least two points.", "error");
      return;
    }
    if (o.closed) {
      setOutlineFeedback("Outline is already closed.", "error");
      return;
    }
    pushOutlineUndo();
    o.active = true;
    o.closed = true;
    updateFieldProbePreview();
    o.feedback = "Outline closed.";
    o.feedbackKind = "ok";
    renderOutlineCapture();
    renderWorkArea();
  }

  function undoOutline() {
    const o = state.outline;
    if (!o.undo.length) return;
    const current = outlineSnapshot();
    const prev = o.undo.pop();
    o.redo.push(current);
    restoreOutlineSnapshot(prev);
    o.feedback = "Undo.";
    o.feedbackKind = "ok";
    renderOutlineCapture();
    renderWorkArea();
  }

  function redoOutline() {
    const o = state.outline;
    if (!o.redo.length) return;
    const current = outlineSnapshot();
    const next = o.redo.pop();
    o.undo.push(current);
    restoreOutlineSnapshot(next);
    o.feedback = "Redo.";
    o.feedbackKind = "ok";
    renderOutlineCapture();
    renderWorkArea();
  }

  return {
    closeOutline, undoOutline, redoOutline,
    fieldProbeSpotGap, fieldProbeCenterSpacing, outlineWorkPoints,
    fieldProbePlanPointMatchesResult, selectedFieldProbePoint,
    selectedFieldProbeResult, unprobedFieldProbePoints, selectFieldProbePoint, outlinePointLabel,
    outlineSummaryText, setOutlineFeedback, isProbeToolActive,
    is3DProbeToolActive, fieldProbeMoveCandidate,
  };
}
