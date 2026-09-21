import test from "node:test";
import assert from "node:assert/strict";
import {
  surfaceMPGPointerSample,
  surfaceMPGAngleDelta,
  sameJogInput,
  jogInputActive,
  createJogFeature,
} from "./modules/jog.js";

test("jog input comparison and deadman activity preserve thresholds", () => {
  const a = { deadman: true, slow: false, axes: { x: 0.2, y: 0, z: 0, a: 0 } };
  assert.equal(sameJogInput(a, { ...a, axes: { ...a.axes, x: 0.2 } }), true);
  assert.equal(jogInputActive(a), true);
  assert.equal(jogInputActive({ deadman: true, axes: { x: 0.12, y: 0, z: 0, a: 0 } }), false);
});

test("MPG pointer angle and wraparound preserve circular input", () => {
  assert.deepEqual(surfaceMPGPointerSample(100, 50, { left: 0, top: 0, width: 100, height: 100 }), { angle: 0, radius: 1 });
  assert.equal(surfaceMPGAngleDelta(359, 1), 2);
  assert.equal(surfaceMPGAngleDelta(1, 359), -2);
});

function jogFixture({ caps = { enabled: true, tick_ms: 20 }, documentRef, windowRef, WebSocketCtor, timers, surface = {} } = {}) {
  const jog = {
    caps, ws: null, link: "offline", reconnectTimer: null, reconnectAttempt: 0, sampleTimer: null,
    armed: true, armQueuedAction: "", armPending: 0, armPendingAction: "", targetPending: 0,
    targetMotionPending: 0, zStepPending: 0, surfaceStepPending: 0, surfaceStepSource: "",
    originPendingMode: "", originPendingLabel: "", originPendingTargets: null, commandDisarm: null,
    sent: new Map(), seq: 1, lastInput: null, lastInputSentAt: 0, inputSuspended: false,
    surfaceInput: null, surfaceWheel: { pointerId: null, lastAngle: null, remainder: 0, gestureSteps: 0, gestureAccepted: 0, gestureReleased: false, gestureAxis: "", blocked: false, value: 0 },
    pad: "", deadman: false, axes: { x: 0, y: 0, z: 0, a: 0 }, buttons: [], preferredPadIndex: null,
    error: "", errorCode: "", fieldProbeMovePending: 0,
  };
  const timersState = timers || { queue: [], next: 1 };
  const setTimer = (fn) => { const id = timersState.next++; timersState.queue.push({ id, fn }); return id; };
  const clearTimer = (id) => { timersState.queue = timersState.queue.filter((entry) => entry.id !== id); };
  const windowValue = windowRef || { location: { protocol: "http:", host: "localhost" }, WebSocket: WebSocketCtor };
  const documentValue = documentRef || { hidden: false, getElementById: () => null };
  const feature = createJogFeature({
    jogState: jog,
    surfaceState: { mpg_axis: "x", mpg_feedback: "none", ...surface },
    documentRef: documentValue,
    windowRef: windowValue,
    WebSocketCtor,
    performanceRef: { now: () => 1000 },
    setTimeoutRef: setTimer,
    clearTimeoutRef: clearTimer,
    renderJog: () => {}, renderMachine: () => {}, renderSurfaceMPGWheel: () => {}, setStatusMessage: () => {},
    applyJogEvent: () => {}, failOutlineCaptureIntents: () => {}, completeCommandDisarm: () => {},
    cancelWorkCoordinateMove: () => {}, clearFieldProbeMove: () => {}, hasPendingOriginOperation: () => false,
    originTargetLabel: () => "origin", clearOriginVerification: () => {}, setOriginFeedback: () => {},
    tapMoveArmFailureText: () => "failed", clampAxis: (value) => value,
    currentGamepad: () => null, mappedAxis: () => 0, buttonStates: () => [], buttonPressed: () => false,
    gamepadLabel: () => "", captureGamepadOutlineButton: () => false, handleGamepadOutlineButton: () => {},
    handleGamepadMacroButtons: () => {}, sameButtonStates: () => true, resetMobileWorkAreaJog: () => false,
    getUI: () => ({ gamepad: { deadman_button: 0, slow_buttons: [] } }), getWorkarea: () => ({}),
    surfaceJogReady: () => true, sendSurfaceStep: () => true,
  });
  return { feature, jog, timers: timersState, window: windowValue, document: documentValue };
}

test("disabled capabilities never open a WebSocket", () => {
  let sockets = 0;
  class FakeSocket { constructor() { sockets++; } }
  const { feature, jog } = jogFixture({ caps: { enabled: false }, WebSocketCtor: FakeSocket, windowRef: { WebSocket: FakeSocket, location: {} } });
  feature.connectJog();
  assert.equal(sockets, 0);
  assert.equal(jog.link, "disabled");
});

