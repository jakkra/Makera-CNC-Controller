export function displayedFieldProbePoints(outline) {
  return outline?.fieldProbePreview?.length ? outline.fieldProbePreview : (outline?.fieldProbeResults || []);
}

export function createWorkareaRenderers({
  stateFacade,
  documentRef,
  constants = {},
  machineToWorkAreaPoint = () => null,
  workAreaMMToSVGUnits = () => 1,
  workAreaMMRadius = () => 1,
  outlinePathD = () => "",
  outlineEditingMarkersVisible = () => true,
  cloneOutlineOrigin = (origin) => origin ? ({ ...origin }) : null,
  currentWorkOrigin = () => null,
  visualWorkOrigin = () => null,
  workPointToMachinePoint = () => null,
  fieldProbePlanPointMatchesResult = () => false,
  fmtCoord = (value) => String(value),
  escapeHtml = (value) => String(value),
} = {}) {
  if (!stateFacade) throw new TypeError("stateFacade is required");
  const state = stateFacade;
  const document = documentRef;
  const {
    OUTLINE_POINT_DIAMETER_MM = 3.675,
    PROBE_SPOT_RADIUS_MM = 1,
  } = constants;

  function renderWorkAreaOutline() {
    const group = document.getElementById("workarea-outline");
    const path = document.getElementById("workarea-outline-path");
    const pointsGroup = document.getElementById("workarea-outline-points");
    if (!group || !path || !pointsGroup) return;
    const probeDisplay = state.outline.active && state.outline.closed
      ? displayedFieldProbePoints(state.outline)
      : [];
    const points = state.outline.points
      .map((point) => machineToWorkAreaPoint({ x: point.machine_x, y: point.machine_y }))
      .filter(Boolean);
    if (!points.length) {
      group.setAttribute("display", "none");
      path.removeAttribute("d");
      pointsGroup.innerHTML = "";
      return;
    }
    path.setAttribute("d", outlinePathD(points, state.outline.closed, state.outline.curveFit));
    group.classList.toggle("closed", !!state.outline.closed);
    group.removeAttribute("display");
    const pointRadius = (OUTLINE_POINT_DIAMETER_MM / 2) * workAreaMMToSVGUnits();
    const showEditingMarkers = outlineEditingMarkersVisible(state.outline, probeDisplay);
    pointsGroup.innerHTML = points.filter(() => showEditingMarkers).map((point) =>
      `<circle cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="${pointRadius.toFixed(3)}"></circle>`
    ).join("");
  }

  function renderWorkAreaFieldProbePreview() {
    const group = document.getElementById("workarea-field-probe-preview");
    if (!group) return;
    const outline = state.outline;
    const origin = cloneOutlineOrigin(outline.origin || currentWorkOrigin() || visualWorkOrigin());
    const display = displayedFieldProbePoints(outline);
    const radius = workAreaMMRadius(PROBE_SPOT_RADIUS_MM);
    const points = display.map((point) => ({
      src: point,
      plot: machineToWorkAreaPoint(workPointToMachinePoint(point, origin)),
    })).filter((point) => point.plot);
    if (!points.length || !outline.active || !outline.closed) {
      group.setAttribute("display", "none");
      group.innerHTML = "";
      return;
    }
    group.innerHTML = points.map((point, index) => {
      const done = outline.fieldProbeResults.some((result) => fieldProbePlanPointMatchesResult(point.src, result));
      const selected = point.src.id === outline.fieldProbeSelectedID;
      const label = "Field probe point " + (index + 1) + ", X " + fmtCoord(point.src.x) + ", Y " + fmtCoord(point.src.y) + ", " + (done ? "probed" : "not probed") + (selected ? "; use arrow keys to move" : "");
      const classes = [
        point.src.probe_kind === "outline" || point.src.probe_kind === "border" ? "boundary" : "",
        point.src.probe_kind === "outline" ? "outline" : "",
        done ? "done" : "",
        selected ? "selected" : "",
        outline.fieldProbePending && index === outline.fieldProbeIndex ? "current" : "",
      ].filter(Boolean).join(" ");
      return `<circle class="${classes}" data-field-probe-id="${escapeHtml(point.src.id)}" role="button" tabindex="0" aria-label="${escapeHtml(label)}" aria-pressed="${selected ? "true" : "false"}" cx="${point.plot.x.toFixed(2)}" cy="${point.plot.y.toFixed(2)}" r="${radius.toFixed(2)}"></circle>`;
    }).join("");
    group.removeAttribute("display");
  }

  return { displayedFieldProbePoints, renderWorkAreaOutline, renderWorkAreaFieldProbePreview };
}
