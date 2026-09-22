const GCODE_SOURCE_ROW_HEIGHT = 20;
const GCODE_SOURCE_OVERSCAN = 12;
const GCODE_SOURCE_PAGE_SIZE = 500;
const GCODE_SOURCE_MAX_PAGES = 8;
const GCODE_SEGMENT_PAGE_SIZE = 5000;

export function mountGcodeViewer({
  THREE,
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  request,
  getActiveGcode = () => null,
  getMachine = () => ({}),
  getFiles = () => new Map(),
  getOutline = () => ({}),
  deps = {},
}) {
  const document = documentRef;
  const window = windowRef;
  const state = {
    get activeGcode() { return getActiveGcode(); },
    get machine() { return getMachine(); },
    get files() { return getFiles(); },
    get outline() { return getOutline(); },
  };
  const {
    activeJobPreviewState = () => null,
    gcodeCursorForPlayedLine = (segments, line) => Math.max(0, Math.min(segments.length, line)),
    gcodeToolLabel = (tool) => tool?.name || "",
    gcodeToolMetadata = (metadata, number) => metadata?.find((tool) => Number(tool?.number) === Number(number)) || null,
    externalJobInfo = () => null,
    fmtSize = () => "-",
    relPath = (value) => value || "",
    escapeHtml = (value) => String(value ?? ""),
    machineActionState = () => "",
    SYNC_LABEL = {},
    setTextIfChanged = () => {},
    setStatusMessage = () => {},
    setSoftDisabled = () => {},
    renderProgramToolLists = () => {},
    renderJobControls = () => {},
    setElementBusy = () => {},
    currentDashboardProfile = () => ({}),
    clearConnectivityIssue = () => {},
    clearNotice = () => {},
    renderActiveGcode = () => {},
    activeGcodeDisplaySegments = (active) => active?.preview?.overview_segments || [],
    axisValue = (values, axis) => {
      const value = Number(values?.[axis]);
      return Number.isFinite(value) ? value : null;
    },
    cloneOutlineOrigin = (origin) => origin ? { ...origin } : null,
    currentWorkOrigin = () => null,
    buildHeightMeshVertices = () => [],
    constrainedOutlineTriangles = () => [],
    interpolateZ = () => 0,
    clearThreeGroup = () => {},
    disposeObject = () => {},
    panGcodeCamera = () => {},
    updateGcodeProgress = () => {},
    toolDisplayName = (tool) => `T${tool}`,
    fmtCoord = (value) => String(value ?? "-"),
  } = deps;
  const drawGcodePreviewCallbacks = {
    renderTimelineEvents: deps.renderGcodeTimelineEvents || ((...args) => renderGcodeTimelineEvents(...args)),
    clearGcodeScene: deps.clearGcodeScene || ((...args) => clearGcodeScene(...args)),
    setPreviewEmpty: deps.setGcodePreviewEmpty || ((...args) => setGcodePreviewEmpty(...args)),
    updateTimeline: deps.updateGcodeTimeline || ((...args) => updateGcodeTimeline(...args)),
    syncSourceLine: deps.syncActiveGcodeSourceLine || ((...args) => syncActiveGcodeSourceLine(...args)),
    ensureViewer: deps.ensureGcodeViewer || ((...args) => ensureGcodeViewer(...args)),
    timelineLocallyOwned: deps.gcodeTimelineLocallyOwned || ((...args) => gcodeTimelineLocallyOwned(...args)),
    syncContextOverlay: deps.syncGcodeContextOverlay || ((...args) => syncGcodeContextOverlay(...args)),
    combineBounds: deps.combineGcodeBounds || ((...args) => combineGcodeBounds(...args)),
    getActiveFile: deps.getActiveFile || ((path) => state.files?.get(path)),
    cameraFitKey: deps.gcodeCameraFitKey || ((...args) => gcodeCameraFitKey(...args)),
    rebuildScene: deps.rebuildGcodeScene || ((...args) => rebuildGcodeScene(...args)),
    fitCamera: deps.fitGcodeCamera || ((...args) => fitGcodeCamera(...args)),
    updateProgress: deps.updateGcodeProgress || ((...args) => updateGcodeProgress(...args)),
    scheduleRender: deps.scheduleGcodeRender || ((...args) => scheduleGcodeRender(...args)),
  };

  const gcodeView = {
  key: "",
  fitKey: "",
  canvas: null,
  empty: null,
  renderer: null,
  scene: null,
  camera: null,
  perspCamera: null,
  orthoCamera: null,
  projection: "orthographic",
  cube: null,
  pathGroup: null,
  contextGroup: null,
  contextKey: "",
  contextBounds: null,
  contextVisible: false,
  progressLine: null,
  marker: null,
  live: null,
  followLive: false,
  target: new THREE.Vector3(),
  orbit: { ...gcodeOrbitAnglesForDirection({ x: 1, y: 1, z: 1 }), radius: 120 },
  segments: [],
  cursor: 0,
  timelineEventLine: 0,
  timelineEventsKey: "",
  has4Axis: false,
  dragging: false,
  timelineDragging: false,
  dragX: 0,
  dragY: 0,
  dragMode: "orbit",
  touchPointers: new Map(),
  pinchDistance: 0,
  panKeyDown: false,
  panKeys: new Set(),
  hovering: false,
  renderQueued: false,
  resizeObserver: null,
  width: 0,
  height: 0,
  pixelRatio: 0,
};

const dashboardGcodeView = {
  key: "",
  canvas: null,
  empty: null,
  renderer: null,
  scene: null,
  camera: null,
  pathGroup: null,
  contextGroup: null,
  progressLine: null,
  marker: null,
  target: new THREE.Vector3(),
  orbit: { ...gcodeOrbitAnglesForDirection({ x: 1, y: 1, z: 1 }), radius: 120 },
  segments: [],
  has4Axis: false,
  renderQueued: false,
  renderStateKey: "",
  resizeObserver: null,
  width: 0,
  height: 0,
  pixelRatio: 0,
};

const activeGcodeSource = {
  path: "",
  signature: "",
  requestID: 0,
  totalLines: 0,
  pages: new Map(),
  loadingPages: new Set(),
  currentLine: 0,
  userScrollingUntil: 0,
  renderQueued: false,
  resizeObserver: null,
  unavailableSignature: "",
};

const activeGcodeGeometry = {
  signature: "",
  requestedSignature: "",
  requestID: 0,
  total: 0,
  segments: [],
};

const GCODE_KIND_COLORS = {
  rapid: 0x91a0ae,
  cut: 0x57a6d6,
  arc: 0x44c27b,
  probe: 0xd99a3a,
};

const GCODE_FOV = 45;
const GCODE_RENDER_PIXEL_BUDGET = 12_000_000;
const GCODE_ORBIT_DRAG_RAD_PER_PX = 0.008;
const GCODE_ORBIT_MIN_RADIUS = 1;
const GCODE_ORBIT_MAX_RADIUS = 100000;
const GCODE_CUBE_DRAG_THRESHOLD_PX = 4;

  function dashboardGcodeWindow(totalLines, currentLine, visibleLines) {
  const total = Math.max(0, Math.trunc(Number(totalLines) || 0));
  const count = Math.max(3, Math.min(30, Math.trunc(Number(visibleLines) || 9)));
  const current = Math.max(0, Math.min(total, Math.trunc(Number(currentLine) || 0)));
  if (!total) return { start: 0, end: 0, current: 0 };
  if (!current) return { start: 0, end: Math.min(total, count), current: 0 };
  const before = Math.floor((count - 1) / 2);
  let start = Math.max(0, current - 1 - before);
  let end = Math.min(total, start + count);
  start = Math.max(0, end - count);
  return { start, end, current };
}

function renderDashboardGcodeStream(live = null) {
  const container = document.getElementById("dashboard-gcode-lines");
  const position = document.getElementById("dashboard-gcode-position");
  if (!container || !position) return;
  if (!activeGcodeSource.path) {
    position.textContent = "-";
    const empty = document.createElement("div");
    empty.className = "dashboard-gcode-line dashboard-gcode-empty";
    empty.textContent = "No gcode loaded";
    container.replaceChildren(empty);
    return;
  }

  const currentLine = Math.max(0, Math.trunc(Number(live?.playedLines) || 0));
  const range = dashboardGcodeWindow(
    activeGcodeSource.totalLines,
    currentLine,
    currentDashboardProfile()?.gcode_lines,
  );
  position.textContent = range.current
    ? `Ln ${range.current} / ${activeGcodeSource.totalLines || "—"}`
    : (activeGcodeSource.totalLines ? `${activeGcodeSource.totalLines} lines` : "Loading…");
  if (range.end > range.start) {
    fetchActiveGcodeSourcePage(range.start);
    fetchActiveGcodeSourcePage(range.end - 1);
  } else {
    fetchActiveGcodeSourcePage(0);
  }

  const fragment = document.createDocumentFragment();
  for (let index = range.start; index < range.end; index++) {
    const lineNumber = index + 1;
    const row = document.createElement("div");
    row.className = "dashboard-gcode-line" + (lineNumber === range.current ? " current" : "");
    if (lineNumber === range.current) row.setAttribute("aria-current", "step");
    const number = document.createElement("span");
    number.className = "dashboard-gcode-number";
    number.textContent = String(lineNumber);
    number.setAttribute("aria-hidden", "true");
    const code = document.createElement("span");
    code.className = "dashboard-gcode-code";
    code.textContent = activeGcodeSourceLine(index) || " ";
    row.append(number, code);
    fragment.appendChild(row);
  }
  if (!range.end) {
    const loading = document.createElement("div");
    loading.className = "dashboard-gcode-line dashboard-gcode-empty";
    loading.textContent = "Loading gcode…";
    fragment.appendChild(loading);
  }
  container.replaceChildren(fragment);
}

function drawDashboardGcodePreview(preview, live = null) {
  const segments = Array.isArray(preview?.segments) ? preview.segments : [];
  const hasToolpath = segments.length > 0 && !!preview?.bounds;
  if (!hasToolpath) {
    // Machine status arrives several times per second. Once the viewer is
    // empty, clearing and rendering the same empty WebGL scene again makes the
    // Overview visibly flash on slower touch hardware.
    if (dashboardGcodeView.key || dashboardGcodeView.segments.length) clearDashboardGcodeScene();
    setDashboardGcodePreviewEmpty("No plotted moves");
    return;
  }
  if (!ensureDashboardGcodeViewer()) return;

  const origin = activeJobOverlayOrigin();
  const context = activeJobContextOverlayData(state.outline, origin);
  const contextKey = activeJobContextOverlayKey(origin);
  const sceneBounds = combineGcodeBounds(preview.bounds, context.bounds);
  const key = [
    activeGcodeSourceSignature(state.activeGcode),
    activeGcodeGeometry.signature ? "full" : "overview",
    segments.length,
    preview.has_4axis ? "4" : "3",
    contextKey,
  ].join("|");
  let sceneChanged = false;
  if (dashboardGcodeView.key !== key) {
    dashboardGcodeView.key = key;
    dashboardGcodeView.segments = segments;
    dashboardGcodeView.has4Axis = !!preview.has_4axis;
    populateGcodePathScene(dashboardGcodeView, { ...preview, bounds: sceneBounds }, segments);
    clearThreeGroup(dashboardGcodeView.contextGroup);
    rebuildGcodeContextOverlayForGroup(dashboardGcodeView.contextGroup, context);
    fitDashboardGcodeCamera(sceneBounds);
    sceneChanged = true;
  }

  const cursor = live
    ? Math.max(0, Math.min(segments.length, Number(live.cursor) || 0))
    : segments.length;
  const markerPosition = live?.position || segments[Math.max(0, cursor - 1)]?.to;
  const renderStateKey = dashboardGcodeRenderStateKey(key, cursor, markerPosition);
  if (sceneChanged || dashboardGcodeView.renderStateKey !== renderStateKey) {
    dashboardGcodeView.renderStateKey = renderStateKey;
    if (dashboardGcodeView.progressLine) {
      dashboardGcodeView.progressLine.geometry.setDrawRange(0, cursor * 2);
    }
    if (markerPosition) {
      dashboardGcodeView.marker.position.copy(gcodeWorldPoint(markerPosition, dashboardGcodeView.has4Axis));
      dashboardGcodeView.marker.scale.setScalar(Math.max(0.8, dashboardGcodeView.orbit.radius * 0.008));
      dashboardGcodeView.marker.visible = true;
    } else {
      dashboardGcodeView.marker.visible = false;
    }
    scheduleDashboardGcodeRender();
  }
  if (dashboardGcodeView.canvas) {
    dashboardGcodeView.canvas.setAttribute(
      "aria-label",
      live?.position
        ? `Active job 3D preview; live spindle at X ${fmtCoord(live.position[0])}, Y ${fmtCoord(live.position[1])}, Z ${fmtCoord(live.position[2])}`
        : "Active job 3D preview",
    );
  }
  setDashboardGcodePreviewEmpty("");
}

function dashboardGcodeRenderStateKey(sceneKey, cursor, markerPosition) {
  const point = Array.isArray(markerPosition)
    ? markerPosition.slice(0, 4).map((value) => {
      const number = Number(value);
      return Number.isFinite(number) ? number.toFixed(4) : "";
    }).join(",")
    : "";
  return `${sceneKey}|${Math.trunc(Number(cursor) || 0)}|${point}`;
}

function activeGcodeSourceSignature(active) {
  if (!active?.path) return "";
  const entry = active.entry || state.files.get(active.path) || {};
  const preview = active.preview || {};
  return JSON.stringify([
    active.path,
    entry.md5 || "",
    Number(entry.size) || 0,
    entry.mtime || "",
    Number(preview.line_count) || 0,
    active.updated_at || "",
  ]);
}

function gcodeCameraFitKey(path, entry = {}, preview = {}, hasToolpath = false) {
  if (!hasToolpath) return "context-only";
  return JSON.stringify([
    String(path || ""),
    entry.md5 || "",
    Number(entry.size) || 0,
    entry.mtime || "",
    Number(preview.line_count) || 0,
    preview.has_4axis ? "4" : "3",
  ]);
}

async function ensureActiveGcodeGeometry(active) {
  const signature = activeGcodeSourceSignature(active);
  if (!signature) {
    activeGcodeGeometry.requestID++;
    activeGcodeGeometry.signature = "";
    activeGcodeGeometry.requestedSignature = "";
    activeGcodeGeometry.total = 0;
    activeGcodeGeometry.segments = [];
    return;
  }
  if (activeGcodeGeometry.signature === signature || activeGcodeGeometry.requestedSignature === signature) return;
  const requestID = ++activeGcodeGeometry.requestID;
  activeGcodeGeometry.requestedSignature = signature;
  activeGcodeGeometry.signature = "";
  activeGcodeGeometry.total = Math.max(0, Number(active?.preview?.plotted_segments) || 0);
  activeGcodeGeometry.segments = [];
  try {
    let start = 0;
    while (start < activeGcodeGeometry.total || start === 0) {
      const response = await request(`/api/gcode/active/segments?start=${start}&limit=${GCODE_SEGMENT_PAGE_SIZE}`);
      if (response.status === 204) {
        if (requestID !== activeGcodeGeometry.requestID || activeGcodeGeometry.requestedSignature !== signature) return;
        // A job reported by the machine can be remote-only while it runs. Its
        // source is unavailable, but its live job model must remain visible.
        activeGcodeGeometry.signature = signature;
        activeGcodeGeometry.requestedSignature = "";
        return;
      }
      const windowData = await response.json();
      if (requestID !== activeGcodeGeometry.requestID || activeGcodeGeometry.requestedSignature !== signature) return;
      const page = Array.isArray(windowData.segments) ? windowData.segments : [];
      activeGcodeGeometry.total = Math.max(0, Number(windowData.total) || 0);
      activeGcodeGeometry.segments.push(...page);
      start += page.length;
      if (!page.length || start >= activeGcodeGeometry.total) break;
    }
    if (requestID !== activeGcodeGeometry.requestID) return;
    activeGcodeGeometry.signature = signature;
    activeGcodeGeometry.requestedSignature = "";
    clearNotice("active-gcode-geometry");
    renderActiveGcode();
  } catch (error) {
    if (requestID !== activeGcodeGeometry.requestID) return;
    activeGcodeGeometry.requestedSignature = "";
    setNotice("Toolpath loading failed: " + error.message, "error", "active-gcode-geometry");
  }
}

function splitGcodeSourceLines(text) {
  if (!text) return [];
  const lines = String(text).split(/\r\n|\n|\r/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

async function ensureActiveGcodeSource(active) {
  const path = String(active?.path || "");
  if (!path) {
    resetActiveGcodeSource();
    return;
  }
  const signature = activeGcodeSourceSignature(active);
  if (activeGcodeSource.signature === signature) return;
  activeGcodeSource.requestID++;
  const pathChanged = activeGcodeSource.path !== path;
  activeGcodeSource.path = path;
  if (pathChanged || (activeGcodeSource.signature && activeGcodeSource.signature !== signature)) {
    activeGcodeSource.pages.clear();
    activeGcodeSource.loadingPages.clear();
    activeGcodeSource.currentLine = 0;
    const scroll = document.getElementById("active-gcode-source-scroll");
    if (scroll) scroll.scrollTop = 0;
    renderActiveGcodeSource();
  }
  activeGcodeSource.signature = signature;
  activeGcodeSource.unavailableSignature = "";
  activeGcodeSource.totalLines = Math.max(0, Number(active?.preview?.line_count) || 0);
  clearNotice("active-gcode-source");
  renderActiveGcodeSource();
  fetchActiveGcodeSourcePage(0);
}

function resetActiveGcodeSource() {
  if (!activeGcodeSource.path && !activeGcodeSource.pages.size) {
    renderActiveGcodeSource();
    return;
  }
  activeGcodeSource.requestID++;
  activeGcodeSource.path = "";
  activeGcodeSource.signature = "";
  activeGcodeSource.totalLines = 0;
  activeGcodeSource.pages.clear();
  activeGcodeSource.loadingPages.clear();
  activeGcodeSource.currentLine = 0;
  clearNotice("active-gcode-source");
  const scroll = document.getElementById("active-gcode-source-scroll");
  if (scroll) {
    scroll.scrollTop = 0;
    scroll.removeAttribute("aria-busy");
  }
  renderActiveGcodeSource();
}

async function fetchActiveGcodeSourcePage(index) {
  if (!activeGcodeSource.path || !activeGcodeSource.signature) return;
  if (activeGcodeSource.unavailableSignature === activeGcodeSource.signature) return;
  const pageStartIndex = Math.max(0, Math.floor(Math.max(0, index) / GCODE_SOURCE_PAGE_SIZE) * GCODE_SOURCE_PAGE_SIZE);
  if (activeGcodeSource.pages.has(pageStartIndex)) {
    const page = activeGcodeSource.pages.get(pageStartIndex);
    activeGcodeSource.pages.delete(pageStartIndex);
    activeGcodeSource.pages.set(pageStartIndex, page);
    return;
  }
  if (activeGcodeSource.loadingPages.has(pageStartIndex)) return;
  const requestID = activeGcodeSource.requestID;
  const signature = activeGcodeSource.signature;
  activeGcodeSource.loadingPages.add(pageStartIndex);
  document.getElementById("active-gcode-source-scroll")?.setAttribute("aria-busy", "true");
  try {
    const response = await request(`/api/gcode/active/source?start_line=${pageStartIndex + 1}&limit=${GCODE_SOURCE_PAGE_SIZE}`);
    if (response.status === 204) {
      if (requestID !== activeGcodeSource.requestID || signature !== activeGcodeSource.signature) return;
      clearConnectivityIssue("active-gcode-source");
      activeGcodeSource.unavailableSignature = signature;
      activeGcodeSource.pages.set(pageStartIndex, []);
      renderActiveGcodeSource();
      return;
    }
    const page = await response.json();
    if (requestID !== activeGcodeSource.requestID || signature !== activeGcodeSource.signature) return;
    activeGcodeSource.totalLines = Math.max(0, Number(page.total_lines) || 0);
    activeGcodeSource.pages.set(pageStartIndex, Array.isArray(page.lines) ? page.lines : []);
    while (activeGcodeSource.pages.size > GCODE_SOURCE_MAX_PAGES) {
      activeGcodeSource.pages.delete(activeGcodeSource.pages.keys().next().value);
    }
    clearConnectivityIssue("active-gcode-source");
    renderActiveGcodeSource();
    const active = state.activeGcode || {};
    const preview = { ...(active.preview || {}), segments: activeGcodeDisplaySegments(active) };
    const live = active.path ? activeJobPreviewState(state.machine, preview, active.path) : null;
    renderDashboardGcodeStream(live);
  } catch (error) {
    if (requestID === activeGcodeSource.requestID) {
      setConnectivityIssue("active-gcode-source", "Gcode source unavailable: " + error.message);
    }
  } finally {
    activeGcodeSource.loadingPages.delete(pageStartIndex);
    if (!activeGcodeSource.loadingPages.size) {
      document.getElementById("active-gcode-source-scroll")?.removeAttribute("aria-busy");
    }
  }
}

function activeGcodeSourceLine(index) {
  const pageStartIndex = Math.floor(index / GCODE_SOURCE_PAGE_SIZE) * GCODE_SOURCE_PAGE_SIZE;
  const page = activeGcodeSource.pages.get(pageStartIndex);
  return page?.[index - pageStartIndex];
}

function gcodeSourceWindow(lineCount, scrollTop, viewportHeight, rowHeight = GCODE_SOURCE_ROW_HEIGHT, overscan = GCODE_SOURCE_OVERSCAN) {
  if (lineCount <= 0 || rowHeight <= 0) return { start: 0, end: 0 };
  const first = Math.max(0, Math.floor(Math.max(0, scrollTop) / rowHeight));
  const visible = Math.max(1, Math.ceil(Math.max(0, viewportHeight) / rowHeight));
  return {
    start: Math.max(0, first - overscan),
    end: Math.min(lineCount, first + visible + overscan),
  };
}

function scheduleActiveGcodeSourceRender() {
  if (activeGcodeSource.renderQueued) return;
  activeGcodeSource.renderQueued = true;
  requestAnimationFrame(() => {
    activeGcodeSource.renderQueued = false;
    renderActiveGcodeSource();
  });
}

function renderActiveGcodeSource() {
  const scroll = document.getElementById("active-gcode-source-scroll");
  const spacer = document.getElementById("active-gcode-source-spacer");
  const container = document.getElementById("active-gcode-source-lines");
  const empty = document.getElementById("active-gcode-source-empty");
  const position = document.getElementById("active-gcode-source-position");
  if (!scroll || !spacer || !container || !empty || !position) return;

  const totalLines = activeGcodeSource.totalLines;
  spacer.style.height = `${totalLines * GCODE_SOURCE_ROW_HEIGHT}px`;
  position.textContent = activeGcodeSource.currentLine > 0
    ? `Ln ${activeGcodeSource.currentLine} / ${totalLines || "—"}`
    : (totalLines ? `${totalLines} lines` : "-");
  empty.textContent = activeGcodeSource.path ? "No gcode source loaded" : "No gcode loaded";
  empty.hidden = totalLines > 0 || activeGcodeSource.loadingPages.size > 0;

  const windowRange = gcodeSourceWindow(
    totalLines,
    scroll.scrollTop,
    scroll.clientHeight,
  );
  for (let index = windowRange.start; index < windowRange.end; index += GCODE_SOURCE_PAGE_SIZE) {
    fetchActiveGcodeSourcePage(index);
  }
  if (windowRange.end > windowRange.start) fetchActiveGcodeSourcePage(windowRange.end - 1);
  const fragment = document.createDocumentFragment();
  for (let index = windowRange.start; index < windowRange.end; index++) {
    const lineNumber = index + 1;
    const row = document.createElement("div");
    row.id = `active-gcode-source-line-${lineNumber}`;
    row.className = "active-gcode-source-line" + (lineNumber === activeGcodeSource.currentLine ? " current" : "");
    row.style.transform = `translateY(${index * GCODE_SOURCE_ROW_HEIGHT}px)`;
    if (lineNumber === activeGcodeSource.currentLine) row.setAttribute("aria-current", "step");

    const number = document.createElement("span");
    number.className = "active-gcode-source-number";
    number.textContent = String(lineNumber);
    number.setAttribute("aria-hidden", "true");
    const code = document.createElement("span");
    code.className = "active-gcode-source-code";
    code.textContent = activeGcodeSourceLine(index) || " ";
    row.append(number, code);
    fragment.appendChild(row);
  }
  container.replaceChildren(fragment);
}

function gcodeSourceLineForCursor(segments, cursor) {
  if (!Array.isArray(segments) || !segments.length || cursor <= 0) return 0;
  const index = Math.min(segments.length, Math.max(1, Math.trunc(cursor))) - 1;
  return Math.max(0, Math.trunc(Number(segments[index]?.line) || 0));
}

function syncActiveGcodeSourceLine(live = null, selectedLine = 0) {
  const liveLine = gcodeView.followLive ? Math.trunc(Number(live?.playedLines) || 0) : 0;
  const line = liveLine > 0
    ? liveLine
    : (selectedLine > 0 ? selectedLine : gcodeSourceLineForCursor(gcodeView.segments, gcodeView.cursor));
  const changed = activeGcodeSource.currentLine !== line;
  activeGcodeSource.currentLine = line;
  if (changed) renderActiveGcodeSource();
  const forceFollow = gcodeTimelineLocallyOwned();
  if (line > 0 && (forceFollow || Date.now() >= activeGcodeSource.userScrollingUntil)) {
    scrollActiveGcodeSourceToLine(line, forceFollow);
  }
}

function scrollActiveGcodeSourceToLine(line, force = false) {
  const scroll = document.getElementById("active-gcode-source-scroll");
  const lineCount = activeGcodeSource.totalLines;
  if (!scroll || line <= 0 || lineCount <= 0) return;
  const targetLine = Math.min(lineCount, Math.max(1, Math.trunc(line)));
  const top = (targetLine - 1) * GCODE_SOURCE_ROW_HEIGHT;
  const margin = Math.min(80, Math.max(GCODE_SOURCE_ROW_HEIGHT, scroll.clientHeight * 0.2));
  const visibleTop = scroll.scrollTop + margin;
  const visibleBottom = scroll.scrollTop + scroll.clientHeight - margin;
  if (!force && top >= visibleTop && top + GCODE_SOURCE_ROW_HEIGHT <= visibleBottom) return;
  scroll.scrollTop = Math.max(0, top - Math.max(0, (scroll.clientHeight - GCODE_SOURCE_ROW_HEIGHT) / 2));
  fetchActiveGcodeSourcePage(targetLine - 1);
  renderActiveGcodeSource();
}

function activeJobOverlayOriginFrom(liveOrigin, outline) {
  const capturedOrigin = cloneOutlineOrigin(outline?.origin) || {};
  const origin = {};
  for (const axis of ["x", "y"]) {
    const live = axisValue(liveOrigin, axis);
    const captured = axisValue(capturedOrigin, axis);
    const value = live === null ? captured : live;
    if (value !== null) origin[axis] = value;
  }
  const liveZ = axisValue(liveOrigin, "z");
  const fieldReferenceZ = outline?.fieldReferenceMachineZ === null || outline?.fieldReferenceMachineZ === ""
    ? NaN
    : Number(outline?.fieldReferenceMachineZ);
  const floorZ = outline?.floorMachineZ === null || outline?.floorMachineZ === ""
    ? NaN
    : Number(outline?.floorMachineZ);
  const capturedZ = axisValue(capturedOrigin, "z");
  const fallbackZ = Number.isFinite(fieldReferenceZ)
    ? fieldReferenceZ
    : (Number.isFinite(floorZ) ? floorZ : capturedZ);
  const z = liveZ === null ? fallbackZ : liveZ;
  if (z !== null && Number.isFinite(z)) origin.z = z;
  return Object.keys(origin).length ? origin : null;
}

function activeJobOverlayOrigin() {
  return activeJobOverlayOriginFrom(currentWorkOrigin(), state.outline);
}

function activeJobOverlayPoint(point, origin) {
  const ox = axisValue(origin, "x");
  const oy = axisValue(origin, "y");
  const oz = axisValue(origin, "z");
  const machineX = Number(point?.machine_x);
  const machineY = Number(point?.machine_y);
  const machineZ = Number(point?.machine_z);
  const storedX = Number(point?.x);
  const storedY = Number(point?.y);
  const storedZ = Number(point?.z);
  const x = Number.isFinite(machineX) && ox !== null ? machineX - ox : storedX;
  const y = Number.isFinite(machineY) && oy !== null ? machineY - oy : storedY;
  const z = Number.isFinite(machineZ) && oz !== null ? machineZ - oz : storedZ;
  return [x, y, z].every(Number.isFinite) ? { ...point, x, y, z } : null;
}

function probePlanMatchesResults(plan, results, tolerance = 0.05) {
  if (!Array.isArray(plan) || !Array.isArray(results) || plan.length !== results.length || !plan.length) return false;
  const cellSize = Math.max(0.000001, Number(tolerance) || 0.05);
  const buckets = new Map();
  const cellKey = (x, y) => `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)}`;
  for (let index = 0; index < results.length; index++) {
    const x = Number(results[index]?.x);
    const y = Number(results[index]?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    const key = cellKey(x, y);
    const bucket = buckets.get(key) || [];
    bucket.push(index);
    buckets.set(key, bucket);
  }
  const used = new Set();
  for (const point of plan) {
    const x = Number(point?.x);
    const y = Number(point?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    const cx = Math.floor(x / cellSize);
    const cy = Math.floor(y / cellSize);
    let best = -1;
    let bestDistance = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const candidate of buckets.get(`${cx + dx},${cy + dy}`) || []) {
          if (used.has(candidate)) continue;
          const result = results[candidate];
          const distance = Math.hypot(x - Number(result.x), y - Number(result.y));
          if (distance <= cellSize && distance < bestDistance) {
            best = candidate;
            bestDistance = distance;
          }
        }
      }
    }
    if (best < 0) return false;
    used.add(best);
  }
  return used.size === results.length;
}

function activeJobFieldProbeComplete(outline) {
  const plan = outline?.fieldProbePreview || [];
  const results = outline?.fieldProbeResults || [];
  return !!outline?.active &&
    !!outline?.closed &&
    !outline?.fieldProbePending &&
    results.length >= 3 &&
    (outline?.fieldProbeComplete === true || (plan.length >= 3 && probePlanMatchesResults(plan, results)));
}

function interpolateOutlinePathZ(point, source, closed) {
  if (!Array.isArray(source) || !source.length) return 0;
  if (source.length === 1) return Number(source[0]?.z) || 0;
  const x = Number(point?.x);
  const y = Number(point?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return Number(source[0]?.z) || 0;
  const segmentCount = closed ? source.length : source.length - 1;
  let bestDistanceSq = Infinity;
  let bestZ = Number(source[0]?.z) || 0;
  for (let index = 0; index < segmentCount; index++) {
    const a = source[index];
    const b = source[(index + 1) % source.length];
    const ax = Number(a?.x);
    const ay = Number(a?.y);
    const bx = Number(b?.x);
    const by = Number(b?.y);
    if (![ax, ay, bx, by].every(Number.isFinite)) continue;
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq > 0
      ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSq))
      : 0;
    const projectedX = ax + dx * t;
    const projectedY = ay + dy * t;
    const distanceSq = (x - projectedX) ** 2 + (y - projectedY) ** 2;
    if (distanceSq >= bestDistanceSq) continue;
    const az = Number(a?.z);
    const bz = Number(b?.z);
    if (Number.isFinite(az) && Number.isFinite(bz)) bestZ = az + (bz - az) * t;
    else if (Number.isFinite(az)) bestZ = az;
    else if (Number.isFinite(bz)) bestZ = bz;
    bestDistanceSq = distanceSq;
  }
  return bestZ;
}

function activeJobContextOverlayData(outline, origin) {
  if (!outline?.active || !Array.isArray(outline.points) || !outline.points.length) {
    return { outline: [], markers: [], surface: null, bounds: null, closed: false };
  }
  const source = outline.points.map((point) => activeJobOverlayPoint(point, origin)).filter(Boolean);
  const effective = effectiveOutlineGeometry(source, !!outline.closed, !!outline.curveFit);
  let outlinePoints = effective.points.map((point) => ({
    x: point.x,
    y: point.y,
    z: interpolateOutlinePathZ(point, source, !!outline.closed),
  }));
  let markers = source.map((point) => ({ x: point.x, y: point.y, z: point.z }));
  let surface = null;

  if (!effective.limited && activeJobFieldProbeComplete(outline)) {
    const samples = outline.fieldProbeResults
      .map((point) => activeJobOverlayPoint(point, origin))
      .filter((point) => point && [point.x, point.y, point.z].every(Number.isFinite));
    let polygon = effective.points.map((point) => ({ x: point.x, y: point.y }));
    if (
      polygon.length > 2 &&
      Math.hypot(polygon[0].x - polygon.at(-1).x, polygon[0].y - polygon.at(-1).y) <= 0.00005
    ) {
      polygon = polygon.slice(0, -1);
    }
    try {
      const meshVertices = buildHeightMeshVertices(samples, polygon);
      const points = [];
      for (const point of meshVertices) {
        if (points.some((seen) => Math.hypot(seen.x - point.x, seen.y - point.y) <= 0.000001)) continue;
        points.push(point);
      }
      const faces = points.length >= 3 ? constrainedOutlineTriangles(points, polygon) : [];
      if (faces.length) {
        surface = { points, faces };
        outlinePoints = outlinePoints.map((point) => ({
          ...point,
          z: interpolateZ(point.x, point.y, samples),
        }));
        markers = markers.map((point) => ({
          ...point,
          z: interpolateZ(point.x, point.y, samples),
        }));
      }
    } catch {
      surface = null;
    }
  }

  const bounds = activeJobOverlayBounds([
    ...outlinePoints,
    ...markers,
    ...(surface?.points || []),
  ]);
  return { outline: outlinePoints, markers, surface, bounds, closed: !!outline.closed };
}

function activeJobOverlayBounds(points) {
  const valid = (points || []).filter((point) => [point?.x, point?.y, point?.z].every(Number.isFinite));
  if (!valid.length) return null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const point of valid) {
    for (const [index, value] of [point.x, point.y, point.z].entries()) {
      min[index] = Math.min(min[index], value);
      max[index] = Math.max(max[index], value);
    }
  }
  return { min, max };
}

