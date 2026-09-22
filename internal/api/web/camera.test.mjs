import test from "node:test";
import assert from "node:assert/strict";
import { mountDashboardCamera } from "./modules/camera.js";

function makeCamera(documentRef = {}) {
  const cameraState = { activeTab: "dashboard", readOnly: false };
  const document = {
    hidden: false,
    activeElement: null,
    getElementById: documentRef.getElementById || (() => null),
    querySelector: documentRef.querySelector || (() => null),
  };
  const windowRef = {
    location: { href: "https://example.test/" },
    localStorage: { getItem: () => null, setItem: () => {} },
    WebSocket: undefined,
  };
  const statuses = [];
  const camera = mountDashboardCamera({
    getActiveTab: () => cameraState.activeTab,
    getReadOnly: () => cameraState.readOnly,
    documentRef: document,
    windowRef,
    request: async () => ({ json: async () => ({ builtin: { configured: false }, external: { configured: false } }) }),
    setStatusMessage: (...args) => statuses.push(args),
    bindButtonAction: () => {},
    setTextIfChanged: () => {},
    webSocketCtor: undefined,
  });
  return { camera, cameraState, document, statuses };
}

test("camera factory owns camera state and gates operation on dashboard visibility", async () => {
  const { camera, cameraState, document } = makeCamera();
  assert.equal(camera.dashboardCameraShouldRun(), true);
  cameraState.activeTab = "files";
  assert.equal(camera.dashboardCameraShouldRun(), false);
  cameraState.activeTab = "dashboard";
  document.hidden = true;
  assert.equal(camera.dashboardCameraShouldRun(), false);
  document.hidden = false;
  await camera.loadDashboardCameras();
  camera.syncDashboardCameras();
  assert.equal(camera.dashboardCameraShouldRun(), true);
});

test("camera loader keeps configured source data and marks configuration loaded on request failure", async () => {
  let calls = 0;
  const { camera } = makeCamera();
  const failing = mountDashboardCamera({
    getActiveTab: () => "files",
    getReadOnly: () => false,
    documentRef: { hidden: false, getElementById: () => null, querySelector: () => null },
    windowRef: { location: { href: "https://example.test/" }, localStorage: { getItem: () => null, setItem: () => {} } },
    request: async () => { calls++; throw new Error("offline"); },
    setStatusMessage: () => {},
    bindButtonAction: () => {},
    setTextIfChanged: () => {},
  });
  await failing.loadDashboardCameras();
  assert.equal(calls, 1);
  assert.equal(failing.dashboardCameraShouldRun(), false);
  assert.equal(camera.dashboardCameraShouldRun(), true);
});

test("camera interaction binder mounts one listener pair per camera surface", () => {
  const registrations = [];
  const makeRoot = (kind) => ({
    classList: { toggle() {} },
    addEventListener(type, handler) { registrations.push([kind, type, handler]); },
  });
  const roots = {
    "dashboard-external-camera": makeRoot("external"),
    "dashboard-builtin-camera": makeRoot("builtin"),
  };
  const camera = mountDashboardCamera({
    getActiveTab: () => "dashboard",
    getReadOnly: () => false,
    documentRef: {
      hidden: false,
      getElementById: (id) => roots[id] || null,
      querySelector: () => null,
    },
    windowRef: { location: { href: "https://example.test/" }, localStorage: { getItem: () => null, setItem() {} } },
    request: async () => ({ json: async () => ({}) }),
    setStatusMessage: () => {},
    bindButtonAction: () => {},
    setTextIfChanged: () => {},
  });

  camera.bindDashboardCameraSwitches();
  assert.deepEqual(registrations.map(([kind, type]) => `${kind}:${type}`), [
    "external:click", "external:keydown", "builtin:click", "builtin:keydown",
  ]);
});
