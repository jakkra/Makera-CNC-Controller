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