function combineGcodeBounds(a, b) {
  const valid = (bounds) =>
    bounds && [0, 1, 2].every((index) => Number.isFinite(Number(bounds.min?.[index])) && Number.isFinite(Number(bounds.max?.[index])));
  if (!valid(a)) return valid(b) ? { min: b.min.slice(0, 3), max: b.max.slice(0, 3) } : null;
  if (!valid(b)) return { min: a.min.slice(0, 3), max: a.max.slice(0, 3) };
  return {
    min: [0, 1, 2].map((index) => Math.min(Number(a.min[index]), Number(b.min[index]))),
    max: [0, 1, 2].map((index) => Math.max(Number(a.max[index]), Number(b.max[index]))),
  };
}

function activeJobContextOverlayKey(origin) {
  const coord = (axis) => {
    const value = axisValue(origin, axis);
    return value === null ? "-" : Number(value).toFixed(4);
  };
  return `${outlineContextRevision}:${coord("x")}:${coord("y")}:${coord("z")}`;
}

function syncGcodeContextOverlay() {
  if (!gcodeView.contextGroup) return false;
  const origin = activeJobOverlayOrigin();
  const key = activeJobContextOverlayKey(origin);
  if (gcodeView.contextKey === key) return false;
  const data = activeJobContextOverlayData(state.outline, origin);
  clearThreeGroup(gcodeView.contextGroup);
  rebuildGcodeContextOverlay(data);
  gcodeView.contextKey = key;
  gcodeView.contextBounds = data.bounds;
  gcodeView.contextVisible = !!data.bounds;
  scheduleGcodeRender();
  return true;
}

