import { setElementBusy, setTextIfChanged } from "./dom.js";

const POSITION_TOLERANCE = 0.05;

export function surfaceMeasurements(outline) {
  const reference = outline.fieldReferenceMachineZ;
  const points = (outline.fieldProbeResults || [])
    .filter((p) => [p.machine_x, p.machine_y, p.machine_z].every(Number.isFinite))
    .map((p) => ({ x: p.machine_x, y: p.machine_y, z: p.machine_z - (Number.isFinite(reference) ? reference : 0) }));
  if (!points.length) return null;
  const low = Math.min(...points.map((point) => point.z));
  const high = Math.max(...points.map((point) => point.z));
  const center = ["x", "y", "z"].map((axis) => points.reduce((sum, p) => sum + p[axis], 0) / points.length);
  let xx = 0, xy = 0, yy = 0, xz = 0, yz = 0;
  const centered = points.map((p) => [p.x - center[0], p.y - center[1], p.z - center[2]]);
  for (const [x, y, z] of centered) {
    xx += x * x;
    xy += x * y;
    yy += y * y;
    xz += x * z;
    yz += y * z;
  }
  const det = xx * yy - xy * xy;
  let planeDeviation = null;
  if (points.length >= 4 && det > 1e-8) {
    const slopeX = (xz * yy - xy * yz) / det;
    const slopeY = (xx * yz - xy * xz) / det;
    const residuals = centered.map(([x, y, z]) => z - slopeX * x - slopeY * y);
    planeDeviation = Math.max(...residuals) - Math.min(...residuals);
  }
  return { points, low, high, range: high - low, planeDeviation, reference };
}

// Hand-captured corners are rarely within a few hundredths of each other.
// Accept a near-rectangle and face its bounding box, which covers every corner.
export const RECTANGLE_TOLERANCE_MM = 1;
// The cutter descends this far outside the stock edge (plus its radius) and
// then feeds in from the side. It never plunges into material.
export const ENTRY_CLEARANCE_MM = 3;
export const ENTRY_CORNERS = ["front-left", "front-right", "back-left", "back-right"];