test("WebSocket lifecycle reconnects after close and cleanup cancels it", () => {
  const sockets = [];
  class FakeSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    constructor() { this.readyState = 0; this.bufferedAmount = 0; this.sent = []; sockets.push(this); }
    send(value) { this.sent.push(value); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const fixture = jogFixture({ WebSocketCtor: FakeSocket, windowRef: { WebSocket: FakeSocket, location: {} } });
  fixture.feature.connectJog();
  assert.equal(sockets.length, 1);
  const first = sockets[0];
  first.readyState = FakeSocket.OPEN;
  first.onopen();
  assert.equal(fixture.jog.link, "online");
  first.onclose();
  assert.equal(fixture.jog.link, "reconnecting");
  assert.equal(fixture.timers.queue.length, 1);
  fixture.feature.cleanup();
  assert.equal(fixture.timers.queue.length, 0);
  assert.equal(fixture.jog.link, "disabled");
});

test("coalesced active input still permits an immediate forced release", () => {
  class FakeSocket {
    static OPEN = 1;
    constructor() { this.readyState = FakeSocket.OPEN; this.bufferedAmount = 1; this.sent = []; }
    send(value) { this.sent.push(JSON.parse(value)); }
  }
  const fixture = jogFixture({ WebSocketCtor: FakeSocket, windowRef: { WebSocket: FakeSocket, location: {} } });
  fixture.feature.connectJog();
  const socket = fixture.jog.ws;
  fixture.feature.sendJogInput({ deadman: true, axes: { x: 1 } });
  assert.equal(socket.sent.length, 0);
  fixture.feature.sendJogInput({ deadman: false, axes: {} }, true);
  assert.equal(socket.sent.length, 1);
  assert.equal(socket.sent[0].deadman, false);
});

test("Surface MPG clockwise full-circle motion keeps a positive direction", () => {
  const listeners = new Map();
  const wheel = {
    classList: { add: () => {}, remove: () => {} },
    addEventListener: (name, handler) => listeners.set(name, handler),
    setPointerCapture: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
  };
  const windowRef = { location: {}, addEventListener: () => {} };
  const fixture = jogFixture({ windowRef, documentRef: { hidden: false, getElementById: () => wheel } });
  const signs = [];
  const actual = createJogFeature({
    jogState: fixture.jog, surfaceState: { mpg_axis: "x", mpg_feedback: "none" },
    documentRef: { hidden: false, getElementById: () => wheel }, windowRef,
    WebSocketCtor: class {}, performanceRef: { now: () => 1000 }, setTimeoutRef: () => 1, clearTimeoutRef: () => {},
    renderJog: () => {}, renderMachine: () => {}, renderSurfaceMPGWheel: () => {}, sendSurfaceStep: (_axis, sign) => { signs.push(sign); return true; },
    surfaceJogReady: () => true, resetMobileWorkAreaJog: () => false,
  });
  actual.bindSurfaceMPGWheel();
  listeners.get("pointerdown")({ button: 0, pointerId: 1, clientX: 100, clientY: 50, preventDefault: () => {} });
  for (const [x, y] of [[50, 100], [0, 50], [50, 0], [100, 50]]) listeners.get("pointermove")({ pointerId: 1, clientX: x, clientY: y });
  listeners.get("pointerup")({ pointerId: 1 });
  assert.ok(signs.length >= 20);
  assert.ok(signs.every((sign) => sign === 1));
});

test("sampling follows replaced UI and workarea objects after mount", () => {
  let ui = { gamepad: { deadman_button: 0, slow_buttons: [] } };
  let workarea = { mobileJogActive: false };
  const jog = {
    caps: { enabled: true, tick_ms: 20 }, ws: null, link: "offline", reconnectTimer: null, reconnectAttempt: 0, sampleTimer: null,
    armed: false, inputSuspended: false, surfaceInput: null, surfaceWheel: {}, preferredPadIndex: null,
    pad: "", deadman: false, axes: { x: 0, y: 0, z: 0, a: 0 }, buttons: [], sent: new Map(), seq: 1,
  };
  const gp = { index: 0 };
  const feature = createJogFeature({
    jogState: jog, surfaceState: { mpg_axis: "x" }, documentRef: { hidden: false }, windowRef: {},
    performanceRef: { now: () => 1000 }, setTimeoutRef: () => 1, clearTimeoutRef: () => {},
    renderJog: () => {}, renderMachine: () => {}, renderSurfaceMPGWheel: () => {}, setStatusMessage: () => {},
    currentGamepad: () => gp, mappedAxis: () => 0, buttonStates: () => [], buttonPressed: (_gamepad, button) => button === 0,
    gamepadLabel: () => "Pad", captureGamepadOutlineButton: () => false, handleGamepadOutlineButton: () => {},
    handleGamepadMacroButtons: () => {}, sameButtonStates: () => true, resetMobileWorkAreaJog: () => false,
    getUI: () => ui, getWorkarea: () => workarea, surfaceJogReady: () => true, sendSurfaceStep: () => true,
  });
  feature.sampleJog();
  assert.equal(jog.deadman, true);
  ui = { gamepad: { deadman_button: 1, slow_buttons: [] } };
  workarea = { mobileJogActive: true, mobileJogAxes: { x: 0, y: 1, z: 0 } };
  feature.sampleJog();
  assert.equal(jog.pad, "Touch");
  assert.deepEqual(jog.axes, { x: 0, y: 1, z: 0 });
});
