const EXTERNAL_CAMERA_VIEW_KEY = "cnc-proxy.external-camera-view.v1";
const EXTERNAL_CAMERA_ZOOM_LEVELS = [1, 1.5, 2, 3];
const CAMERA_SNAPSHOT_ZOOM = 2.5;
const EXTERNAL_SNAPSHOT_REFRESH_MS = 1500;

export function dashboardExternalCameraIsSnapshot(source) {
  return source?.mode === "snapshot";
}

export function normalizeDashboardExternalCameraView(value) {
  const zoom = EXTERNAL_CAMERA_ZOOM_LEVELS.includes(Number(value?.zoom)) ? Number(value.zoom) : 1;
  const clampPercent = (input) => {
    if (input === null || input === undefined || input === "") return 50;
    return Math.max(0, Math.min(100, Number.isFinite(Number(input)) ? Number(input) : 50));
  };
  return { zoom, x: clampPercent(value?.x), y: clampPercent(value?.y) };
}

export function mountDashboardCamera({
  getActiveTab,
  getReadOnly,
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  request,
  setStatusMessage,
  bindButtonAction,
  setTextIfChanged,
  blobCtor = globalThis.Blob,
  urlCtor = globalThis.URL,
  webSocketCtor = windowRef?.WebSocket || globalThis.WebSocket,
}) {
  const cameraState = {
    dashboardCameraPrimary: "external",
    dashboardExternalCameraView: { zoom: 1, x: 50, y: 50 },
    dashboardCameraSnapshotZoomed: false,
    dashboardCameraSnapshotFocus: { x: 50, y: 50 },
    cameraFocus: {
      loaded: false,
      available: false,
      autofocus: true,
      absolute: 5,
      min: 0,
      max: 250,
      step: 5,
      pending: false,
      draftAutofocus: true,
      draftAbsolute: 5,
    },
    cameras: {
      loaded: false,
      sources: { builtin: { configured: false }, external: { configured: false } },
      builtinWS: null,
      builtinReconnectTimer: null,
      builtinObjectURL: "",
      builtinObjectURLs: new Set(),
      externalURL: "",
      externalRetryTimer: null,
    },
  };
  const document = documentRef;
  const window = windowRef;
  const Blob = blobCtor;
  const URL = urlCtor;
  const WebSocket = webSocketCtor;
  const state = {
    cameras: cameraState.cameras,
    cameraFocus: cameraState.cameraFocus,
    get activeTab() { return getActiveTab(); },
    get readOnly() { return getReadOnly(); },
    get dashboardCameraPrimary() { return cameraState.dashboardCameraPrimary; },
    set dashboardCameraPrimary(value) { cameraState.dashboardCameraPrimary = value; },
    get dashboardExternalCameraView() { return cameraState.dashboardExternalCameraView; },
    set dashboardExternalCameraView(value) { cameraState.dashboardExternalCameraView = value; },
    get dashboardCameraSnapshotZoomed() { return cameraState.dashboardCameraSnapshotZoomed; },
    set dashboardCameraSnapshotZoomed(value) { cameraState.dashboardCameraSnapshotZoomed = value; },
    get dashboardCameraSnapshotFocus() { return cameraState.dashboardCameraSnapshotFocus; },
    set dashboardCameraSnapshotFocus(value) { cameraState.dashboardCameraSnapshotFocus = value; },
  };
  function dashboardCameraShouldRun() {
    return state.activeTab === "dashboard" && !document.hidden;
  }

  function dashboardCameraSource(kind) {
    return state.cameras.sources?.[kind] || { configured: false };
  }

  function setDashboardCameraState(kind, status, title, detail = "") {
    const root = document.getElementById(`dashboard-${kind}-camera`);
    const image = document.getElementById(`dashboard-${kind}-camera-image`);
    const stateText = document.getElementById(`dashboard-${kind}-camera-state`);
    const detailText = document.getElementById(`dashboard-${kind}-camera-detail`);
    const badge = document.getElementById(`dashboard-${kind}-camera-badge`);
    if (!root) return;
    if (kind === "external") document.querySelector(".dashboard-camera-stage")?.classList.toggle("external-camera-live", status === "live");
    root.classList.toggle("is-live", status === "live");
    root.classList.toggle("is-error", status === "error");
    root.classList.toggle("is-connecting", status === "connecting");
    root.classList.toggle("is-unconfigured", status === "unconfigured");
    if (image) image.hidden = status !== "live";
    if (stateText) stateText.textContent = title;
    if (detailText) detailText.textContent = detail;
    if (badge) badge.textContent = status === "live" ? "Live" :
      (status === "connecting" ? "Connecting" : (status === "error" ? "Offline" : "Not configured"));
    if (kind === "external") {
      const snapshot = document.getElementById("dashboard-external-camera-snapshot");
      if (snapshot) snapshot.disabled = status !== "live" || dashboardCameraPrimary() !== "external";
      const focus = document.getElementById("dashboard-external-camera-focus-open");
      if (focus) focus.disabled = status !== "live" || dashboardCameraPrimary() !== "external";
    }
  }

  function loadDashboardCameraPrimary() {
    try {
      return window.localStorage?.getItem("sensei.dashboard.primary-camera") === "builtin" ? "builtin" : "external";
    } catch {
      return "external";
    }
  }

  function loadDashboardExternalCameraView() {
    try {
      return normalizeDashboardExternalCameraView(JSON.parse(window.localStorage?.getItem(EXTERNAL_CAMERA_VIEW_KEY) || "null"));
    } catch {
      return normalizeDashboardExternalCameraView(null);
    }
  }

  function saveDashboardExternalCameraView() {
    try {
      window.localStorage?.setItem(EXTERNAL_CAMERA_VIEW_KEY, JSON.stringify(state.dashboardExternalCameraView));
    } catch {
      // Camera framing remains available for this page load without storage.
    }
  }

  function renderDashboardExternalCameraView() {
    const view = normalizeDashboardExternalCameraView(state.dashboardExternalCameraView);
    state.dashboardExternalCameraView = view;
    const frame = document.getElementById("dashboard-external-camera-frame");
    const root = document.getElementById("dashboard-external-camera");
    const value = document.getElementById("dashboard-external-camera-zoom-value");
    const zoomOut = document.getElementById("dashboard-external-camera-zoom-out");
    const zoomIn = document.getElementById("dashboard-external-camera-zoom-in");
    const center = document.getElementById("dashboard-external-camera-zoom-center");
    frame?.style.setProperty("--external-camera-zoom", String(view.zoom));
    frame?.style.setProperty("--external-camera-focus-x", view.x + "%");
    frame?.style.setProperty("--external-camera-focus-y", view.y + "%");
    root?.classList.toggle("is-zoomed", view.zoom > 1);
    if (root && dashboardCameraPrimary() === "external") {
      root.setAttribute("aria-label", view.zoom > 1
        ? "External camera main view; click to focus the zoomed image or use arrow keys to pan"
        : "External camera is the main view");
    }
    setTextIfChanged(value, view.zoom.toFixed(view.zoom % 1 ? 1 : 0) + "×");
    if (zoomOut) zoomOut.disabled = view.zoom === EXTERNAL_CAMERA_ZOOM_LEVELS[0];
    if (zoomIn) zoomIn.disabled = view.zoom === EXTERNAL_CAMERA_ZOOM_LEVELS[EXTERNAL_CAMERA_ZOOM_LEVELS.length - 1];
    if (center) center.disabled = view.zoom === 1 && view.x === 50 && view.y === 50;
  }

  function setDashboardExternalCameraView(next) {
    state.dashboardExternalCameraView = normalizeDashboardExternalCameraView(next);
    saveDashboardExternalCameraView();
    renderDashboardExternalCameraView();
  }

  function stepDashboardExternalCameraZoom(direction) {
    const view = normalizeDashboardExternalCameraView(state.dashboardExternalCameraView);
    const current = EXTERNAL_CAMERA_ZOOM_LEVELS.indexOf(view.zoom);
    const index = Math.max(0, Math.min(EXTERNAL_CAMERA_ZOOM_LEVELS.length - 1, current + (direction < 0 ? -1 : 1)));
    setDashboardExternalCameraView({ ...view, zoom: EXTERNAL_CAMERA_ZOOM_LEVELS[index] });
  }

  function focusDashboardExternalCamera(clientX, clientY) {
    const root = document.getElementById("dashboard-external-camera");
    const view = normalizeDashboardExternalCameraView(state.dashboardExternalCameraView);
    const rect = root?.getBoundingClientRect?.();
    if (!root || view.zoom <= 1 || !rect || rect.width <= 0 || rect.height <= 0) return false;
    setDashboardExternalCameraView({
      ...view,
      x: ((clientX - rect.left) / rect.width) * 100,
      y: ((clientY - rect.top) / rect.height) * 100,
    });
    return true;
  }

  function panDashboardExternalCamera(dx, dy) {
    const view = normalizeDashboardExternalCameraView(state.dashboardExternalCameraView);
    if (view.zoom <= 1) return false;
    setDashboardExternalCameraView({ ...view, x: view.x + dx, y: view.y + dy });
    return true;
  }

  function captureDashboardExternalCameraSnapshot() {
    const image = document.getElementById("dashboard-external-camera-image");
    const modal = document.getElementById("dashboard-camera-snapshot-modal");
    const snapshot = document.getElementById("dashboard-camera-snapshot-image");
    const meta = document.getElementById("dashboard-camera-snapshot-meta");
    if (!image || !modal || !snapshot || !meta || image.hidden || !image.complete || !image.naturalWidth || !image.naturalHeight) {
      setStatusMessage("dashboard-camera-snapshot", "Snapshot unavailable: the external camera has no decoded frame.", "error", { force: true });
      return false;
    }
    try {
      const width = image.naturalWidth;
      const height = image.naturalHeight;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("canvas is unavailable");
      // The live external camera is mounted upside down. Keep the snapshot in
      // the same orientation as the operator sees in the dashboard.
      context.translate(width, height);
      context.rotate(Math.PI);
      context.drawImage(image, 0, 0, width, height);
      snapshot.src = canvas.toDataURL("image/jpeg", 0.92);
      meta.textContent = `${width}×${height} pixels · captured from the current frame`;
      const viewport = document.getElementById("dashboard-camera-snapshot-viewport");
      if (viewport) viewport.style.aspectRatio = `${width} / ${height}`;
      state.dashboardCameraSnapshotZoomed = false;
      state.dashboardCameraSnapshotFocus = { x: 50, y: 50 };
      renderDashboardCameraSnapshotView();
      setStatusMessage("dashboard-camera-snapshot", "");
      if (typeof modal.showModal === "function" && !modal.open) modal.showModal();
      else modal.setAttribute("open", "");
      return true;
    } catch (error) {
      setStatusMessage("dashboard-camera-snapshot", `Snapshot failed: ${error?.message || "the frame could not be read"}.`, "error", { force: true });
      return false;
    }
  }

  function renderDashboardCameraSnapshotView() {
    const image = document.getElementById("dashboard-camera-snapshot-image");
    if (!image) return;
    const focus = state.dashboardCameraSnapshotFocus || { x: 50, y: 50 };
    const zoomed = state.dashboardCameraSnapshotZoomed === true;
    image.style.transform = `scale(${zoomed ? CAMERA_SNAPSHOT_ZOOM : 1})`;
    image.style.transformOrigin = `${focus.x}% ${focus.y}%`;
    image.classList.toggle("is-zoomed", zoomed);
    image.setAttribute("aria-pressed", String(zoomed));
    image.setAttribute("aria-label", zoomed
      ? "Reset snapshot zoom"
      : `Zoom snapshot image ${CAMERA_SNAPSHOT_ZOOM} times`);
  }

  function toggleDashboardCameraSnapshotZoom(clientX, clientY) {
    const image = document.getElementById("dashboard-camera-snapshot-image");
    if (!image?.src) return false;
    if (state.dashboardCameraSnapshotZoomed) {
      state.dashboardCameraSnapshotZoomed = false;
      renderDashboardCameraSnapshotView();
      return true;
    }
    const rect = image.getBoundingClientRect?.();
    if (rect && rect.width > 0 && rect.height > 0 && Number.isFinite(clientX) && Number.isFinite(clientY)) {
      state.dashboardCameraSnapshotFocus = {
        x: Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100)),
        y: Math.max(0, Math.min(100, ((clientY - rect.top) / rect.height) * 100)),
      };
    }
    state.dashboardCameraSnapshotZoomed = true;
    renderDashboardCameraSnapshotView();
    return true;
  }

  function renderDashboardCameraFocusControls() {
    const mode = document.getElementById("dashboard-camera-focus-mode");
    const range = document.getElementById("dashboard-camera-focus-value");
    const label = document.getElementById("dashboard-camera-focus-value-label");
    const apply = document.getElementById("dashboard-camera-focus-apply");
    const focus = state.cameraFocus;
    const auto = focus.draftAutofocus === true;
    if (mode && document.activeElement !== mode) mode.value = auto ? "auto" : "manual";
    if (range) {
      range.min = String(focus.min ?? 0);
      range.max = String(focus.max ?? 250);
      range.step = String(focus.step || 5);
      if (document.activeElement !== range) range.value = String(focus.draftAbsolute);
      range.disabled = auto || focus.pending || !focus.available;
    }
    if (label) label.textContent = String(focus.draftAbsolute);
    if (apply) apply.disabled = focus.pending || !focus.available;
  }

  function normalizeDashboardCameraFocus(data) {
    const min = Number.isFinite(Number(data?.min)) ? Number(data.min) : 0;
    const max = Number.isFinite(Number(data?.max)) ? Number(data.max) : 250;
    const step = Number.isFinite(Number(data?.step)) && Number(data.step) > 0 ? Number(data.step) : 5;
    const rawAbsolute = Number.isFinite(Number(data?.absolute)) ? Number(data.absolute) : min;
    const absolute = Math.max(min, Math.min(max, min + Math.round((rawAbsolute - min) / step) * step));
    return {
      available: data?.available === true,
      autofocus: data?.autofocus === true,
      absolute,
      min,
      max,
      step,
    };
  }

  async function loadDashboardCameraFocus() {
    const focus = state.cameraFocus;
    focus.pending = true;
    focus.loaded = false;
    focus.available = false;
    renderDashboardCameraFocusControls();
    setStatusMessage("dashboard-camera-focus", "Reading camera focus…");
    try {
      const response = await request("/api/camera/external/focus");
      const data = normalizeDashboardCameraFocus(await response.json());
      Object.assign(focus, data, {
        loaded: true,
        pending: false,
        draftAutofocus: data.autofocus,
        draftAbsolute: data.absolute,
      });
      setStatusMessage("dashboard-camera-focus", "");
    } catch (error) {
      focus.loaded = true;
      focus.available = false;
      setStatusMessage("dashboard-camera-focus", `Camera focus unavailable: ${error?.message || "the controls could not be read"}.`, "error", { force: true });
    } finally {
      focus.pending = false;
      renderDashboardCameraFocusControls();
    }
  }

  function openDashboardCameraFocus() {
    const modal = document.getElementById("dashboard-camera-focus-modal");
    if (!modal) return;
    if (!modal.open && typeof modal.showModal === "function") modal.showModal();
    else modal.setAttribute("open", "");
    loadDashboardCameraFocus();
  }

  async function applyDashboardCameraFocus() {
    const focus = state.cameraFocus;
    const modal = document.getElementById("dashboard-camera-focus-modal");
    if (focus.pending || !focus.available) return;
    focus.pending = true;
    renderDashboardCameraFocusControls();
    setStatusMessage("dashboard-camera-focus", "Applying camera focus…");
    try {
      const response = await request("/api/camera/external/focus", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autofocus: focus.draftAutofocus, absolute: focus.draftAbsolute }),
      });
      const data = normalizeDashboardCameraFocus(await response.json());
      Object.assign(focus, data, { draftAutofocus: data.autofocus, draftAbsolute: data.absolute });
      setStatusMessage("dashboard-camera-focus", "Camera focus updated.", "ok", { force: true });
      if (modal?.open) modal.close();
    } catch (error) {
      setStatusMessage("dashboard-camera-focus", `Camera focus failed: ${error?.message || "the controls could not be updated"}.`, "error", { force: true });
    } finally {
      focus.pending = false;
      renderDashboardCameraFocusControls();
    }
  }

  function dashboardCameraPrimary() {
    const preferred = state.dashboardCameraPrimary;
    const external = dashboardCameraSource("external");
    const builtin = dashboardCameraSource("builtin");
    if (preferred === "builtin" && builtin.configured) return "builtin";
    if (preferred === "external" && external.configured) return "external";
    if (external.configured) return "external";
    return "builtin";
  }

  function setDashboardCameraPrimary(kind) {
    if (kind !== "external" && kind !== "builtin") return;
    if (!dashboardCameraSource(kind).configured) return;
    state.dashboardCameraPrimary = kind;
    try {
      window.localStorage?.setItem("sensei.dashboard.primary-camera", kind);
    } catch {
      // The layout still works when browser storage is unavailable.
    }
    renderDashboardCameraConfig();
  }

  function renderDashboardCameraConfig() {
    const external = dashboardCameraSource("external");
    const builtin = dashboardCameraSource("builtin");
    const stage = document.querySelector(".dashboard-camera-stage");
    const primary = dashboardCameraPrimary();
    renderDashboardExternalCameraView();
    stage?.classList.toggle("builtin-primary", primary === "builtin");
    for (const kind of ["external", "builtin"]) {
      const root = document.getElementById(`dashboard-${kind}-camera`);
      if (!root) continue;
      const isPrimary = kind === primary;
      const configured = dashboardCameraSource(kind).configured;
      root.dataset.cameraPrimary = String(isPrimary);
      root.tabIndex = configured ? 0 : -1;
      root.setAttribute("aria-pressed", String(isPrimary));
      const externalZoomed = kind === "external" && isPrimary && state.dashboardExternalCameraView.zoom > 1;
      root.setAttribute("aria-label", externalZoomed
        ? "External camera main view; click to focus the zoomed image or use arrow keys to pan"
        : (isPrimary
          ? `${kind === "external" ? "External" : "Z1"} camera is the main view`
          : `Make ${kind === "external" ? "external" : "Z1"} camera the main view`));
    }
    if (!state.cameras.loaded) {
      setDashboardCameraState("external", "connecting", "Loading camera configuration", "Cameras run only while Overview is visible.");
      setDashboardCameraState("builtin", "connecting", "Loading Z1 camera", "Waiting for the camera service.");
      return;
    }
    if (!external.configured) {
      setDashboardCameraState("external", "unconfigured", "External camera not configured", "Connect a USB camera to the controller and configure its local stream source.");
    }
    if (!builtin.configured) {
      setDashboardCameraState("builtin", "unconfigured", "Z1 camera not configured", "Configure the Z1 camera WebSocket or start the proxy with a fixed Z1 address.");
    }
    const snapshot = document.getElementById("dashboard-external-camera-snapshot");
    if (snapshot) snapshot.disabled = !external.configured || dashboardCameraPrimary() !== "external" || !document.getElementById("dashboard-external-camera")?.classList.contains("is-live");
    const focus = document.getElementById("dashboard-external-camera-focus-open");
    if (focus) focus.disabled = state.readOnly || !external.configured || dashboardCameraPrimary() !== "external" || !document.getElementById("dashboard-external-camera")?.classList.contains("is-live");
    renderDashboardCameraFocusControls();
  }

  function dashboardWebSocketURL(path) {
    const url = new URL(path, window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.href;
  }

  function stopDashboardBuiltinCamera() {
    clearTimeout(state.cameras.builtinReconnectTimer);
    state.cameras.builtinReconnectTimer = null;
    const ws = state.cameras.builtinWS;
    state.cameras.builtinWS = null;
    if (ws) {
      try { ws.close(1000, "overview hidden"); } catch { /* already closed */ }
    }
    const image = document.getElementById("dashboard-builtin-camera-image");
    if (image) image.onload = null;
    for (const objectURL of state.cameras.builtinObjectURLs) URL.revokeObjectURL?.(objectURL);
    state.cameras.builtinObjectURLs.clear();
    state.cameras.builtinObjectURL = "";
  }

  function startDashboardBuiltinCamera() {
    const source = dashboardCameraSource("builtin");
    if (!dashboardCameraShouldRun() || !source.configured || !source.stream_url || !("WebSocket" in window)) return;
    const existing = state.cameras.builtinWS;
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) return;
    clearTimeout(state.cameras.builtinReconnectTimer);
    setDashboardCameraState("builtin", "connecting", "Connecting to Z1 camera", "Video is relayed through Sensei for Tailscale access.");
    const ws = new WebSocket(dashboardWebSocketURL(source.stream_url));
    ws.binaryType = "blob";
    state.cameras.builtinWS = ws;
    ws.onmessage = (event) => {
      if (state.cameras.builtinWS !== ws || !dashboardCameraShouldRun()) return;
      if (typeof event.data === "string") {
        setDashboardCameraState("builtin", "error", "Z1 camera is in use by another client", "Sensei will retry when the stream becomes available.");
        return;
      }
      const blob = event.data instanceof Blob ? event.data : new Blob([event.data], { type: "image/jpeg" });
      const nextURL = URL.createObjectURL(blob);
      state.cameras.builtinObjectURLs.add(nextURL);
      state.cameras.builtinObjectURL = nextURL;
      const image = document.getElementById("dashboard-builtin-camera-image");
      if (image) {
        image.onload = () => {
          // Keep the old frame alive until this frame has decoded. Revoking it on
          // a timer causes a visible black flash when the Z1 stream slows down.
          if (state.cameras.builtinObjectURL !== nextURL) return;
          for (const objectURL of state.cameras.builtinObjectURLs) {
            if (objectURL === nextURL) continue;
            URL.revokeObjectURL?.(objectURL);
            state.cameras.builtinObjectURLs.delete(objectURL);
          }
        };
        image.src = nextURL;
      }
      setDashboardCameraState("builtin", "live", "Z1 camera live", "Video from the machine's built-in camera.");
    };
    ws.onerror = () => {
      if (state.cameras.builtinWS === ws) setDashboardCameraState("builtin", "error", "Z1 camera is not responding", "Sensei will retry automatically.");
    };
    ws.onclose = () => {
      if (state.cameras.builtinWS !== ws) return;
      state.cameras.builtinWS = null;
      if (!dashboardCameraShouldRun()) return;
      setDashboardCameraState("builtin", "error", "Z1 camera offline", "Sensei will retry automatically.");
      state.cameras.builtinReconnectTimer = setTimeout(startDashboardBuiltinCamera, 3000);
    };
  }

  function stopDashboardExternalCamera() {
    clearTimeout(state.cameras.externalRetryTimer);
    state.cameras.externalRetryTimer = null;
    const image = document.getElementById("dashboard-external-camera-image");
    if (image) {
      image.onload = null;
      image.onerror = null;
      image.removeAttribute("src");
    }
    state.cameras.externalURL = "";
  }

  function startDashboardExternalCamera() {
    const source = dashboardCameraSource("external");
    if (!dashboardCameraShouldRun() || !source.configured || !source.stream_url || state.cameras.externalURL) return;
    const image = document.getElementById("dashboard-external-camera-image");
    if (!image) return;
    clearTimeout(state.cameras.externalRetryTimer);
    const url = new URL(source.stream_url, window.location.href);
    url.searchParams.set("v", String(Date.now()));
    state.cameras.externalURL = url.href;
    setDashboardCameraState("external", "connecting", "Connecting to external camera", "Video is relayed through Sensei for remote access.");
    image.onload = () => {
      if (state.cameras.externalURL !== url.href) return;
      setDashboardCameraState("external", "live", "External camera live", "Controller primary camera.");
      if (dashboardExternalCameraIsSnapshot(source)) {
        state.cameras.externalRetryTimer = setTimeout(() => {
          if (state.cameras.externalURL !== url.href || !dashboardCameraShouldRun()) return;
          state.cameras.externalURL = "";
          startDashboardExternalCamera();
        }, EXTERNAL_SNAPSHOT_REFRESH_MS);
      }
    };
    image.onerror = () => {
      if (state.cameras.externalURL !== url.href) return;
      state.cameras.externalURL = "";
      setDashboardCameraState("external", "error", "External camera offline", "Sensei will retry automatically.");
      state.cameras.externalRetryTimer = setTimeout(startDashboardExternalCamera, 4000);
    };
    image.src = url.href;
  }

  function syncDashboardCameras() {
    renderDashboardCameraConfig();
    if (!dashboardCameraShouldRun()) {
      stopDashboardBuiltinCamera();
      stopDashboardExternalCamera();
      return;
    }
    startDashboardBuiltinCamera();
    startDashboardExternalCamera();
  }

  async function loadDashboardCameras() {
    try {
      const response = await request("/api/cameras");
      const sources = await response.json();
      state.cameras.sources = {
        builtin: sources?.builtin || { configured: false },
        external: sources?.external || { configured: false },
      };
    } catch {
      state.cameras.sources = { builtin: { configured: false }, external: { configured: false } };
    } finally {
      state.cameras.loaded = true;
      syncDashboardCameras();
    }
  }

  function bindDashboardCameraSwitches() {
    for (const kind of ["external", "builtin"]) {
      const root = document.getElementById(`dashboard-${kind}-camera`);
      if (!root) continue;
      const select = () => setDashboardCameraPrimary(kind);
      root.addEventListener("click", (event) => {
        if (kind === "external" && dashboardCameraPrimary() === "external" && focusDashboardExternalCamera(event.clientX, event.clientY)) return;
        select();
      });
      root.addEventListener("keydown", (event) => {
        if (kind === "external" && dashboardCameraPrimary() === "external") {
          const amount = event.shiftKey ? 10 : 4;
          const moves = { ArrowLeft: [-amount, 0], ArrowRight: [amount, 0], ArrowUp: [0, -amount], ArrowDown: [0, amount] };
          if (moves[event.key] && panDashboardExternalCamera(...moves[event.key])) {
            event.preventDefault();
            return;
          }
        }
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        select();
      });
    }
    const bindZoom = (id, handler) => {
      const button = document.getElementById(id);
      if (!button) return;
      bindButtonAction(button, (event) => {
        event.stopPropagation();
        handler();
      });
    };
    bindZoom("dashboard-external-camera-zoom-out", () => stepDashboardExternalCameraZoom(-1));
    bindZoom("dashboard-external-camera-zoom-in", () => stepDashboardExternalCameraZoom(1));
    bindZoom("dashboard-external-camera-zoom-center", () => setDashboardExternalCameraView({ zoom: state.dashboardExternalCameraView.zoom, x: 50, y: 50 }));
    bindZoom("dashboard-external-camera-snapshot", captureDashboardExternalCameraSnapshot);
    bindZoom("dashboard-external-camera-focus-open", openDashboardCameraFocus);
    const snapshotImage = document.getElementById("dashboard-camera-snapshot-image");
    snapshotImage?.addEventListener("click", (event) => {
      toggleDashboardCameraSnapshotZoom(event.clientX, event.clientY);
    });
    snapshotImage?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggleDashboardCameraSnapshotZoom(NaN, NaN);
    });
    bindButtonAction(document.getElementById("dashboard-camera-snapshot-close"), () => {
      const modal = document.getElementById("dashboard-camera-snapshot-modal");
      if (modal?.open) modal.close();
    });
    bindButtonAction(document.getElementById("dashboard-camera-focus-close"), () => {
      const modal = document.getElementById("dashboard-camera-focus-modal");
      if (modal?.open) modal.close();
    });
    bindButtonAction(document.getElementById("dashboard-camera-focus-cancel"), () => {
      const modal = document.getElementById("dashboard-camera-focus-modal");
      if (modal?.open) modal.close();
    });
    bindButtonAction(document.getElementById("dashboard-camera-focus-apply"), applyDashboardCameraFocus);
    const focusMode = document.getElementById("dashboard-camera-focus-mode");
    focusMode?.addEventListener("change", () => {
      state.cameraFocus.draftAutofocus = focusMode.value === "auto";
      renderDashboardCameraFocusControls();
    });
    const focusRange = document.getElementById("dashboard-camera-focus-value");
    focusRange?.addEventListener("input", () => {
      const value = Number(focusRange.value);
      if (Number.isFinite(value)) state.cameraFocus.draftAbsolute = value;
      const label = document.getElementById("dashboard-camera-focus-value-label");
      if (label) label.textContent = String(state.cameraFocus.draftAbsolute);
    });
    renderDashboardExternalCameraView();
    renderDashboardCameraFocusControls();
  }

  cameraState.dashboardCameraPrimary = loadDashboardCameraPrimary();
  cameraState.dashboardExternalCameraView = loadDashboardExternalCameraView();

  return {
    dashboardCameraShouldRun,
    dashboardCameraPrimary,
    renderDashboardCameraConfig,
    syncDashboardCameras,
    loadDashboardCameras,
    bindDashboardCameraSwitches,
    stopDashboardBuiltinCamera,
    stopDashboardExternalCamera,
  };
}