function rebuildGcodeContextOverlay(data) {
  rebuildGcodeContextOverlayForGroup(gcodeView.contextGroup, data);
}

function rebuildGcodeContextOverlayForGroup(group, data) {
  if (!group) return;
  const outlineColor = data.closed ? 0x44c27b : 0x57a6d6;
  if (data.surface?.points?.length && data.surface.faces?.length) {
    const geometry = new THREE.BufferGeometry();
    const positions = [];
    for (const point of data.surface.points) {
      const world = gcodeWorldPoint([point.x, point.y, point.z, 0], false);
      positions.push(world.x, world.y, world.z);
    }
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(data.surface.faces.flat());
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        color: 0x44c27b,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    mesh.renderOrder = -10;
    group.add(mesh);
    const wire = new THREE.LineSegments(
      new THREE.WireframeGeometry(geometry),
      new THREE.LineBasicMaterial({
        color: 0x72d69e,
        transparent: true,
        opacity: 0.2,
        depthWrite: false,
      }),
    );
    wire.renderOrder = -9;
    group.add(wire);
  }
  if (data.outline.length >= 2) {
    const points = data.outline.map((point) => gcodeWorldPoint([point.x, point.y, point.z, 0], false));
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({
        color: outlineColor,
        transparent: true,
        opacity: 0.92,
        depthTest: false,
      }),
    );
    line.renderOrder = -8;
    group.add(line);
  }
  if (data.markers.length) {
    const points = data.markers.map((point) => gcodeWorldPoint([point.x, point.y, point.z, 0], false));
    const markers = new THREE.Points(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.PointsMaterial({
        color: outlineColor,
        size: 4,
        sizeAttenuation: false,
        transparent: true,
        opacity: 0.95,
        depthTest: false,
      }),
    );
    markers.renderOrder = -7;
    group.add(markers);
  }
}