export function rectangle(points) {
  if (points.length !== 4 || points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;
  const x = points.map((p) => p.x);
  const y = points.map((p) => p.y);
  const result = { left: Math.min(...x), right: Math.max(...x), front: Math.min(...y), back: Math.max(...y) };
  const tolerance = RECTANGLE_TOLERANCE_MM;
  if (result.right - result.left <= 2 * tolerance || result.back - result.front <= 2 * tolerance) return null;
  const corners = points.map((p) => {
    const side = Math.abs(p.x - result.left) <= tolerance ? "l" : Math.abs(p.x - result.right) <= tolerance ? "r" : "";
    const end = Math.abs(p.y - result.front) <= tolerance ? "f" : Math.abs(p.y - result.back) <= tolerance ? "b" : "";
    return side && end ? side + end : "";
  });
  const adjacent = corners.every((c, i) => c && [...c].filter((letter) => corners[(i + 1) % 4].includes(letter)).length === 1);
  return adjacent && new Set(corners).size === 4 ? result : null;
}

export function facingPlan({ outline, surface, origin, machine, limits, safeZ, parameters }) {
  if (!surface || surface.points.length < 4 || !outline.closed || !outline.fieldProbeComplete || !Number.isFinite(surface.reference)) {
    throw new Error("Complete the surface probe before preparing a facing program.");
  }
  const bounds = outline.curveFit ? null : rectangle(outline.points.map((point) => ({ x: point.machine_x, y: point.machine_y })));
  if (!bounds) throw new Error(`Facing needs a four-corner outline aligned to machine X and Y within ${RECTANGLE_TOLERANCE_MM} mm.`);
  if (!machine?.connected || machine.stale || machine.state !== "Idle" || Number(machine.age_ms) > 10000) {
    throw new Error("Connect to an Idle machine to prepare the facing program.");
  }
  const rotation = machine.fields?.R;
  if (rotation != null && (String(rotation).trim() === "" || Number(rotation) !== 0)) {
    throw new Error("Clear workspace rotation before preparing this facing program.");
  }
  if (![origin?.x, origin?.y, origin?.z].every(Number.isFinite) ||
      Math.abs(surface.reference - origin.z) > POSITION_TOLERANCE) {
    throw new Error("Restore the work Z used for the surface probe before preparing the facing program.");
  }
  const { tool, diameter, stepover, stepdown, targetZ, rpm, feed, plunge } = parameters;
  if (!Number.isInteger(tool) || tool < 1 || tool > 999) throw new Error("Choose a cutter tool number from 1 to 999.");
  if (![diameter, stepover, stepdown, rpm, feed, plunge].every((n) => Number.isFinite(n) && n > 0)) {
    throw new Error("Enter the cutter diameter, step sizes, spindle speed, and both feeds.");
  }
  if (diameter < 0.01 || diameter > 500 || rpm > 60000 || feed > 30000 || !Number.isInteger(rpm)) {
    throw new Error("Choose a valid cutter diameter, spindle speed, and feed.");
  }
  if (stepover >= diameter) throw new Error("Stepover must be smaller than the cutter diameter.");
  if (plunge > feed) throw new Error("Descent feed must be at or below the cutting feed.");
  if (!Number.isFinite(targetZ) || targetZ > surface.low || surface.high - targetZ < 0.001) {
    throw new Error("Set the finish Z at or below the lowest measured point, with at least 0.001 mm to remove.");
  }
  if (!["x", "y", "z"].every((axis) => Number.isFinite(limits?.[axis + "_min"]) &&
      Number.isFinite(limits?.[axis + "_max"]) && limits[axis + "_min"] < limits[axis + "_max"]) ||
      !Number.isFinite(safeZ)) throw new Error("Learn the machine travel limits before preparing a facing program.");
  if (bounds.left < limits.x_min || bounds.right > limits.x_max || bounds.front < limits.y_min || bounds.back > limits.y_max ||
      safeZ > limits.z_max || targetZ + origin.z < limits.z_min || safeZ <= surface.high + origin.z) {
    throw new Error("The facing area, finish Z, or Safe Z is outside the usable machine travel.");
  }
  const lead = diameter / 2 + ENTRY_CLEARANCE_MM;
  const choice = ENTRY_CORNERS.includes(parameters.entryCorner) ? parameters.entryCorner : "auto";
  let entry = null;
  for (const corner of choice === "auto" ? ENTRY_CORNERS : [choice]) {
    const [end, side] = corner.split("-");
    const x = side === "left" ? bounds.left - lead : bounds.right + lead;
    if (x < limits.x_min || x > limits.x_max) continue;
    entry = { corner, side, end, x, y: end === "front" ? bounds.front : bounds.back };
    break;
  }
  if (!entry) {
    throw new Error(choice === "auto"
      ? `The cutter needs ${ENTRY_CLEARANCE_MM} mm plus its radius beyond an X edge of the stock to enter from the side.`
      : `There is no X travel to enter from the ${choice.replace("-", " ")} corner. Choose another entry corner.`);
  }
  const rowCount = Math.ceil((bounds.back - bounds.front) / stepover) + 1;
  const passCount = Math.ceil((surface.high - targetZ) / stepdown);
  if (rowCount * passCount > 5000 || stepover < 0.001 || stepdown < 0.001) {
    throw new Error("Increase the stepover or stepdown to stay within 5,000 cutting rows.");
  }
  const rows = Array.from({ length: rowCount }, (_, i) => bounds.front + i * (bounds.back - bounds.front) / (rowCount - 1));
  if (entry.end === "back") rows.reverse();
  const levels = Array.from({ length: passCount }, (_, i) => surface.high - (i + 1) * (surface.high - targetZ) / passCount);
  return { bounds, entry, origin, safeZ, rows, levels, totalDepth: surface.high - targetZ, parameters };
}

export function raster(plan) {
  const { bounds, entry, rows } = plan;
  return [{ x: entry.x, y: entry.y }, ...rows.flatMap((y, i) => {
    const leftward = (i % 2 === 1) !== (entry.side === "right");
    const a = leftward ? bounds.right : bounds.left;
    const b = leftward ? bounds.left : bounds.right;
    return [{ x: a, y }, { x: b, y }];
  })];
}

// Machine-coordinate box covering everything the cutter sweeps, including the
// descent outside the stock.
export function facingSweepBox({ bounds, entry, parameters }) {
  const radius = parameters.diameter / 2;
  return {
    left: Math.min(bounds.left, entry.x) - radius,
    right: Math.max(bounds.right, entry.x) + radius,
    front: bounds.front - radius,
    back: bounds.back + radius,
  };
}

export function facingTracePoints(plan, limits) {
  // Trace the box swept by the cutter, including its side entry.
  const { left, right, front, back } = facingSweepBox(plan);
  if (left < limits.x_min || right > limits.x_max || front < limits.y_min || back > limits.y_max) {
    throw new Error("The cutter footprint extends beyond machine travel.");
  }
  return [{ x: left, y: front }, { x: right, y: front }, { x: right, y: back }, { x: left, y: back }];
}

export function facingGcode(plan) {
  const { origin, safeZ, levels, parameters: p } = plan;
  const number = (value) => value.toFixed(4);
  const xy = ({ x, y }) => `X${number(x - origin.x)} Y${number(y - origin.y)}`;
  const [entry, ...cut] = raster(plan);
  const lift = `G53 G0 Z${number(safeZ)}`;
  const lines = [
    "; Sensei surface facing",
    `; Use the work zero from the surface scan and a calibrated T${p.tool} cutter`,
    `; Scan work XY zero was machine X${number(origin.x)} Y${number(origin.y)}`,
    `; Side entry at the ${plan.entry.corner.replace("-", " ")} corner, machine X${number(entry.x)} Y${number(entry.y)}`,
    `; The cutter descends ${ENTRY_CLEARANCE_MM} mm beyond the stock edge and feeds in from the side; it never plunges into the stock`,
    "G21", "G90", "G17", "G94", "M5", lift, `M6 T${p.tool}`, "G21", "G90", "G17", "G94", lift,
    "; Confirm work zero, tool length and cutter clearance before resuming", "M600",
    `M3 S${p.rpm}`, "G4 S2",
  ];
  for (const z of levels) {
    lines.push(lift, `G0 ${xy(entry)}`, `G1 Z${number(z)} F${number(p.plunge)}`);
    for (const point of cut) lines.push(`G1 ${xy(point)} F${number(p.feed)}`);
  }
  return [...lines, lift, "M5", "M2", ""].join("\n");
}

export function surfaceColor(z, surface) {
  const fraction = surface.range > 0 ? Math.max(0, Math.min(1, (z - surface.low) / surface.range)) : 0.5;
  return `hsl(${Math.round(220 - 194 * fraction)} 82% 62%)`;
}

function surfaceMap(outline, surface, plan) {
  if (!surface) return "";
  const outlinePoints = outline.points
    .filter((p) => Number.isFinite(p.machine_x) && Number.isFinite(p.machine_y))
    .map((p) => ({ x: p.machine_x, y: p.machine_y }));
  const pathPoints = plan ? raster(plan) : [];
  const sweep = plan ? facingSweepBox(plan) : null;
  const sweepCorners = sweep ? [{ x: sweep.left, y: sweep.front }, { x: sweep.right, y: sweep.back }] : [];
  const extent = [...outlinePoints, ...surface.points, ...pathPoints, ...sweepCorners];
  const left = Math.min(...extent.map((p) => p.x));
  const front = Math.min(...extent.map((p) => p.y));
  const width = Math.max(1, Math.max(...extent.map((p) => p.x)) - left);
  const height = Math.max(1, Math.max(...extent.map((p) => p.y)) - front);
  const scale = Math.min(376 / width, 208 / height);
  const xy = (p) => [(200 + (p.x - left - width / 2) * scale).toFixed(2), (116 - (p.y - front - height / 2) * scale).toFixed(2)];
  const boundary = outlinePoints.length > 2
    ? `<polygon points="${outlinePoints.map((p) => xy(p).join(",")).join(" ")}" />` : "";
  const path = plan
    ? `<polyline points="${pathPoints.map((point) => xy(point).join(",")).join(" ")}" />`
    : "";
  const dots = surface.points.map((p) => {
    const [x, y] = xy(p);
    return `<circle cx="${x}" cy="${y}" r="4" fill="${surfaceColor(p.z, surface)}"><title>Machine X ${p.x.toFixed(3)}, Y ${p.y.toFixed(3)}. Z ${p.z.toFixed(3)} mm</title></circle>`;
  });
  let entry = "";
  if (plan) {
    // Show the full cutter footprint where it descends, and the feed-in
    // direction, so clamps can be checked against it.
    const [ex, ey] = xy(plan.entry);
    const [fx, fy] = xy(pathPoints[1]);
    const [sx0, sy0] = xy({ x: sweep.left, y: sweep.back });
    const [sx1, sy1] = xy({ x: sweep.right, y: sweep.front });
    const r = (plan.parameters.diameter / 2 * scale).toFixed(2);
    const labelBelow = plan.entry.end === "front";
    const ly = (Number(ey) + (labelBelow ? Number(r) + 12 : -Number(r) - 6)).toFixed(2);
    entry = `<rect class="facing-sweep" x="${sx0}" y="${sy0}" width="${(sx1 - sx0).toFixed(2)}" height="${(sy1 - sy0).toFixed(2)}"><title>Area swept by the cutter</title></rect>` +
      `<g class="facing-entry"><title>Side entry: the cutter descends here, ${ENTRY_CLEARANCE_MM} mm outside the stock, then feeds in. Machine X ${plan.entry.x.toFixed(3)}, Y ${plan.entry.y.toFixed(3)}</title>` +
      `<circle cx="${ex}" cy="${ey}" r="${r}"/><line x1="${ex}" y1="${ey}" x2="${fx}" y2="${fy}"/>` +
      `<text x="${ex}" y="${ly}" text-anchor="middle">Entry</text></g>`;
  }
  return entry + boundary + path + dots.join("");
}

export function createSurfaceFacing({
  document, getOutline, getMachine, getOrigin, getLimits, getSafeZ, getReadOnly,
  getTraceBlocker, getTraceFeed, request, setStatusMessage, confirm,
}) {
  const node = (name) => document.getElementById("surface-facing-" + name);
  const dialog = () => node("modal");
  const getInputs = () => Array.from(dialog().querySelectorAll("[data-facing-param]"));
  const getEditButtons = () => dialog().querySelectorAll("[data-facing-diameter], [data-facing-step], [data-facing-entry]");
  const readParameters = () => ({
    ...Object.fromEntries(getInputs().map((input) => [input.dataset.facingParam, input.valueAsNumber])),
    entryCorner: dialog().querySelector('[data-facing-entry][aria-pressed="true"]')?.dataset.facingEntry || "auto",
  });
  let pending = "";
  let plan;
  let planError = "";
  let lastMap;

  function render() {
    if (!dialog()?.open) return;
    const outline = getOutline();
    const surface = surfaceMeasurements(outline);
    const parameters = readParameters();
    plan = null;
    planError = "";
    try {
      const machine = getMachine();
      plan = facingPlan({ outline, surface, machine, origin: getOrigin(), limits: getLimits(), safeZ: getSafeZ(), parameters });
    } catch (error) {
      planError = error.message;
    }
    const map = surfaceMap(outline, surface, plan);
    if (map !== lastMap) {
      node("map").innerHTML = map;
      lastMap = map;
    }
    setTextIfChanged(node("measurements"), surface ? `${surface.points.length} samples · ${surface.range.toFixed(3)} mm peak-to-valley` : "");
    const zSpace = Number.isFinite(surface?.reference) ? "Work Z" : "Machine Z";
    setTextIfChanged(node("low"), surface ? `${zSpace} low ${surface.low.toFixed(3)} mm` : "");
    setTextIfChanged(node("high"), surface ? `High ${surface.high.toFixed(3)} mm` : "");
    setTextIfChanged(node("deviation"), surface?.planeDeviation != null ? `${surface.planeDeviation.toFixed(3)} mm peak-to-valley after removing surface tilt` : "");
    setTextIfChanged(node("passes"), plan ? `${plan.levels.length} passes · ${plan.totalDepth.toFixed(3)} mm maximum removal` : planError);
    node("passes").classList.toggle("error", !plan && !!planError);
    setTextIfChanged(node("entry-summary"), plan
      ? `Enters from the ${plan.entry.corner.replace("-", " ")} corner${parameters.entryCorner === "auto" ? " (auto)" : ""} at machine X ${plan.entry.x.toFixed(2)} Y ${plan.entry.y.toFixed(2)}. Descends ${ENTRY_CLEARANCE_MM} mm outside the stock, then feeds in.`
      : "");
    for (const button of dialog().querySelectorAll("[data-facing-entry]")) {
      button.classList.toggle("active-entry", !!plan && plan.entry.corner === button.dataset.facingEntry);
    }
    node("queue").disabled = !!pending || getReadOnly();
    node("trace").disabled = !!pending || getReadOnly();
    setElementBusy(node("trace"), pending === "trace");
    setTextIfChanged(node("trace"), pending === "trace" ? "Tracing…" : "Trace facing area with laser");
    node("close").disabled = !!pending;
    setElementBusy(node("queue"), pending === "queue");
    setTextIfChanged(node("queue"), pending === "queue" ? "Queuing…" : "Queue facing program");
    for (const input of getInputs()) input.disabled = !!pending;
    for (const button of getEditButtons()) button.disabled = !!pending;
  }

  function bind(bindButtonAction) {
    if (!dialog()) return;
    const feedback = (text, kind = "", opts = {}) => setStatusMessage("surface-facing", text, kind, { force: true, ...opts });
    bindButtonAction(node("open"), () => {
      const surface = surfaceMeasurements(getOutline());
      if (!surface) {
        feedback("Facing needs a captured four-corner outline and a probed surface. Follow the steps in Machining.", "error");
        return;
      }
      node("target").value = (Math.floor(surface.low * 10000) / 10000).toFixed(4);
      dialog().showModal();
      render();
    });
    bindButtonAction(node("close"), () => { if (!pending) dialog().close(); });
    dialog().addEventListener("cancel", (event) => { if (pending) event.preventDefault(); });
    dialog().addEventListener("input", render);
    for (const button of getEditButtons()) {
      bindButtonAction(button, () => {
        if (pending) return;
        const { facingDiameter, facingStep, facingDelta, facingEntry } = button.dataset;
        if (facingEntry) {
          for (const choice of dialog().querySelectorAll("[data-facing-entry]")) {
            choice.setAttribute("aria-pressed", String(choice === button));
          }
        } else if (facingDiameter) {
          const input = node("diameter");
          const custom = facingDiameter === "custom";
          node("custom-diameter").hidden = !custom;
          for (const choice of dialog().querySelectorAll("[data-facing-diameter]")) {
            choice.setAttribute("aria-pressed", String(choice === button));
          }
          if (custom) input.focus();
          else input.value = facingDiameter;
        } else {
          const input = getInputs().find((field) => field.dataset.facingParam === facingStep);
          const current = Number.isFinite(input.valueAsNumber) ? input.valueAsNumber : 0;
          const next = Number((current + Number(facingDelta)).toFixed(4));
          if (facingStep === "targetZ") {
            const surface = surfaceMeasurements(getOutline());
            if (!surface) return;
            input.value = String(Math.min(next, Math.floor(surface.low * 10000) / 10000));
          } else {
            const diameter = node("diameter").valueAsNumber;
            const max = facingStep === "stepover" && diameter >= 0.01
              ? Math.floor((diameter - 0.001) * 10000) / 10000 : Infinity;
            input.value = String(Math.max(Number(input.min), Math.min(next, max)));
          }
        }
        render();
      });
    }
    bindButtonAction(node("trace"), async () => {
      if (pending || getReadOnly()) return;
      try {
        const blocker = getTraceBlocker();
        if (blocker) throw new Error(blocker);
        render();
        if (!plan) throw new Error("Complete the facing setup before tracing.");
        const machinePoints = facingTracePoints(plan, getLimits());
        if (!confirm("Move the probe laser around the area the cutter sweeps, including the side entry, at Safe Z? Check that the probe can clear the stock and clamps.")) return;
        pending = "trace";
        render();
        feedback("Tracing facing area…", "", { timeoutMs: 0 });
        const response = await request("/api/outline/trace", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            machine_points: machinePoints,
            safe_z_mm: plan.safeZ,
            feed_mm_min: getTraceFeed(),
            closed: true,
          }),
        });
        const result = await response.json();
        if (!result.verified) throw new Error(result.message || "Trace motion could not be verified.");
        feedback("Facing area traced with the probe laser.", "ok");
      } catch (error) {
        feedback("Facing area could not be traced. " + error.message, "error");
      } finally {
        pending = "";
        render();
      }
    });
    bindButtonAction(node("queue"), async () => {
      if (pending || getReadOnly()) return;
      const outline = getOutline();
      const parameters = readParameters();
      try {
        const generated = facingPlan({ outline, surface: surfaceMeasurements(outline), machine: getMachine(),
          origin: getOrigin(), limits: getLimits(), safeZ: getSafeZ(), parameters });
        if (!confirm(`Queue this facing program? It uses the work zero from this scan. The cutter descends outside the stock at the ${generated.entry.corner.replace("-", " ")} corner and feeds in from the side. Check the clamps against the shown entry, toolpath and ${(parameters.diameter / 2).toFixed(2)} mm cutter radius.`)) return;
        pending = "queue";
        render();
        feedback("Queuing facing program…", "", { timeoutMs: 0 });
        const suffix = globalThis.crypto.getRandomValues(new Uint32Array(1))[0].toString(16);
        const name = `facing-${Date.now()}-${suffix}.nc`;
        const response = await request("/api/files?path=" + encodeURIComponent(name), {
          method: "POST", headers: { "Content-Type": "text/plain" }, body: facingGcode(generated),
        });
        const entry = await response.json();
        if (entry.path !== "/sd/gcodes/" + name || !entry.upcoming?.id) throw new Error("The upload queue did not confirm the facing program.");
        dialog().close();
        feedback(`Queued ${name} in Up next.`, "ok");
      } catch (error) {
        feedback(`Facing program could not be queued. ${error.message}`, "error");
      } finally {
        pending = "";
        render();
      }
    });
  }

  return { bind, render };
}
