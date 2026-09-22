import { createDashboardProfiles, defaultDashboardSettings, normalizeDashboardSettings } from "./modules/dashboard-profiles.js";
import { createLiveUpdates } from "./modules/live-updates.js";
import { pointInPolygonOrBoundary, effectiveOutlineGeometry, normalizedClosedPolygon, buildFieldProbePreview as computeFieldProbePreview, DEFAULT_FIELD_SPOT_GAP_MM } from "./modules/outline-geometry.js";
import * as THREE from "./three.module.min.js";
import { request } from "./modules/api.js";
import { gcodeCursorForPlayedLine, mountActiveJobControl, mountActiveJobDispatch, mountFeedOverride, mountActiveJobLoader, mountActiveJobPreview, mountActiveJobRunner, mountPausedJobCommand, mountActiveJobSelection } from "./modules/active-job.js";
import { ACTIVE_JOB_SPLIT_MIN_LEFT_PX, ACTIVE_JOB_SPLIT_MIN_PREVIEW_PX, ACTIVE_JOB_SPLIT_STEP_PERCENT, ACTIVE_JOB_SPLITTER_PX, DEFAULT_ACTIVE_JOB_SPLIT_PERCENT, activeJobSplitBounds as calculateActiveJobSplitBounds, createActiveJobLayout } from "./modules/active-job-layout.js";
import { createActiveJobView } from "./modules/active-job-view.js";
import { escapeHtml, setElementBusy, setSoftDisabled, setTextIfChanged } from "./modules/dom.js";
import { fmtActiveFeed, fmtAge, fmtCoord, fmtDashboardFeed, fmtDashboardSpindle, fmtDuration, fmtPos, fmtSize, fmtSpindle, fmtTemperature, fmtTime } from "./modules/format.js";
import { mountMaintenance } from "./modules/maintenance.js";
import { mountDashboardCamera } from "./modules/camera.js";
import { createDashboardTelemetry } from "./modules/dashboard-telemetry.js";
import { createDashboardView } from "./modules/dashboard-view.js";
import { createGcodeLogFeature } from "./modules/gcode-log.js";
import { createBackupFeature } from "./modules/backup.js";
import { mountGcodeViewer } from "./modules/gcode-viewer.js";
import { createFeedback } from "./modules/feedback.js";
import { createMdiMacros } from "./modules/mdi-macros.js";
import { createToolActions } from "./modules/tool-actions.js";
import { createOriginProbing } from "./modules/origin-probing.js";
import { createFilesFeature } from "./modules/files.js";
import { apiFileURL, basename, cleanRelPath, dirname, joinRelPath, parentRelPath, relPath, remotePathFromRel } from "./modules/file-paths.js";
import { fmtActiveTool, toolDisplayName, validToolID } from "./modules/tooling.js";
import { createMachineStatusFeature } from "./modules/machine-status.js";
import { createJogFeature, JOG_INPUT_DEADZONE, jogInputActive, movementArmAvailable as movementArmAvailableState, movementArmLabel as movementArmLabelState, syncJogAvailabilityFromMachine as syncJogAvailabilityState } from "./modules/jog.js";
import { createJogView } from "./modules/jog-view.js";
import { createGamepadControls } from "./modules/gamepad-controls.js";
import { createSurfaceControls } from "./modules/surface-controls.js";
import { createWorkAreaInteractions } from "./modules/workarea-interactions.js";
import { createFieldProbing } from "./modules/field-probing.js";
import { createOutlineCaptureOperations } from "./modules/outline-capture-operations.js";
import { createJogEventHandler } from "./modules/jog-events.js";
import { mobileJogAxisForResponse as computeMobileJogAxisForResponse, mobileWorkAreaJogAxes as computeMobileWorkAreaJogAxes, mobileWorkAreaJogEnabled as isMobileWorkAreaJogEnabled, mobileWorkAreaJogRadius as computeMobileWorkAreaJogRadius } from "./modules/workarea-jog.js";
import { createSurfaceJogFeature, loadSurfaceViewPreferences, saveSurfaceViewPreferences as persistSurfaceViewPreferences, isSurfaceKiosk } from "./modules/surface-jog.js";
import { createSurfaceRouting } from "./modules/surface-routing.js";
import { createSurfaceShell } from "./modules/surface-shell.js";
import { createMachineReconciliation } from "./modules/machine-reconciliation.js";
import { createOutlineFeature, workPointToMachinePoint } from "./modules/outline.js";
import { capturedOutlinePosition as normalizeCapturedOutlinePosition } from "./modules/outline-capture.js";
import { buildOutlineDXF as buildOutlineDXFDocument } from "./modules/outline-dxf.js";
import { createOutlineFilesFeature } from "./modules/outline-files.js";
import { createCommandUI } from "./modules/command-ui.js";
import { loadCommandHistory as readCommandHistory, rememberCommand as rememberCommandEntry, saveCommandHistory as persistCommandHistory } from "./modules/command-history.js";
import { createUISettingsFeature } from "./modules/ui-settings.js";
import { createOutlineView } from "./modules/outline-view.js";
import { createProbeConfirmation } from "./modules/probe-confirm.js";
import { createAppState } from "./modules/state.js";
import { buildHeightOBJ as buildHeightOBJDocument, buildHeightPGM as buildHeightPGMDocument, buildInterpolatedHeightGrid as buildInterpolatedHeightGridDocument, interpolateZ as interpolateZDocument } from "./modules/height-export.js";
import { buildHeightMeshVertices as buildHeightMeshVerticesDocument, solidifyHeightMesh as solidifyHeightMeshDocument } from "./modules/height-mesh.js";
import { constrainedOutlineTriangles as constrainedOutlineTrianglesDocument, orderedOutlineBoundaryIndices as orderedOutlineBoundaryIndicesDocument } from "./modules/height-triangulation.js";
import { exportExtents as exportExtentsDocument, fieldProbeExportPoints as fieldProbeExportPointsDocument, fieldProbeHeightReference as fieldProbeHeightReferenceDocument, outlineEffectiveExportPoints as outlineEffectiveExportPointsDocument, outlineExportPoints as outlineExportPointsDocument } from "./modules/height-coordinates.js";
import {
  addOutlinePolylineDXF,
  boundedOutlineNumber as boundOutlineNumber,
  dxfBounds,
  dxfNumber,
  dxfPair,
  dxfPairs,
  floorProbeFromJSON as parseFloorProbeFromJSON,
  outlineCubicSegments,
  outlineJSONDocument as buildOutlineJSONDocument,
  outlineOriginFromJSON as parseOutlineOriginFromJSON,
  outlinePathD,
  outlinePointFromJSON as parseOutlinePointFromJSON,
  outlineStateFromJSON as parseOutlineStateFromJSON,
  pathNum,
  pathPoint,
} from "./modules/outline-io.js";
import { axisValue, mountWorkareaOutline } from "./modules/workarea-outline.js";
import { createWorkareaRenderers } from "./modules/workarea-render.js";
import { cloneFloorProbe, cloneOutlineOrigin, cloneOutlinePoint, defaultOutlineState, defaultWorkAreaView, newID } from "./modules/state-defaults.js";
import { createNavigationFeature, createLifecycleFeature, viewTabFromURL } from "./modules/navigation.js";
import {
  createSettingsFeature,
  MACHINE_SETTING_IDS,
  DEFAULT_MACHINE_FEED_MIN_MM_MIN,
  DEFAULT_MACHINE_FEED_MAX_MM_MIN,
  MAX_MACHINE_FEED_MM_MIN,
  DEFAULT_SAFE_Z_MM,
  SAFE_Z_LIMIT_MARGIN_MM,
  defaultGamepadSettings,
  defaultMachineSettings,
  normalizeMachineSettings,
  normalizeMachineLearned,
  feedBoundsFor,
  safeZForTapMove,
  finiteOr,
  clampNumber,
  gamepadLabel,
} from "./modules/settings.js";

const GCODE_MAX_LINES = 500;
const PROBE_SPOT_DIAMETER_MM = 2;
const PROBE_SPOT_RADIUS_MM = PROBE_SPOT_DIAMETER_MM / 2;
const MAX_FIELD_PROBE_POINTS = 1500;
const OUTLINE_CURVE_TOLERANCE_MM = 0.25;
const MAX_EFFECTIVE_OUTLINE_POINTS = 4000;
const DEFAULT_PROBE_DEPTH_MM = 20;
const DEFAULT_PROBE_FEED_MM = 50;
const GCODE_SOURCE_ROW_HEIGHT = 20;
const GCODE_SOURCE_OVERSCAN = 12;
const GCODE_SOURCE_PAGE_SIZE = 500;
const GCODE_SOURCE_MAX_PAGES = 8;
const GCODE_SEGMENT_PAGE_SIZE = 5000;
const ACTIVE_JOB_SPLIT_DEFAULT_PERCENT = DEFAULT_ACTIVE_JOB_SPLIT_PERCENT;
const VIEW_TABS = ["dashboard", "active-job", "jog", "control", "files", "maintenance", "attention"];
const NAV_VIEW_TABS = ["dashboard", "active-job", "jog", "control", "files"];
const MOBILE_WORKAREA_MAX_WIDTH_PX = 600;
const MOBILE_JOG_RADIUS_MIN_PX = 56;
const MOBILE_JOG_RADIUS_MAX_PX = 88;
const OUTLINE_CAPTURE_SETTLE_MS = 300;
const OUTLINE_CAPTURE_POLL_MS = 50;
const OUTLINE_CAPTURE_TIMEOUT_MS = 60000;
const OUTLINE_CAPTURE_POSITION_TOLERANCE_MM = 0.02;
const MACRO_EDITOR_IDS = ["macro-name", "macro-description", "macro-color", "macro-lines", "macro-placement"];
const WORKAREA_PAD = 6;
const WORKAREA_VIEW_SIZE = 100;
const WORKAREA_MIN_ZOOM = 1;
const WORKAREA_MAX_ZOOM = 8;
const WORKAREA_ZOOM_STEP = 1.25;
const WORKAREA_PAN_THRESHOLD_PX = 4;
const SPINDLE_DIAMETER_MM = 3.175;
const OUTLINE_POINT_DIAMETER_MM = SPINDLE_DIAMETER_MM + 0.5;

const SYNC_LABEL = {
  synced: "Synced",
  local_only: "Local only",
  pending_upload: "Queued",
  uploading: "Uploading",
  pending_delete: "Delete queued",
  deleting: "Deleting",
  pending_rename: "Rename queued",
  remote_only: "On machine",
  error: "Error",
};

const state = createAppState({
  readCommandHistory,
  defaultGamepadSettings,
  defaultMachineSettings,
  defaultDashboardSettings,
  loadSurfaceViewPreferences,
  defaultOutlineState,
  defaultWorkAreaView,
  activeJobSplitDefaultPercent: ACTIVE_JOB_SPLIT_DEFAULT_PERCENT,
});
const machineReconciliation = createMachineReconciliation({ getState: () => state, performanceRef: performance, axisValue });

const gcodeLog = createGcodeLogFeature({
  documentRef: document,
  navigatorRef: navigator,
  URLRef: URL,
  BlobCtor: Blob,
  setTimeoutRef: setTimeout,
  setNotice: (...args) => setNotice(...args),
  getLines: () => state.gcodeLines,
  setLines: (value) => { state.gcodeLines = value; },
  getSeqs: () => state.gcodeSeqs,
  getFilter: () => state.logFilter,
  getSearch: () => state.logSearch,
  getAutoscroll: () => state.ui.log.autoscroll !== false,
  getPaused: () => state.logPaused,
  setFilter: (value) => { state.logFilter = value; state.ui.log.filter = value; },
  setSearch: (value) => { state.logSearch = value; },
  setAutoscroll: (value) => { state.ui.log.autoscroll = value; },
  setPaused: (value) => { state.logPaused = value; },
  queueSaveUISettings: (...args) => queueSaveUISettings(...args),
  maxLines: GCODE_MAX_LINES,
  escapeHtml,
});
const {
  appendGcodeLine: appendGcodeLineOperation,
  copyVisibleLog: copyVisibleLogOperation,
  exportVisibleLog: exportVisibleLogOperation,
  bindInteractions: bindGcodeLogInteractions,
  clearGcodeLog,
  renderGcodeLog,
} = gcodeLog;

const dashboardTelemetry = createDashboardTelemetry({
  documentRef: document,
  getMachine: () => state.machine,
  setTextIfChanged,
});
const {
  dashboardOptionalNumber,
  renderDashboardTelemetry,
} = dashboardTelemetry;
let dashboardView = null;
let activeJobView = null;
let activeJobLayout = null;

// Navigation is mounted after the feature factories below. Keep callbacks
// that are handed to those factories late-bound so module evaluation never
// reads the navigation instance before it exists.
let showTab = () => {};
let applyUISettings = () => {};
let applyAPICapabilities = () => {};
let queueSaveUISettings = () => {};
let saveUISettings = async () => false;
let loadUISettings = async () => {};
let loadAPICapabilities = async () => {};
let outlineView;
let jogView;
const surfaceRouting = createSurfaceRouting({
  getState: () => state,
  isSurfaceKiosk,
  showTab: (...args) => showTab(...args),
  fmtDuration,
});
const surfaceShell = createSurfaceShell({ documentRef: document, showTab: (...args) => showTab(...args) });

const {
  clearConnectivityIssue,
  clearNotice,
  consumeStatusFeedback,
  dismissNotice,
  renderNoticeBar,
  setConnectivityIssue,
  setNotice,
  setStatusMessage,
} = createFeedback({ documentRef: document, performanceRef: performance });

const backupFeature = createBackupFeature({
  request,
  documentRef: document,
  URLRef: URL,
  BlobCtor: Blob,
  setTimeoutRef: setTimeout,
  locationRef: window.location,
  confirmRef: (message) => window.confirm(message),
  setStatusMessage,
  setNotice,
});
const { exportBackup: exportBackupOperation, importBackupFile: importBackupFileOperation } = backupFeature;

const {
  setDashboardControlsOpen,
  initDashboardControlsMenu,
  setWorkAreaActionsOpen,
  initWorkAreaActionsMenu,
  initCommandPopouts,
} = createCommandUI({
  documentRef: document,
  windowRef: window,
  elementCtor: globalThis.Element,
  getComputedStyleRef: globalThis.getComputedStyle,
  requestAnimationFrameRef: globalThis.requestAnimationFrame,
});

const { resetEventStream, connectControlSSE, connectFilesSSE, pollMachine } = createLiveUpdates({
  request,
  applySnapshot,
  applyMachineStatus,
  appendGcodeLine,
  applyChange,
  clearConnectivityIssue,
  setConnectivityIssue,
  refreshJobs,
});
const { confirmProbeAction, settleProbeConfirmation } = createProbeConfirmation({ documentRef: document });

// Settings owns the machine/gamepad controls while API load/save remains in
// this bootstrap. Late-bound callbacks keep the existing initialization graph
// intact: settings can render jog/workarea state without taking a snapshot of
// either object during module construction.
const settingsFeature = createSettingsFeature({
  documentRef: document,
  getUI: () => state.ui,
  setUI: (value) => { state.ui = value; },
  getSelectedMacroId: () => state.selectedMacroId,
  getMachineLearnPending: () => state.machineLearnPending,
  setMachineLearnPending: (value) => { state.machineLearnPending = value; },
  getSettingsSaveTimer: () => state.settingsSaveTimer,
  setSettingsSaveTimer: (value) => { state.settingsSaveTimer = value; },
  request,
  applyUISettings: (...args) => applyUISettings(...args),
  queueSaveUISettings: (...args) => queueSaveUISettings(...args),
  renderJog: (...args) => renderJog(...args),
  renderWorkArea: (...args) => renderWorkArea(...args),
  setTapFeedback: (...args) => setTapFeedback(...args),
  setStatusMessage,
  setNotice,
  clearNotice,
  confirmRef: (message) => confirm(message),
  fmtCoord,
  newID,
  normalizeDashboardSettings: (...args) => normalizeDashboardSettings(...args),
  macroByID: (id) => state.ui.macros.find((macro) => macro.id === id),
});
const {
  renderMachineSettings,
  refreshMachineLearnedSettings,
  learnMachineParameters,
  openMachineSettings,
  closeMachineSettings,
  updateMachineSettings,
  stepTapFeed,
  updateSafeZToggle,
  renderGamepadSettings,
  renderGamepadMacroBindings,
  updateGamepadAxis,
  updateGamepadButtons,
  addGamepadMacroBinding,
  normalizeGamepadMacroOrder,
  machineLearnedSummaryLines,
  normalizeUISettings,
  controlLocallyOwned,
  markControlDirty,
  clearControlDrafts,
  setInputValue,
  setControlValueIfIdle,
  setCheckedIfIdle,
  bindDirtyDraftControls,
} = settingsFeature;

