export function setSoftDisabled(el, disabled) {
  if (!el) return;
  if (disabled) el.setAttribute("aria-disabled", "true");
  else el.removeAttribute("aria-disabled");
}

export function setTextIfChanged(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

export function setElementBusy(el, busy) {
  if (!el) return;
  if (busy) el.setAttribute("aria-busy", "true");
  else el.removeAttribute("aria-busy");
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>\"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

const actionPresses = new WeakMap();
const actionSuppressClicks = new WeakMap();

export function bindButtonAction(el, handler, {
  documentRef = globalThis.document,
  performanceRef = globalThis.performance,
} = {}) {
  if (!el || el.dataset.actionBound === "true") return;
  el.dataset.actionBound = "true";
  el.addEventListener("pointerdown", (event) => {
    if (typeof event.button === "number" && event.button !== 0) return;
    if (el.disabled) return;
    actionPresses.set(el, { pointerId: event.pointerId, x: event.clientX, y: event.clientY });
    try {
      el.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is best-effort; the click fallback remains in place.
    }
  });
  el.addEventListener("pointerup", (event) => {
    const press = actionPresses.get(el);
    if (!press || press.pointerId !== event.pointerId) return;
    actionPresses.delete(el);
    if (el.disabled) return;
    const dx = Math.abs(event.clientX - press.x);
    const dy = Math.abs(event.clientY - press.y);
    const releaseTarget = documentRef.elementFromPoint(event.clientX, event.clientY);
    if (dx > 12 || dy > 12 || (releaseTarget && !el.contains(releaseTarget))) return;
    actionSuppressClicks.set(el, performanceRef.now());
    event.preventDefault();
    handler(event);
  });
  el.addEventListener("pointercancel", (event) => {
    const press = actionPresses.get(el);
    if (press && press.pointerId === event.pointerId) actionPresses.delete(el);
  });
  el.addEventListener("click", (event) => {
    const last = actionSuppressClicks.get(el) || 0;
    if (performanceRef.now() - last < 700) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (el.disabled) return;
    handler(event);
  });
}