function gcodeRenderPixelRatio(width = 0, height = 0, pixelBudget = GCODE_RENDER_PIXEL_BUDGET) {
  const deviceRatio = Math.max(1, Number(globalThis.devicePixelRatio) || 1);
  if (!(width > 0 && height > 0 && pixelBudget > 0)) return deviceRatio;
  const budgetRatio = Math.sqrt(pixelBudget / (width * height));
  return Math.max(1, Math.min(deviceRatio, budgetRatio));
}

function ensureGcodeViewer() {
  if (gcodeView.renderer) return true;
  const canvas = document.getElementById("gcode-preview");
  if (!canvas) return false;
  gcodeView.canvas = canvas;
  gcodeView.empty = document.getElementById("gcode-preview-empty");
  try {
    gcodeView.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  } catch (e) {
    setGcodePreviewEmpty("3D preview unavailable");
    return false;
  }
  gcodeView.pixelRatio = gcodeRenderPixelRatio();
  gcodeView.renderer.setPixelRatio(gcodeView.pixelRatio);
  gcodeView.renderer.setClearColor(0x202832, 1);
  gcodeView.scene = new THREE.Scene();
  gcodeView.perspCamera = new THREE.PerspectiveCamera(GCODE_FOV, 1, 0.1, 100000);
  gcodeView.orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100000);
  gcodeView.camera = gcodeView.projection === "orthographic" ? gcodeView.orthoCamera : gcodeView.perspCamera;
  gcodeView.pathGroup = new THREE.Group();
  gcodeView.scene.add(gcodeView.pathGroup);
  gcodeView.contextGroup = new THREE.Group();
  gcodeView.scene.add(gcodeView.contextGroup);
  const markerGeometry = new THREE.SphereGeometry(1, 16, 12);
  const markerMaterial = new THREE.MeshBasicMaterial({ color: 0xd99a3a });
  gcodeView.marker = new THREE.Mesh(markerGeometry, markerMaterial);
  gcodeView.marker.visible = false;
  gcodeView.scene.add(gcodeView.marker);
  bindGcodeOrbitControls(canvas);
  initGcodeViewCube();
  bindGcodeProjectionToggle();
  if (globalThis.ResizeObserver) {
    gcodeView.resizeObserver = new ResizeObserver(() => scheduleGcodeRender());
    gcodeView.resizeObserver.observe(canvas);
  }
  window.addEventListener("resize", scheduleGcodeRender);
  return true;
}

function ensureDashboardGcodeViewer() {
  if (dashboardGcodeView.renderer) return true;
  const canvas = document.getElementById("dashboard-preview");
  if (!canvas) return false;
  dashboardGcodeView.canvas = canvas;
  dashboardGcodeView.empty = document.getElementById("dashboard-preview-empty");
  try {
    dashboardGcodeView.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  } catch {
    setDashboardGcodePreviewEmpty("3D preview unavailable");
    return false;
  }
  dashboardGcodeView.pixelRatio = gcodeRenderPixelRatio();
  dashboardGcodeView.renderer.setPixelRatio(dashboardGcodeView.pixelRatio);
  dashboardGcodeView.renderer.setClearColor(0x202832, 1);
  dashboardGcodeView.scene = new THREE.Scene();
  dashboardGcodeView.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100000);
  dashboardGcodeView.pathGroup = new THREE.Group();
  dashboardGcodeView.contextGroup = new THREE.Group();
  dashboardGcodeView.scene.add(dashboardGcodeView.pathGroup);
  dashboardGcodeView.scene.add(dashboardGcodeView.contextGroup);
  dashboardGcodeView.marker = new THREE.Mesh(
    new THREE.SphereGeometry(1, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xd99a3a }),
  );
  dashboardGcodeView.marker.visible = false;
  dashboardGcodeView.scene.add(dashboardGcodeView.marker);
  if (globalThis.ResizeObserver) {
    dashboardGcodeView.resizeObserver = new ResizeObserver(scheduleDashboardGcodeRender);
    dashboardGcodeView.resizeObserver.observe(canvas);
  }
  window.addEventListener("resize", scheduleDashboardGcodeRender);
  return true;
}

function clearDashboardGcodeScene() {
  dashboardGcodeView.key = "";
  dashboardGcodeView.renderStateKey = "";
  dashboardGcodeView.segments = [];
  if (!dashboardGcodeView.renderer) return;
  clearThreeGroup(dashboardGcodeView.pathGroup);
  clearThreeGroup(dashboardGcodeView.contextGroup);
  disposeObject(dashboardGcodeView.progressLine);
  dashboardGcodeView.progressLine = null;
  dashboardGcodeView.marker.visible = false;
  scheduleDashboardGcodeRender();
}

function setDashboardGcodePreviewEmpty(text) {
  const empty = dashboardGcodeView.empty || document.getElementById("dashboard-preview-empty");
  if (!empty) return;
  empty.textContent = text || "";
  empty.hidden = !text;
}

function fitDashboardGcodeCamera(bounds) {
  if (!bounds?.min || !bounds?.max || !dashboardGcodeView.camera) return;
  const min = bounds.min;
  const max = bounds.max;
  const center = [0, 1, 2].map((index) => (Number(min[index]) + Number(max[index])) / 2);
  dashboardGcodeView.target.set(...gcodeWorldCoordinates([...center, 0], false));
  const radius = Math.max(
    Math.abs(Number(max[0]) - Number(min[0])),
    Math.abs(Number(max[1]) - Number(min[1])),
    Math.abs(Number(max[2]) - Number(min[2])),
    1,
  );
  const direction = gcodeOrbitAnglesForDirection({ x: 1, y: 1, z: 1 });
  dashboardGcodeView.orbit.theta = direction.theta;
  dashboardGcodeView.orbit.phi = direction.phi;
  dashboardGcodeView.orbit.radius = radius * 2.4 + 20;
  updateDashboardGcodeCamera();
}

function updateDashboardGcodeCamera() {
  const view = dashboardGcodeView;
  if (!view.camera) return;
  const sinPhi = Math.sin(view.orbit.phi);
  view.camera.up.set(0, 1, 0);
  view.camera.position.set(
    view.target.x + view.orbit.radius * sinPhi * Math.sin(view.orbit.theta),
    view.target.y + view.orbit.radius * Math.cos(view.orbit.phi),
    view.target.z + view.orbit.radius * sinPhi * Math.cos(view.orbit.theta),
  );
  view.camera.lookAt(view.target);
  syncDashboardGcodeProjection();
  scheduleDashboardGcodeRender();
}