const mdiMacros = createMdiMacros({
  documentRef: document,
  getUI: () => state.ui,
  newID,
  escapeHtml,
  bindButtonAction,
  clearControlDrafts,
  setControlValueIfIdle,
  setSoftDisabled,
  setNotice,
  clearNotice,
  queueSaveUISettings,
  renderGamepadSettings,
  confirmRef: (message) => confirm(message),
  sendGcode,
  rememberCommand,
  setStatusMessage,
  getSelectedMacroId: () => state.selectedMacroId,
  setSelectedMacroId: (value) => { state.selectedMacroId = value; },
  getMacroRunning: () => state.macroRunning,
  setMacroRunning: (value) => { state.macroRunning = value; },
  getGcodePending: () => state.gcodePending,
  setGcodePending: (value) => { state.gcodePending = value; },
  getCommandHistory: () => state.commandHistory,
  getHistoryIndex: () => state.historyIndex,
  setHistoryIndex: (value) => { state.historyIndex = value; },
});
const {
  macroByID, slotForMacro, sortedSlots, setMacroPlacement, normalizeSlotOrder,
  bindCommandInteractions, renderGcodeCommandState, submitGcode, navigateCommandHistory, renderMacroButtons,
  renderMacroRegion, renderMacroEditor, currentMacroFromForm, saveMacroFromForm,
  newMacro, macroEditorDirty, confirmDiscardMacroDraft, deleteSelectedMacro,
  moveSelectedMacro, runMacro,
} = mdiMacros;
const toolActions = createToolActions({
  documentRef: document,
  request,
  validToolID,
  toolDisplayName,
  getMachine: () => state.machine,
  getPending: () => state.toolPending,
  setPending: (value) => { state.toolPending = value; },
  setSoftDisabled,
  setElementBusy,
  setStatusMessage,
  disarmTapMoveForCommand,
  appendGcodeLine,
  pollMachine,
});
const {
  customToolID, resetToolSelects, toggleToolCustomInput, handleToolSelect,
  selectedToolID, setCurrentTool, changeTool, continueToolChange,
  calibrateCurrentTool, beginToolAction, finishToolAction,
  refreshMachineAfterToolAction, renderToolActions, setToolFeedback,
  clearToolFeedback,
} = toolActions;
const surfaceJogFeature = createSurfaceJogFeature({
  stateFacade: state,
  documentRef: document,
  windowRef: window,
  getActiveTab: () => state.activeTab,
  getMachine: () => state.machine,
  getReadOnly: () => state.readOnly,
  getTapMoveTargetBusy: () => tapMoveTargetBusy(),
  getPendingOriginOperation: () => hasPendingOriginOperation(),
  getMachineActionState: () => machineActionState(),
  getMovementArmAvailable: () => movementArmAvailable(),
  getMovementArmLabel: (j) => movementArmLabel(j),
  renderMachineReadouts: (...args) => renderMachineReadouts(...args),
  fmtActiveTool: (...args) => fmtActiveTool(...args),
  fmtSpindle: (...args) => fmtSpindle(...args),
  dashboardOptionalNumber,
  renderJog: (...args) => renderJog(...args),
  stopSurfaceHoldJog: (...args) => stopSurfaceHoldJog(...args),
  saveSurfaceViewPreferences: () => saveSurfaceViewPreferences(),
  setTextIfChanged,
  setSoftDisabled,
});
const {
  surfaceJogBaseReady, surfaceJogReady, surfaceMPGGestureActive,
  surfaceJogDisplayState, deferSurfaceMPGMachineRender,
  renderSurfaceJog, renderSurfaceMPGWheel, surfaceQuickActionState,
  renderSurfaceQuickActions, surfaceJogOptionsSummary,
  initializeSurfaceMobileOptions, selectSurfaceJogMethod,
  selectSurfaceMPGAxis, selectSurfaceStep, selectSurfaceMotion,
  surfaceStepDistance, surfaceStepUnit,
} = surfaceJogFeature;
const gamepadControls = createGamepadControls({
  state,
  navigatorRef: navigator,
  documentRef: document,
  callbacks: {
    clearControlDrafts: (...args) => clearControlDrafts(...args),
    queueSaveUISettings: (...args) => queueSaveUISettings(...args),
    addOutlinePoint: (...args) => addOutlinePoint(...args),
    macroByID: (...args) => macroByID(...args),
    setNotice: (...args) => setNotice(...args),
    clearNotice: (...args) => clearNotice(...args),
    runMacro: (...args) => runMacro(...args),
  },
});
const { currentGamepad, buttonPressed, buttonStates, mappedAxis, captureGamepadOutlineButton, handleGamepadOutlineButton, handleGamepadMacroButtons, sameButtonStates, clampAxis } = gamepadControls;
let workAreaInteractions = null;
const jogFeature = createJogFeature({
  jogState: state.jog,
  surfaceState: state.surface,
  documentRef: document,
  windowRef: window,
  WebSocketCtor: window.WebSocket,
  performanceRef: performance,
  renderJog,
  renderMachine: (...args) => machineStatus.renderMachine(...args),
  renderSurfaceMPGWheel,
  setStatusMessage,
  applyJogEvent,
  failOutlineCaptureIntents,
  completeCommandDisarm,
  cancelWorkCoordinateMove,
  clearFieldProbeMove,
  hasPendingOriginOperation: (...args) => originProbing.hasPendingOriginOperation(...args),
  originTargetLabel: (...args) => originProbing.originTargetLabel(...args),
  clearOriginVerification: (...args) => originProbing.clearOriginVerification(...args),
  setOriginFeedback: (...args) => originProbing.setOriginFeedback(...args),
  tapMoveArmFailureText,
  clampAxis,
  currentGamepad,
  mappedAxis,
  buttonStates,
  buttonPressed,
  gamepadLabel,
  captureGamepadOutlineButton,
  handleGamepadOutlineButton,
  handleGamepadMacroButtons,
  sameButtonStates,
  resetMobileWorkAreaJog,
  getUI: () => state.ui,
  getWorkarea: () => state.workarea,
  surfaceJogReady,
  sendSurfaceStep,
});
const {
  connectJog, disableJogConnection, scheduleJogReconnect, sendJogInput, sendJog,
  sampleJog, releaseJogInput, scheduleJogSample, bindSurfaceMPGWheel,
} = jogFeature;

const surfaceControls = createSurfaceControls({
  state,
  documentRef: document,
  callbacks: {
    bindButtonAction,
    toggleSurfaceMovementArm,
    selectSurfaceJogMethod,
    stopSurfaceHoldJog,
    saveSurfaceViewPreferences,
    renderSurfaceJog,
    selectSurfaceStep,
    selectSurfaceMotion,
    selectSurfaceMPGAxis,
    bindSurfaceMPGWheel,
    beginSurfaceHoldJog,
    stopSurfaceHoldJog,
    sendSurfaceStep,
    normalizeMachineSettings,
    clampNumber,
    applySurfaceAutomaticView,
  },
});
const originProbing = createOriginProbing({
  documentRef: document,
  getMachine: () => state.machine,
  getUI: () => state.ui,
  getJog: () => state.jog,
  getActiveTab: () => state.activeTab,
  getOutline: () => state.outline,
  request, pollMachine, sendJog, connectJog, appendGcodeLine, renderJog,
  renderMachineSettings, refreshMachineLearnedSettings, queueSaveUISettings,
  normalizeMachineSettings, defaultMachineSettings, normalizeMachineLearned,
  currentWorkOrigin, currentAxisValues, axisValue, fmtCoord, finiteOr, newID,
  tapMoveTargetBusy,
  isProbeToolActive: (...args) => outlineFeature.isProbeToolActive(...args),
  is3DProbeToolActive: (...args) => outlineFeature.is3DProbeToolActive(...args),
  controlLocallyOwned, setSoftDisabled, setTextIfChanged, setElementBusy, setStatusMessage,
  setTapFeedback, clampNumber,
});
const {
  machineReadyForOriginSet, renderOriginButtons, setOriginFeedback,
  renderOriginSetSourceLabels, hasPendingOriginOperation, savedOrigins,
  selectedSavedOrigin, savedOriginLabel, renderSavedOriginSelect,
  saveCurrentOrigin, deleteSelectedOrigin, originCommandLine,
  formatOriginValue, originTargetsFromXYZ, originTargetsFromSaved,
  machineAnchorPoints, originTargetsFromOriginSource,
  originReferenceRequestFromInputs, renderOriginSetChange, originAxes,
  originTargetLabel, clearOriginVerification, beginOriginVerification,
  checkOriginVerification, scheduleOriginVerification, setOriginViaGcode,
  setReferenceOriginViaAPI, setReferenceOriginViaJog, sendNextJogOriginAxis,
  handleOriginAck, applyOriginTargets, setOriginAxis, openOriginDialog,
  closeOriginDialog, probe3DFieldRules, probe3DInitialPositioning,
  probe3DTravelPreflight, probe3DLearnedTravelBounds,
  probe3DPreflightFromControls, renderProbe3DForm, probe3DNumber,
  probe3DRequestFromControls, openProbe3D, closeProbe3D, runProbe3D,
  applyXYZOrigin, applyOriginSource, runAutoZProbe, recallSelectedOrigin,
} = originProbing;

const dashboardCamera = mountDashboardCamera({
  getActiveTab: () => state.activeTab,
  getReadOnly: () => state.readOnly,
  documentRef: document,
  windowRef: window,
  request,
  setStatusMessage,
  bindButtonAction,
  setTextIfChanged,
});

const filesFeature = createFilesFeature({
  documentRef: document, windowRef: window, request, FormDataRef: FormData,
  promptRef: (message, value) => window.prompt(message, value),
  confirmRef: (message) => window.confirm(message),
  paths: { relPath, cleanRelPath, joinRelPath, remotePathFromRel, parentRelPath, dirname, basename, apiFileURL },
  escapeHtml, fmtSize, fmtTime, syncLabel: SYNC_LABEL, setNotice, clearNotice,
  getMachine: () => state.machine,
  renderMachine: (...args) => machineStatus.renderMachine(...args),
  getActiveGcodePath: () => state.activeGcode?.path || "", loadActiveGcode,
  getActiveSelectPendingPath: () => state.activeSelectPendingPath,
  selectActiveGcode: (...args) => activeJobSelection.selectActiveGcode(...args),
});
const { renderFiles, renderJobs, scheduleFileRender, uploadFiles, doMkdir, doDelete, retryJob, discardFile, doRename, openDir, queuePendingCount } = filesFeature;

const activeJobSelection = mountActiveJobSelection({
  request,
  setActiveSelectPendingPath: (path) => { state.activeSelectPendingPath = path; },
  setActiveGcode: (active) => { state.activeGcode = active; },
  relPath,
  setActiveFeedback,
  setNotice,
  renderFiles: () => renderFiles(),
  renderActiveGcode,
  showTab: (...args) => showTab(...args),
});

const activeJobLoader = mountActiveJobLoader({
  request,
  getActiveGcodeLoading: () => state.activeGcodeLoading,
  setActiveGcodeLoading: (loading) => { state.activeGcodeLoading = loading; },
  setActiveGcode: (active) => { state.activeGcode = active; },
  clearConnectivityIssue,
  setConnectivityIssue,
  renderActiveGcode,
  getMachine: () => state.machine,
  renderAttention: (...args) => machineStatus.renderAttention(...args),
});

const activeJobRunner = mountActiveJobRunner({
  request,
  getActiveGcode: () => state.activeGcode,
  getActiveGcodePending: () => state.activeGcodePending,
  setActiveGcodePending: (value) => { state.activeGcodePending = value; },
  machineActionState: (...args) => machineStatus.machineActionState(...args),
  confirmRef: (message) => confirm(message),
  relPath,
  setActiveFeedback,
  renderActiveGcode,
  clearNotice,
  pollMachine,
  appendGcodeLine,
  setNotice,
});

const activeJobControl = mountActiveJobControl({
  request,
  getActiveGcodePending: () => state.activeGcodePending,
  setActiveGcodePending: (value) => { state.activeGcodePending = value; },
  machineActionState: (...args) => machineStatus.machineActionState(...args),
  confirmRef: (message) => confirm(message),
  setActiveFeedback,
  renderMachine: (...args) => machineStatus.renderMachine(...args),
  pollMachine,
});

const feedOverrideOperation = mountFeedOverride({
  request,
  getActiveGcodePending: () => state.activeGcodePending,
  setActiveGcodePending: (value) => { state.activeGcodePending = value; },
  getMachine: () => state.machine,
  setFeedOverridePendingPercent: (value) => { state.feedOverridePendingPercent = value; },
  setActiveFeedback,
  renderActiveGcode: (...args) => renderActiveGcode(...args),
  pollMachine,
});
const { setFeedOverride: setFeedOverrideOperationFn, adjustFeedOverride: adjustFeedOverrideOperationFn } = feedOverrideOperation;
const activeJobDispatch = mountActiveJobDispatch({
  documentRef: document,
  machineActionState: (...args) => machineActionState(...args),
  jobControlModel: (...args) => jobControlModel(...args),
  setActiveFeedback,
  runActiveJobControl: (...args) => runActiveJobControl(...args),
  sendControl: (...args) => sendControl(...args),
  runPausedJobCommand: (...args) => runPausedJobCommand(...args),
});
const { resumeActiveJob: resumeActiveJobOperation, runJobControl: runJobControlOperation } = activeJobDispatch;

const pausedJobCommand = mountPausedJobCommand({
  request,
  getActiveGcodePending: () => state.activeGcodePending,
  setActiveGcodePending: (value) => { state.activeGcodePending = value; },
  getRaiseDistance: () => document.getElementById("paused-job-raise-distance")?.value,
  setActiveFeedback,
  renderActiveGcode,
  pollMachine,
});

const activeJobPreview = mountActiveJobPreview({ cursorForPlayedLine: gcodeCursorForPlayedLine });
const { activeJobPreviewState } = activeJobPreview;

const maintenance = mountMaintenance({
  request,
  setStatusMessage,
  bindButtonAction,
  getReadOnly: () => state.readOnly,
});

const uiSettings = createUISettingsFeature({
  stateFacade: state,
  documentRef: document,
  request,
  normalizeUISettings,
  clearConnectivityIssue,
  setConnectivityIssue,
  setNotice,
  clearNotice,
  maintenanceRender: () => maintenance.render(),
  renderMacroButtons: (...args) => renderMacroButtons(...args),
  renderMacroEditor: (...args) => renderMacroEditor(...args),
  renderGamepadSettings: (...args) => renderGamepadSettings(...args),
  renderMachineSettings: (...args) => renderMachineSettings(...args),
  renderJog: (...args) => renderJog(...args),
  renderGcodeLog: (...args) => renderGcodeLog(...args),
  renderWorkArea: (...args) => renderWorkArea(...args),
  resolveDashboardProfile: (...args) => resolveDashboardProfile(...args),
  showTab: (...args) => showTab(...args),
});
({ applyUISettings, applyAPICapabilities, queueSaveUISettings, saveUISettings, loadUISettings, loadAPICapabilities } = uiSettings);

const navigationFeature = createNavigationFeature({
  documentRef: document,
  windowRef: window,
  viewTabs: VIEW_TABS,
  getActiveTab: () => state.activeTab,
  setActiveTab: (value) => { state.activeTab = value; },
  getMachine: () => state.machine,
  getSurface: () => state.surface,
  setSurface: (value) => { Object.assign(state.surface, value); },
  isSurfaceKiosk,
  disarmMovementOnControlExit,
  setDashboardControlsOpen,
  connectFilesSSE,
  renderActiveGcode,
  renderDashboard,
  renderJog,
  maintenanceLoad: () => maintenance.load(),
  clearNotice,
  syncDashboardCameras,
});
const { setHeaderCollapsed } = navigationFeature;
showTab = navigationFeature.showTab;

const lifecycleFeature = createLifecycleFeature({
  documentRef: document,
  windowRef: window,
  ElementCtor: typeof Element === "undefined" ? undefined : Element,
  getPageHiddenAt: () => pageHiddenAt,
  setPageHiddenAt: (value) => { pageHiddenAt = value; },
  reloadPage: () => window.location.reload(),
  stopDashboardBuiltinCamera,
  stopDashboardExternalCamera,
  resetEventStream,
  connectControlSSE,
  filesIsLoaded: () => filesFeature.isLoaded(),
  connectFilesSSE,
  loadDashboardCameras,
  loadActiveGcode,
  loadAPICapabilities,
  loadJogCapabilities,
  pollMachine,
  getActiveTab: () => state.activeTab,
  maintenanceLoad: () => maintenance.load(),
  setJogInputSuspended: (value) => { state.jog.inputSuspended = value; },
  releaseJogInput,
  renderJog,
  connectJog,
  scheduleJogSample,
  getPreferredPadIndex: () => state.jog.preferredPadIndex,
  setPreferredPadIndex: (value) => { state.jog.preferredPadIndex = value; },
  clearJogError: () => { state.jog.error = ""; },
});
const { reloadPage, recoverForegroundSession, installPullToRefresh, bindBrowserLifecycle } = lifecycleFeature;

