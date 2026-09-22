export function createFieldProbing({ state, constants = {}, callbacks = {} }) {
  const { DEFAULT_PROBE_DEPTH_MM, DEFAULT_PROBE_FEED_MM } = constants;
  const {
    cloneOutlineOrigin, axisValue, currentWorkOrigin, normalizeMachineSettings, finiteOr,
    safeZForTapMove, request, markGcodeContextOverlayDirty, machineReadyForOriginSet,
    isProbeToolActive, setOutlineFeedback, confirmProbeAction, renderOutlineCapture,
    renderJog, pollMachine, fmtCoord, cancelOutlineFieldSpacingUpdate,
    commitOutlineFieldSpacingDraft, clearControlDrafts, updateFieldProbePreview,
    unprobedFieldProbePoints, currentOutlineCapturePosition, renderWorkArea,
    effectiveOutlineGeometry, outlineWorkPoints, workPointToMachinePoint,
    tapMoveTargetBusy, currentTapFeed,
  } = callbacks;

  async function probeZAtWorkPoint(workPoint, opts = {}) {
    const origin = cloneOutlineOrigin(opts.origin || state.outline.origin || currentWorkOrigin());
    const ox = axisValue(origin, "x");
    const oy = axisValue(origin, "y");
    const oz = axisValue(origin, "z");
    if (ox === null || oy === null || oz === null) {
      throw new Error("current work zero is unavailable");
    }
    const machine = normalizeMachineSettings(state.ui.machine);
    const mx = Number(workPoint.x) + ox;
    const my = Number(workPoint.y) + oy;
    const depth = Math.max(0.1, Math.min(200, finiteOr(opts.depthMM, DEFAULT_PROBE_DEPTH_MM)));
    const feed = Math.max(1, Math.min(1000, finiteOr(opts.feedMMMin, DEFAULT_PROBE_FEED_MM)));
    const body = {
      machine_x: mx,
      machine_y: my,
      move_xy: opts.moveXY !== false,
      safe_z_mm: finiteOr(opts.safeZMM, safeZForTapMove(machine)),
      probe_depth_mm: depth,
      probe_feed_mm_min: feed,
    };
    if (Number.isFinite(opts.retractZMM)) body.retract_z_mm = opts.retractZMM;
    if (Number.isFinite(opts.retractAboveMM)) body.retract_above_mm = opts.retractAboveMM;
    const resp = await request("/api/probe/z", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await resp.json();
    const m = result.machine || {};
    const px = axisValue(m, "x");
    const py = axisValue(m, "y");
    const pz = axisValue(m, "z");
    if (px === null || py === null || pz === null) throw new Error("probe response did not include XYZ");
    return {
      x: px - ox,
      y: py - oy,
      z: pz - oz,
      machine_x: px,
      machine_y: py,
      machine_z: pz,
      retract_z_mm: finiteOr(result.retract_z_mm, NaN),
      output: result.output || "",
    };
  }

  function rebaseOutlineToFloor(machineZ) {
    const floorZ = Number(machineZ);
    if (!Number.isFinite(floorZ)) throw new Error("floor probe did not report a machine Z coordinate");
    const o = state.outline;
    o.floorMachineZ = floorZ;
    o.fieldReferenceMachineZ = floorZ;
    o.fieldReferenceKind = "floor";
    const origin = cloneOutlineOrigin(o.origin || currentWorkOrigin()) || {};
    origin.z = floorZ;
    o.origin = origin;
    for (const point of [...o.points, ...o.fieldProbeResults]) {
      const z = Number(point.machine_z);
      if (Number.isFinite(z)) point.z = z - floorZ;
    }
    markGcodeContextOverlayDirty();
  }

  async function probeFloor() {
    const o = state.outline;
    if (state.jog.zProbePending || o.floorProbePending || o.fieldProbePending || o.tracePending) return;
    if (state.jog.armed) {
      setOutlineFeedback("Disarm Movement before probing the floor.", "error");
      return;
    }
    if (!machineReadyForOriginSet()) {
      setOutlineFeedback("Machine must be connected and Idle to probe the floor.", "error");
      return;
    }
    if (!isProbeToolActive()) {
      setOutlineFeedback("Floor probe requires the probe tool to be active.", "error");
      return;
    }
    if (!await confirmProbeAction({
      title: "Probe Floor",
      message: "Probe the floor at the current XY position?",
      warning: "The detected contact will update the current Z origin to floor Z0. After verification, the spindle will move to Safe Z.",
      confirmLabel: "Probe Floor",
    })) return;
    o.floorProbePending = true;
    state.jog.zProbePending = true;
    o.feedback = "Probing floor and updating work Z zero...";
    o.feedbackKind = "";
    renderOutlineCapture();
    renderJog();
    try {
      const resp = await request("/api/probe/floor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const result = await resp.json();
      const floorZ = axisValue(result.machine, "z");
      if (!result.verified || floorZ === null) {
        throw new Error(result.message || "work Z zero could not be verified");
      }
      rebaseOutlineToFloor(floorZ);
      o.floorProbe = {
        machine_x: axisValue(result.machine, "x"),
        machine_y: axisValue(result.machine, "y"),
        machine_z: floorZ,
        captured_at: new Date().toISOString(),
        probe_output: result.output || "",
        verified: true,
      };
      o.feedback = (result.message || "Floor zero verified and spindle retracted to safe Z.") +
        " Work Z zero is M Z " + fmtCoord(floorZ) + " mm.";
      o.feedbackKind = "ok";
    } catch (e) {
      o.feedback = "Floor probe failed: " + e.message;
      o.feedbackKind = "error";
    } finally {
      o.floorProbePending = false;
      state.jog.zProbePending = false;
      await pollMachine();
      renderOutlineCapture();
      renderJog();
    }
  }

  async function runFieldProbe() {
    const o = state.outline;
    if (!o.active) return;
    if (!o.closed || o.points.length < 3) {
      setOutlineFeedback("Close an outline with at least three points before probing the field.", "error");
      return;
    }
    if (!isProbeToolActive()) {
      setOutlineFeedback("Field Z probe requires the probe tool to be active.", "error");
      return;
    }
    if (state.jog.armed) {
      setOutlineFeedback("Disarm Movement before running field Z probe.", "error");
      return;
    }
    cancelOutlineFieldSpacingUpdate();
    if (!commitOutlineFieldSpacingDraft()) {
      setOutlineFeedback("Enter a valid spot gap before probing the field.", "error");
      return;
    }
    clearControlDrafts("outline-field-spacing");
    updateFieldProbePreview();
    if (o.fieldProbeIssue) {
      setOutlineFeedback(o.fieldProbeIssue + ".", "error");
      renderOutlineCapture();
      return;
    }
    if (o.fieldProbeTooDense) {
      setOutlineFeedback(o.fieldProbeIssue || "Spot gap creates too many probe points.", "error");
      renderOutlineCapture();
      return;
    }
    if (!o.fieldProbePreview.length) {
      setOutlineFeedback("Field Z probe needs at least one preview point inside the outline.", "error");
      return;
    }
    const remaining = unprobedFieldProbePoints(o.fieldProbePreview, o.fieldProbeResults);
    if (!remaining.length) {
      setOutlineFeedback("All field Z probe points already have samples.", "ok");
      return;
    }
    const origin = cloneOutlineOrigin(o.origin || currentWorkOrigin()) || {};
    const floorZ = finiteOr(o.floorMachineZ, NaN);
    const liveOrigin = currentOutlineCapturePosition()?.origin;
    const liveOriginZ = axisValue(liveOrigin, "z");
    const referenceZ = Number.isFinite(floorZ) ? floorZ : (liveOriginZ === null ? axisValue(origin, "z") : liveOriginZ);
    if (referenceZ === null || !Number.isFinite(referenceZ)) {
      setOutlineFeedback("Field Z probe needs the current Z origin.", "error");
      return;
    }
    origin.z = referenceZ;
    const hasFloor = Number.isFinite(floorZ);
    const referenceText = "machine Z " + fmtCoord(referenceZ) + " mm";
    if (!await confirmProbeAction({
      title: "Probe Field Z",
      message: "Run " + remaining.length + " remaining field Z probe" + (remaining.length === 1 ? "" : "s") + " inside the captured outline?",
      warning: hasFloor
        ? "Z coordinates and exports will be relative to the current Z origin at " + referenceText + ", established by the recorded floor probe."
        : "No floor probe is recorded. Z coordinates and exports will be relative to the current Z origin at " + referenceText + ". Consider probing the floor first.",
      confirmLabel: "Probe Field Z",
    })) return;
    const startPosition = currentOutlineCapturePosition();
    const startZMM = axisValue(startPosition?.machine, "z");
    if (startZMM === null) {
      setOutlineFeedback("Field Z probe needs the current machine Z position.", "error");
      return;
    }
    o.fieldProbePending = true;
    o.fieldProbeComplete = false;
    markGcodeContextOverlayDirty();
    o.fieldReferenceMachineZ = referenceZ;
    o.fieldReferenceKind = hasFloor ? "floor" : "work_origin";
    o.fieldProbeIndex = 0;
    o.feedback = "Starting field Z probe...";
    o.feedbackKind = "";
    renderOutlineCapture();
    renderWorkArea();
    try {
      for (let i = 0; i < remaining.length; i++) {
        const pending = remaining[i];
        o.fieldProbeIndex = pending.index;
        o.feedback = "Probing remaining field point " + (i + 1) + " of " + remaining.length + "...";
        renderOutlineCapture();
        renderWorkArea();
        const p = pending.point;
        const probed = await probeZAtWorkPoint(p, {
          moveXY: true,
          origin,
          safeZMM: startZMM,
          retractZMM: startZMM,
        });
        o.fieldProbeResults.push({
          id: p.id,
          x: probed.x,
          y: probed.y,
          z: probed.z,
          machine_x: probed.machine_x,
          machine_y: probed.machine_y,
          machine_z: probed.machine_z,
          probe_kind: p.probe_kind,
          captured_at: new Date().toISOString(),
          probe_output: probed.output,
        });
        renderWorkArea();
      }
      o.fieldProbeComplete = unprobedFieldProbePoints(o.fieldProbePreview, o.fieldProbeResults).length === 0;
      o.feedback = "Field Z probe completed; " + o.fieldProbePreview.length + " of " + o.fieldProbePreview.length + " points have samples.";
      o.feedbackKind = "ok";
    } catch (e) {
      o.feedback = "Field Z probe failed: " + e.message;
      o.feedbackKind = "error";
    } finally {
      o.fieldProbePending = false;
      o.fieldProbeIndex = 0;
      markGcodeContextOverlayDirty();
      renderOutlineCapture();
      renderWorkArea();
      pollMachine();
    }
  }

  function traceOutlineMachinePoints(origin) {
    const geometry = effectiveOutlineGeometry(outlineWorkPoints(), state.outline.closed, state.outline.curveFit);
    if (geometry.limited) throw new Error("curve fit generated too many trace points");
    const points = geometry.points.map((p) => workPointToMachinePoint(p, origin));
    if (points.some((p) => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) {
      throw new Error("outline trace coordinates are unavailable");
    }
    return points.map((p) => ({ x: p.x, y: p.y }));
  }

  async function traceOutline() {
    const o = state.outline;
    if (!o.active || o.points.length < 2) return;
    if (!isProbeToolActive()) {
      setOutlineFeedback("Trace outline requires the probe tool to be active.", "error");
      return;
    }
    if (state.jog.armed) {
      setOutlineFeedback("Disarm Movement before tracing an outline.", "error");
      return;
    }
    if (tapMoveTargetBusy()) {
      setOutlineFeedback("Wait for Movement to finish before tracing an outline.", "error");
      return;
    }
    if (o.fieldProbePending || o.tracePending) return;
    const origin = cloneOutlineOrigin(o.origin || currentWorkOrigin());
    const ox = axisValue(origin, "x");
    const oy = axisValue(origin, "y");
    if (ox === null || oy === null) {
      setOutlineFeedback("Trace outline failed: current outline origin is unavailable.", "error");
      return;
    }
    let machinePoints;
    try {
      machinePoints = traceOutlineMachinePoints(origin);
    } catch (e) {
      setOutlineFeedback("Trace outline failed: " + e.message, "error");
      return;
    }
    if (machinePoints.length < 2) {
      setOutlineFeedback("Trace outline needs at least two trace points.", "error");
      return;
    }
    const machine = normalizeMachineSettings(state.ui.machine);
    o.tracePending = true;
    o.feedback = "Tracing outline...";
    o.feedbackKind = "";
    renderOutlineCapture();
    try {
      const resp = await request("/api/outline/trace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          machine_points: machinePoints,
          safe_z_mm: safeZForTapMove(machine),
          feed_mm_min: currentTapFeed(),
          closed: !!o.closed,
        }),
      });
      const result = await resp.json();
      o.feedback = result.message || ("Trace outline completed with " + machinePoints.length + " points.");
      o.feedbackKind = result.verified ? "ok" : "";
    } catch (e) {
      o.feedback = "Trace outline failed: " + e.message;
      o.feedbackKind = "error";
    } finally {
      o.tracePending = false;
      renderOutlineCapture();
      pollMachine();
    }
  }

  return {
    probeZAtWorkPoint,
    rebaseOutlineToFloor,
    probeFloor,
    runFieldProbe,
    traceOutlineMachinePoints,
    traceOutline,
  };
}