function syncDashboardGcodeProjection() {
  const view = dashboardGcodeView;
  if (!view.camera) return;
  const aspect = view.height > 0 ? view.width / view.height : 1;
  const radius = view.orbit.radius;
  const halfH = Math.tan(THREE.MathUtils.degToRad(GCODE_FOV) / 2) * radius;
  view.camera.near = Math.max(0.01, radius / 1000);
  view.camera.far = Math.max(1000, radius * 100);
  view.camera.top = halfH;
  view.camera.bottom = -halfH;
  view.camera.left = -halfH * aspect;
  view.camera.right = halfH * aspect;
  view.camera.updateProjectionMatrix();
}

function scheduleDashboardGcodeRender() {
  if (!dashboardGcodeView.renderer || dashboardGcodeView.renderQueued) return;
  dashboardGcodeView.renderQueued = true;
  requestAnimationFrame(() => {
    dashboardGcodeView.renderQueued = false;
    renderDashboardGcodeScene();
  });
}

function renderDashboardGcodeScene() {
  const view = dashboardGcodeView;
  if (!view.renderer || !view.camera || !view.canvas) return;
  const rect = view.canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  const pixelRatio = gcodeRenderPixelRatio(width, height);
  const sizeChanged = view.width !== width || view.height !== height;
  const ratioChanged = Math.abs(view.pixelRatio - pixelRatio) > 0.001;
  if (ratioChanged) {
    view.pixelRatio = pixelRatio;
    view.renderer.setPixelRatio(pixelRatio);
  }
  if (sizeChanged || ratioChanged) {
    view.width = width;
    view.height = height;
    view.renderer.setSize(width, height, false);
    syncDashboardGcodeProjection();
  }
  view.renderer.render(view.scene, view.camera);
}

function bindGcodeOrbitControls(canvas) {
  const setPanKey = () => {
    const on = gcodeView.panKeys.size > 0;
    gcodeView.panKeyDown = on;
    canvas.classList.toggle("pan-mode", on || gcodeView.dragMode === "pan");
  };
  canvas.addEventListener("pointerdown", (e) => {
    let pinching = false;
    if (e.pointerType === "touch") {
      gcodeView.touchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (gcodeView.touchPointers.size === 2) {
        const [first, second] = gcodeView.touchPointers.values();
        gcodeView.pinchDistance = gcodePinchDistance(first, second);
        pinching = true;
        e.preventDefault();
      }
    }
    gcodeView.dragging = !pinching;
    gcodeView.dragX = e.clientX;
    gcodeView.dragY = e.clientY;
    gcodeView.dragMode = (e.shiftKey || gcodeView.panKeyDown || e.button === 1) ? "pan" : "orbit";
    canvas.classList.toggle("pan-mode", gcodeView.dragMode === "pan" || gcodeView.panKeyDown);
    if (gcodeView.dragMode === "pan") e.preventDefault();
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture?.(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch" && gcodeView.touchPointers.has(e.pointerId)) {
      gcodeView.touchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (gcodeView.touchPointers.size === 2) {
        const [first, second] = gcodeView.touchPointers.values();
        const distance = gcodePinchDistance(first, second);
        if (gcodeView.pinchDistance > 0 && distance > 0) {
          gcodeView.orbit.radius = gcodeOrbitRadiusAfterPinch(gcodeView.orbit.radius, gcodeView.pinchDistance, distance);
          updateGcodeCamera();
        }
        gcodeView.pinchDistance = distance;
        e.preventDefault();
        return;
      }
    }
    if (!gcodeView.dragging) return;
    const dx = e.clientX - gcodeView.dragX;
    const dy = e.clientY - gcodeView.dragY;
    gcodeView.dragX = e.clientX;
    gcodeView.dragY = e.clientY;
    if (e.shiftKey || gcodeView.panKeyDown || gcodeView.dragMode === "pan") {
      gcodeView.dragMode = "pan";
      canvas.classList.add("pan-mode");
      panGcodeCamera(dx, dy);
    } else {
      rotateGcodeOrbitByDrag(gcodeView.orbit, dx, dy);
      updateGcodeCamera();
    }
  });
  const stopDrag = (e) => {
    let keepDragging = false;
    if (e.pointerType === "touch") {
      gcodeView.touchPointers.delete(e.pointerId);
      gcodeView.pinchDistance = 0;
      if (gcodeView.touchPointers.size === 1) {
        const [{ x, y }] = gcodeView.touchPointers.values();
        keepDragging = true;
        gcodeView.dragX = x;
        gcodeView.dragY = y;
      }
    }
    gcodeView.dragging = keepDragging;
    gcodeView.dragMode = "orbit";
    canvas.classList.toggle("pan-mode", gcodeView.panKeyDown);
    canvas.releasePointerCapture?.(e.pointerId);
  };
  canvas.addEventListener("pointerup", stopDrag);
  canvas.addEventListener("pointercancel", stopDrag);
  canvas.addEventListener("pointerenter", () => { gcodeView.hovering = true; });
  canvas.addEventListener("pointerleave", () => {
    gcodeView.hovering = false;
    if (!gcodeView.dragging) canvas.classList.toggle("pan-mode", gcodeView.panKeyDown);
  });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    gcodeView.orbit.radius = gcodeOrbitRadiusAfterWheel(gcodeView.orbit.radius, e.deltaY);
    updateGcodeCamera();
  }, { passive: false });
  window.addEventListener("keydown", (e) => {
    if (isTypingTarget(e.target)) return;
    if (e.key !== "Shift" && e.code !== "Space") return;
    if (!gcodeView.hovering && document.activeElement !== canvas && !gcodeView.dragging) return;
    if (e.code === "Space") e.preventDefault();
    gcodeView.panKeys.add(e.code === "Space" ? "space" : "shift");
    setPanKey();
  });
  window.addEventListener("keyup", (e) => {
    if (e.key !== "Shift" && e.code !== "Space") return;
    if (e.code === "Space" && (gcodeView.hovering || document.activeElement === canvas)) e.preventDefault();
    gcodeView.panKeys.delete(e.code === "Space" ? "space" : "shift");
    setPanKey();
  });
  window.addEventListener("blur", () => {
    gcodeView.panKeys.clear();
    gcodeView.touchPointers.clear();
    gcodeView.pinchDistance = 0;
    gcodeView.dragging = false;
    setPanKey();
  });
}

function gcodePinchDistance(first, second) {
  return Math.hypot(Number(second?.x) - Number(first?.x), Number(second?.y) - Number(first?.y));
}

function gcodeOrbitRadiusAfterPinch(radius, previousDistance, distance) {
  if (!(previousDistance > 0) || !(distance > 0)) return radius;
  return Math.max(GCODE_ORBIT_MIN_RADIUS, Math.min(GCODE_ORBIT_MAX_RADIUS, radius * previousDistance / distance));
}

function gcodeOrbitRadiusAfterWheel(radius, deltaY) {
  return Math.max(GCODE_ORBIT_MIN_RADIUS, Math.min(GCODE_ORBIT_MAX_RADIUS, radius * Math.exp(deltaY * 0.001)));
}

function rotateGcodeOrbitByDrag(orbit, dx, dy) {
  orbit.theta -= dx * GCODE_ORBIT_DRAG_RAD_PER_PX;
  orbit.phi = Math.max(
    0.08,
    Math.min(Math.PI - 0.08, orbit.phi - dy * GCODE_ORBIT_DRAG_RAD_PER_PX),
  );
  return orbit;
}

function isTypingTarget(el) {
  if (!el) return false;
  const tag = String(el.tagName || "").toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable;
}

function rebuildGcodeScene(preview, segments) {
  populateGcodePathScene(gcodeView, preview, segments);
}

function populateGcodePathScene(view, preview, segments) {
  // Toolpath and outline/probe context have separate cache keys and lifecycles.
  // Context is rebuilt by syncGcodeContextOverlay and must survive path rebuilds.
  clearThreeGroup(view.pathGroup);
  disposeObject(view.progressLine);
  view.progressLine = null;
  const bounds = preview.bounds || {};
  addGcodeGridToView(view, bounds);
  const byKind = { rapid: [], cut: [], arc: [], probe: [] };
  const progress = new Float32Array(segments.length * 6);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] || {};
    const a = gcodeWorldPoint(seg.from || [0, 0, 0, 0], preview.has_4axis);
    const b = gcodeWorldPoint(seg.to || [0, 0, 0, 0], preview.has_4axis);
    const kind = byKind[seg.kind] ? seg.kind : "cut";
    byKind[kind].push(a.x, a.y, a.z, b.x, b.y, b.z);
    const j = i * 6;
    progress[j] = a.x;
    progress[j + 1] = a.y;
    progress[j + 2] = a.z;
    progress[j + 3] = b.x;
    progress[j + 4] = b.y;
    progress[j + 5] = b.z;
  }
  for (const kind of ["rapid", "cut", "arc", "probe"]) {
    if (!byKind[kind].length) continue;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(byKind[kind], 3));
    const material = new THREE.LineBasicMaterial({
      color: GCODE_KIND_COLORS[kind],
      transparent: true,
      opacity: kind === "rapid" ? 0.42 : 0.82,
    });
    view.pathGroup.add(new THREE.LineSegments(geometry, material));
  }
  const progressGeometry = new THREE.BufferGeometry();
  progressGeometry.setAttribute("position", new THREE.BufferAttribute(progress, 3));
  progressGeometry.setDrawRange(0, progress.length / 3);
  const progressMaterial = new THREE.LineBasicMaterial({ color: 0xf2f6fa, transparent: true, opacity: 0.95 });
  view.progressLine = new THREE.LineSegments(progressGeometry, progressMaterial);
  view.scene.add(view.progressLine);
}

function addGcodeGrid(bounds) {
  addGcodeGridToView(gcodeView, bounds);
}

function addGcodeGridToView(view, bounds) {
  const min = bounds.min || [0, 0, 0];
  const max = bounds.max || [1, 1, 1];
  const spanX = Math.max(Math.abs(Number(max[0]) - Number(min[0])), 1);
  const spanY = Math.max(Math.abs(Number(max[1]) - Number(min[1])), 1);
  const size = Math.max(spanX, spanY, 20) * 1.15;
  const divisions = Math.max(4, Math.min(80, Math.round(size / 10)));
  const grid = new THREE.GridHelper(size, divisions, 0x5f6c78, 0x303946);
  const center = gcodeWorldCoordinates([
    (Number(min[0]) + Number(max[0])) / 2,
    (Number(min[1]) + Number(max[1])) / 2,
    Number(min[2]) || 0,
    0,
  ], false);
  grid.position.set(...center);
  view.pathGroup.add(grid);
  // Origin marker with axis legends sits at the work origin (machine 0,0,0).
  view.pathGroup.add(buildGcodeOriginAxes(Math.max(5, size * 0.12), view.renderer));
}

