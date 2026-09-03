import * as THREE from "./three.module.min.js";

const ROOT = "/sd/gcodes";
const GCODE_MAX_LINES = 500;
const GCODE_HISTORY_KEY = "cnc-proxy.gcode-history.v1";
const PROBE_SPOT_DIAMETER_MM = 2;
const PROBE_SPOT_RADIUS_MM = PROBE_SPOT_DIAMETER_MM / 2;
const DEFAULT_FIELD_SPOT_GAP_MM = 8;
const DEFAULT_SAFE_Z_MM = -3;
const SAFE_Z_LIMIT_MARGIN_MM = 3;
const MAX_FIELD_PROBE_POINTS = 1500;
const OUTLINE_CURVE_TOLERANCE_MM = 0.25;
const MAX_EFFECTIVE_OUTLINE_POINTS = 4000;
const DEFAULT_PROBE_DEPTH_MM = 20;
const DEFAULT_PROBE_FEED_MM = 50;
const DEFAULT_MACHINE_FEED_MIN_MM_MIN = 1;
const DEFAULT_MACHINE_FEED_MAX_MM_MIN = 3000;
const MAX_MACHINE_FEED_MM_MIN = 10000;
const NOTICE_INFO_TIMEOUT_MS = 4500;
const NOTICE_OK_TIMEOUT_MS = 3500;
const NOTICE_ERROR_TIMEOUT_MS = 8000;
const NOTICE_REPEAT_SUPPRESS_MS = 30000;
const NOTICE_EXIT_MS = 180;
const NOTICE_REFLOW_MS = 200;
const GCODE_SOURCE_ROW_HEIGHT = 20;
const GCODE_SOURCE_OVERSCAN = 12;
const GCODE_SOURCE_PAGE_SIZE = 500;
const GCODE_SOURCE_MAX_PAGES = 8;
const GCODE_SEGMENT_PAGE_SIZE = 5000;
const ACTIVE_JOB_SPLIT_DEFAULT_PERCENT = 32;
const ACTIVE_JOB_SPLIT_STEP_PERCENT = 2;
const ACTIVE_JOB_SPLIT_MIN_LEFT_PX = 260;
const ACTIVE_JOB_SPLIT_MIN_PREVIEW_PX = 320;
const ACTIVE_JOB_SPLITTER_PX = 16;
const VIEW_TABS = ["dashboard", "active-job", "jog", "control", "files", "attention"];
const NAV_VIEW_TABS = ["dashboard", "active-job", "jog", "control", "files"];
const SURFACE_VIEW_PREFERENCES_KEY = "cnc-proxy.surface-view-preferences.v1";
const DASHBOARD_PANEL_DEFS = [{ id: "machine", label: "Machine" }, { id: "job", label: "Current job" }, { id: "telemetry", label: "Machine telemetry" }, { id: "gcode", label: "Gcode stream" }];
const JOG_INPUT_HEARTBEAT_MS = 100;
const JOG_INPUT_DEADZONE = 0.12;
const JOG_PREDICTION_TOLERANCE_MM = 0.02;
const EXTERNAL_SNAPSHOT_REFRESH_MS = 1500;
const MOBILE_WORKAREA_MAX_WIDTH_PX = 600;
const MOBILE_JOG_RADIUS_MIN_PX = 56;
const MOBILE_JOG_RADIUS_MAX_PX = 88;
const OUTLINE_CAPTURE_SETTLE_MS = 300;
const OUTLINE_CAPTURE_POLL_MS = 50;
const OUTLINE_CAPTURE_TIMEOUT_MS = 60000;
const OUTLINE_CAPTURE_POSITION_TOLERANCE_MM = 0.02;
const MACHINE_SETTING_IDS = [
  "machine-x-min", "machine-x-max", "machine-y-min", "machine-y-max",
  "machine-origin-x", "machine-origin-y", "machine-feed-min", "machine-feed-max",
  "tap-feed-mm-min", "machine-safe-z",
];
const MACRO_EDITOR_IDS = ["macro-name", "macro-description", "macro-color", "macro-lines", "macro-placement"];

const state = {
  files: new Map(),
  jobs: new Map(),
  readOnly: false,
  machine: { state: "", mode: "owner", age_ms: 0, connected: false },
  gcodeSeqs: new Set(),
  gcodeLines: [],
  commandHistory: loadCommandHistory(),
  historyIndex: -1,
  filter: "",
  logFilter: "all",
  logSearch: "",
  logPaused: false,
  selectedMacroId: "",
  ui: { macros: [], macro_buttons: [], log: { filter: "all", autoscroll: true }, gamepad: defaultGamepadSettings(), machine: defaultMachineSettings(), dashboard: defaultDashboardSettings() },
  settingsSaveTimer: null,
  machineLearnPending: false,
  macroRunning: false,
  activeTab: "active-job",
  surface: loadSurfaceViewPreferences(),
  activeJobLeftTab: "source",
  activeJobSplitPercent: ACTIVE_JOB_SPLIT_DEFAULT_PERCENT,
  dashboardProfileID: "overview",
  dashboardRequestedProfileID: "",
  dashboardEmbed: false,
  dashboardSettingsLoaded: false,
  dashboardDraftProfileID: "",
  dashboardCameraPrimary: loadDashboardCameraPrimary(),
  cameras: {
    loaded: false,
    sources: { builtin: { configured: false }, external: { configured: false } },
    builtinWS: null,
    builtinReconnectTimer: null,
    builtinObjectURL: "",
    builtinObjectURLs: new Set(),
    externalURL: "",
    externalRetryTimer: null,
  },
	filesLoaded: false,
	fileActions: new Map(),
	fileRenderTimer: null,
  currentDir: "",
  controlPendingAction: "",
  autoVacuumPending: false,
  lastControlResult: null,
  activeGcode: { path: "", runnable: false, message: "" },
  externalJobObservedAt: 0,
  activeGcodePending: "",
  activeGcodeLoading: false,
  activeSelectPendingPath: "",
  toolPending: "",
  gamepadMacroBindingDirty: false,
  noticeKey: "",
  noticeSeq: 0,
  notices: new Map(),
  statusMessages: new Map(),
  connectivityIssues: new Map(),
  controlES: null,
  filesES: null,
  jog: {
    caps: null,
    ws: null,
    seq: 1,
    armed: false,
    link: "offline",
    pad: "",
    deadman: false,
    axes: { x: 0, y: 0, z: 0 },
    mpos: null,
    wpos: null,
    observed: null,
    estimated: false,
    estimatedUntil: 0,
    statusRevision: 0,
    motionRevision: 0,
    settledMotionRevision: 0,
    motionRevisionKnown: false,
    motionStreamRevision: 0,
    availability: null,
    target: null,
    lead: { x: 0, y: 0, z: 0 },
    path: [],
    buttons: [],
    armPending: 0,
    armPendingAction: "",
    armQueuedAction: "",
    disarmAfterPendingArm: false,
    targetPending: 0,
    targetMotionPending: 0,
    fieldProbeMovePending: 0,
    workMovePending: 0,
    targetLabel: "",
    zStepPending: 0,
    zStepLabel: "",
    surfaceStepPending: 0,
    surfaceStepSource: "",
    commandDisarm: null,
    zProbePending: false,
    probe3DPending: false,
    originPending: 0,
    originPendingAxis: "",
    originPendingMode: "",
    originPendingAxes: [],
    originPendingIndex: 0,
    originPendingTargets: null,
    originPendingLabel: "",
    originVerifyDeadline: 0,
    originVerifyTimer: null,
    tapFeedback: "",
    tapFeedbackKind: "",
    error: "",
    errorCode: "",
    sent: new Map(),
    reconnectTimer: null,
    reconnectAttempt: 0,
    sampleTimer: null,
    preferredPadIndex: null,
    lastInput: null,
    lastInputSentAt: 0,
    inputSuspended: false,
    surfaceInput: null,
    surfaceWheel: { pointerId: null, lastAngle: null, angle: 0, remainder: 0, value: 0, gestureSteps: 0, gestureAccepted: 0, gestureReleased: false, gestureAxis: "", blocked: false },
    outlineCaptureIntents: [],
  },
  outline: defaultOutlineState(),
  workarea: defaultWorkAreaView(),
};

let probeConfirmResolve = null;
let outlineContextRevision = 1;
let surfaceMPGAudioContext = null;
let surfaceMPGAudioResume = null;
let surfaceMPGNextClickTime = 0;
let surfaceMPGFeedbackTimer = null;
const SURFACE_MPG_AUDIO_LOOKAHEAD_S = 0.01;

const gcodeView = {
  key: "",
  fitKey: "",
  canvas: null,
  empty: null,
  renderer: null,
  scene: null,
  camera: null,
  perspCamera: null,
  orthoCamera: null,
  projection: "orthographic",
  cube: null,
  pathGroup: null,
  contextGroup: null,
  contextKey: "",
  contextBounds: null,
  contextVisible: false,
  progressLine: null,
  marker: null,
  live: null,
  followLive: false,
  target: new THREE.Vector3(),
  orbit: { ...gcodeOrbitAnglesForDirection({ x: 1, y: 1, z: 1 }), radius: 120 },
  segments: [],
  cursor: 0,
  has4Axis: false,
  dragging: false,
  timelineDragging: false,
  dragX: 0,
  dragY: 0,
  dragMode: "orbit",
  touchPointers: new Map(),
  pinchDistance: 0,
  panKeyDown: false,
  panKeys: new Set(),
  hovering: false,
  renderQueued: false,
  resizeObserver: null,
  width: 0,
  height: 0,
  pixelRatio: 0,
};

const dashboardGcodeView = {
  key: "",
  canvas: null,
  empty: null,
  renderer: null,
  scene: null,
  camera: null,
  pathGroup: null,
  contextGroup: null,
  progressLine: null,
  marker: null,
  target: new THREE.Vector3(),
  orbit: { ...gcodeOrbitAnglesForDirection({ x: 1, y: 1, z: 1 }), radius: 120 },
  segments: [],
  has4Axis: false,
  renderQueued: false,
  resizeObserver: null,
  width: 0,
  height: 0,
  pixelRatio: 0,
};

const activeGcodeSource = {
  path: "",
  signature: "",
  requestID: 0,
  totalLines: 0,
  pages: new Map(),
  loadingPages: new Set(),
  currentLine: 0,
  userScrollingUntil: 0,
  renderQueued: false,
  resizeObserver: null,
  unavailableSignature: "",
};

const activeGcodeGeometry = {
  signature: "",
  requestedSignature: "",
  requestID: 0,
  total: 0,
  segments: [],
};

const GCODE_KIND_COLORS = {
  rapid: 0x91a0ae,
  cut: 0x57a6d6,
  arc: 0x44c27b,
  probe: 0xd99a3a,
};

const GCODE_FOV = 45;
const GCODE_RENDER_PIXEL_BUDGET = 12_000_000;
const GCODE_ORBIT_DRAG_RAD_PER_PX = 0.008;
const GCODE_ORBIT_MIN_RADIUS = 1;
const GCODE_ORBIT_MAX_RADIUS = 100000;
const GCODE_CUBE_DRAG_THRESHOLD_PX = 4;
const SURFACE_MPG_DETENT_DEG = 15;
const SURFACE_MPG_DEAD_ZONE = 0.24;
// Same axis palette as the Control tab work-area origin marker.
const GCODE_AXIS_COLORS = { x: "#f05b5b", y: "#6fa3ff", z: "#44c27b" };

const SYNC_LABEL = {
  synced: "Synced",
  local_only: "Local only",
  pending_upload: "Queued",
  uploading: "Uploading",
  pending_delete: "Delete queued",
  deleting: "Deleting",
  pending_rename: "Rename queued",
  remote_only: "On machine",
  error: "Error",
};

const HALT_REASON = {
  1: "Halt manually",
  2: "Home fail",
  3: "Probe fail",
  4: "Calibrate fail",
  5: "ATC home fail",
  6: "ATC invalid tool number",
  7: "ATC drop tool fail",
  8: "ATC position occupied",
  9: "Spindle overheated",
  10: "Soft limit triggered",
  11: "Cover opened when playing",
  12: "Wireless probe dead or not set",
  13: "Emergency stop button pressed",
  14: "Power overheated",
  15: "Machine has not been homed",
  21: "Hard limit triggered",
  22: "X axis motor error",
  23: "Y axis motor error",
  24: "Z axis motor error",
  25: "Spindle stall",
  26: "SD card read fail",
  41: "Spindle alarm",
};

function relPath(p) {
  if (!p) return "";
  return p.startsWith(ROOT + "/") ? p.slice(ROOT.length + 1) : p.replace(/^\/+/, "");
}

function basename(p) {
  const r = relPath(p).replace(/\/+$/, "");
  const i = r.lastIndexOf("/");
  return i >= 0 ? r.slice(i + 1) : r;
}

function dirname(p) {
  const r = relPath(p).replace(/\/+$/, "");
  const i = r.lastIndexOf("/");
  return i >= 0 ? r.slice(0, i) : "";
}

function cleanRelPath(p) {
  return String(p || "").replace(/\\/g, "/").split("/").filter(Boolean).join("/");
}

function joinRelPath(dir, name) {
  dir = cleanRelPath(dir);
  name = cleanRelPath(name);
  return dir && name ? dir + "/" + name : (dir || name);
}

function parentRelPath(dir) {
  dir = cleanRelPath(dir);
  const i = dir.lastIndexOf("/");
  return i >= 0 ? dir.slice(0, i) : "";
}

function remotePathFromRel(p) {
  const rel = cleanRelPath(p);
  return rel ? ROOT + "/" + rel : ROOT;
}

function apiFileURL(p) {
  return "/api/files/" + relPath(p).split("/").map(encodeURIComponent).join("/");
}

function fmtSize(n, isDir) {
  if (isDir) return "-";
  if (!Number.isFinite(n)) return "-";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

function fmtTime(s) {
  if (!s || s.startsWith("0001-")) return "-";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString([], { dateStyle: "short", timeStyle: "medium" });
}

function fmtAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  if (ms < 1000) return "now";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return sec + "s";
  const min = Math.round(sec / 60);
  if (min < 60) return min + "m";
  return Math.round(min / 60) + "h";
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const sec = Math.round(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

function fmtCoord(v) {
  return Number.isFinite(v) ? v.toFixed(3) : "-";
}

function fmtPos(p, estimated = false) {
  if (!p) return "-";
  return `X ${fmtCoord(p.x)} Y ${fmtCoord(p.y)} Z ${fmtCoord(p.z)}${estimated ? " est" : ""}`;
}

function fmtActiveFeed(f) {
  const cur = Number(f?.current);
  if (!Number.isFinite(cur)) return "-";
  const value = Math.abs(cur) >= 100 ? Math.round(cur).toString() : cur.toFixed(1);
  return value + " mm/min";
}

function fmtSpindle(s) {
  if (!s) return "-";
  const cur = Number.isFinite(s.current_rpm) ? Math.round(s.current_rpm) : "-";
  const target = Number.isFinite(s.target_rpm) ? Math.round(s.target_rpm) : "-";
  const over = Number.isFinite(s.override) ? Math.round(s.override) + "%" : "-";
  return `${cur}/${target} rpm ${over}`;
}

function fmtDashboardFeed(f) {
  if (!f) return { current: "-", detail: "-" };
  const current = Number(f.current);
  const target = Number(f.target);
  const override = Number(f.override);
  return {
    current: Number.isFinite(current) ? `${Math.round(current)} mm/min` : "-",
    detail: `${Number.isFinite(target) ? "Target " + Math.round(target) : "Target -"} · ${Number.isFinite(override) ? Math.round(override) + "%" : "-"}`,
  };
}

function fmtDashboardSpindle(s) {
  if (!s) return { current: "-", detail: "-" };
  const current = Number(s.current_rpm);
  const target = Number(s.target_rpm);
  const override = Number(s.override);
  return {
    current: Number.isFinite(current) ? `${Math.round(current)} rpm` : "-",
    detail: `${Number.isFinite(target) ? "Target " + Math.round(target) : "Target -"} · ${Number.isFinite(override) ? Math.round(override) + "%" : "-"}`,
  };
}

function fmtTemperature(value, label) {
  const number = Number(value);
  return Number.isFinite(number) ? `${label} ${number.toFixed(1)} °C` : `${label} -`;
}

function fmtActiveTool(t) {
  return Number.isFinite(t?.active) ? toolDisplayName(t.active) : "-";
}

function machineReadoutModel(machine, positions = {}) {
  const wpos = positions.wpos || machine?.wpos || {};
  const mpos = positions.mpos || machine?.mpos || {};
  const feed = fmtDashboardFeed(machine?.feed);
  const spindle = fmtDashboardSpindle(machine?.spindle);
  const offset = Number(machine?.tool?.offset);
  return {
    axes: ["x", "y", "z", "a"].map((axis) => ({
      axis,
      work: fmtCoord(axisValue(wpos, axis)),
      machine: fmtCoord(axisValue(mpos, axis)),
      available: axisValue(wpos, axis) !== null || axisValue(mpos, axis) !== null,
    })),
    metrics: {
      feed,
      spindle,
      tool: {
        current: fmtActiveTool(machine?.tool),
        detail: Number.isFinite(offset) ? `TLO ${offset.toFixed(3)}` : "TLO -",
      },
    },
  };
}

function mountMachineReadouts() {
  const template = document.getElementById("machine-readout-template");
  if (!template?.content) return;
  for (const host of document.querySelectorAll("[data-machine-readout-host]")) {
    if (!host.querySelector(".machine-readout")) host.appendChild(template.content.cloneNode(true));
  }
}

function renderMachineReadouts(machine = state.machine || {}) {
  for (const host of document.querySelectorAll("[data-machine-readout-host]")) {
    const jogHost = !!host.closest("#jog-view");
    const model = machineReadoutModel(machine, jogHost ? currentAxisValues() : { wpos: machine.wpos, mpos: machine.mpos });
    for (const axis of model.axes) {
      const row = host.querySelector(`[data-machine-axis="${axis.axis}"]`);
      if (!row) continue;
      setTextIfChanged(row.querySelector('[data-machine-space="work"]'), axis.work);
      setTextIfChanged(row.querySelector('[data-machine-space="machine"]'), axis.machine);
      row.classList.toggle("is-unavailable", !axis.available);
    }
    for (const [name, metric] of Object.entries(model.metrics)) {
      const row = host.querySelector(`[data-machine-metric="${name}"]`);
      if (!row) continue;
      setTextIfChanged(row.querySelector("[data-machine-primary]"), metric.current);
      setTextIfChanged(row.querySelector("[data-machine-secondary]"), metric.detail);
    }
  }
}

function toolDisplayName(toolID) {
  switch (Number(toolID)) {
  case -1:
    return "Empty";
  case 0:
    return "Probe";
  case 8888:
    return "Laser";
  case 9999:
    return "3D Probe";
  default:
    return Number.isFinite(Number(toolID)) ? "Tool " + Number(toolID) : "-";
  }
}

function validToolID(toolID, allowEmpty = false) {
  if (!Number.isInteger(toolID)) return false;
  if (toolID === -1) return allowEmpty;
  return toolID === 0 || toolID === 8888 || toolID === 9999 || (toolID >= 1 && toolID <= 999);
}

function haltReason(m) {
  if (m?.halt_reason) return m.halt_reason;
  const h = m?.fields?.H;
  const code = Number.parseInt(String(h || "").split(",")[0], 10);
  if (!Number.isFinite(code)) return null;
  return {
    code,
    message: HALT_REASON[code] || "Unknown alarm",
    recovery: code >= 41 ? "power_cycle" : (code >= 21 ? "reset" : "unlock"),
  };
}

function recoveryText(recovery, reason = null) {
  if (reason?.code === 10) {
    return "Soft limit halt. Clear the physical cause, then recover; the proxy sends $X, verifies status, and falls back to M999 if firmware stays in Alarm.";
  }
  switch (recovery) {
  case "unlock":
    return "Clear the cause, unlock, then home before moving.";
  case "reset":
    return "Clear the cause, reset the machine, reconnect, then home.";
  case "power_cycle":
    return "Switch the machine off and on, reconnect, then home.";
  default:
    return "Inspect the cause before moving the machine.";
  }
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function loadCommandHistory() {
  try {
    const values = JSON.parse(localStorage.getItem(GCODE_HISTORY_KEY) || "[]");
    if (Array.isArray(values)) return values.filter((v) => typeof v === "string" && v.trim()).slice(0, 24);
  } catch {
    // Ignore corrupt local UI state.
  }
  return [];
}

function saveCommandHistory() {
  localStorage.setItem(GCODE_HISTORY_KEY, JSON.stringify(state.commandHistory.slice(0, 24)));
}

function rememberCommand(line) {
  line = String(line || "").trim();
  if (!line) return;
  state.commandHistory = [line, ...state.commandHistory.filter((v) => v !== line)].slice(0, 24);
  state.historyIndex = -1;
  saveCommandHistory();
}

function newID(prefix) {
  if (globalThis.crypto && globalThis.crypto.randomUUID) return prefix + "-" + globalThis.crypto.randomUUID();
  return prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

function defaultGamepadSettings() {
  return {
    axes: {
      x: { axis: 0, invert: false, scale: 1 },
      y: { axis: 1, invert: true, scale: 1 },
      z: { axis: 3, invert: true, scale: 1 },
    },
    deadman_button: 0,
    slow_buttons: [4, 5],
    outline_button: 7,
    macro_buttons: [],
  };
}

function defaultSurfaceViewPreferences() {
  return { auto_switch: true, start_view: "jog", method: "directional", motion: "step", step_mm: 1, mpg_axis: "x", mpg_feedback: "confirmed", position_space: "work" };
}

function loadSurfaceViewPreferences() {
  const fallback = defaultSurfaceViewPreferences();
  try {
    const raw = globalThis.localStorage?.getItem(SURFACE_VIEW_PREFERENCES_KEY);
    if (!raw) return fallback;
    const saved = JSON.parse(raw);
    return {
      auto_switch: saved?.auto_switch !== false,
      start_view: ["jog", "active-job", "dashboard"].includes(saved?.start_view) ? saved.start_view : fallback.start_view,
      method: saved?.method === "mpg" ? "mpg" : "directional",
      motion: saved?.motion === "hold" ? "hold" : "step",
      step_mm: [10, 1, 0.1, 0.01].includes(Number(saved?.step_mm)) ? Number(saved.step_mm) : fallback.step_mm,
      mpg_axis: ["x", "y", "z"].includes(saved?.mpg_axis) ? saved.mpg_axis : fallback.mpg_axis,
      mpg_feedback: saved?.mpg_feedback === "detent" ? "detent" : fallback.mpg_feedback,
      position_space: saved?.position_space === "machine" ? "machine" : fallback.position_space,
    };
  } catch {
    return fallback;
  }
}

function saveSurfaceViewPreferences() {
  try {
    globalThis.localStorage?.setItem(SURFACE_VIEW_PREFERENCES_KEY, JSON.stringify(state.surface));
  } catch {
    // Per-device view preferences are optional; a storage restriction must not
    // affect machine control.
  }
}

function isSurfaceKiosk() {
  return typeof window !== "undefined" && window.matchMedia?.("(any-pointer: coarse) and (min-width: 700px)")?.matches === true;
}

function defaultMachineSettings() {
  return {
    work_area: { x_min: -302, x_max: -1, y_min: -212, y_max: -1 },
    origin: { x: 0, y: 0 },
    saved_origins: [],
    feed_min_mm_min: DEFAULT_MACHINE_FEED_MIN_MM_MIN,
    feed_max_mm_min: DEFAULT_MACHINE_FEED_MAX_MM_MIN,
    tap_feed_mm_min: 600,
    safe_z_mm: DEFAULT_SAFE_Z_MM,
    safe_z_disabled: false,
    learned: {},
	learned_profiles: {},
  };
}

function defaultOutlineState() {
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

function defaultWorkAreaView() {
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

function finiteOr(value, fallback) {
  if (value === "" || value === null || typeof value === "undefined") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampNumber(n, min, max) {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function normalizeMachineSettings(machine) {
  const d = defaultMachineSettings();
  machine = machine || {};
  const learned = normalizeMachineLearned(machine.learned);
  const work = machine.work_area || {};
  const hasLearnedWorkArea = Number.isFinite(learned.work_area?.x_min) && Number.isFinite(learned.work_area?.x_max) &&
    Number.isFinite(learned.work_area?.y_min) && Number.isFinite(learned.work_area?.y_max);
  const oldNominalDefault = Number(work.x_min) === -300 && Number(work.x_max) === 0 &&
    Number(work.y_min) === -200 && Number(work.y_max) === 0;
  const oldTravelDefault = Number(work.x_min) === -302 && Number(work.x_max) === 0 &&
    Number(work.y_min) === -212 && Number(work.y_max) === 0;
  if (oldNominalDefault || oldTravelDefault) {
    machine = {
      ...machine,
      work_area: hasLearnedWorkArea ? learned.work_area : d.work_area,
    };
  }
  const normalizedWork = machine.work_area || {};
  const out = {
    work_area: {
      x_min: finiteOr(normalizedWork.x_min, d.work_area.x_min),
      x_max: finiteOr(normalizedWork.x_max, d.work_area.x_max),
      y_min: finiteOr(normalizedWork.y_min, d.work_area.y_min),
      y_max: finiteOr(normalizedWork.y_max, d.work_area.y_max),
    },
    origin: {
      x: finiteOr(machine.origin?.x, d.origin.x),
      y: finiteOr(machine.origin?.y, d.origin.y),
    },
    saved_origins: normalizeSavedOrigins(machine.saved_origins),
    feed_min_mm_min: finiteOr(machine.feed_min_mm_min, d.feed_min_mm_min),
    feed_max_mm_min: finiteOr(machine.feed_max_mm_min, d.feed_max_mm_min),
    tap_feed_mm_min: finiteOr(machine.tap_feed_mm_min, d.tap_feed_mm_min),
    safe_z_mm: finiteOr(machine.safe_z_mm, d.safe_z_mm),
    safe_z_disabled: !!machine.safe_z_disabled,
    learned,
	learned_profiles: Object.fromEntries(Object.entries(machine.learned_profiles || {}).map(([key, profile]) => [key, normalizeMachineLearned(profile)])),
  };
  if (out.work_area.x_min >= out.work_area.x_max) {
    out.work_area.x_min = d.work_area.x_min;
    out.work_area.x_max = d.work_area.x_max;
  }
  if (out.work_area.y_min >= out.work_area.y_max) {
    out.work_area.y_min = d.work_area.y_min;
    out.work_area.y_max = d.work_area.y_max;
  }
  out.feed_min_mm_min = clampNumber(out.feed_min_mm_min, DEFAULT_MACHINE_FEED_MIN_MM_MIN, MAX_MACHINE_FEED_MM_MIN);
  out.feed_max_mm_min = clampNumber(out.feed_max_mm_min, out.feed_min_mm_min, MAX_MACHINE_FEED_MM_MIN);
  const bounds = feedBoundsFor(out);
  out.tap_feed_mm_min = clampNumber(out.tap_feed_mm_min || d.tap_feed_mm_min, bounds.min, bounds.max);
  out.safe_z_mm = safeZForTapMove(out);
  return out;
}

function normalizeMachineLearned(learned) {
  if (!learned || typeof learned !== "object") return {};
  const out = { ...learned };
  out.identity = learned.identity && typeof learned.identity === "object" ? { ...learned.identity } : {};
  const work = learned.work_area && typeof learned.work_area === "object" ? {
    x_min: finiteOr(learned.work_area.x_min, NaN),
    x_max: finiteOr(learned.work_area.x_max, NaN),
    y_min: finiteOr(learned.work_area.y_min, NaN),
    y_max: finiteOr(learned.work_area.y_max, NaN),
  } : null;
  out.work_area = work && Number.isFinite(work.x_min) && Number.isFinite(work.x_max) &&
    Number.isFinite(work.y_min) && Number.isFinite(work.y_max) && work.x_min < work.x_max && work.y_min < work.y_max ? work : {};
  out.feed = learned.feed && typeof learned.feed === "object" ? { ...learned.feed } : {};
  out.soft_endstop = learned.soft_endstop && typeof learned.soft_endstop === "object" ? { ...learned.soft_endstop } : {};
  const anchors = learned.anchors && typeof learned.anchors === "object" ? learned.anchors : {};
  const anchorPoint = (point) => ({ x: finiteOr(point?.x, NaN), y: finiteOr(point?.y, NaN) });
  const anchor1 = anchorPoint(anchors.anchor1);
  const anchor2 = anchorPoint(anchors.anchor2);
  out.anchors = !!anchors.available && Number.isFinite(anchor1.x) && Number.isFinite(anchor1.y) &&
    Number.isFinite(anchor2.x) && Number.isFinite(anchor2.y) ? { available: true, anchor1, anchor2 } : {};
  out.clearance = learned.clearance && typeof learned.clearance === "object" ? { ...learned.clearance } : {};
  out.probe = learned.probe && typeof learned.probe === "object" ? { ...learned.probe } : {};
  out.config = learned.config && typeof learned.config === "object" ? { ...learned.config } : {};
  out.config_numbers = learned.config_numbers && typeof learned.config_numbers === "object" ? { ...learned.config_numbers } : {};
  out.config_bools = learned.config_bools && typeof learned.config_bools === "object" ? { ...learned.config_bools } : {};
  out.diagnostics = learned.diagnostics && typeof learned.diagnostics === "object" ? { ...learned.diagnostics } : {};
  return out;
}

function feedBoundsFor(machine) {
  const d = defaultMachineSettings();
  const configuredMin = clampNumber(finiteOr(machine?.feed_min_mm_min, d.feed_min_mm_min), DEFAULT_MACHINE_FEED_MIN_MM_MIN, MAX_MACHINE_FEED_MM_MIN);
  const configuredMax = clampNumber(finiteOr(machine?.feed_max_mm_min, d.feed_max_mm_min), configuredMin, MAX_MACHINE_FEED_MM_MIN);
  return { min: configuredMin, max: configuredMax, configuredMin, configuredMax };
}

function safeZForTapMove(machine) {
  const safeZ = finiteOr(machine?.safe_z_mm, DEFAULT_SAFE_Z_MM);
  return Math.min(safeZ, safeZCeiling(machine));
}

// The server repeats this policy authoritatively for every proxy-managed safe
// move. Keeping the browser mirror here makes the configured target visible
// before a command is sent, without trusting the browser for enforcement.
function safeZCeiling(machine) {
  const learned = normalizeMachineLearned(machine?.learned);
  const zMin = finiteOr(learned.z_min_mm, NaN);
  const zMax = finiteOr(learned.z_max_mm, NaN);
  const clearance = finiteOr(learned.config_numbers?.["coordinate.clearance_z"], NaN);
  let ceiling = DEFAULT_SAFE_Z_MM;
  if (Number.isFinite(clearance)) ceiling = Math.min(ceiling, clearance);
  if (Number.isFinite(zMin) && Number.isFinite(zMax) && zMax - zMin > 2 * SAFE_Z_LIMIT_MARGIN_MM) {
    ceiling = Math.min(ceiling, zMax - SAFE_Z_LIMIT_MARGIN_MM);
  }
  return ceiling;
}

function normalizeSavedOrigins(origins) {
  if (!Array.isArray(origins)) return [];
  const out = [];
  const seen = new Set();
  for (let i = 0; i < origins.length && out.length < 48; i++) {
    const saved = origins[i] || {};
    const id = String(saved.id || newID("origin"));
    if (seen.has(id)) continue;
    const label = String(saved.label || "").trim().slice(0, 80);
    const x = finiteOr(saved.origin?.x, NaN);
    const y = finiteOr(saved.origin?.y, NaN);
    if (!label || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    seen.add(id);
    out.push({
      id,
      label,
      origin: { x, y },
      created_at: saved.created_at || new Date().toISOString(),
    });
  }
  return out;
}

function normalizeAxisSetting(axis, fallback) {
  axis = axis || {};
  const idx = Number.isInteger(axis.axis) ? axis.axis : fallback.axis;
  const scale = Number.isFinite(axis.scale) && axis.scale > 0 ? axis.scale : fallback.scale;
  return {
    axis: Math.max(0, Math.min(31, idx)),
    invert: Object.prototype.hasOwnProperty.call(axis, "invert") ? !!axis.invert : fallback.invert,
    scale: Math.max(0.05, Math.min(1, scale)),
  };
}

function normalizeButtonList(buttons, fallback) {
  const raw = Array.isArray(buttons) ? buttons : fallback;
  const out = [];
  const seen = new Set();
  for (const btn of raw) {
    const n = Number(btn);
    if (!Number.isInteger(n) || n < 0 || n > 63 || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

function normalizeGamepadSettings(gamepad, macroIDs) {
  const d = defaultGamepadSettings();
  gamepad = gamepad || {};
  const rawBindings = Array.isArray(gamepad.macro_buttons) ? gamepad.macro_buttons : [];
  const bindings = [];
  const seenButtons = new Set();
  for (const binding of rawBindings) {
    const button = Number(binding.button);
    if (!Number.isInteger(button) || button < 0 || button > 63 || seenButtons.has(button)) continue;
    if (!macroIDs.has(binding.macro_id)) continue;
    seenButtons.add(button);
    bindings.push({ id: binding.id || newID("gamepad-macro"), button, macro_id: binding.macro_id });
  }
  bindings.sort((a, b) => a.button - b.button);
  const deadman = Number(gamepad.deadman_button);
  const outlineButton = Number(gamepad.outline_button);
  return {
    axes: {
      x: normalizeAxisSetting(gamepad.axes?.x, d.axes.x),
      y: normalizeAxisSetting(gamepad.axes?.y, d.axes.y),
      z: normalizeAxisSetting(gamepad.axes?.z, d.axes.z),
    },
    deadman_button: Number.isInteger(deadman) && deadman >= 0 && deadman <= 63 ? deadman : d.deadman_button,
    slow_buttons: normalizeButtonList(gamepad.slow_buttons, d.slow_buttons),
    outline_button: Number.isInteger(outlineButton) && outlineButton >= 0 && outlineButton <= 63 ? outlineButton : d.outline_button,
    macro_buttons: bindings,
  };
}

function gamepadLabel(gp) {
  if (!gp) return "";
  const raw = String(gp.id || "").trim();
  const index = Number.isInteger(gp.index) ? gp.index + 1 : 0;
  const suffix = index > 0 ? " #" + index : "";
  if (raw && isXboxGamepadID(raw) && !isGenericGamepadID(raw)) return raw;
  if (isXboxGamepad(gp)) return "Xbox-compatible gamepad" + suffix;
  if (raw && !isGenericGamepadID(raw)) return raw;
  if (gp.mapping === "standard") return "Standard gamepad" + suffix;
  const axes = gp.axes?.length || 0;
  const buttons = gp.buttons?.length || 0;
  if (axes || buttons) return `Gamepad${suffix} (${axes} axes, ${buttons} buttons)`;
  return "Gamepad" + suffix;
}

function isGenericGamepadID(id) {
  const s = String(id || "").trim().toLowerCase();
  return !s || s === "gamepad" || s === "unknown" || s === "standard" || s === "standard gamepad" || s.includes("unknown gamepad");
}

function isXboxGamepad(gp) {
  if (isXboxGamepadID(gp?.id)) return true;
  const axes = gp?.axes?.length || 0;
  const buttons = gp?.buttons?.length || 0;
  return gp?.mapping === "standard" && axes >= 4 && buttons >= 12 && buttons <= 24;
}

function isXboxGamepadID(id) {
  const s = String(id || "").toLowerCase();
  return /\bxbox\b/.test(s) || /\bxinput\b/.test(s) || s.includes("x-input") || s.includes("vendor: 045e") || s.includes("vid_045e");
}

function normalizeUISettings(ui) {
  ui = ui || {};
  const macrosIn = Array.isArray(ui.macros) ? ui.macros : [];
  const slotsIn = Array.isArray(ui.macro_buttons) ? ui.macro_buttons : [];
  const macros = [];
  const macroIDs = new Set();
  for (let i = 0; i < macrosIn.length; i++) {
    const m = macrosIn[i];
    const macro = {
      id: m.id || newID("macro"),
      name: m.name || "Macro " + (i + 1),
      description: m.description || "",
      lines: Array.isArray(m.lines) ? m.lines : String(m.lines || "").split(/\r?\n/),
      color: m.color || "",
      created_at: m.created_at,
      updated_at: m.updated_at,
    };
    if (macroIDs.has(macro.id)) continue;
    macroIDs.add(macro.id);
    macros.push(macro);
  }
  const macroButtons = [];
  const slotIDs = new Set();
  const placedMacros = new Set();
  for (let i = 0; i < slotsIn.length; i++) {
    const s = slotsIn[i];
    const slot = {
      id: s.id || newID("slot"),
      macro_id: s.macro_id,
      region: s.region === "toolbar" ? "toolbar" : "panel",
      order: Number.isFinite(s.order) ? s.order : i,
    };
    if (!macroIDs.has(slot.macro_id) || slotIDs.has(slot.id) || placedMacros.has(slot.macro_id)) continue;
    slotIDs.add(slot.id);
    placedMacros.add(slot.macro_id);
    macroButtons.push(slot);
  }
  return {
    macros,
    macro_buttons: macroButtons,
    log: {
      filter: ui.log?.filter || "all",
      autoscroll: ui.log?.autoscroll !== false,
    },
    gamepad: normalizeGamepadSettings(ui.gamepad, macroIDs),
    machine: normalizeMachineSettings(ui.machine),
    dashboard: normalizeDashboardSettings(ui.dashboard),
  };
}

function defaultDashboardSettings() {
  return {
    profiles: [{
      id: "overview",
      name: "Overview",
      layout: "job-focus",
      density: "comfortable",
      background: "solid",
      panels: DASHBOARD_PANEL_DEFS.map((panel) => panel.id),
      gcode_lines: 9,
    }],
    default_profile_id: "overview",
  };
}

function normalizeDashboardSettings(settings) {
  const defaults = defaultDashboardSettings();
  const knownPanels = new Set(DASHBOARD_PANEL_DEFS.map((panel) => panel.id));
  const profiles = [];
  const seen = new Set();
  for (const candidate of Array.isArray(settings?.profiles) ? settings.profiles : []) {
    const id = String(candidate?.id || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const panels = [];
    const seenPanels = new Set();
    for (const panel of Array.isArray(candidate.panels) ? candidate.panels : []) {
      if (!knownPanels.has(panel) || seenPanels.has(panel)) continue;
      seenPanels.add(panel);
      panels.push(panel);
    }
    const lines = Math.trunc(Number(candidate.gcode_lines));
    profiles.push({
      id,
      name: String(candidate.name || id).trim() || id,
      layout: ["grid", "job-focus", "stacked"].includes(candidate.layout) ? candidate.layout : "job-focus",
      density: candidate.density === "compact" ? "compact" : "comfortable",
      background: candidate.background === "transparent" ? "transparent" : "solid",
      panels: panels.length ? panels : [...defaults.profiles[0].panels],
      gcode_lines: lines >= 3 && lines <= 30 ? lines : defaults.profiles[0].gcode_lines,
    });
  }
  if (!profiles.length) return defaults;
  const requestedDefault = String(settings?.default_profile_id || "").trim();
  return {
    profiles,
    default_profile_id: profiles.some((profile) => profile.id === requestedDefault) ? requestedDefault : profiles[0].id,
  };
}

async function loadUISettings() {
  try {
    const r = await request("/api/ui/settings");
    applyUISettings(await r.json());
    clearConnectivityIssue("ui-settings");
  } catch (e) {
    setConnectivityIssue("ui-settings", "UI settings unavailable: " + e.message);
    applyUISettings(state.ui);
  }
}

function applyAPICapabilities(caps) {
  state.readOnly = !!caps?.read_only;
  document.body.classList.toggle("read-only", state.readOnly);
  for (const id of [
    "command-actions", "ctl-halt", "tab-jog", "tab-control", "tab-files",
    "active-gcode-run", "active-gcode-pause", "paused-job-controls",
    "feed-override-controls", "alarm-actions", "attention-resume", "attention-recover",
  ]) {
    const element = document.getElementById(id);
    if (element) element.hidden = state.readOnly;
  }
  if (state.readOnly && ["jog", "control", "files"].includes(state.activeTab)) {
    showTab("dashboard", "replace");
  }
}

async function loadAPICapabilities() {
  try {
    const r = await request("/api/capabilities");
    applyAPICapabilities(await r.json());
    clearConnectivityIssue("api-capabilities");
  } catch (e) {
    setConnectivityIssue("api-capabilities", "API capabilities unavailable: " + e.message);
  }
}

async function refreshMachineLearnedSettings() {
  try {
    const r = await request("/api/ui/settings");
    const incoming = normalizeMachineSettings((await r.json()).machine);
    const current = normalizeMachineSettings(state.ui.machine);
    const incomingLearnedAt = Date.parse(incoming.learned?.learned_at || "");
    const currentLearnedAt = Date.parse(current.learned?.learned_at || "");
    if (Number.isFinite(currentLearnedAt) && (!Number.isFinite(incomingLearnedAt) || incomingLearnedAt < currentLearnedAt)) return;
    state.ui.machine = {
      ...current,
      learned: incoming.learned,
      learned_profiles: incoming.learned_profiles,
    };
    renderMachineSettings();
    renderJog();
  } catch {
    // The normal connection/status surfaces report outages. A read-only
    // refresh must not replace local action feedback with a duplicate notice.
  }
}

function applyUISettings(ui) {
  state.ui = normalizeUISettings(ui);
  state.dashboardSettingsLoaded = true;
  state.logFilter = state.ui.log.filter || "all";
  document.getElementById("log-filter").value = state.logFilter;
  document.getElementById("log-autoscroll").checked = state.ui.log.autoscroll !== false;
  if (!state.selectedMacroId && state.ui.macros.length) state.selectedMacroId = state.ui.macros[0].id;
  renderMacroButtons();
  renderMacroEditor();
  renderGamepadSettings();
  renderMachineSettings();
  renderJog();
  renderGcodeLog();
  renderWorkArea();
  resolveDashboardProfile();
}

function queueSaveUISettings() {
  clearTimeout(state.settingsSaveTimer);
  state.settingsSaveTimer = setTimeout(saveUISettings, 250);
}

async function saveUISettings(options = {}) {
  clearTimeout(state.settingsSaveTimer);
  state.settingsSaveTimer = null;
  try {
    const r = await request("/api/ui/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state.ui),
    });
    applyUISettings(await r.json());
    if (options.successMessage) setNotice(options.successMessage, "ok", "ui-settings-save");
    else clearNotice("ui-settings-save");
    return true;
  } catch (e) {
    setNotice("Saving UI settings failed: " + e.message, "error", "ui-settings-save");
    return false;
  }
}

function dashboardURLState(locationLike = window.location) {
  const query = new URLSearchParams(String(locationLike?.search || ""));
  const embed = String(query.get("embed") || "").toLowerCase();
  return {
    profile: String(query.get("profile") || "").trim(),
    embed: embed === "1" || embed === "true" || embed === "yes",
  };
}

function dashboardProfileByID(id) {
  return state.ui.dashboard?.profiles?.find((profile) => profile.id === id) || null;
}

function currentDashboardProfile() {
  const settings = normalizeDashboardSettings(state.ui.dashboard);
  const find = (id) => settings.profiles.find((profile) => profile.id === id) || null;
  return find(state.dashboardProfileID) || find(settings.default_profile_id) || settings.profiles[0];
}

function isWideSurfaceOverview() {
  return typeof window !== "undefined" && window.matchMedia?.("(min-width: 1320px)")?.matches === true;
}

function dashboardPanelVisible(panelID, profile, forceSurfaceOverview = isWideSurfaceOverview()) {
  return profile.panels.includes(panelID) || (forceSurfaceOverview && (panelID === "machine" || panelID === "job"));
}

function resolveDashboardProfile() {
  state.ui.dashboard = normalizeDashboardSettings(state.ui.dashboard);
  const requested = state.dashboardRequestedProfileID;
  const fallback = state.ui.dashboard.default_profile_id || state.ui.dashboard.profiles[0]?.id;
  state.dashboardProfileID = dashboardProfileByID(requested) ? requested : fallback;
  renderDashboardProfileControls();
  applyDashboardProfile(currentDashboardProfile());
  renderDashboard();
}

function applyDashboardURLState(locationLike = window.location) {
  const urlState = dashboardURLState(locationLike);
  state.dashboardRequestedProfileID = urlState.profile;
  state.dashboardEmbed = urlState.embed && viewTabFromURL(locationLike) === "dashboard";
  document.body.classList.toggle("dashboard-embed", state.dashboardEmbed);
  if (state.dashboardEmbed) setDashboardControlsOpen(false);
  if (state.dashboardSettingsLoaded || !state.dashboardProfileID) resolveDashboardProfile();
  else applyDashboardProfile(currentDashboardProfile());
}

function syncDashboardProfileURL(profileID, embed = state.dashboardEmbed, mode = "push") {
  const url = new URL(window.location.href);
  url.pathname = "/dashboard";
  url.searchParams.delete("tab");
  if (profileID) url.searchParams.set("profile", profileID);
  else url.searchParams.delete("profile");
  if (embed) url.searchParams.set("embed", "1");
  else url.searchParams.delete("embed");
  url.hash = "";
  const next = url.pathname + url.search;
  const current = window.location.pathname + window.location.search;
  if (mode === "push" && next === current) return;
  window.history[mode === "replace" ? "replaceState" : "pushState"](
    { tab: "dashboard", profile: profileID, embed: !!embed },
    "",
    next,
  );
}

function selectDashboardProfile(profileID, urlMode = "push") {
  const profile = dashboardProfileByID(profileID);
  if (!profile) return false;
  state.dashboardRequestedProfileID = profile.id;
  state.dashboardProfileID = profile.id;
  applyDashboardProfile(profile);
  syncDashboardProfileURL(profile.id, state.dashboardEmbed, urlMode);
  return true;
}

function renderDashboardProfileControls() {
  const select = document.getElementById("dashboard-profile");
  if (!select) return;
  const prior = select.value;
  const fragment = document.createDocumentFragment();
  for (const profile of state.ui.dashboard.profiles) {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = profile.name;
    fragment.appendChild(option);
  }
  select.replaceChildren(fragment);
  select.value = dashboardProfileByID(state.dashboardProfileID) ? state.dashboardProfileID : prior;
}

function applyDashboardProfile(profile) {
  if (!profile) return;
  const grid = document.querySelector(".dashboard-grid");
  if (!grid) return;
  grid.classList.remove(
    "layout-grid",
    "layout-job-focus",
    "layout-stacked",
    "dashboard-density-compact",
    "dashboard-job-focus-split",
    "dashboard-panel-count-1",
    "dashboard-panel-count-2",
    "dashboard-panel-count-3",
    "dashboard-panel-count-4",
  );
  grid.classList.add("layout-" + profile.layout);
  grid.classList.toggle("dashboard-density-compact", profile.density === "compact");
  document.body.classList.toggle("dashboard-background-transparent", profile.background === "transparent");
  const visible = new Set(profile.panels);
  if (isWideSurfaceOverview()) {
    visible.add("machine");
    visible.add("job");
  }
  grid.classList.add(`dashboard-panel-count-${visible.size}`);
  grid.classList.toggle(
    "dashboard-job-focus-split",
    profile.layout === "job-focus" && visible.has("job") && visible.size > 1,
  );
  const order = new Map(profile.panels.map((panel, index) => [panel, index]));
  for (const panel of document.querySelectorAll("[data-dashboard-panel]")) {
    const id = panel.dataset.dashboardPanel;
    panel.hidden = !dashboardPanelVisible(id, profile, isWideSurfaceOverview());
    panel.style.order = String(order.get(id) ?? DASHBOARD_PANEL_DEFS.length);
  }
  const select = document.getElementById("dashboard-profile");
  if (select && select.value !== profile.id) select.value = profile.id;
  if (dashboardGcodeView.renderer) {
    dashboardGcodeView.renderer.setClearColor(0x202832, profile.background === "transparent" ? 0 : 1);
  }
  scheduleDashboardGcodeRender();
}

function dashboardProfileSlug(name, profiles = state.ui.dashboard.profiles) {
  const stem = String(name || "dashboard").toLowerCase().normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "dashboard";
  const used = new Set(profiles.map((profile) => profile.id));
  if (!used.has(stem)) return stem;
  for (let suffix = 2; suffix < 1000; suffix++) {
    const id = `${stem}-${suffix}`;
    if (!used.has(id)) return id;
  }
  return newID("dashboard").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
}

function renderDashboardPanelOrder(panels) {
  const container = document.getElementById("dashboard-panel-order");
  if (!container) return;
  const selected = new Set(panels);
  const ordered = [
    ...panels.map((id) => DASHBOARD_PANEL_DEFS.find((panel) => panel.id === id)).filter(Boolean),
    ...DASHBOARD_PANEL_DEFS.filter((panel) => !selected.has(panel.id)),
  ];
  const fragment = document.createDocumentFragment();
  for (const definition of ordered) {
    const row = document.createElement("div");
    row.className = "dashboard-panel-row";
    row.dataset.dashboardPanelOption = definition.id;
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selected.has(definition.id);
    checkbox.setAttribute("aria-label", `Show ${definition.label}`);
    const label = document.createElement("span");
    label.textContent = definition.label;
    const up = document.createElement("button");
    up.type = "button";
    up.textContent = "↑";
    up.setAttribute("aria-label", `Move ${definition.label} up`);
    up.onclick = () => {
      const previous = row.previousElementSibling;
      if (previous) container.insertBefore(row, previous);
      refreshDashboardPanelOrderButtons();
    };
    const down = document.createElement("button");
    down.type = "button";
    down.textContent = "↓";
    down.setAttribute("aria-label", `Move ${definition.label} down`);
    down.onclick = () => {
      const next = row.nextElementSibling;
      if (next) container.insertBefore(next, row);
      refreshDashboardPanelOrderButtons();
    };
    row.append(checkbox, label, up, down);
    fragment.appendChild(row);
  }
  container.replaceChildren(fragment);
  refreshDashboardPanelOrderButtons();
}

function refreshDashboardPanelOrderButtons() {
  const rows = Array.from(document.querySelectorAll("#dashboard-panel-order .dashboard-panel-row"));
  rows.forEach((row, index) => {
    const buttons = row.querySelectorAll("button");
    if (buttons[0]) buttons[0].disabled = index === 0;
    if (buttons[1]) buttons[1].disabled = index === rows.length - 1;
  });
}

function openDashboardSettings(createNew = false) {
  const profile = currentDashboardProfile();
  state.dashboardDraftProfileID = createNew ? "" : profile.id;
  document.getElementById("dashboard-profile-name").value = createNew ? "" : profile.name;
  document.getElementById("dashboard-layout").value = profile.layout;
  document.getElementById("dashboard-density").value = profile.density;
  document.getElementById("dashboard-background").value = profile.background;
  document.getElementById("dashboard-default").checked = !createNew && profile.id === state.ui.dashboard.default_profile_id;
  document.getElementById("dashboard-gcode-lines-count").value = String(profile.gcode_lines);
  document.getElementById("dashboard-delete").disabled = createNew || state.ui.dashboard.profiles.length <= 1;
  renderDashboardPanelOrder(profile.panels);
  document.getElementById("dashboard-settings-modal")?.showModal();
  document.getElementById("dashboard-profile-name")?.focus();
}

function closeDashboardSettings() {
  document.getElementById("dashboard-settings-modal")?.close();
  state.dashboardDraftProfileID = "";
}

function dashboardProfileFromForm() {
  const nameInput = document.getElementById("dashboard-profile-name");
  const name = String(nameInput?.value || "").trim();
  if (!name) {
    nameInput?.setCustomValidity("Enter a dashboard name.");
    nameInput?.reportValidity();
    return null;
  }
  nameInput.setCustomValidity("");
  const panels = Array.from(document.querySelectorAll("#dashboard-panel-order .dashboard-panel-row"))
    .filter((row) => row.querySelector('input[type="checkbox"]')?.checked)
    .map((row) => row.dataset.dashboardPanelOption);
  if (!panels.length) {
    setNotice("Dashboard layout requires at least one panel.", "error", "dashboard-settings");
    return null;
  }
  const lines = Math.max(3, Math.min(30, Math.trunc(Number(document.getElementById("dashboard-gcode-lines-count")?.value) || 9)));
  return {
    id: state.dashboardDraftProfileID || dashboardProfileSlug(name),
    name,
    layout: document.getElementById("dashboard-layout")?.value || "job-focus",
    density: document.getElementById("dashboard-density")?.value || "comfortable",
    background: document.getElementById("dashboard-background")?.value || "solid",
    panels,
    gcode_lines: lines,
  };
}

async function saveDashboardProfile() {
  const profile = dashboardProfileFromForm();
  if (!profile) return;
  const modal = document.getElementById("dashboard-settings-modal");
  const save = document.getElementById("dashboard-save");
  const previousDashboard = normalizeDashboardSettings(state.ui.dashboard);
  save.disabled = true;
  modal?.setAttribute("aria-busy", "true");
  const profiles = [...state.ui.dashboard.profiles];
  const index = profiles.findIndex((candidate) => candidate.id === profile.id);
  if (index >= 0) profiles[index] = profile;
  else profiles.push(profile);
  state.ui.dashboard.profiles = profiles;
  if (document.getElementById("dashboard-default")?.checked || !dashboardProfileByID(state.ui.dashboard.default_profile_id)) {
    state.ui.dashboard.default_profile_id = profile.id;
  }
  state.dashboardRequestedProfileID = profile.id;
  state.dashboardProfileID = profile.id;
  const saved = await saveUISettings({ successMessage: `Dashboard layout saved: ${profile.name}` });
  save.disabled = false;
  modal?.removeAttribute("aria-busy");
  if (!saved) {
    state.ui.dashboard = previousDashboard;
    resolveDashboardProfile();
    return;
  }
  closeDashboardSettings();
  selectDashboardProfile(profile.id, "push");
}

async function deleteDashboardProfile() {
  const profile = dashboardProfileByID(state.dashboardDraftProfileID);
  if (!profile || state.ui.dashboard.profiles.length <= 1) return;
  if (!confirm(`Delete dashboard layout “${profile.name}”?`)) return;
  const button = document.getElementById("dashboard-delete");
  const modal = document.getElementById("dashboard-settings-modal");
  const previousDashboard = normalizeDashboardSettings(state.ui.dashboard);
  button.disabled = true;
  modal?.setAttribute("aria-busy", "true");
  state.ui.dashboard.profiles = state.ui.dashboard.profiles.filter((candidate) => candidate.id !== profile.id);
  if (state.ui.dashboard.default_profile_id === profile.id) {
    state.ui.dashboard.default_profile_id = state.ui.dashboard.profiles[0].id;
  }
  state.dashboardRequestedProfileID = state.ui.dashboard.default_profile_id;
  state.dashboardProfileID = state.dashboardRequestedProfileID;
  const saved = await saveUISettings({ successMessage: `Dashboard layout deleted: ${profile.name}` });
  button.disabled = false;
  modal?.removeAttribute("aria-busy");
  if (!saved) {
    state.ui.dashboard = previousDashboard;
    resolveDashboardProfile();
    return;
  }
  closeDashboardSettings();
  selectDashboardProfile(state.dashboardProfileID, "replace");
}

async function copyDashboardURL(embed) {
  const profile = currentDashboardProfile();
  const url = new URL(window.location.href);
  url.pathname = "/dashboard";
  url.search = "";
  url.searchParams.set("profile", profile.id);
  if (embed) url.searchParams.set("embed", "1");
  try {
    await navigator.clipboard.writeText(url.href);
    setNotice(embed ? "OBS dashboard URL copied." : "Dashboard URL copied.", "ok", "dashboard-copy");
  } catch (error) {
    setNotice("Copying dashboard URL failed: " + error.message, "error", "dashboard-copy");
  }
}

function macroByID(id) {
  return state.ui.macros.find((m) => m.id === id) || null;
}

function slotForMacro(id) {
  return state.ui.macro_buttons.find((s) => s.macro_id === id) || null;
}

function sortedSlots(region) {
  return state.ui.macro_buttons
    .filter((s) => s.region === region && macroByID(s.macro_id))
    .sort((a, b) => a.order - b.order);
}

function setMacroPlacement(macroID, region) {
  state.ui.macro_buttons = state.ui.macro_buttons.filter((s) => s.macro_id !== macroID);
  if (region === "toolbar" || region === "panel") {
    const order = sortedSlots(region).length;
    state.ui.macro_buttons.push({ id: newID("slot"), macro_id: macroID, region, order });
  }
  normalizeSlotOrder();
}

function normalizeSlotOrder() {
  for (const region of ["toolbar", "panel"]) {
    sortedSlots(region).forEach((slot, i) => { slot.order = i; });
  }
}

function setNotice(text, kind = "info", key = "", opts = {}) {
  if (!text) {
    clearNotice(key);
    return;
  }
  const noticeKey = key || "global";
  const noticeText = String(text);
  const noticeKind = kind || "info";
  const timeoutMs = Object.prototype.hasOwnProperty.call(opts, "timeoutMs")
    ? Number(opts.timeoutMs)
    : noticeTimeoutMs(noticeKind);
  const prev = state.notices.get(noticeKey);
  if (!opts.force && !prev?.removing && prev?.text === noticeText && prev?.kind === noticeKind && prev?.timeoutMs === timeoutMs) return;
  if (prev?.timer) clearTimeout(prev.timer);
  if (prev?.removeTimer) clearTimeout(prev.removeTimer);
  const notice = {
    key: noticeKey,
    text: noticeText,
    kind: noticeKind,
    seq: ++state.noticeSeq,
    timer: null,
    removeTimer: null,
    timeoutMs,
    entering: true,
    removing: false,
  };
  state.notices.set(noticeKey, notice);
  state.noticeKey = noticeKey;
  renderNoticeBar();

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    notice.timer = setTimeout(() => {
      const cur = state.notices.get(noticeKey);
      if (cur?.seq === notice.seq) dismissNotice(noticeKey, notice.seq);
    }, timeoutMs);
  }
}

function noticeTimeoutMs(kind) {
  if (kind === "error") return NOTICE_ERROR_TIMEOUT_MS;
  if (kind === "ok") return NOTICE_OK_TIMEOUT_MS;
  return NOTICE_INFO_TIMEOUT_MS;
}

function statusMessageSignature(text, kind = "") {
  return (kind || "info") + "\n" + String(text || "");
}

function setStatusMessage(key, text, kind = "", opts = {}) {
  if (!text) {
    state.statusMessages.delete(key);
    clearNotice(key);
    return;
  }
  const sig = statusMessageSignature(text, kind);
  const prev = state.statusMessages.get(key);
  const now = performance.now();
  if (!opts.force && prev?.sig === sig && !state.notices.has(key) && now - prev.shownAt < NOTICE_REPEAT_SUPPRESS_MS) return;
  state.statusMessages.set(key, { sig, shownAt: now });
  setNotice(text, kind || "info", key, opts);
}

// Terminal action feedback lifecycle: callers set holder[textProp]/[kindProp]
// on a terminal result, the render path displays it exactly once here, and the
// stored feedback is cleared on that edge. The notice's own timeout removes it
// from view; repeated renders never resurrect stale feedback or evict newer
// notices.
function consumeStatusFeedback(key, holder, textProp, kindProp) {
  const text = holder[textProp];
  if (!text) return;
  const kind = holder[kindProp];
  holder[textProp] = "";
  holder[kindProp] = "";
  setStatusMessage(key, text, kind, { force: true });
}

function clearVisibleNotices() {
  for (const key of [...state.notices.keys()]) dismissNotice(key);
}

function clearNotice(key = "") {
  if (key) {
    dismissNotice(key);
    return;
  }
  clearVisibleNotices();
}

// Bootstrap, polling and event-stream failures often arrive together. Expose
// one durable connection item in the bottom status bar, then clear it only
// once every source has recovered.
function setConnectivityIssue(source, text) {
  state.connectivityIssues.set(source, String(text || "Connection unavailable."));
  const summary = [...state.connectivityIssues.values()][0] || "Connection unavailable.";
  setNotice(summary, "error", "connectivity", { timeoutMs: 0 });
}

function clearConnectivityIssue(source) {
  state.connectivityIssues.delete(source);
  if (state.connectivityIssues.size === 0) {
    clearNotice("connectivity");
    return;
  }
  setNotice([...state.connectivityIssues.values()][0], "error", "connectivity", { timeoutMs: 0 });
}

function noticeItemRects() {
  const list = document.getElementById("notice");
  const rects = new Map();
  if (!list) return rects;
  for (const row of list.children) {
    if (!row.dataset.noticeKey || row.classList.contains("leaving")) continue;
    rects.set(row.dataset.noticeKey, row.getBoundingClientRect().top);
  }
  return rects;
}

function animateNoticeReflow(previousRects) {
  if (!previousRects?.size) return;
  const list = document.getElementById("notice");
  if (!list) return;
  for (const row of list.children) {
    const previousTop = previousRects.get(row.dataset.noticeKey);
    if (!Number.isFinite(previousTop) || typeof row.animate !== "function") continue;
    const delta = previousTop - row.getBoundingClientRect().top;
    if (Math.abs(delta) < 0.5) continue;
    row.animate(
      [{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }],
      { duration: NOTICE_REFLOW_MS, easing: "ease-out" },
    );
  }
}

function dismissNotice(key, seq = 0) {
  const notice = state.notices.get(key);
  if (!notice || (seq && notice.seq !== seq) || notice.removing) return false;
  if (notice.timer) clearTimeout(notice.timer);
  notice.timer = null;
  notice.removing = true;
  notice.entering = false;
  renderNoticeBar();
  notice.removeTimer = setTimeout(() => {
    const current = state.notices.get(key);
    if (current?.seq !== notice.seq || !current.removing) return;
    const previousRects = noticeItemRects();
    state.notices.delete(key);
    if (state.noticeKey === key) state.noticeKey = "";
    renderNoticeBar();
    animateNoticeReflow(previousRects);
  }, NOTICE_EXIT_MS);
  return true;
}

function renderNoticeBar() {
  const bar = document.getElementById("status-bar");
  const list = document.getElementById("notice");
  if (!bar || !list) return;
  const notices = [...state.notices.values()].sort((a, b) => b.seq - a.seq);
  const visible = notices.length > 0;
  bar.hidden = !visible;
  const existing = new Map([...list.children].map((row) => [row.dataset.noticeKey, row]));
  const activeKeys = new Set();
  for (const notice of notices) {
    activeKeys.add(notice.key);
    let row = existing.get(notice.key);
    if (!row) {
      row = document.createElement("div");
      row.dataset.noticeKey = notice.key;
      const dot = document.createElement("span");
      dot.className = "status-dot";
      const text = document.createElement("span");
      text.className = "status-text";
      const dismiss = document.createElement("button");
      dismiss.type = "button";
      dismiss.className = "status-dismiss";
      dismiss.textContent = "Dismiss";
      dismiss.onclick = () => clearNotice(row.dataset.noticeKey);
      row.append(dot, text, dismiss);
    }
    row.className = "status-item " + notice.kind + (notice.entering ? " entering" : "") + (notice.removing ? " leaving" : "");
    const text = row.querySelector(".status-text");
    if (text) text.textContent = notice.text;
    const dismiss = row.querySelector(".status-dismiss");
    if (dismiss) dismiss.setAttribute("aria-label", "Dismiss notification: " + notice.text);
    list.appendChild(row);
    if (notice.entering) {
      row.onanimationend = (event) => {
        if (event.animationName && event.animationName !== "status-item-in") return;
        const current = state.notices.get(notice.key);
        if (current?.seq !== notice.seq || !current.entering) return;
        current.entering = false;
        row.classList.remove("entering");
        row.onanimationend = null;
      };
    }
  }
  for (const [key, row] of existing) {
    if (!activeKeys.has(key)) row.remove();
  }
}

function setHeaderCollapsed(collapsed) {
  const button = document.getElementById("header-toggle");
  document.body.classList.toggle("header-collapsed", !!collapsed);
  if (!button) return;
  const expanded = !collapsed;
  const label = expanded ? "Hide top bars" : "Show top bars";
  button.textContent = expanded ? "▴" : "▾";
  button.setAttribute("aria-expanded", String(expanded));
  button.setAttribute("aria-label", label);
  button.title = label;
  if (collapsed) {
    document.querySelectorAll(".command-popout[open]").forEach((popout) => { popout.open = false; });
  }
}

function setDashboardControlsOpen(open, restoreFocus = false) {
  const button = document.getElementById("dashboard-controls-toggle");
  const panel = document.getElementById("dashboard-toolbar");
  if (!button || !panel) return;
  const expanded = !!open;
  panel.hidden = !expanded;
  button.setAttribute("aria-expanded", String(expanded));
  const label = expanded ? "Hide dashboard layout controls" : "Show dashboard layout controls";
  button.setAttribute("aria-label", label);
  button.title = label;
  if (!expanded && restoreFocus) button.focus();
}

function initDashboardControlsMenu() {
  const button = document.getElementById("dashboard-controls-toggle");
  const panel = document.getElementById("dashboard-toolbar");
  if (!button || !panel) return;
  button.onclick = () => setDashboardControlsOpen(panel.hidden);
  document.addEventListener("click", (event) => {
    if (panel.hidden || button.contains(event.target) || panel.contains(event.target)) return;
    setDashboardControlsOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || panel.hidden) return;
    event.preventDefault();
    setDashboardControlsOpen(false, true);
  });
}

function setWorkAreaActionsOpen(open, restoreFocus = false) {
  const button = document.getElementById("workarea-actions-toggle");
  const panel = document.getElementById("workarea-actions-panel");
  if (!button || !panel) return;
  panel.classList.toggle("is-open", !!open);
  button.setAttribute("aria-expanded", String(!!open));
  if (!open && restoreFocus) button.focus();
}

function initWorkAreaActionsMenu() {
  const button = document.getElementById("workarea-actions-toggle");
  const panel = document.getElementById("workarea-actions-panel");
  const close = panel?.querySelector(".workarea-actions-close");
  if (!button || !panel || !close) return;
  button.onclick = () => setWorkAreaActionsOpen(!panel.classList.contains("is-open"));
  close.onclick = () => setWorkAreaActionsOpen(false, true);
  document.addEventListener("click", (event) => {
    if (!panel.classList.contains("is-open")) return;
    if (button.contains(event.target) || panel.contains(event.target)) return;
    setWorkAreaActionsOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !panel.classList.contains("is-open")) return;
    event.preventDefault();
    setWorkAreaActionsOpen(false, true);
  });
  window.addEventListener("resize", () => {
    if (window.innerWidth > 600) setWorkAreaActionsOpen(false);
  });
}

async function request(url, opts = {}) {
  const resp = await fetch(url, { credentials: "same-origin", cache: "no-store", ...opts });
  if (!resp.ok) {
    let detail = "";
    try {
      const body = await resp.json();
      detail = body.error || JSON.stringify(body);
    } catch {
      detail = await resp.text();
    }
    throw new Error(detail || resp.statusText || "HTTP " + resp.status);
  }
  return resp;
}

function queuePendingCount() {
  let n = 0;
  for (const j of state.jobs.values()) {
    if (j.state === "queued" || j.state === "running") n++;
  }
  return n;
}

function hasLiveJobs() {
  return [...state.jobs.values()].some((j) => j.state === "queued" || j.state === "running");
}

async function refreshJobs() {
  if (!state.filesLoaded || !hasLiveJobs()) return;
  const r = await request("/api/jobs");
  const jobs = await r.json();
  if (!Array.isArray(jobs)) return;
  state.jobs = new Map(jobs.map((j) => [j.id, j]));
  state.machine.pending_jobs = queuePendingCount();
  renderMachine();
  renderFiles();
  renderJobs();
}

function pendingCount() {
  const n = Number(state.machine?.pending_jobs);
  return Number.isFinite(n) ? n : queuePendingCount();
}

function renderMachine() {
  const m = state.machine || {};
  document.getElementById("mode").textContent = m.mode || "owner";
  document.getElementById("age").textContent = fmtAge(m.age_ms);
  document.getElementById("pending").textContent = String(pendingCount());
  const el = document.getElementById("state");
  el.textContent = m.state || "Unknown";
  el.className = "badge state-" + (m.state || "Unknown");
  document.getElementById("status-mpos").textContent = fmtPos(m.mpos, !!m.motion_estimated);
  document.getElementById("status-wpos").textContent = fmtPos(m.wpos, !!m.motion_estimated);
  document.getElementById("status-feed").textContent = fmtActiveFeed(m.feed);
  document.getElementById("status-spindle").textContent = fmtSpindle(m.spindle);
  document.getElementById("status-tool").textContent = fmtActiveTool(m.tool);
  renderToolStatus(m);
  const connection = document.getElementById("status-connection");
  if (connection) {
    const status = m.reconnecting ? "reconnecting" : (m.connected ? "connected" : "outage");
    const label = status === "connected" ? "Connected to machine" :
      (status === "reconnecting" ? "Reconnecting to machine" : "Machine connection outage");
    connection.className = "connection-status " + status;
    connection.setAttribute("aria-label", label);
    connection.title = label;
  }
  renderAlarmPanel(m);
  renderAttention(m);
  renderActiveGcode();
  syncJogAvailabilityFromMachine(m);
  checkOriginVerification();
  renderJog();
  renderOutlineCapture();
}

function renderAttention(m) {
  const machineState = String(m?.state || "Unknown");
  const details = {
    Tool: "Tool change requested. Open Tool actions to confirm the tool and continue only when the physical change is complete.",
    Pause: "The job is paused. Review the job before resuming motion.",
    Wait: "The controller is waiting for an operator decision. Review the active job before resuming.",
    Hold: "Motion is on hold. Make sure the work area is clear before resuming.",
    Alarm: "The machine reported an alarm. Clear the physical cause before attempting recovery.",
  };
  setTextIfChanged(document.getElementById("attention-state"), "Machine state: " + machineState);
  setTextIfChanged(document.getElementById("attention-detail"), details[machineState] || "No operator action is currently requested.");
  const resume = document.getElementById("attention-resume");
  const recover = document.getElementById("attention-recover");
  const tool = document.getElementById("attention-open-tool");
  const resumeAction = attentionResumeAction(machineState);
  if (resume) {
    resume.hidden = state.readOnly || !resumeAction;
    resume.dataset.resumeAction = resumeAction;
    setTextIfChanged(resume, machineState === "Pause" ? "Resume paused job" : "Resume motion");
  }
  if (recover) recover.hidden = state.readOnly || machineState !== "Alarm";
  if (tool) tool.hidden = state.readOnly || machineState !== "Tool";
}

function attentionResumeAction(machineState) {
  if (machineState === "Pause") return "resume_job";
  if (machineState === "Hold") return "resume";
  return "";
}

function renderToolStatus(m) {
  const tool = m.tool || null;
  const active = Number.isFinite(tool?.active) ? toolDisplayName(tool.active) : "-";
  const target = Number.isFinite(tool?.target) ? " -> " + toolDisplayName(tool.target) : "";
  const tlo = Number.isFinite(tool?.offset) ? tool.offset.toFixed(3) : "N/A";
  const wpRaw = String(m.fields?.W || "").split(",")[0];
  const wp = Number.parseFloat(wpRaw);
  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };
  setText("tool-active-status", active + target);
  setText("tool-tlo-status", tlo);
  setText("tool-wp-status", Number.isFinite(wp) ? wp.toFixed(2) + "v" : "-");
  renderToolActions(m);
}

function renderAlarmPanel(m) {
  const panel = document.getElementById("alarm-panel");
  const reason = haltReason(m);
  panel.hidden = m.state !== "Alarm";
  if (panel.hidden) {
    clearNotice("alarm");
    if (state.controlPendingAction !== "recover") {
      state.lastControlResult = null;
      clearNotice("control-recover");
    }
    return;
  }

  const code = reason ? "H:" + reason.code : "H:-";
  const message = reason?.message || "Unknown alarm";
  const recovery = reason?.recovery || "inspect";
  document.getElementById("alarm-title").textContent = `Alarm ${code}: ${message}`;
  document.getElementById("alarm-detail").textContent = recoveryText(recovery, reason);
  const btn = document.getElementById("alarm-recover");
  const pending = state.controlPendingAction === "recover";
  btn.hidden = recovery === "power_cycle";
  btn.disabled = pending || recovery === "inspect";
  btn.textContent = pending ? "Recovering..." : recoveryButtonText(recovery, reason);
  let statusText = "";
  let statusKind = "";
  if (pending) {
    statusText = "Sending recovery command and verifying machine status...";
  } else if (state.lastControlResult?.action === "recover" && state.lastControlResult?.message) {
    statusText = state.lastControlResult.message;
    statusKind = state.lastControlResult.failed ? "error" : "ok";
  } else {
    statusText = recovery === "power_cycle" ? "This halt class cannot be cleared in software." : "";
    statusKind = recovery === "power_cycle" ? "error" : "";
  }
  setStatusMessage("alarm", statusText, statusKind);
}

function recoveryButtonText(recovery, reason = null) {
  if (reason?.code === 10) return "Unlock Soft Limit";
  switch (recovery) {
  case "unlock":
    return "Unlock Alarm";
  case "reset":
    return "Reset Machine";
  default:
    return "Recover";
  }
}

function syncJogAvailabilityFromMachine(m) {
  if (!state.jog.caps?.enabled) return;
  // Movement ownership comes from the jog service, not the shared machine
  // status stream. Keep another UI's ownership visible until the service
  // broadcasts that it has been released.
  if (movementOwnedElsewhere()) return;
  if (state.jog.armed && (m.state === "Idle" || m.state === "Run")) {
    state.jog.availability = { available: true, message: "Jog session active." };
    if (state.jog.errorCode === "status_waiting") {
      state.jog.error = "";
      state.jog.errorCode = "";
    }
    return;
  }
  const stale = !!m.stale || Number(m.age_ms) > 10000;
  let availability;
  if (stale || !m.state || m.state === "Unknown") {
    availability = {
      available: false,
      reason: "stale_status",
      message: "Machine status is stale. Wait for a fresh Idle status before jogging.",
    };
  } else if (m.state !== "Idle") {
    availability = {
      available: false,
      reason: "not_idle",
      message: `Machine is ${m.state}. Jogging requires fresh Idle status.`,
    };
  } else if (!hasMPos(m.mpos)) {
    availability = {
      available: false,
      reason: "stale_status",
      message: "Machine position is unavailable. Wait for a status report with MPos before jogging.",
    };
  } else {
    availability = { available: true, message: "Ready to arm jog." };
  }
  state.jog.availability = availability;
  if (availability.available && isTransientJogBlock(state.jog.errorCode || state.jog.error)) {
    state.jog.error = "";
    state.jog.errorCode = "";
  }
}

function hasMPos(mpos) {
  return !!mpos && ["x", "y", "z"].some((axis) => Number.isFinite(Number(mpos[axis])));
}

function isTransientJogBlock(err) {
  if (!err) return false;
  if (["busy", "not_idle", "stale_status", "controller_waiting", "machine_error"].includes(err)) return true;
  const low = String(err).toLowerCase();
  return low.includes("machine left joggable state") ||
    low.includes("machine is not ready") ||
    low.includes("not idle") ||
    low.includes("status is too stale") ||
    low.includes("controller requested the machine");
}

function movementOwnedElsewhere(j = state.jog) {
  return !j.armed && j.availability?.reason === "busy";
}

function renderJog() {
  const j = state.jog;
  document.getElementById("jog-link").textContent = j.link;
  document.getElementById("jog-pad").textContent = j.pad || "-";
  const dead = document.getElementById("jog-deadman");
  dead.textContent = j.deadman ? "on" : "off";
  dead.className = j.deadman ? "on" : "";
  const msg = jogPanelMessage();
  if (state.activeTab === "control" || state.activeTab === "jog") setStatusMessage("jog-availability", msg.text, msg.kind);
  else clearNotice("jog-availability");
  const arm = document.getElementById("jog-arm");
  setTextIfChanged(arm, movementArmLabel(j));
  arm.classList.toggle("armed", j.armed);
  arm.setAttribute("aria-pressed", j.armed ? "true" : "false");
  const armBusy = !!j.armPending || !!j.armQueuedAction;
  const originBusy = hasPendingOriginOperation();
  const tapOperationBusy = originBusy || !!j.zProbePending;
  arm.disabled = armBusy || tapOperationBusy || !movementArmAvailable();
  const feed = document.getElementById("tap-feed-mm-min");
  const machine = normalizeMachineSettings(state.ui.machine);
  const feedBounds = feedBoundsFor(machine);
  const feedValue = clampNumber(finiteOr(feed?.value, machine.tap_feed_mm_min), feedBounds.min, feedBounds.max);
  if (feed) {
    feed.min = String(Math.round(feedBounds.min));
    feed.max = String(Math.round(feedBounds.max));
    if (!controlLocallyOwned(feed)) feed.value = String(feedValue);
    feed.disabled = tapMoveTargetBusy() || !!j.zStepPending || tapOperationBusy;
  }
  for (const btn of document.querySelectorAll("[data-feed-step]")) {
    const step = Number(btn.dataset.feedStep) || 0;
    btn.disabled = !!feed?.disabled || (step < 0 && feedValue <= feedBounds.min) || (step > 0 && feedValue >= feedBounds.max);
  }
  renderWorkMoveControls(tapOperationBusy);
  renderOriginButtons();
  const zStepDistance = document.getElementById("z-step-distance");
  if (zStepDistance) zStepDistance.disabled = !!j.zStepPending || tapMoveTargetBusy() || tapOperationBusy;
  const zStepReady = !!j.caps?.enabled && j.link === "online" && j.armed && !j.zStepPending && !tapMoveTargetBusy() && !tapOperationBusy;
  const zStepBusy = !!j.zStepPending || tapMoveTargetBusy() || tapOperationBusy;
  for (const btn of document.querySelectorAll("[data-z-step-dir]")) {
    btn.disabled = zStepBusy;
    setSoftDisabled(btn, !zStepBusy && !zStepReady);
  }
  consumeJogAlertFeedback("tap-move", j, "tapFeedback", "tapFeedbackKind");
  const plot = document.getElementById("workarea-plot");
  if (plot) plot.classList.toggle("not-armed", !j.armed);
  renderWorkArea();
  renderSurfaceJog();
}

function surfaceJogBaseReady() {
  return !!state.jog.caps?.enabled && state.jog.link === "online" && state.jog.armed &&
    !tapMoveTargetBusy() && !state.jog.zStepPending && !hasPendingOriginOperation();
}

function surfaceJogReady() {
  return surfaceJogBaseReady() && !state.jog.surfaceStepPending;
}

function movementArmAvailable() {
  const j = state.jog;
  if (j.armed || movementOwnedElsewhere()) return true;
  if (!j.caps?.enabled || j.link !== "online" || !machineReadyForOriginSet()) return false;
  return !j.availability || j.availability.available !== false;
}

function movementArmLabel(j = state.jog) {
  if (j.armPending) return j.armPendingAction === "arm" ? "Arming..." : "Disarming...";
  if (j.armQueuedAction) return "Connecting...";
  if (j.armed) return "Disarm Movement";
  if (movementOwnedElsewhere(j)) return "Disarm other controller";
  return "Arm Movement";
}

function renderSurfaceJog() {
  const surface = state.surface;
  const j = state.jog;
  const ready = surfaceJogBaseReady();
  const surfaceButtonBusy = !!j.surfaceStepPending && j.surfaceStepSource !== "mpg";
  const busy = surfaceButtonBusy || !!j.zStepPending || tapMoveTargetBusy() || hasPendingOriginOperation();
  const arm = document.getElementById("surface-jog-arm");
  if (arm) {
    const armLabel = movementArmLabel(j);
    setTextIfChanged(arm, armLabel);
    arm.classList.toggle("armed", j.armed);
    arm.disabled = !!j.armPending || !!j.armQueuedAction || !movementArmAvailable();
  }
  for (const id of ["surface-jog-motion", "surface-jog-step", "surface-auto-switch", "surface-start-view", "surface-mpg-feedback"]) {
    const el = document.getElementById(id);
    if (!el || el === document.activeElement) continue;
    if (id === "surface-jog-motion") el.value = surface.motion;
    else if (id === "surface-jog-step") el.value = String(surface.step_mm);
    else if (id === "surface-auto-switch") el.checked = surface.auto_switch;
    else if (id === "surface-mpg-feedback") el.value = surface.mpg_feedback;
    else el.value = surface.start_view;
  }
  document.getElementById("surface-directional-panel")?.toggleAttribute("hidden", surface.method !== "directional");
  document.getElementById("surface-mpg-panel")?.toggleAttribute("hidden", surface.method !== "mpg");
  document.getElementById("surface-jog-directional")?.setAttribute("aria-pressed", String(surface.method === "directional"));
  document.getElementById("surface-jog-mpg")?.setAttribute("aria-pressed", String(surface.method === "mpg"));
  renderMachineReadouts(state.machine || {});
  const machineState = String(state.machine?.state || "Unknown");
  setTextIfChanged(document.getElementById("surface-position-state"), machineState === "Idle" ? "Ready to move" : "Machine: " + machineState);
  const detail = state.machine?.connected === false
    ? "Machine connection unavailable"
    : `${fmtActiveTool(state.machine?.tool)} · ${fmtSpindle(state.machine?.spindle)}`;
  setTextIfChanged(document.getElementById("surface-position-detail"), detail);
  renderSurfaceQuickActions(machineState);
  setTextIfChanged(document.getElementById("surface-jog-options-summary"), surfaceJogOptionsSummary(surface));
  for (const button of document.querySelectorAll("[data-surface-step]")) {
    button.setAttribute("aria-pressed", String(Number(button.dataset.surfaceStep) === surfaceStepDistance()));
  }
  for (const button of document.querySelectorAll("[data-surface-motion]")) {
    button.setAttribute("aria-pressed", String(button.dataset.surfaceMotion === surface.motion));
  }
  for (const button of document.querySelectorAll(".surface-mpg-axis")) button.setAttribute("aria-pressed", String(button.dataset.surfaceMpgAxis === surface.mpg_axis));
  for (const button of document.querySelectorAll("[data-surface-axis], [data-surface-z-sign], [data-surface-hold-sign]")) {
    button.disabled = busy;
    setSoftDisabled(button, !busy && !ready);
  }
  renderSurfaceMPGWheel(ready && !surfaceButtonBusy);
}

function renderSurfaceMPGWheel(ready = surfaceJogBaseReady()) {
  const surface = state.surface;
  const j = state.jog;
  const wheel = document.getElementById("surface-mpg-wheel");
  if (wheel) {
    wheel.setAttribute("aria-valuenow", String(j.surfaceWheel.value));
    wheel.setAttribute("aria-valuetext", `${j.surfaceWheel.value} increments on ${surface.mpg_axis.toUpperCase()}`);
    wheel.style.setProperty("--wheel-angle", `${Number(j.surfaceWheel.angle || 0)}deg`);
    const turning = j.surfaceWheel.pointerId !== null;
    wheel.classList.toggle("is-turning", turning);
    wheel.classList.toggle("is-disabled", !ready && !turning);
    wheel.tabIndex = ready || turning ? 0 : -1;
  }
  setTextIfChanged(document.getElementById("surface-mpg-wheel-step"), `${surfaceStepDistance()} mm / click`);
}

function surfaceQuickActionState(machineState) {
  return {
    setup: machineState === "Idle",
    hold: machineState === "Run",
    resume: machineState === "Hold" || machineState === "Pause",
    details: machineState !== "Idle",
  };
}

function renderSurfaceQuickActions(machineState = String(state.machine?.state || "Unknown")) {
  const root = document.getElementById("surface-quick-actions");
  const actions = surfaceQuickActionState(machineState);
  for (const button of document.querySelectorAll("[data-surface-setup]")) button.hidden = !actions.setup;
  const hold = document.getElementById("surface-footer-hold");
  const resume = document.getElementById("surface-footer-resume");
  const details = document.getElementById("surface-footer-job");
  if (hold) hold.hidden = !actions.hold;
  if (resume) {
    resume.hidden = !actions.resume;
    setTextIfChanged(resume, machineState === "Pause" ? "▶ Resume job" : "▶ Resume");
  }
  if (details) details.hidden = !actions.details;
  const vacuum = document.getElementById("surface-footer-vacuum");
  const vacuumValue = dashboardOptionalNumber(state.machine?.spindle?.vacuum_mode);
  const vacuumKnown = vacuumValue !== null;
  const vacuumEnabled = vacuumValue !== null && vacuumValue !== 0;
  if (vacuum) {
    vacuum.disabled = state.autoVacuumPending || state.readOnly || !vacuumKnown;
    vacuum.setAttribute("aria-pressed", String(vacuumEnabled));
    vacuum.setAttribute("aria-busy", String(state.autoVacuumPending));
    vacuum.title = !vacuumKnown ? "Auto Vacuum state is not reported by this machine" : (vacuumEnabled ? "Turn Auto Vacuum off" : "Turn Auto Vacuum on");
    setTextIfChanged(vacuum, state.autoVacuumPending ? "Auto Vacuum…" : (vacuumKnown ? `Auto Vacuum · ${vacuumEnabled ? "On" : "Off"}` : "Auto Vacuum · —"));
  }
  root?.classList.toggle("is-job-state", !actions.setup);
  const labels = {
    Idle: "Machine ready",
    Run: "Job running — setup controls locked",
    Hold: "Motion held",
    Pause: "Job paused",
    Wait: "Operator action required",
    Tool: "Tool change required",
  };
  setTextIfChanged(document.getElementById("surface-footer-state"), labels[machineState] || `Machine: ${machineState}`);
}

async function setAutoVacuum(enabled) {
  const current = dashboardOptionalNumber(state.machine?.spindle?.vacuum_mode);
  if (state.autoVacuumPending || current === null || state.readOnly) return;
  state.autoVacuumPending = true;
  renderSurfaceQuickActions();
  try {
    const response = await request("/api/outputs/auto-vacuum", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !!enabled }),
    });
    const result = await response.json();
    if (state.machine?.spindle) state.machine.spindle.vacuum_mode = result.enabled ? 1 : 0;
    clearNotice("auto-vacuum");
    setTimeout(pollMachine, 1200);
  } catch (e) {
    appendGcodeLine({ seq: "local-" + Date.now(), dir: "recv", source: "api", text: "error: " + e.message });
    setNotice("Auto Vacuum could not be updated: " + e.message, "error", "auto-vacuum");
  } finally {
    state.autoVacuumPending = false;
    renderSurfaceQuickActions();
  }
}

function surfaceJogOptionsSummary(surface = state.surface) {
  const motion = surface.motion === "hold" ? "Hold" : "Step";
  const step = [10, 1, 0.1, 0.01].includes(Number(surface.step_mm)) ? Number(surface.step_mm) : 1;
  const method = surface.method === "mpg" ? "MPG" : "Directional";
  return `${motion} · ${step} mm · ${method}`;
}

function initializeSurfaceMobileOptions(isMobile = window.matchMedia?.("(max-width: 600px)")?.matches === true) {
  const options = document.getElementById("surface-mobile-options");
  if (options) options.open = !isMobile;
}

function selectSurfaceJogMethod(method) {
  state.surface.method = method === "mpg" ? "mpg" : "directional";
  if (window.matchMedia?.("(max-width: 600px)")?.matches) {
    const options = document.getElementById("surface-mobile-options");
    if (options) {
      options.open = false;
      options.querySelector("summary")?.focus();
    }
  }
  saveSurfaceViewPreferences();
  renderSurfaceJog();
}

function selectSurfaceMPGAxis(axis) {
  if (!["x", "y", "z"].includes(axis)) return;
  state.surface.mpg_axis = axis;
  saveSurfaceViewPreferences();
  renderSurfaceJog();
}

function selectSurfaceStep(step) {
  const value = Number(step);
  state.surface.step_mm = [10, 1, 0.1, 0.01].includes(value) ? value : 1;
  const select = document.getElementById("surface-jog-step");
  if (select) select.value = String(state.surface.step_mm);
  saveSurfaceViewPreferences();
  renderSurfaceJog();
}

function selectSurfaceMotion(motion) {
  stopSurfaceHoldJog();
  state.surface.motion = motion === "hold" ? "hold" : "step";
  const select = document.getElementById("surface-jog-motion");
  if (select) select.value = state.surface.motion;
  saveSurfaceViewPreferences();
  renderSurfaceJog();
}

function toggleSurfaceMovementArm() {
  if (movementOwnedElsewhere() && !confirm("Another controller has armed movement. Disarm that session before taking control?")) return false;
  toggleTapMoveArm();
  return true;
}

function surfaceStepDistance() {
  return [10, 1, 0.1, 0.01].includes(Number(state.surface.step_mm)) ? Number(state.surface.step_mm) : 1;
}

function sendSurfaceStep(axis, sign, source = "button") {
  if (state.jog.surfaceStepPending) return false;
  if (!surfaceJogBaseReady()) {
    setStatusMessage("surface-jog", "Arm Movement after a fresh Idle status before jogging.", "error", { force: true });
    return false;
  }
  const distance = surfaceStepDistance() * (sign < 0 ? -1 : 1);
  const seq = sendJog({ type: "step", axis, distance });
  if (!seq) {
    setStatusMessage("surface-jog", "Jog service is not connected.", "error", { force: true });
    connectJog();
    return false;
  }
  state.jog.surfaceStepPending = seq;
  state.jog.surfaceStepSource = source;
  state.jog.zStepLabel = `${axis.toUpperCase()}${distance >= 0 ? "+" : "−"} ${Math.abs(distance)} mm`;
  if (source === "mpg") {
    if (!state.jog.surfaceWheel.gestureSteps) {
      setStatusMessage("surface-jog", `MPG ${axis.toUpperCase()} active...`, "", { timeoutMs: 0, force: true });
    }
    renderSurfaceMPGWheel();
  } else {
    setStatusMessage("surface-jog", "Sending " + state.jog.zStepLabel + "...", "", { timeoutMs: 0, force: true });
    renderJog();
  }
  return true;
}

function beginSurfaceHoldJog(axis, sign) {
  if (!surfaceJogReady()) {
    setStatusMessage("surface-jog", "Arm Movement after a fresh Idle status before jogging.", "error", { force: true });
    return false;
  }
  state.jog.surfaceInput = { axis, sign: sign < 0 ? -1 : 1 };
  state.jog.pad = "Surface";
  state.jog.deadman = true;
  state.jog.axes = { x: axis === "x" ? (sign < 0 ? -1 : 1) : 0, y: axis === "y" ? (sign < 0 ? -1 : 1) : 0, z: axis === "z" ? (sign < 0 ? -1 : 1) : 0 };
  setStatusMessage("surface-jog", "Jogging " + axis.toUpperCase() + "; release to stop.", "", { timeoutMs: 0, force: true });
  sendJogInput({ deadman: true, axes: state.jog.axes }, true);
  renderJog();
  return true;
}

function stopSurfaceHoldJog() {
  if (!state.jog.surfaceInput) return false;
  state.jog.surfaceInput = null;
  state.jog.pad = "";
  state.jog.deadman = false;
  state.jog.axes = { x: 0, y: 0, z: 0 };
  if (state.jog.armed) sendJogInput({ deadman: false, axes: state.jog.axes }, true);
  clearNotice("surface-jog");
  renderJog();
  return true;
}

function setSoftDisabled(el, disabled) {
  if (!el) return;
  if (disabled) el.setAttribute("aria-disabled", "true");
  else el.removeAttribute("aria-disabled");
}

function setTextIfChanged(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

const actionPresses = new WeakMap();
const actionSuppressClicks = new WeakMap();

function bindButtonAction(el, handler) {
  if (!el || el.dataset.actionBound === "true") return;
  el.dataset.actionBound = "true";
  el.addEventListener("pointerdown", (e) => {
    if (typeof e.button === "number" && e.button !== 0) return;
    if (el.disabled) return;
    actionPresses.set(el, { pointerId: e.pointerId, x: e.clientX, y: e.clientY });
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // Pointer capture is best-effort; the click fallback remains in place.
    }
  });
  el.addEventListener("pointerup", (e) => {
    const press = actionPresses.get(el);
    if (!press || press.pointerId !== e.pointerId) return;
    actionPresses.delete(el);
    if (el.disabled) return;
    const dx = Math.abs(e.clientX - press.x);
    const dy = Math.abs(e.clientY - press.y);
    const releaseTarget = document.elementFromPoint(e.clientX, e.clientY);
    if (dx > 12 || dy > 12 || (releaseTarget && !el.contains(releaseTarget))) return;
    actionSuppressClicks.set(el, performance.now());
    e.preventDefault();
    handler(e);
  });
  el.addEventListener("pointercancel", (e) => {
    const press = actionPresses.get(el);
    if (press && press.pointerId === e.pointerId) actionPresses.delete(el);
  });
  el.addEventListener("click", (e) => {
    const last = actionSuppressClicks.get(el) || 0;
    if (performance.now() - last < 700) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (el.disabled) return;
    handler(e);
  });
}

function machineReadyForOriginSet() {
  const m = state.machine || {};
  const age = Number(m.age_ms);
  return !!m.connected && m.state === "Idle" && !m.stale && (!Number.isFinite(age) || age <= 10000);
}

function renderOriginButtons() {
  const j = state.jog;
  const pendingAxis = hasPendingOriginOperation();
  const zProbePending = !!j.zProbePending;
  const probe3DPending = !!j.probe3DPending;
  const jogReady = !!j.caps?.enabled && j.link === "online" && j.armed;
  const externalJogBusy = !j.armed && j.availability && !j.availability.available && j.availability.reason === "busy";
  const apiReady = !j.armed && machineReadyForOriginSet() && !externalJogBusy;
  const ready = (jogReady || apiReady) && !j.armPending && !tapMoveTargetBusy() && !j.zStepPending && !pendingAxis && !zProbePending;
  const busy = !!j.armPending || tapMoveTargetBusy() || !!j.zStepPending || !!pendingAxis || zProbePending;
  const probeReady = apiReady && isProbeToolActive();
  const probe3DReady = apiReady && is3DProbeToolActive();
  for (const btn of document.querySelectorAll("[data-origin-zero]")) {
    btn.disabled = busy;
    setSoftDisabled(btn, !busy && !ready);
  }
  const probe = document.getElementById("origin-probe-z");
  if (probe) {
    probe.disabled = busy;
    setSoftDisabled(probe, !busy && !probeReady);
    setTextIfChanged(probe, zProbePending && !probe3DPending ? "Probing..." : "Probe Z");
  }
  const probe3D = document.getElementById("origin-probe-3d");
  if (probe3D) {
    probe3D.disabled = busy;
    setSoftDisabled(probe3D, !busy && !probe3DReady);
    setTextIfChanged(probe3D, probe3DPending ? "Probing..." : "3D Probe");
  }
  for (const id of ["origin-set-xyz-open", "origin-set-open", "origin-presets-open"]) {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = busy;
  }
  for (const id of ["origin-xyz-x", "origin-xyz-y", "origin-xyz-z", "origin-set-source", "origin-set-x", "origin-set-y"]) {
    const input = document.getElementById(id);
    if (input) input.disabled = busy;
  }
  for (const id of ["origin-xyz-apply", "origin-set-apply"]) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    btn.disabled = busy;
    setSoftDisabled(btn, !busy && !ready);
    setTextIfChanged(btn, pendingAxis ? "Setting..." : (id === "origin-xyz-apply" ? "Set XYZ" : "Set Origin"));
  }
  renderSavedOriginSelect();
  const save = document.getElementById("saved-origin-save");
  const label = document.getElementById("saved-origin-label");
  const currentOrigin = currentWorkOrigin();
  if (label) label.disabled = busy;
  if (save) {
    save.disabled = busy;
    setSoftDisabled(save, !busy && !currentOrigin);
  }
  const del = document.getElementById("saved-origin-delete");
  const selected = selectedSavedOrigin();
  const recall = document.getElementById("saved-origin-recall");
  if (recall) {
    recall.disabled = busy || !selected;
    setSoftDisabled(recall, !busy && !!selected && !ready);
  }
  if (del) {
    del.disabled = busy || !selected;
  }
  renderOriginSetSourceLabels();
}

function setOriginFeedback(text, kind = "") {
  setStatusMessage("origin-action", text, kind, { force: true });
}

function renderOriginSetSourceLabels() {
  const machineCoordinates = document.getElementById("origin-set-source")?.value === "machine";
  const xLabel = document.getElementById("origin-set-x-label");
  const yLabel = document.getElementById("origin-set-y-label");
  if (xLabel) xLabel.textContent = machineCoordinates ? "Machine X" : "X Offset";
  if (yLabel) yLabel.textContent = machineCoordinates ? "Machine Y" : "Y Offset";
  renderOriginSetChange();
}

function hasPendingOriginOperation() {
  return !!state.jog.originPendingAxis || !!state.jog.originPending || !!state.jog.originPendingTargets;
}

function savedOrigins() {
  const machine = state.ui.machine || defaultMachineSettings();
  return Array.isArray(machine.saved_origins) ? machine.saved_origins : [];
}

function selectedSavedOrigin() {
  const id = document.getElementById("saved-origin-select")?.value || "";
  return savedOrigins().find((origin) => origin.id === id) || null;
}

function savedOriginLabel(origin) {
  if (!origin) return "";
  return `${origin.label} (${fmtCoord(origin.origin?.x)}, ${fmtCoord(origin.origin?.y)})`;
}

function renderSavedOriginSelect() {
  const select = document.getElementById("saved-origin-select");
  if (!select) return;
  const origins = savedOrigins();
  const signature = JSON.stringify(origins.map((origin) => [origin.id, savedOriginLabel(origin)]));
  // Rebuild options only when the backing list changed and the operator does
  // not own the control (focused/open); a deferred rebuild happens on the next
  // render after blur.
  if (select.dataset.originsSignature !== signature && !controlLocallyOwned(select)) {
    const previous = select.value;
    select.innerHTML = "";
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = origins.length ? "Select saved zero" : "No saved zeros";
    select.appendChild(empty);
    for (const origin of origins) {
      const option = document.createElement("option");
      option.value = origin.id;
      option.textContent = savedOriginLabel(origin);
      select.appendChild(option);
    }
    if (origins.some((origin) => origin.id === previous)) select.value = previous;
    select.dataset.originsSignature = signature;
  }
  select.disabled = hasPendingOriginOperation();
}

function saveCurrentOrigin() {
  if (hasPendingOriginOperation()) return;
  const origin = currentWorkOrigin();
  if (!origin || axisValue(origin, "x") === null || axisValue(origin, "y") === null) {
    setTapFeedback("Current work zero is unavailable.", "error");
    return;
  }
  const input = document.getElementById("saved-origin-label");
  const label = String(input?.value || "").trim();
  if (!label) {
    setTapFeedback("Enter a label before saving the current zero.", "error");
    return;
  }
  const machine = normalizeMachineSettings(state.ui.machine);
  const saved = {
    id: newID("origin"),
    label: label.slice(0, 80),
    origin: { x: axisValue(origin, "x"), y: axisValue(origin, "y") },
    created_at: new Date().toISOString(),
  };
  state.ui.machine = normalizeMachineSettings({
    ...machine,
    saved_origins: [...savedOrigins(), saved],
  });
  if (input) input.value = "";
  queueSaveUISettings();
  renderMachineSettings();
  renderJog();
  const select = document.getElementById("saved-origin-select");
  if (select) select.value = saved.id;
  setOriginFeedback("Saved origin " + saved.label + ".", "ok");
}

function deleteSelectedOrigin() {
  if (hasPendingOriginOperation()) return;
  const selected = selectedSavedOrigin();
  if (!selected) {
    setTapFeedback("Select a saved zero to delete.", "error");
    return;
  }
  const machine = normalizeMachineSettings(state.ui.machine);
  state.ui.machine = normalizeMachineSettings({
    ...machine,
    saved_origins: savedOrigins().filter((origin) => origin.id !== selected.id),
  });
  queueSaveUISettings();
  renderMachineSettings();
  renderJog();
  setOriginFeedback("Deleted saved origin " + selected.label + ".");
}

function jogPanelMessage() {
  const j = state.jog;
  if (j.error) return { text: jogErrorText(j.error), kind: "error" };
  if (j.link !== "online") return { text: "", kind: "" };
  if (movementOwnedElsewhere(j)) {
    return { text: j.availability.message || jogErrorText("busy"), kind: "" };
  }
  if (!j.armed && j.availability && !j.availability.available) {
    return { text: j.availability.message || jogErrorText(j.availability.reason), kind: "error" };
  }
  return { text: "", kind: "" };
}

function jogErrorText(err) {
  switch (err) {
  case "disabled":
    return "Jogging is disabled.";
  case "busy":
    return "Movement control is held by another UI. Disarm it before taking control.";
  case "not_idle":
    return "Machine is not Idle. Wait for fresh Idle status, then arm jog again.";
  case "stale_status":
    return "Machine status or position is stale. Wait for a fresh status report before jogging.";
  case "status_waiting":
    return "Waiting for fresh machine status before continuing jog.";
  case "controller_waiting":
    return "The controller requested the machine. Jog was disarmed; wait for Idle, then arm again.";
  case "machine_error":
    return "Machine I/O failed. Check the log, wait for reconnect, then arm again.";
  case "bad_input":
    return "Invalid jog input from the browser.";
  default:
    return err || "";
  }
}

const WORKAREA_PAD = 6;
const WORKAREA_VIEW_SIZE = 100;
const WORKAREA_MIN_ZOOM = 1;
const WORKAREA_MAX_ZOOM = 8;
const WORKAREA_ZOOM_STEP = 1.25;
const WORKAREA_PAN_THRESHOLD_PX = 4;
const SPINDLE_DIAMETER_MM = 3.175;
const OUTLINE_POINT_DIAMETER_MM = SPINDLE_DIAMETER_MM + 0.5;
const OUTLINE_FIELD_SPACING_DEBOUNCE_MS = 450;
let outlineFieldSpacingTimer = null;

function renderMachineSettings() {
  const m = state.ui.machine || defaultMachineSettings();
  setInputValue("machine-x-min", m.work_area.x_min);
  setInputValue("machine-x-max", m.work_area.x_max);
  setInputValue("machine-y-min", m.work_area.y_min);
  setInputValue("machine-y-max", m.work_area.y_max);
  setInputValue("machine-origin-x", m.origin.x);
  setInputValue("machine-origin-y", m.origin.y);
  setInputValue("machine-feed-min", m.feed_min_mm_min);
  setInputValue("machine-feed-max", m.feed_max_mm_min);
  setInputValue("tap-feed-mm-min", m.tap_feed_mm_min);
  setInputValue("machine-safe-z", m.safe_z_mm);
  const safeToggle = document.getElementById("tap-safe-z-enabled");
  if (safeToggle && safeToggle !== document.activeElement) safeToggle.checked = !m.safe_z_disabled;
  const learn = document.getElementById("machine-learn");
  if (learn) {
    learn.disabled = state.machineLearnPending;
    learn.setAttribute("aria-busy", state.machineLearnPending ? "true" : "false");
    setTextIfChanged(learn, state.machineLearnPending ? "Learning..." : "Learn from machine");
  }
  renderMachineLearnedSummary(m.learned);
}

function setInputValue(id, value) {
  const el = document.getElementById(id);
  if (controlLocallyOwned(el)) return;
  el.value = Number.isFinite(value) ? String(value) : "";
}

function setControlValueIfIdle(id, value) {
  const el = document.getElementById(id);
  if (controlLocallyOwned(el)) return;
  el.value = value == null ? "" : String(value);
}

function setCheckedIfIdle(id, checked) {
  const el = document.getElementById(id);
  if (controlLocallyOwned(el)) return;
  el.checked = !!checked;
}

function controlLocallyOwned(el) {
  return !el || el === document.activeElement || el.dataset.dirty === "1" || el.dataset.dragging === "1";
}

function markControlDirty(el) {
  if (el) el.dataset.dirty = "1";
}

function clearControlDrafts(...items) {
  for (const item of items.flat()) {
    const el = typeof item === "string" ? document.getElementById(item) : item;
    if (!el) continue;
    delete el.dataset.dirty;
    delete el.dataset.dragging;
    el.setCustomValidity?.("");
  }
}

function bindDirtyDraftControls(ids) {
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener("input", () => markControlDirty(el));
    el.addEventListener("change", () => markControlDirty(el));
  }
}

function renderMachineLearnedSummary(learned) {
  const box = document.getElementById("machine-learned-summary");
  if (!box) return;
  box.innerHTML = "";
  const lines = machineLearnedSummaryLines(learned);
  for (const line of lines) {
    const div = document.createElement("div");
    div.textContent = line;
    box.appendChild(div);
  }
}

function machineLearnedSummaryLines(learned) {
  learned = normalizeMachineLearned(learned);
  const lines = [];
  const id = learned.identity || {};
  const identity = [id.model, id.version, id.file_type].filter(Boolean).join(" / ");
  if (identity) lines.push(identity);
  const area = learned.work_area || {};
  if (Number.isFinite(area.x_min) && Number.isFinite(area.x_max) && Number.isFinite(area.y_min) && Number.isFinite(area.y_max)) {
    lines.push(`travel X ${fmtCoord(area.x_min)}..${fmtCoord(area.x_max)}  Y ${fmtCoord(area.y_min)}..${fmtCoord(area.y_max)}`);
  }
  const zMin = finiteOr(learned.z_min_mm, NaN);
  const zMax = finiteOr(learned.z_max_mm, NaN);
  if (Number.isFinite(zMin) || Number.isFinite(zMax)) lines.push(`Z ${fmtCoord(zMin)}..${fmtCoord(zMax)}`);
  const feed = learned.feed || {};
  const maxXY = finiteOr(feed.max_xy_mm_min, NaN);
  const seek = finiteOr(feed.seek_mm_min, NaN);
  if (Number.isFinite(maxXY)) lines.push(`XY max feed ${Math.round(maxXY)} mm/min`);
  else if (Number.isFinite(seek)) lines.push(`seek feed ${Math.round(seek)} mm/min`);
  const configCount = Object.keys(learned.config || {}).length;
  const diagCount = Object.keys(learned.diagnostics || {}).length;
  const anchors = learned.anchors || {};
  if (anchors.available) {
    lines.push(`Anchor 1 ${fmtCoord(anchors.anchor1?.x)}, ${fmtCoord(anchors.anchor1?.y)}  Anchor 2 ${fmtCoord(anchors.anchor2?.x)}, ${fmtCoord(anchors.anchor2?.y)}`);
  }
  if (configCount || diagCount) lines.push(`${configCount} config values, ${diagCount} diagnostic groups`);
  return lines;
}

async function learnMachineParameters() {
  if (state.machineLearnPending) return;
  if (state.settingsSaveTimer) {
    clearTimeout(state.settingsSaveTimer);
    state.settingsSaveTimer = null;
  }
  state.machineLearnPending = true;
  setStatusMessage("machine-learn", "Learning machine parameters...", "info", { timeoutMs: 0, force: true });
  try {
    renderMachineSettings();
    const r = await request("/api/machine/learn", { method: "POST" });
    const result = await r.json();
    // Clear pending before applying the refreshed settings. A render or
    // normalization failure must never leave this action stranded on
    // "Learning..." after the machine operation has completed.
    state.machineLearnPending = false;
    if (result.ui) applyUISettings(result.ui);
    setStatusMessage("machine-learn", result.message || "Learned machine parameters from firmware.", "ok", { force: true });
    renderMachineSettings();
    renderJog();
  } catch (e) {
    setStatusMessage("machine-learn", "Learning machine parameters failed: " + e.message, "error", { force: true });
    renderMachineSettings();
  } finally {
    state.machineLearnPending = false;
    renderMachineSettings();
  }
}

function openMachineSettings() {
  const dialog = document.getElementById("machine-settings-modal");
  if (!dialog || dialog.open) return;
  renderMachineSettings();
  dialog.showModal();
  refreshMachineLearnedSettings();
}

function closeMachineSettings() {
  document.getElementById("machine-settings-modal")?.close();
}

function updateMachineSettings() {
  const current = state.ui.machine || defaultMachineSettings();
  const read = (id) => {
    const el = document.getElementById(id);
    const raw = String(el?.value ?? "").trim();
    const value = Number(raw);
    const ok = raw !== "" && Number.isFinite(value);
    if (el) el.setCustomValidity(ok ? "" : "Enter a number.");
    return { ok, value };
  };
  const values = {};
  let valid = true;
  for (const id of MACHINE_SETTING_IDS) {
    const result = read(id);
    values[id] = result.value;
    if (!result.ok) valid = false;
  }
  if (!valid) {
    for (const id of MACHINE_SETTING_IDS) {
      const el = document.getElementById(id);
      if (el?.validationMessage) {
        el.reportValidity?.();
        break;
      }
    }
    return;
  }
  state.ui.machine = normalizeMachineSettings({
    work_area: {
      x_min: values["machine-x-min"],
      x_max: values["machine-x-max"],
      y_min: values["machine-y-min"],
      y_max: values["machine-y-max"],
    },
    origin: {
      x: values["machine-origin-x"],
      y: values["machine-origin-y"],
    },
    saved_origins: current.saved_origins || [],
    feed_min_mm_min: values["machine-feed-min"],
    feed_max_mm_min: values["machine-feed-max"],
    tap_feed_mm_min: values["tap-feed-mm-min"],
    safe_z_mm: values["machine-safe-z"],
    safe_z_disabled: !!current.safe_z_disabled,
    learned: current.learned || {},
    learned_profiles: current.learned_profiles || {},
  });
  clearControlDrafts(MACHINE_SETTING_IDS);
  queueSaveUISettings();
  renderMachineSettings();
  renderWorkArea();
}

function stepTapFeed(delta) {
  const input = document.getElementById("tap-feed-mm-min");
  if (!input || input.disabled) return;
  const current = state.ui.machine || defaultMachineSettings();
  const bounds = feedBoundsFor(current);
  const next = clampNumber(finiteOr(input.value, current.tap_feed_mm_min) + delta, bounds.min, bounds.max);
  input.value = String(Math.round(next));
  updateMachineSettings();
  renderJog();
}

function updateSafeZToggle() {
  const current = state.ui.machine || defaultMachineSettings();
  const nextEnabled = !!document.getElementById("tap-safe-z-enabled")?.checked;
  if (!nextEnabled && !confirm("Disable safe Z before click-jog XY moves?")) {
    renderMachineSettings();
    return;
  }
  state.ui.machine = normalizeMachineSettings({
    ...current,
    safe_z_disabled: !nextEnabled,
  });
  state.jog.tapFeedback = nextEnabled ? "Safe Z before click-jog enabled." : "Safe Z before click-jog disabled.";
  state.jog.tapFeedbackKind = nextEnabled ? "ok" : "";
  queueSaveUISettings();
  renderMachineSettings();
  renderJog();
}

function axisValue(values, axis) {
  const n = Number(values?.[axis]);
  return Number.isFinite(n) ? n : null;
}

function currentAxisValues() {
  const preferJog = state.jog.armed || state.jog.originPendingMode === "jog" || !!state.jog.targetPending || !!state.jog.targetMotionPending || !!state.jog.zStepPending;
  return {
    mpos: preferJog ? (state.jog.mpos || state.machine.mpos) : (state.machine.mpos || state.jog.mpos),
    wpos: preferJog ? (state.jog.wpos || state.machine.wpos) : (state.machine.wpos || state.jog.wpos),
  };
}

function tapMoveTargetBusy() {
  return !!state.jog.targetPending || !!state.jog.targetMotionPending;
}

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

function currentWorkOrigin() {
  const { mpos, wpos } = currentAxisValues();
  const out = {};
  let have = false;
  for (const axis of ["x", "y", "z"]) {
    const m = axisValue(mpos, axis);
    const w = axisValue(wpos, axis);
    if (m === null || w === null) continue;
    out[axis] = m - w;
    have = true;
  }
  return have ? out : null;
}

function visualWorkOrigin() {
  const live = currentWorkOrigin();
  if (axisValue(live, "x") !== null && axisValue(live, "y") !== null) return live;
  return state.ui.machine?.origin || defaultMachineSettings().origin;
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

function setWorkAreaToolRadius() {
  const radius = (SPINDLE_DIAMETER_MM / 2) * workAreaMMToSVGUnits();
  for (const id of ["workarea-spindle-marker", "workarea-target-marker"]) {
    const el = document.getElementById(id);
    if (el) el.setAttribute("r", radius.toFixed(3));
  }
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
  if (gcodeView.renderer && syncGcodeContextOverlay() && state.activeTab === "active-job") {
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

function cloneOutlinePoint(p) {
  const out = {
    id: p.id,
    x: p.x,
    y: p.y,
    z: p.z,
    machine_x: p.machine_x,
    machine_y: p.machine_y,
    machine_z: p.machine_z,
    captured_at: p.captured_at,
    probed: !!p.probed,
    probe_output: p.probe_output || "",
  };
  if (p.probe_kind) out.probe_kind = p.probe_kind;
  return out;
}

function cloneOutlineOrigin(origin) {
  if (!origin) return null;
  const out = {};
  for (const axis of ["x", "y", "z"]) {
    const v = axisValue(origin, axis);
    if (v !== null) out[axis] = v;
  }
  return Object.keys(out).length ? out : null;
}

function cloneFloorProbe(probe) {
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

function markGcodeContextOverlayDirty() {
  outlineContextRevision++;
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

function startOutlineCapture() {
  const current = state.outline;
  const keepCurveFit = !!current.curveFit;
  const floorZ = finiteOr(current.floorMachineZ, NaN);
  const floorProbe = cloneFloorProbe(current.floorProbe);
  const pos = currentOutlineCapturePosition();
  cancelOutlineCaptureIntents(current);
  state.outline = defaultOutlineState();
  markGcodeContextOverlayDirty();
  state.outline.active = true;
  state.outline.curveFit = keepCurveFit;
  if (Number.isFinite(floorZ)) {
    state.outline.floorMachineZ = floorZ;
    state.outline.floorProbe = floorProbe;
  }
  state.outline.origin = cloneOutlineOrigin(pos?.origin || currentWorkOrigin());
  if (Number.isFinite(floorZ)) {
    state.outline.origin = state.outline.origin || {};
    state.outline.origin.z = floorZ;
  }
  state.outline.feedback = "Outline capture started.";
  state.outline.feedbackKind = "ok";
  renderOutlineCapture();
  renderWorkArea();
}

function endOutlineCapture() {
  const current = state.outline;
  if (current.points.length && !confirm("End outline capture and clear the captured outline?")) return;
  const keepCurveFit = !!current.curveFit;
  const floorZ = finiteOr(current.floorMachineZ, NaN);
  const floorProbe = cloneFloorProbe(current.floorProbe);
  cancelOutlineCaptureIntents(current);
  state.outline = defaultOutlineState();
  markGcodeContextOverlayDirty();
  state.outline.curveFit = keepCurveFit;
  if (Number.isFinite(floorZ)) {
    state.outline.floorMachineZ = floorZ;
    state.outline.floorProbe = floorProbe;
  }
  state.outline.feedback = "Outline cleared.";
  renderOutlineCapture();
  renderWorkArea();
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

async function waitForOutlineCapturePosition(options = {}) {
  const now = options.now || (() => performance.now());
  const delay = options.delay || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const settleMS = finiteOr(options.settleMS, OUTLINE_CAPTURE_SETTLE_MS);
  const pollMS = finiteOr(options.pollMS, OUTLINE_CAPTURE_POLL_MS);
  const timeoutMS = finiteOr(options.timeoutMS, OUTLINE_CAPTURE_TIMEOUT_MS);
  let requiredRevision = Number.isFinite(Number(options.afterRevision)) ? Number(options.afterRevision) : -1;
  const requireMotionSettlement = Number.isFinite(Number(options.afterMotionRevision)) && Number(options.afterMotionRevision) >= 0;
  let requiredMotionRevision = Number.isFinite(Number(options.afterMotionRevision))
    ? Number(options.afterMotionRevision)
    : (Number(state.jog.motionRevision) || 0);
  let requiredMotionStream = Number.isFinite(Number(options.afterMotionStream))
    ? Number(options.afterMotionStream)
    : (Number(state.jog.motionStreamRevision) || 0);
  const startedAt = now();
  let stablePosition = null;
  let stableSince = null;
  while (now() - startedAt <= timeoutMS) {
    const revision = Number(state.jog.statusRevision) || 0;
    const revisionKnown = !!state.jog.motionRevisionKnown;
    if (revisionKnown) {
      const motionStream = Number(state.jog.motionStreamRevision) || 0;
      if (motionStream !== requiredMotionStream) {
        requiredMotionStream = motionStream;
        requiredMotionRevision = Number(state.jog.motionRevision) || 0;
      } else {
        requiredMotionRevision = Math.max(requiredMotionRevision, Number(state.jog.motionRevision) || 0);
      }
    }
    const machineStillJogging = !!state.jog.armed && state.machine?.state !== "Idle";
    if (outlineCaptureMotionPending() || machineStillJogging) {
      // A position report observed before the predicted queue drained cannot
      // authorize a capture. Require the next report after motion clears.
      if (requiredRevision >= 0) requiredRevision = Math.max(requiredRevision, revision);
      stablePosition = null;
      stableSince = null;
    } else {
      const position = currentOutlineCapturePosition();
      const motionSettled = revisionKnown && Number(state.jog.settledMotionRevision || 0) >= requiredMotionRevision;
      const freshObservedPosition = motionSettled || (!requireMotionSettlement && (requiredRevision < 0 || revision > requiredRevision));
      if (position && freshObservedPosition) {
        // The jog server owns the planner queue and marks the exact motion
        // revision covered by a post-queue Idle position. Capture immediately
        // once that contract is satisfied, including a button press made while
        // the browser was still visually catching up.
        if (motionSettled || (!revisionKnown && requiredRevision >= 0)) return position;
        if (stablePosition && outlineCapturePositionsClose(stablePosition, position)) {
          if (stableSince !== null && now() - stableSince >= settleMS) return position;
        } else {
          stablePosition = position;
          stableSince = now();
        }
      }
    }
    await delay(pollMS);
  }
  throw new Error("motion did not settle before the outline capture timeout");
}

async function processOutlinePointQueue(o) {
  try {
    while (o.addPointQueued > 0) {
      o.addPointQueued--;
      const revisionKnown = !!state.jog.motionRevisionKnown;
      const afterRevision = state.jog.armed && !revisionKnown ? (Number(state.jog.statusRevision) || 0) : -1;
      const afterMotionRevision = revisionKnown ? (Number(state.jog.motionRevision) || 0) : -1;
      const afterMotionStream = Number(state.jog.motionStreamRevision) || 0;
      const pos = await waitForOutlineCapturePosition({ afterRevision, afterMotionRevision, afterMotionStream });
      if (state.outline !== o || !o.active || o.closed) throw new Error("outline capture changed while waiting for motion to settle");
      const capture = {
        id: newID("outline-point"),
        x: pos.work.x,
        y: pos.work.y,
        z: pos.work.z,
        machine_x: pos.machine.x,
        machine_y: pos.machine.y,
        machine_z: pos.machine.z,
        captured_at: new Date().toISOString(),
      };
      pushOutlineUndo();
      o.active = true;
      if (!o.origin) o.origin = cloneOutlineOrigin(pos.origin);
      o.points.push(capture);
      clearFieldProbeData();
      clearNotice("outline-point");
      renderOutlineCapture();
      renderWorkArea();
    }
  } catch (e) {
    o.addPointQueued = 0;
    setStatusMessage("outline-point", "Add point failed: " + e.message, "error", { force: true });
  } finally {
    o.addPointPending = false;
    renderOutlineCapture();
    renderWorkArea();
  }
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

function requestOutlinePositionCapture(o) {
  const capturedAt = new Date().toISOString();
  const seq = sendJog({ type: "capture_position" });
  if (!seq) {
    setStatusMessage("outline-point", "Add point failed: movement connection is unavailable", "error", { force: true });
    return false;
  }
  if (!Array.isArray(state.jog.outlineCaptureIntents)) state.jog.outlineCaptureIntents = [];
  state.jog.outlineCaptureIntents.push({ seq, outline: o, capturedAt, resolved: false, position: null, error: "" });
  // Capture is a server-side stop boundary. Force the next sampled gamepad
  // input onto the wire so motion can resume immediately even if its axes are
  // numerically identical to the sample sent before the capture.
  resetJogInputSender();
  renderOutlineCapture();
  return true;
}

function addOutlinePoint() {
  const o = state.outline;
  if (!o.active) {
    setOutlineFeedback("Capture outline before adding points.", "error");
    return;
  }
  if (o.closed) {
    setOutlineFeedback("Undo close before adding another point.", "error");
    return;
  }
  if (o.fieldProbePending) return;
  if (state.jog.armed) {
    o.feedback = "";
    o.feedbackKind = "";
    requestOutlinePositionCapture(o);
    return;
  }
  o.addPointQueued = Math.min(32, (Number(o.addPointQueued) || 0) + 1);
  if (o.addPointPending) return;
  o.addPointPending = true;
  o.feedback = "";
  o.feedbackKind = "";
  renderOutlineCapture();
  processOutlinePointQueue(o);
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

function setOutlineFeedback(text, kind = "") {
  state.outline.feedback = text;
  state.outline.feedbackKind = kind;
  renderOutlineCapture();
}

function confirmProbeAction({ title, message, warning = "", confirmLabel = "Probe" }) {
  const dialog = document.getElementById("probe-confirm-modal");
  if (!dialog || dialog.open || probeConfirmResolve) return Promise.resolve(false);
  document.getElementById("probe-confirm-title").textContent = title;
  document.getElementById("probe-confirm-message").textContent = message;
  const warningEl = document.getElementById("probe-confirm-warning");
  warningEl.textContent = warning;
  warningEl.hidden = !warning;
  document.getElementById("probe-confirm-accept").textContent = confirmLabel;
  return new Promise((resolve) => {
    probeConfirmResolve = resolve;
    dialog.showModal();
    document.getElementById("probe-confirm-accept").focus();
  });
}

function settleProbeConfirmation(accepted) {
  const resolve = probeConfirmResolve;
  probeConfirmResolve = null;
  document.getElementById("probe-confirm-modal")?.close();
  if (resolve) resolve(!!accepted);
}

function outlinePointLabel(p) {
  return "X " + fmtCoord(p.x) + " Y " + fmtCoord(p.y) + " Z " + fmtCoord(p.z);
}

function isProbeToolActive() {
  return Number(state.machine?.tool?.active) === 0;
}

function is3DProbeToolActive() {
  return Number(state.machine?.tool?.active) === 9999;
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

function renderOutlineCapture() {
  const o = state.outline;
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
  const capturePending = outlineCaptureIntentCount(o) > 0;
  const actionBusy = !!o.addPointPending || !!o.floorProbePending || !!o.fieldProbePending || !!o.fieldProbePointMovePending || !!o.tracePending || !!o.filePending || !!state.jog.zProbePending;
  const busy = capturePending || actionBusy;
  const probeActive = isProbeToolActive();
  const fieldReady = o.active && o.closed && o.points.length >= 3;
  if (panel) panel.hidden = !o.active;
  if (start) {
    start.hidden = !!o.active;
    start.disabled = busy;
    setSoftDisabled(start, false);
  }
  if (activeControls) activeControls.hidden = !o.active;
  if (load) {
    load.disabled = busy;
    setSoftDisabled(load, false);
    setTextIfChanged(load, o.filePending ? "Loading..." : "Load outline");
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
    add.setAttribute("aria-busy", capturePending || o.addPointPending ? "true" : "false");
    setSoftDisabled(add, !actionBusy && !!o.closed);
    setTextIfChanged(add, "Add point");
  }
  if (undo) undo.disabled = busy || !o.undo.length;
  if (redo) redo.disabled = busy || !o.redo.length;
  if (close) {
    close.disabled = busy;
    setSoftDisabled(close, !busy && (!o.active || o.closed || o.points.length < 2));
  }
  if (trace) {
    trace.hidden = !probeActive;
    trace.disabled = busy;
    setTextIfChanged(trace, o.tracePending ? "Tracing..." : "Trace outline");
    setSoftDisabled(trace, !busy && (!o.active || o.points.length < 2 || state.jog.armed || tapMoveTargetBusy()));
  }
  if (curve) {
    curve.checked = !!o.curveFit;
    curve.disabled = busy || o.points.length < 2;
  }
  if (probeFloor) {
    probeFloor.disabled = busy;
    setSoftDisabled(probeFloor, !busy && (!probeActive || state.jog.armed || !machineReadyForOriginSet()));
    setTextIfChanged(probeFloor, o.floorProbePending ? "Probing Floor..." : "Probe Floor");
  }
  if (exp) {
    exp.disabled = busy;
    setSoftDisabled(exp, !busy && o.points.length < 2);
  }
  if (save) {
    save.disabled = busy;
    setSoftDisabled(save, !busy && o.points.length < 2);
  }
  if (spacing) {
    if (!controlLocallyOwned(spacing)) spacing.value = pathNum(fieldProbeSpotGap());
    spacing.disabled = busy;
  }
  if (fieldProbe) {
    setTextIfChanged(fieldProbe, o.fieldProbePending ? "Probing " + Math.min(o.fieldProbeIndex + 1, o.fieldProbePreview.length) + "/" + o.fieldProbePreview.length : "Probe Field Z");
    fieldProbe.disabled = busy;
    setSoftDisabled(fieldProbe, !busy && (!fieldReady || !probeActive || state.jog.armed || !o.fieldProbePreview.length || !!o.fieldProbeTooDense));
  }
  if (resetProbe) {
    const selected = selectedFieldProbePoint(o);
    const hasResult = !!selectedFieldProbeResult(o);
    resetProbe.disabled = busy;
    setSoftDisabled(resetProbe, !busy && !hasResult);
    resetProbe.title = selected
      ? (hasResult ? "Reset the selected point's probe value" : "The selected point has no probe value")
      : "Select a field probe point first";
  }
  if (moveProbe) {
    const selected = selectedFieldProbePoint(o);
    const moving = !!state.jog.fieldProbeMovePending;
    moveProbe.disabled = busy || moving || tapMoveTargetBusy();
    setSoftDisabled(moveProbe, !moveProbe.disabled && (!selected || !state.jog.armed || state.jog.link !== "online"));
    setTextIfChanged(moveProbe, moving ? "Moving..." : "Move to point");
    moveProbe.title = selected ? "Move the spindle to the selected point using the Safe Z setting" : "Select a field probe point first";
  }
  if (exportControls) exportControls.hidden = !o.fieldProbeResults.length;
  if (exportObj) {
    exportObj.disabled = busy;
    setSoftDisabled(exportObj, !busy && o.fieldProbeResults.length < 3);
  }
  if (exportHeight) {
    exportHeight.disabled = busy;
    setSoftDisabled(exportHeight, !busy && o.fieldProbeResults.length < 3);
  }
  if (summary) summary.textContent = outlineSummaryText();
  consumeStatusFeedback("outline", o, "feedback", "feedbackKind");
}

function toggleOutlineCurveFit() {
  state.outline.curveFit = !!document.getElementById("outline-curve-fit")?.checked;
  clearFieldProbeData();
  updateFieldProbePreview();
  renderOutlineCapture();
  renderWorkArea();
}

function commitOutlineFieldSpacingDraft() {
  const input = document.getElementById("outline-field-spacing");
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
  state.outline.fieldSpotGapMM = Math.max(0, Math.min(250, value));
  return true;
}

function cancelOutlineFieldSpacingUpdate() {
  if (outlineFieldSpacingTimer === null) return;
  clearTimeout(outlineFieldSpacingTimer);
  outlineFieldSpacingTimer = null;
}

function flushOutlineFieldSpacingUpdate(render = true) {
  cancelOutlineFieldSpacingUpdate();
  if (!commitOutlineFieldSpacingDraft()) return false;
  const input = document.getElementById("outline-field-spacing");
  clearControlDrafts(input);
  clearFieldProbeData(true);
  updateFieldProbePreview();
  if (state.outline.fieldProbeIssue) {
    setStatusMessage("outline-plan", state.outline.fieldProbeIssue + ".", "error", { force: true });
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
  outlineFieldSpacingTimer = setTimeout(() => {
    outlineFieldSpacingTimer = null;
    flushOutlineFieldSpacingUpdate();
  }, OUTLINE_FIELD_SPACING_DEBOUNCE_MS);
  return true;
}

function fieldProbeSpotGap() {
  const v = Number(state.outline.fieldSpotGapMM);
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

function effectiveOutlineGeometry(points, closed, curveFit) {
  const source = (points || [])
    .map((p) => ({ x: Number(p.x), y: Number(p.y) }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  const out = [];
  let limited = false;
  const addPoint = (p) => {
    if (limited) return;
    const last = out[out.length - 1];
    if (last && Math.hypot(last.x - p.x, last.y - p.y) <= 0.00005) return;
    if (out.length >= MAX_EFFECTIVE_OUTLINE_POINTS) {
      limited = true;
      return;
    }
    out.push({ x: Number(p.x.toFixed(4)), y: Number(p.y.toFixed(4)) });
  };
  if (!source.length) return { points: [], limited: false };
  if (!curveFit || source.length < 3) {
    for (const p of source) addPoint(p);
    if (closed && source.length > 1) addPoint(source[0]);
    return { points: out, limited };
  }
  addPoint(source[0]);
  if (closed) {
    for (let i = 0; i < source.length && !limited; i++) {
      flattenCurveSegment(
        source[(i - 1 + source.length) % source.length],
        source[i],
        source[(i + 1) % source.length],
        source[(i + 2) % source.length],
        addPoint,
      );
    }
    addPoint(source[0]);
  } else {
    for (let i = 0; i < source.length - 1 && !limited; i++) {
      const p0 = i === 0 ? source[i] : source[i - 1];
      const p1 = source[i];
      const p2 = source[i + 1];
      const p3 = i + 2 < source.length ? source[i + 2] : p2;
      flattenCurveSegment(p0, p1, p2, p3, addPoint);
    }
  }
  return { points: out, limited };
}

function flattenCurveSegment(p0, p1, p2, p3, addPoint) {
  const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
  const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
  flattenCubic(p1, c1, c2, p2, addPoint, 0);
}

function flattenCubic(p0, c1, c2, p3, addPoint, depth) {
  if (depth >= 12 || cubicFlatEnough(p0, c1, c2, p3)) {
    addPoint(p3);
    return;
  }
  const a = midpoint(p0, c1);
  const b = midpoint(c1, c2);
  const c = midpoint(c2, p3);
  const d = midpoint(a, b);
  const e = midpoint(b, c);
  const m = midpoint(d, e);
  flattenCubic(p0, a, d, m, addPoint, depth + 1);
  flattenCubic(m, e, c, p3, addPoint, depth + 1);
}

function cubicFlatEnough(p0, c1, c2, p3) {
  return distancePointToSegment(c1, p0, p3) <= OUTLINE_CURVE_TOLERANCE_MM &&
    distancePointToSegment(c2, p0, p3) <= OUTLINE_CURVE_TOLERANCE_MM;
}

function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

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
  const o = state.outline;
  const origin = cloneOutlineOrigin(o.origin || currentWorkOrigin() || visualWorkOrigin());
  const display = displayedFieldProbePoints(o);
  const r = workAreaMMRadius(PROBE_SPOT_RADIUS_MM);
  const points = display.map((p) => ({ src: p, plot: machineToWorkAreaPoint(workPointToMachinePoint(p, origin)) }))
    .filter((p) => p.plot);
  if (!points.length || !o.active || !o.closed) {
    group.setAttribute("display", "none");
    group.innerHTML = "";
    return;
  }
  group.innerHTML = points.map((p, i) => {
    const done = o.fieldProbeResults.some((result) => fieldProbePlanPointMatchesResult(p.src, result));
    const selected = p.src.id === o.fieldProbeSelectedID;
    const label = "Field probe point " + (i + 1) + ", X " + fmtCoord(p.src.x) + ", Y " + fmtCoord(p.src.y) + ", " + (done ? "probed" : "not probed") + (selected ? "; use arrow keys to move" : "");
    return `<circle class="${[p.src.probe_kind === "outline" || p.src.probe_kind === "border" ? "boundary" : "", p.src.probe_kind === "outline" ? "outline" : "", done ? "done" : "", selected ? "selected" : "", o.fieldProbePending && i === o.fieldProbeIndex ? "current" : ""].filter(Boolean).join(" ")}" data-field-probe-id="${escapeHtml(p.src.id)}" role="button" tabindex="0" aria-label="${escapeHtml(label)}" aria-pressed="${selected ? "true" : "false"}" cx="${p.plot.x.toFixed(2)}" cy="${p.plot.y.toFixed(2)}" r="${r.toFixed(2)}"></circle>`;
  }).join("");
  group.removeAttribute("display");
}

function displayedFieldProbePoints(outline) {
  return outline?.fieldProbePreview?.length ? outline.fieldProbePreview : (outline?.fieldProbeResults || []);
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

function selectFieldProbePoint(id) {
  const o = state.outline;
  const point = (o.fieldProbePreview || []).find((candidate) => candidate.id === id);
  if (!point) return false;
  o.fieldProbeSelectedID = point.id;
  renderOutlineCapture();
  renderWorkArea();
  return true;
}

async function resetSelectedFieldProbeValue() {
  const o = state.outline;
  const point = selectedFieldProbePoint(o);
  const result = selectedFieldProbeResult(o);
  if (!point || !result || o.fieldProbePending) return;
  const index = o.fieldProbePreview.indexOf(point);
  if (!await confirmProbeAction({
    title: "Reset Probe Value",
    message: "Reset the Z sample for field point " + (index + 1) + " at X " + fmtCoord(point.x) + " Y " + fmtCoord(point.y) + "?",
    confirmLabel: "Reset Value",
  })) return;
  o.fieldProbeResults = o.fieldProbeResults.filter((sample) => !fieldProbePlanPointMatchesResult(point, sample));
  o.fieldProbeComplete = false;
  markGcodeContextOverlayDirty();
  setOutlineFeedback("Probe value reset for field point " + (index + 1) + ".", "ok");
  renderWorkArea();
}

function moveToSelectedFieldProbePoint() {
  const o = state.outline;
  const point = selectedFieldProbePoint(o);
  if (!point) {
    setTapFeedback("Select a field probe point before moving.", "error");
    return;
  }
  if (state.jog.link !== "online") {
    setTapFeedback("Jog service is not connected.", "error");
    connectJog();
    return;
  }
  if (!state.jog.armed) {
    setTapFeedback("Arm Movement before moving to a field probe point.", "error");
    return;
  }
  if (tapMoveTargetBusy() || state.jog.zStepPending || hasPendingOriginOperation()) return;
  let feed;
  try {
    feed = currentTapFeed();
  } catch (e) {
    setTapFeedback(e.message, "error");
    return;
  }
  const origin = cloneOutlineOrigin(o.origin || currentWorkOrigin());
  const target = workPointToMachinePoint(point, origin);
  if (![target?.x, target?.y].every(Number.isFinite)) {
    setTapFeedback("Selected field probe point does not have a valid machine position.", "error");
    return;
  }
  const machine = normalizeMachineSettings(state.ui.machine);
  const index = o.fieldProbePreview.indexOf(point);
  const label = "field point " + (index + 1) + " (X " + fmtCoord(point.x) + " Y " + fmtCoord(point.y) + ")";
  const seq = sendJog({
    type: "target",
    target: { x: target.x, y: target.y },
    feed_mm_min: feed,
    safe_z_enabled: !machine.safe_z_disabled,
    safe_z_mm: safeZForTapMove(machine),
  });
  if (!seq) {
    setTapFeedback("Jog service is not connected.", "error");
    return;
  }
  const base = state.jog.target || state.jog.observed || state.jog.mpos || state.machine.mpos || {};
  state.jog.target = { ...base, x: target.x, y: target.y };
  state.jog.targetPending = seq;
  state.jog.targetMotionPending = seq;
  state.jog.fieldProbeMovePending = seq;
  state.jog.targetLabel = label;
  state.jog.tapFeedback = "Sending move to " + label + "...";
  state.jog.tapFeedbackKind = "";
  renderJog();
  renderOutlineCapture();
}

function fieldProbeMoveCandidate(local) {
  const machinePoint = workAreaToMachinePoint(workAreaLocalToContentPoint(local));
  const origin = cloneOutlineOrigin(state.outline.origin || currentWorkOrigin());
  const ox = axisValue(origin, "x");
  const oy = axisValue(origin, "y");
  if (!machinePoint || ox === null || oy === null) return null;
  const candidate = { x: machinePoint.x - ox, y: machinePoint.y - oy };
  const polygon = normalizedClosedPolygon(outlineWorkPoints());
  return polygon.length >= 3 && pointInPolygonOrBoundary(candidate, polygon) ? candidate : null;
}

function updateSelectedFieldProbeDrag(local) {
  const o = state.outline;
  const point = selectedFieldProbePoint(o);
  const candidate = fieldProbeMoveCandidate(local);
  if (!point || point.id !== state.workarea.probeDragID || !candidate) return false;
  point.x = candidate.x;
  point.y = candidate.y;
  o.fieldProbeComplete = false;
  renderWorkArea();
  return true;
}

function restoreSelectedFieldProbePosition(original) {
  const point = selectedFieldProbePoint();
  if (!point || !original) return;
  point.x = original.x;
  point.y = original.y;
  state.outline.fieldProbeComplete = !!original.fieldProbeComplete;
}

async function finishSelectedFieldProbeMove(original) {
  const o = state.outline;
  const point = selectedFieldProbePoint(o);
  if (!point || !original) return;
  if (Math.hypot(Number(point.x) - Number(original.x), Number(point.y) - Number(original.y)) <= 1e-7) return;
  const index = o.fieldProbePreview.indexOf(point);
  const previousResult = o.fieldProbeResults.find((sample) => fieldProbePlanPointMatchesResult(original, sample)) || null;
  if (!previousResult) {
    o.fieldProbeComplete = false;
    markGcodeContextOverlayDirty();
    setOutlineFeedback("Field point " + (index + 1) + " moved.", "ok");
    renderWorkArea();
    return;
  }
  o.fieldProbePointMovePending = true;
  renderOutlineCapture();
  const accepted = await confirmProbeAction({
    title: "Move Probed Point",
    message: "Keep field point " + (index + 1) + " at X " + fmtCoord(point.x) + " Y " + fmtCoord(point.y) + "?",
    warning: "This point already has a Z sample. Keeping the new position will reset that probe value.",
    confirmLabel: "Move and Reset",
  });
  if (accepted) {
    o.fieldProbeResults = o.fieldProbeResults.filter((sample) => !fieldProbePlanPointMatchesResult(original, sample));
    o.fieldProbeComplete = false;
    markGcodeContextOverlayDirty();
    o.feedback = "Field point " + (index + 1) + " moved and its probe value was reset.";
    o.feedbackKind = "ok";
  } else {
    restoreSelectedFieldProbePosition(original);
    o.feedback = "Field point move canceled; its probe value was kept.";
    o.feedbackKind = "";
  }
  o.fieldProbePointMovePending = false;
  renderOutlineCapture();
  renderWorkArea();
}

function moveSelectedFieldProbePointBy(dx, dy) {
  const o = state.outline;
  const point = selectedFieldProbePoint(o);
  if (!point || o.fieldProbePointMovePending || o.fieldProbePending) return;
  const original = { id: point.id, x: point.x, y: point.y, fieldProbeComplete: !!o.fieldProbeComplete };
  const candidate = { x: Number(point.x) + Number(dx), y: Number(point.y) + Number(dy) };
  const polygon = normalizedClosedPolygon(outlineWorkPoints());
  if (polygon.length < 3 || !pointInPolygonOrBoundary(candidate, polygon)) {
    setOutlineFeedback("Field point must remain inside the captured outline.", "error");
    return;
  }
  point.x = candidate.x;
  point.y = candidate.y;
  o.fieldProbeComplete = false;
  renderWorkArea();
  finishSelectedFieldProbeMove(original);
}

function unprobedFieldProbePoints(plan, results) {
  const samples = Array.isArray(results) ? results : [];
  return (Array.isArray(plan) ? plan : [])
    .map((point, index) => ({ point, index }))
    .filter(({ point }) => !samples.some((sample) => fieldProbePlanPointMatchesResult(point, sample)));
}

function outlineEditingMarkersVisible(outline, probes) {
  return !outline?.closed || !(probes || []).length;
}

function workAreaMMRadius(mm) {
  const b = workAreaBounds();
  const r = workAreaRect();
  const sx = r.width / Math.max(1e-9, b.x_max - b.x_min);
  const sy = r.height / Math.max(1e-9, b.y_max - b.y_min);
  return Math.max(0.45, Number(mm) * Math.min(sx, sy));
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

function updateFieldProbePreview() {
  const o = state.outline;
  markGcodeContextOverlayDirty();
  if (!o.closed || o.points.length < 3) {
    o.fieldProbePreview = [];
    o.fieldProbeSelectedID = "";
    o.fieldProbeTooDense = false;
    o.fieldProbeIssue = "";
    return;
  }
  const geometry = effectiveOutlineGeometry(outlineWorkPoints(), o.closed, o.curveFit);
  if (geometry.limited) {
    o.fieldProbePreview = [];
    o.fieldProbeSelectedID = "";
    o.fieldProbeTooDense = true;
    o.fieldProbeIssue = "curve fit generated too many outline points";
    return;
  }
  const built = buildFieldProbePreview(geometry.points, fieldProbeSpotGap(), outlineWorkPoints());
  o.fieldProbePreview = built.points;
  if (!selectedFieldProbePoint(o)) o.fieldProbeSelectedID = "";
  o.fieldProbeTooDense = built.tooDense;
  o.fieldProbeIssue = built.issue || "";
}

function buildFieldProbePreview(points, spotGap, outlinePoints = points) {
  const spacing = fieldProbeCenterSpacing(spotGap);
  const polygon = normalizedClosedPolygon(points);
  if (polygon.length < 3) return { points: [], tooDense: false, issue: "field probe needs a closed outline" };
  const boundary = buildBoundaryProbePoints(polygon, outlinePoints, spacing);
  if (boundary.issue || boundary.tooDense) {
    return { points: [], tooDense: !!boundary.tooDense, issue: boundary.issue || "spot gap creates too many probe points" };
  }
  // Keep every captured/border site fixed, construct the gap-safe first ring
  // needed by flattened curves, then globally optimize the remaining
  // reconstruction mesh. Exact Voronoi/Delaunay holes drive the final minimax
  // moves and any globally resolvable insertion.
  const field = buildRelaxedProbePoints(polygon, spacing, boundary.points);
  const ordered = boundary.points.concat(field.points);
  return {
    points: ordered.map((p, i) => ({
      id: "field-probe-" + String(i + 1).padStart(4, "0"),
      x: p.x,
      y: p.y,
      probe_kind: p.probe_kind,
    })),
    tooDense: field.tooDense,
    issue: field.tooDense ? "spot gap creates too many probe points" : "",
  };
}

function normalizedClosedPolygon(points) {
  const out = (points || [])
    .map((p) => ({ x: Number(p.x), y: Number(p.y) }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (out.length > 1 && Math.hypot(out[0].x - out.at(-1).x, out[0].y - out.at(-1).y) <= 0.00005) out.pop();
  return out;
}

function buildBoundaryProbePoints(polygon, outlinePoints, spacing) {
  const path = closedPathSegments(polygon);
  if (!path.segments.length || !Number.isFinite(spacing) || spacing <= 0) {
    return { points: [], tooDense: false, issue: "field probe needs a valid outline" };
  }
  const upperCount = Math.max(1, Math.floor(path.perimeter / spacing + 1e-9));
  if (upperCount >= MAX_FIELD_PROBE_POINTS) {
    return { points: [], tooDense: true, issue: "spot gap creates too many border probe points" };
  }
  // Every point captured by the operator is a mandatory physical probe. Curve
  // fitting changes only the path between those sites; it must never replace
  // them with generated border samples.
  const outlineSeeds = buildOutlineEdgeProbePoints(outlinePoints, path);
  if (outlineSeeds.issue) {
    return { points: [], tooDense: false, issue: outlineSeeds.issue };
  }
  const edgeSeeds = outlineSeeds.points;
  let best;
  if (edgeSeeds.length) {
    // Mandatory captured outline probes split the path into fixed-end
    // intervals. Equal subdivision is the exact minimax solution on each
    // interval: it minimizes its largest along-path gap while respecting the
    // minimum gap. This avoids concentrating the global phase remainder next
    // to a corner (the 1.6×-spacing border hole from the reported layout).
    best = buildCornerPartitionedBoundary(path, edgeSeeds, spacing);
  } else {
    best = buildClosedMinimaxBoundary(path, upperCount, spacing);
  }
  if (!best || best.points.length >= MAX_FIELD_PROBE_POINTS) {
    return { points: [], tooDense: true, issue: "spot gap creates too many border probe points" };
  }
  best.points.sort((a, b) => a.path_distance - b.path_distance);
  return {
    points: best.points.map((point) => ({
      x: point.x,
      y: point.y,
      path_distance: point.path_distance,
      probe_kind: point.probe_kind,
    })),
    tooDense: false,
    issue: "",
  };
}

function buildCornerPartitionedBoundary(path, edgeSeeds, spacing) {
  const seeds = edgeSeeds.map((point) => ({ ...point })).sort((a, b) => a.path_distance - b.path_distance);
  const points = seeds.map((point) => ({ ...point }));
  const acceptedIndex = createProbeSpacingIndex(points, spacing);
  const intervals = seeds.map((seed, index) => {
    const next = seeds[(index + 1) % seeds.length];
    const end = next.path_distance + (index === seeds.length - 1 ? path.perimeter : 0);
    return { start: seed.path_distance, length: end - seed.path_distance, index };
  }).sort((a, b) => b.length - a.length || a.index - b.index);
  for (const interval of intervals) {
    const maximumParts = Math.max(1, Math.floor(interval.length / spacing + 1e-9));
    let selected = [];
    for (let parts = maximumParts; parts >= 1; parts--) {
      const trial = [];
      const trialIndex = createProbeSpacingIndex(points, spacing);
      let valid = true;
      for (let part = 1; part < parts; part++) {
        const distance = (interval.start + interval.length * part / parts) % path.perimeter;
        const sample = sampleClosedPathAtDistance(path, distance);
        const point = { ...sample, probe_kind: "border" };
        if (!probeSpacingIndexAllows(trialIndex, point)) {
          valid = false;
          break;
        }
        trial.push(point);
        addProbeSpacingPoint(trialIndex, point);
      }
      if (!valid) continue;
      selected = trial;
      break;
    }
    for (const point of selected) {
      if (!probeSpacingIndexAllows(acceptedIndex, point)) continue;
      points.push(point);
      addProbeSpacingPoint(acceptedIndex, point);
    }
  }
  return { points, maxArcGap: closedPathMaxSampleGap(points, path.perimeter) };
}

function buildClosedMinimaxBoundary(path, upperCount, spacing) {
  let best = null;
  for (let count = upperCount; count >= 1; count--) {
    for (let phaseIndex = 0; phaseIndex < 24; phaseIndex++) {
      const samples = sampleClosedPath(path, count, phaseIndex / 24).map((sample) => ({
        ...sample,
        probe_kind: "border",
      }));
      const spacingIndex = createProbeSpacingIndex([], spacing);
      let valid = true;
      for (const sample of samples) {
        if (!probeSpacingIndexAllows(spacingIndex, sample)) {
          valid = false;
          break;
        }
        addProbeSpacingPoint(spacingIndex, sample);
      }
      if (!valid) continue;
      const candidate = { points: samples, maxArcGap: closedPathMaxSampleGap(samples, path.perimeter) };
      if (!best ||
          candidate.maxArcGap < best.maxArcGap - 1e-9 ||
          (Math.abs(candidate.maxArcGap - best.maxArcGap) <= 1e-9 && candidate.points.length > best.points.length)) {
        best = candidate;
      }
    }
    if (best) break;
  }
  return best || { points: [], maxArcGap: path.perimeter };
}

function buildOutlineEdgeProbePoints(outlinePoints, path) {
  const points = normalizedClosedPolygon(outlinePoints);
  if (points.length < 3) return { points: [], issue: "" };
  const candidates = [];
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    const projection = projectPointToProbePath(point, path);
    candidates.push({
      ...projection,
      sourceX: point.x,
      sourceY: point.y,
      sourceIndex: index,
    });
  }
  candidates.sort((a, b) => a.path_distance - b.path_distance || a.sourceIndex - b.sourceIndex);
  const selected = candidates.map((candidate) => ({
      x: candidate.sourceX,
      y: candidate.sourceY,
      probe_kind: "outline",
      path_distance: candidate.path_distance,
    }));
  return { points: selected, issue: "" };
}

function projectPointToProbePath(point, path) {
  let best = { x: path.segments[0].a.x, y: path.segments[0].a.y, path_distance: 0, distance2: Infinity };
  for (const segment of path.segments) {
    const dx = segment.b.x - segment.a.x;
    const dy = segment.b.y - segment.a.y;
    const t = Math.max(0, Math.min(1, ((point.x - segment.a.x) * dx + (point.y - segment.a.y) * dy) / (segment.length * segment.length)));
    const x = segment.a.x + dx * t;
    const y = segment.a.y + dy * t;
    const distance2Value = Math.pow(point.x - x, 2) + Math.pow(point.y - y, 2);
    const pathDistance = segment.start + t * segment.length;
    if (distance2Value < best.distance2 - 1e-12 ||
        (Math.abs(distance2Value - best.distance2) <= 1e-12 && pathDistance < best.path_distance)) {
      best = { x, y, path_distance: pathDistance, distance2: distance2Value };
    }
  }
  return best;
}

function closedPathSegments(points) {
  const segments = [];
  let perimeter = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length <= 1e-9) continue;
    segments.push({ a, b, start: perimeter, end: perimeter + length, length });
    perimeter += length;
  }
  return { segments, perimeter };
}

function sampleClosedPath(path, count, phaseFraction = 0) {
  if (!path?.segments?.length || !Number.isInteger(count) || count <= 0) return [];
  const step = path.perimeter / count;
  const out = [];
  let segmentIndex = 0;
  for (let i = 0; i < count; i++) {
    const distance = ((i + phaseFraction) * step) % path.perimeter;
    while (segmentIndex < path.segments.length - 1 && distance > path.segments[segmentIndex].end + 1e-9) {
      segmentIndex++;
    }
    const segment = path.segments[segmentIndex];
    if (!segment) continue;
    const t = Math.max(0, Math.min(1, (distance - segment.start) / segment.length));
    out.push({
      x: segment.a.x + (segment.b.x - segment.a.x) * t,
      y: segment.a.y + (segment.b.y - segment.a.y) * t,
      path_distance: distance,
    });
  }
  return out;
}

function sampleClosedPathAtDistance(path, rawDistance) {
  const distance = ((rawDistance % path.perimeter) + path.perimeter) % path.perimeter;
  let segment = path.segments.at(-1);
  for (const candidate of path.segments) {
    if (distance <= candidate.end + 1e-9) {
      segment = candidate;
      break;
    }
  }
  const t = Math.max(0, Math.min(1, (distance - segment.start) / segment.length));
  return {
    x: segment.a.x + (segment.b.x - segment.a.x) * t,
    y: segment.a.y + (segment.b.y - segment.a.y) * t,
    path_distance: distance,
  };
}

function closedPathMaxSampleGap(points, perimeter) {
  if (!points.length) return perimeter;
  const distances = points.map((point) => point.path_distance).sort((a, b) => a - b);
  let maxGap = distances[0] + perimeter - distances.at(-1);
  for (let i = 1; i < distances.length; i++) maxGap = Math.max(maxGap, distances[i] - distances[i - 1]);
  return maxGap;
}

function createProbeSpacingIndex(points, spacing) {
  const index = { spacing, cells: new Map() };
  for (const point of points) addProbeSpacingPoint(index, point);
  return index;
}

function addProbeSpacingPoint(index, point) {
  const cellX = Math.floor(point.x / index.spacing);
  const cellY = Math.floor(point.y / index.spacing);
  const key = cellX + ":" + cellY;
  const cell = index.cells.get(key) || [];
  cell.push(point);
  index.cells.set(key, cell);
}

function probeSpacingIndexAllows(index, candidate) {
  const cellX = Math.floor(candidate.x / index.spacing);
  const cellY = Math.floor(candidate.y / index.spacing);
  for (let y = cellY - 1; y <= cellY + 1; y++) {
    for (let x = cellX - 1; x <= cellX + 1; x++) {
      for (const point of index.cells.get(x + ":" + y) || []) {
        if (Math.hypot(candidate.x - point.x, candidate.y - point.y) + 1e-9 < index.spacing) return false;
      }
    }
  }
  return true;
}

function buildRelaxedProbePoints(polygon, spacing, reserved = []) {
  const domain = buildProbeDomainSamples(polygon, spacing);
  const boundaryCount = reserved.length;
  const boundaryTargets = buildBoundaryInteriorTargets(reserved, polygon, spacing);
  const boundarySeeds = selectGapSafeBoundaryInteriorSeeds(
    boundaryTargets,
    reserved,
    spacing,
  );
  const fixedCount = boundaryCount;
  const latticeReserved = reserved.concat(boundarySeeds);
  const initial = buildBestProbeLattice(polygon, spacing, latticeReserved, domain);
  const points = reserved.map((point) => ({ ...point }))
    .concat(boundarySeeds.map((point) => ({ ...point, probe_kind: "field" })))
    .concat(initial.points);
  let tooDense = points.length >= MAX_FIELD_PROBE_POINTS && initial.truncated;
  const largeField = points.length >= 250;
  // Solve ordinary plans as reconstruction meshes. Very large plans retain the
  // explicitly constructed boundary layer and use the bounded lattice path so
  // editing cannot lock the UI in the quadratic Delaunay solver.
  const meshOptimized = !tooDense && !largeField && optimizeProbeMesh(
    points,
    fixedCount,
    domain,
    polygon,
    spacing,
    boundaryTargets,
  );
  for (let cycle = 0; cycle < (meshOptimized || largeField ? 0 : 12) && !tooDense; cycle++) {
    for (let iteration = 0; iteration < 36; iteration++) {
      const moved = relaxProbeDistribution(points, fixedCount, domain, polygon, spacing, iteration);
      if (moved <= spacing * 0.0002 && probeDistributionValid(points, fixedCount, polygon, spacing)) break;
    }
    const hole = largestProbeCoverageHole(points, domain, spacing);
    if (!hole.point || hole.distance + 1e-9 < spacing) break;
    if (points.length >= MAX_FIELD_PROBE_POINTS) {
      tooDense = true;
      break;
    }
    points.push({ x: hole.point.x, y: hole.point.y, probe_kind: "field" });
  }
  for (let cycle = 0; cycle < (largeField ? 0 : 8) && !tooDense; cycle++) {
    const hole = largestExactFeasibleProbeHole(points, polygon, spacing);
    if (!hole.point || hole.distance + 1e-9 < spacing) break;
    if (points.length >= MAX_FIELD_PROBE_POINTS) {
      tooDense = true;
      break;
    }
    points.push({ x: hole.point.x, y: hole.point.y, probe_kind: "field" });
    for (let iteration = 0; iteration < 24; iteration++) {
      const moved = relaxProbeDistribution(points, fixedCount, domain, polygon, spacing, iteration);
      if (moved <= spacing * 0.0002 && probeDistributionValid(points, fixedCount, polygon, spacing)) break;
    }
  }
  if (!tooDense && !largeField) improveProbeCovering(points, fixedCount, polygon, spacing, 36);
  // Saturation alone is not optimality: a jammed packing can have no legal
  // insertion while still wasting enough area to support another site after
  // its neighbours move. Seed the worst Delaunay cell under an annealed gap,
  // solve the whole mesh again, and keep the extra probe only if exact hard-gap
  // projection succeeds and the certified covering radius improves.
  for (let insertion = 0;
    insertion < 3 && !tooDense && points.length < 250;
    insertion++) {
    const baseline = probeCoverageCertificate(points, polygon);
    if (points.length >= MAX_FIELD_PROBE_POINTS) {
      tooDense = true;
      break;
    }
    let accepted = null;
    const candidates = baseline.critical.filter((critical) =>
      critical.kind === "interior" &&
      critical.nearest.length > 0 &&
      probeSpotFitsPolygon(critical.point, polygon)
    ).slice(0, 1);
    for (const candidate of candidates) {
      const trial = points.map((point) => ({ ...point }));
      trial.push({ x: candidate.point.x, y: candidate.point.y, probe_kind: "field" });
      if (!optimizeProbeMesh(
        trial,
        fixedCount,
        domain,
        polygon,
        spacing,
        boundaryTargets,
        60,
        baseline,
      )) {
        continue;
      }
      accepted = trial;
      break;
    }
    if (!accepted) break;
    points.splice(0, points.length, ...accepted);
    improveProbeCovering(points, fixedCount, polygon, spacing, 24);
  }
  return {
    points: points.slice(boundaryCount).map((point) => ({
      x: point.x,
      y: point.y,
      probe_kind: "field",
    })),
    tooDense,
  };
}

function optimizeProbeMesh(
  points,
  fixedCount,
  domain,
  polygon,
  spacing,
  boundaryTargets = [],
  iterationLimit = 80,
  comparisonCertificate = null,
) {
  if (points.length <= fixedCount || !domain.length) return false;
  const original = points.map((point) => ({ ...point }));
  const originalCertificate = comparisonCertificate || probeCoverageCertificate(points, polygon);
  const theoreticalRadius = spacing / Math.sqrt(3);
  const triangulationRefresh = polygon.length > 12 ? 1 : 4;
  let faces = [];
  for (let iteration = 0; iteration < iterationLimit; iteration++) {
    const progress = iterationLimit <= 1 ? 1 : iteration / (iterationLimit - 1);
    const targetLength = spacing * (0.72 + 0.28 * Math.min(1, progress * 1.25));
    const forceX = new Float64Array(points.length);
    const forceY = new Float64Array(points.length);
    const forceWeight = new Float64Array(points.length);
    const anchorX = new Float64Array(points.length);
    const anchorY = new Float64Array(points.length);
    const anchorWeight = new Float64Array(points.length);
    if (!faces.length || iteration % triangulationRefresh === 0) {
      faces = probeDelaunayTriangles(points);
    }
    const edges = new Set();
    const coverageCritical = [];
    for (const face of faces) {
      const center = averagePoint(face.map((index) => points[index]));
      if (!pointInPolygonOrBoundary(center, polygon)) continue;
      const circumcenter = triangleCircumcenter(
        points[face[0]],
        points[face[1]],
        points[face[2]],
      );
      if (circumcenter && pointInPolygonOrBoundary(circumcenter, polygon)) {
        const nearest = nearestProbeSet(circumcenter, points);
        coverageCritical.push({
          point: circumcenter,
          distance2: nearest.distance2,
          nearest: nearest.indices,
        });
      }
      for (const [first, second] of [
        [face[0], face[1]],
        [face[1], face[2]],
        [face[2], face[0]],
      ]) {
        const key = triangulationEdgeKey(first, second);
        if (edges.has(key)) continue;
        edges.add(key);
        const dx = points[second].x - points[first].x;
        const dy = points[second].y - points[first].y;
        const length = Math.hypot(dx, dy);
        if (length <= 1e-12 || length > spacing * 2.4) continue;
        const error = length - targetLength;
        const ux = dx / length;
        const uy = dy / length;
        const firstFree = first >= fixedCount;
        const secondFree = second >= fixedCount;
        if (firstFree) {
          forceX[first] += ux * error;
          forceY[first] += uy * error;
          forceWeight[first] += 1;
        }
        if (secondFree) {
          forceX[second] -= ux * error;
          forceY[second] -= uy * error;
          forceWeight[second] += 1;
        }
      }
    }
    coverageCritical.sort((first, second) => second.distance2 - first.distance2);
    const worstInteriorRadius = coverageCritical.length ?
      Math.sqrt(coverageCritical[0].distance2) :
      theoreticalRadius;
    const coverageCutoff = Math.max(theoreticalRadius, worstInteriorRadius * 0.82);
    for (const critical of coverageCritical) {
      const radius = Math.sqrt(critical.distance2);
      if (radius + 1e-9 < coverageCutoff) break;
      const pull = Math.max(0, radius - theoreticalRadius);
      for (const pointIndex of critical.nearest) {
        if (pointIndex < fixedCount) continue;
        const dx = critical.point.x - points[pointIndex].x;
        const dy = critical.point.y - points[pointIndex].y;
        const length = Math.hypot(dx, dy);
        if (length <= 1e-12) continue;
        forceX[pointIndex] += dx / length * pull * 1.8;
        forceY[pointIndex] += dy / length * pull * 1.8;
        forceWeight[pointIndex] += 1.8;
      }
    }
    const nearestIndex = createProbeNearestIndex(points, spacing);
    const sumX = new Float64Array(points.length);
    const sumY = new Float64Array(points.length);
    const sampleWeight = new Float64Array(points.length);
    for (const sample of domain) {
      const nearest = nearestIndexedProbe(nearestIndex, sample, fixedCount);
      if (nearest.index < fixedCount) continue;
      const weight = Math.max(0.1, nearest.distance2 / (spacing * spacing));
      sumX[nearest.index] += sample.x * weight;
      sumY[nearest.index] += sample.y * weight;
      sampleWeight[nearest.index] += weight;
    }
    for (const target of boundaryTargets) {
      const nearest = nearestIndexedProbe(nearestIndex, target, fixedCount);
      if (nearest.index < fixedCount) continue;
      sumX[nearest.index] += target.x * 3;
      sumY[nearest.index] += target.y * 3;
      sampleWeight[nearest.index] += 3;
    }
    for (let boundaryIndex = 0; boundaryIndex < fixedCount; boundaryIndex++) {
      const nearest = nearestIndexedProbe(nearestIndex, points[boundaryIndex], fixedCount);
      if (nearest.index < fixedCount) continue;
      const dx = points[boundaryIndex].x - points[nearest.index].x;
      const dy = points[boundaryIndex].y - points[nearest.index].y;
      const distance = Math.hypot(dx, dy);
      if (distance <= spacing || distance <= 1e-12) continue;
      anchorX[nearest.index] += dx / distance * (distance - spacing);
      anchorY[nearest.index] += dy / distance * (distance - spacing);
      anchorWeight[nearest.index]++;
    }
    const previous = points.map((point) => ({ ...point }));
    const maxStep = spacing * (0.12 - 0.07 * progress);
    const springStep = 0.2;
    const centroidStep = 0.08;
    for (let pointIndex = fixedCount; pointIndex < points.length; pointIndex++) {
      let dx = forceWeight[pointIndex] ?
        forceX[pointIndex] / forceWeight[pointIndex] * springStep :
        0;
      let dy = forceWeight[pointIndex] ?
        forceY[pointIndex] / forceWeight[pointIndex] * springStep :
        0;
      if (sampleWeight[pointIndex]) {
        dx += (sumX[pointIndex] / sampleWeight[pointIndex] - points[pointIndex].x) * centroidStep;
        dy += (sumY[pointIndex] / sampleWeight[pointIndex] - points[pointIndex].y) * centroidStep;
      }
      if (anchorWeight[pointIndex]) {
        dx += anchorX[pointIndex] / anchorWeight[pointIndex] * 2;
        dy += anchorY[pointIndex] / anchorWeight[pointIndex] * 2;
      }
      const length = Math.hypot(dx, dy);
      if (length > maxStep) {
        dx *= maxStep / length;
        dy *= maxStep / length;
      }
      const candidate = {
        ...points[pointIndex],
        x: points[pointIndex].x + dx,
        y: points[pointIndex].y + dy,
      };
      points[pointIndex] = probeSpotFitsPolygon(candidate, polygon) ?
        candidate :
        probePointInsideAlongMove(previous[pointIndex], candidate, polygon);
    }
  }
  const beforeProjection = points.map((point) => ({ ...point }));
  projectProbeSpacingConstraints(points, beforeProjection, fixedCount, polygon, spacing, 0, 240);
  if (!probeDistributionValid(points, fixedCount, polygon, spacing)) {
    points.splice(0, points.length, ...original);
    return false;
  }
  const optimizedCertificate = probeCoverageCertificate(points, polygon);
  if (!probeCoverageCertificateBetter(optimizedCertificate, originalCertificate)) {
    points.splice(0, points.length, ...original);
    return false;
  }
  return true;
}

function buildBoundaryInteriorTargets(boundary, polygon, spacing) {
  if (boundary.length < 2) return [];
  const path = closedPathSegments(polygon);
  const ordered = boundary.map((point) => {
    if (Number.isFinite(point.path_distance)) return { ...point };
    return { ...point, ...projectPointToProbePath(point, path) };
  }).sort((first, second) => first.path_distance - second.path_distance);
  const fixedIndex = createProbeSpacingIndex(ordered, spacing);
  const targets = [];
  for (let index = 0; index < ordered.length; index++) {
    const first = ordered[index];
    const second = ordered[(index + 1) % ordered.length];
    const dx = second.x - first.x;
    const dy = second.y - first.y;
    const chord = Math.hypot(dx, dy);
    if (chord <= 1e-9 || chord > spacing * 2 + 1e-7) continue;
    const midpoint = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
    // The inward circle intersection is exactly `spacing` from both interval
    // endpoints. Projecting it away from all other fixed boundary probes gives
    // a constructive, feasible target for the first interior row.
    const idealHeight = Math.sqrt(Math.max(0, spacing * spacing - chord * chord / 4));
    const nx = -dy / chord;
    const ny = dx / chord;
    let target = null;
    for (const sign of [1, -1]) {
      const initialHeight = Math.max(idealHeight, PROBE_SPOT_RADIUS_MM + 0.0002);
      const candidate = {
        x: midpoint.x + nx * initialHeight * sign,
        y: midpoint.y + ny * initialHeight * sign,
      };
      if (!probeSpotFitsPolygon(candidate, polygon)) continue;
      const projected = projectBoundaryInteriorTarget(candidate, ordered, polygon, spacing);
      if (!projected || !probeSpacingIndexAllows(fixedIndex, projected)) continue;
      target = projected;
      break;
    }
    if (!target) continue;
    if (targets.some((existing) => Math.hypot(existing.x - target.x, existing.y - target.y) < spacing * 0.2)) continue;
    targets.push({
      ...target,
      boundary_edge_index: index,
      boundary_target_position: index + 0.5,
    });
  }
  // At a convex corner, the equilateral target for either incident edge is
  // usually too close to the boundary site on the other edge. The exact
  // circle intersection for the two neighbouring boundary sites is the
  // one-site bridge that minimizes both incident triangles while retaining the
  // full spacing from the corner itself.
  for (let index = 0; index < ordered.length; index++) {
    const previous = ordered[(index - 1 + ordered.length) % ordered.length];
    const corner = ordered[index];
    const next = ordered[(index + 1) % ordered.length];
    const dx = next.x - previous.x;
    const dy = next.y - previous.y;
    const chord = Math.hypot(dx, dy);
    if (chord <= 1e-9 || chord >= spacing * 2 - 1e-7) continue;
    const height = Math.sqrt(Math.max(0, spacing * spacing - chord * chord / 4));
    const center = {
      x: (previous.x + next.x) / 2,
      y: (previous.y + next.y) / 2,
    };
    const nx = -dy / chord;
    const ny = dx / chord;
    let best = null;
    for (const sign of [1, -1]) {
      const candidate = {
        x: center.x + nx * height * sign,
        y: center.y + ny * height * sign,
      };
      if (!probeSpotFitsPolygon(candidate, polygon) ||
          !probeSpacingIndexAllows(fixedIndex, candidate)) {
        continue;
      }
      const maxDistance2 = Math.max(
        distance2(previous, candidate),
        distance2(corner, candidate),
        distance2(next, candidate),
      );
      if (!best || maxDistance2 < best.maxDistance2) {
        best = { point: candidate, maxDistance2 };
      }
    }
    if (!best) continue;
    targets.push({
      ...best.point,
      boundary_corner_index: index,
      boundary_target_position: index,
    });
  }
  targets.sort((first, second) =>
    first.boundary_target_position - second.boundary_target_position
  );
  return targets;
}

function selectGapSafeBoundaryInteriorSeeds(targets, boundary, spacing) {
  if (!targets.length) return [];
  const conflicts = targets.map(() => new Set());
  for (let first = 0; first < targets.length; first++) {
    for (let second = first + 1; second < targets.length; second++) {
      if (Math.hypot(
        targets[first].x - targets[second].x,
        targets[first].y - targets[second].y,
      ) + 1e-9 >= spacing) {
        continue;
      }
      conflicts[first].add(second);
      conflicts[second].add(first);
    }
  }
  const selectedIndices = new Set();
  const contested = new Set();
  const components = [];
  for (let index = 0; index < targets.length; index++) {
    if (!conflicts[index].size) {
      selectedIndices.add(index);
      continue;
    }
    if (contested.has(index)) continue;
    const component = [];
    const pending = [index];
    contested.add(index);
    while (pending.length) {
      const current = pending.pop();
      component.push(current);
      for (const adjacent of conflicts[current]) {
        if (contested.has(adjacent)) continue;
        contested.add(adjacent);
        pending.push(adjacent);
      }
    }
    components.push(component.sort((first, second) => first - second));
  }
  const base = [...selectedIndices].map((index) => targets[index]);
  for (const component of components) {
    // Conflicts are spatially local (normally the two edge targets and bridge
    // target around one corner). Enumerate every maximal independent subset,
    // then solve the incident boundary edges exactly.
    if (component.length > 16) {
      const local = [];
      for (const index of component) {
        if (local.some((selected) => conflicts[index].has(selected))) continue;
        local.push(index);
        selectedIndices.add(index);
      }
      continue;
    }
    const options = [];
    const subsetCount = 1 << component.length;
    for (let mask = 1; mask < subsetCount; mask++) {
      let valid = true;
      let maximal = true;
      const indices = [];
      for (let bit = 0; bit < component.length && valid; bit++) {
        if (!(mask & (1 << bit))) continue;
        const index = component[bit];
        indices.push(index);
        for (let other = bit + 1; other < component.length; other++) {
          if ((mask & (1 << other)) && conflicts[index].has(component[other])) {
            valid = false;
            break;
          }
        }
      }
      if (!valid) continue;
      for (let bit = 0; bit < component.length; bit++) {
        if (mask & (1 << bit)) continue;
        if (indices.every((index) => !conflicts[index].has(component[bit]))) {
          maximal = false;
          break;
        }
      }
      if (maximal) options.push(indices);
    }
    const affectedEdges = new Set();
    for (const index of component) {
      const target = targets[index];
      if (Number.isInteger(target.boundary_edge_index)) {
        affectedEdges.add(target.boundary_edge_index);
      }
      if (Number.isInteger(target.boundary_corner_index)) {
        affectedEdges.add((target.boundary_corner_index - 1 + boundary.length) % boundary.length);
        affectedEdges.add(target.boundary_corner_index);
      }
    }
    let best = null;
    for (const option of options) {
      const sites = base.concat(option.map((index) => targets[index]));
      let maxDistance2 = 0;
      let sumDistance2 = 0;
      for (const edgeIndex of affectedEdges) {
        const first = boundary[edgeIndex];
        const second = boundary[(edgeIndex + 1) % boundary.length];
        let edgeDistance2 = Infinity;
        for (const site of sites) {
          edgeDistance2 = Math.min(edgeDistance2, Math.max(
            distance2(first, site),
            distance2(second, site),
          ));
        }
        maxDistance2 = Math.max(maxDistance2, edgeDistance2);
        sumDistance2 += edgeDistance2;
      }
      const score = {
        option,
        maxDistance2,
        meanDistance2: sumDistance2 / Math.max(1, affectedEdges.size),
      };
      if (!best ||
          score.maxDistance2 < best.maxDistance2 - 1e-9 ||
          (Math.abs(score.maxDistance2 - best.maxDistance2) <= 1e-9 &&
           (score.meanDistance2 < best.meanDistance2 - 1e-9 ||
            (Math.abs(score.meanDistance2 - best.meanDistance2) <= 1e-9 &&
             score.option.length > best.option.length)))) {
        best = score;
      }
    }
    for (const index of best?.option || []) selectedIndices.add(index);
  }
  return [...selectedIndices].sort((first, second) => first - second).map((index) => ({
    ...targets[index],
    boundary_target_index: index,
  }));
}

function projectBoundaryInteriorTarget(candidate, boundary, polygon, spacing) {
  let point = { ...candidate };
  for (let pass = 0; pass < 48; pass++) {
    const previous = { ...point };
    let worstOverlap = 0;
    for (let index = 0; index < boundary.length; index++) {
      const fixed = boundary[index];
      let dx = point.x - fixed.x;
      let dy = point.y - fixed.y;
      let distance = Math.hypot(dx, dy);
      if (distance + 1e-7 >= spacing) continue;
      if (distance <= 1e-12) {
        const angle = (index + 1) * 2.399963229728653;
        dx = Math.cos(angle);
        dy = Math.sin(angle);
        distance = 1;
      }
      const overlap = spacing + 0.0002 - distance;
      worstOverlap = Math.max(worstOverlap, overlap);
      point.x += dx / distance * overlap;
      point.y += dy / distance * overlap;
    }
    if (!probeSpotFitsPolygon(point, polygon)) {
      point = probePointInsideAlongMove(previous, point, polygon);
    }
    if (worstOverlap <= 0.0001) break;
    if (Math.hypot(point.x - previous.x, point.y - previous.y) <= 1e-10) return null;
  }
  if (!probeSpotFitsPolygon(point, polygon)) return null;
  return point;
}

function largestExactFeasibleProbeHole(points, polygon, spacing) {
  const certificate = probeCoverageCertificate(points, polygon);
  const spacingIndex = createProbeSpacingIndex(points, spacing);
  for (const critical of certificate.critical) {
    if (critical.distance2 + 1e-8 < spacing * spacing) break;
    if (!probeSpotFitsPolygon(critical.point, polygon)) continue;
    if (!probeSpacingIndexAllows(spacingIndex, critical.point)) continue;
    return { point: critical.point, distance: Math.sqrt(critical.distance2) };
  }
  return { point: null, distance: 0 };
}

function improveProbeCovering(points, fixedCount, polygon, spacing, maxIterations = 36) {
  if (points.length <= fixedCount) return;
  const theoreticalRadius = spacing / Math.sqrt(3);
  let certificate = probeCoverageCertificate(points, polygon);
  let step = spacing * 0.09;
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const worstRadius = Math.sqrt(certificate.maxDistance2);
    if (worstRadius <= theoreticalRadius + spacing * 0.0001) break;
    const cutoff = Math.max(theoreticalRadius, worstRadius * 0.985);
    const forceX = new Float64Array(points.length);
    const forceY = new Float64Array(points.length);
    const weights = new Float64Array(points.length);
    for (const critical of certificate.critical) {
      const radius = Math.sqrt(critical.distance2);
      if (radius + 1e-9 < cutoff) break;
      if (critical.kind !== "interior" || !critical.nearest.length) continue;
      const severity = Math.max(spacing * 0.002, radius - theoreticalRadius);
      for (const pointIndex of critical.nearest) {
        if (pointIndex < fixedCount) continue;
        const point = points[pointIndex];
        const dx = critical.point.x - point.x;
        const dy = critical.point.y - point.y;
        const length = Math.hypot(dx, dy);
        if (length <= 1e-12) continue;
        forceX[pointIndex] += dx / length * severity;
        forceY[pointIndex] += dy / length * severity;
        weights[pointIndex] += severity;
      }
    }
    if (!weights.some((weight) => weight > 0)) break;
    let accepted = null;
    let acceptedCertificate = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      const attemptStep = step * Math.pow(0.5, attempt);
      const proposed = points.map((point) => ({ ...point }));
      for (let pointIndex = fixedCount; pointIndex < proposed.length; pointIndex++) {
        if (!weights[pointIndex]) continue;
        let dx = forceX[pointIndex] / weights[pointIndex];
        let dy = forceY[pointIndex] / weights[pointIndex];
        const length = Math.hypot(dx, dy);
        if (length <= 1e-12) continue;
        const move = Math.min(attemptStep, length);
        proposed[pointIndex].x += dx / length * move;
        proposed[pointIndex].y += dy / length * move;
      }
      projectProbeSpacingConstraints(proposed, points, fixedCount, polygon, spacing, iteration);
      if (!probeDistributionValid(proposed, fixedCount, polygon, spacing)) continue;
      let maxMove = 0;
      for (let pointIndex = fixedCount; pointIndex < proposed.length; pointIndex++) {
        maxMove = Math.max(maxMove, Math.hypot(
          proposed[pointIndex].x - points[pointIndex].x,
          proposed[pointIndex].y - points[pointIndex].y,
        ));
      }
      if (maxMove <= spacing * 1e-8) continue;
      const proposedCertificate = probeCoverageCertificate(proposed, polygon);
      if (!probeCoverageCertificateBetter(proposedCertificate, certificate)) continue;
      accepted = proposed;
      acceptedCertificate = proposedCertificate;
      step = Math.min(spacing * 0.12, attemptStep * 1.25);
      break;
    }
    if (!accepted) {
      break;
    }
    for (let pointIndex = fixedCount; pointIndex < points.length; pointIndex++) {
      points[pointIndex].x = accepted[pointIndex].x;
      points[pointIndex].y = accepted[pointIndex].y;
    }
    certificate = acceptedCertificate;
  }
}

function probeCoverageCertificateBetter(candidate, current) {
  const scale = Math.max(1, current.maxDistance2, candidate.maxDistance2);
  const tolerance = scale * 1e-9;
  if (candidate.maxDistance2 < current.maxDistance2 - tolerance) return true;
  if (candidate.maxDistance2 > current.maxDistance2 + tolerance) return false;
  const limit = Math.min(24, candidate.critical.length, current.critical.length);
  for (let index = 1; index < limit; index++) {
    const difference = candidate.critical[index].distance2 - current.critical[index].distance2;
    if (difference < -tolerance) return true;
    if (difference > tolerance) return false;
  }
  return false;
}

function buildProbeDomainSamples(polygon, spacing) {
  const bounds = pointBounds(polygon);
  const width = Math.max(0, bounds.x_max - bounds.x_min);
  const height = Math.max(0, bounds.y_max - bounds.y_min);
  const maxSamples = 30000;
  const step = Math.max(spacing / 4, Math.sqrt((width * height) / maxSamples) || spacing / 4);
  const samples = [];
  let row = 0;
  for (let y = bounds.y_min + PROBE_SPOT_RADIUS_MM; y <= bounds.y_max - PROBE_SPOT_RADIUS_MM + 1e-9; y += step, row++) {
    const offset = row % 2 ? step / 2 : 0;
    for (let x = bounds.x_min + PROBE_SPOT_RADIUS_MM + offset; x <= bounds.x_max - PROBE_SPOT_RADIUS_MM + 1e-9; x += step) {
      const point = { x, y };
      if (probeSpotFitsPolygon(point, polygon)) samples.push(point);
    }
  }
  const center = polygonCentroid(polygon);
  if (probeSpotFitsPolygon(center, polygon)) samples.push(center);
  return samples;
}

function buildBestProbeLattice(polygon, spacing, reserved, domain) {
  const offsets = [0, 0.5];
  const scoreStride = Math.max(1, Math.ceil(domain.length / 2500));
  const scoringDomain = scoreStride === 1 ? domain : domain.filter((_, index) => index % scoreStride === 0);
  let best = { points: [], truncated: false, score: null };
  const consider = (candidate) => {
    if (candidate.truncated) return { ...candidate, score: null };
    const score = probeCoverageScore(reserved.concat(candidate.points), scoringDomain, spacing);
    if (!best.score ||
        score.maxDistance2 < best.score.maxDistance2 - 1e-9 ||
        (Math.abs(score.maxDistance2 - best.score.maxDistance2) <= 1e-9 &&
         (score.meanDistance2 < best.score.meanDistance2 - 1e-9 ||
          (Math.abs(score.meanDistance2 - best.score.meanDistance2) <= 1e-9 &&
           candidate.points.length > best.points.length)))) {
      best = { ...candidate, score };
    }
    return null;
  };
  for (const kind of ["triangular", "square"]) {
    const rotationDegrees = kind === "triangular" ? [0, 10, 20, 30, 40, 50] : [0, 15, 30, 45, 60, 75];
    const rotations = rotationDegrees.map((degrees) => degrees * Math.PI / 180);
    for (const rotation of rotations) {
      for (const offsetX of offsets) {
        for (const offsetY of offsets) {
          const candidate = buildProbeLatticeCandidate(polygon, spacing, reserved, kind, rotation, offsetX, offsetY);
          // This one lattice is already a constructive proof that more than
          // the supported number of mutually gap-safe probes fit. No broader
          // search or relaxation can make the requested preview usable.
          const truncated = consider(candidate);
          if (truncated) return truncated;
        }
      }
    }
  }
  return best;
}

function buildProbeLatticeCandidate(polygon, spacing, reserved, kind, rotation, offsetXFrac, offsetYFrac) {
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const toLattice = (point) => ({ x: point.x * cos + point.y * sin, y: -point.x * sin + point.y * cos });
  const fromLattice = (point) => ({ x: point.x * cos - point.y * sin, y: point.x * sin + point.y * cos });
  const bounds = pointBounds(polygon.map(toLattice));
  const rowGap = kind === "triangular" ? spacing * Math.sqrt(3) / 2 : spacing;
  const firstY = Math.floor((bounds.y_min - rowGap) / rowGap) * rowGap + offsetYFrac * rowGap;
  const firstX = Math.floor((bounds.x_min - spacing) / spacing) * spacing + offsetXFrac * spacing;
  const spacingIndex = createProbeSpacingIndex(reserved, spacing);
  const points = [];
  let truncated = false;
  let row = 0;
  for (let y = firstY; y <= bounds.y_max + rowGap + 1e-9; y += rowGap, row++) {
    const rowOffset = kind === "triangular" && row % 2 ? spacing / 2 : 0;
    for (let x = firstX + rowOffset; x <= bounds.x_max + spacing + 1e-9; x += spacing) {
      const source = fromLattice({ x, y });
      const point = { x: source.x, y: source.y, probe_kind: "field" };
      if (!probeSpotFitsPolygon(point, polygon) || !probeSpacingIndexAllows(spacingIndex, point)) continue;
      if (reserved.length + points.length >= MAX_FIELD_PROBE_POINTS) {
        truncated = true;
        break;
      }
      points.push(point);
      addProbeSpacingPoint(spacingIndex, point);
    }
    if (truncated) break;
  }
  return { points, truncated };
}

function probeCoverageScore(points, domain, spacing) {
  if (!points.length || !domain.length) return { maxDistance2: Infinity, meanDistance2: Infinity };
  const index = createProbeNearestIndex(points, spacing);
  let maxDistance2 = 0;
  let sumDistance2 = 0;
  for (const sample of domain) {
    const nearest = nearestIndexedProbe(index, sample).distance2;
    maxDistance2 = Math.max(maxDistance2, nearest);
    sumDistance2 += nearest;
  }
  return { maxDistance2, meanDistance2: sumDistance2 / domain.length };
}

// Return the exact covering radius for this finite probe set over the polygon.
// In the interior, every local maximum of the nearest-site distance is a
// Voronoi vertex, hence the circumcenter of a Delaunay triangle. On a polygon
// edge, all squared point distances share the same quadratic term; their lower
// envelope changes only where two affine remainders cross. Evaluating those
// breakpoints makes the boundary result exact as well—there is no raster/grid
// resolution hidden in this certificate.
function probeCoverageCertificate(points, polygon) {
  if (!points.length || polygon.length < 3) {
    return { maxDistance2: Infinity, point: null, critical: [], exact: false };
  }
  const critical = [];
  const faces = probeDelaunayTriangles(points);
  for (const face of faces) {
    const center = triangleCircumcenter(points[face[0]], points[face[1]], points[face[2]]);
    if (!center || !pointInPolygonOrBoundary(center, polygon)) continue;
    const nearest = nearestProbeSet(center, points);
    critical.push({
      point: center,
      distance2: nearest.distance2,
      nearest: nearest.indices,
      kind: "interior",
    });
  }
  const boundary = exactBoundaryProbeCriticalPoints(points, polygon);
  critical.push(...boundary);
  if (!critical.length) {
    const point = polygonCentroid(polygon);
    const nearest = nearestProbeSet(point, points);
    critical.push({ point, distance2: nearest.distance2, nearest: nearest.indices, kind: "fallback" });
  }
  critical.sort((a, b) =>
    b.distance2 - a.distance2 ||
    a.point.y - b.point.y ||
    a.point.x - b.point.x
  );
  return {
    maxDistance2: critical[0].distance2,
    point: critical[0].point,
    critical,
    exact: true,
  };
}

function probeMeshQualityCertificate(points, polygon) {
  let triangleCount = 0;
  let maxEdge = 0;
  let minAngle = Math.PI;
  let maxRadiusEdgeRatio = 0;
  for (const face of probeDelaunayTriangles(points)) {
    const triangle = face.map((index) => points[index]);
    const centroid = averagePoint(triangle);
    const edgeMidpoints = [
      midpoint(triangle[0], triangle[1]),
      midpoint(triangle[1], triangle[2]),
      midpoint(triangle[2], triangle[0]),
    ];
    if (!pointInPolygonOrBoundary(centroid, polygon) ||
        edgeMidpoints.some((point) => !pointInPolygonOrBoundary(point, polygon))) {
      continue;
    }
    const sides = [
      Math.hypot(triangle[1].x - triangle[0].x, triangle[1].y - triangle[0].y),
      Math.hypot(triangle[2].x - triangle[1].x, triangle[2].y - triangle[1].y),
      Math.hypot(triangle[0].x - triangle[2].x, triangle[0].y - triangle[2].y),
    ];
    const shortest = Math.min(...sides);
    const longest = Math.max(...sides);
    if (shortest <= 1e-12) continue;
    const angles = sides.map((opposite, index) => {
      const first = sides[(index + 1) % 3];
      const second = sides[(index + 2) % 3];
      const cosine = (first * first + second * second - opposite * opposite) /
        (2 * first * second);
      return Math.acos(Math.max(-1, Math.min(1, cosine)));
    });
    const circumcenter = triangleCircumcenter(...triangle);
    if (!circumcenter) continue;
    triangleCount++;
    maxEdge = Math.max(maxEdge, longest);
    minAngle = Math.min(minAngle, ...angles);
    maxRadiusEdgeRatio = Math.max(
      maxRadiusEdgeRatio,
      Math.sqrt(distance2(circumcenter, triangle[0])) / shortest,
    );
  }
  return {
    exact: true,
    triangleCount,
    maxEdge,
    minAngleDegrees: triangleCount ? minAngle * 180 / Math.PI : 0,
    maxRadiusEdgeRatio,
  };
}

// Exhaustively certify the first reconstruction layer. For every consecutive
// pair of physical boundary probes, choose the field probe that minimizes the
// longer of its two incident triangle edges. This directly measures the
// boundary-to-field moat that a global nearest-neighbour score can hide.
function probeBoundaryLayerCertificate(points, polygon) {
  const firstField = points.findIndex((point) => point.probe_kind === "field");
  if (firstField < 2 || firstField >= points.length) {
    return { exact: true, edgeCount: 0, maxThirdEdge: Infinity, worst: null };
  }
  const boundary = points.slice(0, firstField);
  const field = points.slice(firstField);
  const edges = [];
  for (let edgeIndex = 0; edgeIndex < boundary.length; edgeIndex++) {
    const first = boundary[edgeIndex];
    const second = boundary[(edgeIndex + 1) % boundary.length];
    let best = null;
    for (let fieldIndex = 0; fieldIndex < field.length; fieldIndex++) {
      const point = field[fieldIndex];
      const centroid = averagePoint([first, second, point]);
      const edgeMidpoints = [
        midpoint(first, point),
        midpoint(second, point),
      ];
      if (!pointInPolygonOrBoundary(centroid, polygon) ||
          edgeMidpoints.some((candidate) => !pointInPolygonOrBoundary(candidate, polygon))) {
        continue;
      }
      const firstDistance = Math.hypot(point.x - first.x, point.y - first.y);
      const secondDistance = Math.hypot(point.x - second.x, point.y - second.y);
      const maxThirdEdge = Math.max(firstDistance, secondDistance);
      const candidate = {
        edgeIndex,
        fieldIndex: firstField + fieldIndex,
        firstDistance,
        secondDistance,
        maxThirdEdge,
      };
      if (!best ||
          candidate.maxThirdEdge < best.maxThirdEdge - 1e-9 ||
          (Math.abs(candidate.maxThirdEdge - best.maxThirdEdge) <= 1e-9 &&
           candidate.fieldIndex < best.fieldIndex)) {
        best = candidate;
      }
    }
    if (best) edges.push(best);
  }
  edges.sort((first, second) =>
    second.maxThirdEdge - first.maxThirdEdge ||
    first.edgeIndex - second.edgeIndex
  );
  return {
    exact: true,
    edgeCount: edges.length,
    maxThirdEdge: edges[0]?.maxThirdEdge ?? Infinity,
    worst: edges[0] || null,
    edges,
  };
}

function probeDelaunayTriangles(points) {
  if (points.length < 3) return [];
  const bounds = pointBounds(points);
  const span = Math.max(bounds.x_max - bounds.x_min, bounds.y_max - bounds.y_min, 1);
  const centerX = (bounds.x_min + bounds.x_max) / 2;
  const centerY = (bounds.y_min + bounds.y_max) / 2;
  const vertices = points.concat([
    { x: centerX - 32 * span, y: centerY - 24 * span },
    { x: centerX, y: centerY + 32 * span },
    { x: centerX + 32 * span, y: centerY - 24 * span },
  ]);
  const pointCount = points.length;
  let faces = [[pointCount, pointCount + 1, pointCount + 2]];
  const insertionOrder = points.map((point, index) => ({ point, index }))
    .sort((first, second) =>
      first.point.x - second.point.x ||
      first.point.y - second.point.y ||
      first.index - second.index
    );
  for (const insertion of insertionOrder) {
    const bad = [];
    for (let faceIndex = 0; faceIndex < faces.length; faceIndex++) {
      const face = faces[faceIndex];
      if (probePointInCircumcircle(
        insertion.point,
        vertices[face[0]],
        vertices[face[1]],
        vertices[face[2]],
      )) {
        bad.push(faceIndex);
      }
    }
    if (!bad.length) throw new Error("probe coverage triangulation could not insert a site");
    const badSet = new Set(bad);
    const edges = new Map();
    for (const faceIndex of bad) {
      const face = faces[faceIndex];
      for (const [a, b] of [[face[0], face[1]], [face[1], face[2]], [face[2], face[0]]]) {
        const key = triangulationEdgeKey(a, b);
        const edge = edges.get(key) || { a, b, count: 0 };
        edge.count++;
        edges.set(key, edge);
      }
    }
    faces = faces.filter((_, faceIndex) => !badSet.has(faceIndex));
    for (const edge of edges.values()) {
      if (edge.count !== 1) continue;
      if (Math.abs(triangleCross(vertices[edge.a], vertices[edge.b], insertion.point)) <= 1e-12) continue;
      faces.push(triangleCCW(vertices, [edge.a, edge.b, insertion.index]));
    }
  }
  const result = faces.filter((face) => face.every((index) => index < pointCount));
  const used = new Set(result.flat());
  if (used.size !== pointCount) throw new Error("probe coverage triangulation omitted a site");
  return result;
}

function probePointInCircumcircle(point, a, b, c) {
  const center = triangleCircumcenter(a, b, c);
  if (!center) return false;
  const radius2 = distance2(center, a);
  const tolerance = Math.max(1, radius2) * 1e-10;
  return distance2(center, point) <= radius2 + tolerance;
}

function triangleCircumcenter(a, b, c) {
  const denominator = 2 * (
    a.x * (b.y - c.y) +
    b.x * (c.y - a.y) +
    c.x * (a.y - b.y)
  );
  const scale = Math.max(
    Math.hypot(b.x - a.x, b.y - a.y),
    Math.hypot(c.x - b.x, c.y - b.y),
    Math.hypot(a.x - c.x, a.y - c.y),
    1,
  );
  if (Math.abs(denominator) <= scale * scale * 1e-12) return null;
  const aa = a.x * a.x + a.y * a.y;
  const bb = b.x * b.x + b.y * b.y;
  const cc = c.x * c.x + c.y * c.y;
  return {
    x: (aa * (b.y - c.y) + bb * (c.y - a.y) + cc * (a.y - b.y)) / denominator,
    y: (aa * (c.x - b.x) + bb * (a.x - c.x) + cc * (b.x - a.x)) / denominator,
  };
}

function nearestProbeSet(candidate, points) {
  let nearest = Infinity;
  let indices = [];
  for (let index = 0; index < points.length; index++) {
    const value = distance2(candidate, points[index]);
    if (!Number.isFinite(nearest)) {
      nearest = value;
      indices = [index];
      continue;
    }
    const tolerance = Math.max(1, nearest, value) * 1e-8;
    if (value < nearest - tolerance) {
      nearest = value;
      indices = [index];
    } else if (Math.abs(value - nearest) <= tolerance) {
      indices.push(index);
    }
  }
  return { distance2: nearest, indices };
}

function exactBoundaryProbeCriticalPoints(points, polygon) {
  const critical = [];
  for (let edgeIndex = 0; edgeIndex < polygon.length; edgeIndex++) {
    const a = polygon[edgeIndex];
    const b = polygon[(edgeIndex + 1) % polygon.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length2 = dx * dx + dy * dy;
    if (length2 <= 1e-18) continue;
    const lines = points.map((point, index) => ({
      slope: 2 * (dx * (a.x - point.x) + dy * (a.y - point.y)),
      intercept: distance2(a, point),
      index,
    })).sort((first, second) =>
      second.slope - first.slope ||
      first.intercept - second.intercept ||
      first.index - second.index
    );
    const unique = [];
    for (const line of lines) {
      const previous = unique.at(-1);
      const tolerance = Math.max(1, Math.abs(line.slope), Math.abs(previous?.slope || 0)) * 1e-12;
      if (previous && Math.abs(line.slope - previous.slope) <= tolerance) continue;
      unique.push(line);
    }
    const hull = [];
    for (const line of unique) {
      let start = -Infinity;
      while (hull.length) {
        const previous = hull.at(-1);
        start = (previous.line.intercept - line.intercept) / (line.slope - previous.line.slope);
        if (start > previous.start + 1e-12) break;
        hull.pop();
      }
      if (!hull.length) start = -Infinity;
      hull.push({ line, start });
    }
    const parameters = [0, 1];
    for (let index = 1; index < hull.length; index++) {
      if (hull[index].start > 0 && hull[index].start < 1) parameters.push(hull[index].start);
    }
    for (const t of parameters) {
      const point = { x: a.x + dx * t, y: a.y + dy * t };
      const nearest = nearestProbeSet(point, points);
      critical.push({
        point,
        distance2: nearest.distance2,
        nearest: nearest.indices,
        kind: "boundary",
        edge: edgeIndex,
      });
    }
  }
  return critical;
}

function largestProbeCoverageHole(points, domain, spacing) {
  if (!points.length || !domain.length) return { point: null, distance: 0 };
  const index = createProbeNearestIndex(points, spacing);
  let point = null;
  let distance2Value = -Infinity;
  for (const sample of domain) {
    const nearest = nearestIndexedProbe(index, sample).distance2;
    if (nearest > distance2Value + 1e-12) {
      point = sample;
      distance2Value = nearest;
    }
  }
  return { point, distance: Math.sqrt(Math.max(0, distance2Value)) };
}

function relaxProbeDistribution(points, fixedCount, domain, polygon, spacing, iteration) {
  if (points.length <= fixedCount || !domain.length) return 0;
  const index = createProbeNearestIndex(points, spacing);
  const sumX = new Float64Array(points.length);
  const sumY = new Float64Array(points.length);
  const counts = new Uint32Array(points.length);
  for (const sample of domain) {
    // Fixed boundary and first-ring sites own their actual Voronoi cells.
    // Samples assigned to those cells must not pull a deeper movable site
    // through the hard spacing barrier.
    const nearest = nearestIndexedProbe(index, sample);
    if (nearest.index < fixedCount) continue;
    sumX[nearest.index] += sample.x;
    sumY[nearest.index] += sample.y;
    counts[nearest.index]++;
  }
  const proposed = points.map((point) => ({ ...point }));
  const relaxation = 0.42;
  const maxStep = spacing * 0.28;
  for (let pointIndex = fixedCount; pointIndex < points.length; pointIndex++) {
    if (!counts[pointIndex]) continue;
    const point = points[pointIndex];
    let vx = (sumX[pointIndex] / counts[pointIndex] - point.x) * relaxation;
    let vy = (sumY[pointIndex] / counts[pointIndex] - point.y) * relaxation;
    const length = Math.hypot(vx, vy);
    if (length > maxStep) {
      vx *= maxStep / length;
      vy *= maxStep / length;
    }
    proposed[pointIndex].x += vx;
    proposed[pointIndex].y += vy;
  }
  projectProbeSpacingConstraints(proposed, points, fixedCount, polygon, spacing, iteration);
  if (!probeDistributionValid(proposed, fixedCount, polygon, spacing)) {
    let accepted = null;
    for (let attempt = 1; attempt <= 14; attempt++) {
      const alpha = Math.pow(2, -attempt);
      const blended = points.map((point, pointIndex) => pointIndex < fixedCount ? point : ({
        ...point,
        x: point.x + (proposed[pointIndex].x - point.x) * alpha,
        y: point.y + (proposed[pointIndex].y - point.y) * alpha,
      }));
      if (probeDistributionValid(blended, fixedCount, polygon, spacing)) {
        accepted = blended;
        break;
      }
    }
    if (!accepted) return 0;
    proposed.splice(0, proposed.length, ...accepted);
  }
  let maxMove = 0;
  for (let pointIndex = fixedCount; pointIndex < points.length; pointIndex++) {
    maxMove = Math.max(maxMove, Math.hypot(proposed[pointIndex].x - points[pointIndex].x, proposed[pointIndex].y - points[pointIndex].y));
    points[pointIndex].x = proposed[pointIndex].x;
    points[pointIndex].y = proposed[pointIndex].y;
  }
  return maxMove;
}

function createProbeNearestIndex(points, spacing) {
  const index = { spacing, points, cells: new Map() };
  for (let pointIndex = 0; pointIndex < points.length; pointIndex++) {
    const point = points[pointIndex];
    const cellX = Math.floor(point.x / spacing);
    const cellY = Math.floor(point.y / spacing);
    const key = cellX + ":" + cellY;
    const cell = index.cells.get(key) || [];
    cell.push(pointIndex);
    index.cells.set(key, cell);
  }
  return index;
}

function nearestIndexedProbe(index, candidate, minimumIndex = 0) {
  const cellX = Math.floor(candidate.x / index.spacing);
  const cellY = Math.floor(candidate.y / index.spacing);
  let bestIndex = -1;
  let bestDistance2 = Infinity;
  for (let radius = 0; radius <= 3; radius++) {
    for (let y = cellY - radius; y <= cellY + radius; y++) {
      for (let x = cellX - radius; x <= cellX + radius; x++) {
        if (radius && x > cellX - radius && x < cellX + radius && y > cellY - radius && y < cellY + radius) continue;
        for (const pointIndex of index.cells.get(x + ":" + y) || []) {
          if (pointIndex < minimumIndex) continue;
          const distance = distance2(candidate, index.points[pointIndex]);
          if (distance < bestDistance2) {
            bestDistance2 = distance;
            bestIndex = pointIndex;
          }
        }
      }
    }
    if (bestIndex >= 0 && bestDistance2 <= Math.pow(radius * index.spacing, 2)) break;
  }
  if (bestIndex < 0) {
    for (let pointIndex = minimumIndex; pointIndex < index.points.length; pointIndex++) {
      const distance = distance2(candidate, index.points[pointIndex]);
      if (distance < bestDistance2) {
        bestDistance2 = distance;
        bestIndex = pointIndex;
      }
    }
  }
  return { index: bestIndex, distance2: bestDistance2 };
}

function projectProbeSpacingConstraints(proposed, previous, fixedCount, polygon, spacing, iteration, passLimit = 10) {
  const target = spacing + 0.0002;
  for (let pass = 0; pass < passLimit; pass++) {
    let maxOverlap = 0;
    const index = createProbeNearestIndex(proposed, spacing);
    for (let i = 0; i < proposed.length; i++) {
      const cellX = Math.floor(proposed[i].x / spacing);
      const cellY = Math.floor(proposed[i].y / spacing);
      for (let y = cellY - 1; y <= cellY + 1; y++) {
        for (let x = cellX - 1; x <= cellX + 1; x++) {
          for (const j of index.cells.get(x + ":" + y) || []) {
            if (j <= i) continue;
            let dx = proposed[i].x - proposed[j].x;
            let dy = proposed[i].y - proposed[j].y;
            let distance = Math.hypot(dx, dy);
            if (distance >= target) continue;
            if (distance <= 1e-12) {
              const angle = ((i + 1) * 2.399963229728653 + (j + iteration + 1) * 0.7548776662466927);
              dx = Math.cos(angle);
              dy = Math.sin(angle);
              distance = 1;
            }
            const overlap = target - distance;
            const ux = dx / distance;
            const uy = dy / distance;
            const iFree = i >= fixedCount;
            const jFree = j >= fixedCount;
            if (!iFree && !jFree) continue;
            maxOverlap = Math.max(maxOverlap, overlap);
            if (iFree && jFree) {
              proposed[i].x += ux * overlap / 2;
              proposed[i].y += uy * overlap / 2;
              proposed[j].x -= ux * overlap / 2;
              proposed[j].y -= uy * overlap / 2;
            } else if (iFree) {
              proposed[i].x += ux * overlap;
              proposed[i].y += uy * overlap;
            } else if (jFree) {
              proposed[j].x -= ux * overlap;
              proposed[j].y -= uy * overlap;
            }
          }
        }
      }
    }
    for (let pointIndex = fixedCount; pointIndex < proposed.length; pointIndex++) {
      if (probeSpotFitsPolygon(proposed[pointIndex], polygon)) continue;
      proposed[pointIndex] = probePointInsideAlongMove(previous[pointIndex], proposed[pointIndex], polygon);
    }
    if (maxOverlap <= 0.0001) break;
  }
}

function probePointInsideAlongMove(previous, candidate, polygon) {
  if (probeSpotFitsPolygon(candidate, polygon)) return candidate;
  let low = 0;
  let high = 1;
  let best = { ...previous };
  for (let iteration = 0; iteration < 28; iteration++) {
    const ratio = (low + high) / 2;
    const point = {
      ...candidate,
      x: previous.x + (candidate.x - previous.x) * ratio,
      y: previous.y + (candidate.y - previous.y) * ratio,
    };
    if (probeSpotFitsPolygon(point, polygon)) {
      best = point;
      low = ratio;
    } else {
      high = ratio;
    }
  }
  return best;
}

function probeDistributionValid(points, fixedCount, polygon, spacing) {
  const spacingIndex = createProbeSpacingIndex([], spacing);
  for (let pointIndex = 0; pointIndex < points.length; pointIndex++) {
    const point = points[pointIndex];
    if (pointIndex >= fixedCount && !probeSpotFitsPolygon(point, polygon)) return false;
    if (pointIndex >= fixedCount && !probeSpacingIndexAllows(spacingIndex, point)) return false;
    addProbeSpacingPoint(spacingIndex, point);
  }
  return true;
}

function pointBounds(points) {
  const out = { x_min: Infinity, x_max: -Infinity, y_min: Infinity, y_max: -Infinity };
  for (const p of points) {
    out.x_min = Math.min(out.x_min, p.x);
    out.x_max = Math.max(out.x_max, p.x);
    out.y_min = Math.min(out.y_min, p.y);
    out.y_max = Math.max(out.y_max, p.y);
  }
  return out;
}

function probeSpotFitsPolygon(center, polygon) {
  if (!pointInPolygon(center, polygon)) return false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    if (distancePointToSegment(center, polygon[j], polygon[i]) < PROBE_SPOT_RADIUS_MM - 1e-9) return false;
  }
  return true;
}

function distancePointToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (!len2) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function polygonCentroid(points) {
  let twiceArea = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[j];
    const b = points[i];
    const cross = a.x * b.y - b.x * a.y;
    twiceArea += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  if (Math.abs(twiceArea) < 1e-9) return averagePoint(points);
  return { x: cx / (3 * twiceArea), y: cy / (3 * twiceArea) };
}

function averagePoint(points) {
  if (!points.length) return { x: 0, y: 0 };
  let x = 0;
  let y = 0;
  for (const point of points) {
    x += point.x;
    y += point.y;
  }
  return { x: x / points.length, y: y / points.length };
}

function distance2(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const crosses = ((a.y > point.y) !== (b.y > point.y)) &&
      (point.x < ((b.x - a.x) * (point.y - a.y)) / ((b.y - a.y) || 1e-12) + a.x);
    if (crosses) inside = !inside;
  }
  return inside;
}

function workPointToMachinePoint(p, origin) {
  const ox = axisValue(origin, "x");
  const oy = axisValue(origin, "y");
  const oz = axisValue(origin, "z");
  if (ox === null || oy === null) return null;
  const out = { x: Number(p.x) + ox, y: Number(p.y) + oy };
  if (axisValue(p, "z") !== null && oz !== null) out.z = Number(p.z) + oz;
  return out;
}

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

function pathNum(n) {
  if (!Number.isFinite(n)) return "0";
  const v = Math.abs(Number(n)) < 0.00005 ? 0 : Number(n);
  return v.toFixed(4).replace(/\.?0+$/, "");
}

function pathPoint(p) {
  return pathNum(p.x) + " " + pathNum(p.y);
}

function outlinePathD(points, closed, curveFit) {
  if (!points.length) return "";
  let d = "M " + pathPoint(points[0]);
  if (!curveFit || points.length < 3) {
    for (let i = 1; i < points.length; i++) d += " L " + pathPoint(points[i]);
    if (closed && points.length > 1) d += " Z";
    return d;
  }
  for (const segment of outlineCubicSegments(points, closed)) {
    d += " C " + pathPoint(segment.c1) + " " + pathPoint(segment.c2) + " " + pathPoint(segment.end);
  }
  return closed ? d + " Z" : d;
}

function outlineCubicSegments(points, closed) {
  if (points.length < 2) return [];
  const count = closed ? points.length : points.length - 1;
  const segments = [];
  for (let i = 0; i < count; i++) {
    const p0 = closed ? points[(i - 1 + points.length) % points.length] : (i === 0 ? points[i] : points[i - 1]);
    const p1 = points[i];
    const p2 = closed ? points[(i + 1) % points.length] : points[i + 1];
    const p3 = closed ? points[(i + 2) % points.length] : (i + 2 < points.length ? points[i + 2] : p2);
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    segments.push({ start: p1, c1, c2, end: p2 });
  }
  return segments;
}

function dxfPair(lines, code, value) {
  lines.push(String(code), String(value));
}

function dxfPairs(lines, pairs) {
  for (const [code, value] of pairs) dxfPair(lines, code, value);
}

function dxfNumber(value) {
  if (!Number.isFinite(value)) throw new Error("outline contains an invalid coordinate");
  return pathNum(value);
}

function dxfBounds(points) {
  return points.reduce((bounds, point) => ({
    minX: Math.min(bounds.minX, point.x),
    minY: Math.min(bounds.minY, point.y),
    maxX: Math.max(bounds.maxX, point.x),
    maxY: Math.max(bounds.maxY, point.y),
  }), {
    minX: points[0].x,
    minY: points[0].y,
    maxX: points[0].x,
    maxY: points[0].y,
  });
}

function addOutlinePolylineDXF(lines, points, closed) {
  dxfPairs(lines, [
    [0, "POLYLINE"],
    [8, "OUTLINE"],
    [66, 1],
    [70, closed ? 1 : 0],
    [10, 0],
    [20, 0],
    [30, 0],
  ]);
  for (const point of points) {
    dxfPairs(lines, [
      [0, "VERTEX"],
      [8, "OUTLINE"],
      [10, dxfNumber(point.x)],
      [20, dxfNumber(point.y)],
      [30, 0],
      [70, 0],
    ]);
  }
  dxfPairs(lines, [
    [0, "SEQEND"],
    [8, "OUTLINE"],
  ]);
}

function exportOutline() {
  try {
    if (state.outline.points.length < 2) throw new Error("outline needs at least two points");
    const dxf = buildOutlineDXF();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    downloadBlob("cnc-outline-" + stamp + ".dxf", dxf, "application/dxf");
    setOutlineFeedback("DXF export started.", "ok");
  } catch (e) {
    setOutlineFeedback("Export failed: " + e.message, "error");
  }
}

function outlineJSONDocument() {
  const o = state.outline;
  if (o.points.length < 2) throw new Error("outline needs at least two points");
  return {
    app: "cnc-proxy",
    kind: "capture-outline",
    version: 1,
    units: "mm",
    outline: {
      points: o.points.map(cloneOutlinePoint),
      closed: !!o.closed,
      curve_fit: !!o.curveFit,
      origin: cloneOutlineOrigin(o.origin),
      field_spot_gap_mm: fieldProbeSpotGap(),
      floor_machine_z: Number.isFinite(o.floorMachineZ) ? o.floorMachineZ : null,
      floor_probe: cloneFloorProbe(o.floorProbe),
      field_reference_machine_z: Number.isFinite(o.fieldReferenceMachineZ) ? o.fieldReferenceMachineZ : null,
      field_reference_kind: o.fieldReferenceKind || "",
      field_probe_complete: !!o.fieldProbeComplete,
      field_probe_results: o.fieldProbeResults.map(cloneOutlinePoint),
    },
  };
}

function saveOutlineJSON() {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    downloadBlob("cnc-outline-" + stamp + ".json", JSON.stringify(outlineJSONDocument(), null, 2) + "\n", "application/json");
    setOutlineFeedback("Outline JSON export started.", "ok");
  } catch (e) {
    setOutlineFeedback("Save outline failed: " + e.message, "error");
  }
}

async function loadOutlineFile(file) {
  if (!file) return;
  const current = state.outline;
  if (current.points.length && !confirm("Load this outline and replace the current captured outline?")) return;
  current.filePending = true;
  setStatusMessage("outline", "Loading outline...", "", { force: true });
  renderOutlineCapture();
  try {
    const next = outlineStateFromJSON(JSON.parse(await file.text()));
    installLoadedOutlineState(next);
    renderOutlineCapture();
    renderWorkArea();
    setStatusMessage("outline", "Loaded outline with " + next.points.length + " points.", "ok", { force: true });
  } catch (e) {
    current.filePending = false;
    renderOutlineCapture();
    setStatusMessage("outline", "Load outline failed: " + e.message, "error", { force: true });
  }
}

function installLoadedOutlineState(next) {
  cancelOutlineCaptureIntents(state.outline);
  state.outline = next;
  markGcodeContextOverlayDirty();
  if (next.closed) updateFieldProbePreview();
}

function outlineStateFromJSON(doc) {
  if (!doc || doc.app !== "cnc-proxy" || doc.kind !== "capture-outline" || doc.version !== 1 || doc.units !== "mm") {
    throw new Error("file is not a CNC Proxy outline JSON export");
  }
  const raw = doc.outline;
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.points)) {
    throw new Error("outline points are missing");
  }
  if (raw.points.length < 2 || raw.points.length > MAX_EFFECTIVE_OUTLINE_POINTS) {
    throw new Error("outline must contain between 2 and " + MAX_EFFECTIVE_OUTLINE_POINTS + " points");
  }
  const next = defaultOutlineState();
  next.active = true;
  next.points = raw.points.map((point, i) => outlinePointFromJSON(point, i + 1));
  next.closed = !!raw.closed;
  next.curveFit = !!raw.curve_fit;
  next.origin = outlineOriginFromJSON(raw.origin);
  next.fieldSpotGapMM = boundedOutlineNumber(raw.field_spot_gap_mm, 0, 250, DEFAULT_FIELD_SPOT_GAP_MM);
  next.floorProbe = floorProbeFromJSON(raw.floor_probe);
  const floorMachineZ = Number(raw.floor_machine_z);
  next.floorMachineZ = next.floorProbe?.machine_z ??
    (raw.floor_machine_z !== null && raw.floor_machine_z !== "" && Number.isFinite(floorMachineZ) ? floorMachineZ : null);
  const fieldReferenceMachineZ = Number(raw.field_reference_machine_z);
  next.fieldReferenceMachineZ = raw.field_reference_machine_z !== null && raw.field_reference_machine_z !== "" && Number.isFinite(fieldReferenceMachineZ)
    ? fieldReferenceMachineZ
    : (Number.isFinite(next.floorMachineZ) ? next.floorMachineZ : axisValue(next.origin, "z"));
  next.fieldReferenceKind = raw.field_reference_kind === "floor" || raw.field_reference_kind === "work_origin"
    ? raw.field_reference_kind
    : (Number.isFinite(next.floorMachineZ) ? "floor" : (Number.isFinite(next.fieldReferenceMachineZ) ? "work_origin" : ""));
  const samples = raw.field_probe_results == null ? [] : raw.field_probe_results;
  if (!Array.isArray(samples) || samples.length > MAX_FIELD_PROBE_POINTS) {
    throw new Error("field probe samples are invalid");
  }
  next.fieldProbeResults = samples.map((point, i) => outlinePointFromJSON(point, i + 1));
  next.fieldProbeComplete = raw.field_probe_complete === true && next.fieldProbeResults.length >= 3;
  return next;
}

function floorProbeFromJSON(raw) {
  if (raw == null) return null;
  if (typeof raw !== "object") throw new Error("floor probe is invalid");
  const probe = cloneFloorProbe(raw);
  if (!probe) throw new Error("floor probe coordinates are invalid");
  return probe;
}

function outlineOriginFromJSON(raw) {
  if (raw == null) return null;
  if (typeof raw !== "object") throw new Error("outline origin is invalid");
  const origin = {};
  for (const axis of ["x", "y", "z"]) {
    const value = Number(raw[axis]);
    if (Number.isFinite(value)) origin[axis] = value;
  }
  if (!Object.keys(origin).length) throw new Error("outline origin is invalid");
  return origin;
}

function boundedOutlineNumber(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

function outlinePointFromJSON(raw, index) {
  if (!raw || typeof raw !== "object") throw new Error("outline point " + index + " is invalid");
  const point = {};
  for (const field of ["x", "y", "z", "machine_x", "machine_y", "machine_z"]) {
    const value = Number(raw[field]);
    if (!Number.isFinite(value)) throw new Error("outline point " + index + " is missing " + field);
    point[field] = value;
  }
  point.id = typeof raw.id === "string" && raw.id ? raw.id.slice(0, 160) : newID("outline-point");
  point.captured_at = typeof raw.captured_at === "string" ? raw.captured_at.slice(0, 80) : "";
  point.probed = !!raw.probed;
  point.probe_kind = typeof raw.probe_kind === "string" ? raw.probe_kind.slice(0, 24) : "";
  point.probe_output = typeof raw.probe_output === "string" ? raw.probe_output.slice(0, 4096) : "";
  return point;
}

function downloadBlob(filename, content, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function exportWorkOrigin() {
  for (const candidate of [currentWorkOrigin(), state.outline.origin]) {
    const origin = cloneOutlineOrigin(candidate);
    if (axisValue(origin, "x") !== null && axisValue(origin, "y") !== null) return origin;
  }
  throw new Error("current XY work origin is unavailable");
}

function requireHeightExportOutline() {
  if (!state.outline.closed || state.outline.points.length < 3) {
    throw new Error("closed outline needs at least three points");
  }
}

function buildOutlineDXF() {
  const origin = exportWorkOrigin();
  let points = state.outline.curveFit && state.outline.points.length >= 3
    ? outlineEffectiveExportPoints(origin)
    : outlineExportPoints(origin);
  if (state.outline.closed && points.length > 2) {
    const first = points[0];
    const last = points[points.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) <= 0.00005) points = points.slice(0, -1);
  }
  if (points.length < 2) throw new Error("outline needs at least two valid points");
  for (const point of points) {
    dxfNumber(point.x);
    dxfNumber(point.y);
  }

  const bounds = dxfBounds(points);
  const lines = [];
  dxfPairs(lines, [
    [0, "SECTION"],
    [2, "HEADER"],
    [9, "$ACADVER"],
    [1, "AC1009"],
    [9, "$INSBASE"],
    [10, 0],
    [20, 0],
    [30, 0],
    [9, "$INSUNITS"],
    [70, 4],
    [9, "$MEASUREMENT"],
    [70, 1],
    [9, "$EXTMIN"],
    [10, dxfNumber(bounds.minX)],
    [20, dxfNumber(bounds.minY)],
    [30, 0],
    [9, "$EXTMAX"],
    [10, dxfNumber(bounds.maxX)],
    [20, dxfNumber(bounds.maxY)],
    [30, 0],
    [0, "ENDSEC"],
    [0, "SECTION"],
    [2, "TABLES"],
    [0, "TABLE"],
    [2, "LTYPE"],
    [70, 1],
    [0, "LTYPE"],
    [2, "CONTINUOUS"],
    [70, 64],
    [3, "Solid line"],
    [72, 65],
    [73, 0],
    [40, 0],
    [0, "ENDTAB"],
    [0, "TABLE"],
    [2, "LAYER"],
    [70, 2],
    [0, "LAYER"],
    [2, "0"],
    [70, 0],
    [62, 7],
    [6, "CONTINUOUS"],
    [0, "LAYER"],
    [2, "OUTLINE"],
    [70, 0],
    [62, 7],
    [6, "CONTINUOUS"],
    [0, "ENDTAB"],
    [0, "ENDSEC"],
    [0, "SECTION"],
    [2, "ENTITIES"],
  ]);
  addOutlinePolylineDXF(lines, points, state.outline.closed);
  dxfPairs(lines, [
    [0, "ENDSEC"],
    [0, "EOF"],
  ]);
  return lines.join("\r\n") + "\r\n";
}

function outlineExportPoints(origin) {
  const ox = axisValue(origin, "x");
  const oy = axisValue(origin, "y");
  const oz = axisValue(origin, "z");
  return state.outline.points.map((p) => {
    const mx = Number(p.machine_x);
    const my = Number(p.machine_y);
    const mz = Number(p.machine_z);
    return {
      x: Number.isFinite(mx) && ox !== null ? mx - ox : p.x,
      y: Number.isFinite(my) && oy !== null ? my - oy : p.y,
      z: Number.isFinite(mz) && oz !== null ? mz - oz : p.z,
      captured_at: p.captured_at,
      probed: !!p.probed,
    };
  });
}

function outlineEffectiveExportPoints(origin) {
  const raw = outlineExportPoints(origin);
  const geometry = effectiveOutlineGeometry(raw, state.outline.closed, state.outline.curveFit);
  if (geometry.limited) throw new Error("curve fit generated too many outline points");
  return geometry.points;
}

function fieldProbeExportPoints(origin) {
  const ox = axisValue(origin, "x");
  const oy = axisValue(origin, "y");
  const reference = fieldProbeHeightReference(origin);
  return state.outline.fieldProbeResults.map((p) => {
    const mx = Number(p.machine_x);
    const my = Number(p.machine_y);
    const mz = Number(p.machine_z);
    return {
      x: Number.isFinite(mx) && ox !== null ? mx - ox : p.x,
      y: Number.isFinite(my) && oy !== null ? my - oy : p.y,
      z: Number.isFinite(mz) ? mz - reference.machineZ : p.z,
      captured_at: p.captured_at,
      probe_kind: p.probe_kind,
    };
  });
}

function fieldProbeHeightReference(origin) {
  const o = state.outline;
  const floorZ = finiteOr(o.floorMachineZ, NaN);
  if (Number.isFinite(floorZ)) return { machineZ: floorZ, kind: "floor", label: "probed floor" };
  const storedZ = finiteOr(o.fieldReferenceMachineZ, NaN);
  if (Number.isFinite(storedZ)) return { machineZ: storedZ, kind: "work_origin", label: "captured Z origin" };
  const originZ = axisValue(origin, "z");
  if (originZ !== null) return { machineZ: originZ, kind: "work_origin", label: "current Z origin" };
  throw new Error("field probe Z reference is unavailable");
}

function exportExtents(table, points) {
  let minX = table.x_min;
  let maxX = table.x_max;
  let minY = table.y_min;
  let maxY = table.y_max;
  for (const p of points) {
    if (Number.isFinite(p.x)) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
    }
    if (Number.isFinite(p.y)) {
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) {
    minX = 0;
    maxX = 1;
  }
  if (!Number.isFinite(minY) || !Number.isFinite(maxY)) {
    minY = 0;
    maxY = 1;
  }
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  return { x_min: minX, x_max: maxX, y_min: minY, y_max: maxY, width, height };
}

function exportHeightOBJ() {
  try {
    const obj = buildHeightOBJ();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    downloadBlob("cnc-outline-height-" + stamp + ".obj", obj, "text/plain");
    setOutlineFeedback("OBJ export started.", "ok");
  } catch (e) {
    setOutlineFeedback("OBJ export failed: " + e.message, "error");
  }
}

function buildHeightOBJ() {
  requireHeightExportOutline();
  const origin = exportWorkOrigin();
  const outline = outlineEffectiveExportPoints(origin);
  const samples = fieldProbeExportPoints(origin).filter((point) => [point.x, point.y, point.z].every(Number.isFinite));
  if (samples.length < 3) throw new Error("field probe needs at least three samples");
  const meshVertices = buildHeightMeshVertices(samples, outline);
  const triangulationPoints = [];
  const triangulationVertexIndices = [];
  for (let index = 0; index < meshVertices.length; index++) {
    const point = meshVertices[index];
    if (triangulationPoints.some((seen) => Math.hypot(seen.x - point.x, seen.y - point.y) <= 0.000001)) continue;
    triangulationPoints.push(point);
    triangulationVertexIndices.push(index);
  }
  if (triangulationPoints.length < 3) throw new Error("field probe needs at least three distinct XY sample positions");
  const topFaces = constrainedOutlineTriangles(triangulationPoints, outline)
    .map((face) => face.map((index) => triangulationVertexIndices[index]));
  if (!topFaces.length) throw new Error("field probe samples could not form a mesh inside the outline");
  const boundary = orderedOutlineBoundaryIndices(triangulationPoints, outline)
    .map((index) => triangulationVertexIndices[index]);
  const solid = solidifyHeightMesh(meshVertices, topFaces, boundary, 0);
  const reference = fieldProbeHeightReference(origin);
  const originX = axisValue(origin, "x") ?? 0;
  const originY = axisValue(origin, "y") ?? 0;
  const lines = [
    "# CNC Proxy outline field Z probe",
    "# units: millimeters (OBJ is unitless; choose Millimeter in Fusion Insert Mesh)",
    "# coordinate system: CNC work coordinates, right-handed Z-up",
    "# axis mapping: OBJ X=CNC X, OBJ Y=CNC Y, OBJ Z=CNC Z",
    "# triangulation: constrained Delaunay with locked outline edges",
    "# xy coordinates: CNC work coordinates",
    "# cnc_xy_origin_machine_mm: " + pathNum(originX) + " " + pathNum(originY),
    "# CNC Z coordinates: " + reference.label,
    "# z_reference_machine_mm: " + pathNum(reference.machineZ),
    "# solid: sampled top, vertical outline walls, flat underside at Z=0",
    "# sample_count: " + samples.length,
    "# mesh_vertex_count: " + meshVertices.length,
    "# solid_vertex_count: " + solid.vertices.length,
    "o outline_field_probe",
    "s off",
  ];
  for (const point of solid.vertices) {
    lines.push("v " + pathNum(point.x) + " " + pathNum(point.y) + " " + pathNum(point.z));
  }
  lines.push("# faces: top");
  for (const face of topFaces) lines.push("f " + face.map((index) => index + 1).join(" "));
  lines.push("# faces: underside");
  for (const face of solid.undersideFaces) lines.push("f " + face.map((index) => index + 1).join(" "));
  lines.push("# faces: perimeter");
  for (const face of solid.wallFaces) lines.push("f " + face.map((index) => index + 1).join(" "));
  const used = new Set(topFaces.flat());
  lines.push("# points: unused coincident probe samples");
  for (let index = 0; index < meshVertices.length; index++) {
    if (!used.has(index)) lines.push("p " + (index + 1));
  }
  return lines.join("\n") + "\n";
}

function solidifyHeightMesh(meshVertices, topFaces, boundary, undersideZ) {
  if (!Number.isFinite(undersideZ)) throw new Error("solid mesh underside Z is unavailable");
  if (boundary.length < 3) throw new Error("solid mesh needs at least three boundary vertices");
  const vertices = meshVertices.map((point) => ({ ...point }));
  const usedTopIndices = [...new Set(topFaces.flat())].sort((a, b) => a - b);
  const bottomIndexByTop = new Map();
  for (const topIndex of usedTopIndices) {
    const top = meshVertices[topIndex];
    if (!top) throw new Error("solid mesh contains an invalid top vertex");
    if (top.z === undersideZ) {
      bottomIndexByTop.set(topIndex, topIndex);
      continue;
    }
    bottomIndexByTop.set(topIndex, vertices.length);
    vertices.push({ x: top.x, y: top.y, z: undersideZ });
  }
  const bottomIndex = (topIndex) => {
    const index = bottomIndexByTop.get(topIndex);
    if (index === undefined) throw new Error("solid mesh boundary is not part of the top surface");
    return index;
  };
  const undersideFaces = topFaces.map((face) =>
    face.slice().reverse().map((topIndex) => bottomIndex(topIndex))
  );
  const wallFaces = [];
  for (let index = 0; index < boundary.length; index++) {
    const topA = boundary[index];
    const topB = boundary[(index + 1) % boundary.length];
    const bottomA = bottomIndex(topA);
    const bottomB = bottomIndex(topB);
    for (const face of [[topA, bottomA, bottomB], [topA, bottomB, topB]]) {
      if (new Set(face).size === 3) wallFaces.push(face);
    }
  }
  return { vertices, undersideFaces, wallFaces };
}

function buildHeightMeshVertices(samples, outline) {
  const vertices = samples.map((point) => ({ ...point }));
  if (outline.length < 3) return vertices;
  for (let index = 0; index < outline.length; index++) {
    const previous = outline[(index - 1 + outline.length) % outline.length];
    const point = outline[index];
    const next = outline[(index + 1) % outline.length];
    const inX = point.x - previous.x;
    const inY = point.y - previous.y;
    const outX = next.x - point.x;
    const outY = next.y - point.y;
    const inLength = Math.hypot(inX, inY);
    const outLength = Math.hypot(outX, outY);
    if (inLength <= 1e-9 || outLength <= 1e-9) continue;
    const cosine = Math.max(-1, Math.min(1, (inX * outX + inY * outY) / (inLength * outLength)));
    if (1 - cosine < 0.08) continue;
    if (vertices.some((seen) => Math.hypot(seen.x - point.x, seen.y - point.y) <= 0.000001)) continue;
    vertices.push({
      x: point.x,
      y: point.y,
      z: interpolateZ(point.x, point.y, samples),
      probe_kind: "mesh_outline",
    });
  }
  return vertices;
}

function triangleCCW(points, face) {
  const a = points[face[0]], b = points[face[1]], c = points[face[2]];
  const twiceArea = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  return twiceArea < 0 ? [face[0], face[2], face[1]] : face;
}

function constrainedOutlineTriangles(points, outline) {
  const boundary = orderedOutlineBoundaryIndices(points, outline);
  if (boundary.length < 3) throw new Error("field probe needs at least three outline or border samples");
  let faces = triangulateBoundaryRing(points, boundary);
  const boundarySet = new Set(boundary);
  for (let index = 0; index < points.length; index++) {
    if (boundarySet.has(index)) continue;
    faces = insertTriangulationPoint(points, faces, index);
  }
  const constrainedEdges = new Set(boundary.map((vertex, index) =>
    triangulationEdgeKey(vertex, boundary[(index + 1) % boundary.length])
  ));
  return improveConstrainedDelaunay(points, faces, constrainedEdges);
}

function orderedOutlineBoundaryIndices(points, outline) {
  const projections = points.map((point, index) => ({
    index,
    kind: point.probe_kind,
    projection: projectPointToClosedPath(point, outline),
  }));
  const hasKinds = projections.some(({ kind }) => kind === "outline" || kind === "border" || kind === "mesh_outline");
  const boundary = projections.filter(({ kind, projection }) =>
    hasKinds ? kind === "outline" || kind === "border" || kind === "mesh_outline" : projection.distance <= 0.05
  );
  boundary.sort((a, b) => a.projection.along - b.projection.along || a.index - b.index);
  const indices = boundary.map(({ index }) => index);
  if (polygonIndexArea(points, indices) < 0) indices.reverse();
  return indices;
}

function projectPointToClosedPath(point, outline) {
  let along = 0;
  let best = { distance: Infinity, along: 0 };
  for (let index = 0; index < outline.length; index++) {
    const a = outline[index];
    const b = outline[(index + 1) % outline.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    if (length <= 1e-12) continue;
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (length * length)));
    const x = a.x + dx * t;
    const y = a.y + dy * t;
    const distance = Math.hypot(point.x - x, point.y - y);
    if (distance < best.distance - 1e-9 || (Math.abs(distance - best.distance) <= 1e-9 && along + t * length < best.along)) {
      best = { distance, along: along + t * length };
    }
    along += length;
  }
  return best;
}

function polygonIndexArea(points, indices) {
  let twiceArea = 0;
  for (let index = 0; index < indices.length; index++) {
    const a = points[indices[index]];
    const b = points[indices[(index + 1) % indices.length]];
    twiceArea += a.x * b.y - b.x * a.y;
  }
  return twiceArea / 2;
}

function triangulateBoundaryRing(points, boundary) {
  const remaining = boundary.slice();
  const faces = [];
  let guard = remaining.length * remaining.length;
  while (remaining.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let index = 0; index < remaining.length; index++) {
      const prev = remaining[(index - 1 + remaining.length) % remaining.length];
      const current = remaining[index];
      const next = remaining[(index + 1) % remaining.length];
      if (triangleCross(points[prev], points[current], points[next]) <= 1e-10) continue;
      const containsBoundary = remaining.some((candidate) =>
        candidate !== prev && candidate !== current && candidate !== next &&
        pointInTriangle2D(points[candidate], points[prev], points[current], points[next])
      );
      if (containsBoundary) continue;
      faces.push([prev, current, next]);
      remaining.splice(index, 1);
      clipped = true;
      break;
    }
    if (!clipped) throw new Error("probed outline boundary could not be triangulated");
  }
  if (remaining.length === 3 && Math.abs(triangleCross(points[remaining[0]], points[remaining[1]], points[remaining[2]])) > 1e-10) {
    faces.push(triangleCCW(points, remaining));
  }
  if (!faces.length) throw new Error("probed outline boundary could not form a mesh");
  return faces;
}

function insertTriangulationPoint(points, faces, pointIndex) {
  const point = points[pointIndex];
  const containingIndex = faces.findIndex((face) =>
    pointInTriangle2D(point, points[face[0]], points[face[1]], points[face[2]])
  );
  if (containingIndex < 0) throw new Error("field probe sample lies outside the probed outline boundary");
  const containing = faces[containingIndex];
  const hitEdge = [[containing[0], containing[1]], [containing[1], containing[2]], [containing[2], containing[0]]]
    .find(([a, b]) => pointOnSegment2D(point, points[a], points[b]));
  if (hitEdge) {
    const [edgeA, edgeB] = hitEdge;
    const adjacent = [];
    for (let index = 0; index < faces.length; index++) {
      if (faces[index].includes(edgeA) && faces[index].includes(edgeB)) adjacent.push(index);
    }
    const adjacentSet = new Set(adjacent);
    const nextFaces = faces.filter((_, index) => !adjacentSet.has(index));
    for (const index of adjacent) {
      const opposite = faces[index].find((vertex) => vertex !== edgeA && vertex !== edgeB);
      nextFaces.push(triangleCCW(points, [edgeA, pointIndex, opposite]));
      nextFaces.push(triangleCCW(points, [pointIndex, edgeB, opposite]));
    }
    return nextFaces;
  }
  const nextFaces = faces.slice();
  nextFaces.splice(containingIndex, 1,
    triangleCCW(points, [containing[0], containing[1], pointIndex]),
    triangleCCW(points, [containing[1], containing[2], pointIndex]),
    triangleCCW(points, [containing[2], containing[0], pointIndex]));
  return nextFaces;
}

function triangleCross(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function pointInTriangle2D(point, a, b, c) {
  const epsilon = 1e-8;
  const ab = triangleCross(a, b, point);
  const bc = triangleCross(b, c, point);
  const ca = triangleCross(c, a, point);
  return ab >= -epsilon && bc >= -epsilon && ca >= -epsilon;
}

function pointOnSegment2D(point, a, b) {
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length <= 1e-12 || Math.abs(triangleCross(a, b, point)) > Math.max(1, length) * 1e-8) return false;
  const dot = (point.x - a.x) * (point.x - b.x) + (point.y - a.y) * (point.y - b.y);
  return dot < -1e-8;
}

function improveConstrainedDelaunay(points, faces, constrainedEdges) {
  const optimized = faces.map((face) => triangleCCW(points, face));
  const maxPasses = Math.max(16, points.length * 4);
  for (let pass = 0; pass < maxPasses; pass++) {
    let flipCount = 0;
    const touchedFaces = new Set();
    for (const edge of triangulationEdges(optimized).values()) {
      if (edge.faces.length !== 2 || constrainedEdges.has(edge.key)) continue;
      const [firstIndex, secondIndex] = edge.faces;
      if (touchedFaces.has(firstIndex) || touchedFaces.has(secondIndex)) continue;
      const oppositeA = optimized[firstIndex].find((vertex) => vertex !== edge.a && vertex !== edge.b);
      const oppositeB = optimized[secondIndex].find((vertex) => vertex !== edge.a && vertex !== edge.b);
      if (oppositeA === undefined || oppositeB === undefined || oppositeA === oppositeB) continue;
      if (!quadrilateralAllowsFlip(points, edge.a, edge.b, oppositeA, oppositeB)) continue;
      if (!pointInsideCircumcircle(points[edge.a], points[edge.b], points[oppositeA], points[oppositeB])) continue;
      optimized[firstIndex] = triangleCCW(points, [oppositeA, oppositeB, edge.a]);
      optimized[secondIndex] = triangleCCW(points, [oppositeB, oppositeA, edge.b]);
      touchedFaces.add(firstIndex);
      touchedFaces.add(secondIndex);
      flipCount++;
    }
    if (!flipCount) return optimized;
  }
  throw new Error("constrained field triangulation did not converge");
}

function triangulationEdges(faces) {
  const edges = new Map();
  for (let faceIndex = 0; faceIndex < faces.length; faceIndex++) {
    const face = faces[faceIndex];
    for (const [a, b] of [[face[0], face[1]], [face[1], face[2]], [face[2], face[0]]]) {
      const key = triangulationEdgeKey(a, b);
      const edge = edges.get(key) || { key, a: Math.min(a, b), b: Math.max(a, b), faces: [] };
      edge.faces.push(faceIndex);
      edges.set(key, edge);
    }
  }
  return edges;
}

function triangulationEdgeKey(a, b) {
  return Math.min(a, b) + ":" + Math.max(a, b);
}

function quadrilateralAllowsFlip(points, edgeA, edgeB, oppositeA, oppositeB) {
  const sideA = triangleCross(points[oppositeA], points[oppositeB], points[edgeA]);
  const sideB = triangleCross(points[oppositeA], points[oppositeB], points[edgeB]);
  const scale = Math.max(
    Math.hypot(points[oppositeB].x - points[oppositeA].x, points[oppositeB].y - points[oppositeA].y),
    1,
  );
  return sideA * sideB < -Math.pow(scale, 4) * 1e-18;
}

function pointInsideCircumcircle(a, b, c, point) {
  const ax = a.x - point.x;
  const ay = a.y - point.y;
  const bx = b.x - point.x;
  const by = b.y - point.y;
  const cx = c.x - point.x;
  const cy = c.y - point.y;
  const determinant =
    (ax * ax + ay * ay) * (bx * cy - by * cx) -
    (bx * bx + by * by) * (ax * cy - ay * cx) +
    (cx * cx + cy * cy) * (ax * by - ay * bx);
  const orientation = triangleCross(a, b, c);
  const scale = Math.max(Math.abs(ax), Math.abs(ay), Math.abs(bx), Math.abs(by), Math.abs(cx), Math.abs(cy), 1);
  const epsilon = Math.pow(scale, 4) * 1e-12;
  return orientation > 0 ? determinant > epsilon : determinant < -epsilon;
}

function pointInPolygonOrBoundary(point, polygon) {
  if (pointInPolygon(point, polygon)) return true;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    if (distancePointToSegment(point, polygon[j], polygon[i]) <= 0.00001) return true;
  }
  return false;
}

function exportHeightImage() {
  try {
    const pgm = buildHeightPGM();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    downloadBlob("cnc-outline-height-" + stamp + ".pgm", pgm, "image/x-portable-graymap");
    setOutlineFeedback("Height image export started.", "ok");
  } catch (e) {
    setOutlineFeedback("Height image export failed: " + e.message, "error");
  }
}

function buildHeightPGM() {
  requireHeightExportOutline();
  const origin = exportWorkOrigin();
  const mesh = buildInterpolatedHeightGrid(origin);
  const values = [];
  for (const row of mesh.points) {
    for (const p of row) if (p) values.push(p.z);
  }
  if (!values.length) throw new Error("field probe has no samples inside the outline");
  const minZ = Math.min(...values);
  const maxZ = Math.max(...values);
  const span = maxZ - minZ || 1;
  const reference = fieldProbeHeightReference(origin);
  const originX = axisValue(origin, "x") ?? 0;
  const originY = axisValue(origin, "y") ?? 0;
  const rows = [
    "P2",
    "# CNC Proxy outline height image",
    "# units: mm",
    "# xy coordinates: CNC work coordinates",
    "# cnc_xy_origin_machine_mm: " + pathNum(originX) + " " + pathNum(originY),
    "# z coordinates: " + reference.label,
    "# z_reference_machine_mm: " + pathNum(reference.machineZ),
    "# x_min_mm: " + pathNum(mesh.xMin),
    "# x_max_mm: " + pathNum(mesh.xMax),
    "# y_min_mm: " + pathNum(mesh.yMin),
    "# y_max_mm: " + pathNum(mesh.yMax),
    "# x_spacing_mm: " + pathNum(mesh.xSpacing),
    "# y_spacing_mm: " + pathNum(mesh.ySpacing),
    "# raster_columns: X min to X max",
    "# raster_rows: Y max to Y min",
    "# probe_diameter_mm: " + pathNum(PROBE_SPOT_DIAMETER_MM),
    "# spot_gap_mm: " + pathNum(fieldProbeSpotGap()),
    "# z_min_mm: " + pathNum(minZ),
    "# z_max_mm: " + pathNum(maxZ),
    mesh.cols + " " + mesh.rows,
    "65535",
  ];
  for (let r = mesh.rows - 1; r >= 0; r--) {
    const row = [];
    for (let c = 0; c < mesh.cols; c++) {
      const p = mesh.points[r][c];
      row.push(p ? String(Math.round(((p.z - minZ) / span) * 65535)) : "0");
    }
    rows.push(row.join(" "));
  }
  return rows.join("\n") + "\n";
}

function buildInterpolatedHeightGrid(origin) {
  requireHeightExportOutline();
  const rawOutline = outlineExportPoints(origin);
  const outline = outlineEffectiveExportPoints(origin);
  const samples = fieldProbeExportPoints(origin);
  if (rawOutline.length < 3 || outline.length < 3) throw new Error("closed outline needs at least three valid points");
  if (samples.length < 3) throw new Error("field probe needs at least three samples");
  const ext = exportExtents({ x_min: Infinity, x_max: -Infinity, y_min: Infinity, y_max: -Infinity }, outline);
  const spacing = fieldProbeCenterSpacing();
  const cols = Math.max(2, Math.min(512, Math.floor(ext.width / spacing) + 1));
  const rows = Math.max(2, Math.min(512, Math.floor(ext.height / spacing) + 1));
  const actualX = ext.width / Math.max(1, cols - 1);
  const actualY = ext.height / Math.max(1, rows - 1);
  const grid = [];
  for (let r = 0; r < rows; r++) {
    const y = ext.y_min + r * actualY;
    const row = [];
    for (let c = 0; c < cols; c++) {
      const x = ext.x_min + c * actualX;
      if (!pointInPolygonOrBoundary({ x, y }, outline)) {
        row.push(null);
        continue;
      }
      row.push({ x, y, z: interpolateZ(x, y, samples) });
    }
    grid.push(row);
  }
  return {
    points: grid,
    rows,
    cols,
    xMin: ext.x_min,
    xMax: ext.x_max,
    yMin: ext.y_min,
    yMax: ext.y_max,
    xSpacing: actualX,
    ySpacing: actualY,
  };
}

function interpolateZ(x, y, samples) {
  let num = 0;
  let den = 0;
  for (const s of samples) {
    const dx = x - s.x;
    const dy = y - s.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < 1e-9) return s.z;
    const w = 1 / d2;
    num += s.z * w;
    den += w;
  }
  return den ? num / den : 0;
}

function renderGamepadSettings() {
  const gp = state.ui.gamepad || defaultGamepadSettings();
  for (const axis of ["x", "y", "z"]) {
    const cfg = gp.axes[axis];
    const pct = Math.round(cfg.scale * 100);
    setControlValueIfIdle("gamepad-axis-" + axis, cfg.axis);
    setCheckedIfIdle("gamepad-invert-" + axis, cfg.invert);
    setControlValueIfIdle("gamepad-speed-" + axis, pct);
    document.getElementById("gamepad-speed-" + axis + "-value").textContent = pct + "%";
  }
  setControlValueIfIdle("gamepad-deadman-button", gp.deadman_button);
  setControlValueIfIdle("gamepad-slow-button-0", gp.slow_buttons[0] ?? "");
  setControlValueIfIdle("gamepad-slow-button-1", gp.slow_buttons[1] ?? "");
  setControlValueIfIdle("gamepad-outline-button", gp.outline_button);
  renderGamepadMacroBindings();
}

function renderGamepadMacroBindings(opts = {}) {
  const box = document.getElementById("gamepad-macro-bindings");
  if (!opts.force && gamepadMacroBindingsLocallyOwned(box)) return;
  state.gamepadMacroBindingDirty = false;
  box.innerHTML = "";
  if (!state.ui.gamepad.macro_buttons.length) {
    box.innerHTML = `<div class="empty compact">No gamepad macro buttons.</div>`;
    return;
  }
  for (const binding of state.ui.gamepad.macro_buttons) {
    const row = document.createElement("div");
    row.className = "gamepad-binding";

    const button = document.createElement("input");
    button.type = "number";
    button.min = "0";
    button.max = "63";
    button.value = String(binding.button);
    button.oninput = () => {
      state.gamepadMacroBindingDirty = true;
      markControlDirty(button);
    };
    button.onfocus = () => {
      state.gamepadMacroBindingDirty = true;
    };
    button.onblur = () => {
      if (button.dataset.dirty !== "1") state.gamepadMacroBindingDirty = false;
    };
    button.onchange = () => {
      const next = readInt(button.value, binding.button, 0, 63);
      binding.button = next;
      clearControlDrafts(button);
      state.gamepadMacroBindingDirty = false;
      normalizeGamepadMacroOrder();
      renderGamepadMacroBindings({ force: true });
      queueSaveUISettings();
    };

    const select = document.createElement("select");
    for (const macro of state.ui.macros) {
      const option = document.createElement("option");
      option.value = macro.id;
      option.textContent = macro.name;
      option.selected = macro.id === binding.macro_id;
      select.appendChild(option);
    }
    select.onfocus = () => {
      state.gamepadMacroBindingDirty = true;
    };
    select.onblur = () => {
      state.gamepadMacroBindingDirty = false;
    };
    select.onchange = () => {
      binding.macro_id = select.value;
      state.gamepadMacroBindingDirty = false;
      queueSaveUISettings();
    };

    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "Remove";
    del.onclick = () => {
      state.ui.gamepad.macro_buttons = state.ui.gamepad.macro_buttons.filter((b) => b.id !== binding.id);
      state.gamepadMacroBindingDirty = false;
      renderGamepadMacroBindings({ force: true });
      queueSaveUISettings();
    };

    row.append(button, select, del);
    box.appendChild(row);
  }
}

function gamepadMacroBindingsLocallyOwned(box = document.getElementById("gamepad-macro-bindings")) {
  return !!box && (box.contains(document.activeElement) || state.gamepadMacroBindingDirty);
}

function readInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function updateGamepadAxis(axis) {
  const cfg = state.ui.gamepad.axes[axis];
  cfg.axis = readInt(document.getElementById("gamepad-axis-" + axis).value, cfg.axis, 0, 31);
  cfg.invert = document.getElementById("gamepad-invert-" + axis).checked;
  cfg.scale = Math.max(0.05, Math.min(1, Number(document.getElementById("gamepad-speed-" + axis).value) / 100 || cfg.scale));
  document.getElementById("gamepad-speed-" + axis + "-value").textContent = Math.round(cfg.scale * 100) + "%";
  queueSaveUISettings();
}

function updateGamepadButtons() {
  const gp = state.ui.gamepad;
  gp.deadman_button = readInt(document.getElementById("gamepad-deadman-button").value, gp.deadman_button, 0, 63);
  gp.slow_buttons = [
    document.getElementById("gamepad-slow-button-0").value,
    document.getElementById("gamepad-slow-button-1").value,
  ].filter((v) => v !== "").map((v) => readInt(v, 0, 0, 63));
  gp.outline_button = readInt(document.getElementById("gamepad-outline-button").value, gp.outline_button, 0, 63);
  queueSaveUISettings();
}

function addGamepadMacroBinding() {
  const macro = macroByID(state.selectedMacroId) || state.ui.macros[0];
  if (!macro) {
    setNotice("Create a macro before assigning a gamepad button.", "error", "gamepad-macro-binding");
    return;
  }
  const used = new Set(state.ui.gamepad.macro_buttons.map((b) => b.button));
  let button = 1;
  while (used.has(button) && button < 64) button++;
  state.ui.gamepad.macro_buttons.push({ id: newID("gamepad-macro"), button, macro_id: macro.id });
  normalizeGamepadMacroOrder();
  renderGamepadMacroBindings({ force: true });
  clearNotice("gamepad-macro-binding");
  queueSaveUISettings();
}

function normalizeGamepadMacroOrder() {
  state.ui.gamepad.macro_buttons.sort((a, b) => a.button - b.button);
  const seen = new Set();
  state.ui.gamepad.macro_buttons = state.ui.gamepad.macro_buttons.filter((binding) => {
    if (seen.has(binding.button) || !macroByID(binding.macro_id)) return false;
    seen.add(binding.button);
    return true;
  });
}

function renderFiles() {
	if (state.fileRenderTimer) {
		clearTimeout(state.fileRenderTimer);
		state.fileRenderTimer = null;
	}
  renderFileSummary();
  renderFolderChrome();
  renderFolderTree();
  const tbody = document.getElementById("files");
  const q = state.filter.trim().toLowerCase();
  const rows = q ? searchFileRows(q) : directoryRows(state.currentDir);

  const empty = document.getElementById("files-empty");
  empty.textContent = state.filesLoaded
    ? (q ? "No files or folders match the search." : "This folder is empty.")
    : "Files load when this tab opens.";
  empty.hidden = rows.length > 0;

  // Update stable row nodes keyed by path instead of rebuilding the table:
  // rows whose rendered state is unchanged keep their DOM (and any in-flight
  // click/pointer state); only rows whose signature changed are rebuilt.
  const existing = new Map();
  for (const tr of tbody.children) existing.set(tr.dataset.fileKey, tr);
  rows.forEach((f, i) => {
    const key = (f.virtual ? "virtual:" : "entry:") + relPath(f.path);
    const signature = fileRowSignature(f, q);
    let tr = existing.get(key);
		if (tr) {
			existing.delete(key);
			if (tr.dataset.fileSignature !== signature) {
				if (fileRowLocallyOwned(tr)) {
					scheduleFileRender();
				} else {
					buildFileRow(tr, f, q);
					tr.dataset.fileSignature = signature;
				}
      }
    } else {
      tr = document.createElement("tr");
      tr.dataset.fileKey = key;
      buildFileRow(tr, f, q);
      tr.dataset.fileSignature = signature;
    }
    const ref = tbody.children[i] || null;
    if (ref !== tr) tbody.insertBefore(tr, ref);
  });
  for (const tr of existing.values()) tr.remove();
}

function fileRowLocallyOwned(tr) {
	const action = state.fileActions.get(tr.dataset.filePath) || "";
	return tr.contains(document.activeElement) || !!tr.querySelector(":active") || (!!action && tr.dataset.fileAction === action);
}

function scheduleFileRender() {
	if (state.fileRenderTimer) return;
	state.fileRenderTimer = setTimeout(() => {
		state.fileRenderTimer = null;
		renderFiles();
	}, 250);
}

function fileRowSignature(f, q) {
  const retry = preferredRetryJob(failedJobsForPath(f.path));
  return JSON.stringify([
    q ? 1 : 0,
    f.is_dir ? 1 : 0,
    f.virtual ? 1 : 0,
    f.children,
    f.error || "",
    f.sync || "",
    f.size,
    f.mtime || "",
    retry ? retry.id + "/" + retryButtonText(retry) : "",
    canDiscardFile(f) ? 1 : 0,
    canSelectGcodeFile(f) ? 1 : 0,
		state.activeSelectPendingPath === f.path ? 1 : 0,
		state.fileActions.get(f.path) || "",
  ]);
}

function buildFileRow(tr, f, q) {
	tr.dataset.filePath = f.path;
	tr.dataset.fileAction = state.fileActions.get(f.path) || "";
  tr.classList.toggle("is-folder", !!f.is_dir);
  tr.classList.toggle("is-file", !f.is_dir);
  tr.classList.toggle("is-virtual", !!f.virtual);
  const label = SYNC_LABEL[f.sync] || f.sync || "-";
  const type = f.is_dir ? (f.virtual ? "folder" : "dir") : "file";
  tr.innerHTML = `
    <td class="path-cell">
      <button type="button" class="file-name ${f.is_dir ? "folder-name" : ""}">${escapeHtml(q ? relPath(f.path) : basename(f.path))}</button>
      ${f.children != null ? `<div class="muted">${f.children} item${f.children === 1 ? "" : "s"}</div>` : ""}
      ${f.error ? `<div class="err">${escapeHtml(f.error)}</div>` : ""}
    </td>
    <td class="file-type-cell" data-label="Type">${type}</td>
    <td class="file-size-cell num" data-label="${f.is_dir ? "Items" : "Size"}">${escapeHtml(f.is_dir && f.children != null ? String(f.children) : fmtSize(f.size, f.is_dir))}</td>
    <td class="file-modified-cell" data-label="Modified">${escapeHtml(fmtTime(f.mtime))}</td>
    <td class="status-cell">${f.virtual ? `<span class="sync"><span class="dot"></span>Folder</span>` : `<span class="sync s-${escapeHtml(f.sync)}"><span class="dot"></span>${escapeHtml(label)}</span>`}</td>
    <td class="actions"></td>`;

  const actions = tr.querySelector(".actions");
  const name = tr.querySelector(".file-name");
  if (f.is_dir) {
    name.onclick = () => openDir(relPath(f.path));
    const open = document.createElement("button");
    open.type = "button";
    open.textContent = "Open";
    open.onclick = () => openDir(relPath(f.path));
    actions.append(open);
  } else {
    name.onclick = () => window.open(apiFileURL(f.path), "_blank", "noopener");
    const open = document.createElement("a");
    open.textContent = "Open";
    open.href = apiFileURL(f.path);
    open.target = "_blank";
    open.rel = "noopener";
    actions.append(open);
  }
  if (!f.virtual) {
    appendFileActions(actions, f);
  }
}

function appendFileActions(actions, f) {
	const pending = state.fileActions.get(f.path);
	if (pending) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.textContent = pending;
		btn.disabled = true;
		btn.setAttribute("aria-busy", "true");
		actions.append(btn);
		return;
	}
  const failed = failedJobsForPath(f.path);
  const retry = preferredRetryJob(failed);
  if (retry) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = retryButtonText(retry);
    btn.onclick = () => retryJob(retry);
    actions.append(btn);
  }
  if (canDiscardFile(f)) {
    appendFileOverflowAction(actions, "Discard", () => discardFile(f.path));
  }
  if (f.sync === "error") return;

  if (canSelectGcodeFile(f)) {
    const select = document.createElement("button");
    select.type = "button";
    const pending = state.activeSelectPendingPath === f.path;
    select.textContent = pending ? "Selecting..." : "Select";
    select.disabled = pending;
    select.onclick = () => selectActiveGcode(f.path);
    actions.append(select);
  }

  const rename = document.createElement("button");
  rename.type = "button";
  rename.textContent = "Rename";
  rename.onclick = () => doRename(f.path);
  const del = document.createElement("button");
  del.type = "button";
  del.textContent = "Delete";
  del.onclick = () => doDelete(f.path);
  appendFileOverflowAction(actions, rename);
  appendFileOverflowAction(actions, del, null, true);
}

function fileOverflowMenu(actions) {
  let menu = actions.querySelector(".file-row-menu");
  if (menu) return menu;
  menu = document.createElement("details");
  menu.className = "file-row-menu";
  const summary = document.createElement("summary");
  summary.setAttribute("aria-label", "More file actions");
  summary.title = "More actions";
  summary.textContent = "•••";
  const panel = document.createElement("div");
  panel.className = "file-row-menu-panel";
  menu.append(summary, panel);
  actions.append(menu);
  return menu;
}

function appendFileOverflowAction(actions, labelOrButton, onclick, danger = false) {
  const menu = fileOverflowMenu(actions);
  const button = labelOrButton instanceof HTMLElement ? labelOrButton : document.createElement("button");
  button.type = "button";
  if (typeof labelOrButton === "string") button.textContent = labelOrButton;
  if (onclick) button.onclick = onclick;
  if (danger) button.classList.add("danger");
  button.addEventListener("click", () => menu.removeAttribute("open"));
  menu.querySelector(".file-row-menu-panel").append(button);
  actions.append(menu);
}

function jobsForPath(path) {
  return [...state.jobs.values()].filter((j) => j.path === path);
}

function failedJobsForPath(path) {
  return jobsForPath(path).filter((j) => j.state === "failed");
}

function preferredRetryJob(jobs) {
  return jobs.find((j) => j.kind === "upload" || j.kind === "mkdir") || jobs[0] || null;
}

function canDiscardFile(f) {
  if (!f || f.virtual) return false;
  if (jobsForPath(f.path).some((j) => j.state === "running")) return false;
  if (["local_only", "pending_upload"].includes(f.sync)) return true;
  if (f.sync !== "error") return false;
  return true;
}

function canSelectGcodeFile(f) {
  if (!f || f.virtual || f.is_dir) return false;
  if (["pending_delete", "deleting", "error"].includes(f.sync)) return false;
  return true;
}

function retryButtonText(job) {
  switch (job?.kind) {
  case "upload":
    return "Retry Upload";
  case "mkdir":
    return "Retry Folder";
  case "delete":
    return "Retry Delete";
  case "rename":
    return "Retry Rename";
  default:
    return "Retry";
  }
}

function directoryRows(dir) {
  dir = cleanRelPath(dir);
  const prefix = dir ? dir + "/" : "";
  const byPath = new Map();
  const rows = [];
  for (const entry of state.files.values()) {
    const rel = relPath(entry.path);
    if (dir && rel === dir) continue;
    if (!rel.startsWith(prefix)) continue;
    const rest = rel.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf("/");
    if (slash >= 0) {
      const folderRel = joinRelPath(dir, rest.slice(0, slash));
      if (!byPath.has(folderRel)) {
        byPath.set(folderRel, synthFolder(folderRel));
      }
      continue;
    }
    const row = { ...entry, virtual: false, children: entry.is_dir ? countChildren(rel) : null };
    byPath.set(rel, row);
    rows.push(row);
  }
  for (const [folderRel, folder] of byPath) {
    if (folder.is_dir) {
      folder.children = countChildren(folderRel);
      folder.mtime = folder.mtime || newestDescendantMTime(folderRel);
    }
    if (!rows.some((r) => relPath(r.path) === folderRel)) rows.push(folder);
  }
  return sortFileRows(rows);
}

function searchFileRows(q) {
  const rows = [];
  const folders = allFolderRows();
  for (const folder of folders) {
    const rel = relPath(folder.path).toLowerCase();
    if (rel.includes(q)) rows.push(folder);
  }
  for (const entry of state.files.values()) {
    const rel = relPath(entry.path).toLowerCase();
    if (rel.includes(q) || (entry.sync || "").toLowerCase().includes(q) || (entry.error || "").toLowerCase().includes(q)) {
      rows.push({ ...entry, virtual: false, children: entry.is_dir ? countChildren(relPath(entry.path)) : null });
    }
  }
  const seen = new Set();
  return sortFileRows(rows.filter((r) => {
    const key = relPath(r.path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }));
}

function sortFileRows(rows) {
  return rows.sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    return relPath(a.path).localeCompare(relPath(b.path));
  });
}

function synthFolder(rel) {
  const actual = state.files.get(remotePathFromRel(rel));
  if (actual && actual.is_dir) return { ...actual, virtual: false, children: 0 };
  return { path: remotePathFromRel(rel), is_dir: true, size: 0, mtime: "", sync: "", virtual: true, children: 0 };
}

function countChildren(dir) {
  dir = cleanRelPath(dir);
  const prefix = dir ? dir + "/" : "";
  const direct = new Set();
  for (const entry of state.files.values()) {
    const rel = relPath(entry.path);
    if (!rel.startsWith(prefix) || rel === dir) continue;
    const rest = rel.slice(prefix.length);
    if (!rest) continue;
    direct.add(rest.split("/")[0]);
  }
  return direct.size;
}

function newestDescendantMTime(dir) {
  dir = cleanRelPath(dir);
  const prefix = dir ? dir + "/" : "";
  let newest = "";
  for (const entry of state.files.values()) {
    const rel = relPath(entry.path);
    if (!rel.startsWith(prefix) || rel === dir || !entry.mtime) continue;
    if (!newest || new Date(entry.mtime) > new Date(newest)) newest = entry.mtime;
  }
  return newest;
}

function allFolderRows() {
  const folders = new Map();
  for (const entry of state.files.values()) {
    const rel = relPath(entry.path);
    const parts = rel.split("/").filter(Boolean);
    const limit = entry.is_dir ? parts.length : parts.length - 1;
    for (let i = 1; i <= limit; i++) {
      const folderRel = parts.slice(0, i).join("/");
      if (!folders.has(folderRel)) folders.set(folderRel, synthFolder(folderRel));
    }
  }
  for (const folder of folders.values()) {
    const rel = relPath(folder.path);
    folder.children = countChildren(rel);
    folder.mtime = folder.mtime || newestDescendantMTime(rel);
  }
  return sortFileRows([...folders.values()]);
}

function openDir(dir) {
  state.currentDir = cleanRelPath(dir);
  state.filter = "";
  document.getElementById("filter").value = "";
  renderFiles();
}

function renderFolderChrome() {
  document.getElementById("current-folder").textContent = "/" + (state.currentDir || "");
  document.getElementById("folder-up").disabled = !state.currentDir;
  const crumbs = document.getElementById("breadcrumbs");
  crumbs.innerHTML = "";
  const root = document.createElement("button");
  root.type = "button";
  root.textContent = "gcodes";
  root.onclick = () => openDir("");
  crumbs.appendChild(root);
  const parts = state.currentDir.split("/").filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const sep = document.createElement("span");
    sep.className = "crumb-sep";
    sep.textContent = "/";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = parts[i];
    btn.onclick = () => openDir(parts.slice(0, i + 1).join("/"));
    crumbs.append(sep, btn);
  }
}

function renderFolderTree() {
  const tree = document.getElementById("folder-tree");
  tree.innerHTML = "";
  const root = folderTreeButton("", "gcodes", 0);
  tree.appendChild(root);
  for (const folder of allFolderRows()) {
    const rel = relPath(folder.path);
    tree.appendChild(folderTreeButton(rel, basename(rel), rel.split("/").length));
  }
}

function folderTreeButton(rel, label, depth) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "folder-tree-item" + (cleanRelPath(rel) === state.currentDir ? " active" : "");
  btn.style.paddingLeft = 8 + Math.max(0, depth) * 14 + "px";
  btn.textContent = label;
  btn.onclick = () => openDir(rel);
  return btn;
}

function renderFileSummary() {
  const box = document.getElementById("file-summary");
  const counts = new Map();
  for (const f of state.files.values()) {
    counts.set(f.sync || "unknown", (counts.get(f.sync || "unknown") || 0) + 1);
  }
  const total = state.files.size;
  const parts = [["files", total], ...[...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))];
  box.innerHTML = "";
  for (const [label, count] of parts) {
    const el = document.createElement("span");
    el.className = "summary-pill";
    el.textContent = `${SYNC_LABEL[label] || label}: ${count}`;
    box.appendChild(el);
  }
}

function renderJobs() {
  const div = document.getElementById("jobs");
  const jobs = [...state.jobs.values()]
    .filter((j) => j.state !== "done")
    .sort((a, b) => a.id - b.id);
  document.getElementById("active-jobs").textContent = String(jobs.length);
  if (!jobs.length) {
    const text = state.filesLoaded ? "No active or failed jobs." : "Activity loads with the Files tab.";
    div.innerHTML = `<div class="empty">${text}</div>`;
    return;
  }
  div.innerHTML = `<div class="jobs-head"><span>Job</span><span>Status</span><span>Detail</span></div>`;
  for (const j of jobs) {
    const row = document.createElement("div");
    row.className = "job";
    row.innerHTML = `
      <span class="job-main"><span class="job-kind">${escapeHtml(j.kind)}</span><span class="name">${escapeHtml(relPath(j.path))}</span></span>
      <span class="job-status">${escapeHtml(jobStatusText(j))}</span>
      <span class="job-detail">${jobDetailHTML(j)}</span>`;
    appendJobActions(row.querySelector(".job-detail"), j);
    div.appendChild(row);
  }
}

function jobStatusText(j) {
  return `${j.state || ""}${j.attempts ? `, attempt ${j.attempts}` : ""}`;
}

function jobDetailHTML(j) {
  if (j.state === "failed" && j.last_error) {
    return `<span class="job-message">Failed</span><span class="job-error">${escapeHtml(j.last_error)}</span>`;
  }
  const message = j.blocked_message || j.last_error || "";
  return message ? `<span class="job-message">${escapeHtml(message)}</span>` : "";
}

function appendJobActions(box, job) {
  const actions = document.createElement("span");
  actions.className = "job-recovery";
  if (job.state === "failed") {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = retryButtonText(job);
    retry.onclick = () => retryJob(job);
    actions.append(retry);

    const discard = document.createElement("button");
    discard.type = "button";
    discard.textContent = "Discard";
    discard.onclick = () => discardFile(job.path);
    actions.append(discard);
  }

  const entry = state.files.get(job.path);
  if (job.state !== "failed" && job.state !== "running" && entry && canDiscardFile(entry)) {
    const discard = document.createElement("button");
    discard.type = "button";
    discard.textContent = "Discard";
    discard.onclick = () => discardFile(job.path);
    actions.append(discard);
  }
  if (actions.children.length) box.appendChild(actions);
}

function renderActiveGcode() {
  const active = state.activeGcode || {};
  const external = externalJobInfo(state.machine, active);
  const title = document.getElementById("active-gcode-title");
  const meta = document.getElementById("active-gcode-meta");
  const run = document.getElementById("active-gcode-run");
  if (!title || !meta || !run) return;

  renderActiveGcodeControls(active);
  document.querySelector(".active-gcode-workspace")?.classList.toggle("is-empty", !active.path);

  if (!active.path) {
    title.textContent = external ? external.title : "No active gcode selected.";
    meta.textContent = external ? external.detail : "-";
    run.disabled = false;
    setSoftDisabled(run, true);
    ensureActiveGcodeGeometry(null);
    ensureActiveGcodeSource(null);
    drawGcodePreview(null);
    renderActiveJobProgress(null, {}, external);
    renderDashboard();
    if (!state.activeGcodePending) clearNotice("active-gcode");
    return;
  }

  title.textContent = relPath(active.path);
  ensureActiveGcodeGeometry(active);
  ensureActiveGcodeSource(active);
  const preview = active.preview || {};
  const renderedPreview = { ...preview, segments: activeGcodeDisplaySegments(active) };
  const live = activeJobPreviewState(state.machine, renderedPreview, active.path);
  const tools = Array.isArray(preview.tools) && preview.tools.length ? " tools T" + preview.tools.join(", T") : "";
  const entry = active.entry || state.files.get(active.path) || {};
  const sync = SYNC_LABEL[entry.sync] || entry.sync || "";
  const bounds = preview.bounds ? previewBoundsText(preview.bounds) : "no plotted bounds";
  meta.textContent = [
    fmtSize(entry.size || 0, false),
    sync,
    `${preview.line_count || 0} lines`,
    `${preview.move_count || 0} moves`,
    `${preview.plotted_segments || 0} segments`,
    preview.has_4axis ? "4-axis" : "3-axis",
    bounds,
    tools,
  ].filter(Boolean).join(" | ");
  const machineReady = state.machine?.state === "Idle";
  run.disabled = !!state.activeGcodePending;
  setSoftDisabled(run, !state.activeGcodePending && (!active.runnable || !machineReady));
  renderActiveJobProgress(live, preview);
  drawGcodePreview(renderedPreview, live);
  renderDashboard();
}

function renderActiveGcodeControls(active) {
  const machineState = state.machine?.state || "";
  const pending = !!state.activeGcodePending;
  const run = document.getElementById("active-gcode-run");
  const pause = document.getElementById("active-gcode-pause");
  const paused = document.getElementById("paused-job-controls");
  const raise = document.getElementById("paused-job-raise");
  const stopSpindle = document.getElementById("paused-job-stop-spindle");
  const resume = document.getElementById("active-gcode-resume");
  const feedControls = document.getElementById("feed-override-controls");
  const feedDecrease = document.getElementById("feed-override-decrease");
  const feedIncrease = document.getElementById("feed-override-increase");
  const feedReset = document.getElementById("feed-override-reset");
  const feedValue = document.getElementById("feed-override-value");
  if (!run || !pause || !paused || !raise || !stopSpindle || !resume || !feedControls || !feedDecrease || !feedIncrease || !feedReset || !feedValue) return;

  const running = machineState === "Run";
  const suspended = machineState === "Pause";
  run.hidden = running || suspended;
  pause.hidden = !running;
  paused.hidden = !suspended;
  feedControls.hidden = !running && !suspended;
  const feedOverride = Number(state.machine?.feed?.override);
  const hasFeedOverride = Number.isFinite(feedOverride);
  const roundedFeedOverride = hasFeedOverride ? Math.round(feedOverride) : 0;
  feedValue.value = hasFeedOverride ? roundedFeedOverride + "%" : "-";
  feedValue.textContent = feedValue.value;
  feedControls.setAttribute("aria-busy", pending ? "true" : "false");
  feedDecrease.disabled = pending || !hasFeedOverride || roundedFeedOverride <= 50;
  feedIncrease.disabled = pending || !hasFeedOverride || roundedFeedOverride >= 200;
  feedReset.disabled = pending || roundedFeedOverride === 100;
  pause.disabled = pending;
  raise.disabled = pending;
  stopSpindle.disabled = pending;
  resume.disabled = pending;
  run.disabled = pending;
  if (!pending) setSoftDisabled(run, !active?.runnable || machineState !== "Idle");
}

function activeGcodeDisplaySegments(active) {
  if (activeGcodeGeometry.signature === activeGcodeSourceSignature(active)) {
    return activeGcodeGeometry.segments;
  }
  return Array.isArray(active?.preview?.overview_segments) ? active.preview.overview_segments : [];
}

function dashboardOptionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function dashboardOnOff(value) {
  const number = dashboardOptionalNumber(value);
  return number === null ? null : (number !== 0 ? "On" : "Off");
}

function dashboardRotaryText(machine) {
  const position = machine?.wpos || machine?.mpos || {};
  const values = [];
  for (const axis of ["a", "b", "c"]) {
    const value = dashboardOptionalNumber(position[axis]);
    if (value !== null) values.push(`${axis.toUpperCase()} ${value.toFixed(3)}°`);
  }
  return values.length ? values.join(" · ") : null;
}

function dashboardLaserText(laser) {
  if (!laser) return null;
  const stateText = laser.testing ? "Testing" : (laser.state ? "Firing" : (laser.mode ? "Ready" : "Off"));
  const power = dashboardOptionalNumber(laser.power);
  const scale = dashboardOptionalNumber(laser.scale);
  const details = [];
  if (power !== null) details.push(`power ${power.toFixed(1)}`);
  if (scale !== null) details.push(`scale ${scale.toFixed(1)}`);
  return details.length ? `${stateText} · ${details.join(" · ")}` : stateText;
}

function dashboardATCText(value) {
  const stateCode = dashboardOptionalNumber(value);
  if (stateCode === null) return null;
  const labels = {
    0: "Idle",
    1: "Dropping tool",
    2: "Picking tool",
    3: "Calibrating",
    4: "Measuring margin",
    5: "Z probing",
    6: "Auto leveling",
    9: "Done",
  };
  return labels[stateCode] || `State ${stateCode}`;
}

function dashboardControllerText(controller) {
  if (!controller) return null;
  const models = { 1: "C1", 2: "CA1", 3: "Z1" };
  const model = models[controller.model] || `Model ${controller.model}`;
  return `${model} · ${controller.inch_mode ? "inch" : "mm"} · ${controller.absolute_mode ? "absolute" : "relative"}`;
}

function dashboardAlarmText(reason) {
  if (!reason) return null;
  const message = String(reason.message || `Alarm ${reason.code ?? ""}`).trim();
  const recovery = String(reason.recovery || "").replaceAll("_", " ").trim();
  return recovery ? `${message} · ${recovery}` : message;
}

function renderDashboardTelemetry(machine) {
  const spindle = machine?.spindle || {};
  const probeV = dashboardOptionalNumber(machine?.wireless_probe_voltage);
  const levelDelta = dashboardOptionalNumber(machine?.leveling_max_delta);
  const values = {
    rotary: dashboardRotaryText(machine),
    probe: probeV === null ? null : `${probeV.toFixed(2)} V`,
    vacuum: dashboardOnOff(spindle.vacuum_mode),
    air: dashboardOnOff(spindle.blowing_mode),
    outputs: (() => {
      const values = [];
      const bed = dashboardOnOff(spindle.bed_clean_mode);
      const external = dashboardOnOff(spindle.external_mode);
      if (bed !== null) values.push(`Bed clean ${bed}`);
      if (external !== null) values.push(`External ${external}`);
      return values.length ? values.join(" · ") : null;
    })(),
    laser: dashboardLaserText(machine?.laser),
    atc: dashboardATCText(machine?.atc_state),
    leveling: levelDelta === null ? null : `Max delta ${levelDelta.toFixed(3)} mm`,
    controller: dashboardControllerText(machine?.controller),
    alarm: dashboardAlarmText(machine?.halt_reason),
  };
  let visible = 0;
  for (const [key, value] of Object.entries(values)) {
    const row = document.querySelector(`[data-dashboard-telemetry="${key}"]`);
    const output = row?.querySelector("strong");
    if (!row || !output) continue;
    row.hidden = value === null;
    if (value !== null) {
      output.textContent = value;
      visible++;
    }
  }
  const empty = document.getElementById("dashboard-telemetry-empty");
  if (empty) empty.hidden = visible > 0;
}

function dashboardGcodeWindow(totalLines, currentLine, visibleLines) {
  const total = Math.max(0, Math.trunc(Number(totalLines) || 0));
  const count = Math.max(3, Math.min(30, Math.trunc(Number(visibleLines) || 9)));
  const current = Math.max(0, Math.min(total, Math.trunc(Number(currentLine) || 0)));
  if (!total) return { start: 0, end: 0, current: 0 };
  if (!current) return { start: 0, end: Math.min(total, count), current: 0 };
  const before = Math.floor((count - 1) / 2);
  let start = Math.max(0, current - 1 - before);
  let end = Math.min(total, start + count);
  start = Math.max(0, end - count);
  return { start, end, current };
}

function renderDashboardGcodeStream(live = null) {
  const container = document.getElementById("dashboard-gcode-lines");
  const position = document.getElementById("dashboard-gcode-position");
  if (!container || !position) return;
  if (!activeGcodeSource.path) {
    position.textContent = "-";
    const empty = document.createElement("div");
    empty.className = "dashboard-gcode-line dashboard-gcode-empty";
    empty.textContent = "No gcode loaded";
    container.replaceChildren(empty);
    return;
  }

  const currentLine = Math.max(0, Math.trunc(Number(live?.playedLines) || 0));
  const range = dashboardGcodeWindow(
    activeGcodeSource.totalLines,
    currentLine,
    currentDashboardProfile()?.gcode_lines,
  );
  position.textContent = range.current
    ? `Ln ${range.current} / ${activeGcodeSource.totalLines || "—"}`
    : (activeGcodeSource.totalLines ? `${activeGcodeSource.totalLines} lines` : "Loading…");
  if (range.end > range.start) {
    fetchActiveGcodeSourcePage(range.start);
    fetchActiveGcodeSourcePage(range.end - 1);
  } else {
    fetchActiveGcodeSourcePage(0);
  }

  const fragment = document.createDocumentFragment();
  for (let index = range.start; index < range.end; index++) {
    const lineNumber = index + 1;
    const row = document.createElement("div");
    row.className = "dashboard-gcode-line" + (lineNumber === range.current ? " current" : "");
    if (lineNumber === range.current) row.setAttribute("aria-current", "step");
    const number = document.createElement("span");
    number.className = "dashboard-gcode-number";
    number.textContent = String(lineNumber);
    number.setAttribute("aria-hidden", "true");
    const code = document.createElement("span");
    code.className = "dashboard-gcode-code";
    code.textContent = activeGcodeSourceLine(index) || " ";
    row.append(number, code);
    fragment.appendChild(row);
  }
  if (!range.end) {
    const loading = document.createElement("div");
    loading.className = "dashboard-gcode-line dashboard-gcode-empty";
    loading.textContent = "Loading gcode…";
    fragment.appendChild(loading);
  }
  container.replaceChildren(fragment);
}

function dashboardCameraShouldRun() {
  return state.activeTab === "dashboard" && !document.hidden;
}

function dashboardCameraSource(kind) {
  return state.cameras.sources?.[kind] || { configured: false };
}

function dashboardExternalCameraIsSnapshot(source) {
  return source?.mode === "snapshot";
}

function setDashboardCameraState(kind, status, title, detail = "") {
  const root = document.getElementById(`dashboard-${kind}-camera`);
  const image = document.getElementById(`dashboard-${kind}-camera-image`);
  const stateText = document.getElementById(`dashboard-${kind}-camera-state`);
  const detailText = document.getElementById(`dashboard-${kind}-camera-detail`);
  const badge = document.getElementById(`dashboard-${kind}-camera-badge`);
  if (!root) return;
  root.classList.toggle("is-live", status === "live");
  root.classList.toggle("is-error", status === "error");
  root.classList.toggle("is-connecting", status === "connecting");
  root.classList.toggle("is-unconfigured", status === "unconfigured");
  if (image) image.hidden = status !== "live";
  if (stateText) stateText.textContent = title;
  if (detailText) detailText.textContent = detail;
  if (badge) badge.textContent = status === "live" ? "Live" :
    (status === "connecting" ? "Connecting" : (status === "error" ? "Offline" : "Not configured"));
}

function loadDashboardCameraPrimary() {
  try {
    return window.localStorage?.getItem("sensei.dashboard.primary-camera") === "builtin" ? "builtin" : "external";
  } catch {
    return "external";
  }
}

function dashboardCameraPrimary() {
  const preferred = state.dashboardCameraPrimary;
  const external = dashboardCameraSource("external");
  const builtin = dashboardCameraSource("builtin");
  if (preferred === "builtin" && builtin.configured) return "builtin";
  if (preferred === "external" && external.configured) return "external";
  if (external.configured) return "external";
  return "builtin";
}

function setDashboardCameraPrimary(kind) {
  if (kind !== "external" && kind !== "builtin") return;
  if (!dashboardCameraSource(kind).configured) return;
  state.dashboardCameraPrimary = kind;
  try {
    window.localStorage?.setItem("sensei.dashboard.primary-camera", kind);
  } catch {
    // The layout still works when browser storage is unavailable.
  }
  renderDashboardCameraConfig();
}

function renderDashboardCameraConfig() {
  const external = dashboardCameraSource("external");
  const builtin = dashboardCameraSource("builtin");
  const stage = document.querySelector(".dashboard-camera-stage");
  const primary = dashboardCameraPrimary();
  stage?.classList.toggle("builtin-primary", primary === "builtin");
  for (const kind of ["external", "builtin"]) {
    const root = document.getElementById(`dashboard-${kind}-camera`);
    if (!root) continue;
    const isPrimary = kind === primary;
    const configured = dashboardCameraSource(kind).configured;
    root.dataset.cameraPrimary = String(isPrimary);
    root.tabIndex = configured ? 0 : -1;
    root.setAttribute("aria-pressed", String(isPrimary));
    root.setAttribute("aria-label", isPrimary
      ? `${kind === "external" ? "External" : "Z1"} camera is the main view`
      : `Make ${kind === "external" ? "external" : "Z1"} camera the main view`);
  }
  if (!state.cameras.loaded) {
    setDashboardCameraState("external", "connecting", "Loading camera configuration", "Cameras run only while Overview is visible.");
    setDashboardCameraState("builtin", "connecting", "Loading Z1 camera", "Waiting for the camera service.");
    return;
  }
  if (!external.configured) {
    setDashboardCameraState("external", "unconfigured", "External camera not configured", "Connect a USB camera to the controller and configure its local stream source.");
  }
  if (!builtin.configured) {
    setDashboardCameraState("builtin", "unconfigured", "Z1 camera not configured", "Configure the Z1 camera WebSocket or start the proxy with a fixed Z1 address.");
  }
}

function dashboardWebSocketURL(path) {
  const url = new URL(path, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

function stopDashboardBuiltinCamera() {
  clearTimeout(state.cameras.builtinReconnectTimer);
  state.cameras.builtinReconnectTimer = null;
  const ws = state.cameras.builtinWS;
  state.cameras.builtinWS = null;
  if (ws) {
    try { ws.close(1000, "overview hidden"); } catch { /* already closed */ }
  }
  const image = document.getElementById("dashboard-builtin-camera-image");
  if (image) image.onload = null;
  for (const objectURL of state.cameras.builtinObjectURLs) URL.revokeObjectURL?.(objectURL);
  state.cameras.builtinObjectURLs.clear();
  state.cameras.builtinObjectURL = "";
}

function startDashboardBuiltinCamera() {
  const source = dashboardCameraSource("builtin");
  if (!dashboardCameraShouldRun() || !source.configured || !source.stream_url || !("WebSocket" in window)) return;
  const existing = state.cameras.builtinWS;
  if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(state.cameras.builtinReconnectTimer);
  setDashboardCameraState("builtin", "connecting", "Connecting to Z1 camera", "Video is relayed through Sensei for Tailscale access.");
  const ws = new WebSocket(dashboardWebSocketURL(source.stream_url));
  ws.binaryType = "blob";
  state.cameras.builtinWS = ws;
  ws.onmessage = (event) => {
    if (state.cameras.builtinWS !== ws || !dashboardCameraShouldRun()) return;
    if (typeof event.data === "string") {
      setDashboardCameraState("builtin", "error", "Z1 camera is in use by another client", "Sensei will retry when the stream becomes available.");
      return;
    }
    const blob = event.data instanceof Blob ? event.data : new Blob([event.data], { type: "image/jpeg" });
    const nextURL = URL.createObjectURL(blob);
    state.cameras.builtinObjectURLs.add(nextURL);
    state.cameras.builtinObjectURL = nextURL;
    const image = document.getElementById("dashboard-builtin-camera-image");
    if (image) {
      image.onload = () => {
        // Keep the old frame alive until this frame has decoded. Revoking it on
        // a timer causes a visible black flash when the Z1 stream slows down.
        if (state.cameras.builtinObjectURL !== nextURL) return;
        for (const objectURL of state.cameras.builtinObjectURLs) {
          if (objectURL === nextURL) continue;
          URL.revokeObjectURL?.(objectURL);
          state.cameras.builtinObjectURLs.delete(objectURL);
        }
      };
      image.src = nextURL;
    }
    setDashboardCameraState("builtin", "live", "Z1 camera live", "Video from the machine's built-in camera.");
  };
  ws.onerror = () => {
    if (state.cameras.builtinWS === ws) setDashboardCameraState("builtin", "error", "Z1 camera is not responding", "Sensei will retry automatically.");
  };
  ws.onclose = () => {
    if (state.cameras.builtinWS !== ws) return;
    state.cameras.builtinWS = null;
    if (!dashboardCameraShouldRun()) return;
    setDashboardCameraState("builtin", "error", "Z1 camera offline", "Sensei will retry automatically.");
    state.cameras.builtinReconnectTimer = setTimeout(startDashboardBuiltinCamera, 3000);
  };
}

function stopDashboardExternalCamera() {
  clearTimeout(state.cameras.externalRetryTimer);
  state.cameras.externalRetryTimer = null;
  const image = document.getElementById("dashboard-external-camera-image");
  if (image) {
    image.onload = null;
    image.onerror = null;
    image.removeAttribute("src");
  }
  state.cameras.externalURL = "";
}

function startDashboardExternalCamera() {
  const source = dashboardCameraSource("external");
  if (!dashboardCameraShouldRun() || !source.configured || !source.stream_url || state.cameras.externalURL) return;
  const image = document.getElementById("dashboard-external-camera-image");
  if (!image) return;
  clearTimeout(state.cameras.externalRetryTimer);
  const url = new URL(source.stream_url, window.location.href);
  url.searchParams.set("v", String(Date.now()));
  state.cameras.externalURL = url.href;
  setDashboardCameraState("external", "connecting", "Connecting to external camera", "Video is relayed through Sensei for remote access.");
  image.onload = () => {
    if (state.cameras.externalURL !== url.href) return;
    setDashboardCameraState("external", "live", "External camera live", "Controller primary camera.");
    if (dashboardExternalCameraIsSnapshot(source)) {
      state.cameras.externalRetryTimer = setTimeout(() => {
        if (state.cameras.externalURL !== url.href || !dashboardCameraShouldRun()) return;
        state.cameras.externalURL = "";
        startDashboardExternalCamera();
      }, EXTERNAL_SNAPSHOT_REFRESH_MS);
    }
  };
  image.onerror = () => {
    if (state.cameras.externalURL !== url.href) return;
    state.cameras.externalURL = "";
    setDashboardCameraState("external", "error", "External camera offline", "Sensei will retry automatically.");
    state.cameras.externalRetryTimer = setTimeout(startDashboardExternalCamera, 4000);
  };
  image.src = url.href;
}

function syncDashboardCameras() {
  renderDashboardCameraConfig();
  if (!dashboardCameraShouldRun()) {
    stopDashboardBuiltinCamera();
    stopDashboardExternalCamera();
    return;
  }
  startDashboardBuiltinCamera();
  startDashboardExternalCamera();
}

async function loadDashboardCameras() {
  try {
    const response = await request("/api/cameras");
    const sources = await response.json();
    state.cameras.sources = {
      builtin: sources?.builtin || { configured: false },
      external: sources?.external || { configured: false },
    };
  } catch {
    state.cameras.sources = { builtin: { configured: false }, external: { configured: false } };
  } finally {
    state.cameras.loaded = true;
    syncDashboardCameras();
  }
}

function bindDashboardCameraSwitches() {
  for (const kind of ["external", "builtin"]) {
    const root = document.getElementById(`dashboard-${kind}-camera`);
    if (!root) continue;
    const select = () => setDashboardCameraPrimary(kind);
    root.addEventListener("click", select);
    root.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      select();
    });
  }
}

function bindDashboardToolpathShortcut() {
  const preview = document.getElementById("dashboard-toolpath-fallback");
  if (!preview) return;
  const open = () => showTab("active-job");
  preview.addEventListener("click", open);
  preview.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    open();
  });
}

function renderDashboard() {
  const machine = state.machine || {};
  const active = state.activeGcode || {};
  const external = externalJobInfo(machine, active);
  const preview = active.preview || {};
  const dashboardPreview = { ...preview, segments: activeGcodeDisplaySegments(active) };
  const live = active.path ? activeJobPreviewState(machine, dashboardPreview, active.path) : null;
  const setText = (id, value) => {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
  };

  document.querySelector(".dashboard-job")?.classList.toggle("is-empty", !active.path);

  const machineState = document.getElementById("dashboard-state");
  if (machineState) {
    const labels = { Idle: "Ready", Run: "Running", Hold: "Held", Pause: "Paused", Wait: "Waiting", Tool: "Tool change", Alarm: "Alarm" };
    machineState.textContent = labels[machine.state] || machine.state || "Unknown";
    machineState.className = "badge state-" + (machine.state || "Unknown");
  }
  renderMachineReadouts(machine);
  setText("dashboard-job-title", active.path ? relPath(active.path) : (external ? `External job · ${machine.state || "active"}` : "No active job"));

  const progress = document.getElementById("dashboard-progress-bar");
  if (progress) progress.value = live ? live.percent : 0;
  const lineCount = Math.max(0, Number(preview.line_count) || 0);
  setText("dashboard-progress-label", live ? `${live.percent}% · line ${live.playedLines}${lineCount ? " / " + lineCount : ""}` : (external ? external.progressText : "Progress"));
  setText("dashboard-elapsed", live ? fmtDuration(live.elapsedMs) : (external ? external.observedText : "-"));
  setText("dashboard-remaining", live && Number.isFinite(live.remainingMs) ? fmtDuration(live.remainingMs) : "-");
  renderDashboardTelemetry(machine);
  renderDashboardGcodeStream(live);
  document.getElementById("dashboard-toolpath-fallback")?.classList.toggle("has-toolpath", dashboardPreview.segments.length > 0 && !!dashboardPreview.bounds);
  drawDashboardGcodePreview(dashboardPreview, live);
}

function drawDashboardGcodePreview(preview, live = null) {
  const segments = Array.isArray(preview?.segments) ? preview.segments : [];
  const hasToolpath = segments.length > 0 && !!preview?.bounds;
  if (!hasToolpath) {
    // Machine status arrives several times per second. Once the viewer is
    // empty, clearing and rendering the same empty WebGL scene again makes the
    // Overview visibly flash on slower touch hardware.
    if (dashboardGcodeView.key || dashboardGcodeView.segments.length) clearDashboardGcodeScene();
    setDashboardGcodePreviewEmpty("No plotted moves");
    return;
  }
  if (!ensureDashboardGcodeViewer()) return;

  const origin = activeJobOverlayOrigin();
  const context = activeJobContextOverlayData(state.outline, origin);
  const contextKey = activeJobContextOverlayKey(origin);
  const sceneBounds = combineGcodeBounds(preview.bounds, context.bounds);
  const key = [
    activeGcodeSourceSignature(state.activeGcode),
    activeGcodeGeometry.signature ? "full" : "overview",
    segments.length,
    preview.has_4axis ? "4" : "3",
    contextKey,
  ].join("|");
  if (dashboardGcodeView.key !== key) {
    dashboardGcodeView.key = key;
    dashboardGcodeView.segments = segments;
    dashboardGcodeView.has4Axis = !!preview.has_4axis;
    populateGcodePathScene(dashboardGcodeView, { ...preview, bounds: sceneBounds }, segments);
    clearThreeGroup(dashboardGcodeView.contextGroup);
    rebuildGcodeContextOverlayForGroup(dashboardGcodeView.contextGroup, context);
    fitDashboardGcodeCamera(sceneBounds);
  }

  const cursor = live
    ? Math.max(0, Math.min(segments.length, Number(live.cursor) || 0))
    : segments.length;
  if (dashboardGcodeView.progressLine) {
    dashboardGcodeView.progressLine.geometry.setDrawRange(0, cursor * 2);
  }
  const markerPosition = live?.position || segments[Math.max(0, cursor - 1)]?.to;
  if (markerPosition) {
    dashboardGcodeView.marker.position.copy(gcodeWorldPoint(markerPosition, dashboardGcodeView.has4Axis));
    dashboardGcodeView.marker.scale.setScalar(Math.max(0.8, dashboardGcodeView.orbit.radius * 0.008));
    dashboardGcodeView.marker.visible = true;
  } else {
    dashboardGcodeView.marker.visible = false;
  }
  if (dashboardGcodeView.canvas) {
    dashboardGcodeView.canvas.setAttribute(
      "aria-label",
      live?.position
        ? `Active job 3D preview; live spindle at X ${fmtCoord(live.position[0])}, Y ${fmtCoord(live.position[1])}, Z ${fmtCoord(live.position[2])}`
        : "Active job 3D preview",
    );
  }
  setDashboardGcodePreviewEmpty("");
  scheduleDashboardGcodeRender();
}

function activeGcodeSourceSignature(active) {
  if (!active?.path) return "";
  const entry = active.entry || state.files.get(active.path) || {};
  const preview = active.preview || {};
  return JSON.stringify([
    active.path,
    entry.md5 || "",
    Number(entry.size) || 0,
    entry.mtime || "",
    Number(preview.line_count) || 0,
    active.updated_at || "",
  ]);
}

// A running job updates progress metadata for every executed G-code line. That
// is deliberately not part of the camera identity: rebuilding the line mesh is
// fine when its detail level changes, but an operator's orbit/zoom must remain
// intact until the selected file itself changes.
function gcodeCameraFitKey(path, entry = {}, preview = {}, hasToolpath = false) {
  if (!hasToolpath) return "context-only";
  return JSON.stringify([
    String(path || ""),
    entry.md5 || "",
    Number(entry.size) || 0,
    entry.mtime || "",
    Number(preview.line_count) || 0,
    preview.has_4axis ? "4" : "3",
  ]);
}

async function ensureActiveGcodeGeometry(active) {
  const signature = activeGcodeSourceSignature(active);
  if (!signature) {
    activeGcodeGeometry.requestID++;
    activeGcodeGeometry.signature = "";
    activeGcodeGeometry.requestedSignature = "";
    activeGcodeGeometry.total = 0;
    activeGcodeGeometry.segments = [];
    return;
  }
  if (activeGcodeGeometry.signature === signature || activeGcodeGeometry.requestedSignature === signature) return;
  const requestID = ++activeGcodeGeometry.requestID;
  activeGcodeGeometry.requestedSignature = signature;
  activeGcodeGeometry.signature = "";
  activeGcodeGeometry.total = Math.max(0, Number(active?.preview?.plotted_segments) || 0);
  activeGcodeGeometry.segments = [];
  try {
    let start = 0;
    while (start < activeGcodeGeometry.total || start === 0) {
      const response = await request(`/api/gcode/active/segments?start=${start}&limit=${GCODE_SEGMENT_PAGE_SIZE}`);
      if (response.status === 204) {
        if (requestID !== activeGcodeGeometry.requestID || activeGcodeGeometry.requestedSignature !== signature) return;
        // A job reported by the machine can be remote-only while it runs. Its
        // source is unavailable, but its live job model must remain visible.
        activeGcodeGeometry.signature = signature;
        activeGcodeGeometry.requestedSignature = "";
        return;
      }
      const windowData = await response.json();
      if (requestID !== activeGcodeGeometry.requestID || activeGcodeGeometry.requestedSignature !== signature) return;
      const page = Array.isArray(windowData.segments) ? windowData.segments : [];
      activeGcodeGeometry.total = Math.max(0, Number(windowData.total) || 0);
      activeGcodeGeometry.segments.push(...page);
      start += page.length;
      if (!page.length || start >= activeGcodeGeometry.total) break;
    }
    if (requestID !== activeGcodeGeometry.requestID) return;
    activeGcodeGeometry.signature = signature;
    activeGcodeGeometry.requestedSignature = "";
    clearNotice("active-gcode-geometry");
    renderActiveGcode();
  } catch (error) {
    if (requestID !== activeGcodeGeometry.requestID) return;
    activeGcodeGeometry.requestedSignature = "";
    setNotice("Toolpath loading failed: " + error.message, "error", "active-gcode-geometry");
  }
}

function splitGcodeSourceLines(text) {
  if (!text) return [];
  const lines = String(text).split(/\r\n|\n|\r/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

async function ensureActiveGcodeSource(active) {
  const path = String(active?.path || "");
  if (!path) {
    resetActiveGcodeSource();
    return;
  }
  const signature = activeGcodeSourceSignature(active);
  if (activeGcodeSource.signature === signature) return;
  activeGcodeSource.requestID++;
  const pathChanged = activeGcodeSource.path !== path;
  activeGcodeSource.path = path;
  if (pathChanged || (activeGcodeSource.signature && activeGcodeSource.signature !== signature)) {
    activeGcodeSource.pages.clear();
    activeGcodeSource.loadingPages.clear();
    activeGcodeSource.currentLine = 0;
    const scroll = document.getElementById("active-gcode-source-scroll");
    if (scroll) scroll.scrollTop = 0;
    renderActiveGcodeSource();
  }
  activeGcodeSource.signature = signature;
  activeGcodeSource.unavailableSignature = "";
  activeGcodeSource.totalLines = Math.max(0, Number(active?.preview?.line_count) || 0);
  clearNotice("active-gcode-source");
  renderActiveGcodeSource();
  fetchActiveGcodeSourcePage(0);
}

function resetActiveGcodeSource() {
  if (!activeGcodeSource.path && !activeGcodeSource.pages.size) {
    renderActiveGcodeSource();
    return;
  }
  activeGcodeSource.requestID++;
  activeGcodeSource.path = "";
  activeGcodeSource.signature = "";
  activeGcodeSource.totalLines = 0;
  activeGcodeSource.pages.clear();
  activeGcodeSource.loadingPages.clear();
  activeGcodeSource.currentLine = 0;
  clearNotice("active-gcode-source");
  const scroll = document.getElementById("active-gcode-source-scroll");
  if (scroll) {
    scroll.scrollTop = 0;
    scroll.removeAttribute("aria-busy");
  }
  renderActiveGcodeSource();
}

async function fetchActiveGcodeSourcePage(index) {
  if (!activeGcodeSource.path || !activeGcodeSource.signature) return;
  if (activeGcodeSource.unavailableSignature === activeGcodeSource.signature) return;
  const pageStartIndex = Math.max(0, Math.floor(Math.max(0, index) / GCODE_SOURCE_PAGE_SIZE) * GCODE_SOURCE_PAGE_SIZE);
  if (activeGcodeSource.pages.has(pageStartIndex)) {
    const page = activeGcodeSource.pages.get(pageStartIndex);
    activeGcodeSource.pages.delete(pageStartIndex);
    activeGcodeSource.pages.set(pageStartIndex, page);
    return;
  }
  if (activeGcodeSource.loadingPages.has(pageStartIndex)) return;
  const requestID = activeGcodeSource.requestID;
  const signature = activeGcodeSource.signature;
  activeGcodeSource.loadingPages.add(pageStartIndex);
  document.getElementById("active-gcode-source-scroll")?.setAttribute("aria-busy", "true");
  try {
    const response = await request(`/api/gcode/active/source?start_line=${pageStartIndex + 1}&limit=${GCODE_SOURCE_PAGE_SIZE}`);
    if (response.status === 204) {
      if (requestID !== activeGcodeSource.requestID || signature !== activeGcodeSource.signature) return;
      clearConnectivityIssue("active-gcode-source");
      activeGcodeSource.unavailableSignature = signature;
      activeGcodeSource.pages.set(pageStartIndex, []);
      renderActiveGcodeSource();
      return;
    }
    const page = await response.json();
    if (requestID !== activeGcodeSource.requestID || signature !== activeGcodeSource.signature) return;
    activeGcodeSource.totalLines = Math.max(0, Number(page.total_lines) || 0);
    activeGcodeSource.pages.set(pageStartIndex, Array.isArray(page.lines) ? page.lines : []);
    while (activeGcodeSource.pages.size > GCODE_SOURCE_MAX_PAGES) {
      activeGcodeSource.pages.delete(activeGcodeSource.pages.keys().next().value);
    }
    clearConnectivityIssue("active-gcode-source");
    renderActiveGcodeSource();
    const active = state.activeGcode || {};
    const preview = { ...(active.preview || {}), segments: activeGcodeDisplaySegments(active) };
    const live = active.path ? activeJobPreviewState(state.machine, preview, active.path) : null;
    renderDashboardGcodeStream(live);
  } catch (error) {
    if (requestID === activeGcodeSource.requestID) {
      setConnectivityIssue("active-gcode-source", "Gcode source unavailable: " + error.message);
    }
  } finally {
    activeGcodeSource.loadingPages.delete(pageStartIndex);
    if (!activeGcodeSource.loadingPages.size) {
      document.getElementById("active-gcode-source-scroll")?.removeAttribute("aria-busy");
    }
  }
}

function activeGcodeSourceLine(index) {
  const pageStartIndex = Math.floor(index / GCODE_SOURCE_PAGE_SIZE) * GCODE_SOURCE_PAGE_SIZE;
  const page = activeGcodeSource.pages.get(pageStartIndex);
  return page?.[index - pageStartIndex];
}

function gcodeSourceWindow(lineCount, scrollTop, viewportHeight, rowHeight = GCODE_SOURCE_ROW_HEIGHT, overscan = GCODE_SOURCE_OVERSCAN) {
  if (lineCount <= 0 || rowHeight <= 0) return { start: 0, end: 0 };
  const first = Math.max(0, Math.floor(Math.max(0, scrollTop) / rowHeight));
  const visible = Math.max(1, Math.ceil(Math.max(0, viewportHeight) / rowHeight));
  return {
    start: Math.max(0, first - overscan),
    end: Math.min(lineCount, first + visible + overscan),
  };
}

function scheduleActiveGcodeSourceRender() {
  if (activeGcodeSource.renderQueued) return;
  activeGcodeSource.renderQueued = true;
  requestAnimationFrame(() => {
    activeGcodeSource.renderQueued = false;
    renderActiveGcodeSource();
  });
}

function renderActiveGcodeSource() {
  const scroll = document.getElementById("active-gcode-source-scroll");
  const spacer = document.getElementById("active-gcode-source-spacer");
  const container = document.getElementById("active-gcode-source-lines");
  const empty = document.getElementById("active-gcode-source-empty");
  const position = document.getElementById("active-gcode-source-position");
  if (!scroll || !spacer || !container || !empty || !position) return;

  const totalLines = activeGcodeSource.totalLines;
  spacer.style.height = `${totalLines * GCODE_SOURCE_ROW_HEIGHT}px`;
  position.textContent = activeGcodeSource.currentLine > 0
    ? `Ln ${activeGcodeSource.currentLine} / ${totalLines || "—"}`
    : (totalLines ? `${totalLines} lines` : "-");
  empty.textContent = activeGcodeSource.path ? "No gcode source loaded" : "No gcode loaded";
  empty.hidden = totalLines > 0 || activeGcodeSource.loadingPages.size > 0;

  const windowRange = gcodeSourceWindow(
    totalLines,
    scroll.scrollTop,
    scroll.clientHeight,
  );
  for (let index = windowRange.start; index < windowRange.end; index += GCODE_SOURCE_PAGE_SIZE) {
    fetchActiveGcodeSourcePage(index);
  }
  if (windowRange.end > windowRange.start) fetchActiveGcodeSourcePage(windowRange.end - 1);
  const fragment = document.createDocumentFragment();
  for (let index = windowRange.start; index < windowRange.end; index++) {
    const lineNumber = index + 1;
    const row = document.createElement("div");
    row.id = `active-gcode-source-line-${lineNumber}`;
    row.className = "active-gcode-source-line" + (lineNumber === activeGcodeSource.currentLine ? " current" : "");
    row.style.transform = `translateY(${index * GCODE_SOURCE_ROW_HEIGHT}px)`;
    if (lineNumber === activeGcodeSource.currentLine) row.setAttribute("aria-current", "step");

    const number = document.createElement("span");
    number.className = "active-gcode-source-number";
    number.textContent = String(lineNumber);
    number.setAttribute("aria-hidden", "true");
    const code = document.createElement("span");
    code.className = "active-gcode-source-code";
    code.textContent = activeGcodeSourceLine(index) || " ";
    row.append(number, code);
    fragment.appendChild(row);
  }
  container.replaceChildren(fragment);
}

function gcodeSourceLineForCursor(segments, cursor) {
  if (!Array.isArray(segments) || !segments.length || cursor <= 0) return 0;
  const index = Math.min(segments.length, Math.max(1, Math.trunc(cursor))) - 1;
  return Math.max(0, Math.trunc(Number(segments[index]?.line) || 0));
}

function syncActiveGcodeSourceLine(live = null) {
  const liveLine = gcodeView.followLive ? Math.trunc(Number(live?.playedLines) || 0) : 0;
  const line = liveLine > 0
    ? liveLine
    : gcodeSourceLineForCursor(gcodeView.segments, gcodeView.cursor);
  const changed = activeGcodeSource.currentLine !== line;
  activeGcodeSource.currentLine = line;
  if (changed) renderActiveGcodeSource();
  const forceFollow = gcodeTimelineLocallyOwned();
  if (line > 0 && (forceFollow || Date.now() >= activeGcodeSource.userScrollingUntil)) {
    scrollActiveGcodeSourceToLine(line, forceFollow);
  }
}

function scrollActiveGcodeSourceToLine(line, force = false) {
  const scroll = document.getElementById("active-gcode-source-scroll");
  const lineCount = activeGcodeSource.totalLines;
  if (!scroll || line <= 0 || lineCount <= 0) return;
  const targetLine = Math.min(lineCount, Math.max(1, Math.trunc(line)));
  const top = (targetLine - 1) * GCODE_SOURCE_ROW_HEIGHT;
  const margin = Math.min(80, Math.max(GCODE_SOURCE_ROW_HEIGHT, scroll.clientHeight * 0.2));
  const visibleTop = scroll.scrollTop + margin;
  const visibleBottom = scroll.scrollTop + scroll.clientHeight - margin;
  if (!force && top >= visibleTop && top + GCODE_SOURCE_ROW_HEIGHT <= visibleBottom) return;
  scroll.scrollTop = Math.max(0, top - Math.max(0, (scroll.clientHeight - GCODE_SOURCE_ROW_HEIGHT) / 2));
  fetchActiveGcodeSourcePage(targetLine - 1);
  renderActiveGcodeSource();
}

function activeJobOverlayOriginFrom(liveOrigin, outline) {
  const capturedOrigin = cloneOutlineOrigin(outline?.origin) || {};
  const origin = {};
  for (const axis of ["x", "y"]) {
    const live = axisValue(liveOrigin, axis);
    const captured = axisValue(capturedOrigin, axis);
    const value = live === null ? captured : live;
    if (value !== null) origin[axis] = value;
  }
  const liveZ = axisValue(liveOrigin, "z");
  const fieldReferenceZ = outline?.fieldReferenceMachineZ === null || outline?.fieldReferenceMachineZ === ""
    ? NaN
    : Number(outline?.fieldReferenceMachineZ);
  const floorZ = outline?.floorMachineZ === null || outline?.floorMachineZ === ""
    ? NaN
    : Number(outline?.floorMachineZ);
  const capturedZ = axisValue(capturedOrigin, "z");
  const fallbackZ = Number.isFinite(fieldReferenceZ)
    ? fieldReferenceZ
    : (Number.isFinite(floorZ) ? floorZ : capturedZ);
  const z = liveZ === null ? fallbackZ : liveZ;
  if (z !== null && Number.isFinite(z)) origin.z = z;
  return Object.keys(origin).length ? origin : null;
}

function activeJobOverlayOrigin() {
  return activeJobOverlayOriginFrom(currentWorkOrigin(), state.outline);
}

function activeJobOverlayPoint(point, origin) {
  const ox = axisValue(origin, "x");
  const oy = axisValue(origin, "y");
  const oz = axisValue(origin, "z");
  const machineX = Number(point?.machine_x);
  const machineY = Number(point?.machine_y);
  const machineZ = Number(point?.machine_z);
  const storedX = Number(point?.x);
  const storedY = Number(point?.y);
  const storedZ = Number(point?.z);
  const x = Number.isFinite(machineX) && ox !== null ? machineX - ox : storedX;
  const y = Number.isFinite(machineY) && oy !== null ? machineY - oy : storedY;
  const z = Number.isFinite(machineZ) && oz !== null ? machineZ - oz : storedZ;
  return [x, y, z].every(Number.isFinite) ? { ...point, x, y, z } : null;
}

function probePlanMatchesResults(plan, results, tolerance = 0.05) {
  if (!Array.isArray(plan) || !Array.isArray(results) || plan.length !== results.length || !plan.length) return false;
  const cellSize = Math.max(0.000001, Number(tolerance) || 0.05);
  const buckets = new Map();
  const cellKey = (x, y) => `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)}`;
  for (let index = 0; index < results.length; index++) {
    const x = Number(results[index]?.x);
    const y = Number(results[index]?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    const key = cellKey(x, y);
    const bucket = buckets.get(key) || [];
    bucket.push(index);
    buckets.set(key, bucket);
  }
  const used = new Set();
  for (const point of plan) {
    const x = Number(point?.x);
    const y = Number(point?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    const cx = Math.floor(x / cellSize);
    const cy = Math.floor(y / cellSize);
    let best = -1;
    let bestDistance = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const candidate of buckets.get(`${cx + dx},${cy + dy}`) || []) {
          if (used.has(candidate)) continue;
          const result = results[candidate];
          const distance = Math.hypot(x - Number(result.x), y - Number(result.y));
          if (distance <= cellSize && distance < bestDistance) {
            best = candidate;
            bestDistance = distance;
          }
        }
      }
    }
    if (best < 0) return false;
    used.add(best);
  }
  return used.size === results.length;
}

function activeJobFieldProbeComplete(outline) {
  const plan = outline?.fieldProbePreview || [];
  const results = outline?.fieldProbeResults || [];
  return !!outline?.active &&
    !!outline?.closed &&
    !outline?.fieldProbePending &&
    results.length >= 3 &&
    (outline?.fieldProbeComplete === true || (plan.length >= 3 && probePlanMatchesResults(plan, results)));
}

function interpolateOutlinePathZ(point, source, closed) {
  if (!Array.isArray(source) || !source.length) return 0;
  if (source.length === 1) return Number(source[0]?.z) || 0;
  const x = Number(point?.x);
  const y = Number(point?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return Number(source[0]?.z) || 0;
  const segmentCount = closed ? source.length : source.length - 1;
  let bestDistanceSq = Infinity;
  let bestZ = Number(source[0]?.z) || 0;
  for (let index = 0; index < segmentCount; index++) {
    const a = source[index];
    const b = source[(index + 1) % source.length];
    const ax = Number(a?.x);
    const ay = Number(a?.y);
    const bx = Number(b?.x);
    const by = Number(b?.y);
    if (![ax, ay, bx, by].every(Number.isFinite)) continue;
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq > 0
      ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSq))
      : 0;
    const projectedX = ax + dx * t;
    const projectedY = ay + dy * t;
    const distanceSq = (x - projectedX) ** 2 + (y - projectedY) ** 2;
    if (distanceSq >= bestDistanceSq) continue;
    const az = Number(a?.z);
    const bz = Number(b?.z);
    if (Number.isFinite(az) && Number.isFinite(bz)) bestZ = az + (bz - az) * t;
    else if (Number.isFinite(az)) bestZ = az;
    else if (Number.isFinite(bz)) bestZ = bz;
    bestDistanceSq = distanceSq;
  }
  return bestZ;
}

function activeJobContextOverlayData(outline, origin) {
  if (!outline?.active || !Array.isArray(outline.points) || !outline.points.length) {
    return { outline: [], markers: [], surface: null, bounds: null, closed: false };
  }
  const source = outline.points.map((point) => activeJobOverlayPoint(point, origin)).filter(Boolean);
  const effective = effectiveOutlineGeometry(source, !!outline.closed, !!outline.curveFit);
  let outlinePoints = effective.points.map((point) => ({
    x: point.x,
    y: point.y,
    z: interpolateOutlinePathZ(point, source, !!outline.closed),
  }));
  let markers = source.map((point) => ({ x: point.x, y: point.y, z: point.z }));
  let surface = null;

  if (!effective.limited && activeJobFieldProbeComplete(outline)) {
    const samples = outline.fieldProbeResults
      .map((point) => activeJobOverlayPoint(point, origin))
      .filter((point) => point && [point.x, point.y, point.z].every(Number.isFinite));
    let polygon = effective.points.map((point) => ({ x: point.x, y: point.y }));
    if (
      polygon.length > 2 &&
      Math.hypot(polygon[0].x - polygon.at(-1).x, polygon[0].y - polygon.at(-1).y) <= 0.00005
    ) {
      polygon = polygon.slice(0, -1);
    }
    try {
      const meshVertices = buildHeightMeshVertices(samples, polygon);
      const points = [];
      for (const point of meshVertices) {
        if (points.some((seen) => Math.hypot(seen.x - point.x, seen.y - point.y) <= 0.000001)) continue;
        points.push(point);
      }
      const faces = points.length >= 3 ? constrainedOutlineTriangles(points, polygon) : [];
      if (faces.length) {
        surface = { points, faces };
        outlinePoints = outlinePoints.map((point) => ({
          ...point,
          z: interpolateZ(point.x, point.y, samples),
        }));
        markers = markers.map((point) => ({
          ...point,
          z: interpolateZ(point.x, point.y, samples),
        }));
      }
    } catch {
      surface = null;
    }
  }

  const bounds = activeJobOverlayBounds([
    ...outlinePoints,
    ...markers,
    ...(surface?.points || []),
  ]);
  return { outline: outlinePoints, markers, surface, bounds, closed: !!outline.closed };
}

function activeJobOverlayBounds(points) {
  const valid = (points || []).filter((point) => [point?.x, point?.y, point?.z].every(Number.isFinite));
  if (!valid.length) return null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const point of valid) {
    for (const [index, value] of [point.x, point.y, point.z].entries()) {
      min[index] = Math.min(min[index], value);
      max[index] = Math.max(max[index], value);
    }
  }
  return { min, max };
}

function combineGcodeBounds(a, b) {
  const valid = (bounds) =>
    bounds && [0, 1, 2].every((index) => Number.isFinite(Number(bounds.min?.[index])) && Number.isFinite(Number(bounds.max?.[index])));
  if (!valid(a)) return valid(b) ? { min: b.min.slice(0, 3), max: b.max.slice(0, 3) } : null;
  if (!valid(b)) return { min: a.min.slice(0, 3), max: a.max.slice(0, 3) };
  return {
    min: [0, 1, 2].map((index) => Math.min(Number(a.min[index]), Number(b.min[index]))),
    max: [0, 1, 2].map((index) => Math.max(Number(a.max[index]), Number(b.max[index]))),
  };
}

function activeJobContextOverlayKey(origin) {
  const coord = (axis) => {
    const value = axisValue(origin, axis);
    return value === null ? "-" : Number(value).toFixed(4);
  };
  return `${outlineContextRevision}:${coord("x")}:${coord("y")}:${coord("z")}`;
}

function syncGcodeContextOverlay() {
  if (!gcodeView.contextGroup) return false;
  const origin = activeJobOverlayOrigin();
  const key = activeJobContextOverlayKey(origin);
  if (gcodeView.contextKey === key) return false;
  const data = activeJobContextOverlayData(state.outline, origin);
  clearThreeGroup(gcodeView.contextGroup);
  rebuildGcodeContextOverlay(data);
  gcodeView.contextKey = key;
  gcodeView.contextBounds = data.bounds;
  gcodeView.contextVisible = !!data.bounds;
  scheduleGcodeRender();
  return true;
}

function rebuildGcodeContextOverlay(data) {
  rebuildGcodeContextOverlayForGroup(gcodeView.contextGroup, data);
}

function rebuildGcodeContextOverlayForGroup(group, data) {
  if (!group) return;
  const outlineColor = data.closed ? 0x44c27b : 0x57a6d6;
  if (data.surface?.points?.length && data.surface.faces?.length) {
    const geometry = new THREE.BufferGeometry();
    const positions = [];
    for (const point of data.surface.points) {
      const world = gcodeWorldPoint([point.x, point.y, point.z, 0], false);
      positions.push(world.x, world.y, world.z);
    }
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(data.surface.faces.flat());
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        color: 0x44c27b,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    mesh.renderOrder = -10;
    group.add(mesh);
    const wire = new THREE.LineSegments(
      new THREE.WireframeGeometry(geometry),
      new THREE.LineBasicMaterial({
        color: 0x72d69e,
        transparent: true,
        opacity: 0.2,
        depthWrite: false,
      }),
    );
    wire.renderOrder = -9;
    group.add(wire);
  }
  if (data.outline.length >= 2) {
    const points = data.outline.map((point) => gcodeWorldPoint([point.x, point.y, point.z, 0], false));
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({
        color: outlineColor,
        transparent: true,
        opacity: 0.92,
        depthTest: false,
      }),
    );
    line.renderOrder = -8;
    group.add(line);
  }
  if (data.markers.length) {
    const points = data.markers.map((point) => gcodeWorldPoint([point.x, point.y, point.z, 0], false));
    const markers = new THREE.Points(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.PointsMaterial({
        color: outlineColor,
        size: 4,
        sizeAttenuation: false,
        transparent: true,
        opacity: 0.95,
        depthTest: false,
      }),
    );
    markers.renderOrder = -7;
    group.add(markers);
  }
}

function renderActiveJobProgress(live, preview = {}, external = null) {
  const progress = document.getElementById("active-gcode-progress");
  const elapsed = document.getElementById("active-gcode-elapsed");
  const remaining = document.getElementById("active-gcode-remaining");
  if (!progress || !elapsed || !remaining) return;
  if (!live) {
    progress.textContent = external ? external.progressText : "-";
    elapsed.textContent = external ? external.observedText : "-";
    remaining.textContent = "-";
    return;
  }
  const totalLines = Math.max(0, Number(preview.line_count) || 0);
  const lineText = totalLines ? `line ${live.playedLines} / ${totalLines}` : `line ${live.playedLines}`;
  progress.textContent = `${live.percent}% · ${lineText}`;
  elapsed.textContent = fmtDuration(live.elapsedMs);
  remaining.textContent = Number.isFinite(live.remainingMs) ? fmtDuration(live.remainingMs) : "-";
}

function activeJobPreviewState(machine, preview, activePath) {
  const job = machine?.active_job;
  const segments = Array.isArray(preview?.segments) ? preview.segments : [];
  if (!job) return null;
  if (job.path && activePath && job.path !== activePath) return null;
  const playedLines = Math.max(0, Math.trunc(Number(job.played_lines) || 0));
  if (playedLines <= 0) return null;
  const percent = Math.max(0, Math.min(100, Math.trunc(Number(job.percent) || 0)));
  const elapsedMs = Math.max(0, Number(job.elapsed_ms) || 0);
  const remainingValue = Number(job.remaining_ms);
  const remainingMs = Number.isFinite(remainingValue) && remainingValue >= 0 ? remainingValue : null;
  const wpos = machine?.wpos || {};
  let position = null;
  if ([wpos.x, wpos.y, wpos.z].every((value) => Number.isFinite(Number(value)))) {
    position = [
      Number(wpos.x),
      Number(wpos.y),
      Number(wpos.z),
      Number.isFinite(Number(wpos.a)) ? -Number(wpos.a) : 0,
    ];
  }
  return {
    playedLines,
    percent,
    elapsedMs,
    remainingMs,
    cursor: gcodeCursorForPlayedLine(segments, playedLines),
    position,
  };
}

function gcodeCursorForPlayedLine(segments, playedLine) {
  let low = 0;
  let high = Array.isArray(segments) ? segments.length : 0;
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    const line = Number(segments[mid]?.line) || 0;
    if (line < playedLine) low = mid + 1;
    else high = mid;
  }
  return low;
}

function previewBoundsText(bounds) {
  const min = bounds.min || [];
  const max = bounds.max || [];
  const dx = Number(max[0]) - Number(min[0]);
  const dy = Number(max[1]) - Number(min[1]);
  const dz = Number(max[2]) - Number(min[2]);
  if (![dx, dy, dz].every(Number.isFinite)) return "";
  const xyz = `X ${dx.toFixed(2)} Y ${dy.toFixed(2)} Z ${dz.toFixed(2)} mm`;
  const da = Number(bounds.max_a) - Number(bounds.min_a);
  if (Number.isFinite(da) && Math.abs(da) > 0.0001) return `${xyz} A ${Math.abs(da).toFixed(2)} deg`;
  return xyz;
}

function drawGcodePreview(preview, live = null) {
  const segments = Array.isArray(preview?.segments) ? preview.segments : [];
  const hasToolpath = segments.length > 0 && !!preview?.bounds;
  const hasContextCandidate = !!state.outline?.active && !!state.outline?.points?.length;
  if (!hasToolpath && !hasContextCandidate) {
    if (gcodeView.key || gcodeView.segments.length) clearGcodeScene();
    gcodeView.live = live;
    gcodeView.followLive = !!live;
    setGcodePreviewEmpty("No plotted moves");
    updateGcodeTimeline(0);
    syncActiveGcodeSourceLine(live);
    return;
  }
  if (!ensureGcodeViewer()) {
    gcodeView.segments = hasToolpath ? segments : [];
    gcodeView.live = live;
    if (live && !gcodeTimelineLocallyOwned()) {
      gcodeView.cursor = live.cursor;
      gcodeView.followLive = true;
    } else {
      if (!gcodeTimelineLocallyOwned()) gcodeView.cursor = gcodeView.segments.length;
      gcodeView.cursor = Math.max(0, Math.min(gcodeView.segments.length, gcodeView.cursor));
      if (!live) gcodeView.followLive = false;
    }
    updateGcodeTimeline(gcodeView.segments.length);
    syncActiveGcodeSourceLine(live);
    return;
  }
  syncGcodeContextOverlay();
  if (!hasToolpath && !gcodeView.contextVisible) {
    clearGcodeScene();
    setGcodePreviewEmpty("No plotted moves");
    updateGcodeTimeline(0);
    syncActiveGcodeSourceLine(live);
    return;
  }
  const pathKey = hasToolpath ? [
    state.activeGcode?.path || "",
    preview.line_count || 0,
    preview.plotted_segments || segments.length,
    preview.total_distance || 0,
    preview.has_4axis ? "4" : "3",
  ].join(":") : "context-only";
  const key = `${pathKey}|${gcodeView.contextKey}`;
  const sceneBounds = combineGcodeBounds(hasToolpath ? preview.bounds : null, gcodeView.contextBounds);
  const entry = state.activeGcode?.entry || state.files.get(state.activeGcode?.path || "") || {};
  const fitKey = gcodeCameraFitKey(state.activeGcode?.path, entry, preview, hasToolpath);
  if (gcodeView.key !== key) {
    const renderedSegments = hasToolpath ? segments : [];
    gcodeView.key = key;
    gcodeView.segments = renderedSegments;
    gcodeView.has4Axis = hasToolpath && !!preview.has_4axis;
    gcodeView.cursor = live ? live.cursor : renderedSegments.length;
    rebuildGcodeScene({ ...preview, bounds: sceneBounds }, renderedSegments);
    if (sceneBounds && gcodeView.fitKey !== fitKey) {
      gcodeView.fitKey = fitKey;
      fitGcodeCamera(sceneBounds);
    }
  }
  gcodeView.live = live;
  if (live && !gcodeTimelineLocallyOwned()) {
    gcodeView.cursor = live.cursor;
    gcodeView.followLive = true;
  } else if (!live) {
    gcodeView.followLive = false;
  }
  setGcodePreviewEmpty("");
  updateGcodeTimeline(gcodeView.segments.length);
  updateGcodeProgress();
  scheduleGcodeRender();
}

function gcodeRenderPixelRatio(width = 0, height = 0, pixelBudget = GCODE_RENDER_PIXEL_BUDGET) {
  const deviceRatio = Math.max(1, Number(globalThis.devicePixelRatio) || 1);
  if (!(width > 0 && height > 0 && pixelBudget > 0)) return deviceRatio;
  const budgetRatio = Math.sqrt(pixelBudget / (width * height));
  return Math.max(1, Math.min(deviceRatio, budgetRatio));
}

function ensureGcodeViewer() {
  if (gcodeView.renderer) return true;
  const canvas = document.getElementById("gcode-preview");
  if (!canvas) return false;
  gcodeView.canvas = canvas;
  gcodeView.empty = document.getElementById("gcode-preview-empty");
  try {
    gcodeView.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  } catch (e) {
    setGcodePreviewEmpty("3D preview unavailable");
    return false;
  }
  gcodeView.pixelRatio = gcodeRenderPixelRatio();
  gcodeView.renderer.setPixelRatio(gcodeView.pixelRatio);
  gcodeView.renderer.setClearColor(0x202832, 1);
  gcodeView.scene = new THREE.Scene();
  gcodeView.perspCamera = new THREE.PerspectiveCamera(GCODE_FOV, 1, 0.1, 100000);
  gcodeView.orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100000);
  gcodeView.camera = gcodeView.projection === "orthographic" ? gcodeView.orthoCamera : gcodeView.perspCamera;
  gcodeView.pathGroup = new THREE.Group();
  gcodeView.scene.add(gcodeView.pathGroup);
  gcodeView.contextGroup = new THREE.Group();
  gcodeView.scene.add(gcodeView.contextGroup);
  const markerGeometry = new THREE.SphereGeometry(1, 16, 12);
  const markerMaterial = new THREE.MeshBasicMaterial({ color: 0xd99a3a });
  gcodeView.marker = new THREE.Mesh(markerGeometry, markerMaterial);
  gcodeView.marker.visible = false;
  gcodeView.scene.add(gcodeView.marker);
  bindGcodeOrbitControls(canvas);
  initGcodeViewCube();
  bindGcodeProjectionToggle();
  if (globalThis.ResizeObserver) {
    gcodeView.resizeObserver = new ResizeObserver(() => scheduleGcodeRender());
    gcodeView.resizeObserver.observe(canvas);
  }
  window.addEventListener("resize", scheduleGcodeRender);
  return true;
}

function ensureDashboardGcodeViewer() {
  if (dashboardGcodeView.renderer) return true;
  const canvas = document.getElementById("dashboard-preview");
  if (!canvas) return false;
  dashboardGcodeView.canvas = canvas;
  dashboardGcodeView.empty = document.getElementById("dashboard-preview-empty");
  try {
    dashboardGcodeView.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  } catch {
    setDashboardGcodePreviewEmpty("3D preview unavailable");
    return false;
  }
  dashboardGcodeView.pixelRatio = gcodeRenderPixelRatio();
  dashboardGcodeView.renderer.setPixelRatio(dashboardGcodeView.pixelRatio);
  dashboardGcodeView.renderer.setClearColor(0x202832, 1);
  dashboardGcodeView.scene = new THREE.Scene();
  dashboardGcodeView.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100000);
  dashboardGcodeView.pathGroup = new THREE.Group();
  dashboardGcodeView.contextGroup = new THREE.Group();
  dashboardGcodeView.scene.add(dashboardGcodeView.pathGroup);
  dashboardGcodeView.scene.add(dashboardGcodeView.contextGroup);
  dashboardGcodeView.marker = new THREE.Mesh(
    new THREE.SphereGeometry(1, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xd99a3a }),
  );
  dashboardGcodeView.marker.visible = false;
  dashboardGcodeView.scene.add(dashboardGcodeView.marker);
  if (globalThis.ResizeObserver) {
    dashboardGcodeView.resizeObserver = new ResizeObserver(scheduleDashboardGcodeRender);
    dashboardGcodeView.resizeObserver.observe(canvas);
  }
  window.addEventListener("resize", scheduleDashboardGcodeRender);
  return true;
}

function clearDashboardGcodeScene() {
  dashboardGcodeView.key = "";
  dashboardGcodeView.segments = [];
  if (!dashboardGcodeView.renderer) return;
  clearThreeGroup(dashboardGcodeView.pathGroup);
  clearThreeGroup(dashboardGcodeView.contextGroup);
  disposeObject(dashboardGcodeView.progressLine);
  dashboardGcodeView.progressLine = null;
  dashboardGcodeView.marker.visible = false;
  scheduleDashboardGcodeRender();
}

function setDashboardGcodePreviewEmpty(text) {
  const empty = dashboardGcodeView.empty || document.getElementById("dashboard-preview-empty");
  if (!empty) return;
  empty.textContent = text || "";
  empty.hidden = !text;
}

function fitDashboardGcodeCamera(bounds) {
  if (!bounds?.min || !bounds?.max || !dashboardGcodeView.camera) return;
  const min = bounds.min;
  const max = bounds.max;
  const center = [0, 1, 2].map((index) => (Number(min[index]) + Number(max[index])) / 2);
  dashboardGcodeView.target.set(...gcodeWorldCoordinates([...center, 0], false));
  const radius = Math.max(
    Math.abs(Number(max[0]) - Number(min[0])),
    Math.abs(Number(max[1]) - Number(min[1])),
    Math.abs(Number(max[2]) - Number(min[2])),
    1,
  );
  const direction = gcodeOrbitAnglesForDirection({ x: 1, y: 1, z: 1 });
  dashboardGcodeView.orbit.theta = direction.theta;
  dashboardGcodeView.orbit.phi = direction.phi;
  dashboardGcodeView.orbit.radius = radius * 2.4 + 20;
  updateDashboardGcodeCamera();
}

function updateDashboardGcodeCamera() {
  const view = dashboardGcodeView;
  if (!view.camera) return;
  const sinPhi = Math.sin(view.orbit.phi);
  view.camera.up.set(0, 1, 0);
  view.camera.position.set(
    view.target.x + view.orbit.radius * sinPhi * Math.sin(view.orbit.theta),
    view.target.y + view.orbit.radius * Math.cos(view.orbit.phi),
    view.target.z + view.orbit.radius * sinPhi * Math.cos(view.orbit.theta),
  );
  view.camera.lookAt(view.target);
  syncDashboardGcodeProjection();
  scheduleDashboardGcodeRender();
}

function syncDashboardGcodeProjection() {
  const view = dashboardGcodeView;
  if (!view.camera) return;
  const aspect = view.height > 0 ? view.width / view.height : 1;
  const radius = view.orbit.radius;
  const halfH = Math.tan(THREE.MathUtils.degToRad(GCODE_FOV) / 2) * radius;
  view.camera.near = Math.max(0.01, radius / 1000);
  view.camera.far = Math.max(1000, radius * 100);
  view.camera.top = halfH;
  view.camera.bottom = -halfH;
  view.camera.left = -halfH * aspect;
  view.camera.right = halfH * aspect;
  view.camera.updateProjectionMatrix();
}

function scheduleDashboardGcodeRender() {
  if (!dashboardGcodeView.renderer || dashboardGcodeView.renderQueued) return;
  dashboardGcodeView.renderQueued = true;
  requestAnimationFrame(() => {
    dashboardGcodeView.renderQueued = false;
    renderDashboardGcodeScene();
  });
}

function renderDashboardGcodeScene() {
  const view = dashboardGcodeView;
  if (!view.renderer || !view.camera || !view.canvas) return;
  const rect = view.canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  const pixelRatio = gcodeRenderPixelRatio(width, height);
  const sizeChanged = view.width !== width || view.height !== height;
  const ratioChanged = Math.abs(view.pixelRatio - pixelRatio) > 0.001;
  if (ratioChanged) {
    view.pixelRatio = pixelRatio;
    view.renderer.setPixelRatio(pixelRatio);
  }
  if (sizeChanged || ratioChanged) {
    view.width = width;
    view.height = height;
    view.renderer.setSize(width, height, false);
    syncDashboardGcodeProjection();
  }
  view.renderer.render(view.scene, view.camera);
}

function bindGcodeOrbitControls(canvas) {
  const setPanKey = () => {
    const on = gcodeView.panKeys.size > 0;
    gcodeView.panKeyDown = on;
    canvas.classList.toggle("pan-mode", on || gcodeView.dragMode === "pan");
  };
  canvas.addEventListener("pointerdown", (e) => {
    let pinching = false;
    if (e.pointerType === "touch") {
      gcodeView.touchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (gcodeView.touchPointers.size === 2) {
        const [first, second] = gcodeView.touchPointers.values();
        gcodeView.pinchDistance = gcodePinchDistance(first, second);
        pinching = true;
        e.preventDefault();
      }
    }
    gcodeView.dragging = !pinching;
    gcodeView.dragX = e.clientX;
    gcodeView.dragY = e.clientY;
    gcodeView.dragMode = (e.shiftKey || gcodeView.panKeyDown || e.button === 1) ? "pan" : "orbit";
    canvas.classList.toggle("pan-mode", gcodeView.dragMode === "pan" || gcodeView.panKeyDown);
    if (gcodeView.dragMode === "pan") e.preventDefault();
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture?.(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch" && gcodeView.touchPointers.has(e.pointerId)) {
      gcodeView.touchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (gcodeView.touchPointers.size === 2) {
        const [first, second] = gcodeView.touchPointers.values();
        const distance = gcodePinchDistance(first, second);
        if (gcodeView.pinchDistance > 0 && distance > 0) {
          gcodeView.orbit.radius = gcodeOrbitRadiusAfterPinch(gcodeView.orbit.radius, gcodeView.pinchDistance, distance);
          updateGcodeCamera();
        }
        gcodeView.pinchDistance = distance;
        e.preventDefault();
        return;
      }
    }
    if (!gcodeView.dragging) return;
    const dx = e.clientX - gcodeView.dragX;
    const dy = e.clientY - gcodeView.dragY;
    gcodeView.dragX = e.clientX;
    gcodeView.dragY = e.clientY;
    if (e.shiftKey || gcodeView.panKeyDown || gcodeView.dragMode === "pan") {
      gcodeView.dragMode = "pan";
      canvas.classList.add("pan-mode");
      panGcodeCamera(dx, dy);
    } else {
      rotateGcodeOrbitByDrag(gcodeView.orbit, dx, dy);
      updateGcodeCamera();
    }
  });
  const stopDrag = (e) => {
    let keepDragging = false;
    if (e.pointerType === "touch") {
      gcodeView.touchPointers.delete(e.pointerId);
      gcodeView.pinchDistance = 0;
      if (gcodeView.touchPointers.size === 1) {
        const [{ x, y }] = gcodeView.touchPointers.values();
        keepDragging = true;
        gcodeView.dragX = x;
        gcodeView.dragY = y;
      }
    }
    gcodeView.dragging = keepDragging;
    gcodeView.dragMode = "orbit";
    canvas.classList.toggle("pan-mode", gcodeView.panKeyDown);
    canvas.releasePointerCapture?.(e.pointerId);
  };
  canvas.addEventListener("pointerup", stopDrag);
  canvas.addEventListener("pointercancel", stopDrag);
  canvas.addEventListener("pointerenter", () => { gcodeView.hovering = true; });
  canvas.addEventListener("pointerleave", () => {
    gcodeView.hovering = false;
    if (!gcodeView.dragging) canvas.classList.toggle("pan-mode", gcodeView.panKeyDown);
  });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    gcodeView.orbit.radius = gcodeOrbitRadiusAfterWheel(gcodeView.orbit.radius, e.deltaY);
    updateGcodeCamera();
  }, { passive: false });
  window.addEventListener("keydown", (e) => {
    if (isTypingTarget(e.target)) return;
    if (e.key !== "Shift" && e.code !== "Space") return;
    if (!gcodeView.hovering && document.activeElement !== canvas && !gcodeView.dragging) return;
    if (e.code === "Space") e.preventDefault();
    gcodeView.panKeys.add(e.code === "Space" ? "space" : "shift");
    setPanKey();
  });
  window.addEventListener("keyup", (e) => {
    if (e.key !== "Shift" && e.code !== "Space") return;
    if (e.code === "Space" && (gcodeView.hovering || document.activeElement === canvas)) e.preventDefault();
    gcodeView.panKeys.delete(e.code === "Space" ? "space" : "shift");
    setPanKey();
  });
  window.addEventListener("blur", () => {
    gcodeView.panKeys.clear();
    gcodeView.touchPointers.clear();
    gcodeView.pinchDistance = 0;
    gcodeView.dragging = false;
    setPanKey();
  });
}

function gcodePinchDistance(first, second) {
  return Math.hypot(Number(second?.x) - Number(first?.x), Number(second?.y) - Number(first?.y));
}

function gcodeOrbitRadiusAfterPinch(radius, previousDistance, distance) {
  if (!(previousDistance > 0) || !(distance > 0)) return radius;
  return Math.max(GCODE_ORBIT_MIN_RADIUS, Math.min(GCODE_ORBIT_MAX_RADIUS, radius * previousDistance / distance));
}

function gcodeOrbitRadiusAfterWheel(radius, deltaY) {
  return Math.max(GCODE_ORBIT_MIN_RADIUS, Math.min(GCODE_ORBIT_MAX_RADIUS, radius * Math.exp(deltaY * 0.001)));
}

function rotateGcodeOrbitByDrag(orbit, dx, dy) {
  orbit.theta -= dx * GCODE_ORBIT_DRAG_RAD_PER_PX;
  orbit.phi = Math.max(
    0.08,
    Math.min(Math.PI - 0.08, orbit.phi - dy * GCODE_ORBIT_DRAG_RAD_PER_PX),
  );
  return orbit;
}

function isTypingTarget(el) {
  if (!el) return false;
  const tag = String(el.tagName || "").toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable;
}

function rebuildGcodeScene(preview, segments) {
  populateGcodePathScene(gcodeView, preview, segments);
}

function populateGcodePathScene(view, preview, segments) {
  // Toolpath and outline/probe context have separate cache keys and lifecycles.
  // Context is rebuilt by syncGcodeContextOverlay and must survive path rebuilds.
  clearThreeGroup(view.pathGroup);
  disposeObject(view.progressLine);
  view.progressLine = null;
  const bounds = preview.bounds || {};
  addGcodeGridToView(view, bounds);
  const byKind = { rapid: [], cut: [], arc: [], probe: [] };
  const progress = new Float32Array(segments.length * 6);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] || {};
    const a = gcodeWorldPoint(seg.from || [0, 0, 0, 0], preview.has_4axis);
    const b = gcodeWorldPoint(seg.to || [0, 0, 0, 0], preview.has_4axis);
    const kind = byKind[seg.kind] ? seg.kind : "cut";
    byKind[kind].push(a.x, a.y, a.z, b.x, b.y, b.z);
    const j = i * 6;
    progress[j] = a.x;
    progress[j + 1] = a.y;
    progress[j + 2] = a.z;
    progress[j + 3] = b.x;
    progress[j + 4] = b.y;
    progress[j + 5] = b.z;
  }
  for (const kind of ["rapid", "cut", "arc", "probe"]) {
    if (!byKind[kind].length) continue;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(byKind[kind], 3));
    const material = new THREE.LineBasicMaterial({
      color: GCODE_KIND_COLORS[kind],
      transparent: true,
      opacity: kind === "rapid" ? 0.42 : 0.82,
    });
    view.pathGroup.add(new THREE.LineSegments(geometry, material));
  }
  const progressGeometry = new THREE.BufferGeometry();
  progressGeometry.setAttribute("position", new THREE.BufferAttribute(progress, 3));
  progressGeometry.setDrawRange(0, progress.length / 3);
  const progressMaterial = new THREE.LineBasicMaterial({ color: 0xf2f6fa, transparent: true, opacity: 0.95 });
  view.progressLine = new THREE.LineSegments(progressGeometry, progressMaterial);
  view.scene.add(view.progressLine);
}

function addGcodeGrid(bounds) {
  addGcodeGridToView(gcodeView, bounds);
}

function addGcodeGridToView(view, bounds) {
  const min = bounds.min || [0, 0, 0];
  const max = bounds.max || [1, 1, 1];
  const spanX = Math.max(Math.abs(Number(max[0]) - Number(min[0])), 1);
  const spanY = Math.max(Math.abs(Number(max[1]) - Number(min[1])), 1);
  const size = Math.max(spanX, spanY, 20) * 1.15;
  const divisions = Math.max(4, Math.min(80, Math.round(size / 10)));
  const grid = new THREE.GridHelper(size, divisions, 0x5f6c78, 0x303946);
  const center = gcodeWorldCoordinates([
    (Number(min[0]) + Number(max[0])) / 2,
    (Number(min[1]) + Number(max[1])) / 2,
    Number(min[2]) || 0,
    0,
  ], false);
  grid.position.set(...center);
  view.pathGroup.add(grid);
  // Origin marker with axis legends sits at the work origin (machine 0,0,0).
  view.pathGroup.add(buildGcodeOriginAxes(Math.max(5, size * 0.12), view.renderer));
}

function buildGcodeOriginAxes(len, renderer = gcodeView.renderer) {
  const group = new THREE.Group();
  const axes = [
    // Machine X+ is world +x, machine Y+ is world -z, machine Z+ is world +y.
    { color: GCODE_AXIS_COLORS.x, dir: new THREE.Vector3(1, 0, 0), plus: "X+", minus: "X-" },
    { color: GCODE_AXIS_COLORS.y, dir: new THREE.Vector3(0, 0, -1), plus: "Y+", minus: "Y-" },
    { color: GCODE_AXIS_COLORS.z, dir: new THREE.Vector3(0, 1, 0), plus: "Z+", minus: "" },
  ];
  const headLen = len * 0.16;
  const headRadius = len * 0.05;
  for (const axis of axes) {
    const color = new THREE.Color(axis.color);
    const from = axis.minus ? axis.dir.clone().multiplyScalar(-len) : new THREE.Vector3();
    const to = axis.dir.clone().multiplyScalar(len);
    const lineGeometry = new THREE.BufferGeometry().setFromPoints([from, to]);
    group.add(new THREE.Line(lineGeometry, new THREE.LineBasicMaterial({ color })));
    for (const sign of axis.minus ? [1, -1] : [1]) {
      const head = new THREE.Mesh(
        new THREE.ConeGeometry(headRadius, headLen, 12),
        new THREE.MeshBasicMaterial({ color }),
      );
      const tipDir = axis.dir.clone().multiplyScalar(sign);
      head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tipDir);
      head.position.copy(tipDir.multiplyScalar(len - headLen / 2));
      group.add(head);
      const label = makeGcodeAxisLabel(sign > 0 ? axis.plus : axis.minus, axis.color, renderer);
      label.position.copy(axis.dir.clone().multiplyScalar(sign * (len + len * 0.22)));
      label.scale.setScalar(len * 0.34);
      group.add(label);
    }
  }
  return group;
}

function makeGcodeAxisLabel(text, color, renderer = gcodeView.renderer) {
  const size = 256;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d");
  ctx.font = "700 116px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.lineWidth = 24;
  ctx.strokeStyle = "#12171c";
  ctx.strokeText(text, size / 2, size / 2);
  ctx.fillStyle = color;
  ctx.fillText(text, size / 2, size / 2);
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  if (renderer) texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }));
  sprite.renderOrder = 10;
  return sprite;
}

function clearGcodeScene() {
  gcodeView.live = null;
  gcodeView.followLive = false;
  if (gcodeView.canvas) gcodeView.canvas.setAttribute("aria-label", "Active gcode preview");
  if (!gcodeView.renderer) return;
  clearThreeGroup(gcodeView.pathGroup);
  clearThreeGroup(gcodeView.contextGroup);
  disposeObject(gcodeView.progressLine);
  gcodeView.progressLine = null;
  gcodeView.marker.visible = false;
  gcodeView.key = "";
  gcodeView.fitKey = "";
  gcodeView.contextKey = "";
  gcodeView.contextBounds = null;
  gcodeView.contextVisible = false;
  gcodeView.segments = [];
  gcodeView.cursor = 0;
  scheduleGcodeRender();
}

function clearThreeGroup(group) {
  if (!group) return;
  while (group.children.length) {
    const child = group.children.pop();
    disposeObject(child);
  }
}

function disposeObject(obj) {
  if (!obj) return;
  if (obj.parent) obj.parent.remove(obj);
  obj.traverse((node) => {
    if (node.geometry) node.geometry.dispose();
    const materials = Array.isArray(node.material) ? node.material : node.material ? [node.material] : [];
    for (const material of materials) {
      if (material.map) material.map.dispose();
      material.dispose();
    }
  });
}

function fitGcodeCamera(bounds) {
  const min = bounds.min || [0, 0, 0];
  const max = bounds.max || [1, 1, 1];
  const cx = (Number(min[0]) + Number(max[0])) / 2;
  const cy = (Number(min[1]) + Number(max[1])) / 2;
  const cz = (Number(min[2]) + Number(max[2])) / 2;
  gcodeView.target.set(...gcodeWorldCoordinates([cx, cy, cz, 0], false));
  const spanX = Math.abs(Number(max[0]) - Number(min[0]));
  const spanY = Math.abs(Number(max[1]) - Number(min[1]));
  const spanZ = Math.abs(Number(max[2]) - Number(min[2]));
  const radius = Math.max(spanX, spanY, spanZ, 1);
  gcodeView.orbit.radius = radius * 2.4 + 20;
  updateGcodeCamera();
}

function panGcodeCamera(dx, dy) {
  const camera = gcodeView.camera;
  const canvas = gcodeView.canvas;
  if (!camera || !canvas) return;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  const distance = Math.max(0.001, camera.position.distanceTo(gcodeView.target));
  const viewHeight = camera.isOrthographicCamera
    ? camera.top - camera.bottom
    : 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * distance;
  const viewWidth = camera.isOrthographicCamera ? camera.right - camera.left : viewHeight * camera.aspect;
  camera.updateMatrixWorld();
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
  gcodeView.target.addScaledVector(right, -dx * viewWidth / width);
  gcodeView.target.addScaledVector(up, dy * viewHeight / height);
  updateGcodeCamera();
}

function updateGcodeCamera() {
  if (!gcodeView.camera) return;
  const o = gcodeView.orbit;
  const sinPhi = Math.sin(o.phi);
  const x = gcodeView.target.x + o.radius * sinPhi * Math.sin(o.theta);
  const y = gcodeView.target.y + o.radius * Math.cos(o.phi);
  const z = gcodeView.target.z + o.radius * sinPhi * Math.cos(o.theta);
  if (Math.abs(sinPhi) < 0.02) {
    // Looking straight down/up the world-up axis: pick an up vector that keeps
    // machine Y+ toward the top of the screen so top/bottom views stay stable.
    gcodeView.camera.up.set(-Math.sin(o.theta), 0, -Math.cos(o.theta));
  } else {
    gcodeView.camera.up.set(0, 1, 0);
  }
  gcodeView.camera.position.set(x, y, z);
  gcodeView.camera.lookAt(gcodeView.target);
  syncGcodeProjection();
  scheduleGcodeRender();
}

function syncGcodeProjection() {
  const camera = gcodeView.camera;
  if (!camera) return;
  const aspect = gcodeView.height > 0 ? gcodeView.width / gcodeView.height : 1;
  const radius = gcodeView.orbit.radius;
  camera.near = Math.max(0.01, radius / 1000);
  camera.far = Math.max(1000, radius * 100);
  if (camera.isOrthographicCamera) {
    const halfH = Math.tan(THREE.MathUtils.degToRad(GCODE_FOV) / 2) * radius;
    camera.top = halfH;
    camera.bottom = -halfH;
    camera.left = -halfH * aspect;
    camera.right = halfH * aspect;
  } else {
    camera.aspect = aspect;
  }
  camera.updateProjectionMatrix();
}

function setGcodeProjection(mode) {
  const projection = mode === "orthographic" ? "orthographic" : "perspective";
  gcodeView.projection = projection;
  if (gcodeView.perspCamera) {
    gcodeView.camera = projection === "orthographic" ? gcodeView.orthoCamera : gcodeView.perspCamera;
    updateGcodeCamera();
  }
  for (const [id, value] of [["gcode-projection-persp", "perspective"], ["gcode-projection-ortho", "orthographic"]]) {
    const btn = document.getElementById(id);
    if (btn) btn.setAttribute("aria-pressed", projection === value ? "true" : "false");
  }
}

function bindGcodeProjectionToggle() {
  const persp = document.getElementById("gcode-projection-persp");
  const ortho = document.getElementById("gcode-projection-ortho");
  if (persp && !persp.dataset.bound) {
    persp.dataset.bound = "1";
    persp.onclick = () => setGcodeProjection("perspective");
  }
  if (ortho && !ortho.dataset.bound) {
    ortho.dataset.bound = "1";
    ortho.onclick = () => setGcodeProjection("orthographic");
  }
}

// View cube axes are main-scene world axes: +x right, +y top, +z front
// (machine X+ right, Z+ up, Y+ toward the back).
const VIEWCUBE_FACES = [
  { label: "RIGHT", rotation: 0 },
  { label: "LEFT", rotation: 0 },
  { label: "TOP", rotation: 0 },
  { label: "BOTTOM", rotation: 0 },
  { label: "FRONT", rotation: 0 },
  { label: "BACK", rotation: 0 },
];

function initGcodeViewCube() {
  if (gcodeView.cube) return;
  const canvas = document.getElementById("gcode-viewcube");
  if (!canvas) return;
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch (e) {
    return;
  }
  const pixelRatio = gcodeRenderPixelRatio();
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(104, 104, false); // matches the fixed CSS size; the widget may be hidden (0x0) at init
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1.75, 1.75, 1.75, -1.75, 0.1, 10);
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);
  const materials = VIEWCUBE_FACES.map((face) => new THREE.MeshBasicMaterial({
    map: makeViewCubeFaceTexture(face.label, face.rotation, renderer),
  }));
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), materials);
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(mesh.geometry),
    new THREE.LineBasicMaterial({ color: 0x5f6c78 }),
  );
  edges.scale.setScalar(1.001);
  mesh.add(edges);
  const hover = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({
      color: 0x57a6d6,
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
    }),
  );
  hover.add(new THREE.LineSegments(
    new THREE.EdgesGeometry(hover.geometry),
    new THREE.LineBasicMaterial({ color: 0xa9ddff, transparent: true, opacity: 0.95 }),
  ));
  hover.visible = false;
  hover.renderOrder = 3;
  mesh.add(hover);
  scene.add(mesh);
  gcodeView.cube = {
    renderer,
    scene,
    camera,
    mesh,
    hover,
    hoverKey: "",
    canvas,
    raycaster: new THREE.Raycaster(),
    width: 104,
    height: 104,
    pixelRatio,
    dragPointerId: null,
    dragStartX: 0,
    dragStartY: 0,
    dragX: 0,
    dragY: 0,
    dragging: false,
    suppressClick: false,
  };
  canvas.addEventListener("pointerdown", onGcodeViewCubePointerDown);
  canvas.addEventListener("pointermove", onGcodeViewCubePointerMove);
  canvas.addEventListener("pointerup", onGcodeViewCubePointerUp);
  canvas.addEventListener("pointercancel", onGcodeViewCubePointerCancel);
  canvas.addEventListener("pointerleave", clearGcodeViewCubeHover);
  canvas.addEventListener("click", onGcodeViewCubeClick);
}

function makeViewCubeFaceTexture(label, rotation, renderer) {
  const size = 512;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#232b31";
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = "#3a444d";
  ctx.lineWidth = 16;
  ctx.strokeRect(8, 8, size - 16, size - 16);
  ctx.translate(size / 2, size / 2);
  ctx.rotate(rotation || 0);
  ctx.font = "700 96px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.lineWidth = 16;
  ctx.strokeStyle = "#12171c";
  ctx.strokeText(label, 0, 0);
  ctx.fillStyle = "#b7c0ca";
  ctx.fillText(label, 0, 0);
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return texture;
}

function renderGcodeViewCube() {
  const cube = gcodeView.cube;
  if (!cube || !gcodeView.camera) return;
  syncGcodeViewCubeResolution(cube);
  cube.mesh.quaternion.copy(gcodeView.camera.quaternion).invert();
  cube.renderer.render(cube.scene, cube.camera);
}

function syncGcodeViewCubeResolution(cube) {
  const rect = cube.canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width || 104));
  const height = Math.max(1, Math.round(rect.height || 104));
  const pixelRatio = gcodeRenderPixelRatio(width, height);
  const ratioChanged = Math.abs(cube.pixelRatio - pixelRatio) > 0.001;
  if (ratioChanged) {
    cube.pixelRatio = pixelRatio;
    cube.renderer.setPixelRatio(pixelRatio);
  }
  if (cube.width !== width || cube.height !== height || ratioChanged) {
    cube.width = width;
    cube.height = height;
    cube.renderer.setSize(width, height, false);
  }
}

function viewCubeTargetComponents(point, faceNormal = null) {
  const band = 0.55;
  const target = {
    x: Math.abs(Number(point?.x) || 0) > band ? Math.sign(Number(point.x)) : 0,
    y: Math.abs(Number(point?.y) || 0) > band ? Math.sign(Number(point.y)) : 0,
    z: Math.abs(Number(point?.z) || 0) > band ? Math.sign(Number(point.z)) : 0,
  };
  if (target.x === 0 && target.y === 0 && target.z === 0 && faceNormal) {
    target.x = Math.sign(Number(faceNormal.x) || 0);
    target.y = Math.sign(Number(faceNormal.y) || 0);
    target.z = Math.sign(Number(faceNormal.z) || 0);
  }
  return target.x === 0 && target.y === 0 && target.z === 0 ? null : target;
}

function gcodeViewCubeTarget(e) {
  const cube = gcodeView.cube;
  if (!cube || !gcodeView.camera) return null;
  const rect = cube.canvas.getBoundingClientRect();
  const ndc = {
    x: ((e.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
    y: -((e.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1,
  };
  cube.mesh.updateMatrixWorld(true);
  cube.raycaster.setFromCamera(ndc, cube.camera);
  const hits = cube.raycaster.intersectObject(cube.mesh, false);
  if (!hits.length) return null;
  const p = cube.mesh.worldToLocal(hits[0].point.clone());
  const target = viewCubeTargetComponents(p, hits[0].face?.normal);
  return target ? new THREE.Vector3(target.x, target.y, target.z) : null;
}

function setGcodeViewCubeHover(dir) {
  const cube = gcodeView.cube;
  if (!cube) return;
  if (!dir) {
    clearGcodeViewCubeHover();
    return;
  }
  const key = `${dir.x},${dir.y},${dir.z}`;
  if (cube.hoverKey === key) return;
  cube.hoverKey = key;
  const { dimensions, position } = viewCubeHoverGeometry(dir);
  cube.hover.scale.set(dimensions[0], dimensions[1], dimensions[2]);
  cube.hover.position.set(position[0], position[1], position[2]);
  cube.hover.visible = true;
  scheduleGcodeRender();
}

function viewCubeHoverGeometry(dir) {
  const axes = [Number(dir?.x) || 0, Number(dir?.y) || 0, Number(dir?.z) || 0];
  const targetAxes = axes.filter((value) => value !== 0).length;
  const thickness = targetAxes === 1 ? 0.05 : targetAxes === 2 ? 0.12 : 0.18;
  const dimensions = axes.map((value) => value === 0 ? 1.05 : thickness);
  const position = axes.map((value, index) =>
    value === 0 ? 0 : Math.sign(value) * (1 + dimensions[index] / 2 + 0.008)
  );
  return { dimensions, position };
}

function clearGcodeViewCubeHover() {
  const cube = gcodeView.cube;
  if (!cube || (!cube.hover.visible && !cube.hoverKey)) return;
  cube.hover.visible = false;
  cube.hoverKey = "";
  cube.canvas.style.cursor = cube.dragPointerId !== null ? "grabbing" : "default";
  scheduleGcodeRender();
}

function onGcodeViewCubePointerDown(e) {
  const cube = gcodeView.cube;
  if (!cube || (typeof e.button === "number" && e.button !== 0)) return;
  if (!gcodeViewCubeTarget(e)) return;
  cube.dragPointerId = e.pointerId;
  cube.dragStartX = e.clientX;
  cube.dragStartY = e.clientY;
  cube.dragX = e.clientX;
  cube.dragY = e.clientY;
  cube.dragging = false;
  clearGcodeViewCubeHover();
  cube.canvas.style.cursor = "grabbing";
  try {
    cube.canvas.setPointerCapture?.(e.pointerId);
  } catch {
    // Pointer capture is best-effort; in-canvas dragging still works without it.
  }
}

function onGcodeViewCubePointerMove(e) {
  const cube = gcodeView.cube;
  if (!cube) return;
  if (cube.dragPointerId === e.pointerId) {
    const step = gcodeCubeDragStep(cube, e.clientX, e.clientY);
    if (!step) return;
    rotateGcodeOrbitByDrag(gcodeView.orbit, step.dx, step.dy);
    clearGcodeViewCubeHover();
    cube.canvas.style.cursor = "grabbing";
    updateGcodeCamera();
    e.preventDefault();
    return;
  }
  const target = gcodeViewCubeTarget(e);
  cube.canvas.style.cursor = target ? "pointer" : "default";
  setGcodeViewCubeHover(target);
}

function gcodeCubeDragStep(drag, clientX, clientY) {
  const totalX = clientX - drag.dragStartX;
  const totalY = clientY - drag.dragStartY;
  if (!drag.dragging && Math.hypot(totalX, totalY) < GCODE_CUBE_DRAG_THRESHOLD_PX) return null;
  let dx = clientX - drag.dragX;
  let dy = clientY - drag.dragY;
  if (!drag.dragging) {
    drag.dragging = true;
    dx = totalX;
    dy = totalY;
  }
  drag.dragX = clientX;
  drag.dragY = clientY;
  return { dx, dy };
}

function finishGcodeViewCubeDrag(e, cancelled = false) {
  const cube = gcodeView.cube;
  if (!cube || cube.dragPointerId !== e.pointerId) return;
  const wasDragging = cube.dragging;
  cube.dragPointerId = null;
  cube.dragging = false;
  try {
    cube.canvas.releasePointerCapture?.(e.pointerId);
  } catch {
    // Capture may already be gone after cancellation or window focus changes.
  }
  cube.canvas.style.cursor = "default";
  if (wasDragging) {
    cube.suppressClick = true;
    setTimeout(() => {
      if (gcodeView.cube === cube) cube.suppressClick = false;
    }, 0);
  } else if (!cancelled) {
    const target = gcodeViewCubeTarget(e);
    cube.canvas.style.cursor = target ? "pointer" : "default";
    setGcodeViewCubeHover(target);
  }
}

function onGcodeViewCubePointerUp(e) {
  finishGcodeViewCubeDrag(e);
}

function onGcodeViewCubePointerCancel(e) {
  finishGcodeViewCubeDrag(e, true);
}

function onGcodeViewCubeClick(e) {
  const cube = gcodeView.cube;
  if (cube?.suppressClick) return;
  const dir = gcodeViewCubeTarget(e);
  if (!dir) return;
  snapGcodeViewTo(dir.normalize());
}

function snapGcodeViewTo(dir) {
  const angles = gcodeOrbitAnglesForDirection(dir);
  gcodeView.orbit.phi = angles.phi;
  gcodeView.orbit.theta = angles.theta;
  updateGcodeCamera();
}

function gcodeOrbitAnglesForDirection(direction) {
  const x = Number(direction?.x) || 0;
  const y = Number(direction?.y) || 0;
  const z = Number(direction?.z) || 0;
  const length = Math.hypot(x, y, z) || 1;
  return {
    theta: Math.atan2(x, z),
    phi: Math.acos(Math.max(-1, Math.min(1, y / length))),
  };
}

function gcodeTimelineLocallyOwned() {
  const slider = document.getElementById("gcode-timeline");
  return !!slider && (
    gcodeView.timelineDragging ||
    slider === document.activeElement ||
    slider.dataset.dragging === "1"
  );
}

function updateGcodeTimeline(total) {
  const slider = document.getElementById("gcode-timeline");
  const label = document.getElementById("gcode-timeline-label");
  if (!slider || !label) return;
  slider.max = String(total);
  slider.disabled = total <= 0;
  gcodeView.cursor = Math.max(0, Math.min(total, gcodeView.cursor));
  const owned = gcodeTimelineLocallyOwned();
  if (owned) {
    const draft = Math.max(0, Math.min(total, Number(slider.value) || 0));
    label.textContent = `${draft} / ${total}`;
    return;
  }
  slider.value = String(gcodeView.cursor);
  label.textContent = `${gcodeView.cursor} / ${total}`;
  slider.setAttribute("aria-valuetext", `${gcodeView.cursor} of ${total} plotted segments`);
}

function updateGcodeProgress() {
  const total = gcodeView.segments.length;
  gcodeView.cursor = Math.max(0, Math.min(total, gcodeView.cursor));
  if (gcodeView.progressLine) {
    gcodeView.progressLine.geometry.setDrawRange(0, gcodeView.cursor * 2);
  }
  const seg = gcodeView.segments[Math.max(0, gcodeView.cursor - 1)];
  const livePosition = gcodeView.followLive ? gcodeView.live?.position : null;
  const markerPosition = livePosition || seg?.to;
  if (markerPosition) {
    const p = gcodeWorldPoint(markerPosition, gcodeView.has4Axis);
    gcodeView.marker.position.copy(p);
    gcodeView.marker.scale.setScalar(Math.max(0.8, gcodeView.orbit.radius * 0.008));
    gcodeView.marker.visible = true;
  } else {
    gcodeView.marker.visible = false;
  }
  if (gcodeView.canvas) {
    const label = livePosition
      ? `Active gcode preview; live spindle at X ${fmtCoord(livePosition[0])}, Y ${fmtCoord(livePosition[1])}, Z ${fmtCoord(livePosition[2])}`
      : "Active gcode preview";
    gcodeView.canvas.setAttribute("aria-label", label);
  }
  updateGcodeTimeline(total);
  syncActiveGcodeSourceLine(gcodeView.live);
  scheduleGcodeRender();
}

function gcodeWorldCoordinates(pos, has4Axis) {
  let x = Number(pos[0]) || 0;
  let y = Number(pos[1]) || 0;
  let z = Number(pos[2]) || 0;
  const a = Number(pos[3]) || 0;
  if (has4Axis) {
    const rad = a * Math.PI / 180;
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    const ry = y * c - z * s;
    const rz = y * s + z * c;
    y = ry;
    z = rz;
  }
  return [x, z, -y];
}

function gcodeWorldPoint(pos, has4Axis) {
  return new THREE.Vector3(...gcodeWorldCoordinates(pos, has4Axis));
}

function setGcodePreviewEmpty(text) {
  const empty = gcodeView.empty || document.getElementById("gcode-preview-empty");
  if (!empty) return;
  empty.textContent = text || "";
  empty.hidden = !text;
  const tools = document.getElementById("gcode-view-tools");
  if (tools) tools.hidden = !!text;
}

function scheduleGcodeRender() {
  if (!gcodeView.renderer || gcodeView.renderQueued) return;
  gcodeView.renderQueued = true;
  requestAnimationFrame(() => {
    gcodeView.renderQueued = false;
    renderGcodeScene();
  });
}

function renderGcodeScene() {
  if (!gcodeView.renderer || !gcodeView.camera || !gcodeView.canvas) return;
  const rect = gcodeView.canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  const pixelRatio = gcodeRenderPixelRatio(width, height);
  const sizeChanged = gcodeView.width !== width || gcodeView.height !== height;
  const ratioChanged = Math.abs(gcodeView.pixelRatio - pixelRatio) > 0.001;
  if (ratioChanged) {
    gcodeView.pixelRatio = pixelRatio;
    gcodeView.renderer.setPixelRatio(pixelRatio);
  }
  if (sizeChanged || ratioChanged) {
    gcodeView.width = width;
    gcodeView.height = height;
    gcodeView.renderer.setSize(width, height, false);
    syncGcodeProjection();
  }
  gcodeView.renderer.render(gcodeView.scene, gcodeView.camera);
  renderGcodeViewCube();
}

async function loadActiveGcode() {
  if (state.activeGcodeLoading) return;
  state.activeGcodeLoading = true;
  try {
    const r = await request("/api/gcode/active");
    state.activeGcode = await r.json();
    clearConnectivityIssue("active-gcode");
    renderActiveGcode();
  } catch (e) {
    setConnectivityIssue("active-gcode", "Active gcode unavailable: " + e.message);
  } finally {
    state.activeGcodeLoading = false;
  }
}

function syncActiveGcodeFromMachine(machine) {
  const path = String(machine?.active_job?.path || "");
  if (!path || path === state.activeGcode?.path || state.activeGcodeLoading) return;
  loadActiveGcode();
}

async function selectActiveGcode(path) {
  state.activeSelectPendingPath = path;
  setActiveFeedback("Loading preview for " + relPath(path) + "...", "");
  renderFiles();
  try {
    const r = await request("/api/gcode/active", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    state.activeGcode = await r.json();
    setActiveFeedback("Preview loaded for " + relPath(path) + ".", "ok");
    showTab("active-job");
  } catch (e) {
    setActiveFeedback("Preview failed: " + e.message, "error");
    setNotice("Select gcode failed: " + e.message, "error", "active-gcode");
  } finally {
    state.activeSelectPendingPath = "";
    renderFiles();
    renderActiveGcode();
  }
}

async function runActiveGcode() {
  const active = state.activeGcode || {};
  if (!active.path) {
    setActiveFeedback("Select an active gcode before running.", "error");
    return;
  }
  if (!active.runnable) {
    setActiveFeedback(active.message || "Active gcode is not runnable.", "error");
    return;
  }
  if (state.machine?.state !== "Idle") {
    setActiveFeedback("Machine must be Idle before running active gcode.", "error");
    return;
  }
  if (state.activeGcodePending) return;
  if (!confirm("Start " + relPath(active.path) + "?")) return;
  state.activeGcodePending = "run";
  setActiveFeedback("Sending run command for " + relPath(active.path) + "...", "");
  renderActiveGcode();
  try {
    const r = await request("/api/gcode/active/run", { method: "POST" });
    const result = await r.json();
    setActiveFeedback(result.message || "Run command sent; machine confirmation was not available.", result.verified ? "ok" : "");
    clearNotice("active-gcode-run");
    pollMachine();
    setTimeout(pollMachine, 1200);
  } catch (e) {
    appendGcodeLine({ seq: "local-" + Date.now(), dir: "recv", source: "api", text: "error: " + e.message });
    setActiveFeedback("Run failed: " + e.message, "error");
    setNotice("Run failed: " + e.message, "error", "active-gcode-run");
  } finally {
    state.activeGcodePending = "";
    renderActiveGcode();
  }
}

async function runActiveJobControl(action) {
  if (state.activeGcodePending) return;
  if (action === "pause_job" && !confirm("Pause the running job and enable manual paused controls?")) return;
  if (action === "resume_job") {
    const spindle = state.machine?.spindle;
    if (spindle && Number(spindle.target_rpm || 0) === 0 && Number(spindle.current_rpm || 0) === 0 &&
        !confirm("The spindle is stopped. Resume will restore the saved job state; continue?")) return;
  }
  state.activeGcodePending = action;
  setActiveFeedback(action === "pause_job" ? "Pausing job..." : "Restoring the paused job...", "");
  renderActiveGcode();
  try {
    const response = await request("/api/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const result = await response.json();
    setActiveFeedback(result.message, result.verified ? "ok" : "error");
    await pollMachine();
  } catch (error) {
    setActiveFeedback((action === "pause_job" ? "Pause failed: " : "Resume failed: ") + error.message, "error");
  } finally {
    state.activeGcodePending = "";
    renderActiveGcode();
  }
}

async function runPausedJobCommand(action) {
  if (state.activeGcodePending) return;
  const body = { action };
  if (action === "raise_z") {
    const distance = Number(document.getElementById("paused-job-raise-distance")?.value);
    if (!Number.isFinite(distance) || distance <= 0 || distance > 50) {
      setActiveFeedback("Raise distance must be greater than 0 and at most 50 mm.", "error");
      return;
    }
    body.distance_mm = distance;
  }
  state.activeGcodePending = action;
  setActiveFeedback(action === "raise_z" ? "Raising Z while the job is paused..." : "Stopping spindle while the job is paused...", "");
  renderActiveGcode();
  try {
    const response = await request("/api/gcode/active/paused-command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    setActiveFeedback(result.message, result.verified ? "ok" : "error");
    await pollMachine();
  } catch (error) {
    setActiveFeedback("Paused command failed: " + error.message, "error");
  } finally {
    state.activeGcodePending = "";
    renderActiveGcode();
  }
}

async function setFeedOverride(percent) {
  if (state.activeGcodePending) return;
  percent = Math.max(50, Math.min(200, Math.round(Number(percent) / 10) * 10));
  if (!Number.isFinite(percent)) return;
  state.activeGcodePending = "feed_override";
  setActiveFeedback("Setting feed override to " + percent + "%...", "");
  renderActiveGcode();
  try {
    const response = await request("/api/feed-override", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ percent }),
    });
    const result = await response.json();
    setActiveFeedback(result.message, result.verified ? "ok" : "error");
    await pollMachine();
  } catch (error) {
    setActiveFeedback("Feed override failed: " + error.message, "error");
  } finally {
    state.activeGcodePending = "";
    renderActiveGcode();
  }
}

function adjustFeedOverride(delta) {
  const current = Number(state.machine?.feed?.override);
  if (!Number.isFinite(current)) return;
  return setFeedOverride(current + delta);
}

function setActiveFeedback(text, kind) {
  setStatusMessage("active-gcode", text, kind, { force: true });
}

function customToolID(inputID) {
  const input = document.getElementById(inputID);
  const toolID = Number(input?.value);
  if (!Number.isInteger(toolID) || toolID < 1 || toolID > 999) {
    return null;
  }
  return toolID;
}

function resetToolSelects() {
  const change = document.getElementById("tool-change-select");
  const set = document.getElementById("tool-set-select");
  if (change) change.value = "";
  if (set) set.value = "";
  toggleToolCustomInput("change", false);
  toggleToolCustomInput("set", false);
}

function toggleToolCustomInput(kind, show) {
  const row = document.getElementById("tool-" + kind + "-row");
  const input = document.getElementById(kind === "change" ? "tool-change-id" : "tool-id");
  if (!row || !input) return;
  row.classList.toggle("has-custom", show);
  input.hidden = !show;
  if (show) {
    input.focus();
    input.select();
  }
}

function handleToolSelect(kind, value) {
  toggleToolCustomInput(kind, value === "other");
  clearToolFeedback();
}

function selectedToolID(kind, allowEmpty) {
  const select = document.getElementById("tool-" + kind + "-select");
  const value = select?.value || "";
  if (value === "other") {
    return customToolID(kind === "change" ? "tool-change-id" : "tool-id");
  }
  if (value === "") return null;
  const toolID = Number(value);
  return validToolID(toolID, allowEmpty) ? toolID : null;
}

async function setCurrentTool(toolID = null) {
  if (!beginToolAction("set")) return;
  if (toolID == null) {
    toolID = selectedToolID("set", true);
  }
  if (!validToolID(toolID, true)) {
    finishToolAction("set");
    setToolFeedback("Choose Empty, Probe, 3D Probe, Laser, or tool 1-999.", "error");
    return;
  }
  const toolName = toolDisplayName(toolID);
  setToolFeedback("Disarming Movement before setting " + toolName + "...", "");
  try {
    await disarmTapMoveForCommand();
    setToolFeedback("Sending set-tool command for " + toolName + "...", "");
    const r = await request("/api/tool/current", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool_id: toolID }),
    });
    const result = await r.json();
    setToolFeedback(result.message || "Set-tool command sent; machine confirmation was not available.", result.verified ? "ok" : "");
    resetToolSelects();
    refreshMachineAfterToolAction();
  } catch (e) {
    appendGcodeLine({ seq: "local-" + Date.now(), dir: "recv", source: "api", text: "error: " + e.message });
    setToolFeedback("Set-tool failed: " + e.message, "error");
  } finally {
    finishToolAction("set");
  }
}

async function changeTool(toolID = null) {
  if (!beginToolAction("change")) return;
  if (toolID == null) {
    toolID = selectedToolID("change", false);
  }
  if (!validToolID(toolID, false)) {
    finishToolAction("change");
    setToolFeedback("Choose Probe, 3D Probe, Laser, or tool 1-999.", "error");
    return;
  }
  const toolName = toolDisplayName(toolID);
  setToolFeedback("Disarming Movement before changing to " + toolName + "...", "");
  try {
    await disarmTapMoveForCommand();
    setToolFeedback("Sending change-tool command for " + toolName + "...", "");
    const r = await request("/api/tool/change", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool_id: toolID }),
    });
    const result = await r.json();
    setToolFeedback(result.message || "Change-tool command sent; machine confirmation was not available.", result.verified ? "ok" : "");
    resetToolSelects();
    refreshMachineAfterToolAction();
  } catch (e) {
    appendGcodeLine({ seq: "local-" + Date.now(), dir: "recv", source: "api", text: "error: " + e.message });
    setToolFeedback("Change-tool failed: " + e.message, "error");
  } finally {
    finishToolAction("change");
  }
}

async function continueToolChange() {
  const continueAvailable = state.machine?.state === "Tool";
  if (!continueAvailable) {
    setToolFeedback("Continue is only available while the machine is awaiting a tool.", "error");
    renderToolActions();
    return;
  }
  if (!beginToolAction("continue")) return;
  setToolFeedback("Continuing tool change...", "");
  try {
    const r = await request("/api/tool/continue", { method: "POST" });
    const result = await r.json();
    setToolFeedback(result.message || "Tool-change continue command sent; machine confirmation was not available.", result.verified ? "ok" : "");
    refreshMachineAfterToolAction();
  } catch (e) {
    appendGcodeLine({ seq: "local-" + Date.now(), dir: "recv", source: "api", text: "error: " + e.message });
    setToolFeedback("Continue failed: " + e.message, "error");
    refreshMachineAfterToolAction();
  } finally {
    finishToolAction("continue");
  }
}

async function calibrateCurrentTool() {
  if (!beginToolAction("calibrate")) return;
  setToolFeedback("Sending calibration command...", "");
  try {
    const r = await request("/api/tool/calibrate", { method: "POST" });
    const result = await r.json();
    setToolFeedback(result.message || "Calibration command sent; machine confirmation was not available.", result.verified ? "ok" : "");
    refreshMachineAfterToolAction();
  } catch (e) {
    appendGcodeLine({ seq: "local-" + Date.now(), dir: "recv", source: "api", text: "error: " + e.message });
    setToolFeedback("Calibration failed: " + e.message, "error");
  } finally {
    finishToolAction("calibrate");
  }
}

function beginToolAction(action) {
  if (state.toolPending) {
    setToolFeedback("Tool action already in progress.", "error");
    renderToolActions();
    return false;
  }
  state.toolPending = action;
  renderToolActions();
  return true;
}

function finishToolAction(action) {
  if (state.toolPending === action) state.toolPending = "";
  renderToolActions();
}

function refreshMachineAfterToolAction() {
  pollMachine();
  setTimeout(pollMachine, 1200);
}

function setElementBusy(el, busy) {
  if (!el) return;
  if (busy) el.setAttribute("aria-busy", "true");
  else el.removeAttribute("aria-busy");
}

function renderToolActions(m = state.machine || {}) {
  const set = document.getElementById("tool-set");
  const change = document.getElementById("tool-change-set");
  const cont = document.getElementById("tool-continue");
  const cal = document.getElementById("tool-calibrate");
  const setSelect = document.getElementById("tool-set-select");
  const changeSelect = document.getElementById("tool-change-select");
  const setInput = document.getElementById("tool-id");
  const changeInput = document.getElementById("tool-change-id");
  const pendingAction = state.toolPending || "";
  const setPending = pendingAction === "set";
  const changePending = pendingAction === "change";
  const continuePending = pendingAction === "continue";
  const calibratePending = pendingAction === "calibrate";
  const waitingForTool = m.state === "Tool";
  const continueAvailable = waitingForTool;
  const row = document.getElementById("tool-wait-row");
  const label = document.getElementById("tool-wait-status");
  if (row) row.classList.toggle("is-waiting", waitingForTool);
  if (label) label.textContent = continueAvailable ? "Awaiting tool" : "Tool change";

  if (setSelect) setSelect.disabled = setPending || waitingForTool;
  if (changeSelect) changeSelect.disabled = changePending || waitingForTool;
  if (setInput) setInput.disabled = setPending || waitingForTool;
  if (changeInput) changeInput.disabled = changePending || waitingForTool;
  if (set) {
    set.disabled = setPending || waitingForTool;
    setSoftDisabled(set, !!pendingAction && !setPending);
    set.textContent = setPending ? "Setting..." : "Set";
    setElementBusy(set, setPending);
  }
  if (change) {
    change.disabled = changePending || waitingForTool;
    setSoftDisabled(change, !!pendingAction && !changePending);
    change.textContent = changePending ? "Changing..." : "Change";
    setElementBusy(change, changePending);
  }
  if (cont) {
    cont.textContent = continuePending ? "Continuing..." : "Continue";
    cont.disabled = continuePending;
    setSoftDisabled(cont, !continuePending && !continueAvailable);
    setElementBusy(cont, continuePending);
  }
  if (cal) {
    cal.disabled = calibratePending || waitingForTool;
    setSoftDisabled(cal, !!pendingAction && !calibratePending);
    cal.textContent = calibratePending ? "Calibrating..." : "Calibrate";
    setElementBusy(cal, calibratePending);
  }
}

function setToolFeedback(text, kind) {
  setStatusMessage("tool", text, kind, { force: true });
}

function clearToolFeedback() {
  setStatusMessage("tool", "");
}

function appendGcodeLine(ln) {
  if (!ln || state.gcodeSeqs.has(ln.seq)) return;
  state.gcodeSeqs.add(ln.seq);
  state.gcodeLines.push(ln);
  if (state.gcodeLines.length > GCODE_MAX_LINES) {
    const drop = state.gcodeLines.splice(0, state.gcodeLines.length - GCODE_MAX_LINES);
    for (const old of drop) state.gcodeSeqs.delete(old.seq);
  }
  if (state.logPaused) return;
  if (!lineMatchesFilter(ln)) return;
  appendGcodeLineElement(ln);
}

function lineMatchesFilter(ln) {
  const q = state.logSearch.trim().toLowerCase();
  if (q) {
    const haystack = `${ln.source || ""} ${ln.dir || ""} ${ln.text || ""}`.toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  switch (state.logFilter) {
  case "send":
  case "recv":
    return ln.dir === state.logFilter;
  case "api":
  case "controller":
  case "jog":
    return ln.source === state.logFilter;
  case "error":
    return /^(error|alarm)/i.test(ln.text || "");
  default:
    return true;
  }
}

function renderGcodeLog() {
  const log = document.getElementById("gcode-log");
  const autoscroll = state.ui.log.autoscroll !== false;
  const scrollTop = log.scrollTop;
  log.innerHTML = "";
  for (const ln of state.gcodeLines) {
    if (lineMatchesFilter(ln)) appendGcodeLineElement(ln, false);
  }
  log.scrollTop = autoscroll ? log.scrollHeight : scrollTop;
}

function appendGcodeLineElement(ln, keepScroll = true) {
  const log = document.getElementById("gcode-log");
  const autoscroll = state.ui.log.autoscroll !== false;
  const atBottom = autoscroll && (!keepScroll || log.scrollHeight - log.scrollTop - log.clientHeight < 8);
  const div = document.createElement("div");
  const isErr = ln.dir === "recv" && /^(error|alarm)/i.test(ln.text || "");
  div.className = ln.dir + (isErr ? " err-line" : "");
  const arrow = ln.dir === "send" ? ">" : "<";
  div.innerHTML = `<span class="src">${escapeHtml(ln.source)} ${arrow}</span> ${escapeHtml(ln.text)}`;
  log.appendChild(div);
  while (log.childNodes.length > GCODE_MAX_LINES) log.removeChild(log.firstChild);
  if (atBottom) log.scrollTop = log.scrollHeight;
}

function clearGcodeLog() {
  state.gcodeSeqs.clear();
  state.gcodeLines = [];
  document.getElementById("gcode-log").innerHTML = "";
}

function visibleGcodeLines() {
  return state.gcodeLines.filter(lineMatchesFilter);
}

function formatLogLine(ln) {
  const when = ln.time ? new Date(ln.time).toISOString() : "";
  const arrow = ln.dir === "send" ? ">" : "<";
  return `${when} ${ln.source || ""} ${arrow} ${ln.text || ""}`.trim();
}

async function copyVisibleLog() {
  const text = visibleGcodeLines().map(formatLogLine).join("\n");
  try {
    if (!navigator.clipboard) throw new Error("clipboard unavailable");
    await navigator.clipboard.writeText(text);
    setNotice("Copied visible log lines.", "ok", "log-copy");
  } catch {
    setNotice("Copy failed.", "error", "log-copy");
  }
}

function exportVisibleLog() {
  const text = visibleGcodeLines().map((ln) => JSON.stringify(ln)).join("\n") + "\n";
  const blob = new Blob([text], { type: "application/x-ndjson" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "cnc-proxy-log.ndjson";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function exportBackup() {
  try {
    const r = await request("/api/backup");
    const blob = await r.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "cnc-proxy-backup.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    setStatusMessage("backup", "Backup exported.", "ok", { force: true });
  } catch (e) {
    setNotice("Backup export failed: " + e.message, "error", "backup");
  }
}

async function importBackupFile(file) {
  if (!file) return;
  if (!confirm("Import this CNC Proxy backup? This replaces local catalog, queue, UI settings, retained logs, and run history.")) return;
  try {
    const text = await file.text();
    await request("/api/backup/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: text,
    });
    setStatusMessage("backup", "Backup imported; reloading...", "ok", { force: true });
    setTimeout(() => location.reload(), 600);
  } catch (e) {
    setNotice("Backup import failed: " + e.message, "error", "backup");
  }
}

async function uploadFiles(fileList) {
  clearNotice("files-action");
  for (const file of fileList) {
    const target = joinRelPath(state.currentDir, file.name);
    const fd = new FormData();
    fd.append("file", file, file.name);
    fd.append("path", target);
    try {
      await request("/api/files", { method: "POST", body: fd });
      setNotice("Queued upload: " + target, "ok", "files-action");
    } catch (e) {
      setNotice("Upload failed for " + file.name + ": " + e.message, "error", "files-action");
    }
  }
}

async function doMkdir() {
  const name = prompt("New folder name:");
  if (!name) return;
  const dir = joinRelPath(state.currentDir, name);
  try {
    await request("/api/dirs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: dir }),
    });
    setNotice("Folder queued: " + dir, "ok", "files-action");
    state.currentDir = cleanRelPath(dir);
    renderFiles();
  } catch (e) {
    setNotice("Folder create failed: " + e.message, "error", "files-action");
  }
}

async function doDelete(path) {
	if (!confirm("Delete " + relPath(path) + "?")) return;
	beginFileAction(path, "Deleting...", "Deleting: " + relPath(path));
	try {
    await request(apiFileURL(path), { method: "DELETE" });
    setNotice("Delete accepted: " + relPath(path), "ok", "files-action");
	} catch (e) {
		setNotice("Delete failed: " + e.message, "error", "files-action");
	} finally {
		endFileAction(path);
	}
}

async function retryJob(job) {
	if (!job) return;
	beginFileAction(job.path, "Retrying...", retryButtonText(job) + ": " + relPath(job.path));
	try {
    await request("/api/files/retry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job_id: job.id }),
    });
    setNotice(retryButtonText(job) + " queued: " + relPath(job.path), "ok", "files-action");
	} catch (e) {
		setNotice("Retry failed: " + e.message, "error", "files-action");
	} finally {
		endFileAction(job.path);
	}
}

async function discardFile(path) {
	if (!confirm("Discard local state for " + relPath(path) + "? This does not delete anything from the machine.")) return;
	beginFileAction(path, "Discarding...", "Discarding local state: " + relPath(path));
	try {
    await request("/api/files/discard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    setNotice("Discarded local state: " + relPath(path), "ok", "files-action");
	} catch (e) {
		setNotice("Discard failed: " + e.message, "error", "files-action");
	} finally {
		endFileAction(path);
	}
}

async function doRename(path) {
  const currentName = basename(path);
  const nextName = prompt("Rename to:", currentName);
  if (!nextName || nextName === currentName) return;
	const dir = dirname(path);
	const to = dir ? dir + "/" + nextName : nextName;
	beginFileAction(path, "Renaming...", "Renaming: " + relPath(path));
	try {
    await request("/api/files/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: path, to }),
    });
    setNotice("Rename queued: " + relPath(path) + " -> " + to, "ok", "files-action");
	} catch (e) {
		setNotice("Rename failed: " + e.message, "error", "files-action");
	} finally {
		endFileAction(path);
	}
}

function beginFileAction(path, buttonLabel, notice) {
	state.fileActions.set(path, buttonLabel);
	setNotice(notice, "info", "files-action", { timeoutMs: 0, force: true });
	renderFiles();
}

function endFileAction(path) {
	state.fileActions.delete(path);
	renderFiles();
}

function submitGcode(line) {
  line = String(line || "").trim();
  if (!line) return;
  rememberCommand(line);
  sendGcode(line);
}

function navigateCommandHistory(input, dir) {
  if (!state.commandHistory.length) return;
  if (dir < 0 && state.historyIndex < state.commandHistory.length - 1) {
    state.historyIndex++;
  } else if (dir > 0 && state.historyIndex >= 0) {
    state.historyIndex--;
  }
  input.value = state.historyIndex >= 0 ? state.commandHistory[state.historyIndex] : "";
  input.setSelectionRange(input.value.length, input.value.length);
}

function renderMacroButtons() {
  renderMacroRegion("toolbar", document.getElementById("macro-toolbar"));
  renderMacroRegion("panel", document.getElementById("macro-panel"));
}

function renderMacroRegion(region, box) {
  box.innerHTML = "";
  for (const slot of sortedSlots(region)) {
    const macro = macroByID(slot.macro_id);
    if (!macro) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "macro-button " + region;
    btn.textContent = macro.name;
    btn.title = macro.description || macro.lines.join("\n");
    if (macro.color) btn.style.borderColor = macro.color;
    btn.disabled = state.macroRunning;
    bindButtonAction(btn, () => runMacro(macro));
    box.appendChild(btn);
  }
}

function renderMacroEditor() {
  const list = document.getElementById("macro-list");
  list.innerHTML = "";
  for (const macro of state.ui.macros) {
    const row = document.createElement("div");
    row.className = "macro-row" + (macro.id === state.selectedMacroId ? " active" : "");
    row.innerHTML = `<button type="button" class="chip">${escapeHtml(macro.name)}</button><span class="muted">${escapeHtml(slotForMacro(macro.id)?.region || "none")}</span>`;
    row.querySelector("button").onclick = () => {
      if (macro.id !== state.selectedMacroId && !confirmDiscardMacroDraft()) return;
      clearControlDrafts(MACRO_EDITOR_IDS);
      state.selectedMacroId = macro.id;
      renderMacroEditor();
    };
    list.appendChild(row);
  }
  const macro = macroByID(state.selectedMacroId);
  setControlValueIfIdle("macro-name", macro?.name || "");
  setControlValueIfIdle("macro-description", macro?.description || "");
  setControlValueIfIdle("macro-color", macro?.color || "");
  setControlValueIfIdle("macro-lines", macro ? macro.lines.join("\n") : "");
  setControlValueIfIdle("macro-placement", macro ? (slotForMacro(macro.id)?.region || "none") : "none");
  document.getElementById("macro-save").disabled = false;
  const run = document.getElementById("macro-run");
  run.disabled = !!state.macroRunning;
  setSoftDisabled(run, !state.macroRunning && !macro);
  document.getElementById("macro-up").disabled = !macro || !slotForMacro(macro.id);
  document.getElementById("macro-down").disabled = !macro || !slotForMacro(macro.id);
  document.getElementById("macro-delete").disabled = !macro;
}

function currentMacroFromForm() {
  const existing = macroByID(state.selectedMacroId);
  const name = document.getElementById("macro-name").value.trim();
  const lines = document.getElementById("macro-lines").value.split(/\r?\n/).map((ln) => ln.trim()).filter(Boolean);
  if (!name || !lines.length) return null;
  const now = new Date().toISOString();
  return {
    id: existing?.id || newID("macro"),
    name,
    description: document.getElementById("macro-description").value.trim(),
    color: document.getElementById("macro-color").value.trim(),
    lines,
    created_at: existing?.created_at || now,
    updated_at: now,
  };
}

function saveMacroFromForm() {
  const macro = currentMacroFromForm();
  if (!macro) {
    setNotice("Macro requires a name and at least one line.", "error", "macro-edit");
    return;
  }
  const idx = state.ui.macros.findIndex((m) => m.id === macro.id);
  if (idx >= 0) state.ui.macros[idx] = macro;
  else state.ui.macros.push(macro);
  state.selectedMacroId = macro.id;
  setMacroPlacement(macro.id, document.getElementById("macro-placement").value);
  clearControlDrafts(MACRO_EDITOR_IDS);
  renderMacroButtons();
  renderMacroEditor();
  renderGamepadSettings();
  clearNotice("macro-edit");
  queueSaveUISettings();
}

function newMacro() {
  if (!confirmDiscardMacroDraft()) return;
  clearControlDrafts(MACRO_EDITOR_IDS);
  state.selectedMacroId = "";
  renderMacroEditor();
  document.getElementById("macro-name").value = "";
  document.getElementById("macro-description").value = "";
  document.getElementById("macro-color").value = "";
  document.getElementById("macro-lines").value = "";
  document.getElementById("macro-placement").value = "panel";
  document.getElementById("macro-name").focus();
}

function macroEditorDirty() {
  return MACRO_EDITOR_IDS.some((id) => document.getElementById(id)?.dataset.dirty === "1");
}

function confirmDiscardMacroDraft() {
  return !macroEditorDirty() || confirm("Discard unsaved macro edits?");
}

function deleteSelectedMacro() {
  const macro = macroByID(state.selectedMacroId);
  if (!macro || !confirm("Delete macro " + macro.name + "?")) return;
  state.ui.macros = state.ui.macros.filter((m) => m.id !== macro.id);
  state.ui.macro_buttons = state.ui.macro_buttons.filter((s) => s.macro_id !== macro.id);
  state.ui.gamepad.macro_buttons = state.ui.gamepad.macro_buttons.filter((s) => s.macro_id !== macro.id);
  state.selectedMacroId = state.ui.macros[0]?.id || "";
  clearControlDrafts(MACRO_EDITOR_IDS);
  renderMacroButtons();
  renderMacroEditor();
  renderGamepadSettings();
  queueSaveUISettings();
}

function moveSelectedMacro(dir) {
  const macro = macroByID(state.selectedMacroId);
  const slot = macro && slotForMacro(macro.id);
  if (!slot) return;
  const slots = sortedSlots(slot.region);
  const idx = slots.findIndex((s) => s.id === slot.id);
  const next = idx + dir;
  if (next < 0 || next >= slots.length) return;
  const a = slots[idx].order;
  slots[idx].order = slots[next].order;
  slots[next].order = a;
  normalizeSlotOrder();
  renderMacroButtons();
  renderMacroEditor();
  queueSaveUISettings();
}

async function runMacro(macro, opts = {}) {
  if (!macro) {
    setNotice("Select a macro before running.", "error", "macro-run");
    return;
  }
  if (!macro.lines.length) {
    setNotice("Macro has no commands.", "error", "macro-run");
    return;
  }
  if (state.macroRunning) {
    setNotice("A macro is already running.", "error", "macro-run");
    return;
  }
  if (macro.lines.length > 1 && !confirm("Run macro " + macro.name + "?")) return;
  state.macroRunning = true;
  renderMacroButtons();
  renderMacroEditor();
  setNotice((opts.source === "gamepad" ? "Gamepad macro: " : "Running macro: ") + macro.name, "info", "macro-run");
  try {
    for (const line of macro.lines) {
      rememberCommand(line);
      const ok = await sendGcode(line);
      if (!ok) {
        setNotice("Macro stopped after error: " + macro.name, "error", "macro-run");
        return;
      }
    }
    setNotice("Macro completed: " + macro.name, "ok", "macro-run");
  } finally {
    state.macroRunning = false;
    renderMacroButtons();
    renderMacroEditor();
  }
}

function completeCommandDisarm(seq, message = "") {
  const pending = state.jog.commandDisarm;
  if (!pending || pending.seq !== seq) return false;
  state.jog.commandDisarm = null;
  clearTimeout(pending.timer);
  if (message) pending.reject(new Error(message));
  else pending.resolve();
  return true;
}

function disarmTapMoveForCommand() {
  if (!state.jog.armed) return Promise.resolve();
  if (state.jog.commandDisarm) return state.jog.commandDisarm.promise;
  if (state.jog.link !== "online") return Promise.reject(new Error("Movement is not connected."));

  const seq = state.jog.seq++;
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  const pending = { seq, resolve, reject, promise, timer: null };
  state.jog.commandDisarm = pending;
  pending.timer = setTimeout(() => {
    if (completeCommandDisarm(seq, "Movement did not disarm before the command.")) {
      state.jog.tapFeedback = "Movement did not disarm before the command.";
      state.jog.tapFeedbackKind = "error";
      renderJog();
    }
  }, 2000);
  if (!sendJog({ type: "disarm", seq })) {
    completeCommandDisarm(seq, "Movement is not connected.");
    return promise;
  }
  state.jog.armPending = seq;
  state.jog.armPendingAction = "disarm";
  state.jog.tapFeedback = "Disarming Movement before command.";
  state.jog.tapFeedbackKind = "";
  renderJog();
  return promise;
}

async function sendGcode(line) {
  try {
    await disarmTapMoveForCommand();
    await request("/api/gcode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ line }),
    });
    return true;
  } catch (e) {
    appendGcodeLine({ seq: "local-" + Date.now(), dir: "recv", source: "api", text: "error: " + e.message });
    return false;
  }
}

// sendControl injects a realtime control action or explicit recovery action.
// Show immediate feedback because recovery commands may be sent while the log is
// filtered or the machine remains in Alarm until the next status poll.
async function sendControl(action) {
  const noticeKey = "control-" + action;
  state.controlPendingAction = action;
  if (action === "recover") state.lastControlResult = null;
  setControlButtonsPending(action, true);
  renderMachine();
  setNotice(controlPendingText(action), "info", noticeKey);
  try {
    const resp = await request("/api/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    let result = null;
    if ((resp.headers.get("Content-Type") || "").includes("application/json")) {
      result = await resp.json();
    }
    if (result) state.lastControlResult = result;
    setNotice(controlSuccessText(action, result), "ok", noticeKey);
    pollMachine();
    setTimeout(pollMachine, 1200);
  } catch (e) {
    if (action === "recover") {
      state.lastControlResult = { action, recovered: false, failed: true, message: e.message };
    }
    appendGcodeLine({ seq: "local-" + Date.now(), dir: "recv", source: "api", text: "error: " + e.message });
    setNotice(controlErrorText(action, e.message), "error", noticeKey);
  } finally {
    state.controlPendingAction = "";
    setControlButtonsPending(action, false);
    renderMachine();
  }
}

function setControlButtonsPending(action, pending) {
  const ids = {
    hold: "ctl-hold",
    resume: "ctl-resume",
    halt: "ctl-halt",
  };
  const buttons = Array.from(document.querySelectorAll("[data-control-action]"))
    .filter((btn) => btn.dataset.controlAction === action);
  const id = ids[action];
  if (id) {
    const btn = document.getElementById(id);
    if (btn) buttons.push(btn);
  }
  for (const btn of buttons) {
    btn.disabled = pending;
  }
}

function controlPendingText(action) {
  switch (action) {
  case "unlock":
    return "Sending unlock...";
  case "home":
    return "Sending home...";
  case "reset":
    return "Sending reset...";
  case "recover":
    return "Recovering alarm...";
  case "hold":
    return "Sending hold...";
  case "resume":
    return "Sending resume...";
  case "halt":
    return "Sending halt...";
  default:
    return "Sending control: " + action;
  }
}

function controlSuccessText(action, result = null) {
  if (result?.message) return result.message;
  switch (action) {
  case "recover":
    return "Recovery command sent.";
  case "unlock":
    return "Unlock sent. If the alarm clears, home before moving.";
  case "home":
    return "Home sent.";
  case "reset":
    return "Reset sent. Wait for reconnect, then home.";
  case "hold":
    return "Hold sent.";
  case "resume":
    return "Resume sent.";
  case "halt":
    return "Halt sent.";
  default:
    return "Control sent: " + action;
  }
}

function controlErrorText(action, message) {
  return action + " failed: " + message;
}

function confirmControl(action) {
  switch (action) {
  case "recover":
    return confirm("Recover this alarm? Clear the physical cause first. For soft limits, the proxy will unlock and verify status; home before moving afterward.");
  case "unlock":
    return confirm("Unlock the alarm? Clear the physical cause first. Home the machine before moving afterward.");
  case "home":
    return confirm("Home the machine now? Make sure the work area is clear.");
  case "reset":
    return confirm("Reset the machine controller? Reconnect and home the machine afterward.");
  default:
    return true;
  }
}

function bindDataControlButtons() {
  document.querySelectorAll("[data-control-action]").forEach((btn) => {
    bindButtonAction(btn, (e) => {
      e.preventDefault();
      const action = btn.dataset.controlAction;
      if (confirmControl(action)) sendControl(action);
    });
  });
}

function commandPanelPlacement(rect, preferredWidth, viewportWidth, viewportHeight) {
  const margin = 12;
  const width = Math.max(0, Math.min(preferredWidth, viewportWidth - margin * 2));
  const maxLeft = Math.max(margin, viewportWidth - margin - width);
  const left = Math.round(Math.min(Math.max(rect.left + rect.width / 2 - width / 2, margin), maxLeft));
  const belowTop = rect.bottom + 8;
  const belowHeight = viewportHeight - belowTop - margin;
  const aboveHeight = rect.top - margin - 8;
  const placeAbove = belowHeight < 180 && aboveHeight > belowHeight;
  const top = placeAbove
    ? Math.max(margin, rect.top - 8 - Math.max(0, aboveHeight))
    : Math.max(margin, belowTop);
  const maxHeight = Math.max(0, placeAbove ? aboveHeight : belowHeight);
  const arrowMin = Math.min(16, Math.max(0, width - 10));
  const arrowMax = Math.max(arrowMin, width - 26);
  const arrowLeft = Math.round(Math.min(Math.max(rect.left + rect.width / 2 - left - 5, arrowMin), arrowMax));
  return { top: Math.round(top), left, width, maxHeight: Math.round(maxHeight), arrowLeft, placement: placeAbove ? "above" : "below" };
}

function commandPopoutSummary(popout) {
  return Array.from(popout?.children || []).find((el) => el.tagName === "SUMMARY") || null;
}

function closeCommandPopout(popout, restoreFocus = true) {
  if (!popout?.open) return;
  popout.open = false;
  if (restoreFocus) commandPopoutSummary(popout)?.focus();
}

function initCommandPopouts() {
  const popouts = Array.from(document.querySelectorAll(".command-popout"));
  const commandMenu = document.getElementById("command-menu");
  const commandActions = document.getElementById("command-actions");
  const mobileToggle = document.getElementById("mobile-actions-toggle");
  let positionFrame = 0;

  function setMobileMenuOpen(open) {
    commandActions?.classList.toggle("mobile-menu-open", !!open);
    mobileToggle?.setAttribute("aria-expanded", String(!!open));
  }

  mobileToggle?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    setMobileMenuOpen(!commandActions?.classList.contains("mobile-menu-open"));
  });

  const directChild = (el, predicate) => Array.from(el.children).find(predicate) || null;
  function positionPopout(popout) {
    if (!popout.open) return;
    const trigger = directChild(popout, (el) => el.tagName === "SUMMARY");
    const panel = directChild(popout, (el) => el.classList.contains("command-panel"));
    if (!trigger || !panel) return;

    const rect = trigger.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1024;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 768;
    const preferredWidth = Number.parseFloat(getComputedStyle(panel).getPropertyValue("--command-panel-pref-width")) || 440;
    const placement = commandPanelPlacement(rect, preferredWidth, viewportWidth, viewportHeight);

    panel.style.setProperty("--command-panel-top", placement.top + "px");
    panel.style.setProperty("--command-panel-left", placement.left + "px");
    panel.style.setProperty("--command-panel-width", placement.width + "px");
    panel.style.setProperty("--command-panel-max-height", placement.maxHeight + "px");
    panel.style.setProperty("--command-panel-arrow-left", placement.arrowLeft + "px");
    panel.dataset.placement = placement.placement;
  }

  function positionOpenPopouts() {
    positionFrame = 0;
    for (const popout of popouts) positionPopout(popout);
  }

  function schedulePopoutPosition() {
    if (positionFrame) return;
    positionFrame = requestAnimationFrame(positionOpenPopouts);
  }

  for (const popout of popouts) {
    const trigger = commandPopoutSummary(popout);
    const panel = directChild(popout, (el) => el.classList.contains("command-panel"));
    const closeButton = panel?.querySelector(".command-panel-close");
    if (trigger) trigger.setAttribute("aria-expanded", "false");
    closeButton?.addEventListener("click", () => closeCommandPopout(popout));
    popout.addEventListener("toggle", () => {
      if (trigger) trigger.setAttribute("aria-expanded", String(popout.open));
      if (!popout.open) return;
      if (panel) panel.scrollTop = 0;
      for (const other of popouts) {
        if (other !== popout) closeCommandPopout(other, false);
      }
      schedulePopoutPosition();
    });
  }
  document.addEventListener("click", (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest(".command-popout")) return;
    for (const popout of popouts) closeCommandPopout(popout, false);
    if (!target?.closest("#command-actions")) setMobileMenuOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    for (const popout of popouts) closeCommandPopout(popout);
    setMobileMenuOpen(false);
    mobileToggle?.focus();
  });
  window.addEventListener("resize", schedulePopoutPosition);
  window.addEventListener("scroll", schedulePopoutPosition, true);
  commandMenu?.addEventListener("scroll", schedulePopoutPosition, { passive: true });
  window.visualViewport?.addEventListener("resize", schedulePopoutPosition);
  window.visualViewport?.addEventListener("scroll", schedulePopoutPosition);
}

async function loadJogCapabilities() {
  try {
    const r = await request("/api/jog/capabilities");
    state.jog.caps = await r.json();
    state.jog.availability = state.jog.caps.availability || null;
    clearConnectivityIssue("jog-capabilities");
    state.ui.machine = normalizeMachineSettings(state.ui.machine);
    if (state.jog.caps.enabled) connectJog();
    else disableJogConnection();
  } catch (e) {
    setConnectivityIssue("jog-capabilities", "Jog controls unavailable: " + e.message);
    state.jog.error = "";
    state.jog.errorCode = "";
    state.jog.link = "unavailable";
  }
  renderMachineSettings();
  renderJog();
}

function jogURL() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return proto + "//" + location.host + "/api/jog/ws";
}

function connectJog() {
  // Capabilities are authoritative. Do not create a WebSocket until they are
  // known, and never enter the reconnect loop when the server has disabled
  // jogging. A disabled feature is a stable UI state, not an operator error.
  if (!state.jog.caps) {
    state.jog.link = "checking";
    renderJog();
    return;
  }
  if (!state.jog.caps.enabled) {
    disableJogConnection();
    renderJog();
    return;
  }
  if (!("WebSocket" in window)) {
    state.jog.link = "unsupported";
    state.jog.error = "WebSocket unavailable";
    renderJog();
    return;
  }
  const existing = state.jog.ws;
  if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) return;
  clearJogReconnect();
  const ws = new WebSocket(jogURL());
  state.jog.ws = ws;
  state.jog.link = "connecting";
  renderJog();
  ws.onopen = () => {
    if (state.jog.ws !== ws) return;
    state.jog.link = "online";
    state.jog.reconnectAttempt = 0;
    state.jog.error = "";
    state.jog.errorCode = "";
    resetJogInputSender();
    renderJog();
  };
  ws.onclose = () => {
    if (state.jog.ws !== ws) return;
    state.jog.ws = null;
    state.jog.link = "offline";
    state.jog.armed = false;
    clearDisconnectedJogInput();
    state.jog.disarmAfterPendingArm = false;
    state.jog.sent.clear();
    failOutlineCaptureIntents("movement connection closed before the position was captured");
    resetJogInputSender();
    completeCommandDisarm(state.jog.commandDisarm?.seq, "Movement disconnected before the command.");
    if (state.jog.armQueuedAction) {
      const action = state.jog.armQueuedAction;
      state.jog.armQueuedAction = "";
      state.jog.tapFeedback = tapMoveArmFailureText(action, "jog service disconnected");
      state.jog.tapFeedbackKind = "error";
    }
    if (state.jog.armPending) {
      const action = state.jog.armPendingAction;
      state.jog.armPending = 0;
      state.jog.armPendingAction = "";
      state.jog.tapFeedback = tapMoveArmFailureText(action, "jog service disconnected");
      state.jog.tapFeedbackKind = "error";
    }
    if (state.jog.targetPending || state.jog.targetMotionPending) {
      state.jog.targetPending = 0;
      state.jog.targetMotionPending = 0;
      cancelWorkCoordinateMove();
      clearFieldProbeMove();
      state.jog.tapFeedback = "Move failed: jog service disconnected.";
      state.jog.tapFeedbackKind = "error";
    }
    if (state.jog.zStepPending) {
      state.jog.zStepPending = 0;
      state.jog.tapFeedback = "Z move failed: jog service disconnected.";
      state.jog.tapFeedbackKind = "error";
    }
    if (state.jog.surfaceStepPending) {
      state.jog.surfaceStepPending = 0;
      setStatusMessage("surface-jog", "Jog failed: jog service disconnected.", "error", { force: true });
    }
    if (state.jog.originPendingMode === "jog" && hasPendingOriginOperation()) {
      const label = originTargetLabel(state.jog.originPendingLabel, state.jog.originPendingTargets);
      clearOriginVerification();
      setOriginFeedback("Set " + label + " failed: jog service disconnected.", "error");
    }
    renderJog();
    scheduleJogReconnect();
  };
  ws.onerror = () => {
    if (state.jog.ws !== ws) return;
    state.jog.error = "jog socket error";
    state.jog.errorCode = "";
    renderJog();
    try {
      ws.close();
    } catch {
      // Browser will report the close asynchronously.
    }
  };
  ws.onmessage = (e) => {
    if (state.jog.ws !== ws) return;
    try {
      applyJogEvent(JSON.parse(e.data));
    } catch (err) {
      state.jog.error = "bad jog event: " + err.message;
      state.jog.errorCode = "";
      renderJog();
    }
  };
}

function disableJogConnection() {
  clearJogReconnect();
  const ws = state.jog.ws;
  state.jog.ws = null;
  state.jog.link = "disabled";
  state.jog.armed = false;
  state.jog.armQueuedAction = "";
  state.jog.error = "";
  state.jog.errorCode = "";
  clearDisconnectedJogInput();
  if (ws) {
    try {
      ws.close(1000, "jogging disabled");
    } catch {
      // The socket may already be closing; clearing our reference is enough.
    }
  }
}

function clearJogReconnect() {
  if (state.jog.reconnectTimer) {
    clearTimeout(state.jog.reconnectTimer);
    state.jog.reconnectTimer = null;
  }
}

function scheduleJogReconnect() {
  if (!state.jog.caps?.enabled) {
    clearJogReconnect();
    return;
  }
  if (state.jog.reconnectTimer || document.hidden) return;
  const attempt = Math.min(state.jog.reconnectAttempt++, 5);
  const delay = Math.min(10000, 500 * 2 ** attempt);
  state.jog.link = "reconnecting";
  renderJog();
  state.jog.reconnectTimer = setTimeout(() => {
    state.jog.reconnectTimer = null;
    connectJog();
  }, delay);
}

function sameJogInput(a, b) {
  return !!a && !!b && a.deadman === b.deadman && a.slow === b.slow && sameJogAxes(a.axes, b.axes);
}

function jogInputActive(input) {
  return !!input?.deadman && ["x", "y", "z"].some((axis) => Math.abs(Number(input.axes?.[axis] || 0)) > JOG_INPUT_DEADZONE);
}

function resetJogInputSender() {
  state.jog.lastInput = null;
  state.jog.lastInputSentAt = 0;
}

function clearDisconnectedJogInput() {
  resetMobileWorkAreaJog();
  state.jog.surfaceInput = null;
  if (state.jog.surfaceWheel) {
    state.jog.surfaceWheel.pointerId = null;
    state.jog.surfaceWheel.lastAngle = null;
    state.jog.surfaceWheel.remainder = 0;
    state.jog.surfaceWheel.gestureSteps = 0;
    state.jog.surfaceWheel.gestureAccepted = 0;
    state.jog.surfaceWheel.gestureReleased = false;
    state.jog.surfaceWheel.gestureAxis = "";
    state.jog.surfaceWheel.blocked = false;
  }
  state.jog.pad = "";
  state.jog.deadman = false;
  state.jog.axes = { x: 0, y: 0, z: 0 };
  state.jog.buttons = [];
  state.jog.surfaceStepSource = "";
  resetJogInputSender();
}

function sendJogInput(msg, force = false) {
  const ws = state.jog.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    connectJog();
    return 0;
  }

  const input = {
    type: "input",
    deadman: !!msg.deadman,
    slow: !!msg.slow,
    axes: {
      x: clampAxis(Number(msg.axes?.x || 0)),
      y: clampAxis(Number(msg.axes?.y || 0)),
      z: clampAxis(Number(msg.axes?.z || 0)),
    },
  };
  const now = performance.now();
  const previous = state.jog.lastInput;
  const changed = !sameJogInput(previous, input);
  const urgentStop = jogInputActive(previous) && !jogInputActive(input);
  const heartbeatDue = jogInputActive(input) && now - Number(state.jog.lastInputSentAt || 0) >= JOG_INPUT_HEARTBEAT_MS;
  if (!force && !changed && !heartbeatDue) return 0;

  // Gamepad intent is latest-wins. Never build a browser-side train of stale
  // active samples behind a congested WebSocket; the next sample retries the
  // newest axes. A stop always enters the socket immediately and therefore
  // sits behind at most the one frame the browser has already handed off.
  if (!force && !urgentStop && Number(ws.bufferedAmount || 0) > 0) return 0;
  input.seq = msg.seq || state.jog.seq++;
  ws.send(JSON.stringify(input));
  state.jog.lastInput = input;
  state.jog.lastInputSentAt = now;
  return input.seq;
}

function sendJog(msg, force = false) {
  if (msg.type === "input") return sendJogInput(msg, force);
  const ws = state.jog.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    connectJog();
    return 0;
  }
  if (!msg.seq) msg.seq = state.jog.seq++;
  state.jog.sent.set(msg.seq, performance.now());
  ws.send(JSON.stringify(msg));
  return msg.seq;
}

function setTapFeedback(text, kind = "") {
  state.jog.tapFeedback = text;
  state.jog.tapFeedbackKind = kind;
  renderJog();
}

function consumeJogAlertFeedback(key, holder, textProp, kindProp) {
  const text = holder[textProp];
  if (!text) return;
  const kind = holder[kindProp];
  holder[textProp] = "";
  holder[kindProp] = "";
  if (kind === "error") setStatusMessage(key, text, kind, { force: true });
  else clearNotice(key);
}

function tapMoveArmProgressText(action) {
  return action === "arm" ? "Arming Movement..." : "Disarming Movement...";
}

function tapMoveArmSuccessText(action) {
  return action === "arm" ? "Movement armed." : "Movement disarmed.";
}

function tapMoveArmFailureText(action, detail) {
  const prefix = action === "disarm" ? "Disarm failed: " : "Arm failed: ";
  return prefix + detail;
}

function sendTapMoveArmAction(action) {
  const seq = sendJog({ type: action });
  if (!seq) {
    return false;
  }
  state.jog.armQueuedAction = "";
  state.jog.armPending = seq;
  state.jog.armPendingAction = action;
  state.jog.tapFeedback = tapMoveArmProgressText(action);
  state.jog.tapFeedbackKind = "";
  renderJog();
  return true;
}

function requestMovementDisarm() {
  if (state.jog.armQueuedAction === "arm") {
    state.jog.armQueuedAction = "";
    state.jog.tapFeedback = "Movement remains disarmed.";
    state.jog.tapFeedbackKind = "ok";
    renderJog();
    return true;
  }
  releaseJogInput(true);
  if (state.jog.armPending) {
    if (state.jog.armPendingAction === "arm") {
      state.jog.disarmAfterPendingArm = true;
      state.jog.tapFeedback = "Waiting to disarm Movement.";
      state.jog.tapFeedbackKind = "";
      renderJog();
    }
    return true;
  }
  if (!state.jog.armed) return false;
  if (sendTapMoveArmAction("disarm")) return true;
  state.jog.tapFeedback = tapMoveArmFailureText("disarm", "jog service is not connected");
  state.jog.tapFeedbackKind = "error";
  renderJog();
  return false;
}

function disarmMovementOnControlExit(nextTab) {
  const movementView = state.activeTab === "control" || state.activeTab === "jog";
  if (!movementView || nextTab === state.activeTab) return false;
  return requestMovementDisarm();
}

function flushQueuedTapMoveArm() {
  const action = state.jog.armQueuedAction;
  if (!action || state.jog.armPending || state.jog.link !== "online") return false;
  return sendTapMoveArmAction(action);
}

function toggleTapMoveArm() {
  if (state.jog.armPending || state.jog.armQueuedAction) return;
  if (hasPendingOriginOperation()) {
    setTapFeedback("Finish setting origin before changing Movement arm state.", "error");
    return;
  }
  if (state.jog.caps && !state.jog.caps.enabled) {
    setTapFeedback(jogErrorText("disabled"), "error");
    return;
  }
  if (state.jog.link === "unsupported") {
    setTapFeedback("Jog service is unavailable in this browser.", "error");
    return;
  }
  if (movementOwnedElsewhere() && !confirm("Movement is armed in another controller. Disarm that controller's movement session?")) return;
  const action = (state.jog.armed || movementOwnedElsewhere()) ? "disarm" : "arm";
  if (state.jog.armed) releaseJogInput(true);
  if (state.jog.link !== "online") {
    state.jog.armQueuedAction = action;
    state.jog.tapFeedback = "Connecting to jog service...";
    state.jog.tapFeedbackKind = "";
    connectJog();
    renderJog();
    return;
  }
  if (!sendTapMoveArmAction(action)) {
    setTapFeedback("Jog service is not connected.", "error");
  }
}

function currentTapFeed() {
  const input = document.getElementById("tap-feed-mm-min");
  const fallback = state.ui.machine?.tap_feed_mm_min || defaultMachineSettings().tap_feed_mm_min;
  const bounds = feedBoundsFor(state.ui.machine);
  const raw = String(input?.value ?? "").trim();
  const value = raw === "" ? NaN : Number(raw);
  if (!Number.isFinite(value)) {
    input?.setCustomValidity("Enter a feed rate.");
    input?.reportValidity?.();
    throw new Error("Feed must be a number.");
  }
  input?.setCustomValidity("");
  return clampNumber(finiteOr(value, fallback), bounds.min, bounds.max);
}

function workMoveInput(axis) {
  return document.getElementById("work-move-" + axis);
}

function workMoveField(axis) {
  return document.querySelector('[data-work-move-axis="' + axis + '"]');
}

function workMoveInputIsLive(input) {
  return input?.dataset.dirty !== "1";
}

function renderWorkMoveFieldState(axis, input) {
  const field = workMoveField(axis);
  const reset = document.querySelector('[data-work-move-reset="' + axis + '"]');
  const live = workMoveInputIsLive(input);
  if (field) {
    field.classList.toggle("is-live", live);
    field.classList.toggle("is-stale", !live);
    field.dataset.workMoveState = live ? "live" : "stale";
    field.title = live
      ? "Work " + axis.toUpperCase() + " follows the current coordinate."
      : "Work " + axis.toUpperCase() + " is edited; reset to follow the current coordinate.";
  }
  if (reset) {
    reset.disabled = live;
    reset.title = "Reset Work " + axis.toUpperCase() + " to current coordinate";
    reset.setAttribute("aria-label", reset.title);
  }
}

function renderWorkMoveControls(originBusy = hasPendingOriginOperation()) {
  const { wpos } = currentAxisValues();
  const busy = tapMoveTargetBusy() || !!state.jog.zStepPending || originBusy;
  for (const axis of ["x", "y", "z"]) {
    const input = workMoveInput(axis);
    if (!input) continue;
    const value = axisValue(wpos, axis);
    if (workMoveInputIsLive(input) && !controlLocallyOwned(input)) {
      input.value = value === null ? "" : formatOriginValue(value);
    }
    input.disabled = busy;
    renderWorkMoveFieldState(axis, input);
  }
  const btn = document.getElementById("work-move-send");
  if (!btn) return;
  const ready = !!state.jog.caps?.enabled && state.jog.link === "online" && state.jog.armed && !busy;
  btn.disabled = busy;
  setSoftDisabled(btn, !busy && !ready);
}

function workMoveTargetLabel(workTargets) {
  const parts = ["x", "y", "z"]
    .filter((axis) => Number.isFinite(Number(workTargets?.[axis])))
    .map((axis) => axis.toUpperCase() + " " + formatOriginValue(workTargets[axis]));
  return "W " + parts.join(" ");
}

function resetWorkMoveInput(axis) {
  const input = workMoveInput(axis);
  if (!input) return;
  input.dataset.dirty = "0";
  renderWorkMoveControls();
}

function completeWorkCoordinateMove(seq) {
  if (!seq || seq !== state.jog.workMovePending) return false;
  state.jog.workMovePending = 0;
  clearControlDrafts("work-move-x", "work-move-y", "work-move-z");
  const { wpos } = currentAxisValues();
  for (const axis of ["x", "y", "z"]) {
    const value = axisValue(wpos, axis);
    const input = workMoveInput(axis);
    if (input && value !== null) input.value = formatOriginValue(value);
  }
  return true;
}

function cancelWorkCoordinateMove(seq) {
  if (!state.jog.workMovePending || (seq && seq !== state.jog.workMovePending)) return;
  state.jog.workMovePending = 0;
}

function clearFieldProbeMove(seq) {
  if (!state.jog.fieldProbeMovePending || (seq && seq !== state.jog.fieldProbeMovePending)) return;
  state.jog.fieldProbeMovePending = 0;
}

function workMoveTargetsFromInputs() {
  const origin = currentWorkOrigin();
  if (!origin) throw new Error("Current work origin is unavailable.");
  const machineTargets = {};
  const workTargets = {};
  for (const axis of ["x", "y", "z"]) {
    const input = workMoveInput(axis);
    const raw = String(input?.value || "").trim();
    if (raw === "") continue;
    const workValue = finiteOr(raw, NaN);
    if (!Number.isFinite(workValue)) throw new Error("Work " + axis.toUpperCase() + " must be a number.");
    const offset = axisValue(origin, axis);
    if (offset === null) throw new Error("Current " + axis.toUpperCase() + " work origin is unavailable.");
    machineTargets[axis] = workValue + offset;
    workTargets[axis] = workValue;
  }
  if (!Object.keys(machineTargets).length) throw new Error("Enter at least one work coordinate.");
  return { machineTargets, label: workMoveTargetLabel(workTargets) };
}

function sendWorkCoordinateMove() {
  if (state.jog.caps && !state.jog.caps.enabled) {
    setTapFeedback(jogErrorText("disabled"), "error");
    return;
  }
  if (state.jog.link !== "online") {
    setTapFeedback("Jog service is not connected.", "error");
    connectJog();
    return;
  }
  if (!state.jog.armed) {
    setTapFeedback("Arm Movement before moving to work coordinates.", "error");
    return;
  }
  if (tapMoveTargetBusy() || state.jog.zStepPending || hasPendingOriginOperation()) return;
  let move;
  try {
    move = workMoveTargetsFromInputs();
  } catch (e) {
    setTapFeedback(e.message, "error");
    return;
  }
  let feed;
  try {
    feed = currentTapFeed();
  } catch (e) {
    setTapFeedback(e.message, "error");
    return;
  }
  const machine = normalizeMachineSettings(state.ui.machine);
  const safeZEnabled = !machine.safe_z_disabled;
  const seq = sendJog({ type: "target", target: move.machineTargets, feed_mm_min: feed, safe_z_enabled: safeZEnabled, safe_z_mm: safeZForTapMove(machine) });
  if (!seq) {
    setTapFeedback("Jog service is not connected.", "error");
    return;
  }
  const base = state.jog.target || state.jog.observed || state.jog.mpos || state.machine.mpos || {};
  state.jog.target = { ...base, ...move.machineTargets };
  state.jog.targetPending = seq;
  state.jog.targetMotionPending = seq;
  state.jog.workMovePending = seq;
  state.jog.targetLabel = move.label;
  state.jog.tapFeedback = "Sending move to " + move.label + "...";
  state.jog.tapFeedbackKind = "";
  renderJog();
}

function tapTargetLabel(target) {
  return `X ${target.x.toFixed(1)} Y ${target.y.toFixed(1)}`;
}

function sendTapMove(target) {
  if (state.jog.link !== "online") {
    setTapFeedback("Jog service is not connected.", "error");
    connectJog();
    return;
  }
  if (!state.jog.armed) {
    setTapFeedback("Arm Movement before selecting a target.", "error");
    return;
  }
  if (tapMoveTargetBusy() || state.jog.zStepPending || hasPendingOriginOperation()) return;
  let feed;
  try {
    feed = currentTapFeed();
  } catch (e) {
    setTapFeedback(e.message, "error");
    return;
  }
  const machine = normalizeMachineSettings(state.ui.machine);
  const safeZEnabled = !machine.safe_z_disabled;
  const label = tapTargetLabel(target);
  const seq = sendJog({ type: "target", target: { x: target.x, y: target.y }, feed_mm_min: feed, safe_z_enabled: safeZEnabled, safe_z_mm: safeZForTapMove(machine) });
  if (!seq) {
    setTapFeedback("Jog service is not connected.", "error");
    return;
  }
  const base = state.jog.target || state.jog.observed || state.jog.mpos || state.machine.mpos || {};
  state.jog.target = { ...base, x: target.x, y: target.y };
  state.jog.targetPending = seq;
  state.jog.targetMotionPending = seq;
  state.jog.targetLabel = label;
  state.jog.tapFeedback = "Sending target " + label + "...";
  state.jog.tapFeedbackKind = "";
  renderJog();
}

function currentZStepDistance() {
  const value = Number(document.getElementById("z-step-distance")?.value);
  return [10, 1, 0.1, 0.01].includes(value) ? value : 1;
}

function zStepLabel(distance) {
  const sign = distance > 0 ? "+" : "-";
  const abs = Math.abs(distance);
  const text = abs >= 1 ? abs.toFixed(0) : (abs >= 0.1 ? abs.toFixed(1) : abs.toFixed(2));
  return "Z" + sign + " " + text + " mm";
}

function stepZ(dir) {
  if (state.jog.caps && !state.jog.caps.enabled) {
    setTapFeedback(jogErrorText("disabled"), "error");
    return;
  }
  if (state.jog.link !== "online") {
    setTapFeedback("Jog service is not connected.", "error");
    connectJog();
    return;
  }
  if (!state.jog.armed) {
    setTapFeedback("Arm Movement before moving Z.", "error");
    return;
  }
  if (tapMoveTargetBusy() || state.jog.zStepPending || hasPendingOriginOperation()) return;
  const distance = currentZStepDistance() * dir;
  const label = zStepLabel(distance);
  const seq = sendJog({ type: "step", axis: "z", distance });
  if (!seq) {
    setTapFeedback("Jog service is not connected.", "error");
    return;
  }
  state.jog.zStepPending = seq;
  state.jog.zStepLabel = label;
  state.jog.tapFeedback = "Sending " + label + "...";
  state.jog.tapFeedbackKind = "";
  renderJog();
}

function originCommandLine(axis, value = 0) {
  return "G10L20P0" + axis.toUpperCase() + formatOriginValue(value);
}

function formatOriginValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  if (Math.abs(n) < 0.00005) return "0";
  return n.toFixed(4).replace(/\.?0+$/, "");
}

function originTargetsFromXYZ() {
  const targets = {};
  for (const axis of ["x", "y", "z"]) {
    const raw = String(document.getElementById("origin-xyz-" + axis)?.value || "").trim();
    if (!raw) continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(axis.toUpperCase() + " value must be finite.");
    targets[axis] = value;
  }
  if (!originAxes(targets).length) throw new Error("Enter at least one coordinate.");
  return { targets, label: "XYZ" };
}

function originTargetsFromSaved(saved) {
  if (!saved) throw new Error("select a saved zero to recall.");
  const { mpos } = currentAxisValues();
  const mx = axisValue(mpos, "x");
  const my = axisValue(mpos, "y");
  if (mx === null || my === null) throw new Error("current machine XY position is unavailable.");
  return {
    targets: { x: mx - saved.origin.x, y: my - saved.origin.y },
    label: saved.label,
  };
}

function machineAnchorPoints() {
  const anchors = normalizeMachineLearned(state.ui.machine?.learned).anchors;
  const anchor1X = axisValue(anchors?.anchor1, "x");
  const anchor1Y = axisValue(anchors?.anchor1, "y");
  const anchor2X = axisValue(anchors?.anchor2, "x");
  const anchor2Y = axisValue(anchors?.anchor2, "y");
  if (!anchors?.available || anchor1X === null || anchor1Y === null || anchor2X === null || anchor2Y === null) return null;
  return {
    anchor1: { x: anchor1X, y: anchor1Y },
    anchor2: { x: anchor2X, y: anchor2Y },
  };
}

function originTargetsFromOriginSource() {
  const source = document.getElementById("origin-set-source")?.value || "anchor1";
  const x = finiteOr(document.getElementById("origin-set-x")?.value, NaN);
  const y = finiteOr(document.getElementById("origin-set-y")?.value, NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Origin coordinates must be finite.");
  const { mpos } = currentAxisValues();
  const mx = axisValue(mpos, "x");
  const my = axisValue(mpos, "y");
  if (mx === null || my === null) throw new Error("Current machine XY position is unavailable.");
  let machineOrigin;
  let label;
  if (source === "machine") {
    machineOrigin = { x, y };
    label = "machine coordinate origin";
  } else {
    const anchors = machineAnchorPoints();
    if (!anchors) throw new Error("Machine anchor positions are unavailable. Learn machine parameters first.");
    const selected = source === "anchor2" ? "anchor2" : "anchor1";
    const anchor = anchors[selected];
    machineOrigin = { x: anchor.x + x, y: anchor.y + y };
    label = (selected === "anchor2" ? "Anchor 2" : "Anchor 1") + " origin";
  }
  return {
    targets: { x: mx - machineOrigin.x, y: my - machineOrigin.y },
    label,
    machineOrigin,
  };
}

function originReferenceRequestFromInputs() {
  const reference = document.getElementById("origin-set-source")?.value || "anchor1";
  const x = finiteOr(document.getElementById("origin-set-x")?.value, NaN);
  const y = finiteOr(document.getElementById("origin-set-y")?.value, NaN);
  if (!["anchor1", "anchor2", "machine"].includes(reference)) throw new Error("Origin reference is invalid.");
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Origin coordinates must be finite.");
  return {
    reference,
    x,
    y,
    label: reference === "anchor2" ? "Anchor 2 origin" : (reference === "anchor1" ? "Anchor 1 origin" : "machine coordinate origin"),
  };
}

function renderOriginSetChange() {
  const out = document.getElementById("origin-set-change");
  if (!out) return;
  try {
    const { machineOrigin } = originTargetsFromOriginSource();
    const current = currentWorkOrigin();
    const currentX = axisValue(current, "x");
    const currentY = axisValue(current, "y");
    if (currentX === null || currentY === null) {
      out.textContent = "Change from current origin: unavailable (machine and work XY required).";
      return;
    }
    const signed = (value) => (value >= 0 ? "+" : "") + formatOriginValue(value);
    out.textContent = "Change from current origin: X " + signed(machineOrigin.x - currentX) + "  Y " + signed(machineOrigin.y - currentY) + " mm";
  } catch (e) {
    out.textContent = "Change from current origin: " + e.message;
  }
}

function originAxes(targets) {
  return ["x", "y", "z"].filter((axis) => Number.isFinite(Number(targets?.[axis])));
}

function originTargetLabel(label, targets) {
  const parts = originAxes(targets).map((axis) => axis.toUpperCase() + " " + formatOriginValue(targets[axis]));
  return label || parts.join(" ");
}

function clearOriginVerification() {
  if (state.jog.originVerifyTimer) {
    clearTimeout(state.jog.originVerifyTimer);
    state.jog.originVerifyTimer = null;
  }
  state.jog.originPending = 0;
  state.jog.originPendingAxis = "";
  state.jog.originPendingMode = "";
  state.jog.originPendingAxes = [];
  state.jog.originPendingIndex = 0;
  state.jog.originPendingTargets = null;
  state.jog.originPendingLabel = "";
  state.jog.originVerifyDeadline = 0;
}

function beginOriginVerification() {
  state.jog.originPending = 0;
  state.jog.originPendingAxis = "";
  state.jog.originVerifyDeadline = Date.now() + 5000;
  setOriginFeedback("Verifying " + originTargetLabel(state.jog.originPendingLabel, state.jog.originPendingTargets) + "...");
  if (!checkOriginVerification()) scheduleOriginVerification();
}

function checkOriginVerification() {
  const targets = state.jog.originPendingTargets;
  const axes = originAxes(targets);
  if (!axes.length || state.jog.originPending) return false;
  const values = axes.map((axis) => {
    const w = state.jog.originPendingMode === "jog"
      ? (axisValue(state.jog.wpos, axis) ?? axisValue(state.machine.wpos, axis))
      : (axisValue(state.machine.wpos, axis) ?? axisValue(state.jog.wpos, axis));
    return { axis, w, target: Number(targets[axis]) };
  });
  if (values.every((v) => v.w !== null && Math.abs(v.w - v.target) <= 0.01)) {
    const label = originTargetLabel(state.jog.originPendingLabel, targets);
    clearOriginVerification();
    setOriginFeedback(label + " set.", "ok");
    return true;
  }
  if (Date.now() > state.jog.originVerifyDeadline) {
    const seen = values.map((v) => v.w === null ? v.axis.toUpperCase() + " no WPos" : v.axis.toUpperCase() + " " + v.w.toFixed(3)).join(", ");
    const label = originTargetLabel(state.jog.originPendingLabel, targets);
    clearOriginVerification();
    setOriginFeedback("Set " + label + " could not be verified (" + seen + ").", "error");
    return true;
  }
  return false;
}

function scheduleOriginVerification() {
  if (state.jog.originVerifyTimer) clearTimeout(state.jog.originVerifyTimer);
  if (!state.jog.originPendingTargets || state.jog.originPending) return;
  state.jog.originVerifyTimer = setTimeout(async () => {
    state.jog.originVerifyTimer = null;
    if (!state.jog.originPendingTargets || state.jog.originPending) return;
    if (checkOriginVerification()) {
      renderJog();
      return;
    }
    await pollMachine();
    if (!state.jog.originPendingTargets || state.jog.originPending) return;
    if (checkOriginVerification()) renderJog();
    else scheduleOriginVerification();
  }, 350);
}

async function setOriginViaGcode(targets, label) {
  const axes = originAxes(targets);
  state.jog.originPending = -1;
  state.jog.originPendingAxis = axes[0] || "";
  state.jog.originPendingMode = "api";
  state.jog.originPendingAxes = axes;
  state.jog.originPendingIndex = 0;
  state.jog.originPendingTargets = { ...targets };
  state.jog.originPendingLabel = label;
  setOriginFeedback("Setting " + originTargetLabel(label, targets) + "...");
  renderJog();
  try {
    for (const axis of axes) {
      state.jog.originPendingAxis = axis;
      await request("/api/gcode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ line: originCommandLine(axis, targets[axis]) }),
      });
    }
    beginOriginVerification();
  } catch (e) {
    const pendingLabel = originTargetLabel(label, targets);
    clearOriginVerification();
    setOriginFeedback("Set " + pendingLabel + " failed: " + e.message, "error");
    appendGcodeLine({ seq: "local-" + Date.now(), dir: "recv", source: "api", text: "error: " + e.message });
  } finally {
    renderJog();
  }
}

async function setReferenceOriginViaAPI(origin) {
  state.jog.originPending = -1;
  state.jog.originPendingAxis = "xy";
  state.jog.originPendingMode = "api-reference";
  state.jog.originPendingAxes = ["x", "y"];
  state.jog.originPendingTargets = null;
  state.jog.originPendingLabel = origin.label;
  setOriginFeedback("Setting " + origin.label + "...");
  renderJog();
  try {
    const response = await request("/api/origin/reference", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reference: origin.reference, x: origin.x, y: origin.y }),
    });
    const result = await response.json();
    state.jog.originPendingTargets = result.target || null;
    if (!state.jog.originPendingTargets) throw new Error("machine did not return an origin verification target");
    beginOriginVerification();
  } catch (e) {
    clearOriginVerification();
    setOriginFeedback("Set " + origin.label + " failed: " + e.message, "error");
    appendGcodeLine({ seq: "local-" + Date.now(), dir: "recv", source: "api", text: "error: " + e.message });
  } finally {
    renderJog();
  }
}

function setReferenceOriginViaJog(origin) {
  const seq = sendJog({
    type: "origin_reference",
    reference: origin.reference,
    x: origin.x,
    y: origin.y,
  });
  if (!seq) {
    setOriginFeedback("Set " + origin.label + " failed: jog service is not connected.", "error");
    return;
  }
  state.jog.originPending = seq;
  state.jog.originPendingAxis = "xy";
  state.jog.originPendingMode = "jog-reference";
  state.jog.originPendingAxes = ["x", "y"];
  state.jog.originPendingIndex = 0;
  state.jog.originPendingTargets = null;
  state.jog.originPendingLabel = origin.label;
  setOriginFeedback("Setting " + origin.label + "...");
  renderJog();
}

function sendNextJogOriginAxis() {
  const axes = state.jog.originPendingAxes || [];
  const axis = axes[state.jog.originPendingIndex] || "";
  const targets = state.jog.originPendingTargets || {};
  if (!axis) {
    beginOriginVerification();
    return true;
  }
  const seq = sendJog({ type: "origin", axis, value: Number(targets[axis]) || 0 });
  if (!seq) {
    const label = originTargetLabel(state.jog.originPendingLabel, targets);
    clearOriginVerification();
    setOriginFeedback("Set " + label + " failed: jog service is not connected.", "error");
    return false;
  }
  state.jog.originPending = seq;
  state.jog.originPendingAxis = axis;
  setOriginFeedback("Setting " + originTargetLabel(state.jog.originPendingLabel, targets) + "...");
  renderJog();
  return true;
}

function handleOriginAck() {
  state.jog.originPending = 0;
  state.jog.originPendingIndex += 1;
  if (state.jog.originPendingIndex < state.jog.originPendingAxes.length) {
    sendNextJogOriginAxis();
    return;
  }
  beginOriginVerification();
}

function applyOriginTargets(targets, label) {
  const axes = originAxes(targets);
  if (!axes.length) return;
  if (hasPendingOriginOperation() || tapMoveTargetBusy() || state.jog.zStepPending) return;
  if (state.jog.armed) {
    if (state.jog.link !== "online") {
      setOriginFeedback("Jog service is not connected.", "error");
      connectJog();
      return;
    }
    state.jog.originPendingMode = "jog";
    state.jog.originPendingAxes = axes;
    state.jog.originPendingIndex = 0;
    state.jog.originPendingTargets = { ...targets };
    state.jog.originPendingLabel = label;
    sendNextJogOriginAxis();
    return;
  }
  if (!machineReadyForOriginSet()) {
    setOriginFeedback("Machine must be connected and Idle to set origin.", "error");
    return;
  }
  setOriginViaGcode(targets, label);
}

function setOriginAxis(axis) {
  axis = String(axis || "").toLowerCase();
  if (!["x", "y", "z"].includes(axis)) return;
  applyOriginTargets({ [axis]: 0 }, axis.toUpperCase() + "0");
}

function openOriginDialog(id) {
  const dialog = document.getElementById(id);
  if (!dialog || dialog.open) return;
  renderOriginButtons();
  dialog.showModal();
  if (id === "origin-set-modal") refreshMachineLearnedSettings();
}

function closeOriginDialog(id) {
  document.getElementById(id)?.close();
}

function probe3DFieldRules(kind) {
  kind = String(kind || "");
  const x = !kind.endsWith("_y");
  const y = !kind.endsWith("_x");
  const z = !kind.startsWith("bore_pocket");
  const note = kind.startsWith("bore_pocket")
    ? "Move the 3D Probe inside the bore or pocket with its contact point below the top surface, and make sure the probe is stable."
    : "Z Offset is the probe tip-to-surface distance during edge probing. Make sure the 3D Probe is stable.";
  return { x, y, z, note };
}

function probe3DInitialPositioning(kind, xOffset, yOffset) {
  const x = Math.abs(Number(xOffset));
  const y = Math.abs(Number(yOffset));
  switch (String(kind || "")) {
    case "outside_top_left": return { x: -x, y };
    case "outside_top_right": return { x, y };
    case "outside_bottom_right": return { x, y: -y };
    case "outside_bottom_left": return { x: -x, y: -y };
    case "inside_top_left": return { x, y: -y };
    case "inside_top_right": return { x: -x, y: -y };
    case "inside_bottom_right": return { x: -x, y };
    case "inside_bottom_left": return { x, y };
    case "boss_block": return { x: -x, y: -y };
    case "boss_block_x": return { x: -x };
    case "boss_block_y": return { y: -y };
    default: return {};
  }
}

function probe3DTravelPreflight(kind, xOffset, yOffset, mpos, bounds) {
  const delta = probe3DInitialPositioning(kind, xOffset, yOffset);
  const issues = [];
  for (const axis of ["x", "y"]) {
    if (!Object.hasOwn(delta, axis)) continue;
    const current = Number(mpos?.[axis]);
    const min = Number(bounds?.[axis]?.min);
    const max = Number(bounds?.[axis]?.max);
    if (![current, delta[axis], min, max].every(Number.isFinite) || min >= max) continue;
    const target = current + delta[axis];
    const label = axis.toUpperCase();
    if (target < min) {
      issues.push(`${label} target ${target.toFixed(3)} mm is below learned minimum ${min.toFixed(3)} mm (maximum ${label} Offset here: ${Math.max(0, current - min).toFixed(3)} mm).`);
    } else if (target > max) {
      issues.push(`${label} target ${target.toFixed(3)} mm is above learned maximum ${max.toFixed(3)} mm (maximum ${label} Offset here: ${Math.max(0, max - current).toFixed(3)} mm).`);
    }
  }
  return {
    blocked: issues.length > 0,
    warning: issues.length ? "Soft-limit risk: " + issues.join(" ") + " Reduce the offset or reposition the probe." : "",
  };
}

function probe3DLearnedTravelBounds() {
  const learned = state.ui.machine?.learned || {};
  const soft = learned.soft_endstop || {};
  const xMin = Number(soft.x_min);
  const xMax = Number(soft.x_max);
  const yMin = Number(soft.y_min);
  const yMax = Number(soft.y_max);
  return {
    x: Number.isFinite(xMin) && Number.isFinite(xMax) && xMin < xMax ? { min: xMin, max: xMax } : null,
    y: Number.isFinite(yMin) && Number.isFinite(yMax) && yMin < yMax ? { min: yMin, max: yMax } : null,
  };
}

function probe3DPreflightFromControls() {
  const kind = document.getElementById("probe-3d-kind")?.value || "";
  const x = Number(document.getElementById("probe-3d-x")?.value);
  const y = Number(document.getElementById("probe-3d-y")?.value);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { blocked: false, warning: "" };
  return probe3DTravelPreflight(kind, x, y, state.machine.mpos, probe3DLearnedTravelBounds());
}

function renderProbe3DForm() {
  const kind = document.getElementById("probe-3d-kind")?.value || "";
  const rules = probe3DFieldRules(kind);
  const pending = !!state.jog.probe3DPending;
  for (const axis of ["x", "y", "z"]) {
    const field = document.getElementById("probe-3d-" + axis + "-field");
    const input = document.getElementById("probe-3d-" + axis);
    const active = !!rules[axis];
    field?.classList.toggle("is-inactive", !active);
    field?.setAttribute("aria-hidden", active ? "false" : "true");
    if (input) input.disabled = pending || !active;
  }
  const kindSelect = document.getElementById("probe-3d-kind");
  const diameter = document.getElementById("probe-3d-diameter");
  if (kindSelect) kindSelect.disabled = pending;
  if (diameter) diameter.disabled = pending;
  const note = document.getElementById("probe-3d-note");
  if (note) note.textContent = rules.note;
  const preflight = probe3DPreflightFromControls();
  const preflightNode = document.getElementById("probe-3d-preflight");
  if (preflightNode) {
    preflightNode.textContent = preflight.warning;
    preflightNode.classList.toggle("is-visible", preflight.blocked);
    preflightNode.setAttribute("aria-hidden", preflight.blocked ? "false" : "true");
  }
  const run = document.getElementById("probe-3d-run");
  if (run) {
    run.disabled = pending || preflight.blocked;
    setTextIfChanged(run, pending ? "Probing..." : "Probe");
    setElementBusy(run, pending);
  }
  const cancel = document.getElementById("probe-3d-cancel");
  const close = document.getElementById("probe-3d-close");
  if (cancel) cancel.disabled = pending;
  if (close) close.disabled = pending;
}

function probe3DNumber(id, label, positive = false) {
  const raw = String(document.getElementById(id)?.value || "").trim();
  const value = Number(raw);
  if (raw === "" || !Number.isFinite(value)) throw new Error(label + " must be a number.");
  if (value < 0 || value > 5000 || (positive && value === 0)) {
    throw new Error(label + (positive ? " must be greater than 0 and no more than 5000 mm." : " must be between 0 and 5000 mm."));
  }
  return value;
}

function probe3DRequestFromControls() {
  return {
    kind: document.getElementById("probe-3d-kind")?.value || "",
    x_offset_mm: probe3DNumber("probe-3d-x", "X Offset"),
    y_offset_mm: probe3DNumber("probe-3d-y", "Y Offset"),
    z_offset_mm: probe3DNumber("probe-3d-z", "Z Offset"),
    diameter_mm: probe3DNumber("probe-3d-diameter", "Probe Diameter", true),
  };
}

function openProbe3D() {
  if (state.jog.armed) {
    setOriginFeedback("Disarm Movement before running 3D probe.", "error");
    return;
  }
  if (!machineReadyForOriginSet()) {
    setOriginFeedback("Machine must be connected and Idle to run 3D probe.", "error");
    return;
  }
  if (!is3DProbeToolActive()) {
    setOriginFeedback("3D probe requires the 3D Probe tool to be active.", "error");
    return;
  }
  const dialog = document.getElementById("probe-3d-modal");
  if (!dialog || dialog.open) return;
  renderProbe3DForm();
  dialog.showModal();
  document.getElementById("probe-3d-kind")?.focus();
}

function closeProbe3D() {
  if (state.jog.probe3DPending) return;
  document.getElementById("probe-3d-modal")?.close();
}

async function runProbe3D() {
  if (state.jog.zProbePending || tapMoveTargetBusy() || state.jog.zStepPending || hasPendingOriginOperation()) return;
  if (state.jog.armed) {
    setOriginFeedback("Disarm Movement before running 3D probe.", "error");
    return;
  }
  if (!machineReadyForOriginSet()) {
    setOriginFeedback("Machine must be connected and Idle to run 3D probe.", "error");
    return;
  }
  if (!is3DProbeToolActive()) {
    setOriginFeedback("3D probe requires the 3D Probe tool to be active.", "error");
    return;
  }
  let body;
  try {
    body = probe3DRequestFromControls();
  } catch (e) {
    setOriginFeedback(e.message, "error");
    return;
  }
  const preflight = probe3DTravelPreflight(body.kind, body.x_offset_mm, body.y_offset_mm, state.machine.mpos, probe3DLearnedTravelBounds());
  if (preflight.blocked) {
    setOriginFeedback(preflight.warning, "error");
    renderProbe3DForm();
    return;
  }

  state.jog.zProbePending = true;
  state.jog.probe3DPending = true;
  setOriginFeedback("Starting 3D probe...");
  renderJog();
  renderProbe3DForm();
  try {
    const resp = await request("/api/probe/3d", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await resp.json();
    // M480 owns all subsequent motion and origin changes, so a completed Tap
    // Move target no longer represents an active or useful machine target.
    // Clear it only after the 3D-probe command has been accepted; rejected
    // requests retain the marker.
    state.jog.target = null;
    state.jog.targetLabel = "";
    setOriginFeedback(result.message || "3D probe command sent; machine completion was not available.", result.verified ? "ok" : "");
    document.getElementById("probe-3d-modal")?.close();
    pollMachine();
    setTimeout(pollMachine, 1200);
  } catch (e) {
    setOriginFeedback("3D probe failed: " + e.message, "error");
    appendGcodeLine({ seq: "local-" + Date.now(), dir: "recv", source: "api", text: "error: " + e.message });
  } finally {
    state.jog.probe3DPending = false;
    state.jog.zProbePending = false;
    renderProbe3DForm();
    renderJog();
  }
}

function applyXYZOrigin() {
  try {
    const { targets, label } = originTargetsFromXYZ();
    applyOriginTargets(targets, label);
  } catch (e) {
    setOriginFeedback(e.message, "error");
  }
}

function applyOriginSource() {
  try {
    const origin = originReferenceRequestFromInputs();
    if (hasPendingOriginOperation() || tapMoveTargetBusy() || state.jog.zStepPending) return;
    if (state.jog.armed) {
      if (state.jog.link !== "online") {
        setOriginFeedback("Jog service is not connected.", "error");
        connectJog();
        return;
      }
      setReferenceOriginViaJog(origin);
      return;
    }
    if (!machineReadyForOriginSet()) {
      setOriginFeedback("Machine must be connected and Idle to set origin.", "error");
      return;
    }
    setReferenceOriginViaAPI(origin);
  } catch (e) {
    setOriginFeedback(e.message, "error");
    renderJog();
  }
}

async function runAutoZProbe() {
  if (state.jog.zProbePending || tapMoveTargetBusy() || state.jog.zStepPending || hasPendingOriginOperation()) return;
  if (state.jog.armed) {
    setOriginFeedback("Disarm Movement before running Z probe.", "error");
    renderJog();
    return;
  }
  if (!machineReadyForOriginSet()) {
    setOriginFeedback("Machine must be connected and Idle to run Z probe.", "error");
    renderJog();
    return;
  }
  if (!isProbeToolActive()) {
    setOriginFeedback("Z probe requires the probe tool to be active.", "error");
    renderJog();
    return;
  }
  const { wpos } = currentAxisValues();
  if (axisValue(wpos, "x") === null || axisValue(wpos, "y") === null) {
    setOriginFeedback("Current work XY is unavailable.", "error");
    renderJog();
    return;
  }
  state.jog.zProbePending = true;
  setOriginFeedback("Starting Z probe...");
  renderJog();
  try {
    const resp = await request("/api/probe/auto-z", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const result = await resp.json();
    const msg = result.message || "Z probe command sent.";
    setOriginFeedback(msg, result.verified ? "ok" : "");
    await pollMachine();
  } catch (e) {
    setOriginFeedback("Z probe failed: " + e.message, "error");
    appendGcodeLine({ seq: "local-" + Date.now(), dir: "recv", source: "api", text: "error: " + e.message });
  } finally {
    state.jog.zProbePending = false;
    renderJog();
  }
}

function recallSelectedOrigin() {
  try {
    const { targets, label } = originTargetsFromSaved(selectedSavedOrigin());
    applyOriginTargets(targets, label);
  } catch (e) {
    setOriginFeedback(e.message, "error");
  }
}

function handleWorkAreaTap(local) {
  if (mobileWorkAreaJogEnabled()) return;
  const target = workAreaToMachinePoint(workAreaLocalToContentPoint(local));
  if (!target) return;
  sendTapMove(target);
}

function mobileWorkAreaJogEnabled() {
  return typeof window !== "undefined" && Number(window.innerWidth) <= MOBILE_WORKAREA_MAX_WIDTH_PX;
}

function mobileWorkAreaActionsOpen() {
  return !!document.getElementById("workarea-actions-panel")?.classList.contains("is-open");
}

function mobileWorkAreaJogReady() {
  return mobileWorkAreaJogEnabled() &&
    !mobileWorkAreaActionsOpen() &&
    state.activeTab === "control" &&
    state.jog.link === "online" &&
    state.jog.armed &&
    !state.jog.inputSuspended &&
    !tapMoveTargetBusy() &&
    !state.jog.fieldProbeMovePending &&
    !state.jog.zStepPending &&
    !state.jog.zProbePending &&
    !state.jog.probe3DPending &&
    !hasPendingOriginOperation() &&
    !state.outline.fieldProbePointMovePending &&
    !state.outline.fieldProbePending;
}

function mobileJogAxisForResponse(value) {
  value = clampAxis(value);
  if (Math.abs(value) < 1e-6) return 0;
  // The server applies a cubic response after its deadzone. Invert that
  // response here so drag distance maps linearly to commanded feed and the
  // edge of the controller reaches the configured jog maximum.
  const sign = value < 0 ? -1 : 1;
  return sign * (JOG_INPUT_DEADZONE + (1 - JOG_INPUT_DEADZONE) * Math.cbrt(Math.abs(value)));
}

function mobileWorkAreaJogAxes(originX, originY, clientX, clientY, radiusPX) {
  const radius = Math.max(1, Number(radiusPX) || 1);
  const dx = Number(clientX) - Number(originX);
  const dy = Number(clientY) - Number(originY);
  const distance = Math.hypot(dx, dy);
  const scale = distance > radius ? radius / distance : 1;
  return {
    x: mobileJogAxisForResponse((dx * scale) / radius),
    y: mobileJogAxisForResponse((-dy * scale) / radius),
    z: 0,
  };
}

function mobileWorkAreaJogRadius(svg) {
  const rect = svg?.getBoundingClientRect?.();
  const size = Math.min(Number(rect?.width) || 0, Number(rect?.height) || 0);
  return clampNumber(size * 0.22, MOBILE_JOG_RADIUS_MIN_PX, MOBILE_JOG_RADIUS_MAX_PX);
}

function setMobileWorkAreaJogVisual(origin, knob, radiusPX) {
  const svg = document.getElementById("workarea-plot");
  const group = document.getElementById("workarea-mobile-jog");
  if (!svg || !group || !origin || !knob) return;
  const ctm = svg.getScreenCTM?.();
  const screenScale = ctm ? Math.hypot(Number(ctm.a) || 0, Number(ctm.b) || 0) : 0;
  const radius = screenScale > 0 ? radiusPX / screenScale : 18;
  const base = group.querySelector(".mobile-jog-base");
  const line = group.querySelector(".mobile-jog-line");
  const handle = group.querySelector(".mobile-jog-knob");
  base?.setAttribute("cx", pathNum(origin.x));
  base?.setAttribute("cy", pathNum(origin.y));
  base?.setAttribute("r", pathNum(radius));
  line?.setAttribute("x1", pathNum(origin.x));
  line?.setAttribute("y1", pathNum(origin.y));
  line?.setAttribute("x2", pathNum(knob.x));
  line?.setAttribute("y2", pathNum(knob.y));
  handle?.setAttribute("cx", pathNum(knob.x));
  handle?.setAttribute("cy", pathNum(knob.y));
  group.removeAttribute("display");
  svg.classList.add("mobile-jogging");
}

function resetMobileWorkAreaJog(e = null) {
  const v = normalizeWorkAreaView();
  if (e && v.mobileJogPointerId !== e.pointerId) return false;
  const wasActive = !!v.mobileJogActive;
  const pointerId = v.mobileJogPointerId;
  v.mobileJogPointerId = null;
  v.mobileJogOriginClientX = 0;
  v.mobileJogOriginClientY = 0;
  v.mobileJogOriginLocal = null;
  v.mobileJogKnobLocal = null;
  v.mobileJogRadiusPX = 0;
  v.mobileJogAxes = { x: 0, y: 0, z: 0 };
  v.mobileJogActive = false;
  const svg = document.getElementById("workarea-plot");
  const group = document.getElementById("workarea-mobile-jog");
  group?.setAttribute("display", "none");
  svg?.classList.remove("mobile-jogging");
  if (svg && pointerId !== null) {
    try {
      svg.releasePointerCapture(pointerId);
    } catch {
      // Pointer capture may already have been released by the browser.
    }
  }
  return wasActive;
}

function startMobileWorkAreaJog(e, local) {
  if (!mobileWorkAreaJogReady()) return false;
  if (e.target?.closest?.("#workarea-actions-toggle, #workarea-actions-panel")) return false;
  const svg = document.getElementById("workarea-plot");
  if (!svg || !local) return false;
  const stopped = { x: 0, y: 0, z: 0 };
  if (!sendJog({ type: "input", deadman: true, axes: stopped }, true)) {
    setTapFeedback("Jog service is not connected.", "error");
    e.preventDefault();
    return true;
  }
  const v = normalizeWorkAreaView();
  v.mobileJogPointerId = e.pointerId;
  v.mobileJogOriginClientX = e.clientX;
  v.mobileJogOriginClientY = e.clientY;
  v.mobileJogOriginLocal = { x: local.x, y: local.y };
  v.mobileJogKnobLocal = { x: local.x, y: local.y };
  v.mobileJogRadiusPX = mobileWorkAreaJogRadius(svg);
  v.mobileJogAxes = stopped;
  v.mobileJogActive = true;
  state.jog.pad = "Touch";
  state.jog.deadman = true;
  state.jog.axes = stopped;
  setMobileWorkAreaJogVisual(v.mobileJogOriginLocal, v.mobileJogKnobLocal, v.mobileJogRadiusPX);
  try {
    svg.setPointerCapture(e.pointerId);
  } catch {
    // Pointer capture is best-effort; cancellation paths still force a stop.
  }
  e.preventDefault();
  renderJog();
  return true;
}

function updateMobileWorkAreaJog(e) {
  const v = state.workarea;
  if (!v?.mobileJogActive || v.mobileJogPointerId !== e.pointerId) return false;
  const wasMoving = jogInputActive({ deadman: true, axes: v.mobileJogAxes });
  const axes = mobileWorkAreaJogAxes(
    v.mobileJogOriginClientX,
    v.mobileJogOriginClientY,
    e.clientX,
    e.clientY,
    v.mobileJogRadiusPX,
  );
  const dx = e.clientX - v.mobileJogOriginClientX;
  const dy = e.clientY - v.mobileJogOriginClientY;
  const distance = Math.hypot(dx, dy);
  const scale = distance > v.mobileJogRadiusPX ? v.mobileJogRadiusPX / distance : 1;
  const knob = workAreaSVGPointFromClient({
    clientX: v.mobileJogOriginClientX + dx * scale,
    clientY: v.mobileJogOriginClientY + dy * scale,
  });
  v.mobileJogAxes = axes;
  if (knob) v.mobileJogKnobLocal = knob;
  state.jog.deadman = true;
  state.jog.axes = axes;
  sendJog({ type: "input", deadman: true, axes });
  setMobileWorkAreaJogVisual(v.mobileJogOriginLocal, v.mobileJogKnobLocal, v.mobileJogRadiusPX);
  e.preventDefault();
  const moving = jogInputActive({ deadman: true, axes });
  if (moving !== wasMoving) renderJog();
  return true;
}

function stopMobileWorkAreaJog(e = null) {
  const v = state.workarea;
  if (!v?.mobileJogActive || (e && v.mobileJogPointerId !== e.pointerId)) return false;
  resetMobileWorkAreaJog(e);
  state.jog.pad = "";
  state.jog.deadman = false;
  state.jog.axes = { x: 0, y: 0, z: 0 };
  if (state.jog.armed) sendJog({ type: "input", deadman: false, axes: state.jog.axes }, true);
  e?.preventDefault?.();
  renderJog();
  return true;
}

function handleWorkAreaPointerDown(e) {
  if (typeof e.button === "number" && e.button !== 0) return;
  const svg = document.getElementById("workarea-plot");
  const local = workAreaSVGPointFromClient(e);
  if (!svg || !local) return;
  if (startMobileWorkAreaJog(e, local)) return;
  updateWorkAreaHoverPosition(local);
  const v = normalizeWorkAreaView();
  v.pointerId = e.pointerId;
  v.pointerStartX = local.x;
  v.pointerStartY = local.y;
  v.pointerLastX = local.x;
  v.pointerLastY = local.y;
  v.clientStartX = e.clientX;
  v.clientStartY = e.clientY;
  v.tapLocal = { x: local.x, y: local.y };
  v.tapProbeID = String(e.target?.dataset?.fieldProbeId || "");
  const selected = selectedFieldProbePoint();
  v.probeDragID = selected && selected.id === v.tapProbeID && !state.outline.fieldProbePointMovePending && !state.outline.fieldProbePending
    ? selected.id
    : "";
  v.probeDragOriginal = v.probeDragID ? { id: selected.id, x: selected.x, y: selected.y, fieldProbeComplete: !!state.outline.fieldProbeComplete } : null;
  v.probeDragging = false;
  v.dragging = false;
  try {
    svg.setPointerCapture(e.pointerId);
  } catch {
    // Pointer capture is best-effort; pointerup still handles ordinary clicks.
  }
  e.preventDefault();
}

function handleWorkAreaPointerMove(e) {
  if (updateMobileWorkAreaJog(e)) return;
  const v = state.workarea;
  const svg = document.getElementById("workarea-plot");
  const local = workAreaSVGPointFromClient(e);
  if (!svg || !local) return;
  if (!v || v.pointerId !== e.pointerId) {
    updateWorkAreaHoverPosition(local);
    return;
  }
  const moved = Math.hypot(e.clientX - v.clientStartX, e.clientY - v.clientStartY);
  if (!v.dragging && moved > WORKAREA_PAN_THRESHOLD_PX) {
    v.dragging = true;
    v.probeDragging = !!v.probeDragID;
    svg.classList.add(v.probeDragging ? "moving-probe" : "panning");
  }
  if (v.dragging) {
    if (v.probeDragging) updateSelectedFieldProbeDrag(local);
    else panWorkArea(local.x - v.pointerLastX, local.y - v.pointerLastY);
    v.pointerLastX = local.x;
    v.pointerLastY = local.y;
    updateWorkAreaHoverPosition(local);
    e.preventDefault();
  } else {
    updateWorkAreaHoverPosition(local);
  }
}

function clearWorkAreaPointer(e) {
  const v = state.workarea;
  if (!v || (e && v.pointerId !== e.pointerId)) return;
  const svg = document.getElementById("workarea-plot");
  if (svg) {
    svg.classList.remove("panning");
    svg.classList.remove("moving-probe");
    if (e) {
      try {
        svg.releasePointerCapture(e.pointerId);
      } catch {
        // The browser may already have released capture.
      }
    }
  }
  v.pointerId = null;
  v.dragging = false;
  v.tapLocal = null;
  v.tapProbeID = "";
  v.probeDragID = "";
  v.probeDragOriginal = null;
  v.probeDragging = false;
}

function handleWorkAreaPointerUp(e) {
  if (stopMobileWorkAreaJog(e)) return;
  const v = state.workarea;
  if (!v || v.pointerId !== e.pointerId) return;
  const wasDragging = !!v.dragging;
  const wasProbeDrag = !!v.probeDragging;
  const local = wasDragging ? workAreaSVGPointFromClient(e) : v.tapLocal;
  const probeID = wasDragging ? "" : v.tapProbeID;
  const probeOriginal = wasProbeDrag ? v.probeDragOriginal : null;
  clearWorkAreaPointer(e);
  updateWorkAreaHoverPosition(local);
  e.preventDefault();
  if (wasProbeDrag) finishSelectedFieldProbeMove(probeOriginal);
  else if (!wasDragging && probeID) selectFieldProbePoint(probeID);
  else if (!wasDragging && local) handleWorkAreaTap(local);
}

function handleWorkAreaWheel(e) {
  const local = workAreaSVGPointFromClient(e);
  if (!local) return;
  e.preventDefault();
  const multiplier = e.deltaY < 0 ? WORKAREA_ZOOM_STEP : 1 / WORKAREA_ZOOM_STEP;
  zoomWorkArea(multiplier, local);
}

function bindWorkAreaInteractions() {
  const svg = document.getElementById("workarea-plot");
  if (!svg || svg.dataset.workareaBound === "true") return;
  svg.dataset.workareaBound = "true";
  svg.addEventListener("pointerdown", handleWorkAreaPointerDown);
  svg.addEventListener("pointermove", handleWorkAreaPointerMove);
  svg.addEventListener("pointerup", handleWorkAreaPointerUp);
  svg.addEventListener("pointerleave", hideWorkAreaHoverPosition);
  svg.addEventListener("pointercancel", (e) => {
    if (stopMobileWorkAreaJog(e)) return;
    const original = state.workarea?.probeDragOriginal;
    if (original) {
      restoreSelectedFieldProbePosition(original);
      renderWorkArea();
    }
    clearWorkAreaPointer(e);
    hideWorkAreaHoverPosition();
  });
  svg.addEventListener("lostpointercapture", (e) => {
    if (state.workarea?.mobileJogPointerId === e.pointerId) stopMobileWorkAreaJog(e);
  });
  window.addEventListener("pointerup", stopMobileWorkAreaJog);
  window.addEventListener("pointercancel", stopMobileWorkAreaJog);
  svg.addEventListener("wheel", handleWorkAreaWheel, { passive: false });
  svg.addEventListener("keydown", (e) => {
    const probeID = String(e.target?.dataset?.fieldProbeId || "");
    if (!probeID) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      selectFieldProbePoint(probeID);
      return;
    }
    if (probeID !== state.outline.fieldProbeSelectedID || !e.key.startsWith("Arrow")) return;
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    const dx = e.key === "ArrowLeft" ? -step : (e.key === "ArrowRight" ? step : 0);
    const dy = e.key === "ArrowDown" ? -step : (e.key === "ArrowUp" ? step : 0);
    moveSelectedFieldProbePointBy(dx, dy);
  });
}

function clearDisarmedMovementState() {
  state.jog.surfaceInput = null;
  if (resetMobileWorkAreaJog()) {
    state.jog.pad = "";
    state.jog.deadman = false;
    state.jog.axes = { x: 0, y: 0, z: 0 };
  }
  resetJogInputSender();
  state.jog.targetPending = 0;
  state.jog.targetMotionPending = 0;
  cancelWorkCoordinateMove();
  clearFieldProbeMove();
}

function applyJogEvent(ev) {
  let machineChanged = false;
  let surfaceMPGOnly = false;
  if (ev.type === "hello" && ev.capabilities) {
    state.jog.motionStreamRevision = (Number(state.jog.motionStreamRevision) || 0) + 1;
    state.jog.motionRevision = 0;
    state.jog.settledMotionRevision = 0;
    state.jog.motionRevisionKnown = false;
    state.jog.caps = ev.capabilities;
    state.jog.availability = ev.capabilities.availability || null;
    if (state.jog.availability?.available && state.jog.errorCode === "busy") {
      state.jog.error = "";
      state.jog.errorCode = "";
    }
    flushQueuedTapMoveArm();
  } else if (ev.type === "state") {
    const wasArmed = state.jog.armed;
    const armed = !!ev.armed;
    if (state.jog.armed !== armed) resetJogInputSender();
    state.jog.armed = armed;
    if (wasArmed && !armed) {
      clearDisarmedMovementState();
      if (!ev.seq && !state.jog.armPending) {
        state.jog.tapFeedback = "Movement disarmed.";
        state.jog.tapFeedbackKind = "ok";
      }
    }
    if (ev.availability) {
      state.jog.availability = ev.availability;
      if (ev.availability.available) {
        state.jog.error = "";
        state.jog.errorCode = "";
      } else if (ev.availability.reason && !state.jog.armed) {
        state.jog.error = "";
        state.jog.errorCode = "";
      }
    }
  } else if (ev.type === "status" && ev.status) {
    clearNotice("machine-status");
    state.jog.statusRevision = (Number(state.jog.statusRevision) || 0) + 1;
    const motionRevision = Number(ev.status.motion_revision);
    const settledMotionRevision = Number(ev.status.settled_motion_revision);
    if (Number.isFinite(motionRevision) && Number.isFinite(settledMotionRevision)) {
      state.jog.motionRevisionKnown = true;
      state.jog.motionRevision = Math.max(Number(state.jog.motionRevision) || 0, motionRevision);
      state.jog.settledMotionRevision = Math.max(Number(state.jog.settledMotionRevision) || 0, settledMotionRevision);
    }
    const nextMachine = {
      ...state.machine,
      state: ev.status.state || state.machine.state,
      age_ms: ev.status.age_ms,
      observed_at: ev.status.observed_at || state.machine.observed_at,
      raw: ev.status.raw || state.machine.raw,
      mpos: ev.status.mpos || state.machine.mpos,
      wpos: ev.status.wpos || state.machine.wpos,
      motion_estimated: false,
      connected: true,
    };
    state.machine = ev.status.mpos ? reconcileObservedMachineStatus(nextMachine) : mergeMachineStatusForDisplay(nextMachine);
    machineChanged = true;
    if ((ev.status.state === "Idle" || ev.status.state === "Run") && state.jog.errorCode === "status_waiting") {
      state.jog.error = "";
      state.jog.errorCode = "";
    } else if (ev.status.state === "Idle") {
      state.jog.error = "";
      state.jog.errorCode = "";
    }
  } else if (ev.type === "motion" && ev.motion) {
    const motionRevision = Number(ev.motion.revision);
    if (Number.isFinite(motionRevision)) {
      state.jog.motionRevisionKnown = true;
      state.jog.motionRevision = Math.max(Number(state.jog.motionRevision) || 0, motionRevision);
    }
    const predicted = ev.motion.estimated || ev.motion.observed || ev.motion.target;
    if (!state.jog.targetMotionPending) state.jog.target = ev.motion.target || state.jog.target;
    state.jog.mpos = predicted || state.jog.mpos;
    state.jog.wpos = ev.motion.estimated_wpos || state.jog.wpos;
    state.jog.observed = ev.motion.observed || state.jog.observed;
    state.jog.estimated = !!ev.motion.estimated;
    if (state.jog.estimated && Number(ev.motion.queue_lead_ms) > 0) {
      state.jog.estimatedUntil = performance.now() + Number(ev.motion.queue_lead_ms) + 75;
    } else if (!state.jog.estimated) {
      state.jog.estimatedUntil = 0;
    }
    state.jog.lead = ev.motion.lead || state.jog.lead;
    if (predicted) {
      state.jog.path.push(predicted);
      if (state.jog.path.length > 80) state.jog.path.shift();
    }
    if (predicted) {
      state.machine = {
        ...state.machine,
        mpos: predicted,
        wpos: ev.motion.estimated_wpos || state.machine.wpos,
        motion_estimated: !!ev.motion.estimated,
      };
      machineChanged = true;
    }
  } else if (ev.type === "position_capture" && ev.position) {
    state.jog.sent.delete(ev.seq);
    resolveOutlineCaptureIntent(ev.seq, ev.position);
  } else if (ev.type === "ack") {
    const sent = state.jog.sent.get(ev.seq);
    if (sent) {
      document.getElementById("jog-latency").textContent = Math.round(performance.now() - sent) + "ms";
      state.jog.sent.delete(ev.seq);
    }
    if (ev.seq && ev.seq === state.jog.armPending) {
      const action = state.jog.armPendingAction;
      const armed = action === "arm";
      const disarmAfterArm = armed && state.jog.disarmAfterPendingArm;
      if (state.jog.armed !== armed) resetJogInputSender();
      state.jog.armed = armed;
      state.jog.armPending = 0;
      state.jog.armPendingAction = "";
      if (action === "disarm") {
        // The server releases the jog lease and cancels any pending target as
        // part of disarm. Mirror that lifecycle locally so a target whose
        // completion was never observed cannot keep tap movement busy after
        // the operator disarms and arms again.
        clearDisarmedMovementState();
      }
      state.jog.tapFeedback = tapMoveArmSuccessText(action);
      state.jog.tapFeedbackKind = "ok";
      if (disarmAfterArm) {
        state.jog.disarmAfterPendingArm = false;
        requestMovementDisarm();
      }
    }
    completeCommandDisarm(ev.seq);
    if (ev.seq && (ev.seq === state.jog.targetPending || ev.seq === state.jog.targetMotionPending)) {
      state.jog.targetPending = 0;
      state.jog.target = ev.target || state.jog.target;
      state.jog.tapFeedback = "Moving to " + state.jog.targetLabel + "...";
      state.jog.tapFeedbackKind = "";
    }
    if (ev.seq && ev.seq === state.jog.zStepPending) {
      state.jog.zStepPending = 0;
      state.jog.tapFeedback = "Z move sent: " + state.jog.zStepLabel;
      state.jog.tapFeedbackKind = "";
    }
    if (ev.seq && ev.seq === state.jog.surfaceStepPending) {
      const source = state.jog.surfaceStepSource;
      state.jog.surfaceStepPending = 0;
      state.jog.surfaceStepSource = "";
      if (source === "mpg") {
        state.jog.surfaceWheel.gestureAccepted++;
        finishSurfaceMPGGesture();
        surfaceMPGOnly = true;
      } else {
        setStatusMessage("surface-jog", state.jog.zStepLabel + " accepted.", "ok", { force: true });
      }
    }
    if (ev.seq && ev.seq === state.jog.originPending) {
      if (state.jog.originPendingMode === "jog-reference") {
        state.jog.originPending = 0;
        state.jog.originPendingAxis = "";
        state.jog.originPendingTargets = ev.target || null;
        if (state.jog.originPendingTargets) beginOriginVerification();
        else {
          const label = state.jog.originPendingLabel;
          clearOriginVerification();
          setOriginFeedback("Set " + label + " failed: machine did not return an origin verification target.", "error");
        }
      } else {
        handleOriginAck();
      }
    }
    state.jog.error = "";
    state.jog.errorCode = "";
  } else if (ev.type === "target_complete") {
    if (ev.seq && ev.seq === state.jog.targetMotionPending) {
      state.jog.targetPending = 0;
      state.jog.targetMotionPending = 0;
      state.jog.target = ev.target || state.jog.target;
      completeWorkCoordinateMove(ev.seq);
      clearFieldProbeMove(ev.seq);
      state.jog.tapFeedback = "Reached " + state.jog.targetLabel + ".";
      state.jog.tapFeedbackKind = "ok";
    }
  } else if (ev.type === "error") {
    const terminalSessionError = ev.code !== "status_waiting";
    if (!terminalSessionError) {
      // A delayed status reply is an internal retry state, not an operator
      // warning and not a terminal result for any pending movement action.
      if (state.jog.errorCode === "status_waiting") {
        state.jog.error = "";
        state.jog.errorCode = "";
      }
      renderJog();
      renderOutlineCapture();
      return;
    }
    if (ev.seq && resolveOutlineCaptureIntent(ev.seq, null, ev.message || jogErrorText(ev.code))) {
      state.jog.sent.delete(ev.seq);
      renderJog();
      return;
    }
    completeCommandDisarm(ev.seq, ev.message || jogErrorText(ev.code));
    if (ev.seq && ev.seq === state.jog.armPending) {
      const action = state.jog.armPendingAction;
      state.jog.armPending = 0;
      state.jog.armPendingAction = "";
      state.jog.disarmAfterPendingArm = false;
      state.jog.tapFeedback = tapMoveArmFailureText(action, ev.message || jogErrorText(ev.code));
      state.jog.tapFeedbackKind = "error";
    }
    if (!ev.seq && terminalSessionError && state.jog.armQueuedAction) {
      const action = state.jog.armQueuedAction;
      state.jog.armQueuedAction = "";
      state.jog.tapFeedback = tapMoveArmFailureText(action, ev.message || jogErrorText(ev.code));
      state.jog.tapFeedbackKind = "error";
    }
    if (ev.seq && (ev.seq === state.jog.targetPending || ev.seq === state.jog.targetMotionPending)) {
      state.jog.targetPending = 0;
      state.jog.targetMotionPending = 0;
      cancelWorkCoordinateMove(ev.seq);
      clearFieldProbeMove(ev.seq);
      state.jog.tapFeedback = "Move failed: " + (ev.message || jogErrorText(ev.code));
      state.jog.tapFeedbackKind = "error";
    }
    if (ev.seq && ev.seq === state.jog.zStepPending) {
      state.jog.zStepPending = 0;
      state.jog.tapFeedback = "Z move failed: " + (ev.message || jogErrorText(ev.code));
      state.jog.tapFeedbackKind = "error";
    }
    if (ev.seq && ev.seq === state.jog.surfaceStepPending) {
      const source = state.jog.surfaceStepSource;
      state.jog.surfaceStepPending = 0;
      state.jog.surfaceStepSource = "";
      if (source === "mpg") state.jog.surfaceWheel.blocked = true;
      setStatusMessage("surface-jog", "Jog failed: " + (ev.message || jogErrorText(ev.code)), "error", { force: true });
    }
    if (ev.seq && ev.seq === state.jog.originPending) {
      const label = originTargetLabel(state.jog.originPendingLabel, state.jog.originPendingTargets);
      clearOriginVerification();
      setOriginFeedback("Set " + label + " failed: " + (ev.message || jogErrorText(ev.code)), "error");
    }
    if (!ev.seq && terminalSessionError && (state.jog.targetPending || state.jog.targetMotionPending)) {
      state.jog.targetPending = 0;
      state.jog.targetMotionPending = 0;
      cancelWorkCoordinateMove();
      clearFieldProbeMove();
      state.jog.tapFeedback = "Move failed: " + (ev.message || jogErrorText(ev.code));
      state.jog.tapFeedbackKind = "error";
    }
    if (!ev.seq && terminalSessionError && state.jog.zStepPending) {
      state.jog.zStepPending = 0;
      state.jog.tapFeedback = "Z move failed: " + (ev.message || jogErrorText(ev.code));
      state.jog.tapFeedbackKind = "error";
    }
    if (!ev.seq && terminalSessionError && state.jog.surfaceStepPending) {
      const source = state.jog.surfaceStepSource;
      state.jog.surfaceStepPending = 0;
      state.jog.surfaceStepSource = "";
      if (source === "mpg") state.jog.surfaceWheel.blocked = true;
      setStatusMessage("surface-jog", "Jog failed: " + (ev.message || jogErrorText(ev.code)), "error", { force: true });
    }
    if (!ev.seq && terminalSessionError && state.jog.originPendingMode === "jog" && hasPendingOriginOperation()) {
      const label = originTargetLabel(state.jog.originPendingLabel, state.jog.originPendingTargets);
      clearOriginVerification();
      setOriginFeedback("Set " + label + " failed: " + (ev.message || jogErrorText(ev.code)), "error");
    }
    if (!ev.seq && terminalSessionError && state.jog.armPending) {
      const action = state.jog.armPendingAction;
      state.jog.armPending = 0;
      state.jog.armPendingAction = "";
      state.jog.disarmAfterPendingArm = false;
      state.jog.tapFeedback = tapMoveArmFailureText(action, ev.message || jogErrorText(ev.code));
      state.jog.tapFeedbackKind = "error";
    }
    state.jog.errorCode = ev.code || "";
    state.jog.error = ev.message || ev.code || "jog error";
    if (ev.code === "controller_waiting" || ev.code === "not_idle" || ev.code === "stale_status") {
      state.jog.armed = false;
      clearDisarmedMovementState();
    }
  }
  if (machineChanged) renderMachine();
  else if (surfaceMPGOnly) renderSurfaceMPGWheel();
  else {
    renderJog();
    renderOutlineCapture();
  }
}

function jogMotionAwaitingSettlement() {
  return !!state.jog.motionRevisionKnown &&
    Number(state.jog.motionRevision || 0) > Number(state.jog.settledMotionRevision || 0);
}

function jogEstimateActive() {
  return !!state.jog.estimated &&
    (jogMotionAwaitingSettlement() || Number(state.jog.estimatedUntil) > performance.now());
}

function currentGamepad() {
  if (!navigator.getGamepads) return null;
  const pads = navigator.getGamepads();
  const preferred = state.jog.preferredPadIndex;
  if (Number.isInteger(preferred) && pads[preferred] && pads[preferred].connected !== false) return pads[preferred];
  for (const p of pads) {
    if (p && p.connected !== false) {
      state.jog.preferredPadIndex = p.index;
      return p;
    }
  }
  return null;
}

function buttonPressed(gp, button) {
  return !!(gp && gp.buttons && gp.buttons[button] && gp.buttons[button].pressed);
}

function buttonStates(gp) {
  const out = [];
  if (!gp || !gp.buttons) return out;
  for (let i = 0; i < gp.buttons.length; i++) out[i] = !!gp.buttons[i].pressed;
  return out;
}

function mappedAxis(gp, axis) {
  const cfg = state.ui.gamepad.axes[axis];
  let value = gp.axes[cfg.axis] || 0;
  if (cfg.invert) value = -value;
  return clampAxis(value * cfg.scale);
}

function captureGamepadOutlineButton(buttons) {
  const input = document.getElementById("gamepad-outline-button");
  if (!input || document.activeElement !== input) return false;
  const previous = state.jog.buttons || [];
  const button = buttons.findIndex((pressed, index) => pressed && !previous[index]);
  if (button < 0) return false;
  state.ui.gamepad.outline_button = button;
  input.value = String(button);
  clearControlDrafts(input);
  input.blur();
  queueSaveUISettings();
  return true;
}

function handleGamepadOutlineButton(buttons, captured) {
  const button = state.ui.gamepad.outline_button;
  const previous = state.jog.buttons || [];
  if (captured || !buttons[button] || previous[button]) return;
  // This binding is deliberately inert outside capture mode; it must never
  // become an accidental machine action when the outline workflow is closed.
  if (!state.outline.active) return;
  addOutlinePoint();
}

function handleGamepadMacroButtons(buttons, deadman) {
  const prev = state.jog.buttons || [];
  for (const binding of state.ui.gamepad.macro_buttons) {
    if (binding.button === state.ui.gamepad.outline_button) continue;
    const pressed = !!buttons[binding.button];
    if (!pressed || prev[binding.button]) continue;
    const macro = macroByID(binding.macro_id);
    if (!macro) continue;
    if (!state.jog.armed || !deadman) {
      setNotice("Gamepad macro requires armed jog and deadman.", "error", "gamepad-macro");
      continue;
    }
    clearNotice("gamepad-macro");
    runMacro(macro, { source: "gamepad" });
  }
}

function sameJogAxes(a, b) {
  return ["x", "y", "z"].every((axis) => Number(a?.[axis] || 0) === Number(b?.[axis] || 0));
}

function sameButtonStates(a, b) {
  a = Array.isArray(a) ? a : [];
  b = Array.isArray(b) ? b : [];
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!!a[i] !== !!b[i]) return false;
  }
  return true;
}

function sampleJog() {
  try {
    if (state.jog.inputSuspended) {
      const changed = releaseJogInput();
      if (changed) renderJog();
      return;
    }
    if (state.jog.surfaceInput) {
      const { axis, sign } = state.jog.surfaceInput;
      const axes = { x: axis === "x" ? sign : 0, y: axis === "y" ? sign : 0, z: axis === "z" ? sign : 0 };
      state.jog.pad = "Surface";
      state.jog.deadman = true;
      state.jog.axes = axes;
      if (state.jog.armed) sendJog({ type: "input", deadman: true, axes });
      return;
    }
    if (state.workarea?.mobileJogActive) {
      const axes = state.workarea.mobileJogAxes || { x: 0, y: 0, z: 0 };
      state.jog.pad = "Touch";
      state.jog.deadman = true;
      state.jog.axes = axes;
      if (state.jog.armed) sendJog({ type: "input", deadman: true, axes });
      return;
    }
    const gp = currentGamepad();
    if (!gp) {
      const changed = releaseJogInput();
      if (changed) renderJog();
      return;
    }
    const gamepad = state.ui.gamepad;
    const axes = {
      x: mappedAxis(gp, "x"),
      y: mappedAxis(gp, "y"),
      z: mappedAxis(gp, "z"),
    };
    const buttons = buttonStates(gp);
    const deadman = buttonPressed(gp, gamepad.deadman_button);
    const slow = gamepad.slow_buttons.some((btn) => buttonPressed(gp, btn));
    const label = gamepadLabel(gp);
    const changed = state.jog.preferredPadIndex !== gp.index ||
      state.jog.pad !== label ||
      state.jog.deadman !== deadman ||
      !sameJogAxes(state.jog.axes, axes) ||
      !sameButtonStates(state.jog.buttons, buttons);
    state.jog.preferredPadIndex = gp.index;
    state.jog.pad = label;
    state.jog.deadman = deadman;
    state.jog.axes = axes;
    const capturingOutlineButton = captureGamepadOutlineButton(buttons);
    // The stop/latest input frame must precede a point-capture request on the
    // WebSocket. This makes a release+button press in one sampled gamepad frame
    // freeze the endpoint of the released motion, never the previous position.
    if (state.jog.armed) sendJog({ type: "input", deadman, axes, slow });
    handleGamepadOutlineButton(buttons, capturingOutlineButton);
    handleGamepadMacroButtons(buttons, deadman);
    state.jog.buttons = buttons;
    if (changed) renderJog();
  } catch (e) {
    state.jog.error = "gamepad read failed: " + e.message;
    renderJog();
  } finally {
    scheduleJogSample();
  }
}

function releaseJogInput(force = false) {
  const touchChanged = resetMobileWorkAreaJog();
  const surfaceChanged = !!state.jog.surfaceInput;
  state.jog.surfaceInput = null;
  const changed = touchChanged || surfaceChanged || !!state.jog.pad || !!state.jog.deadman ||
    !sameJogAxes(state.jog.axes, { x: 0, y: 0, z: 0 }) ||
    (Array.isArray(state.jog.buttons) && state.jog.buttons.length > 0);
  state.jog.pad = "";
  state.jog.deadman = false;
  state.jog.axes = { x: 0, y: 0, z: 0 };
  state.jog.buttons = [];
  if (state.jog.armed && (force || changed || jogInputActive(state.jog.lastInput))) {
    sendJog({ type: "input", deadman: false, axes: state.jog.axes }, true);
  }
  return changed;
}

function scheduleJogSample() {
  if (state.jog.sampleTimer) return;
  const ms = Math.max(8, Number(state.jog.caps?.tick_ms) || 20);
  state.jog.sampleTimer = setTimeout(() => {
    state.jog.sampleTimer = null;
    sampleJog();
  }, ms);
}

function clampAxis(v) {
  if (!Number.isFinite(v)) return 0;
  return Math.max(-1, Math.min(1, v));
}

function applySnapshot(snap) {
  if (snap.machine) {
    applyMachineStatus(snap.machine, false);
  }
  if (Array.isArray(snap.files)) {
    state.files = new Map(snap.files.map((f) => [f.path, f]));
    state.filesLoaded = true;
  }
  if (Array.isArray(snap.jobs)) state.jobs = new Map(snap.jobs.map((j) => [j.id, j]));
  if (Array.isArray(snap.jobs)) state.machine.pending_jobs = queuePendingCount();
  renderMachine();
  renderFiles();
  renderJobs();
  if (Array.isArray(snap.gcode)) {
    state.gcodeSeqs.clear();
    state.gcodeLines = [];
    document.getElementById("gcode-log").innerHTML = "";
    for (const ln of snap.gcode) appendGcodeLine(ln);
  }
}

function applyMachineStatus(next, render = true) {
  if (!next) return;
  state.machine = reconcileObservedMachineStatus(next);
  if (externalJobState(state.machine.state) && !state.activeGcode?.path) {
    if (!state.externalJobObservedAt) state.externalJobObservedAt = Date.now();
  } else {
    state.externalJobObservedAt = 0;
  }
  syncActiveGcodeFromMachine(next);
  applySurfaceAutomaticView();
  clearNotice("machine-status");
  if (render) renderMachine();
}

function externalJobState(machineState) {
  return ["Run", "Hold", "Pause", "Wait", "Tool"].includes(String(machineState || ""));
}

function externalJobInfo(machine, active) {
  if (active?.path || !externalJobState(machine?.state)) return null;
  const rawProgress = String(machine?.fields?.P || "").trim();
  const observedAt = Number(state.externalJobObservedAt) || Date.now();
  return {
    title: "External controller job " + String(machine.state).toLowerCase(),
    detail: "File and G-code line are unavailable because this job was started outside CNC Proxy.",
    progressText: rawProgress ? "Machine-reported progress P: " + rawProgress : "External job; machine progress is unavailable.",
    observedText: "Observed " + fmtDuration(Date.now() - observedAt) + " ago",
  };
}

function applyChange(ev) {
  if (ev.kind === "reset") {
    setNotice("Local state changed; reloading.", "info", "local-state");
    setTimeout(() => location.reload(), 400);
    return;
  }
  if (ev.kind === "entry" && ev.entry) {
    if (ev.entry.sync === "") state.files.delete(ev.entry.path);
    else state.files.set(ev.entry.path, ev.entry);
    if (state.activeGcode?.path === ev.entry.path) loadActiveGcode();
    renderMachine();
    renderFiles();
  } else if (ev.kind === "job" && ev.job) {
    state.jobs.set(ev.job.id, ev.job);
    state.machine.pending_jobs = queuePendingCount();
    renderMachine();
    renderJobs();
  } else if (ev.kind === "active_gcode") {
    loadActiveGcode();
  }
}

function connectControlSSE() {
  if (state.controlES) return;
  const es = new EventSource("/api/events?scope=control");
  state.controlES = es;
  es.onopen = () => clearConnectivityIssue("control-sse");
  es.addEventListener("snapshot", (e) => {
    clearConnectivityIssue("control-sse");
    applySnapshot(JSON.parse(e.data));
  });
  es.addEventListener("machine", (e) => applyMachineStatus(JSON.parse(e.data)));
  es.addEventListener("gcode", (e) => appendGcodeLine(JSON.parse(e.data)));
  es.onerror = () => setConnectivityIssue("control-sse", "Control event stream disconnected; retrying.");
}

function connectFilesSSE() {
  if (state.filesES) return;
  const es = new EventSource("/api/events?scope=files");
  state.filesES = es;
  es.onopen = () => clearConnectivityIssue("files-sse");
  es.addEventListener("snapshot", (e) => {
    clearConnectivityIssue("files-sse");
    applySnapshot(JSON.parse(e.data));
  });
  es.addEventListener("change", (e) => applyChange(JSON.parse(e.data)));
  es.onerror = () => setConnectivityIssue("files-sse", "Files event stream disconnected; retrying.");
}

function viewTabFromURL(locationLike = window.location) {
  const pathname = String(locationLike?.pathname || "/").replace(/^\/+|\/+$/g, "");
  if (VIEW_TABS.includes(pathname)) return pathname;
  const queryTab = new URLSearchParams(String(locationLike?.search || "")).get("tab");
  if (VIEW_TABS.includes(queryTab)) return queryTab;
  // Phone defaults favour monitoring. Surface kiosk routing happens only after
  // a fresh state report is available in applySurfaceAutomaticView().
  return globalThis.window?.matchMedia?.("(max-width: 600px)")?.matches ? "dashboard" : "active-job";
}

function syncViewTabURL(name, mode) {
  if (mode === "none" || !window.history) return;
  const url = new URL(window.location.href);
  url.pathname = "/" + name;
  url.searchParams.delete("tab");
  url.hash = "";
  const next = url.pathname + url.search;
  const current = window.location.pathname + window.location.search;
  if (mode === "push" && next === current) return;
  const method = mode === "replace" ? "replaceState" : "pushState";
  window.history[method]({ tab: name }, "", next);
}

function showTab(name, urlMode = "push") {
  if (!VIEW_TABS.includes(name)) name = "active-job";
  // A tab selected by the operator must survive repeated status snapshots
  // emitted while a job is in one machine state. Automatic Surface routing
  // resumes when that state actually changes (for example Run to Hold).
  if (urlMode === "push" && isSurfaceKiosk()) {
    state.surface.manual_view_state = String(state.machine?.state || "");
  }
  disarmMovementOnControlExit(name);
  state.activeTab = name;
  if (name !== "dashboard") setDashboardControlsOpen(false);
  document.body.dataset.activeTab = name;
  for (const tab of VIEW_TABS) {
    const view = document.getElementById(tab + "-view");
    if (view) view.hidden = tab !== name;
    const button = document.getElementById("tab-" + tab);
    const active = tab === name;
    button?.classList.toggle("active", active);
    button?.setAttribute("aria-selected", String(active));
    if (button) button.tabIndex = active ? 0 : -1;
  }
  for (const button of document.querySelectorAll("[data-surface-view]")) {
    if (button.dataset.surfaceView === name) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  if (name === "files") connectFilesSSE();
  if (name === "active-job") renderActiveGcode();
  if (name === "dashboard") renderDashboard();
  if (name === "control" || name === "jog") renderJog();
  else clearNotice("jog-availability");
  syncDashboardCameras();
  syncViewTabURL(name, urlMode);
}

function runSurfaceShellAction(action) {
  switch (action) {
  case "home":
    document.getElementById("ctl-home-main")?.click();
    break;
  case "probe-z":
    document.getElementById("origin-probe-z")?.click();
    break;
  case "work-zero": {
    showTab("control");
    const section = document.getElementById("work-zero-section");
    if (section) {
      section.open = true;
      section.scrollIntoView?.({ block: "start", behavior: "smooth" });
    }
    break;
  }
  case "files":
    showTab("files");
    break;
  case "camera":
    showTab("dashboard");
    document.querySelector(".dashboard-camera-stage")?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    break;
  case "actions": {
    const actions = document.getElementById("command-actions");
    const toggle = document.getElementById("mobile-actions-toggle");
    const open = !actions?.classList.contains("mobile-menu-open");
    actions?.classList.toggle("mobile-menu-open", open);
    toggle?.setAttribute("aria-expanded", String(open));
    break;
  }
  }
}

function applySurfaceAutomaticView() {
  if (!isSurfaceKiosk() || !state.surface.auto_switch || !state.machine?.state) return;
  const machineState = String(state.machine.state);
  if (state.surface.manual_view_state === machineState) return;
  // A manual selection applies only to the current machine state. Let the next
  // state transition route the operator to the corresponding Surface view.
  state.surface.manual_view_state = "";
  // A local jog step can briefly report Run. Do not route away from its armed
  // Jog session: changing tabs would deliberately disarm that same session and
  // make the next detent fail. Attention states still take priority below.
  const localJogSession = state.activeTab === "jog" && state.jog?.armed === true;
  const target = ["Tool", "Pause", "Wait", "Hold", "Alarm"].includes(machineState)
    ? "attention"
    : (machineState === "Run" && !localJogSession ? "dashboard" : (machineState === "Idle" ? state.surface.start_view : ""));
  if (target && target !== state.activeTab) showTab(target, "replace");
}

function showActiveJobLeftTab(name) {
  const tabs = ["source", "console"];
  if (!tabs.includes(name)) name = "source";
  state.activeJobLeftTab = name;
  for (const tab of tabs) {
    const button = document.getElementById("active-job-left-tab-" + tab);
    const panel = document.getElementById(tab === "source" ? "active-gcode-source" : "active-gcode-console");
    const active = tab === name;
    if (panel) panel.hidden = !active;
    button?.setAttribute("aria-selected", String(active));
    if (button) button.tabIndex = active ? 0 : -1;
  }
  document.getElementById("active-gcode-left")?.classList.toggle("is-console-active", name === "console");
  document.getElementById("active-gcode-source-position")?.classList.toggle("is-hidden", name !== "source");
  if (name === "source") scheduleActiveGcodeSourceRender();
  else renderGcodeLog();
}

function activeJobSplitBounds(width) {
  const available = Number(width);
  if (!(available > 0)) return { min: 0, max: 100 };
  const min = Math.min(50, (ACTIVE_JOB_SPLIT_MIN_LEFT_PX / available) * 100);
  const previewMax = ((available - ACTIVE_JOB_SPLITTER_PX - ACTIVE_JOB_SPLIT_MIN_PREVIEW_PX) / available) * 100;
  return {
    min,
    max: Math.max(min, Math.min(100, previewMax)),
  };
}

function setActiveJobSplitPercent(percent) {
  const workspace = document.querySelector(".active-gcode-workspace");
  const splitter = document.getElementById("active-gcode-splitter");
  if (!workspace || !splitter) return;
  const bounds = activeJobSplitBounds(workspace.clientWidth);
  const next = Math.max(bounds.min, Math.min(bounds.max, Number(percent) || ACTIVE_JOB_SPLIT_DEFAULT_PERCENT));
  state.activeJobSplitPercent = next;
  workspace.style.setProperty("--active-gcode-left-width", `${next}%`);
  splitter.setAttribute("aria-valuemin", String(Math.round(bounds.min)));
  splitter.setAttribute("aria-valuemax", String(Math.round(bounds.max)));
  splitter.setAttribute("aria-valuenow", String(Math.round(next)));
  splitter.setAttribute("aria-valuetext", `Job details ${Math.round(next)} percent`);
  scheduleActiveGcodeSourceRender();
  scheduleGcodeRender();
}

function bindActiveJobSplitter() {
  const workspace = document.querySelector(".active-gcode-workspace");
  const splitter = document.getElementById("active-gcode-splitter");
  if (!workspace || !splitter) return;
  const setFromClientX = (clientX) => {
    const rect = workspace.getBoundingClientRect();
    if (!(rect.width > 0)) return;
    setActiveJobSplitPercent(((clientX - rect.left) / rect.width) * 100);
  };
  splitter.onpointerdown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    splitter.classList.add("dragging");
    splitter.setPointerCapture(e.pointerId);
    setFromClientX(e.clientX);
  };
  splitter.onpointermove = (e) => {
    if (!splitter.hasPointerCapture(e.pointerId)) return;
    setFromClientX(e.clientX);
  };
  const release = (e) => {
    if (splitter.hasPointerCapture(e.pointerId)) splitter.releasePointerCapture(e.pointerId);
    splitter.classList.remove("dragging");
  };
  splitter.onpointerup = release;
  splitter.onpointercancel = release;
  splitter.onlostpointercapture = () => splitter.classList.remove("dragging");
  splitter.onkeydown = (e) => {
    const bounds = activeJobSplitBounds(workspace.clientWidth);
    let next = state.activeJobSplitPercent;
    if (e.key === "ArrowLeft") next -= ACTIVE_JOB_SPLIT_STEP_PERCENT;
    else if (e.key === "ArrowRight") next += ACTIVE_JOB_SPLIT_STEP_PERCENT;
    else if (e.key === "Home") next = bounds.min;
    else if (e.key === "End") next = bounds.max;
    else return;
    e.preventDefault();
    setActiveJobSplitPercent(next);
  };
  setActiveJobSplitPercent(state.activeJobSplitPercent);
}

async function pollMachine() {
  try {
    const r = await request("/api/machine/status");
    const next = await r.json();
    applyMachineStatus(next);
    clearConnectivityIssue("machine-status");
  } catch (e) {
    setConnectivityIssue("machine-status", "Machine status unavailable: " + e.message);
  }
  try {
    await refreshJobs();
  } catch {
    // File SSE reports its own disconnect state; avoid duplicating it here.
  }
}

function mergeMachineStatusForDisplay(next) {
  if (!jogEstimateActive()) return next;
  return {
    ...next,
    mpos: state.machine.mpos,
    wpos: state.machine.wpos,
    motion_estimated: !!state.machine.motion_estimated,
  };
}

function shouldPreserveJogPrediction(next) {
  if (!next?.mpos || !jogEstimateActive()) return false;
  if (state.jog.motionRevisionKnown && !jogMotionAwaitingSettlement()) return false;
  if (next.state && next.state !== "Idle" && next.state !== "Run") return false;
  const predicted = state.jog.mpos;
  if (!predicted) return false;
  const target = state.jog.target || predicted;
  let predictionIsAhead = false;
  for (const axis of ["x", "y", "z"]) {
    const observedAxis = axisValue(next.mpos, axis);
    const predictedAxis = axisValue(predicted, axis);
    if (observedAxis === null || predictedAxis === null) continue;
    if (Math.abs(predictedAxis - observedAxis) <= JOG_PREDICTION_TOLERANCE_MM) continue;
    const targetAxis = axisValue(target, axis);
    if (targetAxis === null) {
      predictionIsAhead = true;
      continue;
    }
    const predictedRemaining = targetAxis - predictedAxis;
    const observedRemaining = targetAxis - observedAxis;
    const sameApproachSide = Math.abs(predictedRemaining) <= JOG_PREDICTION_TOLERANCE_MM ||
      Math.sign(observedRemaining) === Math.sign(predictedRemaining);
    if (sameApproachSide && Math.abs(observedRemaining) > Math.abs(predictedRemaining) + JOG_PREDICTION_TOLERANCE_MM) {
      predictionIsAhead = true;
    }
  }
  return predictionIsAhead;
}

function reconcileObservedMachineStatus(next) {
  if (!next) return next;
  state.jog.observed = next.mpos || state.jog.observed;
  if (next.mpos && !shouldPreserveJogPrediction(next)) {
    state.jog.mpos = next.mpos;
    state.jog.wpos = next.wpos || state.jog.wpos;
    state.jog.estimated = false;
    state.jog.estimatedUntil = 0;
  }
  return mergeMachineStatusForDisplay(next);
}

function initializeResponsiveControlSections(isMobile = window.matchMedia?.("(max-width: 600px)")?.matches === true) {
  const sections = [
    ["jog-settings-section", true],
    ["move-to-work-section", true],
    ["work-zero-section", true],
    ["gamepad-section", false],
  ];
  for (const [id, desktopOpen] of sections) {
    const section = document.getElementById(id);
    if (section) section.open = !isMobile && desktopOpen;
  }
}

function bindSurfaceHoldButton(button, axis, sign, useSelectedAxis = false) {
  if (!button) return;
  let pointerId = null;
  const targetAxis = () => useSelectedAxis ? state.surface.mpg_axis : axis;
  const start = () => {
    if (state.surface.motion === "step" && !useSelectedAxis) return;
    beginSurfaceHoldJog(targetAxis(), sign);
  };
  const stop = () => stopSurfaceHoldJog();
  button.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    pointerId = e.pointerId;
    button.setPointerCapture?.(pointerId);
    if (state.surface.motion === "hold" || useSelectedAxis) start();
  });
  button.addEventListener("pointerup", (e) => {
    if (pointerId !== e.pointerId) return;
    if (state.surface.motion === "hold" || useSelectedAxis) stop();
    else sendSurfaceStep(targetAxis(), sign);
    pointerId = null;
  });
  button.addEventListener("pointercancel", stop);
  button.addEventListener("lostpointercapture", stop);
  button.addEventListener("keydown", (e) => {
    if (e.repeat || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    if (state.surface.motion === "hold" || useSelectedAxis) start();
    else sendSurfaceStep(targetAxis(), sign);
  });
  button.addEventListener("keyup", (e) => {
    if (e.key === "Enter" || e.key === " ") stop();
  });
  button.addEventListener("click", (e) => e.preventDefault());
}

function surfaceMPGPointerSample(clientX, clientY, rect) {
  const width = Math.max(1, Number(rect?.width || 0));
  const height = Math.max(1, Number(rect?.height || 0));
  const dx = Number(clientX) - (Number(rect?.left || 0) + width / 2);
  const dy = Number(clientY) - (Number(rect?.top || 0) + height / 2);
  return {
    angle: Math.atan2(dy, dx) * 180 / Math.PI,
    radius: Math.hypot(dx, dy) / (Math.min(width, height) / 2),
  };
}

function surfaceMPGAngleDelta(previous, current) {
  return ((Number(current) - Number(previous) + 540) % 360) - 180;
}

function prepareSurfaceMPGFeedback() {
  const AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioContextCtor) return null;
  try {
    if (!surfaceMPGAudioContext) surfaceMPGAudioContext = new AudioContextCtor({ latencyHint: "interactive" });
    if (surfaceMPGAudioContext.state !== "running" && !surfaceMPGAudioResume) {
      surfaceMPGAudioResume = Promise.resolve(surfaceMPGAudioContext.resume?.())
        .catch(() => null)
        .then(() => surfaceMPGAudioContext)
        .finally(() => { surfaceMPGAudioResume = null; });
    }
  } catch {
    surfaceMPGAudioContext = null;
    surfaceMPGAudioResume = null;
  }
  return surfaceMPGAudioContext;
}

function playSurfaceMPGClick(audio) {
  if (!audio || audio.state !== "running") return false;
  const now = audio.currentTime;
  // Browser/WebAudio can receive several acknowledgement callbacks inside one
  // render turn. Space the physical feedback pulses so they remain audible as
  // distinct detents instead of summing into one nearly silent transient.
  // Starting exactly at currentTime can miss the first audio render quantum in
  // Firefox. The oscillator then joins after the fast fade has already begun,
  // making an otherwise identical click sound randomly quiet. A tiny fixed
  // lead gives every pulse the same full attack without adding perceptible lag.
  const start = Math.max(now + SURFACE_MPG_AUDIO_LOOKAHEAD_S, surfaceMPGNextClickTime);
  surfaceMPGNextClickTime = start + 0.03;
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  oscillator.type = "square";
  oscillator.frequency.setValueAtTime(900, start);
  // Keep each detent equally prominent; system volume remains the operator's
  // overall loudness control.  This is deliberately twice the original level
  // for the comparatively quiet Surface speakers.
  gain.gain.setValueAtTime(0.15, start);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.026);
  oscillator.connect(gain);
  gain.connect(audio.destination);
  oscillator.start(start);
  oscillator.stop(start + 0.027);
  return true;
}

function pulseSurfaceMPGDetent(wheel) {
  try {
    globalThis.navigator?.vibrate?.(8);
  } catch {
    // Vibration is optional and is not exposed by most desktop hardware.
  }
  const audio = prepareSurfaceMPGFeedback();
  if (!playSurfaceMPGClick(audio) && surfaceMPGAudioResume) {
    const resume = surfaceMPGAudioResume;
    resume.then((resumedAudio) => { playSurfaceMPGClick(resumedAudio); }).catch(() => {});
  }
  if (!wheel) return;
  wheel.classList.add("is-detent");
  if (surfaceMPGFeedbackTimer) clearTimeout(surfaceMPGFeedbackTimer);
  surfaceMPGFeedbackTimer = setTimeout(() => {
    wheel.classList.remove("is-detent");
    surfaceMPGFeedbackTimer = null;
  }, 55);
}

function finishSurfaceMPGGesture() {
  const gesture = state.jog.surfaceWheel;
  if (!gesture.gestureReleased || state.jog.surfaceStepPending) return false;
  if (!gesture.blocked && gesture.gestureAccepted > 0) {
    const noun = gesture.gestureAccepted === 1 ? "increment" : "increments";
    setStatusMessage(
      "surface-jog",
      `MPG ${gesture.gestureAxis.toUpperCase()}: ${gesture.gestureAccepted} ${noun} accepted.`,
      "ok",
      { force: true },
    );
  }
  gesture.gestureSteps = 0;
  gesture.gestureAccepted = 0;
  gesture.gestureReleased = false;
  gesture.gestureAxis = "";
  gesture.blocked = false;
  return true;
}

function bindSurfaceMPGWheel() {
  const wheel = document.getElementById("surface-mpg-wheel");
  if (!wheel) return;
  const release = (e) => {
    if (state.jog.surfaceWheel.pointerId !== e.pointerId) return;
    state.jog.surfaceWheel.pointerId = null;
    state.jog.surfaceWheel.lastAngle = null;
    state.jog.surfaceWheel.remainder = 0;
    state.jog.surfaceWheel.gestureReleased = true;
    finishSurfaceMPGGesture();
    renderSurfaceMPGWheel();
  };
  wheel.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !surfaceJogReady()) return;
    const sample = surfaceMPGPointerSample(e.clientX, e.clientY, wheel.getBoundingClientRect());
    if (sample.radius < SURFACE_MPG_DEAD_ZONE) return;
    state.jog.surfaceWheel.pointerId = e.pointerId;
    state.jog.surfaceWheel.lastAngle = sample.angle;
    state.jog.surfaceWheel.remainder = 0;
    state.jog.surfaceWheel.gestureSteps = 0;
    state.jog.surfaceWheel.gestureAccepted = 0;
    state.jog.surfaceWheel.gestureReleased = false;
    state.jog.surfaceWheel.gestureAxis = state.surface.mpg_axis;
    state.jog.surfaceWheel.blocked = false;
    prepareSurfaceMPGFeedback();
    wheel.setPointerCapture?.(e.pointerId);
    e.preventDefault();
    renderSurfaceMPGWheel();
  });
  wheel.addEventListener("pointermove", (e) => {
    if (state.jog.surfaceWheel.pointerId !== e.pointerId) return;
    if (state.jog.surfaceWheel.blocked) return;
    const sample = surfaceMPGPointerSample(e.clientX, e.clientY, wheel.getBoundingClientRect());
    if (sample.radius < SURFACE_MPG_DEAD_ZONE) {
      state.jog.surfaceWheel.lastAngle = null;
      return;
    }
    if (!Number.isFinite(state.jog.surfaceWheel.lastAngle)) {
      state.jog.surfaceWheel.lastAngle = sample.angle;
      return;
    }
    const delta = surfaceMPGAngleDelta(state.jog.surfaceWheel.lastAngle, sample.angle);
    state.jog.surfaceWheel.lastAngle = sample.angle;
    state.jog.surfaceWheel.angle = (Number(state.jog.surfaceWheel.angle || 0) + delta + 360) % 360;
    state.jog.surfaceWheel.remainder += delta;
    while (Math.abs(state.jog.surfaceWheel.remainder) >= SURFACE_MPG_DETENT_DEG) {
      const sign = state.jog.surfaceWheel.remainder > 0 ? 1 : -1;
      state.jog.surfaceWheel.remainder -= SURFACE_MPG_DETENT_DEG * sign;
      if (state.surface.mpg_feedback === "detent") pulseSurfaceMPGDetent(wheel);
      if (!state.jog.surfaceStepPending && sendSurfaceStep(state.jog.surfaceWheel.gestureAxis, sign, "mpg")) {
        state.jog.surfaceWheel.gestureSteps++;
        state.jog.surfaceWheel.value += sign;
        if (state.surface.mpg_feedback !== "detent") pulseSurfaceMPGDetent(wheel);
      } else {
        if (!state.jog.surfaceStepPending) state.jog.surfaceWheel.remainder = 0;
      }
    }
    renderSurfaceMPGWheel();
  });
  wheel.addEventListener("pointerup", release);
  wheel.addEventListener("pointercancel", release);
  wheel.addEventListener("lostpointercapture", release);
  wheel.addEventListener("keydown", (e) => {
    if (!["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft"].includes(e.key)) return;
    e.preventDefault();
    const sign = ["ArrowUp", "ArrowRight"].includes(e.key) ? 1 : -1;
    if (state.jog.surfaceStepPending) return;
    prepareSurfaceMPGFeedback();
    if (sendSurfaceStep(state.surface.mpg_axis, sign)) {
      state.jog.surfaceWheel.value += sign;
      state.jog.surfaceWheel.angle = (Number(state.jog.surfaceWheel.angle || 0) + SURFACE_MPG_DETENT_DEG * sign + 360) % 360;
      pulseSurfaceMPGDetent(wheel);
    }
    renderSurfaceMPGWheel();
  });
}

function bindSurfaceXYMap() {
  const modal = document.getElementById("surface-xy-map-modal");
  const plot = document.getElementById("surface-xy-map-plot");
  const target = document.getElementById("surface-xy-map-target");
  const close = () => modal?.close();
  document.getElementById("surface-map-open")?.addEventListener("click", () => modal?.showModal());
  document.getElementById("surface-map-close")?.addEventListener("click", close);
  document.getElementById("surface-map-close-bottom")?.addEventListener("click", close);
  modal?.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
  plot?.addEventListener("pointerdown", (e) => {
    const rect = plot.getBoundingClientRect();
    const work = normalizeMachineSettings(state.ui.machine).work_area;
    const x = work.x_min + clampNumber((e.clientX - rect.left) / Math.max(1, rect.width), 0, 1) * (work.x_max - work.x_min);
    const y = work.y_max - clampNumber((e.clientY - rect.top) / Math.max(1, rect.height), 0, 1) * (work.y_max - work.y_min);
    target.textContent = `X ${x.toFixed(1)}  Y ${y.toFixed(1)} mm`;
  });
}

function init() {
  mountMachineReadouts();
  initializeResponsiveControlSections();
  applyDashboardURLState();
  const drop = document.getElementById("drop");
  const input = document.getElementById("file");
  document.getElementById("header-toggle").onclick = () => setHeaderCollapsed(!document.body.classList.contains("header-collapsed"));
  document.getElementById("development-refresh").onclick = () => window.location.reload();
  initDashboardControlsMenu();
  initWorkAreaActionsMenu();
  for (const [index, name] of NAV_VIEW_TABS.entries()) {
    const tab = document.getElementById("tab-" + name);
    tab.onclick = () => showTab(name);
    tab.onkeydown = (e) => {
      let next = index;
      if (e.key === "ArrowRight") next = (index + 1) % NAV_VIEW_TABS.length;
      else if (e.key === "ArrowLeft") next = (index - 1 + NAV_VIEW_TABS.length) % NAV_VIEW_TABS.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = NAV_VIEW_TABS.length - 1;
      else return;
      e.preventDefault();
      const nextTab = document.getElementById("tab-" + NAV_VIEW_TABS[next]);
      showTab(NAV_VIEW_TABS[next]);
      nextTab.focus();
    };
  }
  window.addEventListener("popstate", () => {
    applyDashboardURLState();
    showTab(viewTabFromURL(), "none");
  });
  showTab(viewTabFromURL(), "replace");
  document.getElementById("dashboard-profile").onchange = (e) => selectDashboardProfile(e.target.value);
  document.getElementById("dashboard-new").onclick = () => {
    setDashboardControlsOpen(false);
    openDashboardSettings(true);
  };
  document.getElementById("dashboard-configure").onclick = () => {
    setDashboardControlsOpen(false);
    openDashboardSettings(false);
  };
  document.getElementById("dashboard-copy-link").onclick = () => copyDashboardURL(false);
  document.getElementById("dashboard-copy-obs").onclick = () => copyDashboardURL(true);
  document.getElementById("dashboard-settings-close").onclick = closeDashboardSettings;
  document.getElementById("dashboard-settings-cancel").onclick = closeDashboardSettings;
  document.getElementById("dashboard-save").onclick = saveDashboardProfile;
  document.getElementById("dashboard-delete").onclick = deleteDashboardProfile;
  document.getElementById("dashboard-settings-modal").addEventListener("cancel", (e) => {
    e.preventDefault();
    closeDashboardSettings();
  });
  const activeJobLeftTabs = ["source", "console"];
  for (const [index, name] of activeJobLeftTabs.entries()) {
    const tab = document.getElementById("active-job-left-tab-" + name);
    tab.onclick = () => showActiveJobLeftTab(name);
    tab.onkeydown = (e) => {
      let next = index;
      if (e.key === "ArrowRight") next = (index + 1) % activeJobLeftTabs.length;
      else if (e.key === "ArrowLeft") next = (index - 1 + activeJobLeftTabs.length) % activeJobLeftTabs.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = activeJobLeftTabs.length - 1;
      else return;
      e.preventDefault();
      const nextTab = document.getElementById("active-job-left-tab-" + activeJobLeftTabs[next]);
      showActiveJobLeftTab(activeJobLeftTabs[next]);
      nextTab.focus();
    };
  }
  showActiveJobLeftTab(state.activeJobLeftTab);
  bindActiveJobSplitter();
  drop.onclick = () => input.click();
  input.onchange = () => { uploadFiles(input.files); input.value = ""; };
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    uploadFiles(e.dataTransfer.files);
  };

  document.getElementById("filter").oninput = (e) => {
    state.filter = e.target.value;
    renderFiles();
  };
  document.getElementById("folder-up").onclick = () => openDir(parentRelPath(state.currentDir));
  document.getElementById("folder-new").onclick = doMkdir;

  const form = document.getElementById("gcode-form");
  const gcodeInput = document.getElementById("gcode-input");
  form.onsubmit = (e) => {
    e.preventDefault();
    const line = gcodeInput.value.trim();
    if (!line) return;
    gcodeInput.value = "";
    submitGcode(line);
  };
  gcodeInput.onkeydown = (e) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      navigateCommandHistory(gcodeInput, -1);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      navigateCommandHistory(gcodeInput, 1);
    } else if (e.key.length === 1) {
      state.historyIndex = -1;
    }
  };
  document.getElementById("log-filter").onchange = (e) => {
    state.logFilter = e.target.value;
    state.ui.log.filter = state.logFilter;
    queueSaveUISettings();
    renderGcodeLog();
  };
  document.getElementById("log-search").oninput = (e) => {
    state.logSearch = e.target.value;
    renderGcodeLog();
  };
  document.getElementById("log-autoscroll").onchange = (e) => {
    state.ui.log.autoscroll = e.target.checked;
    queueSaveUISettings();
  };
  document.getElementById("log-pause").onchange = (e) => {
    state.logPaused = e.target.checked;
    if (!state.logPaused) renderGcodeLog();
  };
  document.getElementById("log-copy").onclick = copyVisibleLog;
  document.getElementById("log-export").onclick = exportVisibleLog;
  document.getElementById("log-clear").onclick = clearGcodeLog;
  document.getElementById("backup-export").onclick = exportBackup;
  document.getElementById("backup-import").onclick = () => document.getElementById("backup-file").click();
  document.getElementById("backup-file").onchange = (e) => {
    importBackupFile(e.target.files[0]);
    e.target.value = "";
  };
  document.getElementById("macro-new").onclick = newMacro;
  document.getElementById("macro-save").onclick = saveMacroFromForm;
  bindButtonAction(document.getElementById("macro-run"), () => runMacro(macroByID(state.selectedMacroId)));
  document.getElementById("macro-up").onclick = () => moveSelectedMacro(-1);
  document.getElementById("macro-down").onclick = () => moveSelectedMacro(1);
  document.getElementById("macro-delete").onclick = deleteSelectedMacro;
  bindDirtyDraftControls(MACRO_EDITOR_IDS);
  for (const axis of ["x", "y", "z"]) {
    document.getElementById("gamepad-axis-" + axis).onchange = () => updateGamepadAxis(axis);
    document.getElementById("gamepad-invert-" + axis).onchange = () => updateGamepadAxis(axis);
    document.getElementById("gamepad-speed-" + axis).oninput = () => updateGamepadAxis(axis);
  }
  document.getElementById("gamepad-deadman-button").onchange = updateGamepadButtons;
  document.getElementById("gamepad-slow-button-0").onchange = updateGamepadButtons;
  document.getElementById("gamepad-slow-button-1").onchange = updateGamepadButtons;
  const outlineButtonInput = document.getElementById("gamepad-outline-button");
  outlineButtonInput.oninput = () => markControlDirty(outlineButtonInput);
  outlineButtonInput.onchange = () => {
    clearControlDrafts(outlineButtonInput);
    updateGamepadButtons();
  };
  document.getElementById("gamepad-add-macro").onclick = addGamepadMacroBinding;
  bindDirtyDraftControls(MACHINE_SETTING_IDS);
  for (const id of MACHINE_SETTING_IDS) {
    document.getElementById(id).onchange = updateMachineSettings;
  }
  for (const btn of document.querySelectorAll("[data-feed-step]")) {
    btn.onclick = () => stepTapFeed(Number(btn.dataset.feedStep) || 0);
  }
  for (const axis of ["x", "y", "z"]) {
    const input = workMoveInput(axis);
    input.oninput = () => {
      input.dataset.dirty = "1";
      renderWorkMoveControls();
    };
    input.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        sendWorkCoordinateMove();
      }
    };
  }
  for (const btn of document.querySelectorAll("[data-work-move-reset]")) {
    bindButtonAction(btn, (e) => {
      e.preventDefault();
      resetWorkMoveInput(btn.dataset.workMoveReset);
    });
  }
  bindButtonAction(document.getElementById("work-move-send"), sendWorkCoordinateMove);
  document.getElementById("tap-safe-z-enabled").onchange = updateSafeZToggle;
  for (const btn of document.querySelectorAll("[data-z-step-dir]")) {
    bindButtonAction(btn, () => stepZ(Number(btn.dataset.zStepDir) || 1));
  }
  for (const btn of document.querySelectorAll("[data-origin-zero]")) {
    bindButtonAction(btn, () => setOriginAxis(btn.dataset.originZero));
  }
  bindButtonAction(document.getElementById("origin-probe-z"), runAutoZProbe);
  bindButtonAction(document.getElementById("origin-probe-3d"), openProbe3D);
  bindButtonAction(document.getElementById("probe-3d-close"), closeProbe3D);
  bindButtonAction(document.getElementById("probe-3d-cancel"), closeProbe3D);
  bindButtonAction(document.getElementById("probe-3d-run"), runProbe3D);
  document.getElementById("probe-3d-kind").onchange = renderProbe3DForm;
  for (const id of ["probe-3d-x", "probe-3d-y", "probe-3d-z", "probe-3d-diameter"]) {
    document.getElementById(id).oninput = renderProbe3DForm;
  }
  document.getElementById("probe-3d-modal").addEventListener("cancel", (e) => {
    e.preventDefault();
    closeProbe3D();
  });
  renderProbe3DForm();
  bindButtonAction(document.getElementById("origin-set-xyz-open"), () => openOriginDialog("origin-xyz-modal"));
  bindButtonAction(document.getElementById("origin-set-open"), () => openOriginDialog("origin-set-modal"));
  bindButtonAction(document.getElementById("origin-presets-open"), () => openOriginDialog("origin-presets-modal"));
  bindButtonAction(document.getElementById("origin-xyz-close"), () => closeOriginDialog("origin-xyz-modal"));
  bindButtonAction(document.getElementById("origin-set-close"), () => closeOriginDialog("origin-set-modal"));
  bindButtonAction(document.getElementById("origin-presets-close"), () => closeOriginDialog("origin-presets-modal"));
  for (const id of ["origin-xyz-x", "origin-xyz-y", "origin-xyz-z"]) {
    const input = document.getElementById(id);
    if (!input) continue;
    input.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        applyXYZOrigin();
      }
    };
  }
  document.getElementById("origin-set-source").onchange = renderJog;
  for (const id of ["origin-set-x", "origin-set-y"]) {
    const input = document.getElementById(id);
    input.oninput = renderOriginSetChange;
    input.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        applyOriginSource();
      }
    };
  }
  document.getElementById("saved-origin-select").onchange = renderJog;
  bindButtonAction(document.getElementById("origin-xyz-apply"), applyXYZOrigin);
  bindButtonAction(document.getElementById("origin-set-apply"), applyOriginSource);
  bindButtonAction(document.getElementById("saved-origin-recall"), recallSelectedOrigin);
  bindButtonAction(document.getElementById("saved-origin-save"), saveCurrentOrigin);
  bindButtonAction(document.getElementById("saved-origin-delete"), deleteSelectedOrigin);
  bindWorkAreaInteractions();
  bindButtonAction(document.getElementById("workarea-zoom-out"), () => zoomWorkArea(1 / WORKAREA_ZOOM_STEP));
  bindButtonAction(document.getElementById("workarea-zoom-reset"), resetWorkAreaView);
  bindButtonAction(document.getElementById("workarea-zoom-in"), () => zoomWorkArea(WORKAREA_ZOOM_STEP));
  bindButtonAction(document.getElementById("outline-start"), startOutlineCapture);
  bindButtonAction(document.getElementById("outline-end"), endOutlineCapture);
  bindButtonAction(document.getElementById("outline-add-point"), addOutlinePoint);
  bindButtonAction(document.getElementById("outline-trace"), traceOutline);
  bindButtonAction(document.getElementById("outline-undo"), undoOutline);
  bindButtonAction(document.getElementById("outline-redo"), redoOutline);
  bindButtonAction(document.getElementById("outline-close"), closeOutline);
  bindButtonAction(document.getElementById("outline-load"), () => document.getElementById("outline-file").click());
  bindButtonAction(document.getElementById("outline-save"), saveOutlineJSON);
  document.getElementById("outline-curve-fit").onchange = toggleOutlineCurveFit;
  bindButtonAction(document.getElementById("outline-export"), exportOutline);
  document.getElementById("outline-file").onchange = (e) => {
    loadOutlineFile(e.target.files[0]);
    e.target.value = "";
  };
  const outlineSpacing = document.getElementById("outline-field-spacing");
  outlineSpacing.oninput = () => {
    markControlDirty(outlineSpacing);
    scheduleOutlineFieldSpacingUpdate();
  };
  outlineSpacing.onchange = scheduleOutlineFieldSpacingUpdate;
  bindButtonAction(document.getElementById("outline-field-probe"), runFieldProbe);
  bindButtonAction(document.getElementById("outline-field-move"), moveToSelectedFieldProbePoint);
  bindButtonAction(document.getElementById("outline-field-reset"), resetSelectedFieldProbeValue);
  bindButtonAction(document.getElementById("outline-probe-floor"), probeFloor);
  bindButtonAction(document.getElementById("outline-export-obj"), exportHeightOBJ);
  bindButtonAction(document.getElementById("outline-export-height"), exportHeightImage);
  bindButtonAction(document.getElementById("probe-confirm-close"), () => settleProbeConfirmation(false));
  bindButtonAction(document.getElementById("probe-confirm-cancel"), () => settleProbeConfirmation(false));
  bindButtonAction(document.getElementById("probe-confirm-accept"), () => settleProbeConfirmation(true));
  document.getElementById("probe-confirm-modal").addEventListener("cancel", (e) => {
    e.preventDefault();
    settleProbeConfirmation(false);
  });
  bindButtonAction(document.getElementById("machine-settings-open"), openMachineSettings);
  bindButtonAction(document.getElementById("machine-settings-close"), closeMachineSettings);
  bindButtonAction(document.getElementById("machine-learn"), learnMachineParameters);

  bindButtonAction(document.getElementById("ctl-hold"), () => sendControl("hold"));
  bindButtonAction(document.getElementById("ctl-resume"), () => sendControl("resume"));
  bindButtonAction(document.getElementById("ctl-halt"), () => sendControl("halt"));
  bindButtonAction(document.getElementById("tool-set"), () => setCurrentTool());
  bindButtonAction(document.getElementById("tool-change-set"), () => changeTool());
  bindButtonAction(document.getElementById("tool-continue"), continueToolChange);
  bindButtonAction(document.getElementById("tool-calibrate"), calibrateCurrentTool);
  document.getElementById("tool-set-select").onchange = (e) => handleToolSelect("set", e.target.value);
  document.getElementById("tool-change-select").onchange = (e) => handleToolSelect("change", e.target.value);
  bindButtonAction(document.getElementById("active-gcode-run"), runActiveGcode);
  bindButtonAction(document.getElementById("active-gcode-pause"), () => runActiveJobControl("pause_job"));
  bindButtonAction(document.getElementById("active-gcode-resume"), () => runActiveJobControl("resume_job"));
  bindButtonAction(document.getElementById("feed-override-decrease"), () => adjustFeedOverride(-10));
  bindButtonAction(document.getElementById("feed-override-increase"), () => adjustFeedOverride(10));
  bindButtonAction(document.getElementById("feed-override-reset"), () => setFeedOverride(100));
  bindButtonAction(document.getElementById("paused-job-raise"), () => runPausedJobCommand("raise_z"));
  bindButtonAction(document.getElementById("paused-job-stop-spindle"), () => runPausedJobCommand("stop_spindle"));
  const gcodeSourceScroll = document.getElementById("active-gcode-source-scroll");
  const markGcodeSourceInteraction = () => {
    activeGcodeSource.userScrollingUntil = Date.now() + 2000;
  };
  gcodeSourceScroll.onscroll = scheduleActiveGcodeSourceRender;
  gcodeSourceScroll.onwheel = markGcodeSourceInteraction;
  gcodeSourceScroll.onpointerdown = markGcodeSourceInteraction;
  gcodeSourceScroll.ontouchstart = markGcodeSourceInteraction;
  gcodeSourceScroll.onkeydown = (e) => {
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(e.key)) {
      markGcodeSourceInteraction();
    }
  };
  if (globalThis.ResizeObserver) {
    activeGcodeSource.resizeObserver = new ResizeObserver(scheduleActiveGcodeSourceRender);
    activeGcodeSource.resizeObserver.observe(gcodeSourceScroll);
  }
  window.addEventListener("resize", () => setActiveJobSplitPercent(state.activeJobSplitPercent));
  window.addEventListener("resize", () => {
    if (!mobileWorkAreaJogEnabled() && state.workarea?.mobileJogActive) {
      if (releaseJogInput(true)) renderJog();
    }
  });
  const gcodeTimeline = document.getElementById("gcode-timeline");
  gcodeTimeline.onpointerdown = () => {
    gcodeView.timelineDragging = true;
    gcodeView.followLive = false;
    gcodeTimeline.dataset.dragging = "1";
  };
  const releaseGcodeTimeline = () => {
    gcodeView.cursor = Math.max(0, Math.min(gcodeView.segments.length, Number(gcodeTimeline.value) || 0));
    gcodeView.timelineDragging = false;
    clearControlDrafts(gcodeTimeline);
    updateGcodeProgress();
  };
  gcodeTimeline.onpointerup = releaseGcodeTimeline;
  gcodeTimeline.onpointercancel = releaseGcodeTimeline;
  gcodeTimeline.onblur = releaseGcodeTimeline;
  gcodeTimeline.onchange = releaseGcodeTimeline;
  gcodeTimeline.oninput = (e) => {
    gcodeView.followLive = false;
    gcodeView.cursor = Number(e.target.value) || 0;
    updateGcodeProgress();
  };
  bindDataControlButtons();
  initCommandPopouts();
  initializeSurfaceMobileOptions();
  window.matchMedia?.("(max-width: 600px)")?.addEventListener?.("change", (e) => initializeSurfaceMobileOptions(e.matches));
  window.matchMedia?.("(min-width: 1320px)")?.addEventListener?.("change", () => applyDashboardProfile(currentDashboardProfile()));
  bindButtonAction(document.getElementById("jog-arm"), toggleTapMoveArm);
  bindButtonAction(document.getElementById("surface-jog-arm"), toggleSurfaceMovementArm);
  document.getElementById("surface-jog-directional").onclick = () => selectSurfaceJogMethod("directional");
  document.getElementById("surface-jog-mpg").onclick = () => selectSurfaceJogMethod("mpg");
  document.getElementById("surface-jog-motion").onchange = (e) => {
    stopSurfaceHoldJog();
    state.surface.motion = e.target.value === "hold" ? "hold" : "step";
    saveSurfaceViewPreferences();
    renderSurfaceJog();
  };
  document.getElementById("surface-jog-step").onchange = (e) => {
    selectSurfaceStep(e.target.value);
  };
  for (const button of document.querySelectorAll("[data-surface-step]")) {
    button.onclick = () => selectSurfaceStep(button.dataset.surfaceStep);
  }
  for (const button of document.querySelectorAll("[data-surface-motion]")) {
    button.onclick = () => selectSurfaceMotion(button.dataset.surfaceMotion);
  }
  for (const button of document.querySelectorAll("[data-surface-view]")) {
    button.onclick = () => showTab(button.dataset.surfaceView);
  }
  for (const button of document.querySelectorAll("[data-surface-action]")) {
    button.onclick = () => runSurfaceShellAction(button.dataset.surfaceAction);
  }
  bindButtonAction(document.getElementById("surface-footer-hold"), () => sendControl("hold"));
  bindButtonAction(document.getElementById("surface-footer-resume"), () => {
    if (state.machine?.state === "Pause") runActiveJobControl("resume_job");
    else if (state.machine?.state === "Hold") sendControl("resume");
  });
  bindDashboardCameraSwitches();
  bindDashboardToolpathShortcut();
  bindButtonAction(document.getElementById("surface-footer-job"), () => showTab("active-job"));
  bindButtonAction(document.getElementById("surface-footer-vacuum"), () => {
    const current = dashboardOptionalNumber(state.machine?.spindle?.vacuum_mode);
    if (current !== null) setAutoVacuum(current === 0);
  });
  document.getElementById("surface-auto-switch").onchange = (e) => {
    state.surface.auto_switch = !!e.target.checked;
    saveSurfaceViewPreferences();
    applySurfaceAutomaticView();
  };
  document.getElementById("surface-start-view").onchange = (e) => {
    state.surface.start_view = ["jog", "active-job", "dashboard"].includes(e.target.value) ? e.target.value : "jog";
    saveSurfaceViewPreferences();
  };
  document.getElementById("surface-mpg-feedback").onchange = (e) => {
    state.surface.mpg_feedback = e.target.value === "detent" ? "detent" : "confirmed";
    saveSurfaceViewPreferences();
  };
  for (const button of document.querySelectorAll("[data-surface-axis]")) {
    bindSurfaceHoldButton(button, button.dataset.surfaceAxis, Number(button.dataset.surfaceSign), false);
  }
  for (const button of document.querySelectorAll("[data-surface-z-sign]")) {
    bindSurfaceHoldButton(button, "z", Number(button.dataset.surfaceZSign), false);
  }
  for (const button of document.querySelectorAll("[data-surface-hold-sign]")) {
    bindSurfaceHoldButton(button, "", Number(button.dataset.surfaceHoldSign), true);
  }
  for (const button of document.querySelectorAll(".surface-mpg-axis")) {
    button.onclick = () => selectSurfaceMPGAxis(button.dataset.surfaceMpgAxis);
  }
  bindSurfaceMPGWheel();
  bindSurfaceXYMap();
  document.getElementById("surface-jog-settings-open").onclick = () => document.getElementById("surface-settings-modal")?.showModal();
  document.getElementById("surface-settings-close").onclick = () => document.getElementById("surface-settings-modal")?.close();
  document.getElementById("surface-open-active-job").onclick = () => showTab("active-job");
  document.getElementById("attention-open-active-job").onclick = () => showTab("active-job");
  bindButtonAction(document.getElementById("attention-resume"), () => {
    const action = attentionResumeAction(String(state.machine?.state || ""));
    if (action === "resume_job") runActiveJobControl(action);
    else if (action === "resume") sendControl(action);
  });
  document.getElementById("attention-open-tool").onclick = () => {
    const menu = document.getElementById("tool-panel")?.closest(".command-popout");
    if (!menu) return;
    document.getElementById("command-actions")?.classList.add("mobile-menu-open");
    document.getElementById("mobile-actions-toggle")?.setAttribute("aria-expanded", "true");
    menu.open = true;
  };

  loadUISettings();
  loadAPICapabilities();
  loadDashboardCameras();
  loadActiveGcode();
  loadJogCapabilities();
  window.addEventListener("online", () => {
    loadJogCapabilities();
  });
  document.addEventListener("visibilitychange", () => {
    syncDashboardCameras();
    if (document.hidden) {
      state.jog.inputSuspended = true;
      if (releaseJogInput(true)) renderJog();
    } else {
      state.jog.inputSuspended = false;
      connectJog();
      scheduleJogSample();
    }
  });
  window.addEventListener("blur", () => {
    state.jog.inputSuspended = true;
    if (releaseJogInput(true)) renderJog();
  });
  window.addEventListener("focus", () => {
    state.jog.inputSuspended = false;
    connectJog();
    scheduleJogSample();
  });
  window.addEventListener("pagehide", () => {
    stopDashboardBuiltinCamera();
    stopDashboardExternalCamera();
    state.jog.inputSuspended = true;
    releaseJogInput(true);
  });
  window.addEventListener("gamepadconnected", (e) => {
    state.jog.preferredPadIndex = e.gamepad?.index ?? state.jog.preferredPadIndex;
    state.jog.error = "";
    connectJog();
    scheduleJogSample();
    renderJog();
  });
  window.addEventListener("gamepaddisconnected", (e) => {
    if (state.jog.preferredPadIndex === e.gamepad?.index) state.jog.preferredPadIndex = null;
    releaseJogInput(true);
    renderJog();
  });
  scheduleJogSample();
  renderFiles();
  renderJobs();
  connectControlSSE();
  pollMachine();
  setInterval(pollMachine, 3000);
}

document.addEventListener("DOMContentLoaded", init);
