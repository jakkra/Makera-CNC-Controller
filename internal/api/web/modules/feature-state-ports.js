function createPort(rootState, keys) {
  const descriptors = {};
  for (const key of keys) {
    descriptors[key] = {
      enumerable: true,
      get: () => rootState[key],
      set: (value) => { rootState[key] = value; },
    };
  }
  return Object.seal(Object.defineProperties({}, descriptors));
}

// Each feature receives only the state names it owns or must coordinate with.
// The accessors deliberately remain live because settings, outline, and view
// objects can be replaced after the feature factories have been mounted.
export function createFeatureStatePorts(rootState) {
  if (!rootState || typeof rootState !== "object") throw new TypeError("rootState is required");

  return Object.freeze({
    surfaceJog: createPort(rootState, [
      "activeGcodePending", "activeTab", "autoVacuumPending",
      "controlPendingAction", "jog", "machine", "surface",
    ]),
    uiSettings: createPort(rootState, [
      "activeTab", "dashboardSettingsLoaded", "logFilter", "readOnly",
      "selectedMacroId", "settingsSaveTimer", "ui",
    ]),
    workareaOutline: createPort(rootState, ["activeTab", "jog", "machine", "outline", "ui", "workarea"]),
    workareaRender: createPort(rootState, ["outline"]),
    outlineView: createPort(rootState, ["jog", "outline"]),
    jogView: createPort(rootState, ["activeTab", "jog", "ui"]),
    gamepad: createPort(rootState, ["jog", "outline", "ui"]),
    surfaceControls: createPort(rootState, ["surface", "ui"]),
    workareaInteractions: createPort(rootState, ["activeTab", "jog", "outline", "workarea"]),
    fieldProbing: createPort(rootState, ["jog", "machine", "outline", "ui", "workarea"]),
    outlineCapture: createPort(rootState, ["jog", "machine", "outline"]),
    jogEvents: createPort(rootState, ["jog", "machine"]),
  });
}
