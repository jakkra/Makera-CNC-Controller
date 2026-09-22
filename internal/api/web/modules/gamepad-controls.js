// Gamepad sampling and button actions, composed from the controller's shared state.
export function createGamepadControls({ state = {}, navigatorRef, documentRef, callbacks = {} } = {}) {
  const { clearControlDrafts, queueSaveUISettings, addOutlinePoint, macroByID, setNotice, clearNotice, runMacro } = callbacks;

  function currentGamepad() {
    if (!navigatorRef.getGamepads) return null;
    const pads = navigatorRef.getGamepads();
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
    const input = documentRef.getElementById("gamepad-outline-button");
    if (!input || documentRef.activeElement !== input) return false;
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

  function sameButtonStates(a, b) {
    a = Array.isArray(a) ? a : [];
    b = Array.isArray(b) ? b : [];
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!!a[i] !== !!b[i]) return false;
    }
    return true;
  }

  function clampAxis(v) {
    if (!Number.isFinite(v)) return 0;
    return Math.max(-1, Math.min(1, v));
  }

  return {
    currentGamepad,
    buttonPressed,
    buttonStates,
    mappedAxis,
    captureGamepadOutlineButton,
    handleGamepadOutlineButton,
    handleGamepadMacroButtons,
    sameButtonStates,
    clampAxis,
  };
}
