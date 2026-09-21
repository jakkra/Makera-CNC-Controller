export const GCODE_HISTORY_KEY = "cnc-proxy.gcode-history.v1";
export const COMMAND_HISTORY_LIMIT = 24;

export function loadCommandHistory(storage = globalThis.localStorage) {
  try {
    const values = JSON.parse(storage?.getItem(GCODE_HISTORY_KEY) || "[]");
    if (Array.isArray(values)) return values.filter((value) => typeof value === "string" && value.trim()).slice(0, COMMAND_HISTORY_LIMIT);
  } catch {
    // Ignore corrupt local UI state.
  }
  return [];
}

export function saveCommandHistory(history, storage = globalThis.localStorage) {
  storage?.setItem(GCODE_HISTORY_KEY, JSON.stringify((Array.isArray(history) ? history : []).slice(0, COMMAND_HISTORY_LIMIT)));
}

export function rememberCommand(history, line) {
  line = String(line || "").trim();
  if (!line) return Array.isArray(history) ? history.slice(0, COMMAND_HISTORY_LIMIT) : [];
  return [line, ...(Array.isArray(history) ? history.filter((value) => value !== line) : [])].slice(0, COMMAND_HISTORY_LIMIT);
}
