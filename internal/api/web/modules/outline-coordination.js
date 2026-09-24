// Small coordination helpers for the outline/work-area UI. The composition
// root supplies state accessors and feature callbacks; this module owns no
// application-wide state other than the field-spacing debounce timer.

export const OUTLINE_FIELD_SPACING_DEBOUNCE_MS = 450;

export function createOutlineCoordination({
  documentRef = globalThis.document,
  getOutline = () => ({}),
  getGcodeContextRevision = () => 0,
  setGcodeContextRevision = () => {},
  workAreaMMToSVGUnits = () => 1,
  spindleDiameterMM = 3.175,
  outlineSnapshot = () => null,
  getCurrentAxisValues = () => ({ mpos: null, wpos: null }),
  currentWorkOrigin = () => null,
  axisValue = (values, axis) => {
    const value = Number(values?.[axis]);
    return Number.isFinite(value) ? value : null;
  },
  renderOutlineCaptureView = () => {},
  clearFieldProbeData = () => {},
  updateFieldProbePreview = () => {},
  renderWorkArea = () => {},
  clearControlDrafts = () => {},
  setStatusMessage = () => {},
  setTimeoutRef = globalThis.setTimeout,
  clearTimeoutRef = globalThis.clearTimeout,
} = {}) {
  let outlineFieldSpacingTimer = null;

  function setWorkAreaToolRadius() {
    const radius = (spindleDiameterMM / 2) * workAreaMMToSVGUnits();
    for (const id of ["workarea-spindle-marker", "workarea-target-marker"]) {
      const el = documentRef?.getElementById?.(id);
      if (el) el.setAttribute("r", radius.toFixed(3));
    }
  }

  function markGcodeContextOverlayDirty() {
    setGcodeContextRevision(getGcodeContextRevision() + 1);
  }

  function pushOutlineUndo() {
    const outline = getOutline();
    outline.undo.push(outlineSnapshot());
    if (outline.undo.length > 100) outline.undo.shift();
    outline.redo = [];
  }

  function currentOutlineCapturePosition() {
    const { mpos, wpos } = getCurrentAxisValues();
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
    const origin = getOutline().origin || currentWorkOrigin();
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

  function renderOutlineCapture() {
    return renderOutlineCaptureView();
  }

  function toggleOutlineCurveFit() {
    getOutline().curveFit = !!documentRef?.getElementById?.("outline-curve-fit")?.checked;
    clearFieldProbeData();
    updateFieldProbePreview();
    renderOutlineCapture();
    renderWorkArea();
  }

  function commitOutlineFieldSpacingDraft() {
    const input = documentRef?.getElementById?.("outline-field-spacing");
    const raw = String(input?.value ?? "").trim();
    const value = Number(raw);
    if (!input || raw === "" || !Number.isFinite(value)) {
      if (input) {
        input.setCustomValidity("Enter a number.");
        input.reportValidity?.();
      }
      return false;
    }
    input.setCustomValidity("");
    getOutline().fieldSpotGapMM = Math.max(0, Math.min(250, value));
    return true;
  }

  function cancelOutlineFieldSpacingUpdate() {
    if (outlineFieldSpacingTimer === null) return;
    clearTimeoutRef(outlineFieldSpacingTimer);
    outlineFieldSpacingTimer = null;
  }

  function flushOutlineFieldSpacingUpdate(render = true) {
    cancelOutlineFieldSpacingUpdate();
    if (!commitOutlineFieldSpacingDraft()) return false;
    const input = documentRef?.getElementById?.("outline-field-spacing");
    clearControlDrafts(input);
    clearFieldProbeData(true);
    updateFieldProbePreview();
    if (getOutline().fieldProbeIssue) {
      setStatusMessage("outline-plan", getOutline().fieldProbeIssue + ".", "error", { force: true });
    }
    if (render) {
      renderOutlineCapture();
      renderWorkArea();
    }
    return true;
  }

  function scheduleOutlineFieldSpacingUpdate() {
    if (!commitOutlineFieldSpacingDraft()) {
      cancelOutlineFieldSpacingUpdate();
      return false;
    }
    cancelOutlineFieldSpacingUpdate();
    outlineFieldSpacingTimer = setTimeoutRef(() => {
      outlineFieldSpacingTimer = null;
      flushOutlineFieldSpacingUpdate();
    }, OUTLINE_FIELD_SPACING_DEBOUNCE_MS);
    return true;
  }

  return {
    setWorkAreaToolRadius,
    markGcodeContextOverlayDirty,
    pushOutlineUndo,
    currentOutlineCapturePosition,
    renderOutlineCapture,
    toggleOutlineCurveFit,
    commitOutlineFieldSpacingDraft,
    cancelOutlineFieldSpacingUpdate,
    flushOutlineFieldSpacingUpdate,
    scheduleOutlineFieldSpacingUpdate,
  };
}