let outlineContextRevision = 1;
let pageHiddenAt = 0;
const HALT_REASON = {
  1: "Halt manually",
  2: "Home fail",
  3: "Probe fail",
  4: "Calibrate fail",
  5: "ATC home fail",
  6: "ATC invalid tool number",
  7: "ATC drop tool fail",
  8: "ATC position occupied",
  9: "Spindle overheated",
  10: "Soft limit triggered",
  11: "Cover opened when playing",
  12: "Wireless probe dead or not set",
  13: "Emergency stop button pressed",
  14: "Power overheated",
  15: "Machine has not been homed",
  21: "Hard limit triggered",
  22: "X axis motor error",
  23: "Y axis motor error",
  24: "Z axis motor error",
  25: "Spindle stall",
  26: "SD card read fail",
  41: "Spindle alarm",
};

const machineStatus = createMachineStatusFeature({
  documentRef: document,
  getMachine: () => state.machine,
  getActiveGcode: () => state.activeGcode,
  getActiveGcodePending: () => state.activeGcodePending,
  getFeedOverridePendingPercent: () => state.feedOverridePendingPercent,
  getReadOnly: () => state.readOnly,
  getControlPendingAction: () => state.controlPendingAction,
  getLastControlResult: () => state.lastControlResult,
  setLastControlResult: (value) => { state.lastControlResult = value; },
  getCurrentAxisValues: currentAxisValues,
  toolDisplayName,
  fmtDashboardFeed,
  fmtDashboardSpindle,
  fmtCoord,
  axisValue,
  setTextIfChanged,
  fmtAge,
  pendingCount,
  fmtPos,
  fmtActiveFeed,
  fmtSpindle,
  renderToolActions,
  renderActiveGcode,
  syncJogAvailabilityFromMachine,
  checkOriginVerification,
  renderJog,
  renderOutlineCapture,
  clearNotice,
  setStatusMessage,
  HALT_REASON,
});
const {
  gcodeToolMetadata, gcodeToolLabel, renderProgramToolLists, machineFeedOverrideControlModel, toolChangeTargetLabel,
  toolChangeAttentionDetail, machineReadoutModel, renderMachineReadouts, mountMachineReadouts, haltReason,
  recoveryText, machineActionState, jobControlModel, jobControlLabel, renderJobControls,
  renderMachine, renderAttention, attentionResumeAction, renderToolStatus,
  renderAlarmPanel, recoveryButtonText,
} = machineStatus;

const gcodeViewer = mountGcodeViewer({
  THREE,
  documentRef: document,
  windowRef: window,
  request,
  getActiveGcode: () => state.activeGcode,
  getMachine: () => state.machine,
  getFiles: () => filesFeature.getFiles(),
  getOutline: () => state.outline,
  deps: {
    activeJobPreviewState,
    getActiveFile: (path) => filesFeature.getFile(path),
    gcodeToolLabel,
    gcodeToolMetadata,
    externalJobInfo,
    fmtSize,
    relPath,
    machineActionState,
    renderProgramToolLists,
    renderJobControls,
    setSoftDisabled,
    setStatusMessage,
    setTextIfChanged,
    setElementBusy,
    SYNC_LABEL,
    currentDashboardProfile: () => currentDashboardProfile(),
    clearConnectivityIssue,
    clearNotice,
    renderActiveGcode,
    activeGcodeDisplaySegments,
    axisValue,
    cloneOutlineOrigin,
    currentWorkOrigin,
    buildHeightMeshVertices,
    constrainedOutlineTriangles,
    interpolateZ,
    clearThreeGroup,
    disposeObject,
    panGcodeCamera,
    updateGcodeProgress,
    toolDisplayName,
    fmtCoord,
  },
});

activeJobView = createActiveJobView({
  documentRef: document,
  getActiveGcode: () => state.activeGcode,
  getMachine: () => state.machine,
  getActiveGcodePending: () => state.activeGcodePending,
  getFeedOverridePendingPercent: () => state.feedOverridePendingPercent,
  externalJobInfo,
  relPath,
  fmtSize,
  syncLabel: SYNC_LABEL,
  machineActionState,
  renderProgramToolLists,
  ensureActiveGcodeGeometry,
  ensureActiveGcodeSource,
  drawGcodePreview,
  fmtDuration,
  renderDashboard,
  activeJobPreviewState,
  activeGcodeDisplaySegments,
  renderJobControls,
  setSoftDisabled,
  getFile: (path) => filesFeature.getFile(path),
  gcodeToolLabel,
});

dashboardView = createDashboardView({
  documentRef: document,
  getMachine: () => state.machine,
  getActiveGcode: () => state.activeGcode,
  externalJobInfo,
  activeGcodeDisplaySegments,
  activeJobPreviewState,
  renderMachineReadouts,
  renderDashboardTelemetry,
  renderDashboardGcodeStream,
  drawDashboardGcodePreview,
  relPath,
  fmtDuration,
});

activeJobLayout = createActiveJobLayout({
  documentRef: document,
  getState: () => state,
  scheduleActiveGcodeSourceRender: (...args) => scheduleActiveGcodeSourceRender(...args),
  scheduleGcodeRender: (...args) => scheduleGcodeRender(...args),
  renderGcodeLog,
  defaultSplitPercent: ACTIVE_JOB_SPLIT_DEFAULT_PERCENT,
  splitStepPercent: ACTIVE_JOB_SPLIT_STEP_PERCENT,
  minLeftPx: ACTIVE_JOB_SPLIT_MIN_LEFT_PX,
  minPreviewPx: ACTIVE_JOB_SPLIT_MIN_PREVIEW_PX,
  splitterPx: ACTIVE_JOB_SPLITTER_PX,
});

// Work-area viewport/state ownership lives in a feature module. The outline
// and probe renderers still live here for now, so these callbacks intentionally
// close over the late-bound feature instance.
let workareaOutline;
let workareaRender;
workareaOutline = mountWorkareaOutline({
  stateFacade: state,
  documentRef: document,
  constants: {
    WORKAREA_PAD,
    WORKAREA_VIEW_SIZE,
    WORKAREA_MIN_ZOOM,
    WORKAREA_MAX_ZOOM,
    WORKAREA_ZOOM_STEP,
    WORKAREA_PAN_THRESHOLD_PX,
    OUTLINE_CAPTURE_POSITION_TOLERANCE_MM,
  },
  defaultWorkAreaView,
  normalizeMachineSettings,
  currentWorkOrigin,
  currentAxisValues,
  syncGcodeContextOverlay,
  setWorkAreaToolRadius: (...args) => setWorkAreaToolRadius(...args),
  markGcodeContextOverlayDirty,
  hasGcodeRenderer: () => !!gcodeViewer.getGcodeView()?.renderer,
  renderActiveGcode,
  renderWorkAreaOutline: (...args) => workareaRender?.renderWorkAreaOutline(...args),
  renderWorkAreaFieldProbePreview: (...args) => workareaRender?.renderWorkAreaFieldProbePreview(...args),
  visualWorkOrigin,
  tapMoveTargetBusy,
  jogEstimateActive,
  hasPendingOriginOperation: (...args) => originProbing.hasPendingOriginOperation(...args),
  updateFieldProbePreview,
  finiteOr,
  clampNumber,
  cloneOutlinePoint,
  cloneOutlineOrigin,
  pathNum,
  fmtCoord,
  newID,
  clearNotice,
  renderOutlineCapture: (...args) => renderOutlineCapture(...args),
});
const {
  normalizeWorkAreaView,
  workAreaViewCenter,
  applyWorkAreaViewport,
  resetWorkAreaView,
  setWorkAreaZoom,
  zoomWorkArea,
  panWorkArea,
  workAreaSVGPointFromClient,
  workAreaLocalToContentPoint,
  hideWorkAreaHoverPosition,
  updateWorkAreaHoverPosition,
  workAreaBounds,
  workAreaRect,
  workAreaMMToSVGUnits,
  workAreaMMRadius,
  machineToWorkAreaPoint,
  workAreaToMachinePoint,
  renderWorkArea,
  outlineSnapshot,
  restoreOutlineSnapshot,
  outlineCapturePositionsClose,
  outlineCaptureIntentCount,
  cancelOutlineCaptureIntents,
  appendOutlineCapturedPosition,
  resolveOutlineCaptureIntent,
  clearFieldProbeData,
  outlineEditingMarkersVisible,
} = workareaOutline;

const outlineFeature = createOutlineFeature({
  getOutline: () => state.outline,
  getMachine: () => state.machine,
  getWorkarea: () => state.workarea,
  renderOutlineCapture,
  renderWorkArea: (...args) => renderWorkArea(...args),
  pushOutlineUndo,
  outlineSnapshot,
  restoreOutlineSnapshot,
  updateFieldProbePreview,
  setTapFeedback,
  fmtCoord,
  axisValue,
  normalizedClosedPolygon,
  pointInPolygonOrBoundary,
  workAreaToMachinePoint,
  workAreaLocalToContentPoint,
  cloneOutlineOrigin,
  currentWorkOrigin,
});
const {
  fieldProbeSpotGap, fieldProbeCenterSpacing, outlineWorkPoints,
  fieldProbePlanPointMatchesResult, selectedFieldProbePoint, unprobedFieldProbePoints,
  selectedFieldProbeResult, selectFieldProbePoint, outlinePointLabel,
  outlineSummaryText, setOutlineFeedback, isProbeToolActive,
  is3DProbeToolActive, closeOutline: closeOutlineFeature,
  undoOutline: undoOutlineFeature, redoOutline: redoOutlineFeature,
} = outlineFeature;
workareaRender = createWorkareaRenderers({
  stateFacade: state,
  documentRef: document,
  constants: { OUTLINE_POINT_DIAMETER_MM, PROBE_SPOT_RADIUS_MM },
  machineToWorkAreaPoint,
  workAreaMMToSVGUnits,
  workAreaMMRadius: (...args) => workAreaMMRadius(...args),
  outlinePathD,
  outlineEditingMarkersVisible,
  cloneOutlineOrigin,
  currentWorkOrigin,
  visualWorkOrigin,
  workPointToMachinePoint,
  fieldProbePlanPointMatchesResult,
  fmtCoord,
  escapeHtml,
});
const { renderWorkAreaOutline, renderWorkAreaFieldProbePreview, displayedFieldProbePoints } = workareaRender;
outlineView = createOutlineView({
  stateFacade: state,
  documentRef: document,
  outlineCaptureIntentCount,
  isProbeToolActive,
  machineReadyForOriginSet,
  tapMoveTargetBusy,
  controlLocallyOwned,
  pathNum,
  setSoftDisabled,
  setTextIfChanged,
  consumeStatusFeedback,
  fieldProbeSpotGap,
  selectedFieldProbePoint,
  selectedFieldProbeResult,
  outlineSummaryText,
});
jogView = createJogView({
  stateFacade: state,
  documentRef: document,
  jogPanelMessage,
  setStatusMessage,
  clearNotice,
  setTextIfChanged,
  movementArmLabel,
  hasPendingOriginOperation,
  movementArmAvailable,
  normalizeMachineSettings,
  feedBoundsFor,
  finiteOr,
  clampNumber,
  controlLocallyOwned,
  tapMoveTargetBusy,
  renderWorkMoveControls,
  renderOriginButtons,
  consumeJogAlertFeedback,
  renderWorkArea,
  renderSurfaceJog,
  setSoftDisabled,
});
const fieldProbeMoveCandidate = (local) => outlineFeature.fieldProbeMoveCandidate(
  local, workAreaToMachinePoint, workAreaLocalToContentPoint, cloneOutlineOrigin, currentWorkOrigin,
);

const outlineFilesFeature = createOutlineFilesFeature({
  documentRef: document,
  getOutline: () => state.outline,
  setOutline: (value) => { state.outline = value; },
  outlineJSONDocument: () => outlineJSONDocument(),
  buildOutlineDXF: () => buildOutlineDXF(),
  buildHeightOBJ: () => buildHeightOBJ(),
  buildHeightPGM: () => buildHeightPGM(),
  outlineStateFromJSON: (doc) => outlineStateFromJSON(doc),
  cancelOutlineCaptureIntents,
  markGcodeContextOverlayDirty,
  updateFieldProbePreview,
  renderOutlineCapture: (...args) => renderOutlineCapture(...args),
  renderWorkArea: (...args) => renderWorkArea(...args),
  setOutlineFeedback,
  setStatusMessage,
  confirmRef: (message) => confirm(message),
});
const {
  downloadBlob: downloadOutlineBlob,
  saveOutlineJSON: saveOutlineJSONFeature,
  exportOutline: exportOutlineFeature,
  exportHeightOBJ: exportHeightOBJFeature,
  exportHeightImage: exportHeightImageFeature,
  loadOutlineFile: loadOutlineFileFeature,
  installLoadedOutlineState: installLoadedOutlineStateFeature,
} = outlineFilesFeature;


const dashboardProfileState = {
  get ui() { return state.ui; },
  set ui(value) { state.ui = value; },
  get dashboardProfileID() { return state.dashboardProfileID; },
  set dashboardProfileID(value) { state.dashboardProfileID = value; },
  get dashboardRequestedProfileID() { return state.dashboardRequestedProfileID; },
  set dashboardRequestedProfileID(value) { state.dashboardRequestedProfileID = value; },
  get dashboardEmbed() { return state.dashboardEmbed; },
  set dashboardEmbed(value) { state.dashboardEmbed = value; },
  get dashboardSettingsLoaded() { return state.dashboardSettingsLoaded; },
  set dashboardSettingsLoaded(value) { state.dashboardSettingsLoaded = value; },
  get dashboardDraftProfileID() { return state.dashboardDraftProfileID; },
  set dashboardDraftProfileID(value) { state.dashboardDraftProfileID = value; },
};
const dashboardProfiles = createDashboardProfiles({
  dashboardState: dashboardProfileState, documentRef: document, windowRef: window, navigatorRef: window.navigator,
  confirmRef: (message) => window.confirm(message),
  normalizeDashboardSettings, viewTabFromURL, setDashboardControlsOpen, renderDashboard, newID, saveUISettings, setNotice,
  getDashboardGcodeView: () => gcodeViewer.getDashboardGcodeView(),
  scheduleDashboardGcodeRender: () => gcodeViewer.scheduleDashboardGcodeRender(),
});
const { dashboardURLState, dashboardProfileByID, currentDashboardProfile, isWideSurfaceOverview, dashboardPanelVisible, resolveDashboardProfile, applyDashboardURLState, syncDashboardProfileURL, selectDashboardProfile, renderDashboardProfileControls, applyDashboardProfile, dashboardProfileSlug, renderDashboardPanelOrder, refreshDashboardPanelOrderButtons, openDashboardSettings, closeDashboardSettings, dashboardProfileFromForm, saveDashboardProfile, deleteDashboardProfile, copyDashboardURL } = dashboardProfiles;

workAreaInteractions = createWorkAreaInteractions({
  state,
  documentRef: document,
  windowRef: window,
  constants: { WORKAREA_PAN_THRESHOLD_PX, WORKAREA_ZOOM_STEP, MOBILE_WORKAREA_MAX_WIDTH_PX },
  callbacks: {
    workAreaToMachinePoint, workAreaLocalToContentPoint, sendTapMove,
    isMobileWorkAreaJogEnabled, tapMoveTargetBusy,
    hasPendingOriginOperation, mobileWorkAreaJogAxes, mobileWorkAreaJogRadius,
    clampNumber, pathNum, sendJog, setTapFeedback, normalizeWorkAreaView, renderJog,
    jogInputActive, workAreaSVGPointFromClient, selectedFieldProbePoint,
    updateWorkAreaHoverPosition, updateSelectedFieldProbeDrag, panWorkArea,
    finishSelectedFieldProbeMove, selectFieldProbePoint, hideWorkAreaHoverPosition,
    restoreSelectedFieldProbePosition, renderWorkArea, zoomWorkArea, moveSelectedFieldProbePointBy,
  },
});

