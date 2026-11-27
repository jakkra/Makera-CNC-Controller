import { bedReferenceHoles, bedMapExtent, bedPlatePlacement, bedPlateSVG } from "./bed-plate.js";
import { setElementBusy, setTextIfChanged } from "./dom.js";
import { DEFAULT_FACING_MATERIAL, DEFAULT_HOLE_DEPTH_MM, helixPreset } from "./facing-presets.js";

const SETTINGS_KEY = "sensei.alignment-settings.v1";
const VALUE_FIELDS = ["depth", "stepdown", "rpm", "feed"];

const cutterDiameter = 3.175;
const nominalDiameter = 4;
const positionTolerance = 0.01;
// The program asks for this tool and pauses so the 3.175 mm end mill can be
// fitted, the same way the facing program does.
const HOLE_TOOL = 1;
const APPROACH_Z_MM = 2;
// The helix starts this far above work Z0, so a stock top slightly above the
// probed zero is still entered by the helix rather than a straight descent.
const HELIX_START_Z_MM = 1;
const localReferences = bedReferenceHoles({ x0: 0, y0: 0 });

export function alignmentDelta(a, b) {
  const x = Number((b.x - a.x).toFixed(3));
  const y = Number((b.y - a.y).toFixed(3));
  return x || y ? { x, y } : null;
}

const spacings = [...new Set(localReferences.flatMap((a) => localReferences.flatMap((b) => {
  const delta = alignmentDelta(a, b);
  return delta && !(delta.x && delta.y) ? [Math.abs(delta.x || delta.y)] : [];
})))].sort((a, b) => a - b);

function zeroRotation(fields) {
  const angle = fields?.R;
  return angle == null || (String(angle).trim() !== "" && Number(angle) === 0);
}

function alignedMachine(machine) {
  return machine?.connected && !machine.stale && machine.state === "Idle" &&
    Number(machine.age_ms) <= 10000 && !machine.controller?.inch_mode;
}

function workOrigin(machine) {
  const origin = Object.fromEntries(["x", "y", "z"].map((axis) => [
    axis, machine.mpos?.[axis] - machine.wpos?.[axis],
  ]));
  return Object.values(origin).every(Number.isFinite) ? origin : null;
}

function axialDelta(direction, spacing) {
  if (!Number.isFinite(spacing) || spacing <= 0 || !/^[xy][+-]$/.test(direction)) return null;
  const [axis, sign] = direction;
  return { x: 0, y: 0, [axis]: sign === "+" ? spacing : -spacing };
}

export function alignmentCenters(first, delta) {
  if (!first || !delta) return null;
  return [first, { x: first.x + delta.x, y: first.y + delta.y }];
}

export function alignmentPlan({ centers, adjustment, depth, stepdown, rpm, feed, machine, limits, safeZ }) {
  if (!centers) throw new Error("Capture the first hole and choose a spacing.");
  if (!alignedMachine(machine)) throw new Error("Wait for a connected, idle machine in millimeter mode.");
  if (!zeroRotation(machine.fields)) throw new Error("Clear work coordinate rotation before preparing the program.");
  const origin = workOrigin(machine);
  if (!origin) throw new Error("Machine and work coordinates are unavailable.");
  const diameter = nominalDiameter + adjustment;
  // The cutter swept by the helix must cover both the wall and the hole center.
  if (!Number.isFinite(adjustment) || diameter < cutterDiameter + 0.002 || diameter >= 2 * cutterDiameter) {
    throw new Error("Enter an adjustment that leaves a hole larger than 3.175 mm and smaller than 6.35 mm.");
  }
  if (!Number.isFinite(depth) || depth < 0.001 || !Number.isFinite(stepdown) || stepdown < 0.001 ||
      Math.ceil(depth / stepdown) > 250 || !Number.isInteger(rpm) || rpm <= 0 || rpm > 60000 ||
      !Number.isFinite(feed) || feed <= 0 || feed > 30000) {
    throw new Error("Check hole depth, depth per turn, spindle speed and feed.");
  }
  if (!["x", "y", "z"].every((axis) => Number.isFinite(limits?.[axis + "_min"]) &&
      Number.isFinite(limits?.[axis + "_max"]) && limits[axis + "_min"] < limits[axis + "_max"]) ||
      !Number.isFinite(safeZ)) throw new Error("Learn the machine travel limits before preparing the program.");
  const [first, second] = centers;
  if (Math.hypot(second.x - first.x, second.y - first.y) <= diameter) throw new Error("The holes must be spaced farther apart than their diameter.");
  const radius = diameter / 2;
  if (centers.some((center) => !["x", "y"].every((axis) =>
    Number.isFinite(center[axis]) && center[axis] - radius >= limits[axis + "_min"] &&
    center[axis] + radius <= limits[axis + "_max"]))) throw new Error("A hole extends beyond machine travel.");
  if (origin.z - depth < limits.z_min || safeZ > limits.z_max || safeZ <= origin.z) {
    throw new Error("Hole depth or Safe Z is outside usable machine travel.");
  }
  return { centers, diameter, depth, stepdown, rpm, feed, origin, safeZ, tool: HOLE_TOOL };
}

