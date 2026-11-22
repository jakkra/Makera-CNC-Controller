// Quick saved machine positions (A-D) for the Surface jog view. They are a
// per-device scratchpad for moving back and forth between a few spots, for
// example probing Z on both ends of a stock to check that it is level. Saving
// only reads the current machine position; going to a slot uses the ordinary
// tap move with a clearance lift, optional Y retract and optional final Z.

export const SAVED_POSITION_SLOTS = Object.freeze(["A", "B", "C", "D"]);
export const SAVED_POSITIONS_KEY = "cnc-proxy.surface-saved-positions.v1";

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function normalizeSavedPositions(raw) {
  const out = {};
  for (const slot of SAVED_POSITION_SLOTS) {
    const x = finite(raw?.[slot]?.x);
    const y = finite(raw?.[slot]?.y);
    const z = finite(raw?.[slot]?.z);
    const tool = finite(raw?.[slot]?.tool);
    out[slot] = x === null ? null : {
      x, ...(y === null ? {} : { y }), ...(z === null ? {} : { z }), ...(tool === null ? {} : { tool }),
    };
  }
  return out;
}

export function loadSavedPositions(storage = globalThis.localStorage, key = SAVED_POSITIONS_KEY) {
  try {
    const raw = storage?.getItem?.(key);
    return normalizeSavedPositions(raw ? JSON.parse(raw) : {});
  } catch {
    return normalizeSavedPositions({});
  }
}

export function storeSavedPositions(positions, storage = globalThis.localStorage, key = SAVED_POSITIONS_KEY) {
  try {
    storage?.setItem?.(key, JSON.stringify(normalizeSavedPositions(positions)));
    return true;
  } catch {
    return false;
  }
}

export function savedPositionLabel(position, includeZ = true) {
  if (!position) return "Empty";
  const coordinates = [`X ${position.x.toFixed(1)}`];
  if (Number.isFinite(position.y)) coordinates.push(`Y ${position.y.toFixed(1)}`);
  if (includeZ && Number.isFinite(position.z)) coordinates.push(`Z ${position.z.toFixed(1)}`);
  return coordinates.join(" ");
}

export function createSurfaceSavedPositions({
  documentRef = globalThis.document,
  storage = globalThis.localStorage,
  getMachinePosition = () => null,
  getRecallOptions = () => ({ includeZ: false, retractMM: 0 }),
  // Active tool number from fresh machine status, or null when unknown. Saved Z
  // is a machine coordinate, so it is only replayed with the same tool fitted.
  getActiveTool = () => null,
  sendTapMove = () => {},
  setStatusMessage = () => {},
  renderJog = () => {},
} = {}) {
  let positions = loadSavedPositions(storage);
  let saving = false;

  function container() {
    return documentRef?.getElementById?.("surface-positions");
  }

  function render() {
    const root = container();
    root?.classList?.toggle("is-saving", saving);
    const toggle = documentRef?.getElementById?.("surface-positions-save");
    if (toggle) {
      toggle.setAttribute("aria-pressed", String(saving));
      toggle.textContent = saving ? "Cancel" : "Save current…";
    }
    const { includeZ } = getRecallOptions();
    for (const button of documentRef?.querySelectorAll?.("[data-surface-position]") || []) {
      const slot = button.dataset.surfacePosition;
      const position = positions[slot] || null;
      const detail = button.querySelector?.("small");
      const label = savedPositionLabel(position, includeZ);
      if (detail) detail.textContent = saving ? "Save here" : label.replace(/ ([YZ]) /g, "\n$1 ");
      button.classList?.toggle("is-empty", !position);
      button.setAttribute("aria-label", saving
        ? `Save current position as ${slot}`
        : (position ? `Go to position ${slot}, ${label}` : `Position ${slot} is empty`));
      if (saving) {
        button.disabled = false;
        button.removeAttribute("aria-disabled");
      }
    }
  }

  function toggleSaving() {
    saving = !saving;
    render();
    renderJog();
  }

  function saveSlot(slot) {
    const mpos = getMachinePosition();
    const x = finite(mpos?.x);
    const y = finite(mpos?.y);
    const z = finite(mpos?.z);
    const tool = finite(getActiveTool());
    saving = false;
    if (x === null || y === null || z === null) {
      setStatusMessage("surface-positions", "Current machine position is unavailable.", "error", { force: true });
    } else {
      positions = { ...positions, [slot]: { x, y, z, ...(tool === null ? {} : { tool }) } };
      const stored = storeSavedPositions(positions, storage);
      setStatusMessage("surface-positions", stored
        ? `Saved position ${slot} at ${savedPositionLabel(positions[slot])}.`
        : `Saved position ${slot} for this session only; this browser cannot store it.`, stored ? "ok" : "", { force: true });
    }
    render();
    renderJog();
  }

  function goToSlot(slot) {
    const position = positions[slot];
    if (!position) {
      setStatusMessage("surface-positions", `Position ${slot} is empty. Use Save current… first.`, "error", { force: true });
      return false;
    }
    const { includeZ, retractMM } = getRecallOptions();
    const missingAxis = !Number.isFinite(position.y) ? "Y" : (includeZ && !Number.isFinite(position.z) ? "Z" : "");
    if (missingAxis) {
      setStatusMessage("surface-positions", `Position ${slot} has no saved ${missingAxis}. Save the position again to record it.`, "error", { force: true });
      return false;
    }
    if (includeZ) {
      const tool = finite(getActiveTool());
      if (!Number.isFinite(position.tool) || tool === null || tool !== position.tool) {
        const saved = Number.isFinite(position.tool) ? `T${position.tool}` : "an unrecorded tool";
        const current = tool === null ? "an unknown tool" : `T${tool}`;
        setStatusMessage("surface-positions", `Position ${slot} Z was saved with ${saved}, but the machine reports ${current}. ` +
          "Re-save the position or turn off Move to saved Z.", "error", { force: true });
        return false;
      }
    }
    const target = { x: position.x, y: position.y };
    if (includeZ) target.z = position.z;
    sendTapMove(target, `position ${slot}`, {
      requireSafeZ: true,
      fastSafeZ: true,
      yRetractMM: retractMM,
    });
    return true;
  }

  function selectSlot(slot) {
    if (!SAVED_POSITION_SLOTS.includes(slot)) return false;
    if (saving) {
      saveSlot(slot);
      return true;
    }
    return goToSlot(slot);
  }

  function bind(bindButtonAction) {
    bindButtonAction(documentRef.getElementById("surface-positions-save"), toggleSaving);
    for (const button of documentRef.querySelectorAll("[data-surface-position]")) {
      bindButtonAction(button, () => selectSlot(button.dataset.surfacePosition));
    }
    render();
  }

  return { bind, render, selectSlot, toggleSaving, positions: () => ({ ...positions }), isSaving: () => saving };
}
