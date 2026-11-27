// The Surface on-screen keyboard covers the lower half of the screen without
// resizing the page. While a text or number field in a dialog has focus, move
// the dialog to the top half and keep the field in view.
const TYPED = "input:not([type=checkbox]):not([type=radio]):not([type=range]), textarea";

export function keepFieldsAboveKeyboard(dialog, { setTimeoutRef = globalThis.setTimeout } = {}) {
  if (!dialog) return;
  dialog.addEventListener("focusin", (event) => {
    if (!event.target?.matches?.(TYPED)) return;
    dialog.classList.add("keyboard-open");
    setTimeoutRef(() => event.target.scrollIntoView?.({ block: "center" }), 250);
  });
  dialog.addEventListener("focusout", () => {
    setTimeoutRef(() => {
      const active = dialog.ownerDocument?.activeElement;
      if (!active || !dialog.contains(active) || !active.matches?.(TYPED)) dialog.classList.remove("keyboard-open");
    }, 200);
  });
  dialog.addEventListener("close", () => dialog.classList.remove("keyboard-open"));
}
