// Quick saved XY positions (A-D) for the Surface jog view. They are a
// per-device scratchpad for moving back and forth between a few spots, for
// example probing Z on both ends of a stock to check that it is level. Saving
// only reads the current machine position; going to a slot uses the ordinary
// tap move (safe Z first, then XY). Z is not stored or restored.

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
    out[slot] = x === null || y === null ? null : { x, y };
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

export function savedPositionLabel(position) {
  return position ? `X ${position.x.toFixed(1)} Y ${position.y.toFixed(1)}` : "Empty";
}

export function createSurfaceSavedPositions({
  documentRef = globalThis.document,
  storage = globalThis.localStorage,
  getMachinePosition = () => null,
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
    for (const button of documentRef?.querySelectorAll?.("[data-surface-position]") || []) {
      const slot = button.dataset.surfacePosition;
      const position = positions[slot] || null;
      const detail = button.querySelector?.("small");
      if (detail) detail.textContent = saving ? "Save here" : (position ? `X ${position.x.toFixed(1)}
Y ${position.y.toFixed(1)}` : "Empty");
      button.classList?.toggle("is-empty", !position);
      button.setAttribute("aria-label", saving
        ? `Save current position as ${slot}`
        : (position ? `Go to position ${slot}, ${savedPositionLabel(position)}` : `Position ${slot} is empty`));
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
    saving = false;
    if (x === null || y === null) {
      setStatusMessage("surface-positions", "Current machine position is unavailable.", "error", { force: true });
    } else {
      positions = { ...positions, [slot]: { x, y } };
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
    sendTapMove({ x: position.x, y: position.y }, `position ${slot}`);
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
