import { DEFAULT_FIELD_SPOT_GAP_MM } from "./outline-geometry.js";

export function newID(prefix) {
  if (globalThis.crypto && globalThis.crypto.randomUUID) return prefix + "-" + globalThis.crypto.randomUUID();
  return prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

export function defaultOutlineState() {
  return {
    active: false,
    points: [],
    closed: false,
    curveFit: false,
    origin: null,
    undo: [],
    redo: [],
    fieldSpotGapMM: DEFAULT_FIELD_SPOT_GAP_MM,
    floorMachineZ: null,
    floorProbe: null,
    floorProbePending: false,
    fieldReferenceMachineZ: null,
    fieldReferenceKind: "",
    fieldProbePreview: [],
    fieldProbeResults: [],
    fieldProbeComplete: false,
    fieldProbePending: false,
    fieldProbeIndex: 0,
    fieldProbeSelectedID: "",
    fieldProbePointMovePending: false,
    fieldProbeTooDense: false,
    fieldProbeIssue: "",
    tracePending: false,
    addPointPending: false,
    addPointQueued: 0,
    filePending: false,
    feedback: "",
    feedbackKind: "",
  };
}

export function defaultWorkAreaView() {
  return {
    zoom: 1,
    panX: 0,
    panY: 0,
    pointerId: null,
    pointerStartX: 0,
    pointerStartY: 0,
    pointerLastX: 0,
    pointerLastY: 0,
    clientStartX: 0,
    clientStartY: 0,
    tapLocal: null,
    tapProbeID: "",
    probeDragID: "",
    probeDragOriginal: null,
    probeDragging: false,
    dragging: false,
    mobileJogPointerId: null,
    mobileJogOriginClientX: 0,
    mobileJogOriginClientY: 0,
    mobileJogOriginLocal: null,
    mobileJogKnobLocal: null,
    mobileJogRadiusPX: 0,
    mobileJogAxes: { x: 0, y: 0, z: 0 },
    mobileJogActive: false,
  };
}

export function cloneOutlinePoint(point) {
  const out = {
    id: point.id,
    x: point.x,
    y: point.y,
    z: point.z,
    machine_x: point.machine_x,
    machine_y: point.machine_y,
    machine_z: point.machine_z,
    captured_at: point.captured_at,
    probed: !!point.probed,
    probe_output: point.probe_output || "",
  };
  if (point.probe_kind) out.probe_kind = point.probe_kind;
  return out;
}

export function cloneOutlineOrigin(origin) {
  if (!origin) return null;
  const out = {};
  for (const axis of ["x", "y", "z"]) {
    const value = Number(origin[axis]);
    if (Number.isFinite(value)) out[axis] = value;
  }
  return Object.keys(out).length ? out : null;
}

export function cloneFloorProbe(probe) {
  if (!probe || typeof probe !== "object") return null;
  const machineX = Number(probe.machine_x);
  const machineY = Number(probe.machine_y);
  const machineZ = Number(probe.machine_z);
  if (![machineX, machineY, machineZ].every(Number.isFinite)) return null;
  return {
    machine_x: machineX,
    machine_y: machineY,
    machine_z: machineZ,
    captured_at: typeof probe.captured_at === "string" ? probe.captured_at : "",
    probe_output: typeof probe.probe_output === "string" ? probe.probe_output : "",
    verified: probe.verified !== false,
  };
}