export function alignmentGcode(plan) {
  const mm = (value) => value.toFixed(4);
  const { centers, diameter, depth, stepdown, rpm, feed, origin, safeZ, tool } = plan;
  const radius = (diameter - cutterDiameter) / 2;
  const helixDepth = depth + HELIX_START_Z_MM;
  const turns = Math.ceil(helixDepth / stepdown);
  const lift = "G53 G0 Z" + mm(safeZ);
  const lineXY = (x, y) => `X${mm(x)} Y${mm(y)}`;
  const lines = [
    `; Sensei alignment setup v2 ${mm(origin.x)} ${mm(origin.y)} ${mm(origin.z)}`,
    `; Two ${mm(diameter)} mm holes with a 3.175 mm end mill as T${tool}`,
    "G21", "G90", "G17", "G94", "M5", lift, `M6 T${tool}`, "G21", "G90", "G17", "G94", lift,
    "; Fit the 3.175 mm end mill, then confirm the stock-top Z zero and clearance below both holes", "M600",
    `M3 S${rpm}`, "G4 S2",
  ];
  // Four quarter-arcs per turn avoid full-circle ambiguity in firmware.
  const ring = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 0]];
  for (const center of centers) {
    const x = center.x - origin.x;
    const y = center.y - origin.y;
    // Rapid to just above the stock, feed to the surface, then descend only
    // along the helix. There is no straight plunge below Z0.
    lines.push(lift, "G0 " + lineXY(x + radius, y), `G0 Z${mm(APPROACH_Z_MM)}`, `G1 Z${mm(HELIX_START_Z_MM)} F${mm(feed)}`);
    for (let turn = 0; turn <= turns; turn++) {
      for (let quarter = 1; quarter < ring.length; quarter++) {
        const [px, py] = ring[quarter - 1];
        const [qx, qy] = ring[quarter];
        const z = HELIX_START_Z_MM - helixDepth * Math.min(1, (turn + quarter / 4) / turns);
        const xy = lineXY(x + qx * radius, y + qy * radius);
        lines.push(`G3 ${xy} Z${mm(z)} I${mm(-px * radius)} J${mm(-py * radius)} F${mm(feed)}`);
      }
    }
  }
  lines.push(lift, "M5", "M2", "");
  return lines.join("\n");
}

// A retry must cut around the same centers: the work XY zero must not move.
// Work Z depends on the fitted tool, which the program changes itself.
function sameSetup(a, b) {
  return ["x", "y"].every((axis) => Math.abs(a.origin[axis] - b.origin[axis]) <= positionTolerance);
}