const fieldProbing = createFieldProbing({
  state,
  constants: { DEFAULT_PROBE_DEPTH_MM, DEFAULT_PROBE_FEED_MM },
  callbacks: {
    cloneOutlineOrigin, axisValue, currentWorkOrigin, normalizeMachineSettings, finiteOr,
    safeZForTapMove, request, markGcodeContextOverlayDirty, machineReadyForOriginSet,
    isProbeToolActive, setOutlineFeedback, confirmProbeAction, renderOutlineCapture,
    renderJog, pollMachine, fmtCoord, cancelOutlineFieldSpacingUpdate,
    commitOutlineFieldSpacingDraft, clearControlDrafts,
    unprobedFieldProbePoints, currentOutlineCapturePosition, renderWorkArea,
    effectiveOutlineGeometry, outlineWorkPoints, workPointToMachinePoint,
    tapMoveTargetBusy, currentTapFeed, selectedFieldProbePoint, connectJog, sendJog,
    setTapFeedback, hasPendingOriginOperation, fieldProbeMoveCandidate,
    fieldProbePlanPointMatchesResult, normalizedClosedPolygon, pointInPolygonOrBoundary,
    selectedFieldProbeResult, fieldProbeSpotGap, computeFieldProbePreview,
  },
});

const outlineCaptureOperations = createOutlineCaptureOperations({
  state,
  constants: { JOG_INPUT_DEADZONE, OUTLINE_CAPTURE_SETTLE_MS, OUTLINE_CAPTURE_POLL_MS, OUTLINE_CAPTURE_TIMEOUT_MS },
  performanceRef: performance,
  setTimeoutRef: setTimeout,
  DateRef: Date,
  callbacks: {
    currentOutlineCapturePosition, cancelOutlineCaptureIntents, defaultOutlineState,
    markGcodeContextOverlayDirty, finiteOr, cloneFloorProbe, cloneOutlineOrigin,
    currentWorkOrigin, renderOutlineCapture, renderWorkArea, jogInputActive,
    tapMoveTargetBusy, hasPendingOriginOperation, jogEstimateActive,
    outlineCapturePositionsClose, pushOutlineUndo, newID, clearFieldProbeData,
    clearNotice, setStatusMessage, resetJogInputSender, sendJog, setOutlineFeedback,
    confirm: (message) => window.confirm(message), resolveOutlineCaptureIntent,
  },
});

function saveCommandHistory() {
  persistCommandHistory(state.commandHistory);
}

function rememberCommand(line) {
  const next = rememberCommandEntry(state.commandHistory, line);
  if (next === state.commandHistory || next.length === state.commandHistory.length && next.every((value, index) => value === state.commandHistory[index])) return;
  state.commandHistory = next;
  state.historyIndex = -1;
  saveCommandHistory();
}

function saveSurfaceViewPreferences() {
  persistSurfaceViewPreferences(state.surface);
}

async function refreshJobs() {
  return filesFeature.refreshJobs();
}

function pendingCount() {
  const n = Number(state.machine?.pending_jobs);
  return Number.isFinite(n) ? n : queuePendingCount();
}

// Job controls intentionally take spindle authority from the server-side job
// context. The browser may use the observed state as a compatibility fallback
// for existing Pause/Resume/Stop endpoints, but it never guesses a spindle
// speed or direction for Start.
function syncJogAvailabilityFromMachine(m) {
  syncJogAvailabilityState(m, state.jog, () => movementOwnedElsewhere());
}

function movementOwnedElsewhere(j = state.jog) {
  return !j.armed && j.availability?.reason === "busy";
}

function renderJog() {
  return jogView?.renderJog();
}

function movementArmAvailable() {
  return movementArmAvailableState(state.jog, machineReadyForOriginSet, movementOwnedElsewhere);
}

function movementArmLabel(j = state.jog) {
  return movementArmLabelState(j);
}

async function setAutoVacuum(enabled) {
  const current = dashboardOptionalNumber(state.machine?.spindle?.vacuum_mode);
  if (state.autoVacuumPending || current === null || state.readOnly) return;
  state.autoVacuumPending = true;
  renderSurfaceQuickActions();
  try {
    const response = await request("/api/outputs/auto-vacuum", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !!enabled }),
    });
    const result = await response.json();
    if (state.machine?.spindle) state.machine.spindle.vacuum_mode = result.enabled ? 1 : 0;
    clearNotice("auto-vacuum");
    setTimeout(pollMachine, 1200);
  } catch (e) {
    appendGcodeLine({ seq: "local-" + Date.now(), dir: "recv", source: "api", text: "error: " + e.message });
    setNotice("Auto Vacuum could not be updated: " + e.message, "error", "auto-vacuum");
  } finally {
    state.autoVacuumPending = false;
    renderSurfaceQuickActions();
  }
}

function toggleSurfaceMovementArm() {
  if (movementOwnedElsewhere() && !confirm("Another controller has armed movement. Disarm that session before taking control?")) return false;
  toggleTapMoveArm();
  return true;
}

function sendSurfaceStep(axis, sign, source = "button", explicitDistance = 0) {
  if (state.jog.surfaceStepPending) return false;
  if (!surfaceJogBaseReady()) {
    setStatusMessage("surface-jog", "Arm Movement after a fresh Idle status before jogging.", "error", { force: true });
    return false;
  }
  const magnitude = Number(explicitDistance) > 0 ? Number(explicitDistance) : surfaceStepDistance();
  const distance = magnitude * (sign < 0 ? -1 : 1);
  const seq = sendJog({ type: "step", axis, distance });
  if (!seq) {
    setStatusMessage("surface-jog", "Jog service is not connected.", "error", { force: true });
    connectJog();
    return false;
  }
  state.jog.surfaceStepPending = seq;
  state.jog.surfaceStepSource = source;
  state.jog.zStepLabel = `${axis.toUpperCase()}${distance >= 0 ? "+" : "−"} ${Math.abs(distance)}${surfaceStepUnit(axis) === "°" ? "°" : " mm"}`;
  if (source === "mpg") {
    if (!state.jog.surfaceWheel.gestureSteps) {
      setStatusMessage("surface-jog", `MPG ${axis.toUpperCase()} active...`, "", { timeoutMs: 0, force: true });
    }
    renderSurfaceMPGWheel();
  } else {
    setStatusMessage("surface-jog", "Sending " + state.jog.zStepLabel + "...", "", { timeoutMs: 0, force: true });
    renderJog();
  }
  return true;
}

function beginSurfaceHoldJog(axis, sign) {
  if (!surfaceJogReady()) {
    setStatusMessage("surface-jog", "Arm Movement after a fresh Idle status before jogging.", "error", { force: true });
    return false;
  }
  state.jog.surfaceInput = { axis, sign: sign < 0 ? -1 : 1 };
  state.jog.pad = "Surface";
  state.jog.deadman = true;
  state.jog.axes = { x: axis === "x" ? (sign < 0 ? -1 : 1) : 0, y: axis === "y" ? (sign < 0 ? -1 : 1) : 0, z: axis === "z" ? (sign < 0 ? -1 : 1) : 0, a: axis === "a" ? (sign < 0 ? -1 : 1) : 0 };
  setStatusMessage("surface-jog", "Jogging " + axis.toUpperCase() + "; release to stop.", "", { timeoutMs: 0, force: true });
  sendJogInput({ deadman: true, axes: state.jog.axes }, true);
  renderJog();
  return true;
}

function stopSurfaceHoldJog() {
  if (!state.jog.surfaceInput) return false;
  state.jog.surfaceInput = null;
  state.jog.pad = "";
  state.jog.deadman = false;
  state.jog.axes = { x: 0, y: 0, z: 0, a: 0 };
  if (state.jog.armed) sendJogInput({ deadman: false, axes: state.jog.axes }, true);
  clearNotice("surface-jog");
  renderJog();
  return true;
}

const actionPresses = new WeakMap();
const actionSuppressClicks = new WeakMap();

function bindButtonAction(el, handler) {
  if (!el || el.dataset.actionBound === "true") return;
  el.dataset.actionBound = "true";
  el.addEventListener("pointerdown", (e) => {
    if (typeof e.button === "number" && e.button !== 0) return;
    if (el.disabled) return;
    actionPresses.set(el, { pointerId: e.pointerId, x: e.clientX, y: e.clientY });
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // Pointer capture is best-effort; the click fallback remains in place.
    }
  });
  el.addEventListener("pointerup", (e) => {
    const press = actionPresses.get(el);
    if (!press || press.pointerId !== e.pointerId) return;
    actionPresses.delete(el);
    if (el.disabled) return;
    const dx = Math.abs(e.clientX - press.x);
    const dy = Math.abs(e.clientY - press.y);
    const releaseTarget = document.elementFromPoint(e.clientX, e.clientY);
    if (dx > 12 || dy > 12 || (releaseTarget && !el.contains(releaseTarget))) return;
    actionSuppressClicks.set(el, performance.now());
    e.preventDefault();
    handler(e);
  });
  el.addEventListener("pointercancel", (e) => {
    const press = actionPresses.get(el);
    if (press && press.pointerId === e.pointerId) actionPresses.delete(el);
  });
  el.addEventListener("click", (e) => {
    const last = actionSuppressClicks.get(el) || 0;
    if (performance.now() - last < 700) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (el.disabled) return;
    handler(e);
  });
}

function jogPanelMessage() {
  const j = state.jog;
  if (j.error) return { text: jogErrorText(j.error), kind: "error" };
  if (j.link !== "online") return { text: "", kind: "" };
  if (movementOwnedElsewhere(j)) {
    return { text: j.availability.message || jogErrorText("busy"), kind: "" };
  }
  if (!j.armed && j.availability && !j.availability.available) {
    return { text: j.availability.message || jogErrorText(j.availability.reason), kind: "error" };
  }
  return { text: "", kind: "" };
}

function jogErrorText(err) {
  switch (err) {
  case "disabled":
    return "Jogging is disabled.";
  case "busy":
    return "Movement control is held by another UI. Disarm it before taking control.";
  case "not_idle":
    return "Machine is not Idle. Wait for fresh Idle status, then arm jog again.";
  case "stale_status":
    return "Machine status or position is stale. Wait for a fresh status report before jogging.";
  case "status_waiting":
    return "Waiting for fresh machine status before continuing jog.";
  case "controller_waiting":
    return "The controller requested the machine. Jog was disarmed; wait for Idle, then arm again.";
  case "machine_error":
    return "Machine I/O failed. Check the log, wait for reconnect, then arm again.";
  case "bad_input":
    return "Invalid jog input from the browser.";
  default:
    return err || "";
  }
}

const OUTLINE_FIELD_SPACING_DEBOUNCE_MS = 450;
let outlineFieldSpacingTimer = null;

function currentAxisValues() {
  const preferJog = state.jog.armed || state.jog.originPendingMode === "jog" || !!state.jog.targetPending || !!state.jog.targetMotionPending || !!state.jog.zStepPending;
  return {
    mpos: preferJog ? (state.jog.mpos || state.machine.mpos) : (state.machine.mpos || state.jog.mpos),
    wpos: preferJog ? (state.jog.wpos || state.machine.wpos) : (state.machine.wpos || state.jog.wpos),
  };
}

function tapMoveTargetBusy() {
  return !!state.jog.targetPending || !!state.jog.targetMotionPending;
}

function currentWorkOrigin() {
  const { mpos, wpos } = currentAxisValues();
  const out = {};
  let have = false;
  for (const axis of ["x", "y", "z"]) {
    const m = axisValue(mpos, axis);
    const w = axisValue(wpos, axis);
    if (m === null || w === null) continue;
    out[axis] = m - w;
    have = true;
  }
  return have ? out : null;
}

function visualWorkOrigin() {
  const live = currentWorkOrigin();
  if (axisValue(live, "x") !== null && axisValue(live, "y") !== null) return live;
  return state.ui.machine?.origin || defaultMachineSettings().origin;
}

function setWorkAreaToolRadius() {
  const radius = (SPINDLE_DIAMETER_MM / 2) * workAreaMMToSVGUnits();
  for (const id of ["workarea-spindle-marker", "workarea-target-marker"]) {
    const el = document.getElementById(id);
    if (el) el.setAttribute("r", radius.toFixed(3));
  }
}

function markGcodeContextOverlayDirty() {
  outlineContextRevision++;
}

function pushOutlineUndo() {
  const o = state.outline;
  o.undo.push(outlineSnapshot());
  if (o.undo.length > 100) o.undo.shift();
  o.redo = [];
}

function currentOutlineCapturePosition() {
  const { mpos, wpos } = currentAxisValues();
  const mx = axisValue(mpos, "x");
  const my = axisValue(mpos, "y");
  const mz = axisValue(mpos, "z");
  const wx = axisValue(wpos, "x");
  const wy = axisValue(wpos, "y");
  const wz = axisValue(wpos, "z");
  if (mx !== null && my !== null && wx !== null && wy !== null && wz !== null) {
    const origin = { x: mx - wx, y: my - wy };
    if (mz !== null) origin.z = mz - wz;
    return {
      machine: { x: mx, y: my, z: mz },
      work: { x: wx, y: wy, z: wz },
      origin,
    };
  }
  const origin = state.outline.origin || currentWorkOrigin();
  const ox = axisValue(origin, "x");
  const oy = axisValue(origin, "y");
  const oz = axisValue(origin, "z");
  if (mx !== null && my !== null && mz !== null && ox !== null && oy !== null && oz !== null) {
    return {
      machine: { x: mx, y: my, z: mz },
      work: { x: mx - ox, y: my - oy, z: mz - oz },
      origin,
    };
  }
  return null;
}

function startOutlineCapture() { return outlineCaptureOperations.startOutlineCapture(); }
function endOutlineCapture() { return outlineCaptureOperations.endOutlineCapture(); }

function outlineCaptureMotionPending() { return outlineCaptureOperations.outlineCaptureMotionPending(); }
function waitForOutlineCapturePosition(options = {}) { return outlineCaptureOperations.waitForOutlineCapturePosition(options); }
function processOutlinePointQueue(o) { return outlineCaptureOperations.processOutlinePointQueue(o); }

function capturedOutlinePosition(position) {
  return normalizeCapturedOutlinePosition(position);
}

function failOutlineCaptureIntents(message) { return outlineCaptureOperations.failOutlineCaptureIntents(message); }
function requestOutlinePositionCapture(o) { return outlineCaptureOperations.requestOutlinePositionCapture(o); }
function addOutlinePoint() { return outlineCaptureOperations.addOutlinePoint(); }

function closeOutline() { return closeOutlineFeature(); }
function undoOutline() { return undoOutlineFeature(); }
function redoOutline() { return redoOutlineFeature(); }

function renderOutlineCapture() {
  return outlineView?.renderOutlineCapture();
}

function toggleOutlineCurveFit() {
  state.outline.curveFit = !!document.getElementById("outline-curve-fit")?.checked;
  clearFieldProbeData();
  updateFieldProbePreview();
  renderOutlineCapture();
  renderWorkArea();
}

function commitOutlineFieldSpacingDraft() {
  const input = document.getElementById("outline-field-spacing");
  const raw = String(input?.value ?? "").trim();
  const value = Number(raw);
  if (!input || raw === "" || !Number.isFinite(value)) {
    if (input) {
      input.setCustomValidity("Enter a number.");
      input.reportValidity?.();
    }
    return false;
  }
  input.setCustomValidity("");
  state.outline.fieldSpotGapMM = Math.max(0, Math.min(250, value));
  return true;
}

function cancelOutlineFieldSpacingUpdate() {
  if (outlineFieldSpacingTimer === null) return;
  clearTimeout(outlineFieldSpacingTimer);
  outlineFieldSpacingTimer = null;
}

function flushOutlineFieldSpacingUpdate(render = true) {
  cancelOutlineFieldSpacingUpdate();
  if (!commitOutlineFieldSpacingDraft()) return false;
  const input = document.getElementById("outline-field-spacing");
  clearControlDrafts(input);
  clearFieldProbeData(true);
  updateFieldProbePreview();
  if (state.outline.fieldProbeIssue) {
    setStatusMessage("outline-plan", state.outline.fieldProbeIssue + ".", "error", { force: true });
  }
  if (render) {
    renderOutlineCapture();
    renderWorkArea();
  }
  return true;
}

function scheduleOutlineFieldSpacingUpdate() {
  if (!commitOutlineFieldSpacingDraft()) {
    cancelOutlineFieldSpacingUpdate();
    return false;
  }
  cancelOutlineFieldSpacingUpdate();
  outlineFieldSpacingTimer = setTimeout(() => {
    outlineFieldSpacingTimer = null;
    flushOutlineFieldSpacingUpdate();
  }, OUTLINE_FIELD_SPACING_DEBOUNCE_MS);
  return true;
}

async function resetSelectedFieldProbeValue() { return fieldProbing.resetSelectedFieldProbeValue(); }

function moveToSelectedFieldProbePoint() { return fieldProbing.moveToSelectedFieldProbePoint(); }