function buildGcodeOriginAxes(len, renderer = gcodeView.renderer) {
  const group = new THREE.Group();
  const axes = [
    // Machine X+ is world +x, machine Y+ is world -z, machine Z+ is world +y.
    { color: GCODE_AXIS_COLORS.x, dir: new THREE.Vector3(1, 0, 0), plus: "X+", minus: "X-" },
    { color: GCODE_AXIS_COLORS.y, dir: new THREE.Vector3(0, 0, -1), plus: "Y+", minus: "Y-" },
    { color: GCODE_AXIS_COLORS.z, dir: new THREE.Vector3(0, 1, 0), plus: "Z+", minus: "" },
  ];
  const headLen = len * 0.16;
  const headRadius = len * 0.05;
  for (const axis of axes) {
    const color = new THREE.Color(axis.color);
    const from = axis.minus ? axis.dir.clone().multiplyScalar(-len) : new THREE.Vector3();
    const to = axis.dir.clone().multiplyScalar(len);
    const lineGeometry = new THREE.BufferGeometry().setFromPoints([from, to]);
    group.add(new THREE.Line(lineGeometry, new THREE.LineBasicMaterial({ color })));
    for (const sign of axis.minus ? [1, -1] : [1]) {
      const head = new THREE.Mesh(
        new THREE.ConeGeometry(headRadius, headLen, 12),
        new THREE.MeshBasicMaterial({ color }),
      );
      const tipDir = axis.dir.clone().multiplyScalar(sign);
      head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tipDir);
      head.position.copy(tipDir.multiplyScalar(len - headLen / 2));
      group.add(head);
      const label = makeGcodeAxisLabel(sign > 0 ? axis.plus : axis.minus, axis.color, renderer);
      label.position.copy(axis.dir.clone().multiplyScalar(sign * (len + len * 0.22)));
      label.scale.setScalar(len * 0.34);
      group.add(label);
    }
  }
  return group;
}

function makeGcodeAxisLabel(text, color, renderer = gcodeView.renderer) {
  const size = 256;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d");
  ctx.font = "700 116px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.lineWidth = 24;
  ctx.strokeStyle = "#12171c";
  ctx.strokeText(text, size / 2, size / 2);
  ctx.fillStyle = color;
  ctx.fillText(text, size / 2, size / 2);
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  if (renderer) texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }));
  sprite.renderOrder = 10;
  return sprite;
}

function clearGcodeScene() {
  gcodeView.live = null;
  gcodeView.followLive = false;
  if (gcodeView.canvas) gcodeView.canvas.setAttribute("aria-label", "Active gcode preview");
  if (!gcodeView.renderer) return;
  clearThreeGroup(gcodeView.pathGroup);
  clearThreeGroup(gcodeView.contextGroup);
  disposeObject(gcodeView.progressLine);
  gcodeView.progressLine = null;
  gcodeView.marker.visible = false;
  gcodeView.key = "";
  gcodeView.fitKey = "";
  gcodeView.contextKey = "";
  gcodeView.contextBounds = null;
  gcodeView.contextVisible = false;
  gcodeView.segments = [];
  gcodeView.cursor = 0;
  gcodeView.timelineEventLine = 0;
  gcodeView.timelineEventsKey = "";
  scheduleGcodeRender();
}

function fitGcodeCamera(bounds) {
  const min = bounds.min || [0, 0, 0];
  const max = bounds.max || [1, 1, 1];
  const cx = (Number(min[0]) + Number(max[0])) / 2;
  const cy = (Number(min[1]) + Number(max[1])) / 2;
  const cz = (Number(min[2]) + Number(max[2])) / 2;
  gcodeView.target.set(...gcodeWorldCoordinates([cx, cy, cz, 0], false));
  const spanX = Math.abs(Number(max[0]) - Number(min[0]));
  const spanY = Math.abs(Number(max[1]) - Number(min[1]));
  const spanZ = Math.abs(Number(max[2]) - Number(min[2]));
  const radius = Math.max(spanX, spanY, spanZ, 1);
  gcodeView.orbit.radius = radius * 2.4 + 20;
  updateGcodeCamera();
}

function updateGcodeCamera() {
  if (!gcodeView.camera) return;
  const o = gcodeView.orbit;
  const sinPhi = Math.sin(o.phi);
  const x = gcodeView.target.x + o.radius * sinPhi * Math.sin(o.theta);
  const y = gcodeView.target.y + o.radius * Math.cos(o.phi);
  const z = gcodeView.target.z + o.radius * sinPhi * Math.cos(o.theta);
  if (Math.abs(sinPhi) < 0.02) {
    // Looking straight down/up the world-up axis: pick an up vector that keeps
    // machine Y+ toward the top of the screen so top/bottom views stay stable.
    gcodeView.camera.up.set(-Math.sin(o.theta), 0, -Math.cos(o.theta));
  } else {
    gcodeView.camera.up.set(0, 1, 0);
  }
  gcodeView.camera.position.set(x, y, z);
  gcodeView.camera.lookAt(gcodeView.target);
  syncGcodeProjection();
  scheduleGcodeRender();
}

function syncGcodeProjection() {
  const camera = gcodeView.camera;
  if (!camera) return;
  const aspect = gcodeView.height > 0 ? gcodeView.width / gcodeView.height : 1;
  const radius = gcodeView.orbit.radius;
  camera.near = Math.max(0.01, radius / 1000);
  camera.far = Math.max(1000, radius * 100);
  if (camera.isOrthographicCamera) {
    const halfH = Math.tan(THREE.MathUtils.degToRad(GCODE_FOV) / 2) * radius;
    camera.top = halfH;
    camera.bottom = -halfH;
    camera.left = -halfH * aspect;
    camera.right = halfH * aspect;
  } else {
    camera.aspect = aspect;
  }
  camera.updateProjectionMatrix();
}

function setGcodeProjection(mode) {
  const projection = mode === "orthographic" ? "orthographic" : "perspective";
  gcodeView.projection = projection;
  if (gcodeView.perspCamera) {
    gcodeView.camera = projection === "orthographic" ? gcodeView.orthoCamera : gcodeView.perspCamera;
    updateGcodeCamera();
  }
  for (const [id, value] of [["gcode-projection-persp", "perspective"], ["gcode-projection-ortho", "orthographic"]]) {
    const btn = document.getElementById(id);
    if (btn) btn.setAttribute("aria-pressed", projection === value ? "true" : "false");
  }
}

function bindGcodeProjectionToggle() {
  const persp = document.getElementById("gcode-projection-persp");
  const ortho = document.getElementById("gcode-projection-ortho");
  if (persp && !persp.dataset.bound) {
    persp.dataset.bound = "1";
    persp.onclick = () => setGcodeProjection("perspective");
  }
  if (ortho && !ortho.dataset.bound) {
    ortho.dataset.bound = "1";
    ortho.onclick = () => setGcodeProjection("orthographic");
  }
}

function initGcodeViewCube() {
  if (gcodeView.cube) return;
  const canvas = document.getElementById("gcode-viewcube");
  if (!canvas) return;
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch (e) {
    return;
  }
  const pixelRatio = gcodeRenderPixelRatio();
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(104, 104, false); // matches the fixed CSS size; the widget may be hidden (0x0) at init
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1.75, 1.75, 1.75, -1.75, 0.1, 10);
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);
  const materials = VIEWCUBE_FACES.map((face) => new THREE.MeshBasicMaterial({
    map: makeViewCubeFaceTexture(face.label, face.rotation, renderer),
  }));
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), materials);
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(mesh.geometry),
    new THREE.LineBasicMaterial({ color: 0x5f6c78 }),
  );
  edges.scale.setScalar(1.001);
  mesh.add(edges);
  const hover = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({
      color: 0x57a6d6,
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
    }),
  );
  hover.add(new THREE.LineSegments(
    new THREE.EdgesGeometry(hover.geometry),
    new THREE.LineBasicMaterial({ color: 0xa9ddff, transparent: true, opacity: 0.95 }),
  ));
  hover.visible = false;
  hover.renderOrder = 3;
  mesh.add(hover);
  scene.add(mesh);
  gcodeView.cube = {
    renderer,
    scene,
    camera,
    mesh,
    hover,
    hoverKey: "",
    canvas,
    raycaster: new THREE.Raycaster(),
    width: 104,
    height: 104,
    pixelRatio,
    dragPointerId: null,
    dragStartX: 0,
    dragStartY: 0,
    dragX: 0,
    dragY: 0,
    dragging: false,
    suppressClick: false,
  };
  canvas.addEventListener("pointerdown", onGcodeViewCubePointerDown);
  canvas.addEventListener("pointermove", onGcodeViewCubePointerMove);
  canvas.addEventListener("pointerup", onGcodeViewCubePointerUp);
  canvas.addEventListener("pointercancel", onGcodeViewCubePointerCancel);
  canvas.addEventListener("pointerleave", clearGcodeViewCubeHover);
  canvas.addEventListener("click", onGcodeViewCubeClick);
}

function makeViewCubeFaceTexture(label, rotation, renderer) {
  const size = 512;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#232b31";
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = "#3a444d";
  ctx.lineWidth = 16;
  ctx.strokeRect(8, 8, size - 16, size - 16);
  ctx.translate(size / 2, size / 2);
  ctx.rotate(rotation || 0);
  ctx.font = "700 96px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.lineWidth = 16;
  ctx.strokeStyle = "#12171c";
  ctx.strokeText(label, 0, 0);
  ctx.fillStyle = "#b7c0ca";
  ctx.fillText(label, 0, 0);
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return texture;
}

function renderGcodeViewCube() {
  const cube = gcodeView.cube;
  if (!cube || !gcodeView.camera) return;
  syncGcodeViewCubeResolution(cube);
  cube.mesh.quaternion.copy(gcodeView.camera.quaternion).invert();
  cube.renderer.render(cube.scene, cube.camera);
}

function syncGcodeViewCubeResolution(cube) {
  const rect = cube.canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width || 104));
  const height = Math.max(1, Math.round(rect.height || 104));
  const pixelRatio = gcodeRenderPixelRatio(width, height);
  const ratioChanged = Math.abs(cube.pixelRatio - pixelRatio) > 0.001;
  if (ratioChanged) {
    cube.pixelRatio = pixelRatio;
    cube.renderer.setPixelRatio(pixelRatio);
  }
  if (cube.width !== width || cube.height !== height || ratioChanged) {
    cube.width = width;
    cube.height = height;
    cube.renderer.setSize(width, height, false);
  }
}

function viewCubeTargetComponents(point, faceNormal = null) {
  const band = 0.55;
  const target = {
    x: Math.abs(Number(point?.x) || 0) > band ? Math.sign(Number(point.x)) : 0,
    y: Math.abs(Number(point?.y) || 0) > band ? Math.sign(Number(point.y)) : 0,
    z: Math.abs(Number(point?.z) || 0) > band ? Math.sign(Number(point.z)) : 0,
  };
  if (target.x === 0 && target.y === 0 && target.z === 0 && faceNormal) {
    target.x = Math.sign(Number(faceNormal.x) || 0);
    target.y = Math.sign(Number(faceNormal.y) || 0);
    target.z = Math.sign(Number(faceNormal.z) || 0);
  }
  return target.x === 0 && target.y === 0 && target.z === 0 ? null : target;
}

