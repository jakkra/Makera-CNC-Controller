const MACRO_EDITOR_IDS = ["macro-name", "macro-description", "macro-color", "macro-lines", "macro-placement"];

export function createMdiMacros({
  documentRef = document, getUI, setUI = () => {}, newID, escapeHtml, bindButtonAction,
  clearControlDrafts, setControlValueIfIdle, setSoftDisabled, setNotice, clearNotice,
  queueSaveUISettings, renderGamepadSettings, confirmRef = (message) => confirm(message),
  sendGcode, rememberCommand, setStatusMessage, getSelectedMacroId = () => "", setSelectedMacroId = () => {},
  getMacroRunning = () => false, setMacroRunning = () => {}, getGcodePending = () => false,
  setGcodePending = () => {}, getCommandHistory = () => [], getHistoryIndex = () => -1, setHistoryIndex = () => {},
} = {}) {
  const document = documentRef;
  const confirm = confirmRef;
  const state = {
    get ui() { return getUI(); }, get selectedMacroId() { return getSelectedMacroId(); }, set selectedMacroId(value) { setSelectedMacroId(value); },
    get macroRunning() { return getMacroRunning(); }, set macroRunning(value) { setMacroRunning(value); }, get gcodePending() { return getGcodePending(); }, set gcodePending(value) { setGcodePending(value); },
    get commandHistory() { return getCommandHistory(); }, get historyIndex() { return getHistoryIndex(); }, set historyIndex(value) { setHistoryIndex(value); },
  };function macroByID(id) {
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

function renderGcodeCommandState() {
  const form = document.getElementById("gcode-form");
  const input = document.getElementById("gcode-input");
  const submit = form?.querySelector('button[type="submit"]');
  form?.setAttribute("aria-busy", String(state.gcodePending));
  if (input) input.disabled = state.gcodePending;
  if (submit) submit.disabled = state.gcodePending;
}

async function submitGcode(line) {
  line = String(line || "").trim();
  if (!line) return;
  if (state.gcodePending) {
    setStatusMessage("gcode-command", "Another manual command is still in progress.", "error", { force: true });
    return false;
  }
  rememberCommand(line);
  state.gcodePending = true;
  renderGcodeCommandState();
  setStatusMessage("gcode-command", `Sending manual command: ${line}`, "", { force: true, timeoutMs: 0 });
  try {
    const sent = await sendGcode(line, { feedback: true });
    if (sent) setStatusMessage("gcode-command", `Manual command sent: ${line}`, "ok", { force: true });
    return sent;
  } finally {
    state.gcodePending = false;
    renderGcodeCommandState();
  }
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

function bindCommandInteractions({ submitGcode: submitGcodeHandler = submitGcode, navigateCommandHistory: navigateCommandHistoryHandler = navigateCommandHistory } = {}) {
  const form = document.getElementById("gcode-form");
  const gcodeInput = document.getElementById("gcode-input");
  form.onsubmit = (e) => {
    e.preventDefault();
    const line = gcodeInput.value.trim();
    if (!line) return;
    gcodeInput.value = "";
    submitGcodeHandler(line);
  };
  gcodeInput.onkeydown = (e) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      navigateCommandHistoryHandler(gcodeInput, -1);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      navigateCommandHistoryHandler(gcodeInput, 1);
    } else if (e.key.length === 1) {
      state.historyIndex = -1;
    }
  };
}

function bindMacroInteractions({
  bindButtonAction: bind = bindButtonAction,
  bindDirtyDraftControls,
  macroEditorIDs = [],
  newMacro: newMacroHandler = newMacro,
  saveMacroFromForm: saveMacroHandler = saveMacroFromForm,
  runMacro: runMacroHandler = runMacro,
  moveSelectedMacro: moveMacroHandler = moveSelectedMacro,
  deleteSelectedMacro: deleteMacroHandler = deleteSelectedMacro,
  macroByID: macroByIDHandler = macroByID,
} = {}) {
  document.getElementById("macro-new").onclick = newMacroHandler;
  document.getElementById("macro-save").onclick = saveMacroHandler;
  bind(document.getElementById("macro-run"), () => runMacroHandler(macroByIDHandler(state.selectedMacroId)));
  document.getElementById("macro-up").onclick = () => moveMacroHandler(-1);
  document.getElementById("macro-down").onclick = () => moveMacroHandler(1);
  document.getElementById("macro-delete").onclick = deleteMacroHandler;
  bindDirtyDraftControls(macroEditorIDs);
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

  return { bindCommandInteractions, bindMacroInteractions, macroByID, slotForMacro, sortedSlots, setMacroPlacement, normalizeSlotOrder, renderGcodeCommandState, submitGcode, navigateCommandHistory, renderMacroButtons, renderMacroRegion, renderMacroEditor, currentMacroFromForm, saveMacroFromForm, newMacro, macroEditorDirty, confirmDiscardMacroDraft, deleteSelectedMacro, moveSelectedMacro, runMacro };
}