function updateSelectedFieldProbeDrag(local) { return fieldProbing.updateSelectedFieldProbeDrag(local); }
function restoreSelectedFieldProbePosition(original) { return fieldProbing.restoreSelectedFieldProbePosition(original); }
async function finishSelectedFieldProbeMove(original) { return fieldProbing.finishSelectedFieldProbeMove(original); }
function moveSelectedFieldProbePointBy(dx, dy) { return fieldProbing.moveSelectedFieldProbePointBy(dx, dy); }

function updateFieldProbePreview() { return fieldProbing.updateFieldProbePreview(); }

// Return the exact covering radius for this finite probe set over the polygon.
// In the interior, every local maximum of the nearest-site distance is a
// Voronoi vertex, hence the circumcenter of a Delaunay triangle. On a polygon
// edge, all squared point distances share the same quadratic term; their lower
// envelope changes only where two affine remainders cross. Evaluating those
// breakpoints makes the boundary result exact as well—there is no raster/grid
// resolution hidden in this certificate.


// Exhaustively certify the first reconstruction layer. For every consecutive
// pair of physical boundary probes, choose the field probe that minimizes the
// longer of its two incident triangle edges. This directly measures the
// boundary-to-field moat that a global nearest-neighbour score can hide.

async function probeZAtWorkPoint(workPoint, opts = {}) { return fieldProbing.probeZAtWorkPoint(workPoint, opts); }
function rebaseOutlineToFloor(machineZ) { return fieldProbing.rebaseOutlineToFloor(machineZ); }
async function probeFloor() { return fieldProbing.probeFloor(); }
async function runFieldProbe() { return fieldProbing.runFieldProbe(); }
function traceOutlineMachinePoints(origin) { return fieldProbing.traceOutlineMachinePoints(origin); }
async function traceOutline() { return fieldProbing.traceOutline(); }

function exportOutline() { return exportOutlineFeature(); }

function outlineJSONDocument() {
  return buildOutlineJSONDocument(state.outline, {
    cloneOutlinePoint,
    cloneOutlineOrigin,
    cloneFloorProbe,
    fieldProbeSpotGap,
  });
}

function saveOutlineJSON() {
  return saveOutlineJSONFeature();
}

async function loadOutlineFile(file) {
  return loadOutlineFileFeature(file);
}

function installLoadedOutlineState(next) {
  return installLoadedOutlineStateFeature(next);
}

function outlineStateFromJSON(doc) {
  return parseOutlineStateFromJSON(doc, {
    defaultOutlineState,
    cloneFloorProbe,
    newID,
    axisValue,
    maxEffectiveOutlinePoints: MAX_EFFECTIVE_OUTLINE_POINTS,
    maxFieldProbePoints: MAX_FIELD_PROBE_POINTS,
    defaultFieldSpotGapMM: DEFAULT_FIELD_SPOT_GAP_MM,
  });
}

function floorProbeFromJSON(raw) {
  return parseFloorProbeFromJSON(raw, { cloneFloorProbe });
}

function outlineOriginFromJSON(raw) {
  return parseOutlineOriginFromJSON(raw);
}

function boundedOutlineNumber(value, min, max, fallback) {
  return boundOutlineNumber(value, min, max, fallback);
}

function outlinePointFromJSON(raw, index) {
  return parseOutlinePointFromJSON(raw, index, { newID });
}

function downloadBlob(filename, content, type) {
  return downloadOutlineBlob(filename, content, type);
}

function exportWorkOrigin() {
  for (const candidate of [currentWorkOrigin(), state.outline.origin]) {
    const origin = cloneOutlineOrigin(candidate);
    if (axisValue(origin, "x") !== null && axisValue(origin, "y") !== null) return origin;
  }
  throw new Error("current XY work origin is unavailable");
}

function requireHeightExportOutline() {
  const outline = arguments.length ? arguments[0] : state.outline;
  if (!outline.closed || outline.points.length < 3) {
    throw new Error("closed outline needs at least three points");
  }
}

function buildOutlineDXF() {
  const outline = state.outline;
  return buildOutlineDXFDocument({
    stateSnapshot: {
      closed: !!outline.closed,
      curveFit: !!outline.curveFit,
      points: outline.points.map((point) => ({ ...point })),
    },
    exportWorkOrigin,
    outlineEffectiveExportPoints,
    outlineExportPoints,
    dxfNumber,
    dxfBounds,
    dxfPairs,
    addOutlinePolylineDXF,
  });
}

function outlineExportPoints(origin, outlineState = state.outline) {
  return outlineExportPointsDocument(origin, outlineState, axisValue);
}

function outlineEffectiveExportPoints(origin, outlineState = state.outline) {
  return outlineEffectiveExportPointsDocument(origin, outlineState, axisValue, effectiveOutlineGeometry);
}

function fieldProbeExportPoints(origin, outlineState = state.outline) {
  return fieldProbeExportPointsDocument(origin, outlineState, axisValue, fieldProbeHeightReference);
}

function fieldProbeHeightReference(origin, outlineState = state.outline) {
  return fieldProbeHeightReferenceDocument(origin, outlineState, finiteOr, axisValue);
}

function exportHeightOBJ() { return exportHeightOBJFeature(); }

function buildHeightOBJ() {
  return buildHeightOBJDocument({
    getOutline: () => state.outline,
    requireHeightExportOutline: (outline) => requireHeightExportOutline(outline),
    exportWorkOrigin: () => exportWorkOrigin(),
    outlineEffectiveExportPoints: (origin, outline) => outlineEffectiveExportPoints(origin, outline),
    fieldProbeExportPoints: (origin, outline) => fieldProbeExportPoints(origin, outline),
    buildHeightMeshVertices: (samples, outline) => buildHeightMeshVertices(samples, outline),
    constrainedOutlineTriangles: (points, outline) => constrainedOutlineTriangles(points, outline),
    orderedOutlineBoundaryIndices: (points, outline) => orderedOutlineBoundaryIndices(points, outline),
    solidifyHeightMesh: (...args) => solidifyHeightMesh(...args),
    fieldProbeHeightReference: (origin, outline) => fieldProbeHeightReference(origin, outline),
    axisValue: (...args) => axisValue(...args),
    pathNum: (...args) => pathNum(...args),
  });
}

function solidifyHeightMesh(...args) {
  return solidifyHeightMeshDocument(...args);
}

function buildHeightMeshVertices(samples, outline) {
  return buildHeightMeshVerticesDocument(samples, outline, interpolateZDocument);
}


function constrainedOutlineTriangles(points, outline) {
  return constrainedOutlineTrianglesDocument(points, outline);
}

function orderedOutlineBoundaryIndices(points, outline) {
  return orderedOutlineBoundaryIndicesDocument(points, outline);
}


function exportHeightImage() { return exportHeightImageFeature(); }

function buildHeightPGM() {
  return buildHeightPGMDocument({
    getOutline: () => state.outline,
    requireHeightExportOutline,
    exportWorkOrigin,
    buildInterpolatedHeightGrid,
    fieldProbeHeightReference,
    axisValue,
    pathNum,
    fieldProbeSpotGap,
    PROBE_SPOT_DIAMETER_MM,
  });
}

function buildInterpolatedHeightGrid(origin, outlineState = state.outline) {
  return buildInterpolatedHeightGridDocument({
    origin,
    getOutline: () => outlineState,
    requireHeightExportOutline,
    outlineExportPoints,
    outlineEffectiveExportPoints,
    fieldProbeExportPoints,
    exportExtents: exportExtentsDocument,
    fieldProbeSpotGap,
    fieldProbeCenterSpacing,
    pointInPolygonOrBoundary,
    interpolateZ: interpolateZDocument,
  });
}

function interpolateZ(x, y, samples) {
  return interpolateZDocument(x, y, samples);
}


function renderActiveGcode(...args) {
  return activeJobView?.renderActiveGcode(...args);
}

function renderActiveGcodeControls(...args) {
  return activeJobView?.renderActiveGcodeControls(...args);
}

function activeGcodeDisplaySegments(active) {
  const activeGcodeGeometry = gcodeViewer.getActiveGcodeGeometry();
  if (activeGcodeGeometry.signature === activeGcodeSourceSignature(active)) {
    return activeGcodeGeometry.segments;
  }
  return Array.isArray(active?.preview?.overview_segments) ? active.preview.overview_segments : [];
}

function dashboardGcodeWindow(...args) { return gcodeViewer.dashboardGcodeWindow(...args); }

function renderDashboardGcodeStream(...args) { return gcodeViewer.renderDashboardGcodeStream(...args); }

function dashboardCameraShouldRun() {
  return dashboardCamera.dashboardCameraShouldRun();
}

function dashboardCameraPrimary() {
  return dashboardCamera.dashboardCameraPrimary();
}

function renderDashboardCameraConfig() {
  return dashboardCamera.renderDashboardCameraConfig();
}

function syncDashboardCameras() {
  return dashboardCamera.syncDashboardCameras();
}

function loadDashboardCameras() {
  return dashboardCamera.loadDashboardCameras();
}

function bindDashboardCameraSwitches() {
  return dashboardCamera.bindDashboardCameraSwitches();
}

function stopDashboardBuiltinCamera() {
  return dashboardCamera.stopDashboardBuiltinCamera();
}

function stopDashboardExternalCamera() {
  return dashboardCamera.stopDashboardExternalCamera();
}


function bindDashboardToolpathShortcut() {
  const preview = document.getElementById("dashboard-toolpath-fallback");
  if (!preview) return;
  const open = () => showTab("active-job");
  preview.addEventListener("click", open);
  preview.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    open();
  });
}

function renderDashboard() {
  return dashboardView?.renderDashboard();
}

function drawDashboardGcodePreview(...args) { return gcodeViewer.drawDashboardGcodePreview(...args); }

function dashboardGcodeRenderStateKey(...args) { return gcodeViewer.dashboardGcodeRenderStateKey(...args); }

function activeGcodeSourceSignature(...args) { return gcodeViewer.activeGcodeSourceSignature(...args); }

// A running job updates progress metadata for every executed G-code line. That
// is deliberately not part of the camera identity: rebuilding the line mesh is
// fine when its detail level changes, but an operator's orbit/zoom must remain
// intact until the selected file itself changes.
function gcodeCameraFitKey(...args) { return gcodeViewer.gcodeCameraFitKey(...args); }

function ensureActiveGcodeGeometry(...args) { return gcodeViewer.ensureActiveGcodeGeometry(...args); }

function splitGcodeSourceLines(...args) { return gcodeViewer.splitGcodeSourceLines(...args); }

function ensureActiveGcodeSource(...args) { return gcodeViewer.ensureActiveGcodeSource(...args); }

function resetActiveGcodeSource(...args) { return gcodeViewer.resetActiveGcodeSource(...args); }

function fetchActiveGcodeSourcePage(...args) { return gcodeViewer.fetchActiveGcodeSourcePage(...args); }

function activeGcodeSourceLine(...args) { return gcodeViewer.activeGcodeSourceLine(...args); }

function gcodeSourceWindow(...args) { return gcodeViewer.gcodeSourceWindow(...args); }

function scheduleActiveGcodeSourceRender(...args) { return gcodeViewer.scheduleActiveGcodeSourceRender(...args); }

function renderActiveGcodeSource(...args) { return gcodeViewer.renderActiveGcodeSource(...args); }

function gcodeSourceLineForCursor(...args) { return gcodeViewer.gcodeSourceLineForCursor(...args); }

function syncActiveGcodeSourceLine(...args) { return gcodeViewer.syncActiveGcodeSourceLine(...args); }

function scrollActiveGcodeSourceToLine(...args) { return gcodeViewer.scrollActiveGcodeSourceToLine(...args); }

function activeJobOverlayOriginFrom(...args) { return gcodeViewer.activeJobOverlayOriginFrom(...args); }

function activeJobOverlayOrigin(...args) { return gcodeViewer.activeJobOverlayOrigin(...args); }

function activeJobOverlayPoint(...args) { return gcodeViewer.activeJobOverlayPoint(...args); }

function probePlanMatchesResults(...args) { return gcodeViewer.probePlanMatchesResults(...args); }

function activeJobFieldProbeComplete(...args) { return gcodeViewer.activeJobFieldProbeComplete(...args); }

function interpolateOutlinePathZ(...args) { return gcodeViewer.interpolateOutlinePathZ(...args); }

function activeJobContextOverlayData(...args) { return gcodeViewer.activeJobContextOverlayData(...args); }

function activeJobOverlayBounds(...args) { return gcodeViewer.activeJobOverlayBounds(...args); }

function combineGcodeBounds(...args) { return gcodeViewer.combineGcodeBounds(...args); }

function activeJobContextOverlayKey(...args) { return gcodeViewer.activeJobContextOverlayKey(...args); }

function syncGcodeContextOverlay(...args) { return gcodeViewer.syncGcodeContextOverlay(...args); }

function rebuildGcodeContextOverlay(...args) { return gcodeViewer.rebuildGcodeContextOverlay(...args); }

function rebuildGcodeContextOverlayForGroup(...args) { return gcodeViewer.rebuildGcodeContextOverlayForGroup(...args); }

function drawGcodePreview(preview, live = null) { return gcodeViewer.drawGcodePreview(preview, live); }

function gcodeRenderPixelRatio(...args) { return gcodeViewer.gcodeRenderPixelRatio(...args); }

function ensureGcodeViewer(...args) { return gcodeViewer.ensureGcodeViewer(...args); }

function ensureDashboardGcodeViewer(...args) { return gcodeViewer.ensureDashboardGcodeViewer(...args); }

function clearDashboardGcodeScene(...args) { return gcodeViewer.clearDashboardGcodeScene(...args); }

function setDashboardGcodePreviewEmpty(...args) { return gcodeViewer.setDashboardGcodePreviewEmpty(...args); }

function fitDashboardGcodeCamera(...args) { return gcodeViewer.fitDashboardGcodeCamera(...args); }

function updateDashboardGcodeCamera(...args) { return gcodeViewer.updateDashboardGcodeCamera(...args); }

function syncDashboardGcodeProjection(...args) { return gcodeViewer.syncDashboardGcodeProjection(...args); }

function scheduleDashboardGcodeRender(...args) { return gcodeViewer.scheduleDashboardGcodeRender(...args); }

function renderDashboardGcodeScene(...args) { return gcodeViewer.renderDashboardGcodeScene(...args); }

function bindGcodeOrbitControls(...args) { return gcodeViewer.bindGcodeOrbitControls(...args); }

function gcodePinchDistance(...args) { return gcodeViewer.gcodePinchDistance(...args); }

function gcodeOrbitRadiusAfterPinch(...args) { return gcodeViewer.gcodeOrbitRadiusAfterPinch(...args); }

function gcodeOrbitRadiusAfterWheel(...args) { return gcodeViewer.gcodeOrbitRadiusAfterWheel(...args); }

function rotateGcodeOrbitByDrag(...args) { return gcodeViewer.rotateGcodeOrbitByDrag(...args); }

function isTypingTarget(...args) { return gcodeViewer.isTypingTarget(...args); }

function rebuildGcodeScene(...args) { return gcodeViewer.rebuildGcodeScene(...args); }

function populateGcodePathScene(...args) { return gcodeViewer.populateGcodePathScene(...args); }

function addGcodeGrid(...args) { return gcodeViewer.addGcodeGrid(...args); }

function addGcodeGridToView(...args) { return gcodeViewer.addGcodeGridToView(...args); }

function buildGcodeOriginAxes(...args) { return gcodeViewer.buildGcodeOriginAxes(...args); }

function makeGcodeAxisLabel(...args) { return gcodeViewer.makeGcodeAxisLabel(...args); }

function clearGcodeScene(...args) { return gcodeViewer.clearGcodeScene(...args); }

function clearThreeGroup(group) {
  if (!group) return;
  while (group.children.length) {
    const child = group.children.pop();
    disposeObject(child);
  }
}

function disposeObject(obj) {
  if (!obj) return;
  if (obj.parent) obj.parent.remove(obj);
  obj.traverse((node) => {
    if (node.geometry) node.geometry.dispose();
    const materials = Array.isArray(node.material) ? node.material : node.material ? [node.material] : [];
    for (const material of materials) {
      if (material.map) material.map.dispose();
      material.dispose();
    }
  });
}

function fitGcodeCamera(...args) { return gcodeViewer.fitGcodeCamera(...args); }

function panGcodeCamera(dx, dy) {
  const gcodeView = gcodeViewer.getGcodeView();
  const camera = gcodeView.camera;
  const canvas = gcodeView.canvas;
  if (!camera || !canvas) return;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  const distance = Math.max(0.001, camera.position.distanceTo(gcodeView.target));
  const viewHeight = camera.isOrthographicCamera
    ? camera.top - camera.bottom
    : 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * distance;
  const viewWidth = camera.isOrthographicCamera ? camera.right - camera.left : viewHeight * camera.aspect;
  camera.updateMatrixWorld();
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
  gcodeView.target.addScaledVector(right, -dx * viewWidth / width);
  gcodeView.target.addScaledVector(up, dy * viewHeight / height);
  updateGcodeCamera();
}