function gcodeViewCubeTarget(e) {
  const cube = gcodeView.cube;
  if (!cube || !gcodeView.camera) return null;
  const rect = cube.canvas.getBoundingClientRect();
  const ndc = {
    x: ((e.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
    y: -((e.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1,
  };
  cube.mesh.updateMatrixWorld(true);
  cube.raycaster.setFromCamera(ndc, cube.camera);
  const hits = cube.raycaster.intersectObject(cube.mesh, false);
  if (!hits.length) return null;
  const p = cube.mesh.worldToLocal(hits[0].point.clone());
  const target = viewCubeTargetComponents(p, hits[0].face?.normal);
  return target ? new THREE.Vector3(target.x, target.y, target.z) : null;
}

function setGcodeViewCubeHover(dir) {
  const cube = gcodeView.cube;
  if (!cube) return;
  if (!dir) {
    clearGcodeViewCubeHover();
    return;
  }
  const key = `${dir.x},${dir.y},${dir.z}`;
  if (cube.hoverKey === key) return;
  cube.hoverKey = key;
  const { dimensions, position } = viewCubeHoverGeometry(dir);
  cube.hover.scale.set(dimensions[0], dimensions[1], dimensions[2]);
  cube.hover.position.set(position[0], position[1], position[2]);
  cube.hover.visible = true;
  scheduleGcodeRender();
}

function viewCubeHoverGeometry(dir) {
  const axes = [Number(dir?.x) || 0, Number(dir?.y) || 0, Number(dir?.z) || 0];
  const targetAxes = axes.filter((value) => value !== 0).length;
  const thickness = targetAxes === 1 ? 0.05 : targetAxes === 2 ? 0.12 : 0.18;
  const dimensions = axes.map((value) => value === 0 ? 1.05 : thickness);
  const position = axes.map((value, index) =>
    value === 0 ? 0 : Math.sign(value) * (1 + dimensions[index] / 2 + 0.008)
  );
  return { dimensions, position };
}

function clearGcodeViewCubeHover() {
  const cube = gcodeView.cube;
  if (!cube || (!cube.hover.visible && !cube.hoverKey)) return;
  cube.hover.visible = false;
  cube.hoverKey = "";
  cube.canvas.style.cursor = cube.dragPointerId !== null ? "grabbing" : "default";
  scheduleGcodeRender();
}

function onGcodeViewCubePointerDown(e) {
  const cube = gcodeView.cube;
  if (!cube || (typeof e.button === "number" && e.button !== 0)) return;
  if (!gcodeViewCubeTarget(e)) return;
  cube.dragPointerId = e.pointerId;
  cube.dragStartX = e.clientX;
  cube.dragStartY = e.clientY;
  cube.dragX = e.clientX;
  cube.dragY = e.clientY;
  cube.dragging = false;
  clearGcodeViewCubeHover();
  cube.canvas.style.cursor = "grabbing";
  try {
    cube.canvas.setPointerCapture?.(e.pointerId);
  } catch {
    // Pointer capture is best-effort; in-canvas dragging still works without it.
  }
}

function onGcodeViewCubePointerMove(e) {
  const cube = gcodeView.cube;
  if (!cube) return;
  if (cube.dragPointerId === e.pointerId) {
    const step = gcodeCubeDragStep(cube, e.clientX, e.clientY);
    if (!step) return;
    rotateGcodeOrbitByDrag(gcodeView.orbit, step.dx, step.dy);
    clearGcodeViewCubeHover();
    cube.canvas.style.cursor = "grabbing";
    updateGcodeCamera();
    e.preventDefault();
    return;
  }
  const target = gcodeViewCubeTarget(e);
  cube.canvas.style.cursor = target ? "pointer" : "default";
  setGcodeViewCubeHover(target);
}

function gcodeCubeDragStep(drag, clientX, clientY) {
  const totalX = clientX - drag.dragStartX;
  const totalY = clientY - drag.dragStartY;
  if (!drag.dragging && Math.hypot(totalX, totalY) < GCODE_CUBE_DRAG_THRESHOLD_PX) return null;
  let dx = clientX - drag.dragX;
  let dy = clientY - drag.dragY;
  if (!drag.dragging) {
    drag.dragging = true;
    dx = totalX;
    dy = totalY;
  }
  drag.dragX = clientX;
  drag.dragY = clientY;
  return { dx, dy };
}

function finishGcodeViewCubeDrag(e, cancelled = false) {
  const cube = gcodeView.cube;
  if (!cube || cube.dragPointerId !== e.pointerId) return;
  const wasDragging = cube.dragging;
  cube.dragPointerId = null;
  cube.dragging = false;
  try {
    cube.canvas.releasePointerCapture?.(e.pointerId);
  } catch {
    // Capture may already be gone after cancellation or window focus changes.
  }
  cube.canvas.style.cursor = "default";
  if (wasDragging) {
    cube.suppressClick = true;
    setTimeout(() => {
      if (gcodeView.cube === cube) cube.suppressClick = false;
    }, 0);
  } else if (!cancelled) {
    const target = gcodeViewCubeTarget(e);
    cube.canvas.style.cursor = target ? "pointer" : "default";
    setGcodeViewCubeHover(target);
  }
}

function onGcodeViewCubePointerUp(e) {
  finishGcodeViewCubeDrag(e);
}

function onGcodeViewCubePointerCancel(e) {
  finishGcodeViewCubeDrag(e, true);
}

function onGcodeViewCubeClick(e) {
  const cube = gcodeView.cube;
  if (cube?.suppressClick) return;
  const dir = gcodeViewCubeTarget(e);
  if (!dir) return;
  snapGcodeViewTo(dir.normalize());
}

function snapGcodeViewTo(dir) {
  const angles = gcodeOrbitAnglesForDirection(dir);
  gcodeView.orbit.phi = angles.phi;
  gcodeView.orbit.theta = angles.theta;
  updateGcodeCamera();
}

function gcodeOrbitAnglesForDirection(direction) {
  const x = Number(direction?.x) || 0;
  const y = Number(direction?.y) || 0;
  const z = Number(direction?.z) || 0;
  const length = Math.hypot(x, y, z) || 1;
  return {
    theta: Math.atan2(x, z),
    phi: Math.acos(Math.max(-1, Math.min(1, y / length))),
  };
}

function gcodeTimelineLocallyOwned() {
  const slider = document.getElementById("gcode-timeline");
  return gcodeView.timelineEventLine > 0 || (!!slider && (
    gcodeView.timelineDragging ||
    slider === document.activeElement ||
    slider.dataset.dragging === "1"
  ));
}

function gcodeTimelineEventLabel(event, toolMetadata = []) {
  const kind = String(event?.kind || "");
  const tool = gcodeToolMetadata(toolMetadata, event?.tool);
  const code = String(event?.code || "");
  const value = Number(event?.value);
  switch (kind) {
  case "tool_change":
    return tool ? [gcodeToolLabel(tool), tool.name].filter(Boolean).join(" · ") : toolDisplayName(event?.tool);
  case "spindle":
    if (code === "M5") return "Spindle stop";
    return [code === "M4" ? "Spindle CCW" : "Spindle CW", Number.isFinite(value) && value > 0 ? `${Math.round(value)} rpm` : ""].filter(Boolean).join(" · ");
  case "a_index":
    return `A index · ${Number.isFinite(value) ? `${-value}°` : "—"}`;
  case "dwell":
    return `Dwell${Number.isFinite(value) && value > 0 ? ` · P${value}` : ""}`;
  case "attention":
    return `Program pause · ${code || "M0"}`;
  case "coolant":
    return `Coolant · ${code}`;
  default:
    return "Program event";
  }
}

function gcodeTimelineEventMarkers(events, totalLines, bucketCount = 48) {
  const lines = Math.max(1, Number(totalLines) || 1);
  const buckets = Math.max(1, Math.trunc(Number(bucketCount) || 48));
  const groups = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const line = Math.trunc(Number(event?.line) || 0);
    if (line <= 0) continue;
    const fraction = Math.max(0, Math.min(1, (line - 1) / Math.max(1, lines - 1)));
    const bucket = Math.min(buckets - 1, Math.floor(fraction * buckets));
    const marker = groups.get(bucket) || { bucket, fraction: (bucket + 0.5) / buckets, events: [] };
    marker.events.push(event);
    groups.set(bucket, marker);
  }
  return [...groups.values()].sort((a, b) => a.bucket - b.bucket);
}

function gcodeTimelineMarkerLabel(marker, toolMetadata = []) {
  const events = Array.isArray(marker?.events) ? marker.events : [];
  const primary = events.find((event) => event.kind === "tool_change") || events[0];
  const base = primary?.kind === "tool_change" ? `T${primary.tool || "?"}` :
    ({ spindle: "S", a_index: "A", attention: "!", coolant: "C", dwell: "D" }[primary?.kind] || "•");
  return events.length > 1 ? `${base}+` : base;
}

function setGcodeTimelineEventDetail(label, line = 0) {
  const detail = document.getElementById("gcode-timeline-event-detail");
  if (!detail) return;
  const text = line > 0 ? `${label} · line ${line}` : "Program events";
  setTextIfChanged(detail, text);
  detail.title = text;
}

function selectGcodeTimelineEvent(event, label = "") {
  const line = Math.trunc(Number(event?.line) || 0);
  if (line <= 0) return;
  gcodeView.followLive = false;
  gcodeView.timelineEventLine = line;
  gcodeView.cursor = gcodeCursorForPlayedLine(gcodeView.segments, line);
  setGcodeTimelineEventDetail(label, line);
  updateGcodeProgress();
}

function renderGcodeTimelineEventList(events, toolMetadata) {
  const root = document.getElementById("gcode-timeline-event-list");
  if (!root) return;
  const fragment = document.createDocumentFragment();
  for (const event of Array.isArray(events) ? events : []) {
    const line = Math.trunc(Number(event?.line) || 0);
    if (line <= 0) continue;
    const label = gcodeTimelineEventLabel(event, toolMetadata);
    const row = document.createElement("button");
    row.type = "button";
    row.className = "gcode-timeline-event-row";
    row.title = `${label} · line ${line}`;
    row.setAttribute("aria-label", `${label}, line ${line}`);
    const lineCell = document.createElement("span");
    lineCell.className = "gcode-timeline-event-line";
    lineCell.textContent = `Ln ${line}`;
    const text = document.createElement("span");
    text.className = "gcode-timeline-event-text";
    text.textContent = label;
    row.append(lineCell, text);
    row.onclick = () => selectGcodeTimelineEvent(event, label);
    fragment.appendChild(row);
  }
  root.replaceChildren(fragment);
}

function renderGcodeTimelineEvents(events, toolMetadata, totalLines) {
  const root = document.getElementById("gcode-timeline-events");
  const listRoot = document.getElementById("gcode-timeline-event-list");
  if (!root || !listRoot) return;
  const markers = gcodeTimelineEventMarkers(events, totalLines);
  const key = JSON.stringify([totalLines, markers]);
  if (gcodeView.timelineEventsKey === key) return;
  gcodeView.timelineEventsKey = key;
  const fragment = document.createDocumentFragment();
  for (const marker of markers) {
    const eventsAtMarker = marker.events;
    const event = eventsAtMarker.find((candidate) => candidate.kind === "tool_change") || eventsAtMarker[0];
    const details = eventsAtMarker.map((candidate) => gcodeTimelineEventLabel(candidate, toolMetadata));
    const label = details.join(" · ");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "gcode-timeline-event";
    button.dataset.eventKind = String(event?.kind || "");
    button.style.left = `${marker.fraction * 100}%`;
    button.textContent = gcodeTimelineMarkerLabel(marker, toolMetadata);
    const firstLine = Math.trunc(Number(eventsAtMarker[0]?.line) || 0);
    const lastLine = Math.trunc(Number(eventsAtMarker.at(-1)?.line) || firstLine);
    const lineText = firstLine === lastLine ? `line ${firstLine}` : `lines ${firstLine}–${lastLine}`;
    button.title = `${label} · ${lineText}`;
    button.setAttribute("aria-label", `${label}, ${lineText}`);
    button.onclick = () => selectGcodeTimelineEvent(event, label);
    fragment.appendChild(button);
  }
  root.replaceChildren(fragment);
  renderGcodeTimelineEventList(events, toolMetadata);
  setGcodeTimelineEventDetail(markers.length ? `${markers.length} event markers` : "", 0);
}

function updateGcodeTimeline(total) {
  const slider = document.getElementById("gcode-timeline");
  const label = document.getElementById("gcode-timeline-label");
  if (!slider || !label) return;
  slider.max = String(total);
  slider.disabled = total <= 0;
  gcodeView.cursor = Math.max(0, Math.min(total, gcodeView.cursor));
  const owned = gcodeTimelineLocallyOwned();
  if (owned) {
    const draft = Math.max(0, Math.min(total, Number(slider.value) || 0));
    label.textContent = `${draft} / ${total}`;
    return;
  }
  slider.value = String(gcodeView.cursor);
  label.textContent = `${gcodeView.cursor} / ${total}`;
  slider.setAttribute("aria-valuetext", `${gcodeView.cursor} of ${total} plotted segments`);
}

function gcodeWorldCoordinates(pos, has4Axis) {
  let x = Number(pos[0]) || 0;
  let y = Number(pos[1]) || 0;
  let z = Number(pos[2]) || 0;
  const a = Number(pos[3]) || 0;
  if (has4Axis) {
    const rad = a * Math.PI / 180;
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    const ry = y * c - z * s;
    const rz = y * s + z * c;
    y = ry;
    z = rz;
  }
  return [x, z, -y];
}

function gcodeWorldPoint(pos, has4Axis) {
  return new THREE.Vector3(...gcodeWorldCoordinates(pos, has4Axis));
}

function setGcodePreviewEmpty(text) {
  const empty = gcodeView.empty || document.getElementById("gcode-preview-empty");
  if (!empty) return;
  empty.textContent = text || "";
  empty.hidden = !text;
  const tools = document.getElementById("gcode-view-tools");
  if (tools) tools.hidden = !!text;
}

function scheduleGcodeRender() {
  if (!gcodeView.renderer || gcodeView.renderQueued) return;
  gcodeView.renderQueued = true;
  requestAnimationFrame(() => {
    gcodeView.renderQueued = false;
    renderGcodeScene();
  });
}

function renderGcodeScene() {
  if (!gcodeView.renderer || !gcodeView.camera || !gcodeView.canvas) return;
  const rect = gcodeView.canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  const pixelRatio = gcodeRenderPixelRatio(width, height);
  const sizeChanged = gcodeView.width !== width || gcodeView.height !== height;
  const ratioChanged = Math.abs(gcodeView.pixelRatio - pixelRatio) > 0.001;
  if (ratioChanged) {
    gcodeView.pixelRatio = pixelRatio;
    gcodeView.renderer.setPixelRatio(pixelRatio);
  }
  if (sizeChanged || ratioChanged) {
    gcodeView.width = width;
    gcodeView.height = height;
    gcodeView.renderer.setSize(width, height, false);
    syncGcodeProjection();
  }
  gcodeView.renderer.render(gcodeView.scene, gcodeView.camera);
  renderGcodeViewCube();
}


function drawGcodePreview(preview, live = null) {
  const segments = Array.isArray(preview?.segments) ? preview.segments : [];
  drawGcodePreviewCallbacks.renderTimelineEvents(preview?.events, preview?.tool_metadata, preview?.line_count);
  const hasToolpath = segments.length > 0 && !!preview?.bounds;
  const hasContextCandidate = !!state.outline?.active && !!state.outline?.points?.length;
  if (!hasToolpath && !hasContextCandidate) {
    if (gcodeView.key || gcodeView.segments.length) drawGcodePreviewCallbacks.clearGcodeScene();
    gcodeView.live = live;
    gcodeView.followLive = !!live;
    drawGcodePreviewCallbacks.setPreviewEmpty("No plotted moves");
    drawGcodePreviewCallbacks.updateTimeline(0);
    drawGcodePreviewCallbacks.syncSourceLine(live);
    return;
  }
  if (!drawGcodePreviewCallbacks.ensureViewer()) {
    gcodeView.segments = hasToolpath ? segments : [];
    gcodeView.live = live;
    if (live && !drawGcodePreviewCallbacks.timelineLocallyOwned()) {
      gcodeView.cursor = live.cursor;
      gcodeView.followLive = true;
    } else {
      if (!drawGcodePreviewCallbacks.timelineLocallyOwned()) gcodeView.cursor = gcodeView.segments.length;
      gcodeView.cursor = Math.max(0, Math.min(gcodeView.segments.length, gcodeView.cursor));
      if (!live) gcodeView.followLive = false;
    }
    drawGcodePreviewCallbacks.updateTimeline(gcodeView.segments.length);
    drawGcodePreviewCallbacks.syncSourceLine(live);
    return;
  }
  drawGcodePreviewCallbacks.syncContextOverlay();
  if (!hasToolpath && !gcodeView.contextVisible) {
    drawGcodePreviewCallbacks.clearGcodeScene();
    drawGcodePreviewCallbacks.setPreviewEmpty("No plotted moves");
    drawGcodePreviewCallbacks.updateTimeline(0);
    drawGcodePreviewCallbacks.syncSourceLine(live);
    return;
  }
  const pathKey = hasToolpath ? [
    state.activeGcode?.path || "",
    preview.line_count || 0,
    preview.plotted_segments || segments.length,
    preview.total_distance || 0,
    preview.has_4axis ? "4" : "3",
  ].join(":") : "context-only";
  const key = pathKey + "|" + gcodeView.contextKey;
  const sceneBounds = drawGcodePreviewCallbacks.combineBounds(hasToolpath ? preview.bounds : null, gcodeView.contextBounds);
  const entry = state.activeGcode?.entry || drawGcodePreviewCallbacks.getActiveFile(state.activeGcode?.path || "") || {};
  const fitKey = drawGcodePreviewCallbacks.cameraFitKey(state.activeGcode?.path, entry, preview, hasToolpath);
  if (gcodeView.key !== key) {
    const renderedSegments = hasToolpath ? segments : [];
    gcodeView.key = key;
    gcodeView.segments = renderedSegments;
    gcodeView.has4Axis = hasToolpath && !!preview.has_4axis;
    gcodeView.cursor = live ? live.cursor : renderedSegments.length;
    drawGcodePreviewCallbacks.rebuildScene({ ...preview, bounds: sceneBounds }, renderedSegments);
    if (sceneBounds && gcodeView.fitKey !== fitKey) {
      gcodeView.fitKey = fitKey;
      drawGcodePreviewCallbacks.fitCamera(sceneBounds);
    }
  }
  gcodeView.live = live;
  if (live && !drawGcodePreviewCallbacks.timelineLocallyOwned()) {
    gcodeView.cursor = live.cursor;
    gcodeView.followLive = true;
  } else if (!live) {
    gcodeView.followLive = false;
  }
  drawGcodePreviewCallbacks.setPreviewEmpty("");
  drawGcodePreviewCallbacks.updateTimeline(gcodeView.segments.length);
  drawGcodePreviewCallbacks.updateProgress();
  drawGcodePreviewCallbacks.scheduleRender();
}

  return {
    getGcodeView: () => gcodeView,
    getDashboardGcodeView: () => dashboardGcodeView,
    getActiveGcodeSource: () => activeGcodeSource,
    getActiveGcodeGeometry: () => activeGcodeGeometry,
    dashboardGcodeWindow,
    renderDashboardGcodeStream,
    drawDashboardGcodePreview,
    drawGcodePreview,
    dashboardGcodeRenderStateKey,
    activeGcodeSourceSignature,
    gcodeCameraFitKey,
    ensureActiveGcodeGeometry,
    splitGcodeSourceLines,
    ensureActiveGcodeSource,
    resetActiveGcodeSource,
    fetchActiveGcodeSourcePage,
    activeGcodeSourceLine,
    gcodeSourceWindow,
    scheduleActiveGcodeSourceRender,
    renderActiveGcodeSource,
    gcodeSourceLineForCursor,
    syncActiveGcodeSourceLine,
    scrollActiveGcodeSourceToLine,
    activeJobOverlayOriginFrom,
    activeJobOverlayOrigin,
    activeJobOverlayPoint,
    probePlanMatchesResults,
    activeJobFieldProbeComplete,
    interpolateOutlinePathZ,
    activeJobContextOverlayData,
    activeJobOverlayBounds,
    combineGcodeBounds,
    activeJobContextOverlayKey,
    syncGcodeContextOverlay,
    rebuildGcodeContextOverlay,
    rebuildGcodeContextOverlayForGroup,
    gcodeRenderPixelRatio,
    ensureGcodeViewer,
    ensureDashboardGcodeViewer,
    clearDashboardGcodeScene,
    setDashboardGcodePreviewEmpty,
    fitDashboardGcodeCamera,
    updateDashboardGcodeCamera,
    syncDashboardGcodeProjection,
    scheduleDashboardGcodeRender,
    renderDashboardGcodeScene,
    bindGcodeOrbitControls,
    gcodePinchDistance,
    gcodeOrbitRadiusAfterPinch,
    gcodeOrbitRadiusAfterWheel,
    rotateGcodeOrbitByDrag,
    isTypingTarget,
    rebuildGcodeScene,
    populateGcodePathScene,
    addGcodeGrid,
    addGcodeGridToView,
    buildGcodeOriginAxes,
    makeGcodeAxisLabel,
    clearGcodeScene,
    fitGcodeCamera,
    updateGcodeCamera,
    syncGcodeProjection,
    setGcodeProjection,
    bindGcodeProjectionToggle,
    initGcodeViewCube,
    makeViewCubeFaceTexture,
    renderGcodeViewCube,
    syncGcodeViewCubeResolution,
    viewCubeTargetComponents,
    gcodeViewCubeTarget,
    setGcodeViewCubeHover,
    viewCubeHoverGeometry,
    clearGcodeViewCubeHover,
    onGcodeViewCubePointerDown,
    onGcodeViewCubePointerMove,
    gcodeCubeDragStep,
    finishGcodeViewCubeDrag,
    onGcodeViewCubePointerUp,
    onGcodeViewCubePointerCancel,
    onGcodeViewCubeClick,
    snapGcodeViewTo,
    gcodeOrbitAnglesForDirection,
    gcodeTimelineLocallyOwned,
    gcodeTimelineEventLabel,
    gcodeTimelineEventMarkers,
    gcodeTimelineMarkerLabel,
    setGcodeTimelineEventDetail,
    selectGcodeTimelineEvent,
    renderGcodeTimelineEventList,
    renderGcodeTimelineEvents,
    updateGcodeTimeline,
    gcodeWorldCoordinates,
    gcodeWorldPoint,
    setGcodePreviewEmpty,
    scheduleGcodeRender,
    renderGcodeScene
  };
}
