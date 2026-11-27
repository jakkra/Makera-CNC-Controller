// An on-page number pad for touch screens. The Surface's system keyboard has
// to be swiped up, which takes focus away from the field, so number fields in
// these dialogs open this pad instead. It lives inside the dialog so it works
// in the dialog's top layer, and writes back through normal input events.

// Pure editing rules, shared with the tests.
export function keypadPress(buffer, key, { allowNegative = true } = {}) {
  const value = String(buffer ?? "");
  if (key === "back") return value.slice(0, -1);
  if (key === "clear") return "";
  if (key === "sign") {
    if (!allowNegative) return value;
    return value.startsWith("-") ? value.slice(1) : "-" + value;
  }
  if (key === ".") {
    if (value.includes(".")) return value;
    return (value === "" || value === "-" ? value + "0" : value) + ".";
  }
  if (/^[0-9]$/.test(key)) {
    if (value === "0") return key;
    if (value === "-0") return "-" + key;
    return value.length >= 12 ? value : value + key;
  }
  return value;
}

const NUMBER_FIELD = "input[type=number]";

function fieldLabel(input) {
  const label = input.labels?.[0] || input.closest("label");
  const text = (label?.childNodes?.length ? [...label.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" ") : label?.textContent) || input.getAttribute("aria-label") || "";
  return text.replace(/\s+/g, " ").trim() || "Value";
}

export function attachNumericKeypad(dialog, { enabled = () => true } = {}) {
  if (!dialog || dialog.querySelector(".numeric-keypad")) return null;
  const document = dialog.ownerDocument;
  const pad = document.createElement("div");
  pad.className = "numeric-keypad";
  pad.hidden = true;
  pad.setAttribute("role", "group");
  pad.setAttribute("aria-label", "Number pad");
  pad.innerHTML = `
    <div class="numeric-keypad-display"><span class="numeric-keypad-label"></span><output class="numeric-keypad-value"></output></div>
    <div class="numeric-keypad-keys">
      ${["7", "8", "9", "4", "5", "6", "1", "2", "3"].map((k) => `<button type="button" data-key="${k}">${k}</button>`).join("")}
      <button type="button" data-key="sign" aria-label="Change sign">±</button>
      <button type="button" data-key="0">0</button>
      <button type="button" data-key="." aria-label="Decimal point">.</button>
      <button type="button" data-key="back" aria-label="Delete last digit">⌫</button>
      <button type="button" data-key="clear">Clear</button>
      <button type="button" data-key="cancel">Cancel</button>
      <button type="button" data-key="ok" class="primary">OK</button>
    </div>`;
  dialog.append(pad);
  const label = pad.querySelector(".numeric-keypad-label");
  const display = pad.querySelector(".numeric-keypad-value");
  let target = null;
  let buffer = "";

  function show() {
    display.textContent = buffer === "" ? " " : buffer;
  }

  function open(input) {
    if (target) target.classList.remove("keypad-target");
    target = input;
    buffer = input.value;
    label.textContent = fieldLabel(input);
    input.classList.add("keypad-target");
    pad.hidden = false;
    dialog.classList.add("keypad-open");
    show();
    input.scrollIntoView?.({ block: "nearest" });
  }

  function close() {
    target?.classList.remove("keypad-target");
    target = null;
    pad.hidden = true;
    dialog.classList.remove("keypad-open");
  }

  function commit() {
    const input = target;
    close();
    if (!input || input.value === buffer) return;
    input.value = buffer;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Number fields stay read-only on touch screens so the system keyboard
  // never opens; a tap opens the pad instead.
  function prepare() {
    const on = enabled();
    for (const input of dialog.querySelectorAll(NUMBER_FIELD)) {
      if (on) {
        input.readOnly = true;
        input.dataset.keypad = "true";
      } else if (input.dataset.keypad === "true") {
        input.readOnly = false;
        delete input.dataset.keypad;
      }
    }
  }

  dialog.addEventListener("click", (event) => {
    const input = event.target?.closest?.(NUMBER_FIELD);
    if (!input || !dialog.contains(input) || input.disabled || input.dataset.keypad !== "true") return;
    event.preventDefault();
    open(input);
  });
  pad.addEventListener("click", (event) => {
    const key = event.target?.closest?.("[data-key]")?.dataset.key;
    if (!key) return;
    event.preventDefault();
    if (key === "ok") return commit();
    if (key === "cancel") return close();
    buffer = keypadPress(buffer, key, { allowNegative: !(Number(target?.min) >= 0) });
    show();
  });
  dialog.addEventListener("close", close);
  // Fields can be added or shown later; check each time the dialog is used.
  dialog.addEventListener("pointerdown", prepare, true);
  prepare();
  return { open, close, prepare };
}