function updateGcodeCamera(...args) { return gcodeViewer.updateGcodeCamera(...args); }

function syncGcodeProjection(...args) { return gcodeViewer.syncGcodeProjection(...args); }

function setGcodeProjection(...args) { return gcodeViewer.setGcodeProjection(...args); }

function bindGcodeProjectionToggle(...args) { return gcodeViewer.bindGcodeProjectionToggle(...args); }

// View cube axes are main-scene world axes: +x right, +y top, +z front
// (machine X+ right, Z+ up, Y+ toward the back).
const VIEWCUBE_FACES = [
  { label: "RIGHT", rotation: 0 },
  { label: "LEFT", rotation: 0 },
  { label: "TOP", rotation: 0 },
  { label: "BOTTOM", rotation: 0 },
  { label: "FRONT", rotation: 0 },
  { label: "BACK", rotation: 0 },
];

function initGcodeViewCube(...args) { return gcodeViewer.initGcodeViewCube(...args); }

function makeViewCubeFaceTexture(...args) { return gcodeViewer.makeViewCubeFaceTexture(...args); }

function renderGcodeViewCube(...args) { return gcodeViewer.renderGcodeViewCube(...args); }

function syncGcodeViewCubeResolution(...args) { return gcodeViewer.syncGcodeViewCubeResolution(...args); }

function viewCubeTargetComponents(...args) { return gcodeViewer.viewCubeTargetComponents(...args); }

function gcodeViewCubeTarget(...args) { return gcodeViewer.gcodeViewCubeTarget(...args); }

function setGcodeViewCubeHover(...args) { return gcodeViewer.setGcodeViewCubeHover(...args); }

function viewCubeHoverGeometry(...args) { return gcodeViewer.viewCubeHoverGeometry(...args); }

function clearGcodeViewCubeHover(...args) { return gcodeViewer.clearGcodeViewCubeHover(...args); }

function onGcodeViewCubePointerDown(...args) { return gcodeViewer.onGcodeViewCubePointerDown(...args); }

function onGcodeViewCubePointerMove(...args) { return gcodeViewer.onGcodeViewCubePointerMove(...args); }

function gcodeCubeDragStep(...args) { return gcodeViewer.gcodeCubeDragStep(...args); }

function finishGcodeViewCubeDrag(...args) { return gcodeViewer.finishGcodeViewCubeDrag(...args); }

function onGcodeViewCubePointerUp(...args) { return gcodeViewer.onGcodeViewCubePointerUp(...args); }

function onGcodeViewCubePointerCancel(...args) { return gcodeViewer.onGcodeViewCubePointerCancel(...args); }

function onGcodeViewCubeClick(...args) { return gcodeViewer.onGcodeViewCubeClick(...args); }

function snapGcodeViewTo(...args) { return gcodeViewer.snapGcodeViewTo(...args); }

function gcodeOrbitAnglesForDirection(...args) { return gcodeViewer.gcodeOrbitAnglesForDirection(...args); }

function gcodeTimelineLocallyOwned(...args) { return gcodeViewer.gcodeTimelineLocallyOwned(...args); }

function gcodeTimelineEventLabel(...args) { return gcodeViewer.gcodeTimelineEventLabel(...args); }

function gcodeTimelineEventMarkers(...args) { return gcodeViewer.gcodeTimelineEventMarkers(...args); }

function gcodeTimelineMarkerLabel(...args) { return gcodeViewer.gcodeTimelineMarkerLabel(...args); }

function setGcodeTimelineEventDetail(...args) { return gcodeViewer.setGcodeTimelineEventDetail(...args); }

function selectGcodeTimelineEvent(...args) { return gcodeViewer.selectGcodeTimelineEvent(...args); }

function renderGcodeTimelineEventList(...args) { return gcodeViewer.renderGcodeTimelineEventList(...args); }

function renderGcodeTimelineEvents(...args) { return gcodeViewer.renderGcodeTimelineEvents(...args); }

function updateGcodeTimeline(...args) { return gcodeViewer.updateGcodeTimeline(...args); }

function updateGcodeProgress() {
  const gcodeView = gcodeViewer.getGcodeView();
  const total = gcodeView.segments.length;
  gcodeView.cursor = Math.max(0, Math.min(total, gcodeView.cursor));
  if (gcodeView.progressLine) {
    gcodeView.progressLine.geometry.setDrawRange(0, gcodeView.cursor * 2);
  }
  const seg = gcodeView.segments[Math.max(0, gcodeView.cursor - 1)];
  const livePosition = gcodeView.followLive ? gcodeView.live?.position : null;
  const markerPosition = livePosition || seg?.to;
  if (markerPosition) {
    const p = gcodeWorldPoint(markerPosition, gcodeView.has4Axis);
    gcodeView.marker.position.copy(p);
    gcodeView.marker.scale.setScalar(Math.max(0.8, gcodeView.orbit.radius * 0.008));
    gcodeView.marker.visible = true;
  } else {
    gcodeView.marker.visible = false;
  }
  if (gcodeView.canvas) {
    const label = livePosition
      ? `Active gcode preview; live spindle at X ${fmtCoord(livePosition[0])}, Y ${fmtCoord(livePosition[1])}, Z ${fmtCoord(livePosition[2])}`
      : "Active gcode preview";
    gcodeView.canvas.setAttribute("aria-label", label);
  }
  updateGcodeTimeline(total);
  syncActiveGcodeSourceLine(gcodeView.live, gcodeView.timelineEventLine);
  scheduleGcodeRender();
}

function gcodeWorldCoordinates(...args) { return gcodeViewer.gcodeWorldCoordinates(...args); }

function gcodeWorldPoint(...args) { return gcodeViewer.gcodeWorldPoint(...args); }

function setGcodePreviewEmpty(...args) { return gcodeViewer.setGcodePreviewEmpty(...args); }

function scheduleGcodeRender(...args) { return gcodeViewer.scheduleGcodeRender(...args); }

function renderGcodeScene(...args) { return gcodeViewer.renderGcodeScene(...args); }

async function loadActiveGcode() {
  return activeJobLoader.loadActiveGcode();
}

function syncActiveGcodeFromMachine(machine) {
  const path = String(machine?.active_job?.path || "");
  if (!path || path === state.activeGcode?.path || state.activeGcodeLoading) return;
  loadActiveGcode();
}

async function runActiveGcode() {
  return activeJobRunner.runActiveGcode();
}

async function runActiveJobControl(action) {
  return activeJobControl.runActiveJobControl(action);
}

async function resumeActiveJob() { return resumeActiveJobOperation(); }

async function runJobControl(action) { return runJobControlOperation(action); }

async function runPausedJobCommand(action, options = {}) {
  return pausedJobCommand.runPausedJobCommand(action, options);
}

async function setFeedOverride(percent) { return setFeedOverrideOperationFn(percent); }

function adjustFeedOverride(delta) { return adjustFeedOverrideOperationFn(delta); }

function setActiveFeedback(text, kind) {
  setStatusMessage("active-gcode", text, kind, { force: true });
}

function appendGcodeLine(ln) { return appendGcodeLineOperation(ln); }

async function copyVisibleLog() { return copyVisibleLogOperation(); }

function exportVisibleLog() { return exportVisibleLogOperation(); }

async function exportBackup() { return exportBackupOperation(); }

async function importBackupFile(file) { return importBackupFileOperation(file); }



function completeCommandDisarm(seq, message = "") {
  const pending = state.jog.commandDisarm;
  if (!pending || pending.seq !== seq) return false;
  state.jog.commandDisarm = null;
  clearTimeout(pending.timer);
  if (message) pending.reject(new Error(message));
  else pending.resolve();
  return true;
}

function disarmTapMoveForCommand() {
  if (!state.jog.armed) return Promise.resolve();
  if (state.jog.commandDisarm) return state.jog.commandDisarm.promise;
  if (state.jog.link !== "online") return Promise.reject(new Error("Movement is not connected."));

  const seq = state.jog.seq++;
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  const pending = { seq, resolve, reject, promise, timer: null };
  state.jog.commandDisarm = pending;
  pending.timer = setTimeout(() => {
    if (completeCommandDisarm(seq, "Movement did not disarm before the command.")) {
      state.jog.tapFeedback = "Movement did not disarm before the command.";
      state.jog.tapFeedbackKind = "error";
      renderJog();
    }
  }, 2000);
  if (!sendJog({ type: "disarm", seq })) {
    completeCommandDisarm(seq, "Movement is not connected.");
    return promise;
  }
  state.jog.armPending = seq;
  state.jog.armPendingAction = "disarm";
  state.jog.tapFeedback = "Disarming Movement before command.";
  state.jog.tapFeedbackKind = "";
  renderJog();
  return promise;
}

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
    appendGcodeLine({ seq: "local-" + Date.now(), dir: "recv", source: "api", text: "error: " + e.message });
    if (opts.feedback) {
      setStatusMessage("gcode-command", `Manual command failed: ${e.message}`, "error", { force: true });
    }
    return false;
  }
}

// sendControl injects a realtime control action or explicit recovery action.
// Show immediate feedback because recovery commands may be sent while the log is
// filtered or the machine remains in Alarm until the next status poll.
async function sendControl(action) {
  const noticeKey = "control-" + action;
  state.controlPendingAction = action;
  if (action === "recover") state.lastControlResult = null;
  setControlButtonsPending(action, true);
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
    if (result) state.lastControlResult = result;
    setNotice(controlSuccessText(action, result), "ok", noticeKey);
    pollMachine();
    setTimeout(pollMachine, 1200);
  } catch (e) {
    if (action === "recover") {
      state.lastControlResult = { action, recovered: false, failed: true, message: e.message };
    }
    appendGcodeLine({ seq: "local-" + Date.now(), dir: "recv", source: "api", text: "error: " + e.message });
    setNotice(controlErrorText(action, e.message), "error", noticeKey);
  } finally {
    state.controlPendingAction = "";
    setControlButtonsPending(action, false);
    renderMachine();
  }
}

function setControlButtonsPending(action, pending) {
  const ids = {
    hold: "ctl-hold",
    resume: "ctl-resume",
    halt: "ctl-halt",
  };
  const buttons = Array.from(document.querySelectorAll("[data-control-action]"))
    .filter((btn) => btn.dataset.controlAction === action);
  const id = ids[action];
  if (id) {
    const btn = document.getElementById(id);
    if (btn) buttons.push(btn);
  }
  for (const btn of buttons) {
    btn.disabled = pending;
  }
}