export function createAlignmentHoles({
  document, getMachine, getSettings, getMovementBusy, getReadOnly, getSafeZ,
  isZProbeActive, runAutoZProbe, request, setStatusMessage, confirm,
}) {
  const node = (name) => document.getElementById("alignment-holes-" + name);
  let first = null;
  let reference = [];
  let queued = null;
  let pending = "";
  let lastMap = "";
  let mapLocation = "";
  const feedback = (message, kind, options = {}) =>
    setStatusMessage("alignment-holes", message, kind, { force: true, ...options });
  const number = (name) => node(name).valueAsNumber;
  const direction = () => node("direction").value;
  const spacing = () => node("spacing").value === "custom" ? number("distance") : Number(node("spacing").value);
  const coordinates = ({x, y}) => `X ${x.toFixed(3)} · Y ${y.toFixed(3)}`;
  const referenceDelta = () => reference.length === 2 ? alignmentDelta(...reference) : null;
  const holeCenters = () => alignmentCenters(first, direction() === "reference"
    ? referenceDelta() : axialDelta(direction(), spacing()));

  function clearReferenceSpacing() {
    if (node("spacing").value === "reference") node("spacing").value = "";
    if (direction() === "reference") node("direction").value = "x+";
  }

  function render() {
    if (!node("modal")?.open) return;
    const settings = getSettings();
    const { work_area: work, learned } = settings;
    const placement = bedPlatePlacement(learned);
    const extent = bedMapExtent(work, placement);
    const width = extent.x_max - extent.x_min;
    const height = extent.y_max - extent.y_min;
    const location = JSON.stringify([placement?.x0, placement?.y0, ...Object.values(extent)]);
    const mapChanged = location !== mapLocation;
    if (mapChanged) {
      mapLocation = location;
      reference = [];
      clearReferenceSpacing();
    }
    const centers = holeCenters();
    const holeMarks = (centers || (first ? [first] : [])).map(({ x, y }, index) => (
      `<g class="alignment-hole-target"><circle cx="${x}" cy="${-y}" r="4"/><text x="${x + 5}" y="${-y - 4}">${index + 1}</text></g>`
    )).join("");
    const axis = centers ? `<line class="alignment-hole-axis" x1="${centers[0].x}" y1="${-centers[0].y}" x2="${centers[1].x}" y2="${-centers[1].y}"/>` : "";
    const svg = bedPlateSVG({ work, placement, overlay: axis + holeMarks });
    if (svg !== lastMap) {
      node("drawing").innerHTML = svg;
      lastMap = svg;
    }
    if (mapChanged) {
      node("plot").style.aspectRatio = String(width / height);
      node("plot").style.width = `min(100%, calc(max(280px, 50dvh) * ${(width / height).toFixed(4)}))`;
      const holes = placement ? bedReferenceHoles(placement) : [];
      node("references").replaceChildren(...holes.map((hole) => {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.hole = hole.name;
        const kind = hole.name.startsWith("L-") ? "L-bracket pin" : "Reference hole";
        button.setAttribute("aria-label", `${kind} ${hole.name}`);
        button.style.left = `${100 * (hole.x - extent.x_min) / width}%`;
        button.style.top = `${100 * (extent.y_max - hole.y) / height}%`;
        const label = document.createElement("span");
        label.textContent = hole.name;
        button.append(label);
        button.addEventListener("click", (event) => {
          // The L-bracket pin targets overlap their nearest grid targets on
          // narrow screens. Resolve taps on the map by the closest center.
          if (event.detail > 0 && event.target === button) {
            let nearest = button;
            let distance = Infinity;
            for (const candidate of node("references").children) {
              const rect = candidate.getBoundingClientRect();
              const d = Math.hypot(event.clientX - rect.left - rect.width / 2,
                event.clientY - rect.top - rect.height / 2);
              if (d < distance) {
                nearest = candidate;
                distance = d;
              }
            }
            pickReference(holes.find((item) => item.name === nearest.dataset.hole));
          } else {
            pickReference(hole);
          }
        });
        return button;
      }));
    }
    for (const button of node("references").children) {
      button.disabled = !!pending;
      button.setAttribute("aria-pressed", String(reference.some((hole) => hole.name === button.dataset.hole)));
    }
    const custom = node("spacing").value === "custom";
    node("custom").hidden = !custom;
    const fromReference = direction() === "reference";
    node("direction-reference").hidden = !fromReference;
    node("spacing-reference").hidden = !fromReference;
    setTextIfChanged(node("map-label"), placement ? "Select two reference holes" : "Machine travel");
    setTextIfChanged(node("reference"), reference.length ? reference.map((hole) => hole.name).join(" → ") : "");
    setTextIfChanged(node("first"), first ? coordinates(first) : "—");
    setTextIfChanged(node("second"), centers ? coordinates(centers[1]) : "—");
    const diameter = nominalDiameter + number("adjustment");
    setTextIfChanged(node("diameter"), Number.isFinite(diameter) ? `Ø ${diameter.toFixed(3)} mm` : "—");
    for (const field of node("modal").querySelectorAll("input, select, [data-alignment-step]")) field.disabled = !!pending;
    node("spacing").disabled = !!pending || fromReference;
    node("close").disabled = !!pending;
    node("capture").disabled = !!pending;
    node("probe-z").disabled = !!pending || getReadOnly();
    setElementBusy(node("probe-z"), pending === "probe");
    setTextIfChanged(node("probe-z"), pending === "probe" ? "Probing stock Z…" : "Probe stock Z");
    node("queue").disabled = !!pending || getReadOnly() || !centers;
    setElementBusy(node("queue"), pending === "queue");
    setTextIfChanged(node("queue"), pending === "queue" ? "Queuing…" : queued ? "Queue again" : "Queue hole program");
  }

  function pickReference(hole) {
    if (pending) return;
    if (reference.length !== 1 || reference[0].name === hole.name) {
      reference = [hole];
      clearReferenceSpacing();
    } else {
      const delta = alignmentDelta(reference[0], hole);
      if (!delta) return;
      reference.push(hole);
      if (delta.x && delta.y) {
        const signed = (value) => (value > 0 ? "+" : "") + value;
        node("direction-reference").textContent = `X ${signed(delta.x)} / Y ${signed(delta.y)}`;
        node("spacing-reference").textContent = `${Math.hypot(delta.x, delta.y).toFixed(3)} mm`;
        node("direction").value = "reference";
        node("spacing").value = "reference";
      } else {
        const distance = delta.x || delta.y;
        node("direction").value = (delta.x ? "x" : "y") + (distance > 0 ? "+" : "-");
        node("spacing").value = String(Math.abs(distance));
      }
    }
    render();
  }

  function bind(bindButtonAction) {
    const modal = node("modal");
    if (!modal) return;
    const options = spacings.map((distance) => {
      const option = document.createElement("option");
      option.value = String(distance);
      option.textContent = distance + " mm";
      return option;
    });
    node("spacing").lastElementChild.before(...options);
    const storage = () => { try { return globalThis.localStorage || null; } catch { return null; } };
    const material = () => modal.querySelector('[data-alignment-material][aria-pressed="true"]')?.dataset.alignmentMaterial || DEFAULT_FACING_MATERIAL;
    const pressMaterial = (value) => {
      for (const button of modal.querySelectorAll("[data-alignment-material]")) {
        button.setAttribute("aria-pressed", String(button.dataset.alignmentMaterial === value));
      }
    };
    const applyPreset = () => {
      const preset = helixPreset(material());
      for (const name of ["stepdown", "rpm", "feed"]) node(name).value = String(preset[name]);
    };
    const saveSettings = () => {
      const values = Object.fromEntries(VALUE_FIELDS.map((name) => [name, node(name).value]));
      try { storage()?.setItem(SETTINGS_KEY, JSON.stringify({ material: material(), values })); } catch { /* best effort */ }
    };
    // Restore the last material and values, or fill the preset for the
    // default material and the default hole depth.
    const restoreSettings = () => {
      let saved = null;
      try { saved = JSON.parse(storage()?.getItem(SETTINGS_KEY) || "null"); } catch { saved = null; }
      pressMaterial(saved?.material || DEFAULT_FACING_MATERIAL);
      if (saved?.values) {
        for (const name of VALUE_FIELDS) if (saved.values[name]) node(name).value = saved.values[name];
      } else {
        applyPreset();
        node("depth").value = String(DEFAULT_HOLE_DEPTH_MM);
      }
    };
    for (const button of modal.querySelectorAll("[data-alignment-material]")) {
      bindButtonAction(button, () => {
        if (pending) return;
        pressMaterial(button.dataset.alignmentMaterial);
        applyPreset();
        saveSettings();
        render();
      });
    }
    modal.addEventListener("input", (event) => {
      if (VALUE_FIELDS.some((name) => event.target === node(name))) saveSettings();
    });
    bindButtonAction(node("open"), () => { restoreSettings(); modal.showModal(); render(); });
    bindButtonAction(node("close"), () => { if (!pending) modal.close(); });
    modal.addEventListener("cancel", (event) => { if (pending) event.preventDefault(); });
    modal.addEventListener("input", (event) => {
      if ([node("direction"), node("spacing"), node("distance")].includes(event.target)) {
        reference = [];
        clearReferenceSpacing();
      }
      render();
    });
    bindButtonAction(node("capture"), () => {
      const machine = getMachine();
      if (getMovementBusy() || !alignedMachine(machine) || !Number.isFinite(machine.mpos?.x) || !Number.isFinite(machine.mpos?.y)) {
        feedback("Stop and disarm Movement, then capture the first hole from a fresh Idle position in millimeters.", "error");
        return;
      }
      first = { x: machine.mpos.x, y: machine.mpos.y };
      queued = null;
      render();
    });
    for (const button of modal.querySelectorAll("[data-alignment-step]")) {
      bindButtonAction(button, () => {
        node("adjustment").value = ((number("adjustment") || 0) + Number(button.dataset.alignmentStep)).toFixed(2);
        render();
      });
    }
    bindButtonAction(node("probe-z"), async () => {
      if (pending || getReadOnly()) return;
      if (getMovementBusy() || !alignedMachine(getMachine())) {
        feedback("Stop and disarm Movement before probing stock Z on an idle machine in millimeters.", "error");
        return;
      }
      if (!isZProbeActive()) {
        feedback("Select the probe or 3D Probe before probing stock Z.", "error");
        return;
      }
      if (!confirm("Probe the stock surface at current XY and set work Z zero? Position the active probe over the stock first.")) return;
      pending = "probe";
      render();
      try {
        await runAutoZProbe();
      } catch (error) {
        feedback("Stock Z probing failed. " + error.message, "error");
      } finally {
        pending = "";
        render();
      }
    });
    bindButtonAction(node("queue"), async () => {
      if (pending || getReadOnly()) return;
      try {
        if (getMovementBusy()) throw new Error("Stop and disarm Movement before queuing.");
        const plan = alignmentPlan({
          centers: holeCenters(),
          adjustment: number("adjustment"), depth: number("depth"), stepdown: number("stepdown"),
          rpm: number("rpm"), feed: number("feed"), machine: getMachine(),
          limits: getSettings().learned?.soft_endstop, safeZ: getSafeZ(),
        });
        if (queued && !sameSetup(queued, plan)) throw new Error("Restore the work XY zero used for the last hole program.");
        if (!confirm(`Queue two Ø ${plan.diameter.toFixed(3)} mm holes? The program stops for a tool change so you can fit the 3.175 mm end mill, then pauses to confirm stock-top Z zero and clearance below both holes.`)) return;
        pending = "queue";
        render();
        feedback("Queuing alignment hole program…", "", { timeoutMs: 0 });
        const suffix = globalThis.crypto.getRandomValues(new Uint32Array(1))[0].toString(16);
        const name = `alignment-holes-${Date.now()}-${suffix}.nc`;
        const response = await request("/api/files?path=" + encodeURIComponent(name), {
          method: "POST", headers: { "Content-Type": "text/plain" }, body: alignmentGcode(plan),
        });
        const entry = await response.json();
        if (entry.path !== "/sd/gcodes/" + name || !entry.upcoming?.id) throw new Error("Up next did not confirm the file.");
        queued = plan;
        modal.close();
        feedback(`Queued ${name} in Up next.`, "ok");
      } catch (error) {
        feedback("Alignment hole program could not be queued. " + error.message, "error");
      } finally {
        pending = "";
        render();
      }
    });
  }
  return { bind, render };
}
