import { setElementBusy, setSoftDisabled, setTextIfChanged } from "./dom.js";
import { isWiredProbeTool } from "./tooling.js";

const MIN_BASELINE_MM = 0.05; // Match the firmware position verification tolerance.

function alongEdge(axis) {
  return axis === "x" ? "y" : "x";
}

function isXY(point) {
  return Number.isFinite(point?.x) && Number.isFinite(point?.y);
}

export function measuredEdgeAngle(first, second, probeAxis) {
  if (!isXY(first) || !isXY(second) || !["x", "y"].includes(probeAxis)) return null;
  const along = alongEdge(probeAxis);
  const span = second[along] - first[along];
  if (Math.abs(span) < MIN_BASELINE_MM) return null;
  const drift = (second[probeAxis] - first[probeAxis]) * Math.sign(span);
  const baseline = Math.abs(span);
  // Signed counterclockwise angle from the positive machine axis along the edge.
  const angle = Math.atan2(probeAxis === "y" ? drift : -drift, baseline);
  return { angleDegrees: angle * 180 / Math.PI, driftMM: drift, baselineMM: baseline };
}

export function createEdgeProbing({
  document, getMachine, getJog, machineReady, hasOtherMotion,
  request, pollMachine, renderJog, renderWorkArea, setStatusMessage,
}) {
  const node = (id) => document.getElementById(id);
  const controls = () => ["direction", "travel", "tip"].map((name) => node("probe-edge-" + name));
  let angleMode = false;
  let pending = false;
  let first = null;
  let second = null;
  let angleLabel = "";
  const drafts = {};

  function feedback(message, kind = "", timeoutMs) {
    setStatusMessage("origin-action", message, kind, { force: true, ...(timeoutMs == null ? {} : { timeoutMs }) });
  }

  function ready() {
    const jog = getJog();
    if (jog.armed || jog.armPending || jog.availability?.reason === "busy") {
      feedback("Disarm Movement before probing an edge.", "error");
      return false;
    }
    if (!machineReady() || !isWiredProbeTool(getMachine()?.tool?.active)) {
      feedback("Edge probing requires a connected, Idle machine with the wired 3D Probe active.", "error");
      return false;
    }
    return !jog.zProbePending && !jog.zStepPending && !hasOtherMotion();
  }

  function readDraft() {
    return controls().map((control) => control.value);
  }

  function writeDraft(values) {
    controls().forEach((control, i) => { control.value = values[i]; });
  }

  function renderDialog() {
    const run = node("probe-edge-run");
    const result = node("probe-edge-result");
    const reset = node("probe-edge-reset");
    setTextIfChanged(node("probe-edge-title"), angleMode ? "Measure edge angle" : "Measure edge");
    setTextIfChanged(node("probe-edge-placement"), angleMode
      ? "Probe two points on the same edge at the same height. Reposition with Jog between points, then disarm Movement."
      : "Place the wired probe at contact height with a clear approach along the selected axis.");
    result.hidden = !angleMode || !first;
    setTextIfChanged(result, angleLabel || (first ? `Point 1 · X ${first.x.toFixed(3)} · Y ${first.y.toFixed(3)} mm` : ""));
    reset.hidden = !angleMode;
    reset.disabled = pending || !first;
    node("probe-edge-close").disabled = pending;
    for (const control of controls()) control.disabled = pending || (angleMode && !!first);
    run.disabled = pending || (angleMode && !!second);
    setTextIfChanged(run, pending ? "Probing…" : angleMode ? (first ? "Probe point 2" : "Probe point 1") : "Probe edge");
    setElementBusy(run, pending);
  }

  function open(angle) {
    const dialog = node("probe-edge-modal");
    if (!ready() || dialog.open) return;
    if (angle !== angleMode) {
      drafts[angleMode] = readDraft();
      if (drafts[angle]) writeDraft(drafts[angle]);
    }
    angleMode = angle;
    renderDialog();
    dialog.showModal();
  }

  async function probe() {
    const [direction, travel, tip] = controls();
    if (pending || (angleMode && second) || !ready() || !travel.reportValidity() || !tip.reportValidity()) return;
    const axis = direction.value[0];
    const sign = direction.value[1] === "+" ? 1 : -1;
    const along = alongEdge(axis);
    pending = getJog().zProbePending = true;
    renderDialog();
    feedback(angleMode ? `Probing point ${first ? 2 : 1}…` : `Measuring ${axis.toUpperCase()} edge…`, "", 0);
    renderJog();
    try {
      const response = await request("/api/probe/edge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ axis, direction: sign, travel_mm: travel.valueAsNumber, tip_diameter_mm: tip.valueAsNumber }),
      });
      const result = await response.json();
      if (result.axis !== axis || !Number.isFinite(result.machine_edge_mm)) throw new Error("No measured edge was reported.");
      if (!angleMode) {
        feedback(`Edge at machine ${axis.toUpperCase()} ${result.machine_edge_mm.toFixed(3)} mm`, "ok");
      } else {
        const point = result.machine_point;
        if (!isXY(point)) throw new Error("No measured XY point was reported.");
        if (!first) {
          first = point;
          feedback(`Point 1 measured. Jog along ${along.toUpperCase()} to point 2, then reopen Measure angle.`);
        } else {
          const result = measuredEdgeAngle(first, point, axis);
          if (!result) throw new Error(`Jog along ${along.toUpperCase()} to a different point on the edge, then try point 2 again.`);
          second = point;
          angleLabel = `${result.angleDegrees.toFixed(3)}° from ${along.toUpperCase()} · ${result.driftMM.toFixed(3)} mm drift over ${result.baselineMM.toFixed(3)} mm`;
          feedback(angleLabel, "ok");
        }
        renderWorkArea();
      }
      node("probe-edge-modal").close();
      pollMachine();
    } catch (error) {
      feedback(`Edge probe failed. ${error.message}`, "error");
    } finally {
      pending = getJog().zProbePending = false;
      renderDialog();
      renderJog();
    }
  }

  // Points measured before a disconnect or a tool change may not share a
  // machine frame with the next touch. Forget them rather than mix them.
  let session;
  function invalidateOnSessionChange() {
    const machine = getMachine() || {};
    const tool = machine.tool?.active;
    if (machine.connected && tool == null) return; // tool not reported yet
    const key = machine.connected ? String(tool) : "disconnected";
    if (session !== undefined && key !== session && !pending && (first || second)) {
      first = second = null;
      angleLabel = "";
      renderDialog();
      renderWorkArea();
    }
    session = key;
  }

  function renderButtons(busy, apiReady) {
    invalidateOnSessionChange();
    const wiredProbe = isWiredProbeTool(getMachine()?.tool?.active);
    for (const id of ["origin-probe-edge", "origin-probe-angle"]) {
      const button = node(id);
      if (!button) continue;
      button.disabled = busy;
      setSoftDisabled(button, !busy && (!apiReady || !wiredProbe));
    }
  }

  function bind(bindButtonAction) {
    const dialog = node("probe-edge-modal");
    if (!dialog) return;
    bindButtonAction(node("origin-probe-edge"), () => open(false));
    bindButtonAction(node("origin-probe-angle"), () => open(true));
    bindButtonAction(node("probe-edge-close"), () => { if (!pending) dialog.close(); });
    dialog.addEventListener("cancel", (event) => { if (pending) event.preventDefault(); });
    bindButtonAction(node("probe-edge-run"), probe);
    bindButtonAction(node("probe-edge-reset"), () => {
      if (pending) return;
      first = second = null;
      angleLabel = "";
      renderDialog();
      renderWorkArea();
    });
  }

  function renderMap(toPlot) {
    const group = node("workarea-probed-edge");
    if (!group) return;
    const a = first && toPlot(first);
    const b = second && toPlot(second);
    group.setAttribute("display", a ? "inline" : "none");
    if (!a) return;
    const line = group.querySelector("line");
    const [start, end] = group.querySelectorAll("circle");
    start.setAttribute("cx", a.x);
    start.setAttribute("cy", a.y);
    line.setAttribute("display", b ? "inline" : "none");
    end.setAttribute("display", b ? "inline" : "none");
    if (!b) return;
    line.setAttribute("x1", a.x);
    line.setAttribute("y1", a.y);
    line.setAttribute("x2", b.x);
    line.setAttribute("y2", b.y);
    end.setAttribute("cx", b.x);
    end.setAttribute("cy", b.y);
  }

  return { bind, renderButtons, renderMap };
}