function controlPendingText(action) {
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

function controlSuccessText(action, result = null) {
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

function controlErrorText(action, message) {
  return action + " failed: " + message;
}

function confirmControl(action) {
  switch (action) {
  case "recover":
    return confirm("Recover this alarm? Clear the physical cause first. For soft limits, the proxy will unlock and verify status; home before moving afterward.");
  case "unlock":
    return confirm("Unlock the alarm? Clear the physical cause first. Home the machine before moving afterward.");
  case "home":
    return confirm("Home the machine now? Make sure the work area is clear.");
  case "reset":
    return confirm("Reset the machine controller? Reconnect and home the machine afterward.");
  default:
    return true;
  }
}

function bindDataControlButtons() {
  document.querySelectorAll("[data-control-action]").forEach((btn) => {
    bindButtonAction(btn, (e) => {
      e.preventDefault();
      const action = btn.dataset.controlAction;
      if (confirmControl(action)) sendControl(action);
    });
  });
}

async function loadJogCapabilities() {
  try {
    const r = await request("/api/jog/capabilities");
    state.jog.caps = await r.json();
    state.jog.availability = state.jog.caps.availability || null;
    clearConnectivityIssue("jog-capabilities");
    state.ui.machine = normalizeMachineSettings(state.ui.machine);
    if (state.jog.caps.enabled) connectJog();
    else disableJogConnection();
  } catch (e) {
    setConnectivityIssue("jog-capabilities", "Jog controls unavailable: " + e.message);
    state.jog.error = "";
    state.jog.errorCode = "";
    state.jog.link = "unavailable";
  }
  renderMachineSettings();
  renderJog();
}

function jogURL() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return proto + "//" + location.host + "/api/jog/ws";
}

function clearJogReconnect() {
  if (state.jog.reconnectTimer) {
    clearTimeout(state.jog.reconnectTimer);
    state.jog.reconnectTimer = null;
  }
}

function resetJogInputSender() {
  state.jog.lastInput = null;
  state.jog.lastInputSentAt = 0;
}

function clearDisconnectedJogInput() {
  resetMobileWorkAreaJog();
  state.jog.surfaceInput = null;
  if (state.jog.surfaceWheel) {
    state.jog.surfaceWheel.pointerId = null;
    state.jog.surfaceWheel.lastAngle = null;
    state.jog.surfaceWheel.remainder = 0;
    state.jog.surfaceWheel.gestureSteps = 0;
    state.jog.surfaceWheel.gestureAccepted = 0;
    state.jog.surfaceWheel.gestureReleased = false;
    state.jog.surfaceWheel.gestureAxis = "";
    state.jog.surfaceWheel.blocked = false;
  }
  state.jog.pad = "";
  state.jog.deadman = false;
  state.jog.axes = { x: 0, y: 0, z: 0, a: 0 };
  state.jog.buttons = [];
  state.jog.surfaceStepSource = "";
  resetJogInputSender();
}

function setTapFeedback(text, kind = "") {
  state.jog.tapFeedback = text;
  state.jog.tapFeedbackKind = kind;
  renderJog();
}

function consumeJogAlertFeedback(key, holder, textProp, kindProp) {
  const text = holder[textProp];
  if (!text) return;
  const kind = holder[kindProp];
  holder[textProp] = "";
  holder[kindProp] = "";
  if (kind === "error") setStatusMessage(key, text, kind, { force: true });
  else clearNotice(key);
}

function tapMoveArmProgressText(action) {
  return action === "arm" ? "Arming Movement..." : "Disarming Movement...";
}

function tapMoveArmSuccessText(action) {
  return action === "arm" ? "Movement armed." : "Movement disarmed.";
}

function tapMoveArmFailureText(action, detail) {
  const prefix = action === "disarm" ? "Disarm failed: " : "Arm failed: ";
  return prefix + detail;
}

function sendTapMoveArmAction(action) {
  const seq = sendJog({ type: action });
  if (!seq) {
    return false;
  }
  state.jog.armQueuedAction = "";
  state.jog.armPending = seq;
  state.jog.armPendingAction = action;
  state.jog.tapFeedback = tapMoveArmProgressText(action);
  state.jog.tapFeedbackKind = "";
  renderJog();
  return true;
}

function requestMovementDisarm() {
  if (state.jog.armQueuedAction === "arm") {
    state.jog.armQueuedAction = "";
    state.jog.tapFeedback = "Movement remains disarmed.";
    state.jog.tapFeedbackKind = "ok";
    renderJog();
    return true;
  }
  releaseJogInput(true);
  if (state.jog.armPending) {
    if (state.jog.armPendingAction === "arm") {
      state.jog.disarmAfterPendingArm = true;
      state.jog.tapFeedback = "Waiting to disarm Movement.";
      state.jog.tapFeedbackKind = "";
      renderJog();
    }
    return true;
  }
  if (!state.jog.armed) return false;
  if (sendTapMoveArmAction("disarm")) return true;
  state.jog.tapFeedback = tapMoveArmFailureText("disarm", "jog service is not connected");
  state.jog.tapFeedbackKind = "error";
  renderJog();
  return false;
}

function disarmMovementOnControlExit(nextTab) {
  const movementView = state.activeTab === "control" || state.activeTab === "jog";
  if (!movementView || nextTab === state.activeTab) return false;
  return requestMovementDisarm();
}

function flushQueuedTapMoveArm() {
  const action = state.jog.armQueuedAction;
  if (!action || state.jog.armPending || state.jog.link !== "online") return false;
  return sendTapMoveArmAction(action);
}

function toggleTapMoveArm() {
  if (state.jog.armPending || state.jog.armQueuedAction) return;
  if (hasPendingOriginOperation()) {
    setTapFeedback("Finish setting origin before changing Movement arm state.", "error");
    return;
  }
  if (state.jog.caps && !state.jog.caps.enabled) {
    setTapFeedback(jogErrorText("disabled"), "error");
    return;
  }
  if (state.jog.link === "unsupported") {
    setTapFeedback("Jog service is unavailable in this browser.", "error");
    return;
  }
  if (movementOwnedElsewhere() && !confirm("Movement is armed in another controller. Disarm that controller's movement session?")) return;
  const action = (state.jog.armed || movementOwnedElsewhere()) ? "disarm" : "arm";
  if (state.jog.armed) releaseJogInput(true);
  if (state.jog.link !== "online") {
    state.jog.armQueuedAction = action;
    state.jog.tapFeedback = "Connecting to jog service...";
    state.jog.tapFeedbackKind = "";
    connectJog();
    renderJog();
    return;
  }
  if (!sendTapMoveArmAction(action)) {
    setTapFeedback("Jog service is not connected.", "error");
  }
}

function currentTapFeed() {
  const input = document.getElementById("tap-feed-mm-min");
  const fallback = state.ui.machine?.tap_feed_mm_min || defaultMachineSettings().tap_feed_mm_min;
  const bounds = feedBoundsFor(state.ui.machine);
  const raw = String(input?.value ?? "").trim();
  const value = raw === "" ? NaN : Number(raw);
  if (!Number.isFinite(value)) {
    input?.setCustomValidity("Enter a feed rate.");
    input?.reportValidity?.();
    throw new Error("Feed must be a number.");
  }
  input?.setCustomValidity("");
  return clampNumber(finiteOr(value, fallback), bounds.min, bounds.max);
}

function workMoveInput(axis) {
  return document.getElementById("work-move-" + axis);
}

function workMoveField(axis) {
  return document.querySelector('[data-work-move-axis="' + axis + '"]');
}

function workMoveInputIsLive(input) {
  return input?.dataset.dirty !== "1";
}

function renderWorkMoveFieldState(axis, input) {
  const field = workMoveField(axis);
  const reset = document.querySelector('[data-work-move-reset="' + axis + '"]');
  const live = workMoveInputIsLive(input);
  if (field) {
    field.classList.toggle("is-live", live);
    field.classList.toggle("is-stale", !live);
    field.dataset.workMoveState = live ? "live" : "stale";
    field.title = live
      ? "Work " + axis.toUpperCase() + " follows the current coordinate."
      : "Work " + axis.toUpperCase() + " is edited; reset to follow the current coordinate.";
  }
  if (reset) {
    reset.disabled = live;
    reset.title = "Reset Work " + axis.toUpperCase() + " to current coordinate";
    reset.setAttribute("aria-label", reset.title);
  }
}

function renderWorkMoveControls(originBusy = hasPendingOriginOperation()) {
  const { wpos } = currentAxisValues();
  const busy = tapMoveTargetBusy() || !!state.jog.zStepPending || originBusy;
  for (const axis of ["x", "y", "z"]) {
    const input = workMoveInput(axis);
    if (!input) continue;
    const value = axisValue(wpos, axis);
    if (workMoveInputIsLive(input) && !controlLocallyOwned(input)) {
      input.value = value === null ? "" : formatOriginValue(value);
    }
    input.disabled = busy;
    renderWorkMoveFieldState(axis, input);
  }
  const btn = document.getElementById("work-move-send");
  if (!btn) return;
  const ready = !!state.jog.caps?.enabled && state.jog.link === "online" && state.jog.armed && !busy;
  btn.disabled = busy;
  setSoftDisabled(btn, !busy && !ready);
}

function workMoveTargetLabel(workTargets) {
  const parts = ["x", "y", "z"]
    .filter((axis) => Number.isFinite(Number(workTargets?.[axis])))
    .map((axis) => axis.toUpperCase() + " " + formatOriginValue(workTargets[axis]));
  return "W " + parts.join(" ");
}

function resetWorkMoveInput(axis) {
  const input = workMoveInput(axis);
  if (!input) return;
  input.dataset.dirty = "0";
  renderWorkMoveControls();
}

function completeWorkCoordinateMove(seq) {
  if (!seq || seq !== state.jog.workMovePending) return false;
  state.jog.workMovePending = 0;
  clearControlDrafts("work-move-x", "work-move-y", "work-move-z");
  const { wpos } = currentAxisValues();
  for (const axis of ["x", "y", "z"]) {
    const value = axisValue(wpos, axis);
    const input = workMoveInput(axis);
    if (input && value !== null) input.value = formatOriginValue(value);
  }
  return true;
}

function cancelWorkCoordinateMove(seq) {
  if (!state.jog.workMovePending || (seq && seq !== state.jog.workMovePending)) return;
  state.jog.workMovePending = 0;
}

function clearFieldProbeMove(seq) {
  if (!state.jog.fieldProbeMovePending || (seq && seq !== state.jog.fieldProbeMovePending)) return;
  state.jog.fieldProbeMovePending = 0;
}

function workMoveTargetsFromInputs() {
  const origin = currentWorkOrigin();
  if (!origin) throw new Error("Current work origin is unavailable.");
  const machineTargets = {};
  const workTargets = {};
  for (const axis of ["x", "y", "z"]) {
    const input = workMoveInput(axis);
    const raw = String(input?.value || "").trim();
    if (raw === "") continue;
    const workValue = finiteOr(raw, NaN);
    if (!Number.isFinite(workValue)) throw new Error("Work " + axis.toUpperCase() + " must be a number.");
    const offset = axisValue(origin, axis);
    if (offset === null) throw new Error("Current " + axis.toUpperCase() + " work origin is unavailable.");
    machineTargets[axis] = workValue + offset;
    workTargets[axis] = workValue;
  }
  if (!Object.keys(machineTargets).length) throw new Error("Enter at least one work coordinate.");
  return { machineTargets, label: workMoveTargetLabel(workTargets) };
}

function sendWorkCoordinateMove() {
  if (state.jog.caps && !state.jog.caps.enabled) {
    setTapFeedback(jogErrorText("disabled"), "error");
    return;
  }
  if (state.jog.link !== "online") {
    setTapFeedback("Jog service is not connected.", "error");
    connectJog();
    return;
  }
  if (!state.jog.armed) {
    setTapFeedback("Arm Movement before moving to work coordinates.", "error");
    return;
  }
  if (tapMoveTargetBusy() || state.jog.zStepPending || hasPendingOriginOperation()) return;
  let move;
  try {
    move = workMoveTargetsFromInputs();
  } catch (e) {
    setTapFeedback(e.message, "error");
    return;
  }
  let feed;
  try {
    feed = currentTapFeed();
  } catch (e) {
    setTapFeedback(e.message, "error");
    return;
  }
  const machine = normalizeMachineSettings(state.ui.machine);
  const safeZEnabled = !machine.safe_z_disabled;
  const seq = sendJog({ type: "target", target: move.machineTargets, feed_mm_min: feed, safe_z_enabled: safeZEnabled, safe_z_mm: safeZForTapMove(machine) });
  if (!seq) {
    setTapFeedback("Jog service is not connected.", "error");
    return;
  }
  const base = state.jog.target || state.jog.observed || state.jog.mpos || state.machine.mpos || {};
  state.jog.target = { ...base, ...move.machineTargets };
  state.jog.targetPending = seq;
  state.jog.targetMotionPending = seq;
  state.jog.workMovePending = seq;
  state.jog.targetLabel = move.label;
  state.jog.tapFeedback = "Sending move to " + move.label + "...";
  state.jog.tapFeedbackKind = "";
  renderJog();
}

function tapTargetLabel(target) {
  return `X ${target.x.toFixed(1)} Y ${target.y.toFixed(1)}`;
}

function sendTapMove(target) {
  if (state.jog.link !== "online") {
    setTapFeedback("Jog service is not connected.", "error");
    connectJog();
    return;
  }
  if (!state.jog.armed) {
    setTapFeedback("Arm Movement before selecting a target.", "error");
    return;
  }
  if (tapMoveTargetBusy() || state.jog.zStepPending || hasPendingOriginOperation()) return;
  let feed;
  try {
    feed = currentTapFeed();
  } catch (e) {
    setTapFeedback(e.message, "error");
    return;
  }
  const machine = normalizeMachineSettings(state.ui.machine);
  const safeZEnabled = !machine.safe_z_disabled;
  const label = tapTargetLabel(target);
  const seq = sendJog({ type: "target", target: { x: target.x, y: target.y }, feed_mm_min: feed, safe_z_enabled: safeZEnabled, safe_z_mm: safeZForTapMove(machine) });
  if (!seq) {
    setTapFeedback("Jog service is not connected.", "error");
    return;
  }
  const base = state.jog.target || state.jog.observed || state.jog.mpos || state.machine.mpos || {};
  state.jog.target = { ...base, x: target.x, y: target.y };
  state.jog.targetPending = seq;
  state.jog.targetMotionPending = seq;
  state.jog.targetLabel = label;
  state.jog.tapFeedback = "Sending target " + label + "...";
  state.jog.tapFeedbackKind = "";
  renderJog();
}

function currentZStepDistance() {
  const value = Number(document.getElementById("z-step-distance")?.value);
  return [10, 1, 0.1, 0.01].includes(value) ? value : 1;
}

function zStepLabel(distance) {
  const sign = distance > 0 ? "+" : "-";
  const abs = Math.abs(distance);
  const text = abs >= 1 ? abs.toFixed(0) : (abs >= 0.1 ? abs.toFixed(1) : abs.toFixed(2));
  return "Z" + sign + " " + text + " mm";
}

function stepZ(dir) {
  if (state.jog.caps && !state.jog.caps.enabled) {
    setTapFeedback(jogErrorText("disabled"), "error");
    return;
  }
  if (state.jog.link !== "online") {
    setTapFeedback("Jog service is not connected.", "error");
    connectJog();
    return;
  }
  if (!state.jog.armed) {
    setTapFeedback("Arm Movement before moving Z.", "error");
    return;
  }
  if (tapMoveTargetBusy() || state.jog.zStepPending || hasPendingOriginOperation()) return;
  const distance = currentZStepDistance() * dir;
  const label = zStepLabel(distance);
  const seq = sendJog({ type: "step", axis: "z", distance });
  if (!seq) {
    setTapFeedback("Jog service is not connected.", "error");
    return;
  }
  state.jog.zStepPending = seq;
  state.jog.zStepLabel = label;
  state.jog.tapFeedback = "Sending " + label + "...";
  state.jog.tapFeedbackKind = "";
  renderJog();
}

function handleWorkAreaTap(local) { return workAreaInteractions.handleWorkAreaTap(local); }
function mobileWorkAreaJogEnabled() { return workAreaInteractions.mobileWorkAreaJogEnabled(); }
function mobileWorkAreaActionsOpen() { return workAreaInteractions.mobileWorkAreaActionsOpen(); }
function mobileWorkAreaJogReady() { return workAreaInteractions.mobileWorkAreaJogReady(); }
function mobileJogAxisForResponse(value) {
  return computeMobileJogAxisForResponse(value, clampAxis, JOG_INPUT_DEADZONE);
}
function mobileWorkAreaJogAxes(originX, originY, clientX, clientY, radiusPX) {
  return computeMobileWorkAreaJogAxes(originX, originY, clientX, clientY, radiusPX, clampAxis, JOG_INPUT_DEADZONE);
}
function mobileWorkAreaJogRadius(svg) {
  return computeMobileWorkAreaJogRadius(svg, clampNumber, MOBILE_JOG_RADIUS_MIN_PX, MOBILE_JOG_RADIUS_MAX_PX);
}
function setMobileWorkAreaJogVisual(origin, knob, radiusPX) { return workAreaInteractions.setMobileWorkAreaJogVisual(origin, knob, radiusPX); }
function resetMobileWorkAreaJog(e = null) { return workAreaInteractions?.resetMobileWorkAreaJog(e) ?? false; }
function startMobileWorkAreaJog(e, local) { return workAreaInteractions.startMobileWorkAreaJog(e, local); }
function updateMobileWorkAreaJog(e) { return workAreaInteractions.updateMobileWorkAreaJog(e); }
function stopMobileWorkAreaJog(e = null) { return workAreaInteractions.stopMobileWorkAreaJog(e); }
function handleWorkAreaPointerDown(e) { return workAreaInteractions.handleWorkAreaPointerDown(e); }
function handleWorkAreaPointerMove(e) { return workAreaInteractions.handleWorkAreaPointerMove(e); }
function clearWorkAreaPointer(e) { return workAreaInteractions.clearWorkAreaPointer(e); }
function handleWorkAreaPointerUp(e) { return workAreaInteractions.handleWorkAreaPointerUp(e); }
function handleWorkAreaWheel(e) { return workAreaInteractions.handleWorkAreaWheel(e); }
function bindWorkAreaInteractions() { return workAreaInteractions.bindWorkAreaInteractions(); }

function clearDisarmedMovementState() {
  state.jog.surfaceInput = null;
  if (resetMobileWorkAreaJog()) {
    state.jog.pad = "";
    state.jog.deadman = false;
    state.jog.axes = { x: 0, y: 0, z: 0, a: 0 };
  }
  resetJogInputSender();
  state.jog.targetPending = 0;
  state.jog.targetMotionPending = 0;
  cancelWorkCoordinateMove();
  clearFieldProbeMove();
}

const applyJogEventFromModule = createJogEventHandler({
  state,
  documentRef: document,
  performanceRef: performance,
  callbacks: {
    flushQueuedTapMoveArm: (...args) => flushQueuedTapMoveArm(...args),
    resetJogInputSender: (...args) => resetJogInputSender(...args),
    clearDisarmedMovementState: (...args) => clearDisarmedMovementState(...args),
    clearNotice: (...args) => clearNotice(...args),
    reconcileObservedMachineStatus: (...args) => reconcileObservedMachineStatus(...args),
    mergeMachineStatusForDisplay: (...args) => mergeMachineStatusForDisplay(...args),
    resolveOutlineCaptureIntent: (...args) => resolveOutlineCaptureIntent(...args),
    tapMoveArmSuccessText: (...args) => tapMoveArmSuccessText(...args),
    requestMovementDisarm: (...args) => requestMovementDisarm(...args),
    completeCommandDisarm: (...args) => completeCommandDisarm(...args),
    finishSurfaceMPGGesture: (...args) => finishSurfaceMPGGesture(...args),
    setStatusMessage: (...args) => setStatusMessage(...args),
    beginOriginVerification: (...args) => beginOriginVerification(...args),
    clearOriginVerification: (...args) => clearOriginVerification(...args),
    setOriginFeedback: (...args) => setOriginFeedback(...args),
    handleOriginAck: (...args) => handleOriginAck(...args),
    completeWorkCoordinateMove: (...args) => completeWorkCoordinateMove(...args),
    clearFieldProbeMove: (...args) => clearFieldProbeMove(...args),
    renderJog: (...args) => renderJog(...args),
    renderOutlineCapture: (...args) => renderOutlineCapture(...args),
    jogErrorText: (...args) => jogErrorText(...args),
    tapMoveArmFailureText: (...args) => tapMoveArmFailureText(...args),
    cancelWorkCoordinateMove: (...args) => cancelWorkCoordinateMove(...args),
    originTargetLabel: (...args) => originTargetLabel(...args),
    hasPendingOriginOperation: (...args) => hasPendingOriginOperation(...args),
    deferSurfaceMPGMachineRender: (...args) => deferSurfaceMPGMachineRender(...args),
    renderSurfaceMPGWheel: (...args) => renderSurfaceMPGWheel(...args),
    renderMachine: (...args) => renderMachine(...args),
  },
});

function applyJogEvent(ev) {
  return applyJogEventFromModule(ev);
}

function jogMotionAwaitingSettlement() { return machineReconciliation.jogMotionAwaitingSettlement(); }
function jogEstimateActive() { return machineReconciliation.jogEstimateActive(); }

function applySnapshot(snap) {
  if (snap.machine) {
    applyMachineStatus(snap.machine, false);
  }
  filesFeature.applySnapshot(snap);
  renderMachine();
  renderFiles();
  renderJobs();
  if (Array.isArray(snap.gcode)) {
    clearGcodeLog();
    for (const ln of snap.gcode) appendGcodeLine(ln);
  }
}

function applyMachineStatus(next, render = true) {
  if (!next) return;
  state.machine = reconcileObservedMachineStatus(next);
  if (externalJobState(state.machine.state) && !state.activeGcode?.path) {
    if (!state.externalJobObservedAt) state.externalJobObservedAt = Date.now();
  } else {
    state.externalJobObservedAt = 0;
  }
  syncActiveGcodeFromMachine(next);
  applySurfaceAutomaticView();
  clearNotice("machine-status");
  if (render) renderMachine();
}

function externalJobState(...args) { return surfaceRouting.externalJobState?.(...args) ?? false; }
function externalJobInfo(...args) { return surfaceRouting.externalJobInfo(...args); }

function applyChange(ev) {
  if (ev.kind === "reset") {
    setNotice("Local state changed; reloading.", "info", "local-state");
    setTimeout(() => location.reload(), 400);
    return;
  }
  if (ev.kind === "entry" && ev.entry) {
    filesFeature.applyEntry(ev.entry);
  } else if (ev.kind === "job" && ev.job) {
    filesFeature.applyJob(ev.job);
  } else if (ev.kind === "active_gcode") {
    loadActiveGcode();
  }
}



function runSurfaceShellAction(...args) { return surfaceShell.runSurfaceShellAction(...args); }

function applySurfaceAutomaticView(...args) { return surfaceRouting.applySurfaceAutomaticView(...args); }

function showActiveJobLeftTab(...args) { return activeJobLayout?.showActiveJobLeftTab(...args); }
function activeJobSplitBounds(...args) { return activeJobLayout?.activeJobSplitBounds(...args) || calculateActiveJobSplitBounds(...args); }
function setActiveJobSplitPercent(...args) { return activeJobLayout?.setActiveJobSplitPercent(...args); }
function bindActiveJobSplitter(...args) { return activeJobLayout?.bindActiveJobSplitter(...args); }


function mergeMachineStatusForDisplay(...args) { return machineReconciliation.mergeMachineStatusForDisplay(...args); }
function shouldPreserveJogPrediction(...args) { return machineReconciliation.shouldPreserveJogPrediction(...args); }
function reconcileObservedMachineStatus(...args) { return machineReconciliation.reconcileObservedMachineStatus(...args); }

function initializeResponsiveControlSections(isMobile = window.matchMedia?.("(max-width: 600px)")?.matches === true) {
  const sections = [
    ["jog-settings-section", true],
    ["move-to-work-section", true],
    ["work-zero-section", true],
    ["gamepad-section", false],
  ];
  for (const [id, desktopOpen] of sections) {
    const section = document.getElementById(id);
    if (section) section.open = !isMobile && desktopOpen;
  }
}

function init() {
  const gcodeView = gcodeViewer.getGcodeView();
  const activeGcodeSource = gcodeViewer.getActiveGcodeSource();
  maintenance.mount();
  mountMachineReadouts();
  initializeResponsiveControlSections();
  applyDashboardURLState();
  document.getElementById("header-toggle").onclick = () => setHeaderCollapsed(!document.body.classList.contains("header-collapsed"));
  document.getElementById("development-refresh").onclick = reloadPage;
  installPullToRefresh();
  initDashboardControlsMenu();
  initWorkAreaActionsMenu();
  for (const [index, name] of NAV_VIEW_TABS.entries()) {
    const tab = document.getElementById("tab-" + name);
    tab.onclick = () => showTab(name);
    tab.onkeydown = (e) => {
      let next = index;
      if (e.key === "ArrowRight") next = (index + 1) % NAV_VIEW_TABS.length;
      else if (e.key === "ArrowLeft") next = (index - 1 + NAV_VIEW_TABS.length) % NAV_VIEW_TABS.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = NAV_VIEW_TABS.length - 1;
      else return;
      e.preventDefault();
      const nextTab = document.getElementById("tab-" + NAV_VIEW_TABS[next]);
      showTab(NAV_VIEW_TABS[next]);
      nextTab.focus();
    };
  }
  window.addEventListener("popstate", () => {
    applyDashboardURLState();
    showTab(viewTabFromURL(window.location, { viewTabs: VIEW_TABS, windowRef: window }), "none");
  });
  showTab(viewTabFromURL(window.location, { viewTabs: VIEW_TABS, windowRef: window }), "replace");
  document.getElementById("dashboard-profile").onchange = (e) => selectDashboardProfile(e.target.value);
  document.getElementById("dashboard-new").onclick = () => {
    setDashboardControlsOpen(false);
    openDashboardSettings(true);
  };
  document.getElementById("dashboard-configure").onclick = () => {
    setDashboardControlsOpen(false);
    openDashboardSettings(false);
  };
  document.getElementById("dashboard-copy-link").onclick = () => copyDashboardURL(false);
  document.getElementById("dashboard-copy-obs").onclick = () => copyDashboardURL(true);
  document.getElementById("dashboard-settings-close").onclick = closeDashboardSettings;
  document.getElementById("dashboard-settings-cancel").onclick = closeDashboardSettings;
  document.getElementById("dashboard-save").onclick = saveDashboardProfile;
  document.getElementById("dashboard-delete").onclick = deleteDashboardProfile;
  document.getElementById("dashboard-settings-modal").addEventListener("cancel", (e) => {
    e.preventDefault();
    closeDashboardSettings();
  });
  const activeJobLeftTabs = ["source", "console"];
  for (const [index, name] of activeJobLeftTabs.entries()) {
    const tab = document.getElementById("active-job-left-tab-" + name);
    tab.onclick = () => showActiveJobLeftTab(name);
    tab.onkeydown = (e) => {
      let next = index;
      if (e.key === "ArrowRight") next = (index + 1) % activeJobLeftTabs.length;
      else if (e.key === "ArrowLeft") next = (index - 1 + activeJobLeftTabs.length) % activeJobLeftTabs.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = activeJobLeftTabs.length - 1;
      else return;
      e.preventDefault();
      const nextTab = document.getElementById("active-job-left-tab-" + activeJobLeftTabs[next]);
      showActiveJobLeftTab(activeJobLeftTabs[next]);
      nextTab.focus();
    };
  }
  showActiveJobLeftTab(state.activeJobLeftTab);
  bindActiveJobSplitter();
  filesFeature.bind();
  filesFeature.mount();

  bindCommandInteractions({ submitGcode, navigateCommandHistory });
  bindGcodeLogInteractions({ copyVisibleLog, exportVisibleLog, clearGcodeLog });
  backupFeature.bindInteractions({ exportBackup, importBackupFile });
  document.getElementById("macro-new").onclick = newMacro;
  document.getElementById("macro-save").onclick = saveMacroFromForm;
  bindButtonAction(document.getElementById("macro-run"), () => runMacro(macroByID(state.selectedMacroId)));
  document.getElementById("macro-up").onclick = () => moveSelectedMacro(-1);
  document.getElementById("macro-down").onclick = () => moveSelectedMacro(1);
  document.getElementById("macro-delete").onclick = deleteSelectedMacro;
  bindDirtyDraftControls(MACRO_EDITOR_IDS);
  for (const axis of ["x", "y", "z"]) {
    document.getElementById("gamepad-axis-" + axis).onchange = () => updateGamepadAxis(axis);
    document.getElementById("gamepad-invert-" + axis).onchange = () => updateGamepadAxis(axis);
    document.getElementById("gamepad-speed-" + axis).oninput = () => updateGamepadAxis(axis);
  }
  document.getElementById("gamepad-deadman-button").onchange = updateGamepadButtons;
  document.getElementById("gamepad-slow-button-0").onchange = updateGamepadButtons;
  document.getElementById("gamepad-slow-button-1").onchange = updateGamepadButtons;
  const outlineButtonInput = document.getElementById("gamepad-outline-button");
  outlineButtonInput.oninput = () => markControlDirty(outlineButtonInput);
  outlineButtonInput.onchange = () => {
    clearControlDrafts(outlineButtonInput);
    updateGamepadButtons();
  };
  document.getElementById("gamepad-add-macro").onclick = addGamepadMacroBinding;
  bindDirtyDraftControls(MACHINE_SETTING_IDS);
  for (const id of MACHINE_SETTING_IDS) {
    document.getElementById(id).onchange = updateMachineSettings;
  }
  for (const btn of document.querySelectorAll("[data-feed-step]")) {
    btn.onclick = () => stepTapFeed(Number(btn.dataset.feedStep) || 0);
  }
  for (const axis of ["x", "y", "z"]) {
    const input = workMoveInput(axis);
    input.oninput = () => {
      input.dataset.dirty = "1";
      renderWorkMoveControls();
    };
    input.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        sendWorkCoordinateMove();
      }
    };
  }
  for (const btn of document.querySelectorAll("[data-work-move-reset]")) {
    bindButtonAction(btn, (e) => {
      e.preventDefault();
      resetWorkMoveInput(btn.dataset.workMoveReset);
    });
  }
  bindButtonAction(document.getElementById("work-move-send"), sendWorkCoordinateMove);
  document.getElementById("tap-safe-z-enabled").onchange = updateSafeZToggle;
  for (const btn of document.querySelectorAll("[data-z-step-dir]")) {
    bindButtonAction(btn, () => stepZ(Number(btn.dataset.zStepDir) || 1));
  }
  for (const btn of document.querySelectorAll("[data-origin-zero]")) {
    bindButtonAction(btn, () => setOriginAxis(btn.dataset.originZero));
  }
  originProbing.bindInteractions({ bindButtonAction });
  bindWorkAreaInteractions();
  bindButtonAction(document.getElementById("workarea-zoom-out"), () => zoomWorkArea(1 / WORKAREA_ZOOM_STEP));
  bindButtonAction(document.getElementById("workarea-zoom-reset"), resetWorkAreaView);
  bindButtonAction(document.getElementById("workarea-zoom-in"), () => zoomWorkArea(WORKAREA_ZOOM_STEP));
  outlineView.bindInteractions({
    bindButtonAction,
    startOutlineCapture,
    endOutlineCapture,
    addOutlinePoint,
    traceOutline,
    undoOutline,
    redoOutline,
    closeOutline,
    saveOutlineJSON,
    toggleOutlineCurveFit,
    exportOutline,
    loadOutlineFile,
    markControlDirty,
    scheduleOutlineFieldSpacingUpdate,
    runFieldProbe,
    moveToSelectedFieldProbePoint,
    resetSelectedFieldProbeValue,
    probeFloor,
    exportHeightOBJ,
    exportHeightImage,
  });
  bindButtonAction(document.getElementById("probe-confirm-close"), () => settleProbeConfirmation(false));
  bindButtonAction(document.getElementById("probe-confirm-cancel"), () => settleProbeConfirmation(false));
  bindButtonAction(document.getElementById("probe-confirm-accept"), () => settleProbeConfirmation(true));
  document.getElementById("probe-confirm-modal").addEventListener("cancel", (e) => {
    e.preventDefault();
    settleProbeConfirmation(false);
  });
  bindButtonAction(document.getElementById("machine-settings-open"), openMachineSettings);
  bindButtonAction(document.getElementById("machine-settings-close"), closeMachineSettings);
  bindButtonAction(document.getElementById("machine-learn"), learnMachineParameters);

  bindButtonAction(document.getElementById("ctl-hold"), () => sendControl("hold"));
  bindButtonAction(document.getElementById("ctl-resume"), () => sendControl("resume"));
  bindButtonAction(document.getElementById("ctl-halt"), () => sendControl("halt"));
  bindButtonAction(document.getElementById("tool-set"), () => setCurrentTool());
  bindButtonAction(document.getElementById("tool-change-set"), () => changeTool());
  bindButtonAction(document.getElementById("tool-continue"), continueToolChange);
  bindButtonAction(document.getElementById("tool-calibrate"), calibrateCurrentTool);
  document.getElementById("tool-set-select").onchange = (e) => handleToolSelect("set", e.target.value);
  document.getElementById("tool-change-select").onchange = (e) => handleToolSelect("change", e.target.value);
  bindButtonAction(document.getElementById("active-gcode-run"), runActiveGcode);
  for (const button of document.querySelectorAll("[data-job-control]")) {
    bindButtonAction(button, () => runJobControl(button.dataset.jobControl));
  }
  bindButtonAction(document.getElementById("feed-override-decrease"), () => adjustFeedOverride(-10));
  bindButtonAction(document.getElementById("feed-override-increase"), () => adjustFeedOverride(10));
  bindButtonAction(document.getElementById("feed-override-reset"), () => setFeedOverride(100));
  for (const button of document.querySelectorAll("[data-machine-feed-delta]")) {
    bindButtonAction(button, () => adjustFeedOverride(Number(button.dataset.machineFeedDelta)));
  }
  for (const button of document.querySelectorAll("[data-machine-feed-reset]")) {
    bindButtonAction(button, () => setFeedOverride(100));
  }
  bindButtonAction(document.getElementById("paused-job-raise"), () => runPausedJobCommand("raise_z"));
  const gcodeSourceScroll = document.getElementById("active-gcode-source-scroll");
  const markGcodeSourceInteraction = () => {
    activeGcodeSource.userScrollingUntil = Date.now() + 2000;
  };
  gcodeSourceScroll.onscroll = scheduleActiveGcodeSourceRender;
  gcodeSourceScroll.onwheel = markGcodeSourceInteraction;
  gcodeSourceScroll.onpointerdown = markGcodeSourceInteraction;
  gcodeSourceScroll.ontouchstart = markGcodeSourceInteraction;
  gcodeSourceScroll.onkeydown = (e) => {
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(e.key)) {
      markGcodeSourceInteraction();
    }
  };
  if (globalThis.ResizeObserver) {
    activeGcodeSource.resizeObserver = new ResizeObserver(scheduleActiveGcodeSourceRender);
    activeGcodeSource.resizeObserver.observe(gcodeSourceScroll);
  }
  window.addEventListener("resize", () => setActiveJobSplitPercent(state.activeJobSplitPercent));
  window.addEventListener("resize", () => {
    if (!mobileWorkAreaJogEnabled() && state.workarea?.mobileJogActive) {
      if (releaseJogInput(true)) renderJog();
    }
  });
  const gcodeTimeline = document.getElementById("gcode-timeline");
  gcodeTimeline.onpointerdown = () => {
    gcodeView.timelineDragging = true;
    gcodeView.followLive = false;
    gcodeTimeline.dataset.dragging = "1";
  };
  const releaseGcodeTimeline = () => {
    gcodeView.cursor = Math.max(0, Math.min(gcodeView.segments.length, Number(gcodeTimeline.value) || 0));
    gcodeView.timelineDragging = false;
    clearControlDrafts(gcodeTimeline);
    updateGcodeProgress();
  };
  gcodeTimeline.onpointerup = releaseGcodeTimeline;
  gcodeTimeline.onpointercancel = releaseGcodeTimeline;
  gcodeTimeline.onblur = releaseGcodeTimeline;
  gcodeTimeline.onchange = releaseGcodeTimeline;
  gcodeTimeline.oninput = (e) => {
    gcodeView.followLive = false;
  gcodeView.timelineEventLine = 0;
  setGcodeTimelineEventDetail("", 0);
  gcodeView.cursor = Number(e.target.value) || 0;
    updateGcodeProgress();
  };
  bindDataControlButtons();
  initCommandPopouts();
  initializeSurfaceMobileOptions();
  window.matchMedia?.("(max-width: 600px)")?.addEventListener?.("change", (e) => initializeSurfaceMobileOptions(e.matches));
  window.matchMedia?.("(min-width: 1320px)")?.addEventListener?.("change", () => applyDashboardProfile(currentDashboardProfile()));
  bindButtonAction(document.getElementById("jog-arm"), toggleTapMoveArm);
  surfaceControls.init();
  for (const button of document.querySelectorAll("[data-surface-view]")) {
    button.onclick = () => showTab(button.dataset.surfaceView);
  }
  for (const button of document.querySelectorAll("[data-surface-action]")) {
    button.onclick = () => runSurfaceShellAction(button.dataset.surfaceAction);
  }
  bindButtonAction(document.getElementById("surface-footer-hold"), () => sendControl("hold"));
  bindButtonAction(document.getElementById("surface-footer-resume"), () => {
    resumeActiveJob();
  });
  bindDashboardCameraSwitches();
  bindDashboardToolpathShortcut();
  bindButtonAction(document.getElementById("surface-footer-job"), () => showTab("active-job"));
  bindButtonAction(document.getElementById("surface-footer-vacuum"), () => {
    const current = dashboardOptionalNumber(state.machine?.spindle?.vacuum_mode);
    if (current !== null) setAutoVacuum(current === 0);
  });
  document.getElementById("surface-open-active-job").onclick = () => showTab("active-job");
  document.getElementById("attention-open-active-job").onclick = () => showTab("active-job");
  bindButtonAction(document.getElementById("attention-resume"), () => {
    const action = attentionResumeAction(String(state.machine?.state || ""));
    if (action === "resume_job") runActiveJobControl(action);
    else if (action === "resume") sendControl(action);
  });
  document.getElementById("attention-open-tool").onclick = () => {
    const menu = document.getElementById("tool-panel")?.closest(".command-popout");
    if (!menu) return;
    document.getElementById("command-actions")?.classList.add("mobile-menu-open");
    document.getElementById("mobile-actions-toggle")?.setAttribute("aria-expanded", "true");
    menu.open = true;
  };

  loadUISettings();
  loadAPICapabilities();
  loadDashboardCameras();
  loadActiveGcode();
  loadJogCapabilities();
  bindBrowserLifecycle();
  scheduleJogSample();
  renderFiles();
  renderJobs();
  connectControlSSE();
  pollMachine();
  setInterval(pollMachine, 3000);
}

document.addEventListener("DOMContentLoaded", init);
