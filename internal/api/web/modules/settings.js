// UI, machine and gamepad settings ownership.
//
// This module deliberately keeps the existing settings shape and DOM ids. It
// is a stateful factory so live settings refreshes can be routed through the
// same local-draft ownership checks as the monolith without replacing focused
// controls or changing the API payload.

export const MACHINE_SETTING_IDS = [
  "machine-x-min", "machine-x-max", "machine-y-min", "machine-y-max",
  "machine-origin-x", "machine-origin-y", "machine-feed-min", "machine-feed-max",
  "tap-feed-mm-min", "machine-safe-z",
];

export const DEFAULT_MACHINE_FEED_MIN_MM_MIN = 1;
export const DEFAULT_MACHINE_FEED_MAX_MM_MIN = 3000;
export const MAX_MACHINE_FEED_MM_MIN = 10000;
export const DEFAULT_SAFE_Z_MM = -3;
export const SAFE_Z_LIMIT_MARGIN_MM = 3;

export function finiteOr(value, fallback) {
  if (value === "" || value === null || typeof value === "undefined") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function clampNumber(n, min, max) {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

export function gamepadLabel(gp) {
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

export function isGenericGamepadID(id) {
  const s = String(id || "").trim().toLowerCase();
  return !s || s === "gamepad" || s === "unknown" || s === "standard" || s === "standard gamepad" || s.includes("unknown gamepad");
}

export function isXboxGamepad(gp) {
  if (isXboxGamepadID(gp?.id)) return true;
  const axes = gp?.axes?.length || 0;
  const buttons = gp?.buttons?.length || 0;
  return gp?.mapping === "standard" && axes >= 4 && buttons >= 12 && buttons <= 24;
}

export function isXboxGamepadID(id) {
  const s = String(id || "").toLowerCase();
  return /\bxbox\b/.test(s) || /\bxinput\b/.test(s) || s.includes("x-input") || s.includes("vendor: 045e") || s.includes("vid_045e");
}

function fallbackID(prefix) {
  if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function defaultGamepadSettings() {
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

export function defaultMachineSettings({
  feedMin = DEFAULT_MACHINE_FEED_MIN_MM_MIN,
  feedMax = DEFAULT_MACHINE_FEED_MAX_MM_MIN,
  safeZ = DEFAULT_SAFE_Z_MM,
} = {}) {
  return {
    work_area: { x_min: -302, x_max: -1, y_min: -212, y_max: -1 },
    origin: { x: 0, y: 0 },
    saved_origins: [],
    feed_min_mm_min: feedMin,
    feed_max_mm_min: feedMax,
    tap_feed_mm_min: 600,
    safe_z_mm: safeZ,
    safe_z_disabled: false,
    learned: {},
    learned_profiles: {},
  };
}

export function normalizeMachineLearned(learned) {
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

export function normalizeSavedOrigins(origins, newID = fallbackID) {
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
    out.push({ id, label, origin: { x, y }, created_at: saved.created_at || new Date().toISOString() });
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

export function normalizeGamepadSettings(gamepad, macroIDs = new Set(), newID = fallbackID) {
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

export function normalizeUISettings(ui, {
  newID = fallbackID,
  normalizeDashboardSettings = (settings) => settings || {},
} = {}) {
  ui = ui || {};
  const macrosIn = Array.isArray(ui.macros) ? ui.macros : [];
  const slotsIn = Array.isArray(ui.macro_buttons) ? ui.macro_buttons : [];
  const macros = [];
  const macroIDs = new Set();
  for (let i = 0; i < macrosIn.length; i++) {
    const m = macrosIn[i] || {};
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
    const s = slotsIn[i] || {};
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
    log: { filter: ui.log?.filter || "all", autoscroll: ui.log?.autoscroll !== false },
    gamepad: normalizeGamepadSettings(ui.gamepad, macroIDs, newID),
    machine: normalizeMachineSettings(ui.machine, { newID }),
    dashboard: normalizeDashboardSettings(ui.dashboard),
  };
}

export function normalizeMachineSettings(machine, {
  newID = fallbackID,
  defaultSettings = defaultMachineSettings,
  normalizeLearned = normalizeMachineLearned,
  feedMin = DEFAULT_MACHINE_FEED_MIN_MM_MIN,
  feedMax = DEFAULT_MACHINE_FEED_MAX_MM_MIN,
  maxFeed = MAX_MACHINE_FEED_MM_MIN,
  defaultSafeZ = DEFAULT_SAFE_Z_MM,
  safeZMargin = SAFE_Z_LIMIT_MARGIN_MM,
} = {}) {
  const d = defaultSettings({ feedMin, feedMax, safeZ: defaultSafeZ });
  machine = machine || {};
  const learned = normalizeLearned(machine.learned);
  const work = machine.work_area || {};
  const hasLearnedWorkArea = Number.isFinite(learned.work_area?.x_min) && Number.isFinite(learned.work_area?.x_max) &&
    Number.isFinite(learned.work_area?.y_min) && Number.isFinite(learned.work_area?.y_max);
  const oldNominalDefault = Number(work.x_min) === -300 && Number(work.x_max) === 0 && Number(work.y_min) === -200 && Number(work.y_max) === 0;
  const oldTravelDefault = Number(work.x_min) === -302 && Number(work.x_max) === 0 && Number(work.y_min) === -212 && Number(work.y_max) === 0;
  if (oldNominalDefault || oldTravelDefault) machine = { ...machine, work_area: hasLearnedWorkArea ? learned.work_area : d.work_area };
  const normalizedWork = machine.work_area || {};
  const out = {
    work_area: {
      x_min: finiteOr(normalizedWork.x_min, d.work_area.x_min), x_max: finiteOr(normalizedWork.x_max, d.work_area.x_max),
      y_min: finiteOr(normalizedWork.y_min, d.work_area.y_min), y_max: finiteOr(normalizedWork.y_max, d.work_area.y_max),
    },
    origin: { x: finiteOr(machine.origin?.x, d.origin.x), y: finiteOr(machine.origin?.y, d.origin.y) },
    saved_origins: normalizeSavedOrigins(machine.saved_origins, newID),
    feed_min_mm_min: finiteOr(machine.feed_min_mm_min, d.feed_min_mm_min),
    feed_max_mm_min: finiteOr(machine.feed_max_mm_min, d.feed_max_mm_min),
    tap_feed_mm_min: finiteOr(machine.tap_feed_mm_min, d.tap_feed_mm_min),
    safe_z_mm: finiteOr(machine.safe_z_mm, d.safe_z_mm),
    safe_z_disabled: !!machine.safe_z_disabled,
    learned,
    learned_profiles: Object.fromEntries(Object.entries(machine.learned_profiles || {}).map(([key, profile]) => [key, normalizeLearned(profile)])),
  };
  if (out.work_area.x_min >= out.work_area.x_max) { out.work_area.x_min = d.work_area.x_min; out.work_area.x_max = d.work_area.x_max; }
  if (out.work_area.y_min >= out.work_area.y_max) { out.work_area.y_min = d.work_area.y_min; out.work_area.y_max = d.work_area.y_max; }
  out.feed_min_mm_min = clampNumber(out.feed_min_mm_min, feedMin, maxFeed);
  out.feed_max_mm_min = clampNumber(out.feed_max_mm_min, out.feed_min_mm_min, maxFeed);
  const bounds = feedBoundsFor(out, { defaultSettings, feedMin, feedMax, maxFeed });
  out.tap_feed_mm_min = clampNumber(out.tap_feed_mm_min || d.tap_feed_mm_min, bounds.min, bounds.max);
  out.safe_z_mm = safeZForTapMove(out, { normalizeLearned, defaultSafeZ, safeZMargin });
  return out;
}

export function feedBoundsFor(machine, { defaultSettings = defaultMachineSettings, feedMin = DEFAULT_MACHINE_FEED_MIN_MM_MIN, feedMax = DEFAULT_MACHINE_FEED_MAX_MM_MIN, maxFeed = MAX_MACHINE_FEED_MM_MIN } = {}) {
  const d = defaultSettings({ feedMin, feedMax });
  const configuredMin = clampNumber(finiteOr(machine?.feed_min_mm_min, d.feed_min_mm_min), feedMin, maxFeed);
  const configuredMax = clampNumber(finiteOr(machine?.feed_max_mm_min, d.feed_max_mm_min), configuredMin, maxFeed);
  return { min: configuredMin, max: configuredMax, configuredMin, configuredMax };
}

export function safeZForTapMove(machine, { normalizeLearned = normalizeMachineLearned, defaultSafeZ = DEFAULT_SAFE_Z_MM, safeZMargin = SAFE_Z_LIMIT_MARGIN_MM } = {}) {
  const safeZ = finiteOr(machine?.safe_z_mm, defaultSafeZ);
  return Math.min(safeZ, safeZCeiling(machine, { normalizeLearned, defaultSafeZ, safeZMargin }));
}

export function safeZCeiling(machine, { normalizeLearned = normalizeMachineLearned, defaultSafeZ = DEFAULT_SAFE_Z_MM, safeZMargin = SAFE_Z_LIMIT_MARGIN_MM } = {}) {
  const learned = normalizeLearned(machine?.learned);
  const zMin = finiteOr(learned.z_min_mm, NaN);
  const zMax = finiteOr(learned.z_max_mm, NaN);
  const clearance = finiteOr(learned.config_numbers?.["coordinate.clearance_z"], NaN);
  let ceiling = defaultSafeZ;
  if (Number.isFinite(clearance)) ceiling = Math.min(ceiling, clearance);
  if (Number.isFinite(zMin) && Number.isFinite(zMax) && zMax - zMin > 2 * safeZMargin) ceiling = Math.min(ceiling, zMax - safeZMargin);
  return ceiling;
}

export function machineLearnedSummaryLines(learned, { normalizeLearned = normalizeMachineLearned, fmtCoord = (value) => String(value) } = {}) {
  learned = normalizeLearned(learned);
  const lines = [];
  const id = learned.identity || {};
  const identity = [id.model, id.version, id.file_type].filter(Boolean).join(" / ");
  if (identity) lines.push(identity);
  const area = learned.work_area || {};
  if (Number.isFinite(area.x_min) && Number.isFinite(area.x_max) && Number.isFinite(area.y_min) && Number.isFinite(area.y_max)) lines.push(`travel X ${fmtCoord(area.x_min)}..${fmtCoord(area.x_max)}  Y ${fmtCoord(area.y_min)}..${fmtCoord(area.y_max)}`);
  const zMin = finiteOr(learned.z_min_mm, NaN); const zMax = finiteOr(learned.z_max_mm, NaN);
  if (Number.isFinite(zMin) || Number.isFinite(zMax)) lines.push(`Z ${fmtCoord(zMin)}..${fmtCoord(zMax)}`);
  const feed = learned.feed || {}; const maxXY = finiteOr(feed.max_xy_mm_min, NaN); const seek = finiteOr(feed.seek_mm_min, NaN);
  if (Number.isFinite(maxXY)) lines.push(`XY max feed ${Math.round(maxXY)} mm/min`); else if (Number.isFinite(seek)) lines.push(`seek feed ${Math.round(seek)} mm/min`);
  const configCount = Object.keys(learned.config || {}).length; const diagCount = Object.keys(learned.diagnostics || {}).length;
  const anchors = learned.anchors || {};
  if (anchors.available) lines.push(`Anchor 1 ${fmtCoord(anchors.anchor1?.x)}, ${fmtCoord(anchors.anchor1?.y)}  Anchor 2 ${fmtCoord(anchors.anchor2?.x)}, ${fmtCoord(anchors.anchor2?.y)}`);
  if (configCount || diagCount) lines.push(`${configCount} config values, ${diagCount} diagnostic groups`);
  return lines;
}

export function createSettingsFeature({
  documentRef = globalThis.document,
  getUI = () => ({}), setUI = () => {},
  getSelectedMacroId = () => "", getMachineLearnPending = () => false, setMachineLearnPending = () => {},
  getSettingsSaveTimer = () => null, setSettingsSaveTimer = () => {},
  request = async () => { throw new Error("request is not configured"); },
  applyUISettings = null, queueSaveUISettings = null,
  renderMacroButtons = () => {}, renderMacroEditor = () => {}, renderJog = () => {}, renderGcodeLog = () => {}, renderWorkArea = () => {}, resolveDashboardProfile = () => {},
  clearConnectivityIssue = () => {}, setConnectivityIssue = () => {},
  setStatusMessage = () => {}, setNotice = () => {}, clearNotice = () => {},
  setTapFeedback = () => {},
  renderMachineLearnedSummary: renderLearnedSummary = null,
  confirmRef = (message) => globalThis.confirm?.(message),
  fmtCoord = (value) => String(value), newID = fallbackID,
  normalizeDashboardSettings = (settings) => settings || {},
  macroByID = (id) => (getUI()?.macros || []).find((macro) => macro.id === id),
  renderMachineSettingsExternal = null,
  machineSettingIDs = MACHINE_SETTING_IDS,
} = {}) {
  const document = documentRef;
  const local = {
    get ui() { return getUI() || {}; },
    get machineLearnPending() { return !!getMachineLearnPending(); },
  };
  const normalizeMachine = (machine) => normalizeMachineSettings(machine, { newID });
  const normalizeGamepad = (gamepad, macroIDs) => normalizeGamepadSettings(gamepad, macroIDs, newID);

  function controlLocallyOwned(el) { return !el || el === document?.activeElement || el.dataset?.dirty === "1" || el.dataset?.dragging === "1"; }
  function markControlDirty(el) { if (el) el.dataset.dirty = "1"; }
  function clearControlDrafts(...items) {
    for (const item of items.flat()) {
      const el = typeof item === "string" ? document?.getElementById(item) : item;
      if (!el) continue;
      if (el.dataset) {
        delete el.dataset.dirty;
        delete el.dataset.dragging;
      }
      el.setCustomValidity?.("");
    }
  }
  function setInputValue(id, value) { const el = document?.getElementById(id); if (controlLocallyOwned(el)) return; el.value = Number.isFinite(value) ? String(value) : ""; }
  function setControlValueIfIdle(id, value) { const el = document?.getElementById(id); if (controlLocallyOwned(el)) return; el.value = value == null ? "" : String(value); }
  function setCheckedIfIdle(id, checked) { const el = document?.getElementById(id); if (controlLocallyOwned(el)) return; el.checked = !!checked; }
  function bindDirtyDraftControls(ids) { for (const id of ids) { const el = document?.getElementById(id); if (!el) continue; el.addEventListener("input", () => markControlDirty(el)); el.addEventListener("change", () => markControlDirty(el)); } }
  function bindMachineSettingsInteractions({ updateMachineSettings: updateMachineSettingsHandler = updateMachineSettings } = {}) {
    bindDirtyDraftControls(machineSettingIDs);
    for (const id of machineSettingIDs) document.getElementById(id).onchange = updateMachineSettingsHandler;
  }

  function renderMachineLearnedSummary(learned) {
    const box = document?.getElementById("machine-learned-summary");
    if (!box) return;
    box.innerHTML = "";
    for (const line of machineLearnedSummaryLines(learned, { fmtCoord })) { const div = document.createElement("div"); div.textContent = line; box.appendChild(div); }
  }
  function renderMachineSettings() {
    if (renderMachineSettingsExternal) return renderMachineSettingsExternal();
    const m = local.ui.machine || defaultMachineSettings();
    setInputValue("machine-x-min", m.work_area.x_min); setInputValue("machine-x-max", m.work_area.x_max);
    setInputValue("machine-y-min", m.work_area.y_min); setInputValue("machine-y-max", m.work_area.y_max);
    setInputValue("machine-origin-x", m.origin.x); setInputValue("machine-origin-y", m.origin.y);
    setInputValue("machine-feed-min", m.feed_min_mm_min); setInputValue("machine-feed-max", m.feed_max_mm_min);
    setInputValue("tap-feed-mm-min", m.tap_feed_mm_min); setInputValue("machine-safe-z", m.safe_z_mm);
    const safeToggle = document?.getElementById("tap-safe-z-enabled"); if (safeToggle && safeToggle !== document.activeElement) safeToggle.checked = !m.safe_z_disabled;
    const learn = document?.getElementById("machine-learn");
    if (learn) { learn.disabled = local.machineLearnPending; learn.setAttribute("aria-busy", local.machineLearnPending ? "true" : "false"); setTextIfChanged(learn, local.machineLearnPending ? "Learning..." : "Learn from machine"); }
    renderMachineLearnedSummary(m.learned);
  }
  function setTextIfChanged(el, value) { if (el && el.textContent !== String(value)) el.textContent = String(value); }

  async function refreshMachineLearnedSettings() {
    try {
      const r = await request("/api/ui/settings");
      const incoming = normalizeMachine((await r.json()).machine); const current = normalizeMachine(local.ui.machine);
      const incomingLearnedAt = Date.parse(incoming.learned?.learned_at || ""); const currentLearnedAt = Date.parse(current.learned?.learned_at || "");
      if (Number.isFinite(currentLearnedAt) && (!Number.isFinite(incomingLearnedAt) || incomingLearnedAt < currentLearnedAt)) return;
      setUI({ ...local.ui, machine: { ...current, learned: incoming.learned, learned_profiles: incoming.learned_profiles } });
      renderMachineSettings(); renderJog();
    } catch { /* normal connection surfaces report outages */ }
  }
  async function learnMachineParameters() {
    if (local.machineLearnPending) return;
    const timer = getSettingsSaveTimer(); if (timer) { clearTimeout(timer); setSettingsSaveTimer(null); }
    setMachineLearnPending(true); setStatusMessage("machine-learn", "Learning machine parameters...", "info", { timeoutMs: 0, force: true });
    try {
      renderMachineSettings(); const r = await request("/api/machine/learn", { method: "POST" }); const result = await r.json();
      setMachineLearnPending(false); if (result.ui && applyUISettings) applyUISettings(result.ui);
      setStatusMessage("machine-learn", result.message || "Learned machine parameters from firmware.", "ok", { force: true }); renderMachineSettings(); renderJog();
    } catch (e) { setStatusMessage("machine-learn", "Learning machine parameters failed: " + e.message, "error", { force: true }); renderMachineSettings(); }
    finally { setMachineLearnPending(false); renderMachineSettings(); }
  }
  function openMachineSettings() { const dialog = document?.getElementById("machine-settings-modal"); if (!dialog || dialog.open) return; renderMachineSettings(); dialog.showModal(); refreshMachineLearnedSettings(); }
  function closeMachineSettings() { document?.getElementById("machine-settings-modal")?.close(); }

  function updateMachineSettings() {
    const current = local.ui.machine || defaultMachineSettings(); const values = {}; let valid = true;
    const read = (id) => { const el = document?.getElementById(id); const raw = String(el?.value ?? "").trim(); const value = Number(raw); const ok = raw !== "" && Number.isFinite(value); if (el) el.setCustomValidity(ok ? "" : "Enter a number."); return { ok, value }; };
    for (const id of machineSettingIDs) { const result = read(id); values[id] = result.value; if (!result.ok) valid = false; }
    if (!valid) { for (const id of machineSettingIDs) { const el = document?.getElementById(id); if (el?.validationMessage) { el.reportValidity?.(); break; } } return; }
    setUI({ ...local.ui, machine: normalizeMachine({ work_area: { x_min: values["machine-x-min"], x_max: values["machine-x-max"], y_min: values["machine-y-min"], y_max: values["machine-y-max"] }, origin: { x: values["machine-origin-x"], y: values["machine-origin-y"] }, saved_origins: current.saved_origins || [], feed_min_mm_min: values["machine-feed-min"], feed_max_mm_min: values["machine-feed-max"], tap_feed_mm_min: values["tap-feed-mm-min"], safe_z_mm: values["machine-safe-z"], safe_z_disabled: !!current.safe_z_disabled, learned: current.learned || {}, learned_profiles: current.learned_profiles || {} }) });
    clearControlDrafts(machineSettingIDs); (queueSaveUISettings || (() => {}))(); renderMachineSettings(); renderWorkArea();
  }
  function stepTapFeed(delta) { const input = document?.getElementById("tap-feed-mm-min"); if (!input || input.disabled) return; const current = local.ui.machine || defaultMachineSettings(); const bounds = feedBoundsFor(current); const next = clampNumber(finiteOr(input.value, current.tap_feed_mm_min) + delta, bounds.min, bounds.max); input.value = String(Math.round(next)); updateMachineSettings(); renderJog(); }
  function updateSafeZToggle() { const current = local.ui.machine || defaultMachineSettings(); const nextEnabled = !!document?.getElementById("tap-safe-z-enabled")?.checked; if (!nextEnabled && !confirmRef("Disable safe Z before click-jog XY moves?")) { renderMachineSettings(); return; } setUI({ ...local.ui, machine: normalizeMachine({ ...current, safe_z_disabled: !nextEnabled }) }); setTapFeedback(nextEnabled ? "Safe Z before click-jog enabled." : "Safe Z before click-jog disabled.", nextEnabled ? "ok" : ""); (queueSaveUISettings || (() => {}))(); renderMachineSettings(); renderJog(); }

  function renderGamepadSettings() {
    const gp = local.ui.gamepad || defaultGamepadSettings();
    for (const axis of ["x", "y", "z"]) { const cfg = gp.axes[axis]; const pct = Math.round(cfg.scale * 100); setControlValueIfIdle("gamepad-axis-" + axis, cfg.axis); setCheckedIfIdle("gamepad-invert-" + axis, cfg.invert); setControlValueIfIdle("gamepad-speed-" + axis, pct); setTextIfChanged(document?.getElementById("gamepad-speed-" + axis + "-value"), pct + "%"); }
    setControlValueIfIdle("gamepad-deadman-button", gp.deadman_button); setControlValueIfIdle("gamepad-slow-button-0", gp.slow_buttons[0] ?? ""); setControlValueIfIdle("gamepad-slow-button-1", gp.slow_buttons[1] ?? ""); setControlValueIfIdle("gamepad-outline-button", gp.outline_button); renderGamepadMacroBindings();
  }
  function gamepadMacroBindingsLocallyOwned(box = document?.getElementById("gamepad-macro-bindings")) { return !!box && (box.contains?.(document?.activeElement) || !!local.ui.gamepadMacroBindingDirty); }
  function normalizeGamepadMacroOrder() { const ui = local.ui; const bindings = [...(ui.gamepad?.macro_buttons || [])].sort((a, b) => a.button - b.button); const seen = new Set(); ui.gamepad.macro_buttons = bindings.filter((binding) => { if (seen.has(binding.button) || !macroByID(binding.macro_id)) return false; seen.add(binding.button); return true; }); }
  function readInt(value, fallback, min, max) { const n = Number(value); if (!Number.isInteger(n)) return fallback; return Math.max(min, Math.min(max, n)); }
  function renderGamepadMacroBindings(opts = {}) {
    const box = document?.getElementById("gamepad-macro-bindings"); if (!box || (!opts.force && gamepadMacroBindingsLocallyOwned(box))) return;
    local.ui.gamepadMacroBindingDirty = false; box.innerHTML = "";
    if (!local.ui.gamepad?.macro_buttons?.length) { box.innerHTML = `<div class="empty compact">No gamepad macro buttons.</div>`; return; }
    for (const binding of local.ui.gamepad.macro_buttons) {
      const row = document.createElement("div"); row.className = "gamepad-binding";
      const button = document.createElement("input"); button.type = "number"; button.min = "0"; button.max = "63"; button.value = String(binding.button);
      button.oninput = () => { local.ui.gamepadMacroBindingDirty = true; markControlDirty(button); }; button.onfocus = () => { local.ui.gamepadMacroBindingDirty = true; }; button.onblur = () => { if (button.dataset.dirty !== "1") local.ui.gamepadMacroBindingDirty = false; };
      button.onchange = () => { binding.button = readInt(button.value, binding.button, 0, 63); clearControlDrafts(button); local.ui.gamepadMacroBindingDirty = false; normalizeGamepadMacroOrder(); renderGamepadMacroBindings({ force: true }); (queueSaveUISettings || (() => {}))(); };
      const select = document.createElement("select"); for (const macro of local.ui.macros || []) { const option = document.createElement("option"); option.value = macro.id; option.textContent = macro.name; option.selected = macro.id === binding.macro_id; select.appendChild(option); }
      select.onfocus = () => { local.ui.gamepadMacroBindingDirty = true; }; select.onblur = () => { local.ui.gamepadMacroBindingDirty = false; }; select.onchange = () => { binding.macro_id = select.value; local.ui.gamepadMacroBindingDirty = false; (queueSaveUISettings || (() => {}))(); };
      const del = document.createElement("button"); del.type = "button"; del.textContent = "Remove"; del.onclick = () => { local.ui.gamepad.macro_buttons = local.ui.gamepad.macro_buttons.filter((b) => b.id !== binding.id); local.ui.gamepadMacroBindingDirty = false; renderGamepadMacroBindings({ force: true }); (queueSaveUISettings || (() => {}))(); };
      row.append(button, select, del); box.appendChild(row);
    }
  }
  function updateGamepadAxis(axis) { const cfg = local.ui.gamepad.axes[axis]; cfg.axis = readInt(document.getElementById("gamepad-axis-" + axis).value, cfg.axis, 0, 31); cfg.invert = document.getElementById("gamepad-invert-" + axis).checked; cfg.scale = Math.max(0.05, Math.min(1, Number(document.getElementById("gamepad-speed-" + axis).value) / 100 || cfg.scale)); setTextIfChanged(document.getElementById("gamepad-speed-" + axis + "-value"), Math.round(cfg.scale * 100) + "%"); (queueSaveUISettings || (() => {}))(); }
  function updateGamepadButtons() { const gp = local.ui.gamepad; gp.deadman_button = readInt(document.getElementById("gamepad-deadman-button").value, gp.deadman_button, 0, 63); gp.slow_buttons = [document.getElementById("gamepad-slow-button-0").value, document.getElementById("gamepad-slow-button-1").value].filter((v) => v !== "").map((v) => readInt(v, 0, 0, 63)); gp.outline_button = readInt(document.getElementById("gamepad-outline-button").value, gp.outline_button, 0, 63); (queueSaveUISettings || (() => {}))(); }
  function addGamepadMacroBinding() { const macro = macroByID(getSelectedMacroId()) || local.ui.macros?.[0]; if (!macro) { setNotice("Create a macro before assigning a gamepad button.", "error", "gamepad-macro-binding"); return; } const used = new Set(local.ui.gamepad.macro_buttons.map((b) => b.button)); let button = 1; while (used.has(button) && button < 64) button++; local.ui.gamepad.macro_buttons.push({ id: newID("gamepad-macro"), button, macro_id: macro.id }); normalizeGamepadMacroOrder(); renderGamepadMacroBindings({ force: true }); clearNotice("gamepad-macro-binding"); (queueSaveUISettings || (() => {}))(); }

  return { defaultGamepadSettings, defaultMachineSettings, normalizeMachineLearned, normalizeSavedOrigins, normalizeGamepadSettings: normalizeGamepad, normalizeMachineSettings: normalizeMachine, normalizeUISettings: (ui, opts = {}) => normalizeUISettings(ui, { ...opts, newID }), feedBoundsFor, safeZForTapMove, safeZCeiling, machineLearnedSummaryLines, controlLocallyOwned, markControlDirty, clearControlDrafts, setInputValue, setControlValueIfIdle, setCheckedIfIdle, bindDirtyDraftControls, bindMachineSettingsInteractions, renderMachineLearnedSummary, renderMachineSettings, refreshMachineLearnedSettings, learnMachineParameters, openMachineSettings, closeMachineSettings, updateMachineSettings, stepTapFeed, updateSafeZToggle, renderGamepadSettings, renderGamepadMacroBindings, gamepadMacroBindingsLocallyOwned, updateGamepadAxis, updateGamepadButtons, addGamepadMacroBinding, normalizeGamepadMacroOrder };
}
