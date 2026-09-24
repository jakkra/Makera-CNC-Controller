// Machine-facing command helpers.  The module owns command sequencing and
// feedback, while the application supplies narrow state and rendering hooks.

export function setControlButtonsPending(action, pending, { documentRef = globalThis.document } = {}) {
  const ids = {
    hold: "ctl-hold",
    resume: "ctl-resume",
    halt: "ctl-halt",
  };
  const buttons = Array.from(documentRef.querySelectorAll("[data-control-action]"))
    .filter((btn) => btn.dataset.controlAction === action);
  const id = ids[action];
  if (id) {
    const btn = documentRef.getElementById(id);
    if (btn) buttons.push(btn);
  }
  for (const btn of buttons) {
    btn.disabled = pending;
  }
}

export function controlPendingText(action) {
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

export function controlSuccessText(action, result = null) {
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

export function controlErrorText(action, message) {
  return action + " failed: " + message;
}

export function confirmControl(action, confirmRef = globalThis.confirm) {
  switch (action) {
  case "recover":
    return confirmRef("Recover this alarm? Clear the physical cause first. For soft limits, the proxy will unlock and verify status; home before moving afterward.");
  case "unlock":
    return confirmRef("Unlock the alarm? Clear the physical cause first. Home the machine before moving afterward.");
  case "home":
    return confirmRef("Home the machine now? Make sure the work area is clear.");
  case "reset":
    return confirmRef("Reset the machine controller? Reconnect and home the machine afterward.");
  default:
    return true;
  }
}

export function createMachineCommands({
  documentRef = globalThis.document,
  request,
  disarmTapMoveForCommand = async () => {},
  appendGcodeLine = () => {},
  setStatusMessage = () => {},
  setNotice = () => {},
  renderMachine = () => {},
  pollMachine = () => {},
  getControlPendingAction = () => "",
  setControlPendingAction = () => {},
  getLastControlResult = () => null,
  setLastControlResult = () => {},
  setTimeoutRef = setTimeout,
  nowRef = Date.now,
} = {}) {
  async function sendGcode(line, opts = {}) {
    try {
      await disarmTapMoveForCommand();
      await request("/api/gcode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ line }),
      });
      return true;
    } catch (e) {
      appendGcodeLine({ seq: "local-" + nowRef(), dir: "recv", source: "api", text: "error: " + e.message });
      if (opts.feedback) {
        setStatusMessage("gcode-command", `Manual command failed: ${e.message}`, "error", { force: true });
      }
      return false;
    }
  }

  async function sendControl(action) {
    const noticeKey = "control-" + action;
    setControlPendingAction(action);
    if (action === "recover") setLastControlResult(null);
    setControlButtonsPending(action, true, { documentRef });
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
      if (result) setLastControlResult(result);
      setNotice(controlSuccessText(action, result), "ok", noticeKey);
      pollMachine();
      setTimeoutRef(pollMachine, 1200);
    } catch (e) {
      if (action === "recover") {
        setLastControlResult({ action, recovered: false, failed: true, message: e.message });
      }
      appendGcodeLine({ seq: "local-" + nowRef(), dir: "recv", source: "api", text: "error: " + e.message });
      setNotice(controlErrorText(action, e.message), "error", noticeKey);
    } finally {
      setControlPendingAction("");
      setControlButtonsPending(action, false, { documentRef });
      renderMachine();
    }
  }

  return {
    sendGcode,
    sendControl,
    setControlButtonsPending: (action, pending) => setControlButtonsPending(action, pending, { documentRef }),
    controlPendingText,
    controlSuccessText,
    controlErrorText,
    confirmControl,
    getControlPendingAction,
    getLastControlResult,
  };
}
