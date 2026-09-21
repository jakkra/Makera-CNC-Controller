export function createOutlineView({
  stateFacade,
  documentRef,
  outlineCaptureIntentCount = () => 0,
  isProbeToolActive = () => false,
  machineReadyForOriginSet = () => false,
  tapMoveTargetBusy = () => false,
  controlLocallyOwned = () => false,
  pathNum = (value) => String(value),
  setSoftDisabled = () => {},
  setTextIfChanged = () => {},
  consumeStatusFeedback = () => {},
  fieldProbeSpotGap = () => 0,
  selectedFieldProbePoint = () => null,
  selectedFieldProbeResult = () => null,
  outlineSummaryText = () => "",
} = {}) {
  if (!stateFacade) throw new TypeError("stateFacade is required");
  const state = stateFacade;
  const document = documentRef;

  function renderOutlineCapture() {
    const outline = state.outline;
    const panel = document.getElementById("outline-capture");
    const start = document.getElementById("outline-start");
    const activeControls = document.getElementById("outline-active-controls");
    const end = document.getElementById("outline-end");
    const add = document.getElementById("outline-add-point");
    const undo = document.getElementById("outline-undo");
    const redo = document.getElementById("outline-redo");
    const close = document.getElementById("outline-close");
    const trace = document.getElementById("outline-trace");
    const load = document.getElementById("outline-load");
    const save = document.getElementById("outline-save");
    const curve = document.getElementById("outline-curve-fit");
    const probeFloor = document.getElementById("outline-probe-floor");
    const exp = document.getElementById("outline-export");
    const spacing = document.getElementById("outline-field-spacing");
    const fieldProbe = document.getElementById("outline-field-probe");
    const resetProbe = document.getElementById("outline-field-reset");
    const moveProbe = document.getElementById("outline-field-move");
    const exportControls = document.getElementById("outline-export-controls");
    const exportObj = document.getElementById("outline-export-obj");
    const exportHeight = document.getElementById("outline-export-height");
    const summary = document.getElementById("outline-summary");
    const capturePending = outlineCaptureIntentCount(outline) > 0;
    const actionBusy = !!outline.addPointPending || !!outline.floorProbePending || !!outline.fieldProbePending || !!outline.fieldProbePointMovePending || !!outline.tracePending || !!outline.filePending || !!state.jog.zProbePending;
    const busy = capturePending || actionBusy;
    const probeActive = isProbeToolActive();
    const fieldReady = outline.active && outline.closed && outline.points.length >= 3;
    if (panel) panel.hidden = !outline.active;
    if (start) {
      start.hidden = !!outline.active;
      start.disabled = busy;
      setSoftDisabled(start, false);
    }
    if (activeControls) activeControls.hidden = !outline.active;
    if (load) {
      load.disabled = busy;
      setSoftDisabled(load, false);
      setTextIfChanged(load, outline.filePending ? "Loading..." : "Load outline");
    }
    if (end) {
      end.disabled = busy;
      setSoftDisabled(end, false);
    }
    if (add) {
      // Each press is an independent capture intent. Keep Add point available
      // while earlier intents are in flight so rapid gamepad/button presses are
      // never collapsed into one request.
      add.disabled = actionBusy;
      add.setAttribute("aria-busy", capturePending || outline.addPointPending ? "true" : "false");
      setSoftDisabled(add, !actionBusy && !!outline.closed);
      setTextIfChanged(add, "Add point");
    }
    if (undo) undo.disabled = busy || !outline.undo.length;
    if (redo) redo.disabled = busy || !outline.redo.length;
    if (close) {
      close.disabled = busy;
      setSoftDisabled(close, !busy && (!outline.active || outline.closed || outline.points.length < 2));
    }
    if (trace) {
      trace.hidden = !probeActive;
      trace.disabled = busy;
      setTextIfChanged(trace, outline.tracePending ? "Tracing..." : "Trace outline");
      setSoftDisabled(trace, !busy && (!outline.active || outline.points.length < 2 || state.jog.armed || tapMoveTargetBusy()));
    }
    if (curve) {
      curve.checked = !!outline.curveFit;
      curve.disabled = busy || outline.points.length < 2;
    }
    if (probeFloor) {
      probeFloor.disabled = busy;
      setSoftDisabled(probeFloor, !busy && (!probeActive || state.jog.armed || !machineReadyForOriginSet()));
      setTextIfChanged(probeFloor, outline.floorProbePending ? "Probing Floor..." : "Probe Floor");
    }
    if (exp) {
      exp.disabled = busy;
      setSoftDisabled(exp, !busy && outline.points.length < 2);
    }
    if (save) {
      save.disabled = busy;
      setSoftDisabled(save, !busy && outline.points.length < 2);
    }
    if (spacing) {
      if (!controlLocallyOwned(spacing)) spacing.value = pathNum(fieldProbeSpotGap());
      spacing.disabled = busy;
    }
    if (fieldProbe) {
      setTextIfChanged(fieldProbe, outline.fieldProbePending ? "Probing " + Math.min(outline.fieldProbeIndex + 1, outline.fieldProbePreview.length) + "/" + outline.fieldProbePreview.length : "Probe Field Z");
      fieldProbe.disabled = busy;
      setSoftDisabled(fieldProbe, !busy && (!fieldReady || !probeActive || state.jog.armed || !outline.fieldProbePreview.length || !!outline.fieldProbeTooDense));
    }
    if (resetProbe) {
      const selected = selectedFieldProbePoint(outline);
      const hasResult = !!selectedFieldProbeResult(outline);
      resetProbe.disabled = busy;
      setSoftDisabled(resetProbe, !busy && !hasResult);
      resetProbe.title = selected
        ? (hasResult ? "Reset the selected point's probe value" : "The selected point has no probe value")
        : "Select a field probe point first";
    }
    if (moveProbe) {
      const selected = selectedFieldProbePoint(outline);
      const moving = !!state.jog.fieldProbeMovePending;
      moveProbe.disabled = busy || moving || tapMoveTargetBusy();
      setSoftDisabled(moveProbe, !moveProbe.disabled && (!selected || !state.jog.armed || state.jog.link !== "online"));
      setTextIfChanged(moveProbe, moving ? "Moving..." : "Move to point");
      moveProbe.title = selected ? "Move the spindle to the selected point using the Safe Z setting" : "Select a field probe point first";
    }
    if (exportControls) exportControls.hidden = !outline.fieldProbeResults.length;
    if (exportObj) {
      exportObj.disabled = busy;
      setSoftDisabled(exportObj, !busy && outline.fieldProbeResults.length < 3);
    }
    if (exportHeight) {
      exportHeight.disabled = busy;
      setSoftDisabled(exportHeight, !busy && outline.fieldProbeResults.length < 3);
    }
    if (summary) summary.textContent = outlineSummaryText();
    consumeStatusFeedback("outline", outline, "feedback", "feedbackKind");
  }

  return { renderOutlineCapture };
}
